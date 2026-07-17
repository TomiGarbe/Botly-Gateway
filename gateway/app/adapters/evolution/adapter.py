from __future__ import annotations

import base64
import re
from typing import Any

from app.adapters.evolution.client import EvolutionClient, get_evolution_client
from app.adapters.evolution.errors import EvolutionError
from app.adapters.evolution.transports import BAILEYS_TRANSPORT_PROFILE, EvolutionTransportProfile
from app.core.logging import get_logger

logger = get_logger(__name__)
_DATA_URI_RE = re.compile(r"^data:[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*;base64,")
_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


class EvolutionAdapter:
    def __init__(
        self,
        client: EvolutionClient | None = None,
        transport_profile: EvolutionTransportProfile = BAILEYS_TRANSPORT_PROFILE,
    ) -> None:
        self._client = client or get_evolution_client()
        self.transport_profile = transport_profile

    async def open(self) -> None:
        await self._client.open()

    async def close(self) -> None:
        await self._client.close()

    async def create_instance(
        self,
        instance_name: str,
        qrcode: bool = True,
        token: str | None = None,
        *,
        integration: str,
        number: str | None = None,
        business_id: str | None = None,
    ) -> dict:
        payload: dict[str, Any] = {
            "instanceName": instance_name,
            "integration": integration,
            "qrcode": qrcode,
        }
        if token:
            payload["token"] = token
        if number:
            payload["number"] = number
        if business_id:
            payload["businessId"] = business_id
        logger.info("instance_create_requested", instance=instance_name)
        return await self._client.request("POST", "/instance/create", json=payload, retries=1)

    async def connect_instance(self, instance_name: str) -> dict:
        return await self._client.request("GET", f"/instance/connect/{instance_name}", retries=1)

    async def get_qr(self, instance_name: str) -> dict:
        return await self.connect_instance(instance_name)

    async def get_instance_status(self, instance_name: str) -> dict:
        return await self._client.request("GET", f"/instance/connectionState/{instance_name}", retries=1)

    async def list_instances(self) -> list:
        return await self._client.request("GET", "/instance/fetchInstances", retries=1)

    async def reconnect_instance(self, instance_name: str) -> dict:
        logger.info("instance_restart_requested", instance=instance_name)
        try:
            return await self._client.request("POST", f"/instance/restart/{instance_name}", retries=1)
        except EvolutionError as exc:
            if exc.status_code in (404, 405):
                logger.warning("instance_restart_fallback_put", instance=instance_name)
                return await self._client.request("PUT", f"/instance/restart/{instance_name}", retries=1)
            raise

    async def disconnect_instance(self, instance_name: str) -> dict:
        logger.info("instance_logout_requested", instance=instance_name)
        return await self._client.request("DELETE", f"/instance/logout/{instance_name}", retries=1)

    async def delete_instance(self, instance_name: str) -> dict:
        logger.warning("instance_delete_requested", instance=instance_name)
        return await self._client.request("DELETE", f"/instance/delete/{instance_name}", retries=1)

    async def send_text(self, instance_name: str, number: str, text: str) -> dict:
        logger.info("text_send_requested", instance=instance_name, recipient=number)
        return await self._client.request(
            "POST",
            f"/message/sendText/{instance_name}",
            json={"number": number, "text": text},
            retries=0,
        )

    async def send_media(
        self,
        instance_name: str,
        number: str,
        media_payload: str,
        mediatype: str,
        mimetype: str,
        file_name: str,
        caption: str = "",
    ) -> dict:
        raw_media = (media_payload or "").strip()
        if not raw_media:
            raise EvolutionError(message="Payload media invalido: contenido vacio", status_code=400, retryable=False)

        if _HTTP_URL_RE.match(raw_media):
            return await self._client.request(
                "POST",
                f"/message/sendMedia/{instance_name}",
                json=self._build_send_media_payload(number, mediatype, raw_media, mimetype, file_name, caption),
                retries=0,
            )

        media_prefix_ok = bool(_DATA_URI_RE.match(raw_media))
        media_b64 = raw_media.split(",", 1)[1] if media_prefix_ok else raw_media
        try:
            base64.b64decode(media_b64, validate=True)
            media_b64_ok = True
        except Exception:
            media_b64_ok = False

        if not media_b64_ok:
            raise EvolutionError(
                message="Payload media invalido: se esperaba base64 valido (raw o data URI)",
                status_code=400,
                detail={"media_prefix_ok": media_prefix_ok, "media_b64_ok": media_b64_ok},
                retryable=False,
            )

        payload_b = self._build_send_media_payload(number, mediatype, media_b64, "", file_name, "")
        attempts: list[dict[str, Any]] = []

        if media_prefix_ok:
            payload_a = dict(payload_b)
            payload_a["media"] = raw_media
            try:
                result = await self._client.request("POST", f"/message/sendMedia/{instance_name}", json=payload_a, retries=0)
                logger.info(
                    "evolution_send_media_ab",
                    endpoint=f"/message/sendMedia/{instance_name}",
                    test="A_data_uri",
                    status=201,
                    accepted_format="data_uri",
                )
                return result
            except EvolutionError as exc:
                attempts.append({"test": "A_data_uri", "status": exc.status_code, "error": str(exc)})
                logger.warning(
                    "evolution_send_media_ab",
                    endpoint=f"/message/sendMedia/{instance_name}",
                    test="A_data_uri",
                    status=exc.status_code,
                    error=str(exc),
                )

        try:
            result = await self._client.request("POST", f"/message/sendMedia/{instance_name}", json=payload_b, retries=0)
            logger.info(
                "evolution_send_media_ab",
                endpoint=f"/message/sendMedia/{instance_name}",
                test="B_raw_base64",
                status=201,
                accepted_format="raw_base64",
            )
            return result
        except EvolutionError as exc:
            attempts.append({"test": "B_raw_base64", "status": exc.status_code, "error": str(exc)})
            logger.warning(
                "evolution_send_media_ab",
                endpoint=f"/message/sendMedia/{instance_name}",
                test="B_raw_base64",
                status=exc.status_code,
                error=str(exc),
            )
            raise EvolutionError(
                message=f"Evolution rechazo media en A/B: {attempts}",
                status_code=exc.status_code,
                detail={"attempts": attempts},
                retryable=exc.retryable,
            ) from exc

    def _build_send_media_payload(
        self,
        number: str,
        mediatype: str,
        media: str,
        mimetype: str,
        file_name: str,
        caption: str,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"number": number, "mediatype": mediatype, "media": media}
        if file_name:
            payload["fileName"] = file_name
        if caption:
            payload["caption"] = caption
        if mimetype:
            payload["mimetype"] = mimetype
        return payload

    async def send_buttons(self, instance_name: str, payload: dict) -> dict:
        return await self._client.request("POST", f"/message/sendButtons/{instance_name}", json=payload, retries=0)

    async def send_list(self, instance_name: str, payload: dict) -> dict:
        return await self._client.request("POST", f"/message/sendList/{instance_name}", json=payload, retries=0)

    async def configure_webhook(self, instance_name: str, url: str, events: list[str]) -> dict:
        payload = {
            "webhook": {
                "enabled": True,
                "url": url,
                "webhookByEvents": False,
                "webhookBase64": False,
                "events": events,
            }
        }
        return await self._client.request("POST", f"/webhook/set/{instance_name}", json=payload, retries=1)

    async def get_webhook(self, instance_name: str) -> dict:
        return await self._client.request("GET", f"/webhook/find/{instance_name}", retries=1)

    async def check_whatsapp_numbers(self, instance_name: str, numbers: list[str]) -> list:
        return await self._client.request(
            "POST",
            f"/chat/whatsappNumbers/{instance_name}",
            json={"numbers": numbers},
            retries=0,
        )

    async def get_base64_from_media_message(
        self,
        instance_name: str,
        *,
        message_key: dict[str, Any],
        message_object: dict[str, Any] | None = None,
        convert_to_mp4: bool = False,
    ) -> str:
        if not isinstance(message_key, dict) or not str(message_key.get("id") or "").strip():
            raise EvolutionError(
                message="No se pudo descifrar media: falta message.key.id",
                status_code=422,
                retryable=False,
            )

        body: dict[str, Any] = {
            "message": {
                "key": message_key,
            },
            "convertToMp4": bool(convert_to_mp4),
        }
        if isinstance(message_object, dict) and message_object:
            body["message"]["message"] = message_object

        result = await self._client.request(
            "POST",
            f"/chat/getBase64FromMediaMessage/{instance_name}",
            json=body,
            retries=0,
        )
        candidate = self._find_base64_candidate(result)
        if not candidate:
            raise EvolutionError(
                message="Evolution no devolvio base64 para media message",
                status_code=502,
                detail={
                    "endpoint": f"/chat/getBase64FromMediaMessage/{instance_name}",
                    "response_type": type(result).__name__,
                },
                retryable=False,
            )
        return candidate

    def _find_base64_candidate(self, node: Any) -> str | None:
        if isinstance(node, str):
            text = node.strip()
            if text.startswith("data:") and ";base64," in text:
                return text.split(";base64,", 1)[1].strip()
            if text and len(text) > 60:
                try:
                    base64.b64decode(text, validate=True)
                    return text
                except Exception:
                    return None
            return None
        if isinstance(node, dict):
            for key in ("base64", "data", "media", "file", "content"):
                if key in node:
                    found = self._find_base64_candidate(node.get(key))
                    if found:
                        return found
            for value in node.values():
                found = self._find_base64_candidate(value)
                if found:
                    return found
        if isinstance(node, list):
            for item in node:
                found = self._find_base64_candidate(item)
                if found:
                    return found
        return None


_adapter = EvolutionAdapter()


def get_evolution_adapter() -> EvolutionAdapter:
    return _adapter
