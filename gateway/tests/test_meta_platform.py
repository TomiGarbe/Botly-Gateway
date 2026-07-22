from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx

from app.platforms.meta import (
    MetaCredentials,
    MetaDiscoveryService,
    MetaPlatform,
    MetaResource,
    MetaResourceStatus,
    MetaResourceType,
)
from app.platforms.meta.resource_store import MetaResourceStore


def _settings(**overrides):
    defaults = {
        "meta_app_id": "app_123",
        "meta_app_secret": "secret",
        "meta_embedded_signup_config_id": "config_123",
        "meta_graph_version": "v23.0",
        "meta_signup_timeout_seconds": 30,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_meta_platform_public_config_represents_meta_not_whatsapp() -> None:
    platform = MetaPlatform(settings_factory=lambda: _settings(meta_app_secret=""))

    config = platform.public_config()
    health = platform.health()

    assert config["enabled"] is False
    assert config["app_id"] == "app_123"
    assert config["config_id"] == "config_123"
    assert config["missing"] == ["meta_app_secret"]
    assert health["platform"] == "meta"
    assert health["configured"] is False


def test_meta_platform_authenticate_exchanges_oauth_code_and_hides_token_publicly() -> None:
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        return httpx.Response(200, json={"access_token": "secret-token", "token_type": "bearer", "expires_in": 3600})

    async def run() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://graph.facebook.com/v23.0",
        )
        platform = MetaPlatform(client=client, settings_factory=lambda: _settings())

        token = await platform.authenticate(code="oauth-code")
        await client.aclose()

        assert token.access_token == "secret-token"
        assert token.public_dict()["hasAccessToken"] is True
        assert "secret-token" not in str(token.public_dict())
        assert requests == [("GET", "/v23.0/oauth/access_token")]

    asyncio.run(run())


def test_meta_platform_builds_embedded_signup_credentials() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "secret-token", "token_type": "bearer"})

    async def run_with_client() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://graph.facebook.com/v23.0",
        )
        platform = MetaPlatform(client=client, settings_factory=lambda: _settings())
        token = await platform.authenticate(code="oauth-code")
        credentials = platform.credentials_from_embedded_signup(
            token=token,
            phone_number_id="phone_123",
            business_account_id="waba_456",
            session_info={"event": "FINISH"},
        )
        await client.aclose()

        assert platform.validate_credentials(credentials) is True
        assert credentials.access_token_ref == "meta://waba/waba_456/phones/phone_123/token"
        assert credentials.public_dict()["phoneNumberId"] == "phone_123"
        assert "secret-token" not in str(credentials.public_dict())

    asyncio.run(run_with_client())


def test_meta_resource_model_is_channel_agnostic() -> None:
    resource = MetaResource.build(
        resource_type=MetaResourceType.WHATSAPP_BUSINESS,
        external_id="waba_456",
        display_name="Acme WABA",
        status=MetaResourceStatus.ACTIVE,
        metadata={"phoneNumberId": "phone_123"},
    )

    assert resource.public_dict() == {
        "id": "meta:WHATSAPP_BUSINESS:waba_456",
        "platformId": "meta",
        "resourceType": "WHATSAPP_BUSINESS",
        "type": "WHATSAPP_BUSINESS",
        "externalId": "waba_456",
        "displayName": "Acme WABA",
        "status": "ACTIVE",
        "metadata": {"phoneNumberId": "phone_123"},
    }


def test_meta_discovery_service_discovers_and_persists_available_resources(tmp_path) -> None:
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        if request.url.path.endswith("/waba_456"):
            return httpx.Response(200, json={"id": "waba_456", "name": "Acme WABA", "timezone_id": "1"})
        if request.url.path.endswith("/waba_456/phone_numbers"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "phone_123",
                            "display_phone_number": "+549111111111",
                            "verified_name": "Acme Support",
                            "name_status": "APPROVED",
                        }
                    ]
                },
            )
        if request.url.path.endswith("/me/accounts"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "page_1",
                            "name": "Acme Page",
                            "access_token": "page-secret",
                            "instagram_business_account": {
                                "id": "ig_1",
                                "username": "acme",
                            },
                        }
                    ]
                },
            )
        return httpx.Response(404, json={"error": {"message": "not found"}})

    async def run() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://graph.facebook.com/v23.0",
        )
        store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
        service = MetaDiscoveryService(
            platform=MetaPlatform(client=client, settings_factory=lambda: _settings()),
            store=store,
        )
        resources = await service.discover(
            credentials=MetaCredentials(
                access_token="secret-token",
                phone_number_id="phone_123",
                business_account_id="waba_456",
            )
        )
        await client.aclose()

        assert {resource.resource_type for resource in resources} == {
            MetaResourceType.WHATSAPP_BUSINESS,
            MetaResourceType.FACEBOOK_PAGE,
            MetaResourceType.MESSENGER,
            MetaResourceType.INSTAGRAM,
        }
        assert any(resource.display_name == "Acme Support" for resource in resources)
        assert "page-secret" not in str([resource.public_dict() for resource in resources])
        assert len(store.list(scope_id="waba_456")) == 4
        assert ("GET", "/v23.0/waba_456") in requests
        assert ("GET", "/v23.0/waba_456/phone_numbers") in requests
        assert ("GET", "/v23.0/me/accounts") in requests

    asyncio.run(run())


def test_meta_resource_store_marks_missing_resources_deleted(tmp_path) -> None:
    store = MetaResourceStore(path_factory=lambda: str(tmp_path / "meta_resources.json"))
    first = (
        MetaResource.build(
            resource_type=MetaResourceType.WHATSAPP_BUSINESS,
            external_id="waba_456",
            display_name="Acme WABA",
        ),
        MetaResource.build(
            resource_type=MetaResourceType.FACEBOOK_PAGE,
            external_id="page_1",
            display_name="Acme Page",
        ),
    )
    store.sync(resources=first, scope_id="waba_456")

    second = (
        MetaResource.build(
            resource_type=MetaResourceType.WHATSAPP_BUSINESS,
            external_id="waba_456",
            display_name="Acme WABA Renamed",
        ),
    )
    store.sync(resources=second, scope_id="waba_456")

    active = store.list(scope_id="waba_456")
    all_resources = store.list(scope_id="waba_456", include_deleted=True)

    assert [resource.external_id for resource in active] == ["waba_456"]
    deleted = [resource for resource in all_resources if resource.external_id == "page_1"][0]
    assert deleted.status == MetaResourceStatus.REMOVED
    assert deleted.deleted_at is not None
