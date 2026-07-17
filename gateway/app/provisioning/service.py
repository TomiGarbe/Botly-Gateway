from __future__ import annotations

from uuid import uuid4

from app.connections.types import ConnectionType
from app.provisioning.contracts import InstanceProvisioner, SignupProvider
from app.provisioning.models import ProvisioningRecord, ProvisioningRequest, ProvisioningResult
from app.provisioning.types import ProvisioningState


class ProvisioningService:
    def __init__(
        self,
        *,
        instance_provisioners: list[InstanceProvisioner],
        signup_providers: list[SignupProvider] | None = None,
    ) -> None:
        self._instance_provisioners = {provisioner.connection_type: provisioner for provisioner in instance_provisioners}
        self._signup_providers = {
            (provider.connection_type, provider.provider_name): provider for provider in (signup_providers or [])
        }
        self._records: dict[str, ProvisioningRecord] = {}

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
