import json
from types import SimpleNamespace

from app.services.instance_webhooks import append_dispatch_history, create_webhook, get_webhook_delivery, list_webhook_delivery_page


def _configure(monkeypatch, tmp_path) -> None:
    settings = SimpleNamespace(
        instance_webhooks_path=str(tmp_path / "webhooks.json"), instance_webhooks_encryption_key="test-key",
        webhook_dispatch_history_limit=30, webhook_deliveries_path=str(tmp_path / "deliveries.json"),
        webhook_delivery_retention=20, webhook_delivery_max_payload_bytes=1024, gateway_api_key="gateway-key",
    )
    monkeypatch.setattr("app.services.instance_webhooks.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.webhook_deliveries.get_settings", lambda: settings)


def _webhook() -> dict:
    return create_webhook("runtime", name="Observability", url="https://receiver.test/events?token=private", enabled=True, auth_type="NONE", auth_config=None, custom_headers=None)


def _delivery(identifier: str, timestamp: int, **extra) -> dict:
    return {
        "id": identifier, "timestamp": timestamp, "eventType": "message.created", "eventId": "event-1",
        "requestId": "request-1", "dispatchId": "correlation-1", "messageId": "message-1", "conversationId": "conversation-1",
        "success": True, "status": "success", "statusCode": 200, "durationMs": 12.4, "attemptCount": 1,
        "request": {"url": "https://receiver.test/events?token=private", "query": {"api_key": "private-key", "page": "1"}, "headers": {"Authorization": "Bearer private"}, "payloadPreview": '{"nested":{"token":"body-secret"}}'},
        "response": {"headers": {"Set-Cookie": "private-cookie"}, "bodyPreview": '{"secret":"response-secret","ok":true}'},
        "metadata": {"token": "metadata-secret"}, **extra,
    }


def test_delivery_detail_is_structured_redacted_and_correlated(monkeypatch, tmp_path) -> None:
    _configure(monkeypatch, tmp_path)
    hook = _webhook()
    append_dispatch_history("runtime", hook["id"], _delivery("delivery-1", 10))
    detail = get_webhook_delivery("runtime", hook["id"], "delivery-1")
    assert detail and detail["summary"]["operation"] == "webhook.delivery"
    assert detail["summary"]["semanticStatus"] == "success"
    assert detail["summary"]["eventId"] == "event-1"
    assert detail["summary"]["correlationId"] == "correlation-1"
    assert detail["request"]["url"] and "private" not in detail["request"]["url"]
    assert detail["request"]["query"]["api_key"] == "[REDACTED]"
    assert detail["errorDetail"] is None
    for key, value in {"delivery_id": "delivery-1", "event_id": "event-1", "request_id": "request-1", "correlation_id": "correlation-1", "search": "correlation-1"}.items():
        assert [item["id"] for item in list_webhook_delivery_page("runtime", hook["id"], **{key: value})["items"]] == ["delivery-1"]
    rendered = json.dumps(detail)
    for secret in ("private-key", "body-secret", "response-secret", "metadata-secret", "private-cookie"):
        assert secret not in rendered


def test_delivery_semantic_statuses_and_lightweight_filtered_pages(monkeypatch, tmp_path) -> None:
    _configure(monkeypatch, tmp_path)
    hook = _webhook()
    append_dispatch_history("runtime", hook["id"], _delivery("a", 100, success=False, status="timeout", statusCode=0, errorType="timeout", error="token=private"))
    append_dispatch_history("runtime", hook["id"], _delivery("b", 100, success=False, status="http_500", statusCode=500, errorType="http_error", error="failed"))
    append_dispatch_history("runtime", hook["id"], _delivery("c", 200, isTest=True))
    append_dispatch_history("runtime", hook["id"], _delivery("d", 300, success=False, status="network_error", statusCode=0, errorType="network_error", error="offline"))

    timeout_page = list_webhook_delivery_page("runtime", hook["id"], status="timeout", limit=10)
    assert [item["id"] for item in timeout_page["items"]] == ["a"]
    assert timeout_page["items"][0]["semanticStatus"] == "timeout"
    tests_page = list_webhook_delivery_page("runtime", hook["id"], is_test=True, date_from=150, limit=10)
    assert [item["id"] for item in tests_page["items"]] == ["c"]
    assert list_webhook_delivery_page("runtime", hook["id"], event_type="other.event")["items"] == []
    assert [item["id"] for item in list_webhook_delivery_page("runtime", hook["id"], operation="webhook.test")["items"]] == ["c"]
    page = list_webhook_delivery_page("runtime", hook["id"], limit=2, offset=1)
    assert page["total"] == 4 and page["offset"] == 1 and page["limit"] == 2
    assert [item["id"] for item in page["items"]] == ["c", "b"]
    assert "request" not in page["items"][0] and "response" not in page["items"][0]
    network = get_webhook_delivery("runtime", hook["id"], "d")
    assert network and network["semanticStatus"] == "network_error"
