from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable

from app.domain.discovery import DiscoveryType


class ChannelId(str, Enum):
    WHATSAPP = "whatsapp"
    INSTAGRAM = "instagram"
    MESSENGER = "messenger"
    TELEGRAM = "telegram"
    DISCORD = "discord"


class MethodId(str, Enum):
    OFFICIAL = "official"
    WEB = "web"
    BOT_API = "bot_api"
    BOT = "bot"


class PlatformId(str, Enum):
    META = "meta"


class RuntimeId(str, Enum):
    EVOLUTION = "evolution"


class ChannelStatus(str, Enum):
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    DISCONNECTED = "DISCONNECTED"
    ERROR = "ERROR"


class AuthenticationKind(str, Enum):
    EMBEDDED_SIGNUP = "embedded_signup"
    QR = "qr"
    BOT_TOKEN = "bot_token"
    OAUTH = "oauth"
    NONE = "none"


DiscoveryKind = DiscoveryType


class Capability(str, Enum):
    SUPPORTS_MEDIA = "supports_media"
    SUPPORTS_IMAGES = "supports_images"
    SUPPORTS_AUDIO = "supports_audio"
    SUPPORTS_VIDEO = "supports_video"
    SUPPORTS_EMBEDDED_SIGNUP = "supports_embedded_signup"
    SUPPORTS_QR = "supports_qr"
    SUPPORTS_TEMPLATES = "supports_templates"
    SUPPORTS_REACTIONS = "supports_reactions"
    SUPPORTS_TYPING = "supports_typing"
    SUPPORTS_READ_RECEIPTS = "supports_read_receipts"
    SUPPORTS_WEBHOOKS = "supports_webhooks"
    SUPPORTS_TEXT = "supports_text"


def _enum_value(value: Enum | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, Enum):
        return str(value.value)
    return str(value)


@dataclass(frozen=True)
class CapabilitySet:
    values: frozenset[Capability] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        object.__setattr__(self, "values", frozenset(Capability(value) for value in self.values))

    @classmethod
    def of(cls, *values: Capability | str) -> "CapabilitySet":
        return cls(frozenset(Capability(value) for value in values))

    @classmethod
    def merge(cls, sets: Iterable["CapabilitySet"]) -> "CapabilitySet":
        values: set[Capability] = set()
        for capability_set in sets:
            values.update(capability_set.values)
        return cls(frozenset(values))

    def supports(self, capability: Capability | str) -> bool:
        return Capability(capability) in self.values

    def as_tuple(self) -> tuple[str, ...]:
        return tuple(sorted(capability.value for capability in self.values))


@dataclass(frozen=True)
class PlatformDefinition:
    id: PlatformId
    name: str
    display_name: str
    description: str = ""
    icon: str = ""
    logo: str | None = None
    color: str | None = None
    supports_oauth: bool = False
    supports_refresh: bool = False
    supports_discovery: bool = False
    visible: bool = True
    enabled: bool = True
    sort_order: int = 0
    capabilities: CapabilitySet = field(default_factory=CapabilitySet)
    owner: str | None = None
    notes: tuple[str, ...] = ()

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id.value,
            "name": self.name,
            "displayName": self.display_name,
            "description": self.description,
            "icon": self.icon,
            "logo": self.logo,
            "color": self.color,
            "owner": self.owner,
            "supportsOauth": self.supports_oauth,
            "supportsRefresh": self.supports_refresh,
            "supportsDiscovery": self.supports_discovery,
            "visible": self.visible,
            "enabled": self.enabled,
            "sortOrder": self.sort_order,
            "capabilities": self.capabilities.as_tuple(),
        }


@dataclass(frozen=True)
class RuntimeDefinition:
    id: RuntimeId
    name: str
    adapter_package: str
    responsibilities: tuple[str, ...] = ()
    internal: bool = True

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id.value,
            "name": self.name,
            "internal": self.internal,
        }


@dataclass(frozen=True)
class MethodDefinition:
    id: MethodId
    name: str
    display_name: str
    authentication: AuthenticationKind
    discovery: DiscoveryType
    description: str = ""
    icon: str = ""
    logo: str | None = None
    color: str | None = None
    capabilities: CapabilitySet = field(default_factory=CapabilitySet)
    platform_id: PlatformId | None = None
    supports_discovery: bool = False
    supports_oauth: bool = False
    supports_refresh: bool = False
    visible: bool = True
    enabled: bool = True
    sort_order: int = 0
    current_connection_type: str | None = None

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id.value,
            "name": self.name,
            "displayName": self.display_name,
            "description": self.description,
            "icon": self.icon,
            "logo": self.logo,
            "color": self.color,
            "platformId": _enum_value(self.platform_id),
            "authentication": self.authentication.value,
            "discovery": self.discovery.value,
            "capabilities": self.capabilities.as_tuple(),
            "supportsDiscovery": self.supports_discovery,
            "supportsOauth": self.supports_oauth,
            "supportsRefresh": self.supports_refresh,
            "visible": self.visible,
            "enabled": self.enabled,
            "sortOrder": self.sort_order,
            "currentConnectionType": self.current_connection_type,
        }


@dataclass(frozen=True)
class ChannelDefinition:
    id: ChannelId
    name: str
    display_name: str
    description: str
    icon: str
    methods: tuple[MethodDefinition, ...]
    logo: str | None = None
    color: str | None = None
    supports_multi_channel: bool = False
    supports_discovery: bool = False
    visible: bool = True
    enabled: bool = True
    sort_order: int = 0
    capabilities: CapabilitySet = field(default_factory=CapabilitySet)

    def public_dict(self) -> dict[str, Any]:
        methods = sorted(
            (method for method in self.methods if method.visible),
            key=lambda item: item.sort_order,
        )
        return {
            "id": self.id.value,
            "name": self.name,
            "displayName": self.display_name,
            "description": self.description,
            "icon": self.icon,
            "logo": self.logo,
            "color": self.color,
            "supportsMultiChannel": self.supports_multi_channel,
            "supportsDiscovery": self.supports_discovery,
            "visible": self.visible,
            "enabled": self.enabled,
            "sortOrder": self.sort_order,
            "capabilities": self.capabilities.as_tuple(),
            "methods": [method.public_dict() for method in methods],
        }


@dataclass(frozen=True)
class IntegrationDefinition:
    id: str
    channel_id: ChannelId
    method_id: MethodId
    runtime_id: RuntimeId
    runtime_integration: str
    platform_id: PlatformId | None = None
    enabled: bool = True
    notes: tuple[str, ...] = ()

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "channelId": self.channel_id.value,
            "methodId": self.method_id.value,
            "platformId": _enum_value(self.platform_id),
            "enabled": self.enabled,
        }


@dataclass(frozen=True)
class ProvisionedChannel:
    id: str
    channel_id: ChannelId
    method_id: MethodId
    integration_id: str
    runtime_id: RuntimeId
    display_name: str
    status: ChannelStatus = ChannelStatus.ACTIVE
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None

    def public_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "channelId": self.channel_id.value,
            "methodId": self.method_id.value,
            "integrationId": self.integration_id,
            "runtimeId": self.runtime_id.value,
            "displayName": self.display_name,
            "status": self.status.value,
            "metadata": dict(self.metadata),
        }
        if self.created_at:
            payload["createdAt"] = self.created_at
        if self.updated_at:
            payload["updatedAt"] = self.updated_at
        return payload
