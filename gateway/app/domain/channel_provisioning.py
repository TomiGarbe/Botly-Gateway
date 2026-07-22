from __future__ import annotations

import hashlib

from app.domain.channel_store import ChannelStore, get_channel_store
from app.domain.defaults import get_default_domain_registry
from app.domain.models import ChannelId, ChannelStatus, MethodId, ProvisionedChannel
from app.domain.registries import DomainRegistry, RegistryError
from app.domain.runtime_resolver import RuntimeResolver
from app.platforms.meta import MetaResource, MetaResourceType
from app.platforms.meta.resource_store import MetaResourceStore, get_meta_resource_store


class ChannelProvisioningService:
    def __init__(
        self,
        *,
        domain: DomainRegistry | None = None,
        channel_store: ChannelStore | None = None,
        meta_resource_store: MetaResourceStore | None = None,
    ) -> None:
        self._domain = domain or get_default_domain_registry()
        self._channel_store = channel_store or get_channel_store()
        self._meta_resource_store = meta_resource_store or get_meta_resource_store()
        self._runtime_resolver = RuntimeResolver(self._domain)

    def provision_from_meta_resource(self, resource: MetaResource) -> ProvisionedChannel | None:
        target = self._target_for_meta_resource(resource)
        if target is None:
            return None
        channel_id, method_id = target
        existing = self._channel_store.find_by_resource(resource.id)
        if existing is not None:
            self._meta_resource_store.mark_active(resource.id)
            return existing

        resolution = self._runtime_resolver.resolve(channel_id, method_id)
        metadata = {
            "sourceResourceId": resource.id,
            "sourceResourceType": resource.resource_type.value,
            "sourceExternalId": resource.external_id,
        }
        if resource.resource_type == MetaResourceType.INSTAGRAM:
            page_id = str(resource.metadata.get("pageId") or "").strip()
            if page_id:
                metadata["sourcePageId"] = page_id
                metadata["graphSendNodeId"] = page_id

        channel = ProvisionedChannel(
            id=f"{channel_id.value}:{method_id.value}:{hashlib.sha256(resource.id.encode('utf-8')).hexdigest()[:12]}",
            channel_id=channel_id,
            method_id=method_id,
            integration_id=resolution.integration.id,
            runtime_id=resolution.runtime.id,
            display_name=resource.display_name,
            status=ChannelStatus.ACTIVE,
            metadata=metadata,
        )
        persisted = self._channel_store.upsert(channel)
        self._meta_resource_store.mark_active(resource.id)
        return persisted

    def _target_for_meta_resource(self, resource: MetaResource) -> tuple[ChannelId, MethodId] | None:
        if resource.resource_type == MetaResourceType.WHATSAPP_BUSINESS:
            return ChannelId.WHATSAPP, MethodId.OFFICIAL
        if resource.resource_type == MetaResourceType.INSTAGRAM:
            return ChannelId.INSTAGRAM, MethodId.OFFICIAL
        if resource.resource_type in {
            MetaResourceType.MESSENGER,
            MetaResourceType.FACEBOOK_PAGE,
        }:
            return None
        raise RegistryError(f"Unsupported MetaResource type: {resource.resource_type.value}")
