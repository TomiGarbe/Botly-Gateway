from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import provider_deliveries as provider_deliveries_router
from app.services import normalization
from app.services.provider_deliveries import ProviderDeliveryQueryService


def _connection(connection_id: str, client_id: str, runtime_name: str, provider: str = "evolution"):
    return SimpleNamespace(
        id=connection_id,
        client_id=client_id,
        provider=SimpleNamespace(id=provider),
        status=SimpleNamespace(state="connected"),
        technical={"legacy_instance_name": runtime_name},
    )


class _Connections:
    def __init__(self) -> None:
        self.items = {
            "connection-a": _connection("connection-a", "tenant-a", "runtime-a"),
            "connection-b": _connection("connection-b", "tenant-b", "runtime-b", "meta"),
        }

    async def get_connection(self, connection_id: str):
        from app.services.connections import ConnectionNotFoundError
        if connection_id not in self.items:
            raise ConnectionNotFoundError(connection_id)
        return self.items[connection_id]

    async def get_connection_by_runtime_name(self, runtime_name: str):
        from app.services.connections import ConnectionNotFoundError
        for connection in self.items.values():
            if connection.technical["legacy_instance_name"] == runtime_name:
                return connection
        raise ConnectionNotFoundError(runtime_name)


def _event(
    delivery_id: str, instance: str, timestamp: int, *, provider: str = "evolution",
    direction: str = "outbound", status: str = "success", message_id: str = "message-a",
    conversation_id: str = "conversation-a", channel_id: str = "whatsapp",
) -> dict:
    return {
        "id": delivery_id,
        "layer": "business",
        "instance": instance,
        "timestamp": timestamp,
        "providerDelivery": {
            "id": delivery_id, "timestamp": timestamp, "provider": provider,
            "direction": direction, "operation": f"provider.message.{direction}",
            "semanticStatus": status, "messageId": message_id,
            "deliveryState": "accepted" if status == "success" else "failed",
            "reconciliationState": "not_required",
            "conversationId": conversation_id, "channelId": channel_id,
            "connectionId": "untrusted-persisted-id", "providerMessageId": f"provider-{delivery_id}",
            "durationMs": 12, "attemptCount": 2, "retryCount": 1,
            "requestId": f"request-{delivery_id}", "correlationId": f"correlation-{delivery_id}",
            "request": {"headers": {"Authorization": "Bearer private", "safe": "ok"}, "url": "https://provider.test/send?access_token=private", "body": {"text": "diagnostic payload"}},
            "response": {"headers": {"Set-Cookie": "private-cookie"}, "body": {"accessToken": "private-response"}},
            "error": {"message": "token=private-error", "code": "failed"} if status == "failed" else None,
            "metadata": {"signature": "private-signature", "safe": "kept"},
        },
    }


def _http(monkeypatch) -> TestClient:
    monkeypatch.setattr(provider_deliveries_router, "_connections", _Connections())
    app = FastAPI()

    @app.middleware("http")
    async def reviewer(request, call_next):
        request.state.user = SimpleNamespace(role="meta_reviewer", business_id="tenant-a")
        return await call_next(request)

    app.include_router(provider_deliveries_router.router)
    return TestClient(app)


