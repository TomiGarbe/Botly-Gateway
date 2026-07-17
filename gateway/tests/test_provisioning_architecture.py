from __future__ import annotations

import asyncio

from app.connections.types import ConnectionType
from app.provisioning import (
    InstanceProvisioningResult,
    ProvisioningRequest,
    ProvisioningService,
    ProvisioningState,
    SignupResult,
    SignupSession,
)


class FakeInstanceProvisioner:
    connection_type = ConnectionType.BAILEYS

    def __init__(self) -> None:
        self.requests: list[ProvisioningRequest] = []

    async def provision_instance(self, request: ProvisioningRequest) -> InstanceProvisioningResult:
        self.requests.append(request)
        return InstanceProvisioningResult(
            instance={"id": request.instance_name, "name": request.instance_name, "status": "connecting"},
            external_id=f"physical:{request.instance_name}",
        )


class FakeSignupProvider:
    provider_name = "fake-signup"
    connection_type = ConnectionType.CLOUD

    async def start(self, request: ProvisioningRequest) -> SignupSession:
        return SignupSession(
            id=f"signup:{request.instance_name}",
            provider=self.provider_name,
            connection_type=request.connection_type,
            public_payload={"next": "collect_cloud_credentials"},
        )

    async def complete(self, session_id: str, payload: dict) -> SignupResult:
        return SignupResult(
            provider=self.provider_name,
            connection_type=self.connection_type,
            configuration=dict(payload),
        )


def test_provisioning_service_creates_physical_instance_through_abstraction() -> None:
    async def run() -> None:
        provisioner = FakeInstanceProvisioner()
        service = ProvisioningService(instance_provisioners=[provisioner])

        result = await service.provision_connection(
            ProvisioningRequest(
                instance_name="botly",
                connection_type=ConnectionType.BAILEYS,
                qrcode=True,
                token="instance-token",
            )
        )

        assert result.is_ready is True
        assert result.record.state == ProvisioningState.READY
        assert result.instance == {"id": "botly", "name": "botly", "status": "connecting"}
        assert result.record.metadata["externalId"] == "physical:botly"
        assert provisioner.requests[0].token == "instance-token"

    asyncio.run(run())


def test_provisioning_can_wait_for_configuration_without_creating_instance() -> None:
    async def run() -> None:
        service = ProvisioningService(instance_provisioners=[FakeInstanceProvisioner()])

        result = await service.provision_connection(
            ProvisioningRequest(
                instance_name="cloud_main",
                connection_type=ConnectionType.CLOUD,
                requires_signup=True,
            )
        )

        assert result.record.state == ProvisioningState.WAITING_CONFIGURATION
        assert result.instance is None
        assert result.signup is None

    asyncio.run(run())


def test_signup_provider_contract_is_separate_from_instance_provisioner() -> None:
    async def run() -> None:
        service = ProvisioningService(
            instance_provisioners=[FakeInstanceProvisioner()],
            signup_providers=[FakeSignupProvider()],
        )

        result = await service.provision_connection(
            ProvisioningRequest(
                instance_name="cloud_main",
                connection_type=ConnectionType.CLOUD,
                requires_signup=True,
                signup_provider="fake-signup",
            )
        )

        assert result.record.state == ProvisioningState.WAITING_CONFIGURATION
        assert result.signup is not None
        assert result.signup.provider == "fake-signup"
        assert result.signup.public_payload == {"next": "collect_cloud_credentials"}
        assert result.instance is None

    asyncio.run(run())


def test_provisioning_state_is_not_connection_state() -> None:
    async def run() -> None:
        service = ProvisioningService(instance_provisioners=[FakeInstanceProvisioner()])

        result = await service.provision_connection(
            ProvisioningRequest(instance_name="botly", connection_type=ConnectionType.BAILEYS)
        )

        assert result.record.state == ProvisioningState.READY
        assert result.instance is not None
        assert result.instance["status"] == "connecting"

    asyncio.run(run())
