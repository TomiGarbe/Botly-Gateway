"""Backward-compatible facade for callers that used MetaSignupService.

All onboarding work belongs to app.services.meta.MetaOnboardingOrchestrator.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.domain import ChannelProvisioningService
from app.core.config import get_settings
from app.platforms.meta import MetaCredentials, MetaPlatform, MetaPlatformError, MetaResource
from app.services.meta.evolution import MetaEvolutionProvisioner
from app.services.meta.orchestrator import MetaOnboardingOrchestrator


class MetaSignupError(MetaPlatformError):
    pass


@dataclass(frozen=True)
class MetaSignupCompletion:
    credentials: MetaCredentials
    instance: dict[str, Any]
    resources: tuple[MetaResource, ...] = ()
    channels: tuple[Any, ...] = ()


class MetaSignupService:
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        connection_manager: Any | None = None,
        platform: MetaPlatform | None = None,
        channel_provisioning: ChannelProvisioningService | None = None,
    ) -> None:
        resolved_platform = platform or MetaPlatform(client=client, settings_factory=get_settings)
        self._orchestrator = MetaOnboardingOrchestrator(
            platform=resolved_platform,
            evolution=MetaEvolutionProvisioner(connection_manager),
            channel_provisioning=channel_provisioning,
        )

    def public_config(self) -> dict[str, Any]:
        return self._orchestrator.public_config()

    async def complete_onboarding(self, **kwargs: Any) -> MetaSignupCompletion:
        try:
            result = await self._orchestrator.run(**kwargs)
        except MetaPlatformError as exc:
            raise MetaSignupError(str(exc), status_code=exc.status_code, detail=exc.detail) from exc
        return MetaSignupCompletion(
            credentials=result.credentials,
            instance=result.instance,
            resources=tuple(result.resources),
            channels=tuple(result.channels),
        )


def get_meta_signup_service() -> MetaSignupService:
    return MetaSignupService()
