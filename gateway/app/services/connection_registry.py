from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Literal

from app.core.config import get_settings
from app.core.logging import get_logger


_LOCK = threading.Lock()
_SCHEMA_VERSION = 2
_LEGACY_CONNECTION_REGISTRY_PATH = Path("/tmp/botly_connection_registry.json")
logger = get_logger(__name__)


class ConnectionRegistry:
    """Durable, additive ownership registry for the new domain.

    The Gateway currently has no relational database. This registry deliberately
    stores only product ownership/identity metadata and never copies, changes or
    deletes runtime instances managed by the legacy provider.
    """

    def __init__(self, path: str | Path | None = None) -> None:
        self._allow_legacy_migration = path is None
        self._path = Path(path) if path is not None else Path(get_settings().connection_registry_path)
        self._migrate_legacy_registry_if_needed()

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"schema_version": _SCHEMA_VERSION, "clients": {}, "connections": {}, "setups": {}}

    def _read_unlocked(self) -> dict[str, Any]:
        self._ensure_private_storage_unlocked()
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
        setups = raw.get("setups") if isinstance(raw.get("setups"), dict) else {}
        return {"schema_version": _SCHEMA_VERSION, "clients": clients, "connections": connections, "setups": setups}

    def _write_unlocked(self, store: dict[str, Any]) -> None:
        self._ensure_private_storage_unlocked()
        temporary = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary.write_text(json.dumps(store, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, self._path)

    def _ensure_private_storage_unlocked(self) -> None:
        """Keep the durable registry private even when its directory pre-exists."""
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self._path.parent, 0o700)
        except OSError:
            pass
        if self._path.exists():
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass

    def _migrate_legacy_registry_if_needed(self) -> None:
        """Copy the pre-persistence registry once without deleting its source.

        Earlier Gateway images used /tmp for this store.  On the first startup
        with a configured persistent location, preserve that data by copying it
        only when the destination does not exist.  An unreadable or malformed
        legacy file keeps the existing empty/corrupt-file behaviour: it is left
        untouched and is not promoted to the durable location.
        """
        legacy_path = _LEGACY_CONNECTION_REGISTRY_PATH
        if not self._allow_legacy_migration or self._path == legacy_path or self._path.exists() or not legacy_path.exists():
            return
        try:
            raw = json.loads(legacy_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("connection_registry_legacy_migration_skipped", source=str(legacy_path), error=str(exc))
            return
        if not isinstance(raw, dict):
            logger.warning("connection_registry_legacy_migration_skipped", source=str(legacy_path), error="invalid_store")
            return

        clients = raw.get("clients") if isinstance(raw.get("clients"), dict) else {}
        connections = raw.get("connections") if isinstance(raw.get("connections"), dict) else {}
        with _LOCK:
            if self._path.exists():
                return
            self._write_unlocked({"schema_version": _SCHEMA_VERSION, "clients": clients, "connections": connections, "setups": {}})
        logger.info("connection_registry_legacy_migrated", source=str(legacy_path), destination=str(self._path))

    def snapshot(self) -> dict[str, Any]:
        with _LOCK:
            return deepcopy(self._read_unlocked())

    def replace(self, store: dict[str, Any]) -> None:
        """Administrative rollback primitive; no runtime/provider data is touched."""
        clients = store.get("clients") if isinstance(store.get("clients"), dict) else {}
        connections = store.get("connections") if isinstance(store.get("connections"), dict) else {}
        setups = store.get("setups") if isinstance(store.get("setups"), dict) else {}
        with _LOCK:
            self._write_unlocked({"schema_version": _SCHEMA_VERSION, "clients": clients, "connections": connections, "setups": setups})

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

    def setup_record_by_id(self, setup_id: str) -> dict[str, Any] | None:
        with _LOCK:
            item = self._read_unlocked()["setups"].get(setup_id)
            return deepcopy(item) if isinstance(item, dict) else None

    def setup_record_by_idempotency_key(self, client_id: str, idempotency_key: str) -> dict[str, Any] | None:
        with _LOCK:
            for item in self._read_unlocked()["setups"].values():
                if isinstance(item, dict) and str(item.get("client_id")) == client_id and str(item.get("idempotency_key") or "") == idempotency_key:
                    return deepcopy(item)
            return None

    def save_setup_record_for_client(self, setup: dict[str, Any]) -> dict[str, Any] | None:
        client_id = str(setup.get("client_id") or "")
        setup_id = str(setup.get("id") or "")
        if not client_id or not setup_id:
            return None
        with _LOCK:
            store = self._read_unlocked()
            if client_id not in store["clients"]:
                return None
            store["setups"][setup_id] = deepcopy(setup)
            self._write_unlocked(store)
        return deepcopy(setup)

    def update_setup_record(self, setup_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        with _LOCK:
            store = self._read_unlocked()
            record = store["setups"].get(setup_id)
            if not isinstance(record, dict):
                return None
            record.update(deepcopy(changes))
            store["setups"][setup_id] = record
            self._write_unlocked(store)
            return deepcopy(record)

    def promote_setup_to_connection(self, setup_id: str, connection: dict[str, Any], setup_changes: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Atomically publish a ready setup and its operational connection."""
        legacy_name = str(connection.get("legacy_name") or "")
        with _LOCK:
            store = self._read_unlocked()
            setup = store["setups"].get(setup_id)
            if not isinstance(setup, dict) or not legacy_name or setup.get("client_id") not in store["clients"]:
                return None
            setup.update(deepcopy(setup_changes))
            store["setups"][setup_id] = setup
            store["connections"][legacy_name] = deepcopy(connection)
            self._write_unlocked(store)
            return deepcopy(setup), deepcopy(connection)

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
