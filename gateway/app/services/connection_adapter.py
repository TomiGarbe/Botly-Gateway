from __future__ import annotations

from typing import Any

from app.domain.connection import (
    Channel,
    Connection,
    ConnectionApiKey,
    ConnectionCapabilities,
    ConnectionClient,
    ConnectionStatus,
    ConnectionWebhook,
    Provider,
)


def _provider(legacy: dict[str, Any]) -> Provider:
    connection_type = legacy.get("connectionType")
    integration = legacy.get("integration")
    if connection_type == "cloud" or integration == "WHATSAPP-BUSINESS":
        return Provider(id="meta", display_name="Meta")
    if connection_type == "baileys" or integration == "WHATSAPP-BAILEYS":
        return Provider(id="evolution", display_name="Evolution")
    return Provider(id="gateway", display_name="Gateway")


def _channel(legacy: dict[str, Any]) -> Channel:
    return Channel(
        id=str(legacy.get("channelId") or "whatsapp"),
        display_name=str(legacy.get("channelDisplayName") or "WhatsApp"),
        icon=str(legacy["methodIcon"]) if legacy.get("methodIcon") else None,
    )


def legacy_instance_to_connection(
    legacy: dict[str, Any],
    relation: dict[str, Any],
    client_name: str | None = None,
) -> Connection:
    """Compatibility adapter. New services never expose the legacy shape."""
    provider = _provider(legacy)
    official = provider.id == "meta"
    qr = provider.id == "evolution"
    return Connection(
        id=str(relation["id"]),
        client_id=str(relation["client_id"]),
        name=str(legacy["name"]),
        display_name=str(legacy["profileName"]) if legacy.get("profileName") else None,
        address=str(legacy["phone"]) if legacy.get("phone") else None,
        provider=provider,
        channel=_channel(legacy),
        status=ConnectionStatus(
            state={"open": "connected", "connecting": "connecting"}.get(str(legacy.get("status")), "disconnected"),
            lifecycle=str(legacy["lifecycleState"]) if legacy.get("lifecycleState") else None,
            health=str(legacy.get("health") or "unknown"),
        ),
        capabilities=ConnectionCapabilities(
            supports_messaging=True,
            supports_webhook=True,
            supports_media=True,
            supports_qr=qr,
            supports_reconnect=True,
            supports_api_key=True,
            supports_official_api=official,
        ),
        webhook=ConnectionWebhook(supported=True),
        api_key=ConnectionApiKey(supported=True),
        client=ConnectionClient(id=str(relation["client_id"]), name=client_name or "Cliente eliminado"),
        last_activity_at=str(relation["last_activity_at"]) if relation.get("last_activity_at") else None,
        created_at=str(relation["created_at"]) if relation.get("created_at") else None,
        updated_at=str(relation["updated_at"]) if relation.get("updated_at") else None,
        technical={"legacy_instance_name": str(legacy["name"])},
    )
