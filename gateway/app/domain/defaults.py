from __future__ import annotations

from functools import lru_cache

from app.domain.models import (
    AuthenticationKind,
    Capability,
    CapabilitySet,
    ChannelDefinition,
    ChannelId,
    IntegrationDefinition,
    MethodDefinition,
    MethodId,
    PlatformDefinition,
    PlatformId,
    RuntimeDefinition,
    RuntimeId,
)
from app.domain.discovery import DiscoveryType
from app.domain.registries import ChannelRegistry, DomainRegistry, IntegrationRegistry, PlatformRegistry, RuntimeRegistry

WHATSAPP_OFFICIAL_CAPABILITIES = CapabilitySet.of(
    Capability.SUPPORTS_TEXT,
    Capability.SUPPORTS_MEDIA,
    Capability.SUPPORTS_AUDIO,
    Capability.SUPPORTS_VIDEO,
    Capability.SUPPORTS_EMBEDDED_SIGNUP,
    Capability.SUPPORTS_TEMPLATES,
    Capability.SUPPORTS_REACTIONS,
    Capability.SUPPORTS_WEBHOOKS,
)

WHATSAPP_WEB_CAPABILITIES = CapabilitySet.of(
    Capability.SUPPORTS_TEXT,
    Capability.SUPPORTS_MEDIA,
    Capability.SUPPORTS_AUDIO,
    Capability.SUPPORTS_VIDEO,
    Capability.SUPPORTS_QR,
    Capability.SUPPORTS_REACTIONS,
    Capability.SUPPORTS_WEBHOOKS,
)

INSTAGRAM_OFFICIAL_CAPABILITIES = CapabilitySet.of(
    Capability.SUPPORTS_TEXT,
    Capability.SUPPORTS_IMAGES,
    Capability.SUPPORTS_VIDEO,
    Capability.SUPPORTS_AUDIO,
    Capability.SUPPORTS_REACTIONS,
    Capability.SUPPORTS_TYPING,
    Capability.SUPPORTS_READ_RECEIPTS,
    Capability.SUPPORTS_WEBHOOKS,
)


