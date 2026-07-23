from __future__ import annotations

from uuid import uuid4

from app.connections.types import ConnectionType
from app.domain import (
    ChannelProvisioningService,
    ChannelStatus,
    ChannelStore,
    DomainRegistry,
    RegistryError,
    RuntimeResolver,
    get_channel_store,
    get_default_domain_registry,
)
from app.platforms.meta import MetaResource, MetaResourceStore, get_meta_resource_store
from app.provisioning.contracts import InstanceProvisioner, SignupProvider
from app.provisioning.models import ProvisioningRecord, ProvisioningRequest, ProvisioningResult
from app.provisioning.public_models import (
    CatalogItem,
    ConnectionRequest,
    ConnectionStart,
    MethodInfo,
    ProvisionedChannel as PublicProvisionedChannel,
    ProvisioningResource,
)
from app.provisioning.types import ProvisioningState
from app.services.features import FeatureService, get_feature_service


class ProvisioningResourceNotFoundError(LookupError):
    pass


class ProvisioningResourceUnsupportedError(ValueError):
    pass


class ProvisioningService:
    def __init__(
        self,
        *,
        instance_provisioners: list[InstanceProvisioner] | None = None,
        signup_providers: list[SignupProvider] | None = None,
        domain: DomainRegistry | None = None,
        channel_store: ChannelStore | None = None,
        meta_resource_store: MetaResourceStore | None = None,
        channel_provisioning: ChannelProvisioningService | None = None,
        features: FeatureService | None = None,
    ) -> None:
        self._domain = domain or get_default_domain_registry()
        self._channel_store = channel_store or get_channel_store()
        self._meta_resource_store = meta_resource_store or get_meta_resource_store()
        self._channel_provisioning = channel_provisioning or ChannelProvisioningService(
            domain=self._domain,
            channel_store=self._channel_store,
            meta_resource_store=self._meta_resource_store,
        )
        self._runtime_resolver = RuntimeResolver(self._domain)
        self._features = features
        self._instance_provisioners = {
            provisioner.connection_type: provisioner for provisioner in (instance_provisioners or [])
        }
        self._signup_providers = {
            (provider.connection_type, provider.provider_name): provider for provider in (signup_providers or [])
        }
        self._records: dict[str, ProvisioningRecord] = {}

    def list_catalog(self) -> list[CatalogItem]:
        items: list[CatalogItem] = []
        channels = sorted(
            (channel for channel in self._domain.channels.list() if channel.visible and channel.enabled),
            key=lambda item: item.sort_order,
        )
        for channel in channels:
            methods = [
                MethodInfo(
                    id=method.id.value,
                    display_name=method.display_name,
                    icon=method.icon,
                    authentication=method.authentication.value,
                    discovery=method.discovery.value,
                    capabilities=list(method.capabilities.as_tuple()),
                    enabled=method.enabled,
                )
                for method in sorted(
                    (method for method in channel.methods if method.visible and method.enabled and self._feature_service().method_enabled(channel.id.value, method.id.value)),
                    key=lambda item: item.sort_order,
                )
            ]
            items.append(
                CatalogItem(
                    channel=channel.id.value,
                    display_name=channel.display_name,
                    icon=channel.icon,
                    capabilities=list(channel.capabilities.as_tuple()),
                    methods=methods,
                    enabled=channel.enabled,
                )
            )
        return items

    def list_resources(self) -> list[ProvisioningResource]:
        return [
            ProvisioningResource(
                id=resource.id,
                type=resource.resource_type.value,
                display_name=resource.display_name,
                status=resource.status.value,
            )
            for resource in self._meta_resource_store.list()
        ]

    def list_channels(self) -> list[PublicProvisionedChannel]:
        return [self._public_channel(channel) for channel in self._channel_store.list()]

    def start_connection(self, request: ConnectionRequest) -> ConnectionStart:
        channel = self._domain.channels.require(request.channel)
        method = self._domain.channels.require_method(channel.id, request.method)
        if not self._feature_service().method_enabled(channel.id.value, method.id.value):
            raise RegistryError("Channel method not available")
        resolution = self._runtime_resolver.resolve(channel.id, method.id)
        if not resolution.integration.enabled:
            raise RegistryError(f"Integration disabled for {channel.id.value} / {method.id.value}")

        platform = None
        if method.platform_id is not None:
            platform_definition = self._domain.platforms.require(method.platform_id)
            platform = {
                "id": platform_definition.id.value,
                "display_name": platform_definition.display_name,
                "icon": platform_definition.icon,
                "enabled": platform_definition.enabled,
                "supports_oauth": platform_definition.supports_oauth,
                "supports_discovery": platform_definition.supports_discovery,
            }

        next_action = {
            "type": method.authentication.value,
            "discovery": method.discovery.value,
            "channel": channel.id.value,
            "method": method.id.value,
        }
        if method.platform_id is not None:
            next_action["platform"] = method.platform_id.value

        return ConnectionStart(
            channel=channel.id.value,
            method=method.id.value,
            status="READY",
            authentication=method.authentication.value,
            discovery=method.discovery.value,
            platform=platform,
            capabilities=list(method.capabilities.as_tuple()),
            next_action=next_action,
        )

    def provision_resource(self, resource_id: str) -> PublicProvisionedChannel:
        resource = self._find_meta_resource(resource_id)
        if resource is None:
            raise ProvisioningResourceNotFoundError(f"Resource not found: {resource_id}")
        channel = self._channel_provisioning.provision_from_meta_resource(resource)
        if channel is None:
            raise ProvisioningResourceUnsupportedError(f"Resource cannot be provisioned: {resource_id}")
        return self._public_channel(channel)

    def _new_record(self, request: ProvisioningRequest) -> ProvisioningRecord:
        record = ProvisioningRecord(
            id=str(uuid4()),
            instance_name=request.instance_name,
            connection_type=request.connection_type,
            metadata=dict(request.metadata),
        )
        self._records[record.id] = record
        return record

    def get_record(self, provisioning_id: str) -> ProvisioningRecord | None:
        return self._records.get(provisioning_id)

    async def provision_connection(self, request: ProvisioningRequest) -> ProvisioningResult:
        record = self._new_record(request)

        if request.requires_signup:
            record.transition(ProvisioningState.WAITING_CONFIGURATION)
            provider = self._resolve_signup_provider(request.connection_type, request.signup_provider)
            if provider is None:
                return ProvisioningResult(record=record)
            signup = await provider.start(request)
            return ProvisioningResult(record=record, signup=signup)

        provisioner = self._resolve_instance_provisioner(request.connection_type)
        try:
            record.transition(ProvisioningState.PROVISIONING)
            provisioned = await provisioner.provision_instance(request)
            record.metadata.update(provisioned.metadata)
            if provisioned.external_id:
                record.metadata["externalId"] = provisioned.external_id
            record.transition(ProvisioningState.READY)
            return ProvisioningResult(record=record, instance=provisioned.instance)
        except Exception as exc:
            record.transition(ProvisioningState.FAILED, error=str(exc))
            raise

    def _resolve_instance_provisioner(self, connection_type: ConnectionType) -> InstanceProvisioner:
        provisioner = self._instance_provisioners.get(connection_type)
        if provisioner is None:
            raise NotImplementedError(f"No instance provisioner registered for connection type {connection_type.value}.")
        return provisioner

    def _resolve_signup_provider(
        self,
        connection_type: ConnectionType,
        provider_name: str | None,
    ) -> SignupProvider | None:
        if provider_name is not None:
            return self._signup_providers.get((connection_type, provider_name))

        for (provider_connection_type, _), provider in self._signup_providers.items():
            if provider_connection_type == connection_type:
                return provider
        return None

    def _find_meta_resource(self, resource_id: str) -> MetaResource | None:
        for resource in self._meta_resource_store.list():
            if resource.id == resource_id:
                return resource
        return None

    def _feature_service(self) -> FeatureService:
        return self._features or get_feature_service()

    def _public_channel(self, channel) -> PublicProvisionedChannel:
        return PublicProvisionedChannel(
            id=channel.id,
            channel=channel.channel_id.value,
            method=channel.method_id.value,
            display_name=channel.display_name,
            status=_public_channel_status(channel.status),
        )


def _public_channel_status(status: ChannelStatus | str) -> str:
    if status == ChannelStatus.ACTIVE or str(status) == ChannelStatus.ACTIVE.value:
        return "CONNECTED"
    if isinstance(status, ChannelStatus):
        return status.value
    return str(status)
