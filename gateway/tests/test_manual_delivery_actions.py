import asyncio
import json
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import webhook_center
from app.services.instance_webhooks import append_dispatch_history, create_webhook, get_webhook_delivery, update_webhook
from app.services.manual_delivery_actions import get_action


def _settings(tmp_path):
    return SimpleNamespace(
        instance_webhooks_path=str(tmp_path / "webhooks.json"),
        instance_webhooks_encryption_key="manual-action-test-key",
        webhook_dispatch_history_limit=30, webhook_deliveries_path=str(tmp_path / "deliveries.json"),
        webhook_delivery_retention=100, webhook_delivery_max_payload_bytes=16_384,
        manual_delivery_actions_path=str(tmp_path / "manual-actions.json"),
        manual_delivery_action_retention=100, manual_delivery_action_rate_limit=10,
        manual_delivery_action_rate_window_seconds=60,
    )


def _client(monkeypatch, tmp_path, *, actor_business="tenant-a", webhook_enabled=True):
    settings = _settings(tmp_path)
    for target in (
        "app.services.instance_webhooks.get_settings", "app.services.webhook_deliveries.get_settings",
        "app.services.manual_delivery_actions.get_settings",
    ):
        monkeypatch.setattr(target, lambda: settings)
    hook = create_webhook("runtime-a", name="Test", url="https://receiver.example.test/test?token=private", enabled=webhook_enabled, auth_type="NONE", auth_config=None, custom_headers=None)
    append_dispatch_history("runtime-a", hook["id"], {"id": "source-test", "timestamp": 1, "isTest": True, "success": True, "status": "success", "statusCode": 204})
    append_dispatch_history("runtime-a", hook["id"], {
        "id": "source-real", "timestamp": 2, "isTest": False, "success": True, "status": "success", "statusCode": 204,
        "destinationUrl": "https://receiver.example.test/test?token=private",
        "request": {"url": "https://receiver.example.test/test?token=private", "payloadPreview": '{"id":"business-event","event":"MESSAGE_CREATED","instance":"runtime-a","text":"safe payload"}', "payloadTruncated": False},
    })
    connection = SimpleNamespace(id="connection-a", client_id="tenant-a", technical={"legacy_instance_name": "runtime-a"})

    class Connections:
        async def get_connection_by_runtime_name(self, runtime_name):
            if runtime_name != "runtime-a":
                from app.services.connections import ConnectionNotFoundError
                raise ConnectionNotFoundError(runtime_name)
            return connection

    calls = []

    async def dispatcher(*, payload, request_id, item, test_mode=False, manual_action_id=None, bypass_filters=False):
        calls.append({"payload": payload, "request_id": request_id, "manual_action_id": manual_action_id, "test_mode": test_mode, "bypass_filters": bypass_filters})
        delivery = append_dispatch_history("runtime-a", hook["id"], {
            "id": f"repeated-{len(calls)}", "timestamp": 10 + len(calls), "isTest": test_mode,
            "success": True, "status": "success", "statusCode": 204,
            "metadata": {"manualActionId": manual_action_id},
        })
        return {"ok": True, "statusCode": 204, "latencyMs": 12.5, "retriesUsed": 0, "deliveryId": delivery["id"]}

    monkeypatch.setattr(webhook_center, "_connections", Connections())
    monkeypatch.setattr(webhook_center, "dispatch_webhook_with_retry", dispatcher)
    app = FastAPI()

    @app.middleware("http")
    async def identity(request, call_next):
        request.state.user = SimpleNamespace(id="actor-a", role="meta_reviewer", business_id=actor_business)
        return await call_next(request)

    app.include_router(webhook_center.router)
    return TestClient(app), hook, calls


def test_repeat_test_is_append_only_idempotent_and_linked(monkeypatch, tmp_path):
    client, hook, calls = _client(monkeypatch, tmp_path)
    path = f"/webhooks/{hook['id']}/deliveries/source-test/repeat-test"
    first = client.post(path, headers={"Idempotency-Key": "repeat-1"})
    second = client.post(path, headers={"Idempotency-Key": "repeat-1"})

    assert first.status_code == second.status_code == 200
    result = first.json()
    assert result["action"] == "repeat_test" and result["risk"] == "safe"
    assert result["status"] == "completed" and result["configurationSource"] == "current"
    assert result["newDeliveryId"] == "repeated-1" and second.json()["newDeliveryId"] == "repeated-1"
    assert len(calls) == 1
    assert get_webhook_delivery("runtime-a", hook["id"], "source-test")["id"] == "source-test"
    repeated = get_webhook_delivery("runtime-a", hook["id"], "repeated-1")
    assert repeated["isTest"] is True and repeated["metadata"]["manualActionId"] == result["actionId"]
    action = get_action(result["actionId"])
    assert action and action["sourceDeliveryId"] == "source-test" and action["newDeliveryId"] == "repeated-1"
    serialized = json.dumps(action)
    assert "private" not in serialized and "Authorization" not in serialized


