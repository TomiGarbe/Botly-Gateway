from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import connection_setups as setup_router
from app.services.clients import ClientService
from app.services.connection_registry import ConnectionRegistry
from app.services.connection_setups import ConnectionSetupConflictError, ConnectionSetupService, InvalidConnectionSetupTransition
from app.services.connection_setup_cleanup import ConnectionSetupCleanupService
from app.services.gateway_settings import GatewaySettingsService


class _Runtime:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.webhooks: list[str] = []

    async def create(self, name: str, **_kwargs):
        self.created.append(name)
        return {"instanceName": name}

    async def set_webhook(self, name: str, *_args, **_kwargs):
        self.webhooks.append(name)

    async def delete(self, name: str, **_kwargs):
        self.created = [item for item in self.created if item != name]
        return {"deleted": name}


def _service(tmp_path, monkeypatch, runtime=None):
    monkeypatch.setattr("app.services.connection_setups.get_settings", lambda: SimpleNamespace(connection_setup_ttl_seconds=3600, gateway_port=9000))
    registry = ConnectionRegistry(tmp_path / "connections.json")
    client = ClientService(registry).create_client("Setup owner")
    return ConnectionSetupService(runtime or _Runtime(), registry, GatewaySettingsService(tmp_path / "settings.json")), registry, client


def test_meta_setup_is_not_inventory_until_atomically_promoted(monkeypatch, tmp_path) -> None:
    service, registry, client = _service(tmp_path, monkeypatch)
    setup = service.create(client_id=client.id, channel="whatsapp", name="Oficial", provider="meta", idempotency_key="meta-1")

    assert setup["state"] == "draft"
    assert registry.connection_records() == []
    assert service.begin_meta(setup["id"])["state"] == "onboarding"
    assert service.begin_meta_provisioning(setup["id"])["state"] == "provisioning"
    completed = service.complete_meta(setup["id"], phone_number_id="phone-1", business_account_id="waba-1")

    assert completed["state"] == "ready"
    assert completed["connection_id"]
    assert len(registry.connection_records()) == 1
    with pytest.raises(InvalidConnectionSetupTransition):
        service.cancel(setup["id"])
    with pytest.raises(InvalidConnectionSetupTransition):
        service.transition(setup["id"], "draft")


def test_setup_idempotency_reload_cancel_and_expiration(monkeypatch, tmp_path) -> None:
    service, registry, client = _service(tmp_path, monkeypatch)
    first = service.create(client_id=client.id, channel="whatsapp", name="Meta", provider="meta", idempotency_key="retry-key")
    repeated = service.create(client_id=client.id, channel="whatsapp", name="Other", provider="meta", idempotency_key="retry-key")

    assert repeated["id"] == first["id"]
    assert ConnectionSetupService(registry=registry, gateway_settings=GatewaySettingsService(tmp_path / "settings.json")).get(first["id"])["state"] == "draft"
    assert service.cancel(first["id"])["state"] == "cancelled"
    with pytest.raises(InvalidConnectionSetupTransition):
        service.transition(first["id"], "ready")

    expired = service.create(client_id=client.id, channel="whatsapp", name="Expires", provider="meta")
    registry.update_setup_record(expired["id"], {"expires_at": "2000-01-01T00:00:00Z"})
    assert service.get(expired["id"])["state"] == "expired"


def test_meta_failure_and_known_resource_cancellation_follow_lifecycle(monkeypatch, tmp_path) -> None:
    service, registry, client = _service(tmp_path, monkeypatch)
    failed = service.create(client_id=client.id, channel="whatsapp", name="Failure", provider="meta")
    service.begin_meta(failed["id"])
    service.begin_meta_provisioning(failed["id"])
    assert service.mark_meta_failed(failed["id"])["state"] == "failed"

    cleanup = service.create(client_id=client.id, channel="whatsapp", name="Cleanup", provider="meta")
    service.begin_meta(cleanup["id"])
    registry.update_setup_record(cleanup["id"], {"external_resources": [{"kind": "meta_phone_number", "identifier": "phone", "ownership_confirmed": False}]})
    assert service.cancel(cleanup["id"])["state"] == "cleanup_pending"


