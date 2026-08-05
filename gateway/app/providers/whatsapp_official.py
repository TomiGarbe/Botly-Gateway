from __future__ import annotations

import base64
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


def _credentials_or_error(credentials: CredentialManager, instance_name: str):
    credential_info = credentials.get_official_credentials_info(instance_name)
    access_token = credentials.get_official_access_token(instance_name)
    if credential_info is None or not access_token:
        raise MetaPlatformError(
            "No hay credenciales utilizables para WhatsApp Oficial. Reconecta la cuenta.",
            status_code=422,
            detail={"field": "official_credentials", "provider": "meta_whatsapp"},
        )
    return credential_info, access_token


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
        credential_info, access_token = _credentials_or_error(self._credentials, instance_name)

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

    async def send_media(
        self,
        *,
        instance_name: str,
        number: str,
        media_base64: str,
        media_type: str,
        mime_type: str,
        file_name: str,
        caption: str = "",
    ) -> dict[str, Any]:
        """Upload browser media to Graph and send its id through Cloud API."""
        credential_info, access_token = _credentials_or_error(self._credentials, instance_name)
        try:
            binary = base64.b64decode(media_base64, validate=True)
        except Exception as exc:
            raise MetaPlatformError("El archivo recibido no es válido.", status_code=422) from exc

        headers = {"Authorization": f"Bearer {access_token}"}
        uploaded = await self._platform.request(
            "POST",
            f"/{credential_info.phone_number_id}/media",
            headers=headers,
            data={"messaging_product": "whatsapp"},
            files={"file": (file_name or "file.bin", binary, mime_type or "application/octet-stream")},
            log_response=True,
        )
        media_id = str(uploaded.get("id") or "").strip() if isinstance(uploaded, dict) else ""
        if not media_id:
            raise MetaPlatformError("Meta no devolvió el identificador del archivo.", status_code=502)

        media_payload: dict[str, Any] = {"id": media_id}
        if caption.strip() and media_type in {"image", "video", "document"}:
            media_payload["caption"] = caption.strip()
        if media_type == "document" and file_name:
            media_payload["filename"] = file_name
        payload = {"messaging_product": "whatsapp", "to": number, "type": media_type, media_type: media_payload}
        response = await self._platform.request(
            "POST",
            f"/{credential_info.phone_number_id}/messages",
            headers=headers,
            json=payload,
            log_response=True,
        )
        messages = response.get("messages") if isinstance(response, dict) else None
        first = messages[0] if isinstance(messages, list) and messages and isinstance(messages[0], dict) else {}
        message_id = str(first.get("id") or "").strip()
        if not message_id:
            raise MetaPlatformError("Meta aceptó el archivo pero no devolvió el id del mensaje.", status_code=502)
        return {"ok": True, "provider": "meta_whatsapp", "messageId": message_id, "status": "accepted", "meta": response}


def get_official_whatsapp_provider() -> OfficialWhatsAppProvider:
    return OfficialWhatsAppProvider()
