from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import messages


class _InstagramConnectionService:
    def __init__(self) -> None:
        self.sent: tuple[str, str, str] | None = None

    async def get_connection_by_runtime_name(self, runtime_name: str):
        assert runtime_name == "instagram_runtime"
        return SimpleNamespace(
            id="instagram-connection-id",
            provider=SimpleNamespace(id="meta"),
            channel=SimpleNamespace(id="instagram"),
        )

    async def send_instagram_text(self, *, connection_id: str, external_id: str, text: str):
        self.sent = (connection_id, external_id, text)
        return {"ok": True, "recipient": {"externalId": external_id}}


def test_unified_message_endpoint_sends_instagram_text_with_opaque_external_id(monkeypatch) -> None:
    service = _InstagramConnectionService()
    monkeypatch.setattr(messages, "get_connection_service", lambda: service)
    app = FastAPI()
    app.include_router(messages.router)

    response = TestClient(app).post(
        "/messages/instagram_runtime",
        json={"external_id": "instagram-scoped-user-id", "text": "Hola"},
    )

    assert response.status_code == 200
    assert service.sent == ("instagram-connection-id", "instagram-scoped-user-id", "Hola")

