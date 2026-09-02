import asyncio
import os
from types import SimpleNamespace

import pytest

from app.core.secret_protection import REDACTED
from app.services import connection_registry as connection_registry_module
from app.services import instance_webhooks as instance_webhooks_module
from app.services import webhook_delivery
from app.services.connection_registry import ConnectionRegistry
from app.services.instance_webhooks import (
    create_webhook,
    get_webhook,
    list_instance_webhooks,
    list_recent_dispatches,
    protect_stored_webhook_secrets,
    update_webhook,
)


def _webhook_settings(path, key="phase-zero-key", gateway_key="gateway-fallback-key"):
    return SimpleNamespace(
        instance_webhooks_path=str(path),
        instance_webhooks_encryption_key=key,
        gateway_api_key=gateway_key,
        webhook_dispatch_history_limit=30,
    )


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are enforced in the Linux Gateway container")
def test_registry_persists_across_reinitialization_and_hardens_existing_storage(tmp_path) -> None:
    path = tmp_path / "gateway_data" / "connections" / "connection_registry.json"
    path.parent.mkdir(parents=True, mode=0o755)
    path.write_text('{"clients": {}, "connections": {}}', encoding="utf-8")
    path.chmod(0o644)

    first = ConnectionRegistry(path)
    first.save_client({"id": "phase-03-client", "name": "Restart test"})
    recreated = ConnectionRegistry(path)

    assert recreated.get_client("phase-03-client") == {"id": "phase-03-client", "name": "Restart test"}
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700


def test_webhook_secret_survives_service_reinitialization_and_runtime_delivery(monkeypatch, tmp_path) -> None:
    path = tmp_path / "gateway_data" / "instance_webhooks.json"
    monkeypatch.setattr(instance_webhooks_module, "get_settings", lambda: _webhook_settings(path))
    created = create_webhook(
        "phase_03_connection",
        name="Restart test",
        url="https://bot.example.test/hook?token=test-secret-123456",
        enabled=True,
        auth_type="API_KEY",
        auth_config={"headerName": "X-Client-Key", "apiKey": "test-secret-123456"},
        custom_headers={"X-Webhook-Token": "test-secret-123456"},
    )
    stored_before_restart = path.read_text(encoding="utf-8")

    # A fresh read models the new service process using the same mounted path.
    runtime_item = get_webhook("phase_03_connection", created["id"], reveal_secrets=True)
    assert runtime_item is not None
    assert "test-secret-123456" not in stored_before_restart

    received = {}

    class FakeResponse:
        status_code = 204
        text = '{"token":"test-secret-123456"}'
        headers = {"X-Webhook-Token": "test-secret-123456"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def post(self, url, *, json, headers, params):
            received.update({"url": url, "headers": headers, "params": params, "payload": json})
            return FakeResponse()

    monkeypatch.setattr(webhook_delivery.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    monkeypatch.setattr(webhook_delivery, "settings", SimpleNamespace(instance_webhook_timeout=1, webhook_debug=False))
    result = asyncio.run(
        webhook_delivery.dispatch_webhook_with_retry(
            payload={"instance": "phase_03_connection", "event": "MESSAGES_UPSERT", "token": "test-secret-123456"},
            request_id="phase-03-restart",
            item=runtime_item,
            test_mode=True,
        )
    )

    public = list_instance_webhooks("phase_03_connection")[0]
    history = list_recent_dispatches("phase_03_connection")[0]
    assert result["ok"] is True
    assert received["headers"]["X-Client-Key"] == "test-secret-123456"
    assert received["headers"]["X-Webhook-Token"] == "test-secret-123456"
    assert received["headers"]["X-Request-Id"] == "phase-03-restart"
    assert received["headers"]["X-Dispatch-Id"].startswith("disp_phase-03-restart")
    assert public["authConfig"]["apiKey"] == REDACTED
    assert "test-secret-123456" not in str(public)
    assert "test-secret-123456" not in str(history)

    updated = update_webhook(
        "phase_03_connection", created["id"], name="Updated", url="https://bot.example.test/updated",
        enabled=True, auth_type="API_KEY", auth_config={"headerName": "X-Client-Key"},
        custom_headers=None,
    )
    assert updated is not None
    assert "test-secret-123456" not in path.read_text(encoding="utf-8")
    assert get_webhook("phase_03_connection", created["id"], reveal_secrets=True)["authConfig"]["apiKey"] == "test-secret-123456"


def test_changed_encryption_key_fails_without_rewriting_encrypted_store(monkeypatch, tmp_path) -> None:
    path = tmp_path / "instance_webhooks.json"
    settings = {"value": _webhook_settings(path, key="original-key", gateway_key="original-fallback")}
    monkeypatch.setattr(instance_webhooks_module, "get_settings", lambda: settings["value"])
    create_webhook(
        "phase_03_connection", name="Key test", url="https://bot.example.test/hook", enabled=True,
        auth_type="BEARER", auth_config={"token": "test-secret-123456"}, custom_headers=None,
    )
    encrypted_before = path.read_text(encoding="utf-8")
    settings["value"] = _webhook_settings(path, key="changed-key", gateway_key="different-fallback")

    with pytest.raises(RuntimeError, match="No se pudo descifrar"):
        protect_stored_webhook_secrets()

    assert path.read_text(encoding="utf-8") == encrypted_before
