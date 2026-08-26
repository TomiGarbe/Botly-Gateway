from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import analytics as analytics_router
from app.services.analytics import AnalyticsService


def _connection(identifier: str, runtime: str, provider: str, *, client: str = "tenant-a"):
    return SimpleNamespace(id=identifier, name=f"Connection {identifier}", client_id=client, provider=SimpleNamespace(id=provider), technical={"legacy_instance_name": runtime})


class _ProviderRows:
    def __init__(self, rows): self.rows = rows
    def analytics_records(self): return self.rows


class _Attempts:
    def __init__(self, rows): self.rows = rows
    def list(self): return self.rows


def test_analytics_aggregates_existing_sources_without_counting_status_as_messages(monkeypatch) -> None:
    provider_rows = [
        ("runtime-evo", {"timestamp": 1_000, "provider": "evolution", "direction": "inbound", "operation": "provider.message.inbound", "semanticStatus": "success", "deliveryState": "accepted", "reconciliationState": "not_required", "durationMs": 10}),
        ("runtime-evo", {"timestamp": 2_000, "provider": "evolution", "direction": "outbound", "operation": "provider.message.outbound", "semanticStatus": "timeout", "deliveryState": "unknown", "reconciliationState": "pending", "durationMs": 20}),
        ("runtime-meta", {"timestamp": 3_000, "provider": "meta", "direction": "status", "operation": "provider.message.status", "semanticStatus": "unknown", "deliveryState": "delivered", "reconciliationState": "not_required", "durationMs": 30}),
        ("runtime-meta", {"timestamp": 4_000, "provider": "meta", "direction": "outbound", "operation": "provider.message.outbound", "semanticStatus": "failed", "deliveryState": "failed", "reconciliationState": "not_required", "durationMs": 40}),
        ("runtime-evo", {"timestamp": 5_000, "provider": None, "direction": "inbound", "operation": "provider.message.inbound", "semanticStatus": "network_error", "deliveryState": None, "reconciliationState": None, "durationMs": None}),
    ]
    attempts = [
        {"instance": "runtime-evo", "createdAt": 2_000, "semanticStatus": "timeout", "deliveryState": "unknown", "reconciliationState": "pending"},
        {"instance": "runtime-meta", "createdAt": 3_000, "semanticStatus": "timeout", "deliveryState": "delivered", "reconciliationState": "not_required", "lastReconciliation": {"status": "found"}},
    ]
    webhooks = [
        {"instanceName": "runtime-evo", "timestamp": 1_000, "semanticStatus": "success", "durationMs": 10, "attemptCount": 1, "retryCount": 0, "isTest": True},
        {"instanceName": "runtime-meta", "timestamp": 4_000, "semanticStatus": "timeout", "durationMs": 30, "attemptCount": 2, "retryCount": 1, "isTest": False},
    ]
    actions = [
        {"connectionId": "evo", "createdAt": 2_000, "action": "resend_provider_outbound", "status": "completed"},
        {"connectionId": "meta", "createdAt": 4_000, "action": "resend_provider_outbound", "status": "blocked"},
    ]
    monkeypatch.setattr("app.services.analytics.list_all_delivery_summaries", lambda: webhooks)
    monkeypatch.setattr("app.services.analytics.list_action_summaries", lambda: actions)
    service = AnalyticsService(provider_deliveries=_ProviderRows(provider_rows), attempts=_Attempts(attempts))

    result = service.snapshot(connections=[_connection("evo", "runtime-evo", "evolution"), _connection("meta", "runtime-meta", "meta")], from_ms=0, to_ms=10_000, granularity="hour")

    assert result["summary"] == {"totalMessages": 4, "inboundMessages": 2, "outboundMessages": 2, "providerDeliveries": 5, "providerTechnicalSuccess": 1, "providerFailures": 1, "providerUnknown": 1, "pendingReconciliation": 1, "webhookDeliveries": 2, "webhookFailures": 1}
    evolution, meta = result["providers"]
    assert evolution["messages"] == 2 and evolution["statusEvents"] == 0
    assert meta["messages"] == 1 and meta["statusEvents"] == 1
    assert meta["technical"]["unknown"] == 1 and meta["deliveryStates"]["delivered"] == 1
    assert meta["latency"] == {"sampleCount": 2, "averageMs": 35.0, "p95Ms": 40.0}
    assert result["attempts"]["pendingReconciliation"] == 1 and result["attempts"]["reconciled"] == 1
    assert result["webhooks"]["testDeliveries"] == 1 and result["webhooks"]["realDeliveries"] == 1 and result["webhooks"]["retries"] == 1
    assert result["manualActions"] == {"totalActions": 2, "resendTotal": 2, "resendCompleted": 1, "resendFailed": 0, "resendBlocked": 1}
    assert result["timeseries"] == [{"bucketStartUtc": "1970-01-01T00:00:00Z", "messages": 4, "providerFailures": 1, "providerUnknown": 1, "webhookFailures": 1}]


