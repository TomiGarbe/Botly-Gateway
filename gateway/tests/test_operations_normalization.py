from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services.connection_diagnostics import ConnectionDiagnosticsService
from app.services.connection_operations import ConnectionOperationUnavailableError, ConnectionOperationsService
from app.services.connection_registry import ConnectionRegistry
from app.services.clients import ClientService
from app.services.connections import ConnectionService


class _Runtime:
    def __init__(self, name: str, *, connection_type: str = "baileys", status: str = "open") -> None:
        self.name = name
        self.connection_type = connection_type
        self.status = status
        self.reconnect_calls: list[str] = []

    async def list_instances(self) -> list[dict[str, str]]:
        return [{"name": self.name, "connectionType": self.connection_type, "status": self.status}]

    async def reconnect(self, name: str) -> dict[str, bool]:
        self.reconnect_calls.append(name)
        await asyncio.sleep(0.01)
        return {"ok": True}


def _connection(tmp_path, *, provider: str = "evolution"):
    registry = ConnectionRegistry(tmp_path / "connection_registry.json")
    client = ClientService(registry).create_client("Operations")
    connection = ConnectionService(_Runtime("unused"), registry).create_connection(
        client_id=client.id,
        channel="whatsapp",
        provider=provider,
    )
    return registry, connection


def test_reconnect_is_real_for_evolution_and_rejects_concurrent_duplicates(monkeypatch, tmp_path) -> None:
    registry, connection = _connection(tmp_path)
    runtime_name = registry.connection_record_by_id(connection.id)["legacy_name"]
    runtime = _Runtime(runtime_name)
    monkeypatch.setattr("app.services.connection_operations.get_credential_manager", lambda: SimpleNamespace(get_official_credentials_info=lambda _name: None))
    operations = ConnectionOperationsService(runtime, registry)

    async def run() -> None:
        first = asyncio.create_task(operations.reconnect(connection.id))
        await asyncio.sleep(0)
        with pytest.raises(ConnectionOperationUnavailableError, match="already running"):
            await operations.reconnect(connection.id)
        result = await first
        assert result == {"operation": "reconnect", "provider": "evolution", "status": "requested"}

    asyncio.run(run())
    assert runtime.reconnect_calls == [runtime_name]


def test_meta_reconnect_is_not_presented_as_a_completed_action(monkeypatch, tmp_path) -> None:
    registry, connection = _connection(tmp_path, provider="meta")
    runtime_name = registry.connection_record_by_id(connection.id)["legacy_name"]
    credential = SimpleNamespace(access_token_hash="hash", updated_at="2026-08-20T00:00:00Z", phone_number_id="phone", business_account_id="waba")
    monkeypatch.setattr("app.services.connection_operations.get_credential_manager", lambda: SimpleNamespace(get_official_credentials_info=lambda _name: credential))
    operations = ConnectionOperationsService(_Runtime(runtime_name, connection_type="cloud"), registry)

    with pytest.raises(ConnectionOperationUnavailableError, match="stateless"):
        asyncio.run(operations.reconnect(connection.id))


@pytest.mark.parametrize(
    ("hooks", "expected"),
    [
        ([], False),
        ([{"id": "hook", "enabled": False, "url": "https://example.test", "authType": "NONE"}], False),
        ([{"id": "hook", "enabled": True, "url": "ftp://example.test", "authType": "NONE"}], False),
        ([{"id": "hook", "enabled": True, "url": "https://example.test", "authType": "BEARER", "authConfig": {"hasToken": True}}], True),
    ],
)
def test_webhook_configuration_verification_is_local_and_honest(monkeypatch, tmp_path, hooks, expected) -> None:
    registry, connection = _connection(tmp_path)
    monkeypatch.setattr("app.services.connection_operations.list_instance_webhooks", lambda *_args, **_kwargs: hooks)

    result = ConnectionOperationsService(_Runtime("unused"), registry).verify_webhook_configuration(connection.id)

    assert result["diagnostic"] == "verify_webhook_configuration"
    assert result["connectivity_checked"] is False
    assert result["configuration_valid"] is expected


def test_availability_diagnostic_reports_provider_limitations_without_secrets(monkeypatch, tmp_path) -> None:
    registry, connection = _connection(tmp_path, provider="meta")
    runtime_name = registry.connection_record_by_id(connection.id)["legacy_name"]
    credential = SimpleNamespace(access_token_hash="hash", updated_at="2026-08-20T00:00:00Z", phone_number_id="phone", business_account_id="waba")
    monkeypatch.setattr("app.services.connection_diagnostics.get_settings", lambda: SimpleNamespace(meta_graph_version="v23.0"))
    monkeypatch.setattr("app.services.connection_diagnostics.list_instance_webhooks", lambda *_args, **_kwargs: [])
    diagnostics = ConnectionDiagnosticsService(
        _Runtime(runtime_name, connection_type="cloud"),
        registry,
        SimpleNamespace(get_official_credentials_info=lambda _name: credential),
        lambda **_kwargs: [],
    )

    result = asyncio.run(diagnostics.verify_availability(connection.id))

    assert result["diagnostic"] == "verify_availability"
    assert result["provider"] == "meta"
    assert result["deep_provider_health_checked"] is False
    assert "Graph API request" in result["limitation"]
    assert "hash" not in str(result)
