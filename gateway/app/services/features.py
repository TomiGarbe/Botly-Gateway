from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.config import Settings, get_settings


@dataclass(frozen=True)
class FeatureFlags:
    provider_evolution: bool
    provider_baileys: bool
    whatsapp_web: bool
    qr_login: bool
    instagram: bool
    whatsapp_cloud: bool

    def public_dict(self) -> dict[str, bool]:
        return {"providerEvolution": self.provider_evolution, "providerBaileys": self.provider_baileys, "whatsappWeb": self.whatsapp_web, "qrLogin": self.qr_login, "instagram": self.instagram, "whatsappCloud": self.whatsapp_cloud}


class FeatureService:
    """Single policy point for publicly exposed technologies."""

    def __init__(self, settings: Settings | None = None) -> None:
        config = settings or get_settings()
        self.flags = FeatureFlags(config.feature_provider_evolution, config.feature_provider_baileys, config.feature_whatsapp_web, config.feature_qr_login, config.feature_instagram, config.feature_whatsapp_cloud)

    def public_dict(self) -> dict[str, Any]:
        return {"features": self.flags.public_dict()}

    def method_enabled(self, channel_id: str, method_id: str) -> bool:
        if channel_id == "whatsapp" and method_id == "official":
            return self.flags.whatsapp_cloud
        if channel_id == "whatsapp" and method_id == "web":
            return all((self.flags.provider_evolution, self.flags.provider_baileys, self.flags.whatsapp_web, self.flags.qr_login))
        return channel_id == "instagram" and self.flags.instagram

    def public_channels(self, domain) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for channel in domain.public_channels():
            methods = [method for method in channel.get("methods", []) if method.get("visible") and method.get("enabled") and self.method_enabled(str(channel.get("id")), str(method.get("id")))]
            if channel.get("visible") and channel.get("enabled") and methods:
                items.append({**channel, "methods": methods, "capabilities": sorted({capability for method in methods for capability in method.get("capabilities", [])})})
        return sorted(items, key=lambda item: int(item.get("sortOrder") or 0))

    def connection_type_enabled(self, connection_type: str | None) -> bool:
        return str(connection_type or "").lower() != "baileys" or self.method_enabled("whatsapp", "web")


def get_feature_service() -> FeatureService:
    return FeatureService()
