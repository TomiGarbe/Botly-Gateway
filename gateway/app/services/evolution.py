"""
Cliente HTTP para Evolution API v2.
Todas las llamadas a Evolution pasan por acá — nunca desde los routers directamente.
"""

from typing import Any

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _client() -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        base_url=settings.evolution_url,
        headers={"apikey": settings.evolution_api_key, "Content-Type": "application/json"},
        timeout=30.0,
    )


async def _request(method: str, path: str, **kwargs) -> Any:
    async with _client() as client:
        response = await client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()


# ── Instancias ────────────────────────────────────────────────────────────────

async def create_instance(instance_name: str, qrcode: bool = True, token: str | None = None) -> dict:
    payload: dict[str, Any] = {
        "instanceName": instance_name,
        "integration": "WHATSAPP-BAILEYS",
        "qrcode": qrcode,
    }
    if token:
        payload["token"] = token
    logger.info("evolution.create_instance", instance=instance_name)
    return await _request("POST", "/instance/create", json=payload)


async def get_qr(instance_name: str) -> dict:
    return await _request("GET", f"/instance/connect/{instance_name}")


async def get_connection_state(instance_name: str) -> dict:
    return await _request("GET", f"/instance/connectionState/{instance_name}")


async def fetch_instances() -> list:
    return await _request("GET", "/instance/fetchInstances")


async def logout_instance(instance_name: str) -> dict:
    logger.info("evolution.logout_instance", instance=instance_name)
    return await _request("DELETE", f"/instance/logout/{instance_name}")


async def delete_instance(instance_name: str) -> dict:
    logger.warning("evolution.delete_instance", instance=instance_name)
    return await _request("DELETE", f"/instance/delete/{instance_name}")


# ── Mensajes ──────────────────────────────────────────────────────────────────

async def send_text(instance_name: str, number: str, text: str) -> dict:
    logger.info("evolution.send_text", instance=instance_name, to=number)
    return await _request(
        "POST",
        f"/message/sendText/{instance_name}",
        json={"number": number, "text": text},
    )


async def send_media(
    instance_name: str,
    number: str,
    media_url: str,
    mediatype: str,
    caption: str = "",
) -> dict:
    return await _request(
        "POST",
        f"/message/sendMedia/{instance_name}",
        json={"number": number, "mediatype": mediatype, "media": media_url, "caption": caption},
    )


async def send_buttons(instance_name: str, payload: dict) -> dict:
    return await _request("POST", f"/message/sendButtons/{instance_name}", json=payload)


async def send_list(instance_name: str, payload: dict) -> dict:
    return await _request("POST", f"/message/sendList/{instance_name}", json=payload)


# ── Webhooks ──────────────────────────────────────────────────────────────────

async def set_webhook(instance_name: str, url: str, events: list[str]) -> dict:
    payload = {
        "webhook": {
            "enabled": True,
            "url": url,
            "webhookByEvents": False,
            "webhookBase64": False,
            "events": events,
        }
    }
    return await _request("POST", f"/webhook/set/{instance_name}", json=payload)


async def get_webhook(instance_name: str) -> dict:
    return await _request("GET", f"/webhook/find/{instance_name}")


# ── Utilidades ────────────────────────────────────────────────────────────────

async def check_whatsapp_numbers(instance_name: str, numbers: list[str]) -> list:
    return await _request(
        "POST",
        f"/chat/whatsappNumbers/{instance_name}",
        json={"numbers": numbers},
    )