def test_repeat_test_rejects_real_disabled_foreign_and_idempotency_conflicts(monkeypatch, tmp_path):
    client, hook, calls = _client(monkeypatch, tmp_path)
    base = f"/webhooks/{hook['id']}/deliveries"
    assert client.post(f"{base}/source-real/repeat-test", headers={"Idempotency-Key": "real"}).status_code == 409
    assert client.post(f"{base}/missing/repeat-test", headers={"Idempotency-Key": "missing"}).status_code == 404
    assert client.post(f"{base}/source-test/repeat-test", headers={"Idempotency-Key": "shared"}).status_code == 200
    assert client.post(f"{base}/source-real/repeat-test", headers={"Idempotency-Key": "shared"}).status_code == 409
    assert client.post(f"{base}/source-test/repeat-test", headers={"Idempotency-Key": "reason"}, json={"reason": "operator check"}).status_code == 200
    assert client.post(f"{base}/source-test/repeat-test", headers={"Idempotency-Key": "reason"}, json={"reason": "different context"}).status_code == 409
    assert len(calls) == 2

    foreign_client, foreign_hook, foreign_calls = _client(monkeypatch, tmp_path / "foreign", actor_business="tenant-b")
    assert foreign_client.post(f"/webhooks/{foreign_hook['id']}/deliveries/source-test/repeat-test", headers={"Idempotency-Key": "foreign"}).status_code == 403
    assert foreign_calls == []

    disabled_client, disabled_hook, disabled_calls = _client(monkeypatch, tmp_path / "disabled", webhook_enabled=False)
    assert disabled_client.post(f"/webhooks/{disabled_hook['id']}/deliveries/source-test/repeat-test", headers={"Idempotency-Key": "disabled"}).status_code == 409
    assert disabled_calls == []


def test_repeat_test_records_a_failed_action_when_dispatcher_returns_failure(monkeypatch, tmp_path):
    client, hook, _calls = _client(monkeypatch, tmp_path)

    async def failing_dispatcher(*, manual_action_id=None, **_kwargs):
        delivery = append_dispatch_history("runtime-a", hook["id"], {
            "id": "failed-repeat", "timestamp": 11, "isTest": True, "success": False,
            "status": "timeout", "statusCode": 0, "error": "safe failure",
            "metadata": {"manualActionId": manual_action_id},
        })
        return {"ok": False, "statusCode": 0, "latencyMs": 5, "retriesUsed": 3, "error": "safe failure", "deliveryId": delivery["id"]}

    monkeypatch.setattr(webhook_center, "dispatch_webhook_with_retry", failing_dispatcher)
    response = client.post(f"/webhooks/{hook['id']}/deliveries/source-test/repeat-test", headers={"Idempotency-Key": "failed"})
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "failed" and result["newDeliveryId"] == "failed-repeat"
    action = get_action(result["actionId"])
    assert action and action["status"] == "failed" and action["result"]["error"] == "safe failure"


def test_redeliver_current_target_is_append_only_idempotent_and_uses_current_configuration(monkeypatch, tmp_path):
    client, hook, calls = _client(monkeypatch, tmp_path)
    path = f"/webhooks/{hook['id']}/deliveries/source-real/redeliver-current-target"
    assert client.post(path, headers={"Idempotency-Key": "missing-confirmation"}, json={}).status_code == 409

    first = client.post(path, headers={"Idempotency-Key": "redeliver-1"}, json={"confirmCurrentTarget": True})
    second = client.post(path, headers={"Idempotency-Key": "redeliver-1"}, json={"confirmCurrentTarget": True})
    assert first.status_code == second.status_code == 200
    result = first.json()
    assert result["action"] == "redeliver_current_target" and result["risk"] == "warning"
    assert result["status"] == "completed" and result["configurationSource"] == "current"
    assert result["observableDestinationDrift"] is False and result["newDeliveryId"] == "repeated-1"
    assert len(calls) == 1 and calls[0]["test_mode"] is False and calls[0]["bypass_filters"] is True
    assert calls[0]["payload"] == {"id": "business-event", "event": "MESSAGE_CREATED", "instance": "runtime-a", "text": "safe payload"}
    assert get_webhook_delivery("runtime-a", hook["id"], "source-real")["id"] == "source-real"
    repeated = get_webhook_delivery("runtime-a", hook["id"], "repeated-1")
    assert repeated["isTest"] is False and repeated["metadata"]["manualActionId"] == result["actionId"]
    action = get_action(result["actionId"])
    assert action and action["sourceDeliveryId"] == "source-real" and action["newDeliveryId"] == "repeated-1"


def test_redelivery_rejects_tests_incomplete_payloads_and_reports_observable_destination_drift(monkeypatch, tmp_path):
    client, hook, calls = _client(monkeypatch, tmp_path)
    base = f"/webhooks/{hook['id']}/deliveries"
    assert client.post(f"{base}/source-test/redeliver-current-target", headers={"Idempotency-Key": "test"}, json={"confirmCurrentTarget": True}).status_code == 409
    append_dispatch_history("runtime-a", hook["id"], {
        "id": "source-truncated", "timestamp": 3, "isTest": False, "success": False, "status": "failed",
        "destinationUrl": "https://receiver.example.test/test", "request": {"url": "https://receiver.example.test/test", "payloadPreview": '{"id":"partial"}', "payloadTruncated": True},
    })
    assert client.post(f"{base}/source-truncated/redeliver-current-target", headers={"Idempotency-Key": "truncated"}, json={"confirmCurrentTarget": True}).status_code == 409
    updated = update_webhook("runtime-a", hook["id"], name="Test", url="https://changed.example.test/events", enabled=True, auth_type="NONE", auth_config={}, custom_headers={}, event_filters={"business": True})
    assert updated
    response = client.post(f"{base}/source-real/redeliver-current-target", headers={"Idempotency-Key": "drift"}, json={"confirmCurrentTarget": True})
    assert response.status_code == 200 and response.json()["observableDestinationDrift"] is True
    assert len(calls) == 1
