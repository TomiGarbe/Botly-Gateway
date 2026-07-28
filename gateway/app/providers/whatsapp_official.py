from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.platforms.meta import MetaPlatform, MetaPlatformError
from app.services.credential_manager import CredentialManager, get_credential_manager

logger = get_logger(__name__)


def _safe_payload_for_log(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep structural diagnostics while never logging a token or message body."""
    text = payload.get("text") if isinstance(payload.get("text"), dict) else {}
    return {
        "messaging_product": payload.get("messaging_product"),
        "to": payload.get("to"),
        "type": payload.get("type"),
        "text": {"bodyLength": len(str(text.get("body") or ""))},
    }


class OfficialWhatsAppProvider:
    """Outbound adapter for WhatsApp Cloud API's /{phone-number-id}/messages."""

    def __init__(
        self,
        *,
        credentials: CredentialManager | None = None,
        platform: MetaPlatform | None = None,
    ) -> None:
        self._credentials = credentials or get_credential_manager()
        self._platform = platform or MetaPlatform()

    async def send_text(self, *, instance_name: str, number: str, text: str) -> dict[str, Any]:
        credential_info = self._credentials.get_official_credentials_info(instance_name)
        access_token = self._credentials.get_official_access_token(instance_name)
        if credential_info is None or not access_token:
            raise MetaPlatformError(
                "No hay credenciales utilizables para WhatsApp Oficial. Reconecta la cuenta.",
                status_code=422,
                detail={"field": "official_credentials", "provider": "meta_whatsapp"},
            )

        payload = {
            "messaging_product": "whatsapp",
            "to": number,
            "type": "text",
            "text": {"body": text},
        }
        logger.info(
            "meta_whatsapp_send_payload",
            instance=instance_name,
            phone_number_id=credential_info.phone_number_id,
            payload=_safe_payload_for_log(payload),
        )
        response = await self._platform.request(
            "POST",
            f"/{credential_info.phone_number_id}/messages",
            headers={"Authorization": f"Bearer {access_token}"},
            json=payload,
            log_response=True,
        )
        if not isinstance(response, dict):
            raise MetaPlatformError("Meta devolvio una respuesta invalida al enviar el mensaje.", status_code=502)
        messages = response.get("messages")
        first_message = messages[0] if isinstance(messages, list) and messages and isinstance(messages[0], dict) else {}
        message_id = str(first_message.get("id") or "").strip()
        if not message_id:
            raise MetaPlatformError(
                "Meta acepto la solicitud pero no devolvio el id del mensaje.",
                status_code=502,
                detail={"providerResponse": response},
            )
        logger.info(
            "meta_whatsapp_send_response",
            instance=instance_name,
            message_id=message_id,
            response=response,
        )
        return {
            "ok": True,
            "provider": "meta_whatsapp",
            "messageId": message_id,
            "status": "accepted",
            "meta": response,
        }


def get_official_whatsapp_provider() -> OfficialWhatsAppProvider:
    return OfficialWhatsAppProvider()
