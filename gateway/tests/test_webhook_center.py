import asyncio
import importlib
import json
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import webhook_center
from app.services.instance_webhooks import (
    append_dispatch_history,
    create_webhook,
    delete_webhook,
    get_webhook_delivery,
    get_webhook,
    list_recent_dispatches,
    list_webhook_dispatches,
    update_webhook,
)
from app.services.webhook_delivery import dispatch_webhook_with_retry


def _settings(tmp_path, *, retention: int = 250):
    return SimpleNamespace(
        instance_webhooks_path=str(tmp_path / "webhooks.json"),
        instance_webhooks_encryption_key="test-webhook-encryption-key",
        webhook_dispatch_history_limit=30,
        webhook_deliveries_path=str(tmp_path / "deliveries.json"),
        webhook_delivery_retention=retention,
        webhook_delivery_max_payload_bytes=16_384,
        gateway_api_key="test-gateway-key",
    )


def _configure_stores(monkeypatch, tmp_path, *, retention: int = 250):
    settings = _settings(tmp_path, retention=retention)
    monkeypatch.setattr("app.services.instance_webhooks.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.webhook_deliveries.get_settings", lambda: settings)


def _create(instance_name: str, name: str):
    return create_webhook(
        instance_name,
        name=name,
        url="https://receiver.example.test/events?token=not-public",
        enabled=True,
        auth_type="CUSTOM_HEADERS",
        auth_config=None,
        custom_headers={"X-Secret": "do-not-store"},
    )


def test_multiple_webhooks_are_independent_and_delete_keeps_delivery_evidence(monkeypatch, tmp_path) -> None:
    _configure_stores(monkeypatch, tmp_path)
    first = _create("runtime-a", "First")
    second = _create("runtime-a", "Second")
    updated = update_webhook(
        "runtime-a", first["id"], name="First updated", url="https://new.example.test/events",
        enabled=False, auth_type="NONE", auth_config={}, custom_headers={},
        event_filters={"business": False, "transport": True, "operational": False},
    )
    assert updated and updated["name"] == "First updated" and updated["enabled"] is False
    assert get_webhook("runtime-a", second["id"])["name"] == "Second"

    append_dispatch_history(
        "runtime-a",
        first["id"],
        {
            "id": "delivery-a",
            "timestamp": 100,
            "success": True,
            "status": "success",
            "statusCode": 204,
            "isTest": True,
            "request": {"payloadPreview": '{"token":"secret","nested":{"authorization":"also-secret"}}'},
            "response": {"bodyPreview": '{"apiKey":"response-secret"}'},
            "metadata": {"nested": {"password": "metadata-secret"}},
        },
    )
    append_dispatch_history(
        "runtime-a",
        second["id"],
        {"id": "delivery-b", "timestamp": 200, "success": False, "status": "failed", "error": "failed"},
    )

    first_deliveries = list_webhook_dispatches("runtime-a", first["id"])
    second_deliveries = list_webhook_dispatches("runtime-a", second["id"])
    assert [row["id"] for row in first_deliveries] == ["delivery-a"]
    assert first_deliveries[0]["isTest"] is True
    assert [row["id"] for row in second_deliveries] == ["delivery-b"]
    serialized = json.dumps(first_deliveries)
    for secret in ("secret", "also-secret", "response-secret", "metadata-secret", "not-public", "do-not-store"):
        assert secret not in serialized

    assert delete_webhook("runtime-a", first["id"]) is True
    assert get_webhook_delivery("runtime-a", first["id"], "delivery-a") is None
    # The independent store retains audit evidence even though the deleted
    # configuration can no longer expose it through its owned endpoint.
    from app.services.webhook_deliveries import get_webhook_delivery as stored_delivery
    assert stored_delivery(first["id"], "delivery-a") is not None
    assert list_webhook_dispatches("runtime-a", second["id"])[0]["id"] == "delivery-b"


def test_delivery_retention_is_explicit_and_per_webhook(monkeypatch, tmp_path) -> None:
    _configure_stores(monkeypatch, tmp_path, retention=2)
    first = _create("runtime-a", "First")
    second = _create("runtime-a", "Second")
    for number in range(3):
        append_dispatch_history(
            "runtime-a", first["id"],
            {"id": f"delivery-{number}", "timestamp": number, "success": True, "status": "success"},
        )
    append_dispatch_history(
        "runtime-a", second["id"],
        {"id": "second-delivery", "timestamp": 99, "success": True, "status": "success"},
    )

    assert [row["id"] for row in list_webhook_dispatches("runtime-a", first["id"])] == ["delivery-2", "delivery-1"]
    assert [row["id"] for row in list_webhook_dispatches("runtime-a", second["id"])] == ["second-delivery"]
    configuration = get_webhook("runtime-a", first["id"])
    assert configuration and configuration["successCount"] == 3
    assert configuration.get("dispatchHistory") in (None, [])


