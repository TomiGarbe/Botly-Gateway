from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.domain.client import Client, ClientOverview
from app.services.connection_registry import ConnectionRegistry, get_connection_registry


class ClientNotFoundError(KeyError):
    pass


class ClientHasConnectionsError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _client_from_record(record: dict) -> Client:
    return Client(
        id=str(record["id"]),
        name=str(record["name"]),
        description=record.get("description") if isinstance(record.get("description"), str) else None,
        created_at=str(record["created_at"]),
        updated_at=str(record["updated_at"]),
    )


class ClientService:
    def __init__(self, registry: ConnectionRegistry | None = None) -> None:
        self._registry = registry or get_connection_registry()

    def list_clients(self) -> list[Client]:
        return sorted((_client_from_record(item) for item in self._registry.list_clients()), key=lambda item: (item.name.lower(), item.id))

    def get_client(self, client_id: str) -> Client:
        record = self._registry.get_client(client_id)
        if record is None:
            raise ClientNotFoundError(client_id)
        return _client_from_record(record)

    def list_client_overviews(self) -> list[ClientOverview]:
        return [self.get_client_overview(client.id) for client in self.list_clients()]

    def get_client_overview(self, client_id: str) -> ClientOverview:
        client = self.get_client(client_id)
        connection_count, last_activity_at = self._registry.client_connection_summary(client.id)
        return ClientOverview(
            client=client,
            connection_count=connection_count,
            last_activity_at=last_activity_at,
        )

    def create_client(self, name: str, description: str | None = None) -> Client:
        clean_name = str(name or "").strip()
        if not clean_name:
            raise ValueError("Client name is required")
        now = _now()
        client = Client(id=str(uuid4()), name=clean_name, description=self._description(description), created_at=now, updated_at=now)
        self._registry.save_client(client.public_dict())
        return client

    def update_client(self, client_id: str, *, name: str | None = None, description: str | None | object = ...) -> Client:
        current = self.get_client(client_id)
        next_name = current.name if name is None else str(name).strip()
        if not next_name:
            raise ValueError("Client name is required")
        next_description = current.description if description is ... else self._description(description)
        updated = Client(id=current.id, name=next_name, description=next_description, created_at=current.created_at, updated_at=_now())
        self._registry.save_client(updated.public_dict())
        return updated

    def delete_client(self, client_id: str) -> None:
        result = self._registry.delete_client_if_unconnected(client_id)
        if result == "not_found":
            raise ClientNotFoundError(client_id)
        if result == "has_connections":
            raise ClientHasConnectionsError("A client with connections cannot be deleted")

    @staticmethod
    def _description(value: str | None | object) -> str | None:
        if value is None:
            return None
        clean = str(value).strip()
        return clean or None


def get_client_service() -> ClientService:
    return ClientService()
