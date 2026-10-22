import asyncio

import pytest

from app.adapters.evolution.errors import EvolutionError
from app.services import connection_operations as ops
from app.services.connection_registry import ConnectionRegistry
from app.services.provider_session import record_connection_update


class FakeManager:
    def __init__(self, *, logout_fails=False):
        self.calls, self.logout_fails = [], logout_fails

    async def list_instances(self):
        return [{"name": "runtime-a", "connectionStatus": "connecting"}]

    async def disconnect(self, name, *, connection_type=None):
        self.calls.append(("logout", name))
        if self.logout_fails:
            raise EvolutionError(message="instance is not connected", status_code=400)
        return {"ok": True}

    async def delete(self, name, *, connection_type=None):
        self.calls.append(("delete", name))

    async def create(self, name, *, qrcode=True, connection_type=None):
        self.calls.append(("create", name, qrcode))


@pytest.fixture
def registry(tmp_path):
    registry = ConnectionRegistry(tmp_path / "registry.json")
    registry.save_connection_record("runtime-a", {"id": "conn-a", "client_id": "client-a", "legacy_name": "runtime-a",
                                                  "provider_id": "evolution", "channel_id": "whatsapp", "status_state": "connected"})
    return registry


def test_healthy_session_logs_out_and_keeps_the_instance(registry, monkeypatch):
    manager = FakeManager()
    result = asyncio.run(ops.ConnectionOperationsService(manager, registry).disconnect("conn-a"))
    assert result["mode"] == "logout" and manager.calls == [("logout", "runtime-a")]
    record = registry.connection_record_by_id("conn-a")
    assert record["status_state"] == "disconnected" and record["provider_session"]["statusReason"] == "manual_disconnect"


def test_broken_session_is_recreated_under_the_same_name(registry, monkeypatch):
    webhooks = []
    async def ensure(manager, name, *, force_configure=False):
        webhooks.append((name, force_configure))
    monkeypatch.setattr(ops, "ensure_evolution_webhook", ensure)
    manager = FakeManager(logout_fails=True)
    result = asyncio.run(ops.ConnectionOperationsService(manager, registry).disconnect("conn-a"))
    assert result["mode"] == "reset"
    assert manager.calls == [("logout", "runtime-a"), ("delete", "runtime-a"), ("create", "runtime-a", True)]
    assert webhooks == [("runtime-a", True)]


def test_only_evolution_connections_can_be_unlinked(registry):
    registry.update_connection_record("conn-a", {"provider_id": "meta"})
    with pytest.raises(ops.ConnectionOperationUnavailableError):
        asyncio.run(ops.ConnectionOperationsService(FakeManager(), registry).disconnect("conn-a"))


def test_connection_updates_are_recorded_only_when_they_change(registry):
    update = {"event": "connection.update", "instance": "runtime-a", "data": {"state": "close", "statusReason": 401}}
    assert record_connection_update(update, registry=registry) is True
    assert record_connection_update(update, registry=registry) is False
    session = registry.connection_record_by_id("conn-a")["provider_session"]
    assert (session["state"], session["statusReason"]) == ("close", 401)
    assert record_connection_update({"event": "qrcode.updated", "instance": "runtime-a", "data": {}}, registry=registry) is False
