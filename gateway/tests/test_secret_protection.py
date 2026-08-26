from types import SimpleNamespace

from app.core.secret_protection import REDACTED, SecretRedactor
from app.services.instance_webhooks import append_dispatch_history, build_auth_headers, create_webhook, get_webhook, list_recent_dispatches, list_instance_webhooks, mask_headers_for_log, protect_stored_webhook_secrets


def _settings(path):
    return SimpleNamespace(
        instance_webhooks_path=str(path),
        instance_webhooks_encryption_key="test-webhook-encryption-key",
        gateway_api_key="test-gateway-key",
        webhook_dispatch_history_limit=30,
    )


def test_secret_redactor_masks_sensitive_headers_without_hiding_operational_headers() -> None:
    headers = {
        "Authorization": "bearer-value",
        "X-Api-Key": "api-value",
        "X-Client-Key": "client-value",
        "X-Webhook-Token": "webhook-value",
        "X-Signature": "signature-value",
        "Cookie": "session=value",
        "Content-Type": "application/json",
        "User-Agent": "Botly Gateway",
        "X-Request-ID": "request-01",
    }

    safe = mask_headers_for_log(headers)

    assert all(safe[name] == REDACTED for name in list(headers)[:6])
    assert safe["Content-Type"] == "application/json"
    assert safe["User-Agent"] == "Botly Gateway"
    assert safe["X-Request-ID"] == "request-01"


def test_secret_redactor_recurses_through_json_objects_and_lists() -> None:
    value = {
        "token": "top-secret",
        "nested": {"Access_Token": "nested-secret", "items": [{"api_key": "key-secret"}, {"message": "hola"}]},
        "PASSWORD": "password-secret",
        "safe": "visible",
    }

    safe = SecretRedactor.redact_json(value)

    assert safe["token"] == REDACTED
    assert safe["nested"]["Access_Token"] == REDACTED
    assert safe["nested"]["items"][0]["api_key"] == REDACTED
    assert safe["PASSWORD"] == REDACTED
    assert safe["nested"]["items"][1]["message"] == "hola"
    assert safe["safe"] == "visible"


def test_structured_logs_apply_the_same_redaction() -> None:
    event = SecretRedactor.structlog_processor(None, "info", {"event": "dispatch", "api_key": "log-secret", "request_id": "request-01"})

    assert event["api_key"] == REDACTED
    assert event["request_id"] == "request-01"


def test_webhook_secrets_are_encrypted_at_rest_but_available_for_delivery(monkeypatch, tmp_path) -> None:
    path = tmp_path / "webhooks.json"
    monkeypatch.setattr("app.services.instance_webhooks.get_settings", lambda: _settings(path))
    create_webhook(
        "connection_one",
        name="Botly",
        url="https://bot.example.test/hook",
        enabled=True,
        auth_type="API_KEY",
        auth_config={"headerName": "X-Client-Key", "apiKey": "delivery-secret"},
        custom_headers={"X-Webhook-Token": "custom-secret", "X-Request-ID": "request-01"},
    )

    stored = path.read_text(encoding="utf-8")
    internal = get_webhook("connection_one", list_instance_webhooks("connection_one")[0]["id"], reveal_secrets=True)
    public = list_instance_webhooks("connection_one")[0]

    assert "delivery-secret" not in stored
    assert "custom-secret" not in stored
    assert build_auth_headers(internal) == {"X-Client-Key": "delivery-secret", "X-Webhook-Token": "custom-secret", "X-Request-ID": "request-01"}
    assert public["authConfig"]["apiKey"] == REDACTED
    assert public["customHeaders"]["X-Webhook-Token"] == REDACTED
    assert "delivery-secret" not in str(public)
    assert "custom-secret" not in str(public)


def test_legacy_webhook_secret_is_migrated_without_breaking_delivery(monkeypatch, tmp_path) -> None:
    path = tmp_path / "webhooks.json"
    path.write_text('{"instances":{"connection_one":[{"id":"hook-01","url":"https://bot.example.test/hook","enabled":true,"authType":"BEARER","authConfig":{"token":"legacy-secret"},"customHeaders":{}}]}}', encoding="utf-8")
    monkeypatch.setattr("app.services.instance_webhooks.get_settings", lambda: _settings(path))

    assert protect_stored_webhook_secrets() == 1
    internal = list_instance_webhooks("connection_one", reveal_secrets=True)[0]
    public = list_instance_webhooks("connection_one")[0]

    assert build_auth_headers(internal) == {"Authorization": "Bearer legacy-secret"}
    assert "legacy-secret" not in path.read_text(encoding="utf-8")
    assert "legacy-secret" in path.with_suffix(".json.pre-encryption-backup").read_text(encoding="utf-8")
    assert public["authConfig"]["token"] == REDACTED


def test_delivery_history_redacts_headers_and_json_payloads(monkeypatch, tmp_path) -> None:
    path = tmp_path / "webhooks.json"
    monkeypatch.setattr("app.services.instance_webhooks.get_settings", lambda: _settings(path))
    created = create_webhook(
        "connection_one", name="Botly", url="https://bot.example.test/hook", enabled=True,
        auth_type="NONE", auth_config=None, custom_headers=None,
    )
    append_dispatch_history(
        "connection_one", created["id"],
        {
            "request": {
                "headers": {"X-Client-Key": "header-secret", "X-Request-ID": "request-01"},
                "payloadSummary": {"token": "payload-secret", "message": "hola"},
                "payloadPreview": '{"nested":{"api_key":"preview-secret"}}',
            },
            "response": {"headers": {"Set-Cookie": "session-secret"}, "bodyPreview": '{"secret":"response-secret"}'},
        },
    )

    delivery = list_recent_dispatches("connection_one")[0]

    assert delivery["request"]["headers"]["X-Client-Key"] == REDACTED
    assert delivery["request"]["headers"]["X-Request-ID"] == "request-01"
    assert delivery["request"]["payloadSummary"]["token"] == REDACTED
    assert "preview-secret" not in delivery["request"]["payloadPreview"]
    assert delivery["response"]["headers"]["Set-Cookie"] == REDACTED
    assert "response-secret" not in delivery["response"]["bodyPreview"]
