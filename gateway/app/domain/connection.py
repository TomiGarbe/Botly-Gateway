from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Provider:
    id: str
    display_name: str


@dataclass(frozen=True)
class Channel:
    id: str
    display_name: str
    icon: str | None = None


@dataclass(frozen=True)
class ConnectionCapabilities:
    supports_messaging: bool = False
    supports_webhook: bool = False
    supports_media: bool = False
    supports_qr: bool = False
    supports_reconnect: bool = False
    supports_api_key: bool = False
    supports_official_api: bool = False
    supports_templates: bool = False


@dataclass(frozen=True)
class ConnectionStatus:
    state: str
    lifecycle: str | None
    health: str


@dataclass(frozen=True)
class ConnectionWebhook:
    supported: bool


@dataclass(frozen=True)
class ConnectionApiKey:
    supported: bool


@dataclass(frozen=True)
class ConnectionLogs:
    supported: bool = True


@dataclass(frozen=True)
class ConnectionClient:
    id: str
    name: str


@dataclass(frozen=True)
class Connection:
    """Provider-neutral connection resource exposed by the new API."""

    id: str
    client_id: str
    name: str
    display_name: str | None
    address: str | None
    provider: Provider
    channel: Channel
    status: ConnectionStatus
    capabilities: ConnectionCapabilities
    webhook: ConnectionWebhook
    api_key: ConnectionApiKey
    logs: ConnectionLogs = field(default_factory=ConnectionLogs)
    client: ConnectionClient | None = None
    last_activity_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    technical: dict[str, Any] = field(default_factory=dict)

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "client_id": self.client_id,
            "name": self.name,
            "display_name": self.display_name,
            "address": self.address,
            "provider": asdict(self.provider),
            "channel": asdict(self.channel),
            "status": asdict(self.status),
            "capabilities": asdict(self.capabilities),
            "webhook": asdict(self.webhook),
            "api_key": asdict(self.api_key),
            "logs": asdict(self.logs),
            "client": asdict(self.client) if self.client else None,
            "last_activity_at": self.last_activity_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
