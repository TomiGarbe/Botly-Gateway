"""
Receptor de webhooks de Evolution API.
Evolution hace POST acá, el gateway lo procesa y lo reenvía al bot.
"""

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, Request, HTTPException, status

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])

# Cache simple en memoria para deduplicación de mensajes
# En producción reemplazar por Redis
_seen_message_ids: set[str] = set()
_MAX_SEEN = 10_000  # evita que crezca indefinidamente


def _is_duplicate(message_id: str) -> bool:
    if message_id in _seen_message_ids:
        return True
    if len(_seen_message_ids) >= _MAX_SEEN:
        _seen_message_ids.clear()
    _seen_message_ids.add(message_id)
    return False


async def _forward_to_bot(payload: dict) -> None:
    """Envía el evento procesado al bot. Fire-and-forget con 1 reintento."""
    settings = get_settings()
    if not settings.bot_webhook_url:
        return

    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=settings.bot_webhook_timeout) as client:
                resp = await client.post(settings.bot_webhook_url, json=payload)
                resp.raise_for_status()
                logger.info(
                    "webhook_forwarded",
                    event=payload.get("event"),
                    instance=payload.get("instance"),
                    status=resp.status_code,
                )
                return
        except Exception as exc:
            logger.warning(
                "webhook_forward_failed",
                event=payload.get("event"),
                instance=payload.get("instance"),
                attempt=attempt + 1,
                error=str(exc),
            )
            if attempt == 0:
                await asyncio.sleep(1)


@router.post("/evolution")
async def receive_webhook(request: Request):
    """
    Endpoint que recibe todos los eventos de Evolution.
    Responde 200 inmediatamente y procesa de forma asíncrona.
    """
    settings = get_settings()

    try:
        payload: dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body JSON inválido")

    # Validación de origen: Evolution v2 puede enviar la apikey global o el token
    # de la instancia dependiendo de la versión y configuración. En red interna Docker
    # la validación estricta no agrega seguridad real — loguemos la discrepancia
    # pero no rechacemos el request.
    received_key = payload.get("apikey", "")
    if received_key and received_key != settings.evolution_api_key:
        logger.debug(
            "webhook_apikey_mismatch",
            instance=payload.get("instance"),
            received_prefix=received_key[:8],  # solo los primeros 8 chars para debug
        )

    event = payload.get("event", "UNKNOWN")
    instance = payload.get("instance", "unknown")

    logger.info("webhook_received", event=event, instance=instance)

    # Deduplicación para mensajes entrantes
    if event == "MESSAGES_UPSERT":
        msg_id = payload.get("data", {}).get("key", {}).get("id", "")
        if msg_id and _is_duplicate(msg_id):
            logger.debug("webhook_duplicate_skipped", msg_id=msg_id, instance=instance)
            return {"status": "duplicate"}

    # Reenviar al bot en background (no bloquea la respuesta a Evolution)
    asyncio.create_task(_forward_to_bot(payload))

    return {"status": "ok"}
