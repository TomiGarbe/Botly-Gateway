from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.connections import ConnectionManager, get_connection_manager
from app.core.config import get_settings
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
from app.services.connection_adapter import legacy_instance_to_connection
from app.services.connection_registry import ConnectionRegistry, get_connection_registry
from app.services.gateway_settings import (
    ChannelDisabledError,
    ChannelNotImplementedError,
    GatewaySettingsService,
    ProviderDisabledError,
    ProviderNotImplementedError,
    get_gateway_settings_service,
)
from app.services.instances_contract import normalize_instance_list


_MIGRATION_CLIENT_ID = str(uuid5(NAMESPACE_URL, "botly-gateway:migrated-connections"))
_WHATSAPP_CHANNEL = "whatsapp"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class ConnectionNotFoundError(KeyError):
    pass


class ConnectionClientNotFoundError(KeyError):
    pass


class UnsupportedConnectionChannelError(ValueError):
    pass


class UnsupportedConnectionProviderError(ValueError):
    pass


class ConnectionService:
    """Product-domain connection service with the provider runtime behind an adapter."""

    def __init__(
        self,
        connection_manager: ConnectionManager | None = None,
        registry: ConnectionRegistry | None = None,
        gateway_settings: GatewaySettingsService | None = None,
    ) -> None:
        self._connection_manager = connection_manager or get_connection_manager()
        self._registry = registry or get_connection_registry()
        self._gateway_settings = gateway_settings or get_gateway_settings_service()

    def _migration_client_record(self) -> dict[str, str | None]:
        record = self._registry.get_client(_MIGRATION_CLIENT_ID)
        if record:
            return record
        now = _now()
        return {
            "id": _MIGRATION_CLIENT_ID,
            "name": "Migrated connections",
            "description": "Automatically assigned during the Connection domain migration.",
            "created_at": now,
            "updated_at": now,
        }

    async def migrate_legacy_connections(self) -> int:
        raw = await self._connection_manager.list_instances()
        normalized = normalize_instance_list(raw if isinstance(raw, list) else [])
        return self._registry.ensure_legacy_connections(normalized, self._migration_client_record())

    @staticmethod
    def _runtime_name(record: dict[str, Any]) -> str:
        return str(record.get("legacy_name") or "")

    def _client_reference(self, client_id: str) -> ConnectionClient:
        client = self._registry.get_client(client_id)
        if client is None:
            raise ConnectionClientNotFoundError(client_id)
        return ConnectionClient(id=str(client["id"]), name=str(client["name"]))

    def _stored_connection(self, record: dict[str, Any]) -> Connection:
        client = self._client_reference(str(record["client_id"]))
        return Connection(
            id=str(record["id"]),
            client_id=client.id,
            name=str(record.get("name") or "WhatsApp"),
            display_name=str(record["display_name"]) if record.get("display_name") else None,
            address=str(record["address"]) if record.get("address") else None,
            provider=Provider(
                id=str(record.get("provider_id") or "meta"),
                display_name=str(record.get("provider_display_name") or "Meta"),
            ),
            channel=Channel(
                id=str(record.get("channel_id") or _WHATSAPP_CHANNEL),
                display_name=str(record.get("channel_display_name") or "WhatsApp"),
            ),
            status=ConnectionStatus(
                state=str(record.get("status_state") or "pending"),
                lifecycle=str(record["status_lifecycle"]) if record.get("status_lifecycle") else None,
                health=str(record.get("status_health") or "unknown"),
            ),
            capabilities=ConnectionCapabilities(
                supports_messaging=True,
                supports_webhook=True,
                supports_media=True,
                supports_qr=str(record.get("provider_id") or "meta") == "evolution",
                supports_reconnect=True,
                supports_api_key=True,
                supports_official_api=str(record.get("provider_id") or "meta") == "meta",
            ),
            webhook=ConnectionWebhook(supported=True),
            api_key=ConnectionApiKey(supported=True),
            client=client,
            last_activity_at=str(record["last_activity_at"]) if record.get("last_activity_at") else None,
            created_at=str(record["created_at"]) if record.get("created_at") else None,
            updated_at=str(record["updated_at"]) if record.get("updated_at") else None,
            technical={"legacy_instance_name": str(record.get("legacy_name") or "") or None},
        )

    async def _runtime_connections(self) -> dict[str, dict[str, Any]]:
        try:
            raw = await self._connection_manager.list_instances()
        except Exception:
            return {}
        normalized = normalize_instance_list(raw if isinstance(raw, list) else [])
        self._registry.ensure_legacy_connections(normalized, self._migration_client_record())
        return {str(item["name"]): item for item in normalized}

    async def list_connections(self, client_id: str | None = None) -> list[Connection]:
        runtime_connections = await self._runtime_connections()
        result: list[Connection] = []
        for record in self._registry.connection_records():
            if client_id is not None and str(record.get("client_id")) != client_id:
                continue
            runtime = runtime_connections.get(self._runtime_name(record))
            try:
                if runtime is not None:
                    client = self._client_reference(str(record["client_id"]))
                    result.append(
                        replace(
                            legacy_instance_to_connection(runtime, record, client.name),
                            technical={"legacy_instance_name": self._runtime_name(record)},
                        )
                    )
                else:
                    result.append(self._stored_connection(record))
            except ConnectionClientNotFoundError:
                continue
        return sorted(result, key=lambda connection: (connection.name.lower(), connection.id))

    async def get_connection(self, connection_id: str) -> Connection:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        for connection in await self.list_connections(str(record["client_id"])):
            if connection.id == connection_id:
                return connection
        raise ConnectionNotFoundError(connection_id)

    def create_connection(self, *, client_id: str, channel: str, name: str | None = None, provider: str = "meta") -> Connection:
        client = self._client_reference(client_id)
        self._gateway_settings.require_channel_available(channel)
        if channel != _WHATSAPP_CHANNEL:
            raise UnsupportedConnectionChannelError("Only WhatsApp is available for new connections")
        if provider not in {"meta", "evolution"}:
            raise UnsupportedConnectionProviderError(f"Unsupported provider: {provider}")
        self._gateway_settings.require_provider_available(provider)
        # Meta (WhatsApp Cloud) es independiente del motor Evolution: opera directo
        # contra la Graph API. No exigir el proveedor "evolution" para conexiones Meta.
        clean_name = str(name or "").strip()
        if not clean_name:
            clean_name = "WhatsApp Oficial" if provider == "meta" else "WhatsApp Evolution"
        now = _now()
        connection_id = str(uuid4())
        record = {
            "id": connection_id,
            "legacy_name": f"connection_{connection_id.replace('-', '')[:24]}",
            "client_id": client.id,
            "name": clean_name,
            "provider_id": provider,
            "provider_display_name": "Meta" if provider == "meta" else "Evolution",
            "channel_id": _WHATSAPP_CHANNEL,
            "channel_display_name": "WhatsApp",
            "status_state": "pending" if provider == "meta" else "connecting",
            "status_health": "unknown",
            "created_at": now,
            "updated_at": now,
        }
        saved = self._registry.save_connection_record_for_client(str(record["legacy_name"]), record)
        if saved is None:
            raise ConnectionClientNotFoundError(client.id)
        return self._stored_connection(record)

    async def get_connection_by_runtime_name(self, instance_name: str) -> Connection:
        """Resolve a legacy runtime name through the product ownership registry."""
        for connection in await self.list_connections():
            if self._runtime_name(self._registry.connection_record_by_id(connection.id) or {}) == instance_name:
                return connection
        raise ConnectionNotFoundError(instance_name)

    async def start_evolution_connection(self, connection_id: str) -> Connection:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        if str(record.get("provider_id") or "") != "evolution":
            raise UnsupportedConnectionProviderError("This connection does not use Evolution")
        self._gateway_settings.require_provider_available("evolution")
        try:
            await self._connection_manager.create(
                self._runtime_name(record),
                qrcode=True,
                connection_type="baileys",
            )
        except Exception:
            self._registry.delete_connection_record(connection_id)
            raise
        try:
            await self._connection_manager.set_webhook(
                self._runtime_name(record),
                f"http://gateway:{get_settings().gateway_port}/webhooks/evolution",
                ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED", "SEND_MESSAGE"],
                connection_type="baileys",
            )
        except Exception:
            # The QR connection is usable even if webhook setup must be
            # retried later, mirroring the existing instance creation flow.
            pass
        return self._stored_connection(record)

    async def evolution_qr(self, connection_id: str) -> dict[str, Any]:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        if str(record.get("provider_id") or "") != "evolution":
            raise UnsupportedConnectionProviderError("This connection does not use Evolution")
        self._gateway_settings.require_provider_available("evolution")
        return await self._connection_manager.connect(self._runtime_name(record), connection_type="baileys")

    async def update_connection(self, connection_id: str, *, name: str | None = None) -> Connection:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        if name is None:
            raise ValueError("At least one connection field must be provided")
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("Connection name is required")
        updated = self._registry.update_connection_record(
            connection_id,
            {"name": clean_name, "updated_at": _now()},
        )
        if updated is None:
            raise ConnectionNotFoundError(connection_id)
        return await self.get_connection(connection_id)

    async def delete_connection(self, connection_id: str) -> None:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        runtime = (await self._runtime_connections()).get(self._runtime_name(record))
        if runtime is not None:
            await self._connection_manager.delete(self._runtime_name(record))
        deleted = self._registry.delete_connection_record(connection_id)
        if deleted is None:
            raise ConnectionNotFoundError(connection_id)

    def connection_runtime_name(self, connection_id: str) -> str:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        return self._runtime_name(record)

    def connection_last_heartbeat_at(self, connection_id: str) -> str | None:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        value = record.get("last_heartbeat_at")
        return str(value) if value else None

    def mark_meta_signup_completed(self, connection_id: str) -> Connection:
        record = self._registry.update_connection_record(
            connection_id,
            {"status_state": "connected", "status_health": "healthy", "updated_at": _now()},
        )
        if record is None:
            raise ConnectionNotFoundError(connection_id)
        return self._stored_connection(record)


def get_connection_service() -> ConnectionService:
    return ConnectionService()
