from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


_LOCK = threading.Lock()
_SCHEMA_VERSION = 2
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

_PROVIDER_CATALOG: dict[str, dict[str, Any]] = {
    "meta": {
        "name": "Meta",
        "description": "Plataforma oficial para los canales de Meta.",
        "icon": "meta",
        "implemented": True,
        "enabled": True,
    },
    "evolution": {
        "name": "Evolution",
        "description": "Runtime que opera las conexiones del Gateway.",
        "icon": "server",
        "implemented": True,
        "enabled": True,
    },
}


class ChannelNotImplementedError(ValueError):
    pass


class ChannelDisabledError(ValueError):
    pass


class ProviderNotImplementedError(ValueError):
    pass


class ProviderDisabledError(ValueError):
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
        return {"schema_version": _SCHEMA_VERSION, "channels": {}, "providers": {}}

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
        providers = payload.get("providers") if isinstance(payload.get("providers"), dict) else {}
        return {"schema_version": _SCHEMA_VERSION, "channels": channels, "providers": providers}

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

    def providers(self) -> dict[str, dict[str, Any]]:
        with _LOCK:
            stored = self._read_unlocked()["providers"]
        result: dict[str, dict[str, Any]] = {}
        for provider_id, definition in _PROVIDER_CATALOG.items():
            saved = stored.get(provider_id) if isinstance(stored.get(provider_id), dict) else {}
            implemented = bool(definition["implemented"])
            result[provider_id] = {
                **definition,
                "implemented": implemented,
                "enabled": bool(saved.get("enabled", definition["enabled"])) if implemented else False,
            }
        return result

    def update_providers(self, updates: dict[str, bool]) -> dict[str, dict[str, Any]]:
        unknown = set(updates) - set(_PROVIDER_CATALOG)
        if unknown:
            raise ValueError(f"Unknown provider: {sorted(unknown)[0]}")
        for provider_id, enabled in updates.items():
            if enabled and not bool(_PROVIDER_CATALOG[provider_id]["implemented"]):
                raise ProviderNotImplementedError(f"El proveedor '{provider_id}' no esta disponible todavia.")
        with _LOCK:
            payload = self._read_unlocked()
            for provider_id, enabled in updates.items():
                payload["providers"][provider_id] = {"enabled": bool(enabled)}
            self._write_unlocked(payload)
        return self.providers()

    def require_provider_available(self, provider_id: str) -> None:
        provider = self.providers().get(provider_id)
        if provider is None or not provider["implemented"]:
            raise ProviderNotImplementedError(f"El proveedor '{provider_id}' no esta disponible todavia.")
        if not provider["enabled"]:
            raise ProviderDisabledError(f"El proveedor '{provider_id}' esta deshabilitado por la configuracion del Gateway.")

    def require_channel_available(self, channel_id: str) -> None:
        channel = self.channels().get(channel_id)
        if channel is None or not channel["implemented"]:
            raise ChannelNotImplementedError(f"El canal '{channel_id}' todavía no está disponible.")
        if not channel["enabled"]:
            raise ChannelDisabledError(f"El canal '{channel_id}' está deshabilitado por la configuración del Gateway.")


def get_gateway_settings_service() -> GatewaySettingsService:
    return GatewaySettingsService()
