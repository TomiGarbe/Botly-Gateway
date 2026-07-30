from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx

from app.platforms.meta import MetaPlatform
from app.services.meta.evolution import MetaEvolutionProvisioner
from app.services.meta.orchestrator import MetaOnboardingOrchestrator


def test_standard_onboarding_registers_once_and_exposes_ready_state(monkeypatch, tmp_path) -> None:
    calls: list[tuple[str, str]] = []
    subscription = {"configured": False}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        path = request.url.path
        if path.endswith("/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "secret-token"})
        if path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": {"is_valid": True, "app_id": "app_123", "scopes": ["whatsapp_business_management", "whatsapp_business_messaging"]}})
        if path.endswith("/waba_456/phone_numbers"):
            return httpx.Response(200, json={"data": [{"id": "phone_123", "display_phone_number": "+549111111111", "verified_name": "Acme"}]})
        if path.endswith("/waba_456/subscribed_apps"):
            if request.method == "GET":
                data = [{"id": "app_123", "override_callback_uri": "https://gateway.example.test/webhooks/meta"}] if subscription["configured"] else []
                return httpx.Response(200, json={"data": data})
            subscription["configured"] = True
            return httpx.Response(200, json={"success": True})
        if path.endswith("/waba_456"):
            return httpx.Response(200, json={"id": "waba_456", "name": "Acme WABA"})
        if path.endswith("/phone_123/register"):
            payload = json.loads(request.content)
            assert set(payload) == {"messaging_product", "pin"}
            assert payload["messaging_product"] == "whatsapp"
            assert isinstance(payload["pin"], str) and payload["pin"].isdigit() and len(payload["pin"]) == 6
            return httpx.Response(200, json={"success": True})
        if path.endswith("/phone_123"):
            return httpx.Response(200, json={"id": "phone_123", "verified_name": "Acme", "platform_type": "CLOUD_API"})
        if path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": []})
        return httpx.Response(404, json={"error": {"message": "not found"}})

    class Manager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def create(self, **kwargs):
            self.calls.append(kwargs)
            return {"instanceName": kwargs["instance_name"], "integration": "WHATSAPP-BUSINESS", "status": "open"}

    settings = SimpleNamespace(
        meta_app_id="app_123",
        meta_app_secret="app-secret",
        meta_embedded_signup_config_id="config_123",
        meta_graph_version="v23.0",
        meta_signup_timeout_seconds=30,
        public_app_url="https://gateway.example.test",
        meta_webhook_verify_token="verify-token",
        meta_onboarding_path=str(tmp_path / "onboarding.json"),
        official_credentials_path=str(tmp_path / "credentials.json"),
        official_credentials_encryption_key="encryption-key",
        meta_resources_path=str(tmp_path / "resources.json"),
        channel_records_path=str(tmp_path / "channels.json"),
    )
    for target in (
        "app.services.meta.orchestrator.get_settings",
        "app.services.meta.verification.get_settings",
        "app.services.meta.subscriptions.get_settings",
        "app.services.meta.state_store.get_settings",
        "app.services.credential_manager.get_settings",
        "app.platforms.meta.resource_store.get_settings",
        "app.domain.channel_store.get_settings",
    ):
        monkeypatch.setattr(target, lambda: settings)

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://graph.facebook.com/v23.0")
        manager = Manager()
        orchestrator = MetaOnboardingOrchestrator(
            platform=MetaPlatform(client=client, settings_factory=lambda: settings),
            evolution=MetaEvolutionProvisioner(manager),
        )
        first = await orchestrator.run(
            instance_name="standard_instance",
            code="oauth-code",
            phone_number_id="phone_123",
            business_account_id="waba_456",
            session_info={"event": "FINISH"},
        )
        second = await orchestrator.run(
            instance_name="standard_instance",
            code="new-oauth-code",
            phone_number_id="phone_123",
            business_account_id="waba_456",
            session_info={"event": "FINISH"},
        )
        await client.aclose()

        assert first.record.public_dict()["status"] == "READY"
        assert second.record.public_dict()["steps"] == {
            "oauth": True, "token": True, "discovery": True, "subscription": True,
            "phone": True, "webhook": True, "evolution": True, "credentials": True,
        }
        assert calls.count(("POST", "/v23.0/waba_456/subscribed_apps")) == 1
        assert calls.count(("POST", "/v23.0/phone_123/register")) == 1
        assert len(manager.calls) == 1
        stored_credentials = (tmp_path / "credentials.json").read_text(encoding="utf-8")
        assert "secret-token" not in stored_credentials
        assert '"registrationPinCiphertext"' in stored_credentials
        assert '"pin"' not in stored_credentials

    asyncio.run(run())
