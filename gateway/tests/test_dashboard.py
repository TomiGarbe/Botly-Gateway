from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domain.client import Client
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
from app.routers import dashboard as dashboard_router
from app.services.dashboard import DashboardService


def _connection(connection_id: str, *, state: str, health: str = "healthy") -> Connection:
    client = ConnectionClient(id="client-1", name="Global Tech")
    return Connection(
        id=connection_id,
        client_id=client.id,
        name="WhatsApp soporte" if connection_id == "connection-1" else "WhatsApp ventas",
        display_name=None,
        address=None,
        provider=Provider(id="meta", display_name="Meta"),
        channel=Channel(id="whatsapp", display_name="WhatsApp"),
        status=ConnectionStatus(state=state, lifecycle=None, health=health),
        capabilities=ConnectionCapabilities(supports_webhook=True),
        webhook=ConnectionWebhook(supported=True),
        api_key=ConnectionApiKey(supported=True),
        client=client,
    )


class _Connections:
    async def list_connections(self) -> list[Connection]:
        return [_connection("connection-1", state="connected"), _connection("connection-2", state="disconnected")]

    def connection_runtime_name(self, connection_id: str) -> str:
        return {"connection-1": "support", "connection-2": "sales"}[connection_id]

    def connection_last_heartbeat_at(self, _connection_id: str) -> None:
        return None


class _Clients:
    def list_clients(self) -> list[Client]:
        return [Client(id="client-1", name="Global Tech", description=None, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z")]


class _Operations:
    def webhook(self, _connection_id: str) -> dict:
        return {"last_error": None}


def _service() -> DashboardService:
    return DashboardService(
        connections=_Connections(),  # type: ignore[arg-type]
        clients=_Clients(),  # type: ignore[arg-type]
        operations=_Operations(),  # type: ignore[arg-type]
        events_reader=lambda **_kwargs: [
            {"id": "event-1", "event": "CONNECTION_CREATED", "instance": "support", "timestamp": 100, "severity": "SUCCESS", "details": {"client_id": "client-1"}},
            {"id": "event-2", "direction": "outbound", "instance": "support", "timestamp": 90, "severity": "SUCCESS"},
        ],
        now=lambda: datetime(2026, 8, 4, tzinfo=timezone.utc),
    )


def test_dashboard_snapshot_is_an_operational_summary() -> None:
    snapshot = asyncio.run(_service().snapshot()).public_dict()

    assert snapshot["overall"] == {"state": "critical", "label": "Problemas críticos"}
    assert snapshot["metrics"] == {"clients": 1, "connections": 2, "connected": 1, "active_alerts": 1}
    assert snapshot["attention"] == [
        {
            "severity": "critical",
            "status": "Desconectada",
            "client": {"id": "client-1", "name": "Global Tech"},
            "connection": {"id": "connection-2", "name": "WhatsApp ventas"},
        }
    ]
    descriptions = [item["description"] for item in snapshot["recent_activity"]]
    assert {"Cliente creado", "Conexión creada", "Mensaje enviado"}.issubset(descriptions)
    connection_created = next(item for item in snapshot["recent_activity"] if item["description"] == "Conexión creada")
    assert connection_created["connection"]["id"] == "connection-1"


def test_dashboard_router_exposes_one_snapshot(monkeypatch) -> None:
    monkeypatch.setattr(dashboard_router, "_service", _service())
    api = FastAPI()
    api.include_router(dashboard_router.router)

    response = TestClient(api).get("/dashboard")

    assert response.status_code == 200
    assert response.json()["metrics"]["connections"] == 2
