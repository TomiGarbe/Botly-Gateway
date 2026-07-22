from __future__ import annotations

from app.domain import (
    ChannelId,
    ChannelProvisioningService,
    ChannelStatus,
    ChannelStore,
    MethodId,
    RuntimeResolver,
    RuntimeId,
    build_default_domain_registry,
)
from app.platforms.meta import MetaResource, MetaResourceStatus, MetaResourceType
from app.platforms.meta.resource_store import MetaResourceStore


def test_channel_provisioning_creates_whatsapp_official_from_meta_resource(tmp_path) -> None:
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    channel_store = ChannelStore(path_factory=lambda: str(tmp_path / "channels.json"))
    resource = MetaResource.build(
        resource_type=MetaResourceType.WHATSAPP_BUSINESS,
        external_id="waba_456",
        display_name="Acme Support",
    )
    resource_store.sync(resources=(resource,), scope_id="waba_456")

    service = ChannelProvisioningService(
        channel_store=channel_store,
        meta_resource_store=resource_store,
    )
    channel = service.provision_from_meta_resource(resource)

    assert channel is not None
    assert channel.channel_id == ChannelId.WHATSAPP
    assert channel.method_id == MethodId.OFFICIAL
    assert channel.integration_id == "whatsapp.official.evolution"
    assert channel.runtime_id == RuntimeId.EVOLUTION
    assert channel.status == ChannelStatus.ACTIVE
    assert channel.metadata == {
        "sourceResourceId": resource.id,
        "sourceResourceType": MetaResourceType.WHATSAPP_BUSINESS.value,
        "sourceExternalId": "waba_456",
    }

    active_resource = resource_store.list(scope_id="waba_456")[0]
    assert active_resource.status == MetaResourceStatus.ACTIVE


def test_channel_provisioning_does_not_duplicate_existing_channel(tmp_path) -> None:
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    channel_store = ChannelStore(path_factory=lambda: str(tmp_path / "channels.json"))
    resource = MetaResource.build(
        resource_type=MetaResourceType.WHATSAPP_BUSINESS,
        external_id="waba_456",
        display_name="Acme Support",
    )
    resource_store.sync(resources=(resource,), scope_id="waba_456")
    service = ChannelProvisioningService(channel_store=channel_store, meta_resource_store=resource_store)

    first = service.provision_from_meta_resource(resource)
    second = service.provision_from_meta_resource(resource)

    assert first == second
    assert len(channel_store.list()) == 1


def test_channel_provisioning_creates_instagram_official_from_meta_resource(tmp_path) -> None:
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    channel_store = ChannelStore(path_factory=lambda: str(tmp_path / "channels.json"))
    resource = MetaResource.build(
        resource_type=MetaResourceType.INSTAGRAM,
        external_id="ig_1",
        display_name="acme",
        metadata={"pageId": "page_1"},
    )
    resource_store.sync(resources=(resource,), scope_id="waba_456")
    service = ChannelProvisioningService(channel_store=channel_store, meta_resource_store=resource_store)

    channel = service.provision_from_meta_resource(resource)

    assert channel is not None
    assert channel.channel_id == ChannelId.INSTAGRAM
    assert channel.method_id == MethodId.OFFICIAL
    assert channel.integration_id == "instagram.official.evolution"
    assert channel.runtime_id == RuntimeId.EVOLUTION
    assert channel.metadata["sourceResourceId"] == resource.id
    assert channel.metadata["sourceResourceType"] == MetaResourceType.INSTAGRAM.value
    assert channel.metadata["sourceExternalId"] == "ig_1"
    assert channel.metadata["sourcePageId"] == "page_1"
    assert channel.metadata["graphSendNodeId"] == "page_1"


def test_channel_provisioning_leaves_unregistered_meta_resources_unactivated(tmp_path) -> None:
    service = ChannelProvisioningService(
        channel_store=ChannelStore(path_factory=lambda: str(tmp_path / "channels.json")),
        meta_resource_store=MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json")),
    )
    resource = MetaResource.build(
        resource_type=MetaResourceType.MESSENGER,
        external_id="page_1",
        display_name="Acme Page",
    )

    assert service.provision_from_meta_resource(resource) is None


def test_runtime_resolver_resolves_from_provisioned_channel(tmp_path) -> None:
    channel_store = ChannelStore(path_factory=lambda: str(tmp_path / "channels.json"))
    resource_store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    resource = MetaResource.build(
        resource_type=MetaResourceType.WHATSAPP_BUSINESS,
        external_id="waba_456",
        display_name="Acme Support",
    )
    resource_store.sync(resources=(resource,), scope_id="waba_456")
    channel = ChannelProvisioningService(
        channel_store=channel_store,
        meta_resource_store=resource_store,
    ).provision_from_meta_resource(resource)

    assert channel is not None
    resolution = RuntimeResolver(build_default_domain_registry()).resolve_channel(channel)

    assert resolution.integration.id == "whatsapp.official.evolution"
    assert resolution.runtime.id == RuntimeId.EVOLUTION