def build_default_domain_registry() -> DomainRegistry:
    whatsapp_official = MethodDefinition(
        id=MethodId.OFFICIAL,
        name="Official",
        display_name="WhatsApp Oficial",
        description="Conexion guiada sin copiar credenciales.",
        icon="badge-check",
        color="#10b981",
        platform_id=PlatformId.META,
        authentication=AuthenticationKind.EMBEDDED_SIGNUP,
        discovery=DiscoveryType.EMBEDDED_SIGNUP,
        capabilities=WHATSAPP_OFFICIAL_CAPABILITIES,
        supports_discovery=True,
        supports_oauth=True,
        supports_refresh=True,
        sort_order=20,
        current_connection_type="cloud",
    )
    whatsapp_web = MethodDefinition(
        id=MethodId.WEB,
        name="Web",
        display_name="WhatsApp Web",
        description="Conecta escaneando un codigo QR desde el telefono.",
        icon="qr-code",
        color="#3b82f6",
        platform_id=None,
        authentication=AuthenticationKind.QR,
        discovery=DiscoveryType.QR,
        capabilities=WHATSAPP_WEB_CAPABILITIES,
        supports_discovery=True,
        sort_order=10,
        current_connection_type="baileys",
    )
    instagram_official = MethodDefinition(
        id=MethodId.OFFICIAL,
        name="Official",
        display_name="Instagram Official",
        description="Mensajeria oficial de Instagram sobre Meta Platform.",
        icon="instagram",
        color="#e1306c",
        platform_id=PlatformId.META,
        authentication=AuthenticationKind.OAUTH,
        discovery=DiscoveryType.MANUAL,
        capabilities=INSTAGRAM_OFFICIAL_CAPABILITIES,
        supports_discovery=True,
        supports_oauth=True,
        supports_refresh=True,
        sort_order=10,
    )

    whatsapp = ChannelDefinition(
        id=ChannelId.WHATSAPP,
        name="WhatsApp",
        display_name="WhatsApp",
        description="Canal de mensajeria WhatsApp para conexiones oficiales y web.",
        icon="whatsapp",
        color="#25d366",
        supports_multi_channel=False,
        supports_discovery=True,
        sort_order=10,
        methods=(whatsapp_official, whatsapp_web),
        capabilities=CapabilitySet.merge((WHATSAPP_OFFICIAL_CAPABILITIES, WHATSAPP_WEB_CAPABILITIES)),
    )
    instagram = ChannelDefinition(
        id=ChannelId.INSTAGRAM,
        name="Instagram",
        display_name="Instagram",
        description="Canal de mensajeria oficial de Instagram sobre Meta Platform.",
        icon="instagram",
        color="#e1306c",
        supports_multi_channel=True,
        supports_discovery=True,
        sort_order=20,
        methods=(instagram_official,),
        capabilities=INSTAGRAM_OFFICIAL_CAPABILITIES,
    )

    meta = PlatformDefinition(
        id=PlatformId.META,
        name="Meta Platform",
        display_name="Meta Platform",
        description="Plataforma oficial de Meta para canales y metodos oficiales.",
        icon="meta",
        color="#0866ff",
        owner="Meta",
        supports_oauth=True,
        supports_refresh=True,
        supports_discovery=True,
        sort_order=10,
        capabilities=CapabilitySet.of(
            Capability.SUPPORTS_EMBEDDED_SIGNUP,
            Capability.SUPPORTS_TEXT,
            Capability.SUPPORTS_MEDIA,
            Capability.SUPPORTS_IMAGES,
            Capability.SUPPORTS_AUDIO,
            Capability.SUPPORTS_VIDEO,
            Capability.SUPPORTS_TEMPLATES,
            Capability.SUPPORTS_REACTIONS,
            Capability.SUPPORTS_WEBHOOKS,
        ),
        notes=("Used by official Meta-owned channels such as WhatsApp Official and Instagram Official.",),
    )

    evolution = RuntimeDefinition(
        id=RuntimeId.EVOLUTION,
        name="Botly Gateway",
        adapter_package="app.adapters.evolution",
        responsibilities=(
            "Manage the current Botly Gateway WhatsApp sessions.",
            "Preserve the existing public API and runtime behavior during migration.",
        ),
    )

    integrations = IntegrationRegistry(
        (
            IntegrationDefinition(
                id="whatsapp.official.evolution",
                channel_id=ChannelId.WHATSAPP,
                method_id=MethodId.OFFICIAL,
                platform_id=PlatformId.META,
                runtime_id=RuntimeId.EVOLUTION,
                runtime_integration="WHATSAPP-BUSINESS",
                notes=("Internal bridge for the current manual/embedded signup cloud path.",),
            ),
            IntegrationDefinition(
                id="whatsapp.web.evolution",
                channel_id=ChannelId.WHATSAPP,
                method_id=MethodId.WEB,
                platform_id=None,
                runtime_id=RuntimeId.EVOLUTION,
                runtime_integration="WHATSAPP-BAILEYS",
                notes=("Internal bridge for the current QR-based WhatsApp Web path.",),
            ),
            IntegrationDefinition(
                id="instagram.official.evolution",
                channel_id=ChannelId.INSTAGRAM,
                method_id=MethodId.OFFICIAL,
                platform_id=PlatformId.META,
                runtime_id=RuntimeId.EVOLUTION,
                runtime_integration="INSTAGRAM-OFFICIAL",
                notes=("Internal bridge for Instagram Messaging through Meta Platform.",),
            ),
        )
    )

    return DomainRegistry(
        channels=ChannelRegistry((whatsapp, instagram)),
        platforms=PlatformRegistry((meta,)),
        runtimes=RuntimeRegistry((evolution,)),
        integrations=integrations,
    )


@lru_cache
def get_default_domain_registry() -> DomainRegistry:
    return build_default_domain_registry()
