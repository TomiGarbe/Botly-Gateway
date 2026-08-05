from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from uuid import uuid4

from app.core.config import get_settings
from app.domain.alert import Alert, AlertReference
from app.domain.connection import Connection
from app.services.connection_operations import ConnectionOperationsService, get_connection_operations_service
from app.services.connections import ConnectionService, get_connection_service
from app.services.normalization import list_events


_LOCK = threading.Lock()
_HEARTBEAT_MAX_AGE = timedelta(minutes=15)
_RECONNECT_WINDOW = timedelta(hours=24)
_RECONNECT_THRESHOLD = 3
_ALERTS_KEY = "connection_alerts_v2"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat().replace("+00:00", "Z")


class AlertStore:
    """Persists operator decisions without changing the event timeline."""

    def __init__(self, path: str | Path | None = None) -> None:
        self._path = Path(path) if path is not None else Path(get_settings().alerts_path)

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.exists():
            return {_ALERTS_KEY: []}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return {_ALERTS_KEY: []}
        if not isinstance(raw, dict):
            return {_ALERTS_KEY: []}
        raw.setdefault(_ALERTS_KEY, [])
        if not isinstance(raw[_ALERTS_KEY], list):
            raw[_ALERTS_KEY] = []
        return raw

    def _write_unlocked(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
        os.replace(temporary, self._path)

    def sync(self, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = _iso()
        active_fingerprints = {candidate["fingerprint"] for candidate in candidates}
        with _LOCK:
            payload = self._read_unlocked()
            items = [item for item in payload[_ALERTS_KEY] if isinstance(item, dict)]
            active_by_fingerprint = {
                str(item.get("fingerprint")): item
                for item in items
                if item.get("status") in {"new", "acknowledged"}
            }
            manually_resolved = {
                str(item.get("fingerprint"))
                for item in items
                if item.get("status") == "resolved" and item.get("resolution_source") == "manual"
            }

            for item in items:
                if item.get("status") in {"new", "acknowledged"} and item.get("fingerprint") not in active_fingerprints:
                    item["status"] = "resolved"
                    item["resolved_at"] = now
                    item["resolution_source"] = "automatic"

            for candidate in candidates:
                current = active_by_fingerprint.get(candidate["fingerprint"])
                if current is not None or candidate["fingerprint"] in manually_resolved:
                    continue
                items.append(
                    {
                        "id": str(uuid4()),
                        "status": "new",
                        "created_at": now,
                        "resolved_at": None,
                        "resolution_source": None,
                        **candidate,
                    }
                )

            payload[_ALERTS_KEY] = items
            self._write_unlocked(payload)
            return [dict(item) for item in items]

    def list(self) -> list[dict[str, Any]]:
        with _LOCK:
            return [dict(item) for item in self._read_unlocked()[_ALERTS_KEY] if isinstance(item, dict)]

    def update_status(self, alert_id: str, status: str) -> dict[str, Any] | None:
        if status not in {"acknowledged", "resolved"}:
            return None
        with _LOCK:
            payload = self._read_unlocked()
            for item in payload[_ALERTS_KEY]:
                if not isinstance(item, dict) or item.get("id") != alert_id:
                    continue
                if item.get("status") == "resolved":
                    return dict(item)
                item["status"] = status
                if status == "resolved":
                    item["resolved_at"] = _iso()
                    item["resolution_source"] = "manual"
                self._write_unlocked(payload)
                return dict(item)
            return None


class AlertService:
    """Builds actionable Connection incidents; it never exposes technical evidence."""

    def __init__(
        self,
        connections: ConnectionService | None = None,
        operations: ConnectionOperationsService | None = None,
        store: AlertStore | None = None,
        events_reader: Callable[..., list[dict[str, Any]]] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._connections = connections or get_connection_service()
        self._operations = operations or get_connection_operations_service()
        self._store = store or AlertStore()
        self._events_reader = events_reader or list_events
        self._now = now or _now

    async def list_alerts(self) -> list[Alert]:
        connections = await self._connections.list_connections()
        runtime_names = {self._connections.connection_runtime_name(connection.id): connection for connection in connections}
        candidates = self._candidates(connections, runtime_names)
        records = self._store.sync(candidates)
        alerts = [self._to_alert(item) for item in records]
        return sorted(alerts, key=lambda item: (item.status == "resolved", item.created_at), reverse=False)

    async def acknowledge(self, alert_id: str) -> Alert | None:
        await self.list_alerts()
        item = self._store.update_status(alert_id, "acknowledged")
        return self._to_alert(item) if item else None

    async def resolve(self, alert_id: str) -> Alert | None:
        await self.list_alerts()
        item = self._store.update_status(alert_id, "resolved")
        return self._to_alert(item) if item else None

    def _candidates(self, connections: list[Connection], runtime_names: dict[str, Connection]) -> list[dict[str, Any]]:
        events = self._events_reader(limit=500)
        reconnects = self._reconnect_counts(events, runtime_names)
        candidates: list[dict[str, Any]] = []
        for connection in connections:
            candidates.extend(self._connection_candidates(connection, reconnects.get(connection.id, 0)))
        return candidates

    def _connection_candidates(self, connection: Connection, reconnect_count: int) -> list[dict[str, Any]]:
        lifecycle = (connection.status.lifecycle or "").lower()
        candidates: list[dict[str, Any]] = []
        if connection.status.state == "disconnected":
            candidates.append(self._candidate("connection_disconnected", "critical", "Conexión desconectada", "La conexión dejó de estar disponible. Abrí el Workspace para reconectarla.", connection))
        if "auth" in lifecycle or "token" in lifecycle:
            candidates.append(self._candidate("authentication_error", "critical", "Error de autenticación", "La autorización de esta conexión necesita renovarse.", connection))
        if connection.status.state in {"pending", "connecting"}:
            candidates.append(self._candidate("embedded_signup_pending", "warning", "Embedded Signup pendiente", "La conexión todavía necesita completar su configuración.", connection))
        if connection.status.health == "degraded" or connection.status.health == "unhealthy":
            candidates.append(self._candidate("provider_degraded", "critical" if connection.status.health == "unhealthy" else "warning", "Proveedor degradado", "El proveedor de esta conexión reporta un estado degradado.", connection))

        heartbeat_at = self._heartbeat_at(connection.id)
        if heartbeat_at and self._now() - heartbeat_at > _HEARTBEAT_MAX_AGE:
            candidates.append(self._candidate("heartbeat_expired", "warning", "Heartbeat vencido", "No se confirmó actividad reciente de esta conexión.", connection))
        try:
            webhook = self._operations.webhook(connection.id)
        except Exception:
            webhook = None
        if webhook and webhook.get("last_error"):
            candidates.append(self._candidate("webhook_errors", "warning", "Webhook con errores", "La última entrega del webhook no pudo completarse.", connection))
        if reconnect_count >= _RECONNECT_THRESHOLD:
            candidates.append(self._candidate("repeated_reconnects", "warning", "Reconexiones repetidas", "La conexión requirió varias reconexiones recientemente.", connection))
        return candidates

    @staticmethod
    def _reference(connection: Connection) -> AlertReference:
        return AlertReference(id=connection.id, name=connection.name)

    @staticmethod
    def _client_reference(connection: Connection) -> AlertReference:
        return AlertReference(id=connection.client_id, name=connection.client.name if connection.client else "Cliente")

    def _candidate(self, alert_type: str, severity: str, title: str, description: str, connection: Connection) -> dict[str, Any]:
        return {
            "fingerprint": f"{alert_type}:{connection.id}",
            "severity": severity,
            "title": title,
            "description": description,
            "client": self._client_reference(connection).__dict__,
            "connection": self._reference(connection).__dict__,
            "workspace_url": f"/connections/{connection.id}",
        }

    def _heartbeat_at(self, connection_id: str) -> datetime | None:
        try:
            value = self._connections.connection_last_heartbeat_at(connection_id)
            return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
        except (TypeError, ValueError):
            return None

    def _reconnect_counts(self, events: Iterable[dict[str, Any]], runtime_names: dict[str, Connection]) -> dict[str, int]:
        minimum = int((self._now() - _RECONNECT_WINDOW).timestamp() * 1000)
        counts: dict[str, int] = {}
        for event in events:
            if not isinstance(event, dict) or int(event.get("timestamp") or 0) < minimum:
                continue
            pipeline = event.get("pipeline") if isinstance(event.get("pipeline"), dict) else {}
            stage = str(pipeline.get("stage") or "").lower()
            event_name = str(event.get("event") or "").lower()
            if "reconnect" not in stage and "reconnect" not in event_name:
                continue
            connection = runtime_names.get(str(event.get("instance") or ""))
            if connection:
                counts[connection.id] = counts.get(connection.id, 0) + 1
        return counts

    @staticmethod
    def _to_alert(item: dict[str, Any]) -> Alert:
        client = item.get("client") if isinstance(item.get("client"), dict) else {}
        connection = item.get("connection") if isinstance(item.get("connection"), dict) else {}
        return Alert(
            id=str(item["id"]),
            severity=str(item["severity"]),
            status=str(item["status"]),
            title=str(item["title"]),
            description=str(item["description"]),
            client=AlertReference(id=str(client.get("id") or ""), name=str(client.get("name") or "Cliente")),
            connection=AlertReference(id=str(connection.get("id") or ""), name=str(connection.get("name") or "Conexión")),
            created_at=str(item["created_at"]),
            resolved_at=str(item["resolved_at"]) if item.get("resolved_at") else None,
            workspace_url=str(item["workspace_url"]),
        )


def get_alert_service() -> AlertService:
    return AlertService()


# Transitional internal helpers for legacy automations. They are deliberately
# excluded from the HTTP API and do not affect the Connection alert workflow.
def update_alert(alert_id: str, *, status: str) -> dict[str, Any] | None:
    item = AlertStore().update_status(alert_id, "resolved" if status == "resolved" else "acknowledged")
    return item


def create_manual_alert(**_kwargs: Any) -> dict[str, Any]:
    return {"ok": False}
