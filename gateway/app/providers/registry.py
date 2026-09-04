from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class ProviderRegistryError(ValueError):
    pass


@dataclass(frozen=True)
class ProviderRegistration:
    """One deterministic provider/channel adapter registration."""

    provider_id: str
    channel_type: str
    adapter: Any


class ProviderRegistry:
    """Resolve provider transport separately from the functional channel."""

    def __init__(self) -> None:
        self._registrations: dict[tuple[str, str], ProviderRegistration] = {}

    @staticmethod
    def _key(provider_id: str, channel_type: str) -> tuple[str, str]:
        provider = str(provider_id or "").strip().lower()
        channel = str(channel_type or "").strip().lower()
        if not provider or not channel:
            raise ProviderRegistryError("provider_id and channel_type are required")
        return provider, channel

    def register(self, *, provider_id: str, channel_type: str, adapter: Any) -> None:
        key = self._key(provider_id, channel_type)
        if key in self._registrations:
            raise ProviderRegistryError(f"Provider already registered for {key[0]} / {key[1]}")
        self._registrations[key] = ProviderRegistration(*key, adapter)

    def get(self, *, provider_id: str, channel_type: str) -> Any | None:
        registration = self._registrations.get(self._key(provider_id, channel_type))
        return registration.adapter if registration else None

    def require(self, *, provider_id: str, channel_type: str) -> Any:
        adapter = self.get(provider_id=provider_id, channel_type=channel_type)
        if adapter is None:
            raise ProviderRegistryError(
                f"No provider adapter registered for provider={provider_id!r}, channel_type={channel_type!r}"
            )
        return adapter

    def registrations(self) -> tuple[ProviderRegistration, ...]:
        return tuple(self._registrations[key] for key in sorted(self._registrations))