def test_test_mode_uses_the_dispatcher_and_persists_a_test_delivery(monkeypatch, tmp_path) -> None:
    _configure_stores(monkeypatch, tmp_path)
    created = _create("runtime-a", "Test target")
    internal = get_webhook("runtime-a", created["id"], reveal_secrets=True)

    class SuccessfulClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            from httpx import Response
            return Response(204, headers={"X-Request-Id": "safe"})

    monkeypatch.setattr("app.services.webhook_delivery.httpx.AsyncClient", lambda **_kwargs: SuccessfulClient())
    result = asyncio.run(
        dispatch_webhook_with_retry(
            payload={"instance": "runtime-a", "event": "TEST_WEBHOOK", "dispatchId": "test-dispatch"},
            request_id="test-request",
            item=internal,
            test_mode=True,
        )
    )
    assert result["ok"] is True
    delivery = list_webhook_dispatches("runtime-a", created["id"])[0]
    assert delivery["isTest"] is True
    assert delivery["correlationId"] == "test-dispatch"


def test_webhook_center_enforces_connection_ownership(monkeypatch, tmp_path) -> None:
    _configure_stores(monkeypatch, tmp_path)
    owned = _create("runtime-owned", "Owned")
    foreign = _create("runtime-foreign", "Foreign")
    connections = {
        "connection-owned": SimpleNamespace(id="connection-owned", client_id="tenant-a", technical={"legacy_instance_name": "runtime-owned"}),
        "connection-foreign": SimpleNamespace(id="connection-foreign", client_id="tenant-b", technical={"legacy_instance_name": "runtime-foreign"}),
    }

    class ConnectionService:
        async def get_connection(self, connection_id):
            if connection_id not in connections:
                from app.services.connections import ConnectionNotFoundError
                raise ConnectionNotFoundError(connection_id)
            return connections[connection_id]

        async def get_connection_by_runtime_name(self, runtime_name):
            for connection in connections.values():
                if connection.technical["legacy_instance_name"] == runtime_name:
                    return connection
            from app.services.connections import ConnectionNotFoundError
            raise ConnectionNotFoundError(runtime_name)

        async def list_connections(self):
            return list(connections.values())

    monkeypatch.setattr(webhook_center, "_connections", ConnectionService())
    app = FastAPI()

    @app.middleware("http")
    async def reviewer_identity(request, call_next):
        request.state.user = SimpleNamespace(role="meta_reviewer", business_id="tenant-a")
        return await call_next(request)

    app.include_router(webhook_center.router)
    client = TestClient(app)

    listed = client.get("/webhooks")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [owned["id"]]
    scoped = client.get("/webhooks", params={"connection_id": "connection-owned"})
    assert scoped.status_code == 200
    assert [item["id"] for item in scoped.json()["items"]] == [owned["id"]]
    assert client.get("/webhooks", params={"connection_id": "connection-foreign"}).status_code == 403
    assert client.get(f"/webhooks/{owned['id']}").status_code == 200
    assert client.get(f"/webhooks/{foreign['id']}").status_code == 403
    assert client.get(f"/webhooks/{foreign['id']}/deliveries").status_code == 403
    assert client.get(f"/webhooks/{owned['id']}/deliveries", params={"date_from": 2, "date_to": 1}).status_code == 422
    assert client.get(f"/webhooks/{owned['id']}/deliveries", params={"status": "unknown"}).status_code == 422
    assert client.get(f"/webhooks/{owned['id']}/deliveries", params={"search": "x" * 257}).status_code == 422
    assert client.patch(f"/webhooks/{foreign['id']}/enabled", json={"enabled": False}).status_code == 403

    updated = client.patch(f"/webhooks/{owned['id']}", json={"name": "Owned updated"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Owned updated"
    assert client.patch(f"/webhooks/{owned['id']}/filters", json={"business": False, "transport": True}).status_code == 200
    assert client.patch(f"/webhooks/{owned['id']}/enabled", json={"enabled": False}).json()["enabled"] is False


def test_connection_webhook_timeline_is_scoped_deduplicated_and_safe(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DEBUG", "false")
    connections_router = importlib.import_module("app.routers.connections")
    _configure_stores(monkeypatch, tmp_path)
    owned = _create("runtime-owned", "Owned")
    foreign = _create("runtime-foreign", "Foreign")
    connections = {
        "connection-owned": SimpleNamespace(id="connection-owned", client_id="tenant-a", technical={"legacy_instance_name": "runtime-owned"}),
        "connection-empty": SimpleNamespace(id="connection-empty", client_id="tenant-a", technical={"legacy_instance_name": "runtime-empty"}),
        "connection-foreign": SimpleNamespace(id="connection-foreign", client_id="tenant-b", technical={"legacy_instance_name": "runtime-foreign"}),
    }
    entry = {
        "id": "logical-delivery", "timestamp": 100, "eventType": "messages.upsert", "eventId": "event-1",
        "requestId": "request-1", "correlationId": "correlation-1", "success": False, "status": "http_500",
        "statusCode": 500, "durationMs": 12, "attemptCount": 2, "retryCount": 1, "error": "delivery failed",
        "request": {"headers": {"Authorization": "Bearer private"}, "payloadPreview": '{"token":"private"}'},
        "response": {"bodyPreview": '{"apiKey":"private"}'},
        "attempts": [{"statusCode": 500, "authorization": "private"}],
    }
    append_dispatch_history("runtime-owned", owned["id"], entry)
    append_dispatch_history("runtime-owned", owned["id"], entry)
    append_dispatch_history("runtime-foreign", foreign["id"], {"id": "foreign-delivery", "timestamp": 200, "success": True, "status": "success"})

    class ConnectionService:
        async def get_connection(self, connection_id):
            if connection_id not in connections:
                from app.services.connections import ConnectionNotFoundError
                raise ConnectionNotFoundError(connection_id)
            return connections[connection_id]

    class Operations:
        def webhook_deliveries(self, connection_id, *, limit):
            runtime_name = connections[connection_id].technical["legacy_instance_name"]
            return {"items": list_recent_dispatches(runtime_name, limit=limit), "metrics": {"totalDeliveries": 0}}

    monkeypatch.setattr(connections_router, "_service", ConnectionService())
    monkeypatch.setattr(connections_router, "_operations", Operations())
    app = FastAPI()

    @app.middleware("http")
    async def reviewer_identity(request, call_next):
        request.state.user = SimpleNamespace(role="meta_reviewer", business_id="tenant-a")
        return await call_next(request)

    app.include_router(connections_router.router)
    client = TestClient(app)

    response = client.get("/connections/connection-owned/webhook/deliveries", params={"limit": 100})
    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload["items"]] == ["logical-delivery"]
    assert payload["items"][0]["eventId"] == "event-1"
    serialized = json.dumps(payload)
    assert "private" not in serialized
    assert client.get("/connections/connection-empty/webhook/deliveries").json()["items"] == []
    assert client.get("/connections/connection-foreign/webhook/deliveries").status_code == 403
    assert client.get("/connections/missing/webhook/deliveries").status_code == 404
    assert client.get("/connections/connection-owned/webhook/deliveries", params={"limit": 201}).status_code == 422


def test_manual_webhook_test_uses_selected_target_payload_and_delivery_identity(monkeypatch, tmp_path) -> None:
    _configure_stores(monkeypatch, tmp_path)
    owned = _create("runtime-owned", "Owned")
    foreign = _create("runtime-foreign", "Foreign")
    disabled = create_webhook("runtime-owned", name="Disabled", url="https://disabled.example.test", enabled=False, auth_type="NONE", auth_config=None, custom_headers=None)
    connections = {
        "connection-owned": SimpleNamespace(id="connection-owned", client_id="tenant-a", technical={"legacy_instance_name": "runtime-owned"}),
        "connection-foreign": SimpleNamespace(id="connection-foreign", client_id="tenant-b", technical={"legacy_instance_name": "runtime-foreign"}),
    }

    class ConnectionService:
        async def get_connection(self, connection_id):
            if connection_id not in connections:
                from app.services.connections import ConnectionNotFoundError
                raise ConnectionNotFoundError(connection_id)
            return connections[connection_id]

        async def get_connection_by_runtime_name(self, runtime_name):
            for connection in connections.values():
                if connection.technical["legacy_instance_name"] == runtime_name:
                    return connection
            from app.services.connections import ConnectionNotFoundError
            raise ConnectionNotFoundError(runtime_name)

    captured: dict = {}

    async def dispatch(*, payload, request_id, item, test_mode=False, **_kwargs):
        captured.update({"payload": payload, "request_id": request_id, "webhook_id": item["id"], "test_mode": test_mode})
        return {"ok": True, "statusCode": 202, "retriesUsed": 0, "latencyMs": 14.5, "deliveryId": "delivery-created"}

    monkeypatch.setattr(webhook_center, "_connections", ConnectionService())
    monkeypatch.setattr(webhook_center, "dispatch_webhook_with_retry", dispatch)
    app = FastAPI()

    @app.middleware("http")
    async def reviewer_identity(request, call_next):
        request.state.user = SimpleNamespace(id="operator-a", role="meta_reviewer", business_id="tenant-a")
        return await call_next(request)

    app.include_router(webhook_center.router)
    client = TestClient(app)

    default = client.get(f"/webhooks/{owned['id']}/test-payload")
    assert default.status_code == 200
    assert default.json()["payload"]["instance"] == "runtime-owned"
    response = client.post(f"/webhooks/{owned['id']}/test", json={"payload": {"instance": "runtime-foreign", "text": "manual test", "token": "never-return"}})
    assert response.status_code == 200
    assert response.json()["deliveryId"] == "delivery-created"
    assert "never-return" not in response.text
    assert captured["webhook_id"] == owned["id"] and captured["test_mode"] is True
    assert captured["payload"]["instance"] == "runtime-owned"
    assert captured["payload"]["text"] == "manual test"
    assert captured["payload"]["meta"]["source"] == "webhook_center_test"
    assert client.post(f"/webhooks/{owned['id']}/test", json={"payload": "not-an-object"}).status_code == 422
    assert client.post(f"/webhooks/{disabled['id']}/test", json={}).status_code == 409
    assert client.post(f"/webhooks/{foreign['id']}/test", json={}).status_code == 403
