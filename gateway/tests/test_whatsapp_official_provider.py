from __future__ import annotations

import asyncio

from app.providers.whatsapp_official import OfficialWhatsAppProvider


class _Credentials:
    class _Info:
        phone_number_id = "123456789"

    def get_official_credentials_info(self, instance_name: str):
        assert instance_name == "official_instance"
        return self._Info()

    def get_official_access_token(self, instance_name: str):
        assert instance_name == "official_instance"
        return "never-log-this-token"


class _Platform:
    def __init__(self) -> None:
        self.call: dict | None = None

    async def request(self, method: str, path: str, **kwargs):
        self.call = {"method": method, "path": path, **kwargs}
        return {"messaging_product": "whatsapp", "contacts": [{"wa_id": "5491111111111"}], "messages": [{"id": "wamid.abc"}]}


def test_official_provider_builds_the_meta_text_payload_exactly() -> None:
    async def run() -> None:
        platform = _Platform()
        provider = OfficialWhatsAppProvider(credentials=_Credentials(), platform=platform)

        result = await provider.send_text(instance_name="official_instance", number="5491111111111", text="Hola")

        assert platform.call == {
            "method": "POST",
            "path": "/123456789/messages",
            "headers": {"Authorization": "Bearer never-log-this-token"},
            "log_response": True,
            "json": {
                "messaging_product": "whatsapp",
                "to": "5491111111111",
                "type": "text",
                "text": {"body": "Hola"},
            },
        }
        assert result["messageId"] == "wamid.abc"
        assert result["status"] == "accepted"

    asyncio.run(run())
