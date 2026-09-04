"""Encrypted Channel API keys for the Gateway -> Botly Core boundary."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.secret_protection import SecretCipher


_LOCK = threading.Lock()


class CoreChannelCredentialStore:
    """Persist only the Core credential; Connection records retain a safe ref."""

    def __init__(self, path: str | Path | None = None) -> None:
        self._path = Path(path) if path is not None else Path(get_settings().core_channel_credentials_path)

    def _cipher(self) -> SecretCipher:
        settings = get_settings()
        material = str(getattr(settings, "core_channel_credentials_encryption_key", "") or "").strip()
        if str(getattr(settings, "environment", "")).lower() in {"production", "prod"} and not material:
            raise RuntimeError("CORE_CHANNEL_CREDENTIALS_ENCRYPTION_KEY is required in production")
        return SecretCipher(material or str(getattr(settings, "gateway_api_key", "") or ""))

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.exists():
            return {"version": 1, "credentials": {}}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return {"version": 1, "credentials": {}}
        credentials = raw.get("credentials") if isinstance(raw, dict) and isinstance(raw.get("credentials"), dict) else {}
        return {"version": 1, "credentials": credentials}

    def _write_unlocked(self, value: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self._path.with_suffix(self._path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True), encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, self._path)

    @staticmethod
    def _key(connection_id: str) -> str:
        return str(connection_id or "").strip()

    def upsert(self, *, connection_id: str, core_channel_id: str, channel_api_key: str) -> str:
        key = self._key(connection_id)
        channel = str(core_channel_id or "").strip()
        secret = str(channel_api_key or "").strip()
        if not key or not channel or not secret:
            raise ValueError("connection_id, core_channel_id and channel_api_key are required")
        with _LOCK:
            data = self._read_unlocked()
            data["credentials"][key] = {
                "coreChannelId": channel,
                "encryptedApiKey": self._cipher().encrypt(secret),
            }
            self._write_unlocked(data)
        return f"core-channel://{key}/{channel}"

    def get_api_key(self, *, connection_id: str, core_channel_id: str) -> str | None:
        key = self._key(connection_id)
        with _LOCK:
            item = self._read_unlocked()["credentials"].get(key)
        if not isinstance(item, dict) or str(item.get("coreChannelId") or "") != str(core_channel_id or ""):
            return None
        secret, _ = self._cipher().decrypt_or_legacy(item.get("encryptedApiKey"))
        return secret or None

    def delete(self, connection_id: str) -> None:
        key = self._key(connection_id)
        if not key:
            return
        with _LOCK:
            data = self._read_unlocked()
            if key in data["credentials"]:
                del data["credentials"][key]
                self._write_unlocked(data)

    def public_reference(self, *, connection_id: str, core_channel_id: str) -> dict[str, str]:
        return {"channelId": str(core_channel_id), "credentialRef": f"core-channel://{self._key(connection_id)}/{core_channel_id}"}


_store = CoreChannelCredentialStore()


def get_core_channel_credential_store() -> CoreChannelCredentialStore:
    return _store
