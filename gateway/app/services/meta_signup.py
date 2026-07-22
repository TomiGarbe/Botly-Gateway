from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.connections import get_connection_manager
from app.core.config import get_settings
from app.core.logging import get_logger
from app.domain import ChannelProvisioningService, ProvisionedChannel
from app.platforms.meta import MetaCredentials, MetaPlatform, MetaPlatformError, MetaResource

logger = get_logger(__name__)


class MetaSignupError(MetaPlatformError):
    pass


@dataclass(frozen=True)
class MetaSignupCompletion:
    credentials: MetaCredentials
    instance: dict[str, Any]
    resources: tuple[MetaResource, ...] = ()
    channels: tuple[ProvisionedChannel, ...] = ()


class MetaSignupService:
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        connection_manager: Any | None = None,
        platform: MetaPlatform | None = None,
        channel_provisioning: ChannelProvisioningService | None = None,
    ) -> None:
        self._connection_manager = connection_manager
        self._platform = platform or MetaPlatform(client=client, settings_factory=get_settings)
        self._channel_provisioning = channel_provisioning or ChannelProvisioningService()

    def public_config(self) -> dict[str, Any]:
        return self._platform.public_config()

    async def complete_onboarding(
        self,
        *,
        instance_name: str,
        code: str,
        phone_number_id: str,
        business_account_id: str,
        session_info: dict[str, Any] | None = None,
    ) -> MetaSignupCompletion:
        credentials = await self.complete_embedded_signup(
            code=code,
            phone_number_id=phone_number_id,
            business_account_id=business_account_id,
            session_info=session_info,
        )
        resources: tuple[MetaResource, ...] = ()
        try:
            resources = await self._platform.discover_resources(credentials=credentials)
            logger.info(
                "meta_resources_discovered",
                instance=instance_name,
                business_account_id=business_account_id,
                count=len(resources),
            )
        except Exception as exc:
            logger.warning(
                "meta_resources_discovery_failed",
                instance=instance_name,
                business_account_id=business_account_id,
                error=str(exc),
            )
        channels: list[ProvisionedChannel] = []
        for resource in resources:
            try:
                channel = self._channel_provisioning.provision_from_meta_resource(resource)
                if channel is not None:
                    channels.append(channel)
            except Exception as exc:
                logger.warning(
                    "channel_provisioning_from_meta_resource_failed",
                    instance=instance_name,
                    resource_id=resource.id,
                    error=str(exc),
                )
        manager = self._connection_manager or get_connection_manager()
        instance = await manager.create(
            instance_name=instance_name,
            qrcode=False,
            token=credentials.access_token,
            phone_number_id=credentials.phone_number_id,
            business_id=credentials.business_account_id,
            connection_type="cloud",
        )
        return MetaSignupCompletion(
            credentials=credentials,
            instance=instance if isinstance(instance, dict) else {},
            resources=resources,
            channels=tuple(channels),
        )

    async def complete_embedded_signup(
        self,
        *,
        code: str,
        phone_number_id: str,
        business_account_id: str,
        session_info: dict[str, Any] | None = None,
    ) -> MetaCredentials:
        try:
            token = await self._platform.authenticate(code=code)
            return self._platform.credentials_from_embedded_signup(
                token=token,
                phone_number_id=phone_number_id,
                business_account_id=business_account_id,
                session_info=session_info,
            )
        except MetaPlatformError as exc:
            raise MetaSignupError(str(exc), status_code=exc.status_code, detail=exc.detail) from exc


def get_meta_signup_service() -> MetaSignupService:
    return MetaSignupService()