def test_provider_delivery_query_filters_paginates_stably_and_reads_legacy(monkeypatch) -> None:
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    normalization._business_events.clear()
    normalization._business_events.extend([
        _event("delivery-b", "runtime-a", 200, status="failed", message_id="message-b", conversation_id="conversation-b", channel_id="channel-b"),
        _event("delivery-a", "runtime-a", 200),
        _event("delivery-other", "runtime-b", 300, provider="meta", direction="inbound"),
        {"id": "legacy-a", "layer": "business", "instance": "runtime-a", "timestamp": 100, "direction": "inbound", "status": "failed", "message": {"id": "legacy-message"}, "raw": {"provider": "evolution"}},
    ])
    normalization._business_events[0]["providerDelivery"]["eventId"] = "event-delivery-b"
    service = ProviderDeliveryQueryService()

    page = service.list(instance="runtime-a", limit=1, offset=1)
    assert page["total"] == 3
    assert page["items"][0]["id"] == "delivery-a"  # timestamp + ID stable order
    assert service.list(instance="runtime-a", limit=20, offset=0, provider="evolution", direction="outbound", status="failed", operation="provider.message.outbound", message_id="message-b", conversation_id="conversation-b", channel_id="channel-b")["items"][0]["id"] == "delivery-b"
    legacy = service.list(instance="runtime-a", limit=20, offset=0, message_id="legacy-message")["items"]
    assert legacy == [
        {"id": "legacy-a", "timestamp": 100, "direction": "inbound", "operation": "provider.message.inbound", "provider": "evolution", "semanticStatus": "failed", "deliveryState": None, "reconciliationState": None, "messageId": "legacy-message", "conversationId": None, "channelId": None, "connectionId": None, "providerMessageId": None, "durationMs": None, "attemptCount": None, "retryCount": None, "correlationId": None, "isTest": False}
    ]
    advanced = service.list(
        instance="runtime-a", limit=20, offset=0, delivery_id="delivery-b", provider_message_id="provider-delivery-b",
        correlation_id="correlation-delivery-b", request_id="request-delivery-b", event_id="event-delivery-b",
    )
    assert [item["id"] for item in advanced["items"]] == ["delivery-b"]
    assert [item["id"] for item in service.list(instance="runtime-a", limit=20, offset=0, search="correlation-delivery-b")["items"]] == ["delivery-b"]


def test_provider_deliveries_api_enforces_ownership_filters_and_redacts(monkeypatch) -> None:
    normalization._business_events.clear()
    normalization._business_events.extend([
        _event("delivery-a", "runtime-a", 200, status="failed"),
        _event("delivery-b", "runtime-b", 300, provider="meta", direction="inbound"),
    ])
    http = _http(monkeypatch)

    listed = http.get("/provider-deliveries", params={"connection_id": "connection-a", "direction": "outbound", "status": "failed", "operation": "provider.message.outbound", "message_id": "message-a", "conversation_id": "conversation-a", "channel_id": "whatsapp", "date_from": "1970-01-01T00:00:00Z", "date_to": "1970-01-01T00:00:01Z"})
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["connectionId"] == "connection-a"
    assert listed.json()["items"][0]["semanticStatus"] == "failed"
    assert listed.json()["items"][0]["deliveryState"] == "failed"
    assert listed.json()["items"][0]["reconciliationState"] == "not_required"
    assert "request" not in listed.json()["items"][0]

    detail = http.get("/provider-deliveries/delivery-a")
    assert detail.status_code == 200
    payload = detail.json()
    assert payload["summary"]["connectionId"] == "connection-a"
    assert "semanticStatus" in payload["summary"]
    assert payload["summary"]["deliveryState"] == "failed"
    assert payload["summary"]["reconciliationState"] == "not_required"
    assert "private" not in str(payload)
    assert payload["request"]["headers"]["Authorization"] == "[REDACTED]"
    assert payload["response"]["headers"]["Set-Cookie"] == "[REDACTED]"
    assert payload["metadata"]["signature"] == "[REDACTED]"

    assert http.get("/provider-deliveries", params={"connection_id": "connection-b"}).status_code == 403
    assert http.get("/provider-deliveries/delivery-b").status_code == 403
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "provider": "meta"}).status_code == 422
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "direction": "sideways"}).status_code == 422
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "status": "unknown"}).status_code == 200
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "search": "x" * 257}).status_code == 422
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "search": "correlation-delivery-b"}).json()["items"] == []
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "search": "connection-a"}).json()["total"] == 1
    assert http.get("/provider-deliveries", params={"connection_id": "connection-a", "date_from": "2026-01-02T00:00:00Z", "date_to": "2026-01-01T00:00:00Z"}).status_code == 422
    assert http.get("/provider-deliveries/missing").status_code == 404


