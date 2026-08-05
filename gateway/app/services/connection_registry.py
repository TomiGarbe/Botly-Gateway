from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Literal

from app.core.config import get_settings


_LOCK = threading.Lock()
_SCHEMA_VERSION = 1


class ConnectionRegistry:
    """Durable, additive ownership registry for the new domain.

    The Gateway currently has no relational database. This registry deliberately
    stores only product ownership/identity metadata and never copies, changes or
    deletes runtime instances managed by the legacy provider.
    """

    def __init__(self, path: str | Path | None = None) -> None:
        self._path = Path(path) if path is not None else Path(get_settings().connection_registry_path)

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"schema_version": _SCHEMA_VERSION, "clients": {}, "connections": {}}

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.exists():
            return self._empty()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return self._empty()
        if not isinstance(raw, dict):
            return self._empty()
        clients = raw.get("clients") if isinstance(raw.get("clients"), dict) else {}
        connections = raw.get("connections") if isinstance(raw.get("connections"), dict) else {}
        return {"schema_version": _SCHEMA_VERSION, "clients": clients, "connections": connections}

    def _write_unlocked(self, store: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary.write_text(json.dumps(store, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temporary, self._path)

    def snapshot(self) -> dict[str, Any]:
        with _LOCK:
            return deepcopy(self._read_unlocked())

    def replace(self, store: dict[str, Any]) -> None:
        """Administrative rollback primitive; no runtime/provider data is touched."""
        clients = store.get("clients") if isinstance(store.get("clients"), dict) else {}
        connections = store.get("connections") if isinstance(store.get("connections"), dict) else {}
        with _LOCK:
            self._write_unlocked({"schema_version": _SCHEMA_VERSION, "clients": clients, "connections": connections})

    def list_clients(self) -> list[dict[str, Any]]:
        with _LOCK:
            clients = self._read_unlocked()["clients"]
            return [deepcopy(item) for item in clients.values() if isinstance(item, dict)]

    def get_client(self, client_id: str) -> dict[str, Any] | None:
        with _LOCK:
            item = self._read_unlocked()["clients"].get(client_id)
            return deepcopy(item) if isinstance(item, dict) else None

    def save_client(self, client: dict[str, Any]) -> dict[str, Any]:
        with _LOCK:
            store = self._read_unlocked()
            store["clients"][str(client["id"])] = deepcopy(client)
            self._write_unlocked(store)
        return deepcopy(client)

    def delete_client(self, client_id: str) -> bool:
        with _LOCK:
            store = self._read_unlocked()
            if client_id not in store["clients"]:
                return False
            del store["clients"][client_id]
            self._write_unlocked(store)
            return True

    def connection_records(self) -> list[dict[str, Any]]:
        with _LOCK:
            return [deepcopy(item) for item in self._read_unlocked()["connections"].values() if isinstance(item, dict)]

    def connection_record_by_id(self, connection_id: str) -> dict[str, Any] | None:
        with _LOCK:
            for record in self._read_unlocked()["connections"].values():
                if isinstance(record, dict) and str(record.get("id")) == connection_id:
                    return deepcopy(record)
            return None

    def connection_record(self, legacy_name: str) -> dict[str, Any] | None:
        with _LOCK:
            item = self._read_unlocked()["connections"].get(legacy_name)
            return deepcopy(item) if isinstance(item, dict) else None

    def save_connection_record(self, legacy_name: str, record: dict[str, Any]) -> dict[str, Any]:
        with _LOCK:
            store = self._read_unlocked()
            store["connections"][legacy_name] = deepcopy(record)
            self._write_unlocked(store)
        return deepcopy(record)

    def save_connection_record_for_client(self, legacy_name: str, record: dict[str, Any]) -> dict[str, Any] | None:
        """Create a connection only while its owning client still exists."""
        client_id = str(record.get("client_id") or "")
        with _LOCK:
            store = self._read_unlocked()
            if not client_id or client_id not in store["clients"]:
                return None
            store["connections"][legacy_name] = deepcopy(record)
            self._write_unlocked(store)
        return deepcopy(record)

    def update_connection_record(self, connection_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        with _LOCK:
            store = self._read_unlocked()
            for legacy_name, record in store["connections"].items():
                if not isinstance(record, dict) or str(record.get("id")) != connection_id:
                    continue
                record.update(deepcopy(changes))
                store["connections"][legacy_name] = record
                self._write_unlocked(store)
                return deepcopy(record)
            return None

    def delete_connection_record(self, connection_id: str) -> dict[str, Any] | None:
        with _LOCK:
            store = self._read_unlocked()
            for legacy_name, record in store["connections"].items():
                if not isinstance(record, dict) or str(record.get("id")) != connection_id:
                    continue
                deleted = deepcopy(record)
                del store["connections"][legacy_name]
                self._write_unlocked(store)
                return deleted
            return None

    def client_has_connections(self, client_id: str) -> bool:
        with _LOCK:
            return any(
                isinstance(record, dict) and record.get("client_id") == client_id
                for record in self._read_unlocked()["connections"].values()
            )

    def client_connection_summary(self, client_id: str) -> tuple[int, str | None]:
        """Return the relationship count and the latest recorded activity.

        Activity is intentionally optional while the connection module is still
        being migrated. It is only exposed when a connection has explicitly
        recorded ``last_activity_at``; metadata updates are not activity.
        """
        with _LOCK:
            records = self._read_unlocked()["connections"].values()
            related = [
                record
                for record in records
                if isinstance(record, dict) and record.get("client_id") == client_id
            ]
            activities = [
                value
                for record in related
                if isinstance((value := record.get("last_activity_at")), str) and value.strip()
            ]
            return len(related), max(activities, default=None)

    def delete_client_if_unconnected(self, client_id: str) -> Literal["deleted", "not_found", "has_connections"]:
        """Atomically delete a client only when it has no connection records."""
        with _LOCK:
            store = self._read_unlocked()
            if client_id not in store["clients"]:
                return "not_found"
            if any(
                isinstance(record, dict) and record.get("client_id") == client_id
                for record in store["connections"].values()
            ):
                return "has_connections"
            del store["clients"][client_id]
            self._write_unlocked(store)
            return "deleted"

    def ensure_legacy_connections(self, records: Iterable[dict[str, Any]], fallback_client: dict[str, Any]) -> int:
        """Add ownership records for pre-existing runtime connections.

        This is an idempotent, forward-only data migration: it only inserts
        missing registry rows. `snapshot` + `replace` makes it reversible.
        """
        records = list(records)
        if not records:
            return 0

        inserted = 0
        with _LOCK:
            store = self._read_unlocked()
            changed = False
            if fallback_client["id"] not in store["clients"]:
                store["clients"][fallback_client["id"]] = deepcopy(fallback_client)
                changed = True
            for record in records:
                name = str(record.get("name") or "").strip()
                if not name:
                    continue
                existing = store["connections"].get(name)
                if isinstance(existing, dict):
                    if existing.get("client_id") not in store["clients"]:
                        existing["client_id"] = fallback_client["id"]
                        existing["updated_at"] = fallback_client["updated_at"]
                        changed = True
                    continue
                store["connections"][name] = {
                    "id": str(record.get("id") or name),
                    "legacy_name": name,
                    "client_id": fallback_client["id"],
                    "created_at": fallback_client["created_at"],
                    "updated_at": fallback_client["updated_at"],
                }
                inserted += 1
                changed = True
            if changed:
                self._write_unlocked(store)
        return inserted


def get_connection_registry() -> ConnectionRegistry:
    return ConnectionRegistry()
