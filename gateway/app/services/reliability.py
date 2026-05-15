from __future__ import annotations

import hashlib
import time
from collections import defaultdict, deque
from typing import Any

from app.core.config import get_settings


class TTLStore:
    def __init__(self, ttl_seconds: int, max_items: int):
        self.ttl_seconds = ttl_seconds
        self.max_items = max_items
        self._store: dict[str, float] = {}

    def _cleanup(self) -> None:
        now = time.time()
        expired = [k for k, exp in self._store.items() if exp <= now]
        for key in expired:
            self._store.pop(key, None)
        if len(self._store) <= self.max_items:
            return
        # fallback simple: recorta por vencimiento más cercano
        keep = sorted(self._store.items(), key=lambda kv: kv[1], reverse=True)[: self.max_items]
        self._store = dict(keep)

    def exists(self, key: str) -> bool:
        exp = self._store.get(key)
        if exp is None:
            return False
        if exp <= time.time():
            self._store.pop(key, None)
            return False
        return True

    def put(self, key: str) -> None:
        self._store[key] = time.time() + self.ttl_seconds
        if len(self._store) > self.max_items:
            self._cleanup()


settings = get_settings()
inbound_dedupe = TTLStore(
    ttl_seconds=settings.dedupe_ttl_seconds,
    max_items=settings.dedupe_max_items,
)
outbound_echo = TTLStore(
    ttl_seconds=settings.outbound_echo_ttl_seconds,
    max_items=max(1000, settings.dedupe_max_items // 2),
)
flood_tracker: dict[str, deque[float]] = defaultdict(deque)
_last_flood_cleanup = 0.0


def normalize_number(number: str | None) -> str:
    if not number:
        return ""
    return "".join(ch for ch in number if ch.isdigit())


def conversation_id(instance: str | None, remote_jid: str | None) -> str:
    return f"{instance or 'unknown'}::{(remote_jid or 'unknown').lower()}"


def message_fingerprint(
    *,
    instance: str | None,
    remote_jid: str | None,
    kind: str | None,
    text: str | None,
    media_id: str | None,
) -> str:
    raw = "|".join(
        [
            instance or "",
            (remote_jid or "").lower(),
            kind or "",
            (text or "").strip().lower()[:120],
            media_id or "",
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def outbound_fingerprint(instance: str, number: str, kind: str, payload: str) -> str:
    raw = "|".join([instance, normalize_number(number), kind, (payload or "").strip().lower()[:120]])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def mark_outbound(instance: str, number: str, kind: str, payload: str) -> str:
    fp = outbound_fingerprint(instance, number, kind, payload)
    outbound_echo.put(fp)
    return fp


def looks_like_outbound_echo(instance: str | None, remote_jid: str | None, kind: str, payload: str) -> bool:
    fp = outbound_fingerprint(
        instance or "unknown",
        normalize_number((remote_jid or "").split("@")[0]),
        kind,
        payload,
    )
    return outbound_echo.exists(fp)


def is_flood(conversation: str) -> tuple[bool, int]:
    global _last_flood_cleanup
    now = time.time()
    window = settings.flood_window_seconds
    max_messages = settings.flood_max_messages
    q = flood_tracker[conversation]
    q.append(now)
    while q and (now - q[0]) > window:
        q.popleft()
    if not q:
        flood_tracker.pop(conversation, None)

    if now - _last_flood_cleanup > 30:
        stale = [k for k, item in flood_tracker.items() if not item or (now - item[-1]) > window]
        for key in stale:
            flood_tracker.pop(key, None)
        _last_flood_cleanup = now
    return (len(q) > max_messages, len(q))
