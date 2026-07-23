from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.models.requests import CreateInstanceRequest
from app.routers import instances as instances_router


class _StubConnectionManager:
    def __init__(self, result) -> None:
        self._result = result

    async def create(self, **_kwargs):
        return self._result

    async def get_webhook(self, _instance_name):
        return {}

    async def set_webhook(self, *_args, **_kwargs):
        return {}


def _isolate_key_store(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.services.instance_auth.get_settings",
        lambda: SimpleNamespace(instance_api_keys_path=str(tmp_path / "instance_api_keys.json")),
    )


def test_create_instance_returns_instance_and_plaintext_api_key(monkeypatch, tmp_path) -> None:
    """El panel revela la API key una unica vez al crear: la respuesta debe traerla."""
    _isolate_key_store(monkeypatch, tmp_path)
    monkeypatch.setattr(instances_router, "get_feature_service", lambda: SimpleNamespace(connection_type_enabled=lambda _value: True))
    monkeypatch.setattr(
        instances_router,
        "_connection_manager",
        _StubConnectionManager({"instanceName": "acme_support", "integration": "WHATSAPP-BAILEYS"}),
    )

    body = CreateInstanceRequest(instance_name="acme_support", auto_configure_webhook=False)
    payload = asyncio.run(instances_router.create_instance(body))

    assert payload["instance"]["name"] == "acme_support"
    assert isinstance(payload["apiKey"], str) and payload["apiKey"]


def test_create_instance_fallback_response_still_exposes_api_key(monkeypatch, tmp_path) -> None:
    """Si Evolution devuelve algo inusable, el fallback no debe romper ni perder la apiKey."""
    _isolate_key_store(monkeypatch, tmp_path)
    monkeypatch.setattr(instances_router, "_connection_manager", _StubConnectionManager(None))

    body = CreateInstanceRequest(
        instance_name="cloud_instance",
        connection_type="cloud",
        qrcode=False,
        token="access-token",
        phone_number_id="phone_123",
        business_id="waba_456",
        auto_configure_webhook=False,
    )
    payload = asyncio.run(instances_router.create_instance(body))

    assert payload["instance"]["status"] == "open"
    assert payload["instance"]["connectionType"] == "cloud"
    assert isinstance(payload["apiKey"], str) and payload["apiKey"]
