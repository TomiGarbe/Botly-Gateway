"""Contract smoke test for one complete WhatsApp Official first connection.

Run on its own with:
    python -m pytest -q tests/test_first_connection_smoke.py

External Meta and Evolution calls are represented by their HTTP/provider
contracts, so the test is deterministic and contains no live credentials.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.platforms.meta import MetaPlatform
from app.providers.whatsapp_official import OfficialWhatsAppProvider
from app.routers import meta_webhook
from app.routers.messages import _persist_local_outbound_event
from app.services import credential_manager
from app.services.meta.evolution import MetaEvolutionProvisioner
from app.services.meta.models import MetaOnboardingRecord, MetaOnboardingState, OnboardingType
from app.services.meta.orchestrator import MetaOnboardingOrchestrator
from app.services.meta.state_store import MetaOnboardingStore
from app.services import normalization
from app.services.normalization import list_events


def test_first_connection_onboarding_send_receive_and_persistence(monkeypatch, tmp_path) -> None:
    """Exercise the complete Gateway-owned path with signed Cloud webhook input."""
    settings = SimpleNamespace(
        gateway_api_key="gateway-test-key",
        meta_app_id="app_123",
        meta_app_secret="app-secret",
        meta_embedded_signup_config_id="config_123",
        meta_graph_version="v23.0",
        meta_signup_timeout_seconds=30,
        public_app_url="https://gateway.example.test",
        meta_webhook_verify_token="verify-token",
        meta_webhook_require_signature=True,
        bot_webhook_max_queue=200,
        meta_onboarding_path=str(tmp_path / "onboarding.json"),
        official_credentials_path=str(tmp_path / "credentials.json"),
        official_credentials_encryption_key="test-encryption-key",
        webhook_events_path=str(tmp_path / "events.json"),
        meta_resources_path=str(tmp_path / "resources.json"),
        channel_records_path=str(tmp_path / "channels.json"),
    )
    for target in (
        "app.services.meta.orchestrator.get_settings",
        "app.services.meta.verification.get_settings",
        "app.services.meta.subscriptions.get_settings",
        "app.services.meta.state_store.get_settings",
        "app.services.credential_manager.get_settings",
        "app.services.normalization.get_settings",
        "app.platforms.meta.resource_store.get_settings",
        "app.domain.channel_store.get_settings",
    ):
        monkeypatch.setattr(target, lambda: settings)
    monkeypatch.setattr(normalization, "get_settings", lambda: settings)
    monkeypatch.setattr(meta_webhook, "get_settings", lambda: settings)
    # Isolate the smoke from the persisted development timeline restored when
    # the module was imported.
    normalization._business_events.clear()
    normalization._business_event_keys.clear()
    normalization._business_event_keys_order.clear()

    graph_calls: list[tuple[str, str]] = []
    subscription = {"configured": False}

    def graph_handler(request: httpx.Request) -> httpx.Response:
        graph_calls.append((request.method, request.url.path))
        path = request.url.path
        if path.endswith("/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "smoke-access-token"})
        if path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": {"is_valid": True, "app_id": "app_123", "scopes": ["whatsapp_business_management", "whatsapp_business_messaging"]}})
        if path.endswith("/waba_456/phone_numbers"):
            return httpx.Response(200, json={"data": [{"id": "phone_123", "display_phone_number": "+549111111111", "platform_type": "CLOUD_API"}]})
        if path.endswith("/waba_456/subscribed_apps"):
            if request.method == "GET":
                data = [{"id": "app_123", "override_callback_uri": "https://gateway.example.test/webhooks/meta"}] if subscription["configured"] else []
                return httpx.Response(200, json={"data": data})
            assert json.loads(request.content) == {
                "override_callback_uri": "https://gateway.example.test/webhooks/meta",
                "verify_token": "verify-token",
            }
            subscription["configured"] = True
            return httpx.Response(200, json={"success": True})
        if path.endswith("/waba_456"):
            return httpx.Response(200, json={"id": "waba_456", "name": "Smoke WABA"})
        if path.endswith("/phone_123/register"):
            return httpx.Response(200, json={"success": True})
        if path.endswith("/phone_123"):
            return httpx.Response(200, json={"id": "phone_123", "platform_type": "CLOUD_API"})
        if path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": []})
        return httpx.Response(404, json={"error": {"message": "unexpected Graph request"}})

    class Evolution:
        async def create(self, **kwargs):
            assert kwargs["connection_type"] == "cloud"
            assert kwargs["phone_number_id"] == "phone_123"
            return {"instanceName": kwargs["instance_name"], "integration": "WHATSAPP-BUSINESS", "status": "open"}

    class OutboundPlatform:
        async def request(self, method: str, path: str, **kwargs):
            assert (method, path) == ("POST", "/phone_123/messages")
            assert kwargs["json"]["text"]["body"] == "mensaje smoke"
            return {"messages": [{"id": "wamid.smoke.outbound"}]}

    async def run_onboarding_and_send() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(graph_handler), base_url="https://graph.facebook.com/v23.0")
        orchestrator = MetaOnboardingOrchestrator(
            platform=MetaPlatform(client=client, settings_factory=lambda: settings),
            evolution=MetaEvolutionProvisioner(Evolution()),
        )
        completed = await orchestrator.run(
            instance_name="smoke_cloud",
            code="embedded-signup-code",
            phone_number_id="phone_123",
            business_account_id="waba_456",
        )
        assert completed.record.public_dict()["status"] == "READY"
        assert all(completed.record.public_dict()["steps"].values())
        assert credential_manager.get_credential_manager().get_official_credentials_info("smoke_cloud") is not None

        outbound = await OfficialWhatsAppProvider(
            credentials=credential_manager.get_credential_manager(),
            platform=OutboundPlatform(),
        ).send_text(instance_name="smoke_cloud", number="5491100000000", text="mensaje smoke")
        _persist_local_outbound_event(
            instance_name="smoke_cloud",
            number="5491100000000",
            msg_type="text",
            text="mensaje smoke",
            evolution_result=outbound,
        )
        await client.aclose()

    asyncio.run(run_onboarding_and_send())
    assert ("POST", "/v23.0/waba_456/subscribed_apps") in graph_calls
    assert ("POST", "/v23.0/phone_123/register") in graph_calls

    now = str(int(time.time()))
    inbound = {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"field": "messages", "value": {
            "metadata": {"phone_number_id": "phone_123"},
            "contacts": [{"wa_id": "5491100000000", "profile": {"name": "Smoke User"}}],
            "messages": [{"from": "5491100000000", "id": "wamid.smoke.inbound", "timestamp": now, "type": "text", "text": {"body": "respuesta smoke"}}],
        }}]}],
    }
    body = json.dumps(inbound).encode("utf-8")
    signature = "sha256=" + hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()
    response = TestClient(app).post("/webhooks/meta", content=body, headers={"X-Hub-Signature-256": signature})

    assert response.status_code == 200
    assert response.json()["messages"] == 1
    timeline = list_events(instance="smoke_cloud", limit=100)
    outbound = next(item for item in timeline if (item.get("message") or {}).get("id") == "wamid.smoke.outbound")
    received = next(item for item in timeline if (item.get("message") or {}).get("id") == "wamid.smoke.inbound")
    assert outbound["direction"] == "outbound"
    assert received["direction"] == "inbound"
    assert received["text"] == "respuesta smoke"
    assert received["meta"]["conversationId"] == "smoke_cloud::5491100000000@s.whatsapp.net"
    persisted_timeline = json.loads((tmp_path / "events.json").read_text(encoding="utf-8"))["items"]
    assert {"wamid.smoke.outbound", "wamid.smoke.inbound"}.issubset(
        {(item.get("message") or {}).get("id") for item in persisted_timeline}
    )


def test_ready_is_removed_and_reports_the_blocking_stage_after_a_failure(monkeypatch, tmp_path) -> None:
    settings = SimpleNamespace(meta_onboarding_path=str(tmp_path / "onboarding.json"))
    monkeypatch.setattr("app.services.meta.state_store.get_settings", lambda: settings)
    store = MetaOnboardingStore()
    record = MetaOnboardingRecord(instance_name="smoke_cloud", onboarding_type=OnboardingType.STANDARD)
    for state in MetaOnboardingState:
        store.advance(record, state)

    store.fail(record, code="phone_registration_failed", message="Meta rechazo el numero")

    public = record.public_dict()
    assert public["status"] == "INCOMPLETE"
    assert public["blockingStage"] == "phone_registration"
    assert public["errors"][-1]["action"]
