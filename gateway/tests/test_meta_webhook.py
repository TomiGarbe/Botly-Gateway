from __future__ import annotations

import hashlib
import hmac
import json
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.main import app
from app.routers import meta_webhook
from app.services import credential_manager


def _settings(*, verify_token: str = "verify-token", app_secret: str = "app-secret") -> SimpleNamespace:
    return SimpleNamespace(
        meta_webhook_verify_token=verify_token,
        meta_webhook_require_signature=True,
        meta_app_secret=app_secret,
        bot_webhook_max_queue=200,
    )


def test_meta_webhook_returns_the_exact_challenge(monkeypatch) -> None:
    monkeypatch.setattr(meta_webhook, "get_settings", lambda: _settings())
    client = TestClient(app)

    response = client.get(
        "/webhooks/meta",
        params={"hub.mode": "subscribe", "hub.verify_token": "verify-token", "hub.challenge": "123456"},
    )

    assert response.status_code == 200
    assert response.text == "123456"
    assert response.headers["content-type"].startswith("text/plain")
    assert client.get("/webhooks/meta", params={"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "123456"}).status_code == 403


def test_meta_webhook_accepts_signed_message_status_and_error(monkeypatch, tmp_path) -> None:
    settings = _settings()
    store_path = tmp_path / "credentials.json"
    monkeypatch.setattr(meta_webhook, "get_settings", lambda: settings)
    monkeypatch.setattr(credential_manager, "get_settings", lambda: SimpleNamespace(official_credentials_path=str(store_path)))
    credential_manager.get_credential_manager().upsert_official_credentials(
        instance_name="cloud_test",
        access_token="access-token",
        phone_number_id="phone_123",
        business_account_id="waba_123",
        source="test",
    )
    now = str(int(time.time()))
    payload = {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"field": "messages", "value": {
            "metadata": {"phone_number_id": "phone_123"},
            "messages": [{"from": "5491100000000", "id": "wamid.message", "timestamp": now, "type": "text", "text": {"body": "hola"}}],
            "statuses": [{"id": "wamid.status", "recipient_id": "5491100000000", "timestamp": now, "status": "delivered"}],
            "errors": [{"code": 131000}],
        }}]}],
    }
    body = json.dumps(payload).encode("utf-8")
    signature = "sha256=" + hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()

    response = TestClient(app).post("/webhooks/meta", content=body, headers={"X-Hub-Signature-256": signature})

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "messages": 1, "statuses": 1, "changes": 1, "errors": 1, "unmapped": 0}
    assert TestClient(app).post("/webhooks/meta", content=body, headers={"X-Hub-Signature-256": "sha256=bad"}).status_code == 401
