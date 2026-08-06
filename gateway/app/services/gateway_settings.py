from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


_LOCK = threading.Lock()
_SCHEMA_VERSION = 1
_PERSISTENT_PATH = Path("/var/lib/botly/gateway_settings.json")
_LOCAL_PATH = Path("/tmp/botly_gateway_settings.json")

_CHANNEL_CATALOG: dict[str, dict[str, Any]] = {
    "whatsapp": {
        "name": "WhatsApp",
        "description": "Conexión oficial con Meta.",
        "icon": "message-circle",
        "implemented": True,
        "enabled": True,
    },
    "instagram": {
        "name": "Instagram",
        "description": "Mensajería de Instagram desde Meta.",
        "icon": "instagram",
        "implemented": False,
        "enabled": False,
    },
    "facebook": {
        "name": "Facebook",
        "description": "Mensajes de páginas de Facebook.",
        "icon": "facebook",
        "implemented": False,
        "enabled": False,
    },
    "telegram": {
        "name": "Telegram",
        "description": "Mensajería mediante bots de Telegram.",
        "icon": "send",
        "implemented": False,
        "enabled": False,
    },
}


class ChannelNotImplementedError(ValueError):
    pass


class ChannelDisabledError(ValueError):
    pass


class GatewaySettingsService:
    """Persistent product settings owned by the Gateway, not environment flags."""

    def __init__(self, path: str | Path | None = None) -> None:
        if path is not None:
            self._path = Path(path)
        else:
            self._path = _PERSISTENT_PATH if _PERSISTENT_PATH.parent.exists() else _LOCAL_PATH

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"schema_version": _SCHEMA_VERSION, "channels": {}}

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.exists():
            return self._empty()
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return self._empty()
        if not isinstance(payload, dict):
            return self._empty()
        channels = payload.get("channels") if isinstance(payload.get("channels"), dict) else {}
        return {"schema_version": _SCHEMA_VERSION, "channels": channels}

    def _write_unlocked(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temporary, self._path)

    def channels(self) -> dict[str, dict[str, Any]]:
        with _LOCK:
            stored = self._read_unlocked()["channels"]
        result: dict[str, dict[str, Any]] = {}
        for channel_id, definition in _CHANNEL_CATALOG.items():
            saved = stored.get(channel_id) if isinstance(stored.get(channel_id), dict) else {}
            implemented = bool(definition["implemented"])
            result[channel_id] = {
                **definition,
                "implemented": implemented,
                "enabled": bool(saved.get("enabled", definition["enabled"])) if implemented else False,
            }
        return result

    def update_channels(self, updates: dict[str, bool]) -> dict[str, dict[str, Any]]:
        unknown = set(updates) - set(_CHANNEL_CATALOG)
        if unknown:
            raise ValueError(f"Unknown channel: {sorted(unknown)[0]}")
        for channel_id, enabled in updates.items():
            if enabled and not bool(_CHANNEL_CATALOG[channel_id]["implemented"]):
                raise ChannelNotImplementedError(f"El canal '{channel_id}' todavía no está disponible.")
        with _LOCK:
            payload = self._read_unlocked()
            for channel_id, enabled in updates.items():
                payload["channels"][channel_id] = {"enabled": bool(enabled)}
            self._write_unlocked(payload)
        return self.channels()

    def require_channel_available(self, channel_id: str) -> None:
        channel = self.channels().get(channel_id)
        if channel is None or not channel["implemented"]:
            raise ChannelNotImplementedError(f"El canal '{channel_id}' todavía no está disponible.")
        if not channel["enabled"]:
            raise ChannelDisabledError(f"El canal '{channel_id}' está deshabilitado por la configuración del Gateway.")


def get_gateway_settings_service() -> GatewaySettingsService:
    return GatewaySettingsService()
