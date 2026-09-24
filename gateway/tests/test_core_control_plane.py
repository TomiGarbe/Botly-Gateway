import json
from types import SimpleNamespace

import asyncio
import httpx
import pytest
from pydantic import ValidationError

from app.models.requests import CoreChannelBindingRequest
from app.services.core_control_plane import CoreControlPlaneClient, CoreControlPlaneError


def _settings(**changes):
    values = {
        "core_control_plane_url": "https://core.test/api/v1/control-plane/gateway",
        "gateway_control_plane_api_key": "gateway-control-plane-secret",
        "core_control_plane_timeout_seconds": 3,
    }
    values.update(changes)
    return SimpleNamespace(**values)


def test_discovery_sends_service_auth_and_returns_safe_metadata() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"items": [{"id": "channel-a", "name": "Instagram", "channel_type": "instagram", "status": "active"}]})

    client = CoreControlPlaneClient(
        settings_factory=lambda: _settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://core.test/api/v1/control-plane/gateway"),
    )
    channels = asyncio.run(client.discover_channels(gateway_client_id="client-a", channel_type="instagram"))

    assert [item.public_dict() for item in channels] == [{"id": "channel-a", "name": "Instagram", "channel_type": "instagram", "status": "active"}]
    assert captured[0].headers["authorization"] == "Bearer gateway-control-plane-secret"
    assert captured[0].headers["x-botly-gateway-client-id"] == "client-a"
    assert captured[0].url.path == "/api/v1/control-plane/gateway/channels"
    assert captured[0].url.params["channel_type"] == "instagram"


def test_binding_keeps_dispatch_credential_in_server_client_only() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/bindings")
        assert json.loads(request.content) == {
            "gateway_connection_id": "connection-a",
            "core_channel_id": "channel-a",
            "channel_type": "instagram",
        }
        return httpx.Response(200, json={
            "binding": {"id": "binding-a"},
            "channel": {"id": "channel-a", "name": "Instagram", "channel_type": "instagram", "status": "active"},
            "dispatch_credential": "core-channel-credential",
        })

    client = CoreControlPlaneClient(
        settings_factory=lambda: _settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://core.test/api/v1/control-plane/gateway"),
    )
    result = asyncio.run(client.bind(gateway_client_id="client-a", gateway_connection_id="connection-a", core_channel_id="channel-a", channel_type="instagram"))

    assert result.id == "binding-a"
    assert result.channel.public_dict()["name"] == "Instagram"
    assert result.dispatch_credential == "core-channel-credential"


@pytest.mark.parametrize("status", [401, 403, 404, 409, 503])
def test_core_errors_are_safe_and_preserve_status(status: int) -> None:
    client = CoreControlPlaneClient(
        settings_factory=lambda: _settings(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(status)), base_url="https://core.test/api/v1/control-plane/gateway"),
    )
    with pytest.raises(CoreControlPlaneError) as exc:
        asyncio.run(client.discover_channels(gateway_client_id="client-a", channel_type="instagram"))
    assert exc.value.status_code == status
    assert "gateway-control-plane-secret" not in str(exc.value)


def test_control_plane_requires_dedicated_configuration() -> None:
    client = CoreControlPlaneClient(settings_factory=lambda: _settings(gateway_control_plane_api_key=""))
    with pytest.raises(CoreControlPlaneError) as exc:
        asyncio.run(client.discover_channels(gateway_client_id="client-a", channel_type="instagram"))
    assert exc.value.status_code == 503


def test_public_binding_contract_rejects_a_browser_supplied_credential() -> None:
    with pytest.raises(ValidationError):
        CoreChannelBindingRequest.model_validate({"core_channel_id": "channel-a", "channel_api_key": "must-not-be-accepted"})