def test_provider_reconciliation_endpoint_is_attempt_only_and_ownership_aware(monkeypatch) -> None:
    class _DeliveryLookup:
        def find(self, delivery_id: str):
            if delivery_id == "delivery-a":
                return "runtime-a", {"attemptId": "outbound_attempt_a"}
            if delivery_id == "delivery-b":
                return "runtime-b", {"attemptId": "outbound_attempt_b"}
            return None

    class _Reconciler:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def reconcile(self, **kwargs):
            self.calls.append(kwargs)

            class _Result:
                def public_dict(self):
                    return {"reconciliationId": "reconciliation-a", "attemptId": "outbound_attempt_a", "provider": "meta", "startedAt": 1, "completedAt": 2, "status": "inconclusive", "providerMessageId": "wamid.1", "observedState": None, "confidence": "inconclusive", "reason": "missing_provider_message_id", "error": None}

            return _Result()

    reconciler = _Reconciler()
    monkeypatch.setattr(provider_deliveries_router, "_connections", _Connections())
    monkeypatch.setattr(provider_deliveries_router, "_deliveries", _DeliveryLookup())
    monkeypatch.setattr(provider_deliveries_router, "_reconciliation", reconciler)
    http = _http(monkeypatch)

    response = http.post("/provider-deliveries/delivery-a/reconcile")
    assert response.status_code == 200
    assert response.json()["attemptId"] == "outbound_attempt_a"
    assert reconciler.calls == [{"attempt_id": "outbound_attempt_a", "instance": "runtime-a", "connection_id": "connection-a"}]
    assert http.post("/provider-deliveries/delivery-a/reconcile", json={"provider": "evolution"}).status_code == 422
    assert http.post("/provider-deliveries/delivery-b/reconcile").status_code == 403


def test_provider_resend_endpoint_accepts_only_confirmation_and_resolves_all_sensitive_values(monkeypatch) -> None:
    class _DeliveryLookup:
        def find(self, delivery_id: str):
            if delivery_id == "delivery-a":
                return "runtime-a", {"attemptId": "outbound_attempt_a"}
            if delivery_id == "delivery-b":
                return "runtime-b", {"attemptId": "outbound_attempt_b"}
            return None

    class _Resend:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def resend(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "idempotent": False,
                "action": {"id": "manual-action-a", "action": "resend_provider_outbound", "status": "completed", "risk": "warning"},
                "newAttempt": {"id": "outbound_attempt_new"},
            }

    resend = _Resend()
    monkeypatch.setattr(provider_deliveries_router, "_connections", _Connections())
    monkeypatch.setattr(provider_deliveries_router, "_deliveries", _DeliveryLookup())
    monkeypatch.setattr(provider_deliveries_router, "_resend", resend)
    app = FastAPI()

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.user = SimpleNamespace(id="actor-a", role="meta_reviewer", business_id="tenant-a")
        return await call_next(request)

    app.include_router(provider_deliveries_router.router)
    http = TestClient(app)
    response = http.post("/provider-deliveries/delivery-a/resend", headers={"Idempotency-Key": "resend-a"}, json={"confirmCurrentConfiguration": True})
    assert response.status_code == 200
    assert response.json()["actionId"] == "manual-action-a"
    assert response.json()["newAttemptId"] == response.json()["newDeliveryId"] == "outbound_attempt_new"
    assert resend.calls == [{
        "source_attempt_id": "outbound_attempt_a", "source_delivery_id": "delivery-a", "connection_id": "connection-a",
        "actor_id": "actor-a", "idempotency_key": "resend-a", "confirmed": True, "current_provider": "evolution",
        "current_instance": "runtime-a", "connection_active": True,
    }]
    assert http.post("/provider-deliveries/delivery-a/resend", headers={"Idempotency-Key": "x"}, json={"confirmCurrentConfiguration": True, "destination": "untrusted"}).status_code == 422
    assert http.post("/provider-deliveries/delivery-a/resend", json={"confirmCurrentConfiguration": True}).status_code == 422
    assert http.post("/provider-deliveries/delivery-b/resend", headers={"Idempotency-Key": "foreign"}, json={"confirmCurrentConfiguration": True}).status_code == 403
    assert http.post("/provider-deliveries/missing/resend", headers={"Idempotency-Key": "missing"}, json={"confirmCurrentConfiguration": True}).status_code == 404
