from __future__ import annotations

from dataclasses import dataclass

from app.domain.models import ChannelId, IntegrationDefinition, MethodId, ProvisionedChannel, RuntimeDefinition
from app.domain.registries import DomainRegistry, RegistryError


@dataclass(frozen=True)
class RuntimeResolution:
    integration: IntegrationDefinition
    runtime: RuntimeDefinition


class RuntimeResolver:
    def __init__(self, domain: DomainRegistry) -> None:
        self._domain = domain

    def resolve(self, channel_id: ChannelId | str, method_id: MethodId | str) -> RuntimeResolution:
        integration = self._domain.integration_for_method(channel_id, method_id)
        if integration is None:
            raise RegistryError(f"No integration registered for {channel_id} / {method_id}")
        runtime = self._domain.runtimes.require(integration.runtime_id)
        return RuntimeResolution(integration=integration, runtime=runtime)

    def resolve_channel(self, channel: ProvisionedChannel) -> RuntimeResolution:
        integration = self._domain.integrations.require(channel.integration_id)
        if integration.channel_id != channel.channel_id or integration.method_id != channel.method_id:
            raise RegistryError(f"Channel {channel.id} integration does not match its channel/method.")
        runtime = self._domain.runtimes.require(channel.runtime_id)
        if runtime.id != integration.runtime_id:
            raise RegistryError(f"Channel {channel.id} runtime does not match its integration.")
        return RuntimeResolution(integration=integration, runtime=runtime)
