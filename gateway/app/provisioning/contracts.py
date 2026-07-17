from __future__ import annotations

from typing import Protocol

from app.connections.types import ConnectionType
from app.provisioning.models import InstanceProvisioningResult, ProvisioningRequest, SignupResult, SignupSession


class SignupProvider(Protocol):
    @property
    def provider_name(self) -> str:
        ...

    @property
    def connection_type(self) -> ConnectionType:
        ...

    async def start(self, request: ProvisioningRequest) -> SignupSession:
        ...

    async def complete(self, session_id: str, payload: dict) -> SignupResult:
        ...


class InstanceProvisioner(Protocol):
    @property
    def connection_type(self) -> ConnectionType:
        ...

    async def provision_instance(self, request: ProvisioningRequest) -> InstanceProvisioningResult:
        ...
