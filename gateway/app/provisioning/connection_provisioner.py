from __future__ import annotations

from app.connections.base import Connection
from app.connections.types import ConnectionType
from app.provisioning.models import InstanceProvisioningResult, ProvisioningRequest


class ConnectionInstanceProvisioner:
    def __init__(self, connection: Connection) -> None:
        self._connection = connection

    @property
    def connection_type(self) -> ConnectionType:
        return self._connection.connection_type

    async def provision_instance(self, request: ProvisioningRequest) -> InstanceProvisioningResult:
        instance = await self._connection.create(
            request.instance_name,
            qrcode=request.qrcode,
            token=request.token,
            phone_number_id=request.phone_number_id,
            business_id=request.business_id,
        )
        return InstanceProvisioningResult(instance=instance, external_id=request.instance_name)
