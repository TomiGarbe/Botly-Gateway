from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import settings as settings_router
from app.services.clients import ClientService
from app.services.connection_registry import ConnectionRegistry
from app.services.connections import ConnectionService
from app.services.gateway_settings import ChannelDisabledError, ChannelNotImplementedError, GatewaySettingsService, ProviderDisabledError


class _EmptyRuntime:
    async def list_instances(self) -> list[dict]:
        return []


class _EvolutionRuntime(_EmptyRuntime):
    def __init__(self) -> None:
        self.created: list[tuple[str, dict]] = []

    async def create(self, instance_name: str, **kwargs) -> dict:
        self.created.append((instance_name, kwargs))
        return {"instanceName": instance_name}

    async def connect(self, instance_name: str, **_kwargs) -> dict:
        return {"qrcode": {"base64": "qr-data"}, "instance": {"instanceName": instance_name}}


def test_channel_settings_persist_and_keep_implementation_server_owned(tmp_path) -> None:
    path = tmp_path / "gateway_settings.json"
    service = GatewaySettingsService(path)

    assert service.channels()["whatsapp"]["enabled"] is True
    assert service.channels()["instagram"] == {
        "name": "Instagram",
        "description": "Mensajería de Instagram desde Meta.",
        "icon": "instagram",
        "implemented": False,
        "enabled": False,
    }

    service.update_channels({"whatsapp": False})
    assert GatewaySettingsService(path).channels()["whatsapp"]["enabled"] is False


def test_connection_creation_requires_an_enabled_implemented_channel(tmp_path) -> None:
    settings = GatewaySettingsService(tmp_path / "gateway_settings.json")
    registry = ConnectionRegistry(tmp_path / "connection_registry.json")
    client = ClientService(registry).create_client("Global Tech")
    service = ConnectionService(_EmptyRuntime(), registry, settings)

    with pytest.raises(ChannelNotImplementedError, match="todavía no está disponible"):
        service.create_connection(client_id=client.id, channel="instagram")

    settings.update_channels({"whatsapp": False})
    with pytest.raises(ChannelDisabledError, match="deshabilitado por la configuración"):
        service.create_connection(client_id=client.id, channel="whatsapp")


@pytest.mark.parametrize("provider_id", ["meta", "evolution"])
def test_connection_creation_requires_enabled_providers(tmp_path, provider_id: str) -> None:
    settings = GatewaySettingsService(tmp_path / "gateway_settings.json")
    registry = ConnectionRegistry(tmp_path / "connection_registry.json")
    client = ClientService(registry).create_client("Global Tech")
    service = ConnectionService(_EmptyRuntime(), registry, settings)

    settings.update_providers({provider_id: False})

    with pytest.raises(ProviderDisabledError, match=provider_id):
        service.create_connection(client_id=client.id, channel="whatsapp", provider=provider_id)


def test_evolution_connection_keeps_initial_name_and_starts_qr_runtime(tmp_path) -> None:
    settings = GatewaySettingsService(tmp_path / "gateway_settings.json")
    registry = ConnectionRegistry(tmp_path / "connection_registry.json")
    client = ClientService(registry).create_client("Global Tech")
    runtime = _EvolutionRuntime()
    service = ConnectionService(runtime, registry, settings)

    pending = service.create_connection(
        client_id=client.id,
        channel="whatsapp",
        name="Ventas Argentina",
        provider="evolution",
    )
    started = asyncio.run(service.start_evolution_connection(pending.id))
    qr = asyncio.run(service.evolution_qr(pending.id))

    assert started.name == "Ventas Argentina"
    assert started.provider.id == "evolution"
    assert started.capabilities.supports_qr is True
    assert runtime.created == [(pending.technical["legacy_instance_name"], {"qrcode": True, "connection_type": "baileys"})]
    assert qr["qrcode"]["base64"] == "qr-data"


def test_settings_providers_api_reads_and_updates_persisted_state(monkeypatch, tmp_path) -> None:
    service = GatewaySettingsService(tmp_path / "gateway_settings.json")
    monkeypatch.setattr(settings_router, "_service", service)
    api = FastAPI()
    api.include_router(settings_router.router)
    client = TestClient(api)

    response = client.get("/settings/providers")
    assert response.status_code == 200
    assert response.json()["providers"]["meta"]["enabled"] is True
    assert response.json()["providers"]["evolution"]["enabled"] is True

    updated = client.patch("/settings/providers", json={"providers": {"meta": {"enabled": False}}})
    assert updated.status_code == 200
    assert updated.json()["providers"]["meta"]["enabled"] is False
    assert GatewaySettingsService(tmp_path / "gateway_settings.json").providers()["meta"]["enabled"] is False

    unknown = client.patch("/settings/providers", json={"providers": {"unknown": {"enabled": True}}})
    assert unknown.status_code == 422
    assert "Unknown provider" in unknown.json()["detail"]


def test_settings_channels_api_reads_and_updates_persisted_state(monkeypatch, tmp_path) -> None:
    service = GatewaySettingsService(tmp_path / "gateway_settings.json")
    monkeypatch.setattr(settings_router, "_service", service)
    api = FastAPI()
    api.include_router(settings_router.router)
    client = TestClient(api)

    response = client.get("/settings/channels")
    assert response.status_code == 200
    assert response.json()["channels"]["whatsapp"]["implemented"] is True

    updated = client.patch("/settings/channels", json={"channels": {"whatsapp": {"enabled": False}}})
    assert updated.status_code == 200
    assert updated.json()["channels"]["whatsapp"]["enabled"] is False
    assert GatewaySettingsService(tmp_path / "gateway_settings.json").channels()["whatsapp"]["enabled"] is False

    unavailable = client.patch("/settings/channels", json={"channels": {"instagram": {"enabled": True}}})
    assert unavailable.status_code == 422
    assert "todavía no está disponible" in unavailable.json()["detail"]
