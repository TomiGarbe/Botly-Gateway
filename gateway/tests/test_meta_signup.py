from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx

from app.platforms.meta.resource_store import MetaResourceStore
from app.services.meta_signup import MetaSignupService


def test_meta_signup_service_exchanges_code_creates_evolution_instance_discovers_resources_and_hides_token(monkeypatch, tmp_path) -> None:
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        if request.url.path.endswith("/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "secret-token", "token_type": "bearer", "expires_in": 3600})
        if request.url.path.endswith("/waba_456"):
            return httpx.Response(200, json={"id": "waba_456", "name": "Acme WABA"})
        if request.url.path.endswith("/waba_456/phone_numbers"):
            return httpx.Response(200, json={"data": [{"id": "phone_123", "verified_name": "Acme Support"}]})
        if request.url.path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": []})
        return httpx.Response(404, json={"error": {"message": "not found"}})

    class FakeConnectionManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def create(self, **kwargs) -> dict:
            self.calls.append(kwargs)
            return {
                "instanceName": kwargs["instance_name"],
                "integration": "WHATSAPP-BUSINESS",
                "status": "open",
            }

    settings = SimpleNamespace(
        meta_app_id="app_123",
        meta_app_secret="secret",
        meta_embedded_signup_config_id="config_123",
        meta_graph_version="v23.0",
        meta_signup_timeout_seconds=30,
        meta_resources_path=str(tmp_path / "meta_resources.json"),
        channel_records_path=str(tmp_path / "channels.json"),
    )
    monkeypatch.setattr(
        "app.services.meta_signup.get_settings",
        lambda: settings,
    )
    monkeypatch.setattr(
        "app.platforms.meta.resource_store.get_settings",
        lambda: settings,
    )
    monkeypatch.setattr(
        "app.domain.channel_store.get_settings",
        lambda: settings,
    )

    async def run() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://graph.facebook.com/v23.0",
        )
        manager = FakeConnectionManager()
        service = MetaSignupService(client=client, connection_manager=manager)
        completion = await service.complete_onboarding(
            instance_name="cloud_instance",
            code="oauth-code",
            phone_number_id="phone_123",
            business_account_id="waba_456",
            session_info={"event": "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"},
        )
        await client.aclose()

        credentials = completion.credentials
        public = credentials.public_dict()
        assert credentials.access_token == "secret-token"
        assert public["phoneNumberId"] == "phone_123"
        assert public["businessAccountId"] == "waba_456"
        assert "coexistence" not in public
        assert "secret-token" not in str(public)
        assert requests == [
            ("GET", "/v23.0/oauth/access_token"),
            ("GET", "/v23.0/waba_456"),
            ("GET", "/v23.0/waba_456/phone_numbers"),
            ("GET", "/v23.0/me/accounts"),
        ]
        assert manager.calls == [
            {
                "instance_name": "cloud_instance",
                "qrcode": False,
                "token": "secret-token",
                "phone_number_id": "phone_123",
                "business_id": "waba_456",
                "connection_type": "cloud",
            }
        ]
        assert completion.instance["instanceName"] == "cloud_instance"
        assert len(completion.resources) == 1
        assert len(completion.channels) == 1
        assert completion.channels[0].integration_id == "whatsapp.official.evolution"
        stored = MetaResourceStore(path_factory=lambda: settings.meta_resources_path).list(scope_id="waba_456")
        assert len(stored) == 1
        assert stored[0].display_name == "Acme Support"

    asyncio.run(run())
