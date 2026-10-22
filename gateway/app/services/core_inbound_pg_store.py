"""PostgreSQL Gateway -> Core outbox with the same contract as the JSON store."""
from __future__ import annotations

import json
import threading
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.core_inbound_dispatcher import (
    CoreInboundDeliveryStore,
    CoreInboundPersistenceError,
    _as_int,
    _now,
    _text,
)

logger = get_logger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS botly_gateway_core_inbound_deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    scope_key TEXT UNIQUE,
    connection_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_attempt_at BIGINT,
    lease_expires_at BIGINT,
    delivered_at BIGINT,
    created_at BIGINT NOT NULL,
    doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_core_inbound_due ON botly_gateway_core_inbound_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_core_inbound_connection ON botly_gateway_core_inbound_deliveries (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_core_inbound_delivered ON botly_gateway_core_inbound_deliveries (delivered_at) WHERE status = 'delivered';
"""
_COLUMNS = "id, event_id, scope_key, connection_id, status, next_attempt_at, lease_expires_at, delivered_at, created_at, doc"


class PostgresCoreInboundDeliveryStore(CoreInboundDeliveryStore):
    def __init__(self, database_url: str, *, legacy_path: str | Path | None = None) -> None:
        self._url = database_url
        self._legacy_path = Path(legacy_path) if legacy_path is not None else Path(get_settings().core_inbound_deliveries_path)
        self._ready = False
        self._init_lock = threading.Lock()

    def _connect(self):
        import psycopg

        connection = psycopg.connect(self._url)
        if not self._ready:
            with self._init_lock:
                if not self._ready:
                    with connection.transaction():
                        connection.execute("SELECT pg_advisory_xact_lock(hashtext('botly_gateway_core_inbound_schema'))")
                        connection.execute(_SCHEMA)
                        imported = self._import_legacy_json(connection)
                    if imported:  # only after the import committed
                        self._legacy_path.rename(self._legacy_path.with_suffix(self._legacy_path.suffix + ".migrated"))
                    self._ready = True
        return connection

    def _import_legacy_json(self, connection) -> bool:
        if not self._legacy_path.exists():
            return False
        if connection.execute("SELECT EXISTS (SELECT 1 FROM botly_gateway_core_inbound_deliveries)").fetchone()[0]:
            return False
        deliveries = CoreInboundDeliveryStore(self._legacy_path)._read_unlocked()["deliveries"]
        for item in deliveries:
            self._insert(connection, item)
        logger.info("core_inbound_json_imported", count=len(deliveries), source=str(self._legacy_path))
        return True

    def _scope_key(self, item: dict[str, Any]) -> str | None:
        scope = self._provider_message_scope(item.get("canonicalEvent") if isinstance(item.get("canonicalEvent"), dict) else {})
        return json.dumps(scope, separators=(",", ":")) if scope is not None else None

    def _row(self, item: dict[str, Any]) -> tuple:
        return (item["id"], item["eventId"], self._scope_key(item), _text(item.get("connectionId")), item["status"],
                item.get("nextAttemptAt"), item.get("leaseExpiresAt"), item.get("deliveredAt"),
                _as_int(item.get("createdAt")), json.dumps(item))

    def _insert(self, connection, item: dict[str, Any]) -> bool:
        cursor = connection.execute(
            f"INSERT INTO botly_gateway_core_inbound_deliveries ({_COLUMNS}) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb) ON CONFLICT DO NOTHING",
            self._row(item),
        )
        return cursor.rowcount == 1

    def _save(self, connection, item: dict[str, Any]) -> None:
        _, _, _, _, status, next_at, lease, delivered, _, doc = self._row(item)
        connection.execute(
            "UPDATE botly_gateway_core_inbound_deliveries SET status=%s, next_attempt_at=%s, lease_expires_at=%s, "
            "delivered_at=%s, doc=%s::jsonb WHERE id=%s",
            (status, next_at, lease, delivered, doc, item["id"]),
        )

    def enqueue(self, *, event: dict[str, Any], core_channel_id: str | None, initial_error: str | None = None) -> tuple[dict[str, Any], bool]:
        event_id = _text(event.get("eventId"))
        transport = event.get("transport") if isinstance(event.get("transport"), dict) else {}
        if not event_id or not all(_text(transport.get(key)) for key in ("provider", "channelType", "providerAccountRef", "connectionRef")):
            raise CoreInboundPersistenceError("Canonical event is missing durable delivery identity")
        now = _now()
        delivery = {
            "id": f"core_inbound_{uuid.uuid4().hex}", "eventId": event_id,
            "provider": _text(transport.get("provider")), "channelType": _text(transport.get("channelType")),
            "providerAccountId": _text(transport.get("providerAccountRef")), "connectionId": _text(transport.get("connectionRef")),
            "coreChannelId": _text(core_channel_id) or None, "canonicalEvent": deepcopy(event),
            "status": "failed" if initial_error else "pending", "attemptCount": 0,
            "nextAttemptAt": None if initial_error else now, "lastAttemptAt": None, "deliveredAt": None,
            "lastError": initial_error, "createdAt": now, "updatedAt": now, "leaseExpiresAt": None,
            "duplicateAcknowledged": False,
        }
        days = max(1, int(getattr(get_settings(), "core_inbound_delivery_retention_days", 7) or 7))
        try:
            with self._connect() as connection, connection.transaction():
                connection.execute(
                    "DELETE FROM botly_gateway_core_inbound_deliveries WHERE status='delivered' AND delivered_at < %s",
                    (now - days * 86_400_000,),
                )
                if self._insert(connection, delivery):
                    return deepcopy(delivery), True
                row = connection.execute(
                    "SELECT doc FROM botly_gateway_core_inbound_deliveries WHERE event_id=%s OR (scope_key IS NOT NULL AND scope_key=%s) LIMIT 1",
                    (event_id, self._scope_key(delivery)),
                ).fetchone()
        except CoreInboundPersistenceError:
            raise
        except Exception as exc:
            raise CoreInboundPersistenceError("Canonical Core delivery could not be persisted") from exc
        if row is None:
            raise CoreInboundPersistenceError("Canonical Core delivery conflict could not be resolved")
        return row[0], False

    def replay_group(self, delivery_id: str, *, connection_id: str, core_channel_id: str, binding_id: str) -> dict[str, Any]:
        with self._connect() as connection, connection.transaction():
            row = connection.execute("SELECT doc FROM botly_gateway_core_inbound_deliveries WHERE id=%s FOR UPDATE", (delivery_id,)).fetchone()
            item = row[0] if row else {}
            event = item.get("canonicalEvent") or {}
            transport = event.get("transport") or {}
            if (event.get("contractVersion") != "canonical-v2" or transport.get("connectionRef") != connection_id
                    or transport.get("coreChannelId") != core_channel_id or transport.get("bindingId") != binding_id):
                raise ValueError("Replay binding mismatch")
            if item["status"] in {"failed", "dead_letter", "retry"}:
                item.update(status="pending", nextAttemptAt=_now(), leaseExpiresAt=None, lastError=None, updatedAt=_now(), attemptCount=0)
                self._save(connection, item)
            return {"id": item["id"], "eventId": item["eventId"], "status": item["status"]}

    def get(self, delivery_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT doc FROM botly_gateway_core_inbound_deliveries WHERE id=%s", (_text(delivery_id),)).fetchone()
        return row[0] if row else None

    def list(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT doc FROM botly_gateway_core_inbound_deliveries ORDER BY created_at").fetchall()
        return [row[0] for row in rows]

    def list_for_connection(self, connection_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT doc FROM botly_gateway_core_inbound_deliveries WHERE connection_id=%s ORDER BY created_at DESC LIMIT %s",
                (_text(connection_id), max(1, limit)),
            ).fetchall()
        return [row[0] for row in rows]

    def claim_due(self, *, limit: int, lease_seconds: int) -> list[dict[str, Any]]:
        now = _now()
        claimed: list[dict[str, Any]] = []
        with self._connect() as connection, connection.transaction():
            rows = connection.execute(
                "SELECT doc FROM botly_gateway_core_inbound_deliveries "
                "WHERE (status IN ('pending','retry') AND next_attempt_at <= %s) OR (status='delivering' AND lease_expires_at <= %s) "
                "ORDER BY next_attempt_at NULLS FIRST, created_at LIMIT %s FOR UPDATE SKIP LOCKED",
                (now, now, max(1, limit)),
            ).fetchall()
            for (item,) in rows:
                item.update({
                    "status": "delivering", "attemptCount": _as_int(item.get("attemptCount")) + 1,
                    "lastAttemptAt": now, "nextAttemptAt": None,
                    "leaseExpiresAt": now + max(1, lease_seconds) * 1000, "updatedAt": now,
                })
                self._save(connection, item)
                claimed.append(item)
        return claimed

    def _update(self, delivery_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as connection, connection.transaction():
            row = connection.execute("SELECT doc FROM botly_gateway_core_inbound_deliveries WHERE id=%s FOR UPDATE", (_text(delivery_id),)).fetchone()
            if row is None:
                raise KeyError(delivery_id)
            item = row[0]
            item.update(deepcopy(changes))
            item["updatedAt"] = _now()
            self._save(connection, item)
            return item


def build_core_inbound_store() -> CoreInboundDeliveryStore:
    settings = get_settings()
    mode = str(getattr(settings, "core_inbound_store", "auto") or "auto").lower()
    url = str(getattr(settings, "gateway_users_database_url", "") or "").strip()
    if mode == "postgres" or (mode == "auto" and url.startswith("postgresql")):
        return PostgresCoreInboundDeliveryStore(url)
    return CoreInboundDeliveryStore()
