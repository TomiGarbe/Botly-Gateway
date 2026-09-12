from __future__ import annotations

import asyncio
import hashlib
from types import SimpleNamespace

import httpx
import pytest

import app.platforms.meta.platform as meta_platform_module

from app.platforms.meta import (
    MetaCredentials,
    MetaDiscoveryService,
    MetaPlatform,
    MetaPlatformError,
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


def test_meta_platform_retries_oauth_190_with_the_graph_query_token_format() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.headers.get("Authorization"):
            assert request.url.params.get("appsecret_proof")
            return httpx.Response(401, json={"error": {"message": "Invalid OAuth access token", "code": 190}})
        assert request.url.params.get("access_token") == "embedded-signup-token"
        assert request.url.params.get("appsecret_proof")
        return httpx.Response(200, json={"data": []})

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://graph.facebook.com/v23.0")
        platform = MetaPlatform(client=client, settings_factory=lambda: _settings())
        result = await platform.request("GET", "/waba/phone_numbers", headers={"Authorization": "Bearer embedded-signup-token"})
        await client.aclose()

        assert result == {"data": []}
        assert len(requests) == 2
        assert requests[1].headers.get("Authorization") is None

    asyncio.run(run())


def test_meta_platform_logs_safe_token_correlation_and_retry_metadata(monkeypatch) -> None:
    access_token = "access-token-that-must-never-appear-in-logs"
    oauth_code = "oauth-code-that-must-never-appear-in-logs"
    app_secret = "application-secret-that-must-never-appear-in-logs"
    app_token = "app_123|app-token-that-must-never-appear-in-logs"
    records: list[tuple[str, str, dict]] = []

    class CapturingLogger:
        def info(self, event: str, **kwargs) -> None:
            records.append(("info", event, kwargs))

        def warning(self, event: str, **kwargs) -> None:
            records.append(("warning", event, kwargs))

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth/access_token"):
            return httpx.Response(200, json={"access_token": access_token, "token_type": "bearer"})
        if request.url.path.endswith("/debug_token"):
            assert request.url.params["input_token"] == access_token
            return httpx.Response(200, json={"data": {"is_valid": True}})
        if request.url.path.endswith("/waba/phone_numbers"):
            if request.headers.get("Authorization"):
                return httpx.Response(
                    401,
                    json={"error": {"message": "Invalid OAuth token", "type": "OAuthException", "code": 190, "fbtrace_id": "FIRST"}},
                )
            assert request.url.params["access_token"] == access_token
            return httpx.Response(
                400,
                json={"error": {"message": "Cannot parse access token", "type": "OAuthException", "code": 190, "fbtrace_id": "SECOND"}},
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    monkeypatch.setattr(meta_platform_module, "logger", CapturingLogger())

    async def run() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://graph.facebook.com/v23.0",
        )
        platform = MetaPlatform(client=client, settings_factory=lambda: _settings(meta_app_secret=app_secret))
        token = await platform.authenticate(code=oauth_code)
        await platform.request("GET", "/debug_token", params={"input_token": token.access_token, "access_token": app_token})
        with pytest.raises(MetaPlatformError) as error:
            await platform.request("GET", "/waba/phone_numbers", headers={"Authorization": f"Bearer {token.access_token}"})
        await client.aclose()

        assert error.value.status_code == 400

    asyncio.run(run())

    token_hash = hashlib.sha256(access_token.encode("utf-8")).hexdigest()
    oauth_record = next(record for record in records if record[1] == "meta_oauth_access_token_received")
    assert oauth_record[2] == {
        "access_token_present": True,
        "access_token_length": len(access_token),
        "access_token_sha256": token_hash,
    }

    graph_records = [record for record in records if record[1] == "meta_graph_request"]
    debug_record = next(record for record in graph_records if record[2]["path"] == "/debug_token")
    phone_records = [record for record in graph_records if record[2]["path"] == "/waba/phone_numbers"]
    assert debug_record[2]["token_transport"] == "debug_input_token"
    assert debug_record[2]["access_token_sha256"] == token_hash
    assert [(record[2]["attempt"], record[2]["status"]) for record in phone_records] == [(1, 401), (2, 400)]
    assert [record[2]["access_token_sha256"] for record in phone_records] == [token_hash, token_hash]
    assert [record[2]["token_transport"] for record in phone_records] == ["authorization_bearer", "query_access_token"]
    assert phone_records[0][2]["retry_triggered"] is True
    assert phone_records[0][2]["meta_fbtrace_id"] == "FIRST"
    assert phone_records[1][2]["meta_error_code"] == 190
    assert phone_records[1][2]["meta_error_type"] == "OAuthException"
    assert phone_records[1][2]["meta_fbtrace_id"] == "SECOND"

    retry_record = next(record for record in records if record[1] == "meta_graph_retry")
    assert retry_record[2]["retry_reason"] == "oauth_error_190_with_bearer"
    assert retry_record[2]["token_transport_from"] == "authorization_bearer"
    assert retry_record[2]["token_transport_to"] == "query_access_token"
    assert retry_record[2]["access_token_sha256"] == token_hash

    captured_log_data = str(records)
    for secret in (access_token, oauth_code, app_secret, app_token, "Authorization"):
        assert secret not in captured_log_data
    assert MetaPlatform._safe_log_path(f"/waba/phone_numbers?access_token={access_token}") == "/waba/phone_numbers"


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
