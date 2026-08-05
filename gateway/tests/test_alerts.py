from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domain.connection import (
    Channel,
    Connection,
    ConnectionApiKey,
    ConnectionCapabilities,
    ConnectionClient,
    ConnectionStatus,
    ConnectionWebhook,
    Provider,
)
from app.routers import alerts as alerts_router
from app.services.alerts import AlertService, AlertStore


NOW = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)


def _connection(connection_id: str, *, state: str = "connected", health: str = "healthy", lifecycle: str | None = None) -> Connection:
    client = ConnectionClient(id="client-1", name="Global Tech")
    return Connection(
        id=connection_id,
        client_id=client.id,
        name=f"WhatsApp {connection_id}",
        display_name=None,
        address=None,
        provider=Provider(id="meta", display_name="Meta"),
        channel=Channel(id="whatsapp", display_name="WhatsApp"),
        status=ConnectionStatus(state=state, lifecycle=lifecycle, health=health),
        capabilities=ConnectionCapabilities(supports_webhook=True),
        webhook=ConnectionWebhook(supported=True),
        api_key=ConnectionApiKey(supported=True),
        client=client,
    )


class _Connections:
    def __init__(self) -> None:
        self.items = [
            _connection("disconnected", state="disconnected"),
            _connection("heartbeat"),
            _connection("webhook"),
            _connection("signup", state="pending"),
            _connection("auth", lifecycle="token_expired"),
            _connection("reconnect"),
            _connection("degraded", health="degraded"),
        ]

    async def list_connections(self) -> list[Connection]:
        return self.items

    def connection_runtime_name(self, connection_id: str) -> str:
        return connection_id

    def connection_last_heartbeat_at(self, connection_id: str) -> str | None:
        if connection_id == "heartbeat":
            return (NOW - timedelta(minutes=16)).isoformat().replace("+00:00", "Z")
        return None


class _Operations:
    def webhook(self, connection_id: str) -> dict:
        return {"last_error": "delivery failed" if connection_id == "webhook" else None}


def _service(tmp_path) -> AlertService:
    return AlertService(
        connections=_Connections(),  # type: ignore[arg-type]
        operations=_Operations(),  # type: ignore[arg-type]
        store=AlertStore(tmp_path / "alerts.json"),
        events_reader=lambda **_kwargs: [
            {"instance": "reconnect", "timestamp": int(NOW.timestamp() * 1000), "event": "CONNECTION_RECONNECT"},
            {"instance": "reconnect", "timestamp": int(NOW.timestamp() * 1000), "event": "CONNECTION_RECONNECT"},
            {"instance": "reconnect", "timestamp": int(NOW.timestamp() * 1000), "event": "CONNECTION_RECONNECT"},
        ],
        now=lambda: NOW,
    )


def test_alert_service_returns_actionable_connection_incidents(tmp_path) -> None:
    service = _service(tmp_path)
    alerts = asyncio.run(service.list_alerts())

    assert {alert.title for alert in alerts} == {
        "Conexión desconectada",
        "Heartbeat vencido",
        "Webhook con errores",
        "Embedded Signup pendiente",
        "Error de autenticación",
        "Reconexiones repetidas",
        "Proveedor degradado",
    }
    assert all(alert.workspace_url == f"/connections/{alert.connection.id}" for alert in alerts)
    assert {alert.severity for alert in alerts} <= {"critical", "warning", "info"}

    acknowledged = asyncio.run(service.acknowledge(alerts[0].id))
    assert acknowledged is not None
    assert acknowledged.status == "acknowledged"
    resolved = asyncio.run(service.resolve(alerts[0].id))
    assert resolved is not None
    assert resolved.status == "resolved"
    assert resolved.resolved_at is not None


def test_alerts_router_exposes_list_acknowledge_and_resolve(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(alerts_router, "_service", _service(tmp_path))
    api = FastAPI()
    api.include_router(alerts_router.router)
    http = TestClient(api)

    listed = http.get("/alerts")
    assert listed.status_code == 200
    alert_id = listed.json()["items"][0]["id"]
    assert http.post(f"/alerts/{alert_id}/acknowledge").json()["status"] == "acknowledged"
    assert http.post(f"/alerts/{alert_id}/resolve").json()["status"] == "resolved"