def test_analytics_empty_and_time_ranges_return_null_latency(monkeypatch) -> None:
    monkeypatch.setattr("app.services.analytics.list_all_delivery_summaries", lambda: [])
    monkeypatch.setattr("app.services.analytics.list_action_summaries", lambda: [])
    service = AnalyticsService(provider_deliveries=_ProviderRows([]), attempts=_Attempts([]))
    result = service.snapshot(connections=[_connection("a", "runtime-a", "evolution")], from_ms=1_000, to_ms=2_000, granularity="day")
    assert result["summary"]["totalMessages"] == 0
    assert result["providers"] == [] and result["timeseries"] == []
    assert result["webhooks"]["latency"] == {"sampleCount": 0, "averageMs": None, "p95Ms": None}
    assert result["connections"][0]["connectionId"] == "a"


def test_analytics_endpoint_enforces_owned_connection_and_validates_range(monkeypatch) -> None:
    class _Connections:
        async def list_connections(self): return [_connection("a", "runtime-a", "evolution", client="tenant-a"), _connection("b", "runtime-b", "meta", client="tenant-b")]
        async def get_connection(self, identifier):
            from app.services.connections import ConnectionNotFoundError
            for item in await self.list_connections():
                if item.id == identifier: return item
            raise ConnectionNotFoundError(identifier)

    class _Analytics:
        def snapshot(self, **kwargs):
            assert [connection.id for connection in kwargs["connections"]] == ["a"]
            return {"range": {"fromUtc": "2026-01-01T00:00:00Z", "toUtc": "2026-01-02T00:00:00Z", "inclusiveStart": True, "exclusiveEnd": True, "granularity": "day"}, "summary": {"totalMessages": 0, "inboundMessages": 0, "outboundMessages": 0, "providerDeliveries": 0, "providerTechnicalSuccess": 0, "providerFailures": 0, "providerUnknown": 0, "pendingReconciliation": 0, "webhookDeliveries": 0, "webhookFailures": 0}, "providers": [], "attempts": {"totalAttempts": 0, "technical": {}, "deliveryStates": {}, "accepted": 0, "pendingReconciliation": 0, "reconciled": 0, "stillUnknown": 0}, "manualActions": {"totalActions": 0, "resendTotal": 0, "resendCompleted": 0, "resendFailed": 0, "resendBlocked": 0}, "webhooks": {"totalDeliveries": 0, "technical": {}, "testDeliveries": 0, "realDeliveries": 0, "totalAttempts": 0, "retries": 0, "technicalSuccessRate": None, "technicalFailureRate": None, "latency": {"sampleCount": 0, "averageMs": None, "p95Ms": None}}, "connections": [], "timeseries": []}

    monkeypatch.setattr(analytics_router, "_connections", _Connections())
    monkeypatch.setattr(analytics_router, "_analytics", _Analytics())
    app = FastAPI()
    @app.middleware("http")
    async def identity(request, call_next):
        request.state.user = SimpleNamespace(role="meta_reviewer", business_id="tenant-a")
        return await call_next(request)
    app.include_router(analytics_router.router)
    http = TestClient(app)

    response = http.get("/analytics", params={"preset": "custom", "date_from": "2026-01-01T00:00:00Z", "date_to": "2026-01-02T00:00:00Z", "granularity": "day"})
    assert response.status_code == 200 and response.json()["range"]["exclusiveEnd"] is True
    assert http.get("/analytics", params={"connection_id": "b"}).status_code == 403
    assert http.get("/analytics", params={"preset": "custom"}).status_code == 422
    assert http.get("/analytics", params={"preset": "24h", "date_from": "2026-01-01T00:00:00Z"}).status_code == 422
