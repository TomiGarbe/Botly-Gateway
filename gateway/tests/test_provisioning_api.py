from __future__ import annotations

import asyncio

from app.domain import ChannelStore
from app.platforms.meta import MetaResource, MetaResourceStore, MetaResourceType
from app.provisioning import ConnectionRequest, ProvisioningService
from app.routers import provisioning as provisioning_router


def _service(tmp_path) -> ProvisioningService:
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    channel_store = ChannelStore(path_factory=lambda: str(tmp_path / "channels.json"))
    return ProvisioningService(channel_store=channel_store, meta_resource_store=resource_store)


def test_provisioning_catalog_is_public_and_registry_driven(tmp_path) -> None:
    catalog = _service(tmp_path).list_catalog()

    payload = [item.model_dump() for item in catalog]

    assert payload[0]["channel"] == "whatsapp"
    assert [method["id"] for method in payload[0]["methods"]] == ["web", "official"]
    assert "supports_text" in payload[0]["methods"][0]["capabilities"]
    assert "runtime" not in str(payload).lower()
    assert "integration" not in str(payload).lower()
    assert "evolution" not in str(payload).lower()


def test_provisioning_resources_do_not_expose_meta_metadata_or_external_ids(tmp_path) -> None:
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    resource = MetaResource.build(
        resource_type=MetaResourceType.WHATSAPP_BUSINESS,
        external_id="waba_secretish",
        display_name="Acme Support",
        metadata={"pageAccessToken": "secret-token", "phone": "+540000"},
    )
    resource_store.sync(resources=(resource,), scope_id="waba_secretish")

    service = ProvisioningService(
        channel_store=ChannelStore(path_factory=lambda: str(tmp_path / "channels.json")),
        meta_resource_store=resource_store,
    )

    payload = [item.model_dump() for item in service.list_resources()]

    assert payload == [
        {
            "id": "meta:WHATSAPP_BUSINESS:waba_secretish",
            "type": "WHATSAPP_BUSINESS",
            "display_name": "Acme Support",
            "status": "DISCOVERED",
        }
    ]
    assert "secret-token" not in str(payload)
    assert "metadata" not in payload[0]
    assert "external_id" not in payload[0]


def test_provisioning_connect_resolves_method_without_exposing_runtime(tmp_path) -> None:
    result = _service(tmp_path).start_connection(ConnectionRequest(channel="whatsapp", method="official"))

    payload = result.model_dump()

    assert payload["channel"] == "whatsapp"
    assert payload["method"] == "official"
    assert payload["authentication"] == "embedded_signup"
    assert payload["platform"]["id"] == "meta"
    assert payload["next_action"] == {
        "type": "embedded_signup",
        "discovery": "embedded_signup",
        "channel": "whatsapp",
        "method": "official",
        "platform": "meta",
    }
    assert "runtime" not in str(payload).lower()
    assert "integration" not in str(payload).lower()
    assert "evolution" not in str(payload).lower()


def test_provisioning_provisions_channel_from_resource_id(tmp_path) -> None:
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    channel_store = ChannelStore(path_factory=lambda: str(tmp_path / "channels.json"))
    resource = MetaResource.build(
        resource_type=MetaResourceType.WHATSAPP_BUSINESS,
        external_id="waba_456",
        display_name="Acme Support",
    )
    resource_store.sync(resources=(resource,), scope_id="waba_456")
    service = ProvisioningService(channel_store=channel_store, meta_resource_store=resource_store)

    channel = service.provision_resource(resource.id)

    assert channel.model_dump() == {
        "id": channel.id,
        "channel": "whatsapp",
        "method": "official",
        "display_name": "Acme Support",
        "status": "CONNECTED",
    }
    assert service.list_resources()[0].status == "ACTIVE"
    assert "runtime" not in str(channel.model_dump()).lower()
    assert "integration" not in str(channel.model_dump()).lower()


def test_provisioning_router_catalog_path_returns_public_list(tmp_path, monkeypatch) -> None:
    service = _service(tmp_path)
    monkeypatch.setattr(provisioning_router, "get_provisioning_service", lambda: service)

    payload = asyncio.run(provisioning_router.get_catalog())

    assert payload[0].channel == "whatsapp"
    assert payload[0].methods[0].id == "web"
