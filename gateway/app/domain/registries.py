from __future__ import annotations

from enum import Enum
from typing import Generic, Iterable, TypeVar

from app.domain.models import (
    ChannelDefinition,
    ChannelId,
    IntegrationDefinition,
    MethodDefinition,
    MethodId,
    PlatformDefinition,
    PlatformId,
    RuntimeDefinition,
    RuntimeId,
)

T = TypeVar("T")


class RegistryError(ValueError):
    pass


def _key(value: Enum | str) -> str:
    if isinstance(value, Enum):
        return str(value.value)
    return str(value)


class Registry(Generic[T]):
    def __init__(self, items: Iterable[T] = ()) -> None:
        self._items: dict[str, T] = {}
        for item in items:
            self.register(item)

    def register(self, item: T) -> None:
        item_id = _key(getattr(item, "id"))
        if item_id in self._items:
            raise RegistryError(f"Duplicate registry item: {item_id}")
        self._items[item_id] = item

    def get(self, item_id: Enum | str) -> T | None:
        return self._items.get(_key(item_id))

    def require(self, item_id: Enum | str) -> T:
        item = self.get(item_id)
        if item is None:
            raise RegistryError(f"Unknown registry item: {_key(item_id)}")
        return item

    def list(self) -> tuple[T, ...]:
        return tuple(self._items.values())


class PlatformRegistry(Registry[PlatformDefinition]):
    pass


class RuntimeRegistry(Registry[RuntimeDefinition]):
    pass


class IntegrationRegistry(Registry[IntegrationDefinition]):
    def for_method(self, channel_id: ChannelId | str, method_id: MethodId | str) -> IntegrationDefinition | None:
        resolved_channel_id = _key(channel_id)
        resolved_method_id = _key(method_id)
        for integration in self.list():
            if integration.channel_id.value == resolved_channel_id and integration.method_id.value == resolved_method_id:
                return integration
        return None

    def for_runtime_integration(self, runtime_integration: str) -> IntegrationDefinition | None:
        resolved_runtime_integration = str(runtime_integration or "").strip()
        for integration in self.list():
            if integration.runtime_integration == resolved_runtime_integration:
                return integration
        return None


class ChannelRegistry(Registry[ChannelDefinition]):
    def methods_for(self, channel_id: ChannelId | str) -> tuple[MethodDefinition, ...]:
        return self.require(channel_id).methods

    def get_method(self, channel_id: ChannelId | str, method_id: MethodId | str) -> MethodDefinition | None:
        resolved_method_id = _key(method_id)
        for method in self.methods_for(channel_id):
            if method.id.value == resolved_method_id:
                return method
        return None

    def require_method(self, channel_id: ChannelId | str, method_id: MethodId | str) -> MethodDefinition:
        method = self.get_method(channel_id, method_id)
        if method is None:
            raise RegistryError(f"Unknown channel method: {_key(channel_id)} / {_key(method_id)}")
        return method

    def public_channels(self) -> tuple[dict, ...]:
        return tuple(channel.public_dict() for channel in self.list())


class DomainRegistry:
    def __init__(
        self,
        *,
        channels: ChannelRegistry,
        platforms: PlatformRegistry,
        runtimes: RuntimeRegistry,
        integrations: IntegrationRegistry,
    ) -> None:
        self.channels = channels
        self.platforms = platforms
        self.runtimes = runtimes
        self.integrations = integrations

    def integration_for_method(
        self,
        channel_id: ChannelId | str,
        method_id: MethodId | str,
    ) -> IntegrationDefinition | None:
        return self.integrations.for_method(channel_id, method_id)

    def integration_for_runtime_integration(self, runtime_integration: str) -> IntegrationDefinition | None:
        return self.integrations.for_runtime_integration(runtime_integration)

    def public_channels(self) -> tuple[dict, ...]:
        return self.channels.public_channels()
