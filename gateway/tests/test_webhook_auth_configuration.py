from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.auth import AuthMiddleware
from app.services.instance_webhooks import build_auth_headers, build_auth_query_params, create_webhook, list_instance_webhooks


def test_gateway_api_key_authenticates_machine_requests(monkeypatch) -> None:
    monkeypatch.setattr("app.middleware.auth.get_settings", lambda: SimpleNamespace(gateway_api_key="gateway-secret"))
    monkeypatch.setattr("app.middleware.auth.get_auth_service", lambda: SimpleNamespace(current_user=lambda _cookie: None))
    app = FastAPI()
    app.add_middleware(AuthMiddleware)

    @app.get("/private")
    async def private_endpoint():
        return {"ok": True}

    client = TestClient(app)
    assert client.get("/private", headers={"X-API-Key": "gateway-secret"}).status_code == 200
    assert client.get("/private", headers={"Authorization": "Bearer gateway-secret"}).status_code == 200
    assert client.get("/private", headers={"X-API-Key": "wrong"}).status_code == 401


def test_query_param_webhook_security_keeps_secret_out_of_public_configuration(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.services.instance_webhooks.get_settings",
        lambda: SimpleNamespace(instance_webhooks_path=str(tmp_path / "webhooks.json"), webhook_dispatch_history_limit=30),
    )
    created = create_webhook(
        "botly_connection",
        name="Bot webhook",
        url="https://bot.example.test/events",
        enabled=True,
        auth_type="QUERY_PARAM",
        auth_config={"queryParamName": "token", "queryParamValue": "secret-value"},
        custom_headers=None,
    )

    internal = list_instance_webhooks("botly_connection", reveal_secrets=True)[0]
    public = list_instance_webhooks("botly_connection", reveal_secrets=False)[0]

    assert build_auth_headers(internal) == {}
    assert build_auth_query_params(internal) == {"token": "secret-value"}
    assert public["authConfig"]["queryParamName"] == "token"
    assert public["authConfig"]["queryParamValue"] == ""
    assert public["authConfig"]["hasQueryParamValue"] is True


def test_custom_header_webhook_security_keeps_value_out_of_public_configuration(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.services.instance_webhooks.get_settings",
        lambda: SimpleNamespace(instance_webhooks_path=str(tmp_path / "webhooks.json"), webhook_dispatch_history_limit=30),
    )
    create_webhook(
        "botly_connection",
        name="Bot webhook",
        url="https://bot.example.test/events",
        enabled=True,
        auth_type="CUSTOM_HEADERS",
        auth_config=None,
        custom_headers={"X-Bot-Secret": "secret-value"},
    )

    public = list_instance_webhooks("botly_connection", reveal_secrets=False)[0]

    assert public["customHeaders"] == {"X-Bot-Secret": ""}
    assert public["hasCustomHeaders"] is True
