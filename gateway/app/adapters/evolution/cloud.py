from __future__ import annotations

from app.adapters.evolution.errors import EvolutionError
from app.adapters.evolution.transports import CLOUD_TRANSPORT_PROFILE, EvolutionTransportProfile


class CloudEvolutionAdapter:
    transport_profile: EvolutionTransportProfile = CLOUD_TRANSPORT_PROFILE

    def _not_implemented(self, operation: str) -> EvolutionError:
        return EvolutionError(
            message=f"Evolution Cloud operation '{operation}' is not implemented yet.",
            status_code=501,
            retryable=False,
        )

    async def create_instance(self, *args, **kwargs) -> dict:
        raise self._not_implemented("create_instance")

    async def connect_instance(self, *args, **kwargs) -> dict:
        raise self._not_implemented("connect_instance")

    async def disconnect_instance(self, *args, **kwargs) -> dict:
        raise self._not_implemented("disconnect_instance")

    async def delete_instance(self, *args, **kwargs) -> dict:
        raise self._not_implemented("delete_instance")
