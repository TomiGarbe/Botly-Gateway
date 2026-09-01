from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.adapters.evolution.adapter import EvolutionAdapter
from app.adapters.evolution.errors import EvolutionError
from app.services.evolution_webhook import ensure_evolution_webhook
from app.services.evolution_auth import validate_evolution_auth
from app.services.normalization import normalize_webhook


class _Client:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def request(self, method: str, path: str, **kwargs):
        self.calls.append({"method": method, "path": path, **kwargs})
        return {"success": True}


def test_configure_webhook_uses_evolution_v2_flat_contract() -> None:
    async def run() -> None:
        client = _Client()
        adapter = EvolutionAdapter(client=client)
        await adapter.configure_webhook(
            "botly_connection",
            "http://gateway:9000/webhooks/evolution",
            ["MESSAGES_UPSERT"],
            headers={"x-evolution-webhook-secret": "private"},
        )
        assert client.calls == [{
            "method": "POST",
            "path": "/webhook/set/botly_connection",
            "json": {
                "enabled": True,
                "url": "http://gateway:9000/webhooks/evolution",
                "events": ["MESSAGES_UPSERT"],
                "headers": {"x-evolution-webhook-secret": "private"},
                "base64": False,
            },
            "retries": 1,
        }]
    asyncio.run(run())


class _Runtime:
    def __init__(self, webhook: dict | None = None) -> None:
        self.webhook = webhook or {}
        self.set_calls: list[dict] = []

    async def get_webhook(self, _name: str, **_kwargs):
        return self.webhook

    async def set_webhook(self, name: str, url: str, events: list[str], **kwargs):
        self.set_calls.append({"name": name, "url": url, "events": events, **kwargs})
        self.webhook = {
            "enabled": True,
            "url": url,
            "events": events,
            "headers": kwargs.get("headers", {}),
        }


def test_ensure_webhook_repairs_then_verifies(monkeypatch) -> None:
    monkeypatch.setattr("app.services.evolution_webhook.get_settings", lambda: SimpleNamespace(gateway_port=9000, evolution_webhook_secret="secret"))
    runtime = _Runtime({"enabled": False, "url": "", "events": []})

    result = asyncio.run(ensure_evolution_webhook(runtime, "runtime-a"))

    assert result["enabled"] is True
    assert runtime.set_calls[0]["headers"] == {"x-evolution-webhook-secret": "secret"}


def test_ensure_webhook_rejects_remote_configuration_mismatch(monkeypatch) -> None:
    monkeypatch.setattr("app.services.evolution_webhook.get_settings", lambda: SimpleNamespace(gateway_port=9000, evolution_webhook_secret=""))

    class MismatchRuntime(_Runtime):
        async def set_webhook(self, *_args, **_kwargs):
            self.webhook = {"enabled": True, "url": "http://wrong", "events": []}

    with pytest.raises(EvolutionError, match="configuration mismatch"):
        asyncio.run(ensure_evolution_webhook(MismatchRuntime(), "runtime-a", force_configure=True))


def test_messages_upsert_normalizes_both_inbound_and_from_me_without_optional_fields() -> None:
    for from_me in (False, True):
        normalized = normalize_webhook({
            "event": "messages.upsert",
            "instance": "runtime-a",
            "data": {
                "key": {"id": f"message-{from_me}", "remoteJid": "5491100000000@s.whatsapp.net", "fromMe": from_me},
                "message": {"conversation": "hola"},
                "messageType": "conversation",
            },
        })
        assert normalized["layer"] == "business"
        assert normalized["message"]["fromMe"] is from_me
        assert normalized["message"]["from"] == "5491100000000@s.whatsapp.net"
        assert normalized["message"]["pushName"] is None


def test_explicit_webhook_secret_accepts_only_matching_credential(monkeypatch) -> None:
    from app.services import evolution_auth

    class Instances:
        async def list_instances(self):
            return []

    monkeypatch.setattr(evolution_auth, "_connection_manager", Instances())
    monkeypatch.setattr(evolution_auth, "get_settings", lambda: SimpleNamespace(
        evolution_api_key="global", evolution_webhook_secret="webhook-secret", evolution_auth_cache_ttl_seconds=45,
    ))
    evolution_auth._TOKEN_CACHE.update({"expiresAt": 0.0, "byInstance": {}})
    valid = asyncio.run(validate_evolution_auth({"instance": "runtime-a"}, "webhook-secret"))
    invalid = asyncio.run(validate_evolution_auth({"instance": "runtime-a"}, "global"))
    missing = asyncio.run(validate_evolution_auth({"instance": "runtime-a"}, ""))
    assert valid["accepted"] is True and valid["mode"] == "webhook_secret"
    assert invalid["accepted"] is False
    assert missing["accepted"] is False


def test_unknown_evolution_instance_is_rejected_after_authentication(monkeypatch) -> None:
    from app.routers import webhooks
    from app.services import evolution_auth

    class Instances:
        async def list_instances(self):
            return []

    class EmptyRegistry:
        def connection_record(self, _instance: str):
            return None

    test_settings = SimpleNamespace(
        evolution_api_key="global", evolution_webhook_secret="webhook-secret", evolution_auth_cache_ttl_seconds=45,
        allow_insecure_evolution_webhooks=False, bot_webhook_max_parallel=20, bot_webhook_max_queue=200,
    )
    monkeypatch.setattr(evolution_auth, "_connection_manager", Instances())
    monkeypatch.setattr(evolution_auth, "get_settings", lambda: test_settings)
    monkeypatch.setattr(webhooks, "settings", test_settings)
    monkeypatch.setattr(webhooks, "_connection_registry", EmptyRegistry())
    evolution_auth._TOKEN_CACHE.update({"expiresAt": 0.0, "byInstance": {}})

    app = FastAPI()
    app.include_router(webhooks.router)
    response = TestClient(app).post(
        "/webhooks/evolution",
        json={"instance": "unknown", "event": "MESSAGES_UPSERT", "data": {}},
        headers={"x-evolution-webhook-secret": "webhook-secret"},
    )
    assert response.status_code == 404


def test_known_evolution_instance_reaches_the_pipeline(monkeypatch) -> None:
    from app.routers import webhooks
    from app.services import evolution_auth

    class KnownRegistry:
        def connection_record(self, instance: str):
            assert instance == "runtime-a"
            return {"id": "connection-a", "client_id": "business-a", "channel_id": "whatsapp"}

    test_settings = SimpleNamespace(
        evolution_api_key="global", evolution_webhook_secret="webhook-secret", evolution_auth_cache_ttl_seconds=45,
        allow_insecure_evolution_webhooks=False, bot_webhook_max_parallel=20, bot_webhook_max_queue=200,
    )
    monkeypatch.setattr(evolution_auth, "get_settings", lambda: test_settings)
    monkeypatch.setattr(webhooks, "settings", test_settings)
    monkeypatch.setattr(webhooks, "_connection_registry", KnownRegistry())
    monkeypatch.setattr(
        webhooks,
        "process_incoming_webhook",
        lambda payload, _request_id: {"status": "ignored_technical", "normalized": {"event": payload["event"]}},
    )

    app = FastAPI()
    app.include_router(webhooks.router)
    response = TestClient(app).post(
        "/webhooks/evolution",
        json={"instance": "runtime-a", "event": "CONNECTION_UPDATE", "data": {}},
        headers={"x-evolution-webhook-secret": "webhook-secret"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ignored_technical"}
