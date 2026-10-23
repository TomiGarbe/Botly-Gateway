"""WhatsApp Cloud API coexistence: the business keeps the WhatsApp Business app.

Meta sends up to 180 days of 1:1 history once (webhook field ``history``) after
``POST /{phone_number_id}/smb_app_data`` is called within 24h of onboarding,
and mirrors what the business sends from the app (``smb_message_echoes``).
Groups are not synchronized by Meta.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.connection_registry import get_connection_registry
from app.services.credential_manager import get_credential_manager

logger = get_logger(__name__)

HISTORY_DECLINED = 2593109


def cloud_message_data(message: dict[str, Any], contacts: list[dict[str, Any]] | None = None, *, from_me: bool = False) -> dict[str, Any]:
    """Evolution-shaped record, the format the inbound pipeline and Core already read."""
    from app.routers.meta_webhook import _message_data

    data = _message_data(message, contacts or [])
    if from_me:
        recipient = str(message.get("to") or "").strip()
        data["key"].update({"remoteJid": f"{recipient}@s.whatsapp.net", "fromMe": True})
        data["pushName"] = None
    return data


def history_records(item: dict[str, Any], business_number: str) -> list[dict[str, Any]]:
    """Flatten one ``history`` chunk; business messages carry ``to`` (or come from its own number)."""
    records = []
    for thread in item.get("threads") or []:
        if not isinstance(thread, dict):
            continue
        for message in thread.get("messages") or []:
            if not isinstance(message, dict) or not message.get("id") or message.get("type") == "media_placeholder":
                continue
            outbound = bool(message.get("to")) or str(message.get("from") or "") == business_number
            if outbound and not message.get("to"):
                message = {**message, "to": thread.get("id")}
            records.append(cloud_message_data(message, from_me=outbound))
    return records


class CloudHistoryStore:
    """History chunks per runtime instance, newest first when paged."""

    def __init__(self, database_url: str | None = None, *, path: str | Path | None = None) -> None:
        settings = get_settings()
        url = database_url if database_url is not None else str(getattr(settings, "gateway_users_database_url", "") or "")
        self._url = url if url.startswith("postgresql") else ""
        self._path = Path(path) if path is not None else Path(settings.core_inbound_deliveries_path).with_name("cloud_history.json")
        self._lock = threading.Lock()
        self._ready = False

    def _connect(self):
        import psycopg

        connection = psycopg.connect(self._url)
        if not self._ready:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS botly_gateway_cloud_history (instance TEXT NOT NULL, message_id TEXT NOT NULL, "
                "ts BIGINT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (instance, message_id));"
                "CREATE INDEX IF NOT EXISTS ix_cloud_history_ts ON botly_gateway_cloud_history (instance, ts DESC)"
            )
            connection.commit()
            self._ready = True
        return connection

    def _read(self) -> dict[str, dict[str, dict[str, Any]]]:
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}

    def add(self, instance: str, records: list[dict[str, Any]]) -> int:
        rows = [(instance, r["key"]["id"], int(r.get("messageTimestamp") or 0), json.dumps(r)) for r in records if r.get("key", {}).get("id")]
        if not rows:
            return 0
        if self._url:
            with self._connect() as connection:
                cursor = connection.cursor()
                cursor.executemany(
                    "INSERT INTO botly_gateway_cloud_history (instance, message_id, ts, data) VALUES (%s,%s,%s,%s::jsonb) ON CONFLICT DO NOTHING",
                    rows,
                )
            return len(rows)
        with self._lock:
            data = self._read()
            bucket = data.setdefault(instance, {})
            for _, message_id, _, raw in rows:
                bucket.setdefault(message_id, json.loads(raw))
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(data), encoding="utf-8")
        return len(rows)

    def page(self, instance: str, page: int, page_size: int) -> tuple[list[dict[str, Any]], int]:
        offset = (max(1, page) - 1) * page_size
        if self._url:
            with self._connect() as connection:
                total = connection.execute("SELECT COUNT(*) FROM botly_gateway_cloud_history WHERE instance=%s", (instance,)).fetchone()[0]
                rows = connection.execute(
                    "SELECT data FROM botly_gateway_cloud_history WHERE instance=%s ORDER BY ts DESC, message_id LIMIT %s OFFSET %s",
                    (instance, page_size, offset),
                ).fetchall()
            return [row[0] for row in rows], int(total)
        with self._lock:
            records = sorted(self._read().get(instance, {}).values(), key=lambda r: (-int(r.get("messageTimestamp") or 0), r["key"]["id"]))
        return records[offset:offset + page_size], len(records)


_store: CloudHistoryStore | None = None


def get_cloud_history_store() -> CloudHistoryStore:
    global _store
    if _store is None:
        _store = CloudHistoryStore()
    return _store


def record_history_chunk(instance: str, item: dict[str, Any], business_number: str, *, store=None, registry=None) -> int:
    registry = registry or get_connection_registry()
    record = registry.connection_record(instance)
    errors = [e for e in item.get("errors") or [] if isinstance(e, dict)]
    meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    stored = 0 if errors else (store or get_cloud_history_store()).add(instance, history_records(item, business_number))
    if record:
        state = dict(record.get("coexistence") or {})
        if any(e.get("code") == HISTORY_DECLINED for e in errors):
            state["history"] = "declined"
        else:
            state.update(history="complete" if meta.get("phase") == 2 and int(meta.get("progress") or 0) >= 100 else "receiving",
                         historyPhase=meta.get("phase"), historyProgress=meta.get("progress"),
                         historyMessages=int(state.get("historyMessages") or 0) + stored)
        state["updatedAt"] = datetime.now(timezone.utc).isoformat()
        registry.update_connection_record(record["id"], {"coexistence": state})
    return stored


async def request_coexistence_sync(instance: str, *, client_factory=httpx.AsyncClient, registry=None) -> dict[str, Any]:
    """Ask Meta for contacts and history. Each type works once, within 24h of onboarding."""
    credentials = get_credential_manager()
    info = credentials.get_official_credentials_info(instance)
    token = credentials.get_official_access_token(instance)
    if info is None or not token:
        raise ValueError("WhatsApp Cloud credentials are unavailable")
    settings = get_settings()
    url = f"https://graph.facebook.com/{settings.meta_graph_version}/{info.phone_number_id}/smb_app_data"
    results: dict[str, Any] = {}
    async with client_factory(timeout=30) as client:
        for sync_type in ("smb_app_state_sync", "history"):
            response = await client.post(url, json={"messaging_product": "whatsapp", "sync_type": sync_type},
                                         headers={"Authorization": f"Bearer {token}"})
            body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            results[sync_type] = ({"requestId": body.get("request_id")} if response.status_code < 400
                                  else {"error": (body.get("error") or {}).get("message") or f"HTTP {response.status_code}"})
    registry = registry or get_connection_registry()
    record = registry.connection_record(instance)
    if record:
        state = dict(record.get("coexistence") or {})
        state.update(requestedAt=datetime.now(timezone.utc).isoformat(), contacts=results["smb_app_state_sync"],
                     historyRequest=results["history"], history=state.get("history") or ("requested" if "requestId" in results["history"] else "failed"))
        registry.update_connection_record(record["id"], {"coexistence": state})
    logger.info("cloud_coexistence_sync_requested", instance=instance, outcome={k: "ok" if "requestId" in v else "error" for k, v in results.items()})
    return results
