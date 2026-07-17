from __future__ import annotations

import asyncio

import pytest

from app.adapters.evolution.adapter import EvolutionAdapter
from app.connections import (
    CloudConnectionStatus,
    CloudCredentials,
    ConnectionHealthStatus,
    ConnectionLifecycleState,
    ConnectionType,
    get_connection_manager,
)
from app.connections.cloud import CloudConnection
from app.connections.errors import ConnectionNotImplementedError
from app.models.requests import CreateInstanceRequest
from app.services.connection_health import ConnectionHealthService
from app.services.instances_contract import normalize_instance


def test_connection_manager_resolves_baileys_and_cloud() -> None:
    manager = get_connection_manager()

    assert manager.default().connection_type == ConnectionType.BAILEYS
    assert manager.get(ConnectionType.BAILEYS).connection_type == ConnectionType.BAILEYS
    assert manager.get("cloud").connection_type == ConnectionType.CLOUD


def test_baileys_connection_keeps_current_integration() -> None:
    baileys = get_connection_manager().get(ConnectionType.BAILEYS)

    assert baileys.evolution_integration == "WHATSAPP-BAILEYS"
    assert baileys.capabilities.supports_qr is True
    assert baileys.capabilities.supports_text_messages is True


def test_cloud_credentials_are_domain_only_and_do_not_expose_secret_values() -> None:
    credentials = CloudCredentials(
        phone_number_id="phone_123",
        business_account_id="waba_456",
        access_token_ref="secret://cloud/token",
        connection_metadata={"displayName": "Main WhatsApp"},
    )

    public = credentials.public_dict()

    assert credentials.is_configured is True
    assert public["hasAccessTokenRef"] is True
    assert "access_token" not in public
    assert "secret://cloud/token" not in str(public)


def test_cloud_connection_lifecycle_local_states() -> None:
    async def run() -> None:
        cloud = CloudConnection()

        created = await cloud.create("cloud_instance")
        assert created["status"] == CloudConnectionStatus.CREATED.value

        configured = cloud.configure(
            "cloud_instance",
            CloudCredentials(
                phone_number_id="phone_123",
                business_account_id="waba_456",
                access_token_ref="secret://cloud/token",
            ),
        )
        assert configured["status"] == CloudConnectionStatus.CONFIGURED.value

        status = await cloud.get_status("cloud_instance")
        assert status["status"] == CloudConnectionStatus.CONFIGURED.value

        disconnected = await cloud.disconnect("cloud_instance")
        assert disconnected["status"] == CloudConnectionStatus.DISCONNECTED.value

        deleted = await cloud.delete("cloud_instance")
        assert deleted["status"] == CloudConnectionStatus.DELETED.value

    asyncio.run(run())


def test_cloud_connection_meta_dependent_operations_are_explicitly_not_implemented() -> None:
    async def run() -> None:
        cloud = CloudConnection()
        await cloud.create("cloud_instance")

        with pytest.raises(ConnectionNotImplementedError) as exc:
            await cloud.connect("cloud_instance")

        assert exc.value.status_code == 501
        assert exc.value.operation == "connect"

    asyncio.run(run())


def test_cloud_connection_creates_evolution_instance_with_manual_credentials(monkeypatch) -> None:
    class FakeAdapter:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def create_instance(self, **kwargs) -> dict:
            self.calls.append(kwargs)
            return {
                "instanceName": kwargs["instance_name"],
                "integration": kwargs["integration"],
                "status": "open",
            }

    async def run() -> None:
        adapter = FakeAdapter()
        monkeypatch.setattr("app.adapters.evolution.get_evolution_adapter", lambda: adapter)

        cloud = CloudConnection()
        result = await cloud.create(
            "cloud_instance",
            qrcode=True,
            token="secret-token",
            phone_number_id="phone_123",
            business_id="waba_456",
        )

        assert adapter.calls == [
            {
                "instance_name": "cloud_instance",
                "qrcode": False,
                "token": "secret-token",
                "integration": "WHATSAPP-BUSINESS",
                "number": "phone_123",
                "business_id": "waba_456",
            }
        ]
        assert result["connectionType"] == "cloud"
        assert result["integration"] == "WHATSAPP-BUSINESS"

    asyncio.run(run())


def test_cloud_create_request_requires_manual_credentials() -> None:
    with pytest.raises(ValueError):
        CreateInstanceRequest(instance_name="cloud_instance", connection_type="cloud", token="token")

    request = CreateInstanceRequest(
        instance_name="cloud_instance",
        connection_type="cloud",
        qrcode=True,
        token="token",
        phone_number_id="phone_123",
        business_id="waba_456",
    )

    assert request.qrcode is False


def test_evolution_adapter_builds_whatsapp_business_create_payload() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def request(self, method: str, path: str, **kwargs) -> dict:
            self.calls.append({"method": method, "path": path, **kwargs})
            return kwargs["json"]

    async def run() -> None:
        client = FakeClient()
        adapter = EvolutionAdapter(client=client)

        result = await adapter.create_instance(
            instance_name="cloud_instance",
            qrcode=False,
            token="secret-token",
            integration="WHATSAPP-BUSINESS",
            number="phone_123",
            business_id="waba_456",
        )

        assert client.calls[0]["method"] == "POST"
        assert client.calls[0]["path"] == "/instance/create"
        assert result == {
            "instanceName": "cloud_instance",
            "integration": "WHATSAPP-BUSINESS",
            "qrcode": False,
            "token": "secret-token",
            "number": "phone_123",
            "businessId": "waba_456",
        }

    asyncio.run(run())


def test_normalize_instance_marks_whatsapp_business_as_cloud() -> None:
    normalized = normalize_instance(
        {
            "instanceName": "cloud_instance",
            "integration": "WHATSAPP-BUSINESS",
            "connectionStatus": "open",
            "number": "phone_123",
        }
    )

    assert normalized is not None
    assert normalized["connectionType"] == "cloud"
    assert normalized["integration"] == "WHATSAPP-BUSINESS"
    assert normalized["phone"] == "phone_123"
    assert normalized["lifecycleState"] == ConnectionLifecycleState.WARNING.value
    assert normalized["health"] == ConnectionHealthStatus.DEGRADED.value


def test_connection_health_service_marks_manual_cloud_ready_when_checks_pass() -> None:
    health = ConnectionHealthService().evaluate(
        {
            "instanceName": "cloud_instance",
            "integration": "WHATSAPP-BUSINESS",
            "status": "open",
            "lifecycleSignals": {
                "tokenConfigured": True,
            },
        },
        name="cloud_instance",
        status="open",
        connection_type="cloud",
        integration="WHATSAPP-BUSINESS",
    )

    assert health.lifecycle_state == ConnectionLifecycleState.CONNECTED
    assert health.health == ConnectionHealthStatus.HEALTHY
    assert health.diagnostics == ()


def test_connection_health_service_does_not_manage_cloud_runtime_states() -> None:
    health = ConnectionHealthService().evaluate(
        {
            "instanceName": "cloud_instance",
            "integration": "WHATSAPP-BUSINESS",
            "status": "open",
            "lifecycleSignals": {
                "tokenConfigured": True,
                "tokenExpired": True,
                "webhookInvalid": True,
                "permissionsInsufficient": True,
            },
        },
        name="cloud_instance",
        status="open",
        connection_type="cloud",
        integration="WHATSAPP-BUSINESS",
    )

    assert health.lifecycle_state == ConnectionLifecycleState.CONNECTED
    assert health.health == ConnectionHealthStatus.HEALTHY
    assert health.diagnostics == ()