def test_meta_cancel_during_provisioning_preserves_external_assets_for_manual_cleanup(monkeypatch, tmp_path) -> None:
    service, _registry, client = _service(tmp_path, monkeypatch)
    setup = service.create(client_id=client.id, channel="whatsapp", name="Cancel", provider="meta")

    service.begin_meta(setup["id"])
    service.begin_meta_provisioning(
        setup["id"], phone_number_id="phone-1", business_account_id="waba-1"
    )
    cancelled = service.cancel(setup["id"])

    assert cancelled["state"] == "cleanup_pending"
    assert cancelled["cleanup_required"] is True
    with pytest.raises(ConnectionSetupConflictError):
        service.complete_meta(setup["id"], phone_number_id="phone-1", business_account_id="waba-1")


def test_evolution_setup_promotes_only_after_provisioning(monkeypatch, tmp_path) -> None:
    runtime = _Runtime()
    service, registry, client = _service(tmp_path, monkeypatch, runtime)
    setup = service.create(client_id=client.id, channel="whatsapp", name="QR", provider="evolution")
    ready = asyncio.run(service.provision_evolution(setup["id"]))

    assert ready["state"] == "ready"
    assert ready["connection_id"]
    assert runtime.created == [ready["runtime_name"]]
    assert runtime.webhooks == [ready["runtime_name"]]
    assert registry.connection_record_by_id(ready["connection_id"])["status_state"] == "connecting"


def test_setup_router_enforces_reviewer_ownership(monkeypatch, tmp_path) -> None:
    service, _registry, owner = _service(tmp_path, monkeypatch)
    setup = service.create(client_id=owner.id, channel="whatsapp", name="Private", provider="meta")
    monkeypatch.setattr(setup_router, "_service", service)
    app = FastAPI()

    @app.middleware("http")
    async def reviewer(request, call_next):
        request.state.user = SimpleNamespace(role="meta_reviewer", business_id="another-client")
        return await call_next(request)

    app.include_router(setup_router.router)
    assert TestClient(app).get(f"/connection-setups/{setup['id']}").status_code == 403


def test_expired_setup_with_owned_evolution_instance_is_cleaned_idempotently(monkeypatch, tmp_path) -> None:
    runtime = _Runtime()
    service, registry, client = _service(tmp_path, monkeypatch, runtime)
    setup = service.create(client_id=client.id, channel="whatsapp", name="Expired", provider="evolution")
    registry.update_setup_record(setup["id"], {"state": "provisioning", "external_resources": [{"kind": "evolution_instance", "identifier": setup["runtime_name"], "ownership_confirmed": True}], "expires_at": "2000-01-01T00:00:00Z"})
    assert service.get(setup["id"])["state"] == "cleanup_pending"

    cleanup = ConnectionSetupCleanupService(runtime, registry, service)
    first = asyncio.run(cleanup.cleanup(setup["id"]))
    second = asyncio.run(cleanup.cleanup(setup["id"]))

    assert first["state"] == "expired"
    assert first["cleanup_required"] is False
    assert second["state"] == "expired"


def test_meta_checkpoint_never_receives_automatic_cleanup(monkeypatch, tmp_path) -> None:
    runtime = _Runtime()
    service, registry, client = _service(tmp_path, monkeypatch, runtime)
    setup = service.create(client_id=client.id, channel="whatsapp", name="Meta", provider="meta")
    registry.update_setup_record(setup["id"], {"state": "cleanup_pending", "cleanup_required": True, "external_resources": [{"kind": "meta_phone_number", "identifier": "phone-1", "ownership_confirmed": False}]})
    result = asyncio.run(ConnectionSetupCleanupService(runtime, registry, service).cleanup(setup["id"]))

    assert result["state"] == "cleanup_pending"
    assert result["cleanup"]["last_error"] == "manual_verification_required"
