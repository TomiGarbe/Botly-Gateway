from __future__ import annotations

from app.connections import ConnectionType, get_connection_manager
from app.domain import (
    AuthenticationKind,
    Capability,
    ChannelId,
    DiscoveryType,
    MethodId,
    PlatformId,
    RuntimeResolver,
    RuntimeId,
    build_default_domain_registry,
)
from app.routers import channels as channels_router


def test_default_domain_registers_current_channels_platform_and_runtime() -> None:
    domain = build_default_domain_registry()

    assert [channel.id for channel in domain.channels.list()] == [ChannelId.WHATSAPP, ChannelId.INSTAGRAM]
    assert [platform.id for platform in domain.platforms.list()] == [PlatformId.META]
    assert [runtime.id for runtime in domain.runtimes.list()] == [RuntimeId.EVOLUTION]


def test_whatsapp_channel_defines_current_methods_and_capabilities() -> None:
    domain = build_default_domain_registry()
    whatsapp = domain.channels.require(ChannelId.WHATSAPP)

    assert whatsapp.name == "WhatsApp"
    assert whatsapp.icon == "whatsapp"
    assert [method.id for method in whatsapp.methods] == [
        MethodId.OFFICIAL,
        MethodId.WEB,
    ]
    assert whatsapp.capabilities.supports(Capability.SUPPORTS_MEDIA)
    assert whatsapp.capabilities.supports(Capability.SUPPORTS_EMBEDDED_SIGNUP)
    assert whatsapp.capabilities.supports(Capability.SUPPORTS_QR)
    assert whatsapp.capabilities.supports(Capability.SUPPORTS_TEMPLATES)


def test_instagram_channel_defines_official_method_and_capabilities() -> None:
    domain = build_default_domain_registry()
    instagram = domain.channels.require(ChannelId.INSTAGRAM)

    assert instagram.name == "Instagram"
    assert instagram.icon == "instagram"
    assert [method.id for method in instagram.methods] == [MethodId.OFFICIAL]
    assert instagram.capabilities.supports(Capability.SUPPORTS_TEXT)
    assert instagram.capabilities.supports(Capability.SUPPORTS_IMAGES)
    assert instagram.capabilities.supports(Capability.SUPPORTS_VIDEO)
    assert instagram.capabilities.supports(Capability.SUPPORTS_AUDIO)
    assert instagram.capabilities.supports(Capability.SUPPORTS_REACTIONS)
    assert instagram.capabilities.supports(Capability.SUPPORTS_TYPING)
    assert instagram.capabilities.supports(Capability.SUPPORTS_READ_RECEIPTS)


def test_methods_describe_platform_authentication_and_discovery() -> None:
    domain = build_default_domain_registry()

    official = domain.channels.require_method(ChannelId.WHATSAPP, MethodId.OFFICIAL)
    web = domain.channels.require_method(ChannelId.WHATSAPP, MethodId.WEB)
    instagram_official = domain.channels.require_method(ChannelId.INSTAGRAM, MethodId.OFFICIAL)

    assert official.platform_id == PlatformId.META
    assert official.authentication == AuthenticationKind.EMBEDDED_SIGNUP
    assert official.discovery == DiscoveryType.EMBEDDED_SIGNUP
    assert official.capabilities.supports(Capability.SUPPORTS_EMBEDDED_SIGNUP)
    assert official.display_name == "WhatsApp Oficial"
    assert official.current_connection_type == "cloud"

    assert web.platform_id is None
    assert web.authentication == AuthenticationKind.QR
    assert web.discovery == DiscoveryType.QR
    assert web.capabilities.supports(Capability.SUPPORTS_QR)
    assert web.display_name == "WhatsApp Web"
    assert web.current_connection_type == "baileys"

    assert instagram_official.platform_id == PlatformId.META
    assert instagram_official.authentication == AuthenticationKind.OAUTH
    assert instagram_official.discovery == DiscoveryType.MANUAL
    assert instagram_official.current_connection_type is None


def test_integrations_keep_runtime_details_internal_to_the_domain() -> None:
    domain = build_default_domain_registry()

    official_integration = domain.integration_for_method(ChannelId.WHATSAPP, MethodId.OFFICIAL)
    web_integration = domain.integration_for_method(ChannelId.WHATSAPP, MethodId.WEB)
    instagram_integration = domain.integration_for_method(ChannelId.INSTAGRAM, MethodId.OFFICIAL)

    assert official_integration is not None
    assert official_integration.runtime_id == RuntimeId.EVOLUTION
    assert official_integration.runtime_integration == "WHATSAPP-BUSINESS"

    assert web_integration is not None
    assert web_integration.runtime_id == RuntimeId.EVOLUTION
    assert web_integration.runtime_integration == "WHATSAPP-BAILEYS"

    assert instagram_integration is not None
    assert instagram_integration.runtime_id == RuntimeId.EVOLUTION
    assert instagram_integration.runtime_integration == "INSTAGRAM-OFFICIAL"


def test_public_channel_metadata_does_not_expose_runtime_or_evolution() -> None:
    domain = build_default_domain_registry()

    public_channels = domain.public_channels()

    assert len(public_channels) == 2
    assert public_channels[0]["id"] == "whatsapp"
    assert public_channels[1]["id"] == "instagram"
    assert "runtimeId" not in str(public_channels)
    assert "runtime_integration" not in str(public_channels)
    assert "evolution" not in str(public_channels).lower()


def test_architecture_v2_does_not_change_current_connection_manager_defaults() -> None:
    manager = get_connection_manager()

    assert manager.default().connection_type == ConnectionType.BAILEYS
    assert manager.default().evolution_integration == "WHATSAPP-BAILEYS"


def test_runtime_resolver_maps_current_channel_methods_to_evolution_runtime() -> None:
    domain = build_default_domain_registry()
    resolver = RuntimeResolver(domain)

    official = resolver.resolve(ChannelId.WHATSAPP, MethodId.OFFICIAL)
    web = resolver.resolve(ChannelId.WHATSAPP, MethodId.WEB)
    instagram = resolver.resolve(ChannelId.INSTAGRAM, MethodId.OFFICIAL)

    assert official.integration.id == "whatsapp.official.evolution"
    assert official.runtime.id == RuntimeId.EVOLUTION
    assert web.integration.id == "whatsapp.web.evolution"
    assert web.runtime.id == RuntimeId.EVOLUTION
    assert instagram.integration.id == "instagram.official.evolution"
    assert instagram.runtime.id == RuntimeId.EVOLUTION


def test_channels_router_exposes_catalog_from_domain_registry() -> None:
    import asyncio

    payload = asyncio.run(channels_router.list_channels())

    assert payload["items"][0]["id"] == "whatsapp"
    assert [method["id"] for method in payload["items"][0]["methods"]] == ["web", "official"]
    assert payload["items"][0]["methods"][0]["currentConnectionType"] == "baileys"
    assert payload["items"][0]["methods"][1]["currentConnectionType"] == "cloud"
    assert payload["items"][1]["id"] == "instagram"
    assert payload["items"][1]["methods"][0]["id"] == "official"
    assert payload["items"][1]["methods"][0]["currentConnectionType"] is None
