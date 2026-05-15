"""
Receptor de webhooks de Evolution API.
Evolution hace POST aca, el gateway lo procesa y lo reenvia al bot.
"""

import asyncio
import random
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, status

from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.normalization import list_events, normalize_webhook, save_event, save_pipeline_event, save_raw_event
from app.services.reliability import (
    conversation_id,
    inbound_dedupe,
    is_flood,
    looks_like_outbound_echo,
    message_fingerprint,
)

logger = get_logger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])
settings = get_settings()

_forward_semaphore = asyncio.Semaphore(max(1, settings.bot_webhook_max_parallel))
_forward_tasks: set[asyncio.Task] = set()


def _track_background_task(task: asyncio.Task) -> None:
    _forward_tasks.add(task)

    def _cleanup(done: asyncio.Task) -> None:
        _forward_tasks.discard(done)

    task.add_done_callback(_cleanup)


async def shutdown_forward_workers(timeout_s: float = 3.0) -> None:
    if not _forward_tasks:
        return
    to_cancel = list(_forward_tasks)
    for task in to_cancel:
        if not task.done():
            task.cancel()
    try:
        await asyncio.wait(to_cancel, timeout=timeout_s)
    except Exception:
        return


async def _forward_to_bot(payload: dict[str, Any], request_id: str) -> None:
    if not settings.bot_webhook_url:
        save_pipeline_event(
            stage="forward_to_bot",
            status="skipped_no_target",
            instance=payload.get("instance"),
            message_id=(payload.get("message") or {}).get("id"),
            conversation_id=(payload.get("meta") or {}).get("conversationId"),
            request_id=request_id,
        )
        return

    max_attempts = max(1, settings.bot_webhook_retries + 1)
    start = time.perf_counter()

    async with _forward_semaphore:
        for attempt in range(max_attempts):
            try:
                timeout = httpx.Timeout(
                    connect=min(5.0, float(settings.bot_webhook_timeout)),
                    read=float(settings.bot_webhook_timeout),
                    write=min(8.0, float(settings.bot_webhook_timeout)),
                    pool=2.0,
                )
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(settings.bot_webhook_url, json=payload)
                    if resp.status_code >= 500:
                        raise httpx.HTTPStatusError(
                            f"Server error {resp.status_code}",
                            request=resp.request,
                            response=resp,
                        )
                    resp.raise_for_status()
                    latency_ms = round((time.perf_counter() - start) * 1000, 2)
                    logger.info(
                        "webhook_forwarded",
                        request_id=request_id,
                        source_event=payload.get("event"),
                        instance=payload.get("instance"),
                        status=resp.status_code,
                        attempt=attempt + 1,
                        latency_ms=latency_ms,
                    )
                    save_pipeline_event(
                        stage="forward_to_bot",
                        status="ok",
                        instance=payload.get("instance"),
                        message_id=(payload.get("message") or {}).get("id"),
                        conversation_id=(payload.get("meta") or {}).get("conversationId"),
                        request_id=request_id,
                        details={"attempt": attempt + 1, "statusCode": resp.status_code, "latencyMs": latency_ms},
                    )
                    return
            except httpx.TimeoutException as exc:
                error_type = "timeout"
                retryable = True
                err = str(exc)
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                error_type = f"http_{code}"
                retryable = code >= 500 or code in (408, 429)
                err = exc.response.text[:220] or str(exc)
            except Exception as exc:
                error_type = "transport"
                retryable = True
                err = str(exc)

            has_next = (attempt + 1) < max_attempts and retryable
            logger.warning(
                "webhook_forward_failed",
                request_id=request_id,
                source_event=payload.get("event"),
                instance=payload.get("instance"),
                attempt=attempt + 1,
                retryable=has_next,
                error_type=error_type,
                error=err,
            )
            save_pipeline_event(
                stage="forward_to_bot",
                status="retrying" if has_next else "failed",
                instance=payload.get("instance"),
                message_id=(payload.get("message") or {}).get("id"),
                conversation_id=(payload.get("meta") or {}).get("conversationId"),
                request_id=request_id,
                details={"attempt": attempt + 1, "errorType": error_type, "error": err[:180]},
            )
            if has_next:
                sleep_s = (settings.bot_webhook_backoff_base_ms / 1000.0) * (2**attempt) + random.uniform(0, 0.2)
                await asyncio.sleep(min(4.0, sleep_s))


def _to_bot_payload(normalized: dict[str, Any]) -> dict[str, Any] | None:
    if normalized.get("layer") != "business":
        return None
    if normalized.get("type") != "message":
        return None

    message_type = str(normalized.get("messageType") or "")
    if message_type not in {"text", "audio", "image", "video", "document", "sticker", "voice_note"}:
        return None

    return {
        "id": normalized.get("id"),
        "type": "message",
        "instance": normalized.get("instance"),
        "timestamp": normalized.get("timestamp"),
        "direction": normalized.get("direction"),
        "messageType": message_type,
        "sender": normalized.get("sender"),
        "recipient": normalized.get("recipient"),
        "text": normalized.get("text"),
        "content": normalized.get("content"),
        "media": normalized.get("media"),
        "status": normalized.get("status"),
        "meta": normalized.get("meta"),
    }


@router.post("/evolution")
async def receive_webhook(request: Request):
    """
    Endpoint que recibe todos los eventos de Evolution.
    Responde 200 inmediatamente y procesa de forma asincrona.
    """

    try:
        payload: dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body JSON invalido")

    received_key = payload.get("apikey", "")
    if received_key and received_key != settings.evolution_api_key:
        logger.debug(
            "webhook_apikey_mismatch",
            instance=payload.get("instance"),
            received_prefix=received_key[:8],
        )

    event = str(payload.get("event", "UNKNOWN"))
    instance = str(payload.get("instance", "unknown"))
    request_id = str(uuid.uuid4())[:12]

    logger.debug("webhook_received", request_id=request_id, source_event=event, instance=instance)

    normalized = normalize_webhook(payload)
    save_raw_event({"requestId": request_id, "payload": payload, "normalized": normalized, "timestamp": int(time.time() * 1000)})
    if normalized.get("layer") == "technical":
        logger.debug(
            "webhook_technical_ignored",
            request_id=request_id,
            source_event=event,
            instance=instance,
            reason=normalized.get("reason"),
        )
        return {"status": "ignored_technical"}

    save_pipeline_event(
        stage="webhook_received",
        status="ok",
        instance=instance,
        request_id=request_id,
        event=event,
    )

    message = normalized.get("message") or {}
    msg_id = str(message.get("id") or "")
    conv_id = conversation_id(instance, message.get("from"))
    normalized["meta"] = {"requestId": request_id, "conversationId": conv_id}

    if event == "MESSAGES_UPSERT":
        if msg_id and inbound_dedupe.exists(msg_id):
            save_pipeline_event(
                stage="dedupe",
                status="skipped_duplicate_id",
                instance=instance,
                message_id=msg_id,
                conversation_id=conv_id,
                request_id=request_id,
            )
            logger.warning("duplicate_message_ignored", request_id=request_id, instance=instance, message_id=msg_id)
            return {"status": "duplicate"}
        if msg_id:
            inbound_dedupe.put(msg_id)

        fp = message_fingerprint(
            instance=instance,
            remote_jid=message.get("from"),
            kind=message.get("kind"),
            text=message.get("text"),
            media_id=(normalized.get("media") or {}).get("id") if normalized.get("media") else None,
        )
        if inbound_dedupe.exists(fp):
            save_pipeline_event(
                stage="dedupe",
                status="skipped_duplicate_fingerprint",
                instance=instance,
                message_id=msg_id,
                conversation_id=conv_id,
                request_id=request_id,
            )
            logger.warning("duplicate_fingerprint_ignored", request_id=request_id, instance=instance, message_id=msg_id)
            return {"status": "duplicate_fp"}
        inbound_dedupe.put(fp)

        if bool(message.get("fromMe")):
            save_pipeline_event(
                stage="anti_loop",
                status="skipped_from_me",
                instance=instance,
                message_id=msg_id,
                conversation_id=conv_id,
                request_id=request_id,
            )
            logger.debug("loop_prevented_from_me", request_id=request_id, instance=instance, message_id=msg_id)
            return {"status": "from_me"}

        payload_text = str(message.get("text") or (normalized.get("media") or {}).get("caption") or "")
        if looks_like_outbound_echo(instance, message.get("from"), str(message.get("kind") or "unknown"), payload_text):
            save_pipeline_event(
                stage="anti_loop",
                status="skipped_outbound_echo",
                instance=instance,
                message_id=msg_id,
                conversation_id=conv_id,
                request_id=request_id,
            )
            logger.warning("outbound_echo_ignored", request_id=request_id, instance=instance, message_id=msg_id)
            return {"status": "echo_filtered"}

        flooded, count = is_flood(conv_id)
        if flooded:
            save_pipeline_event(
                stage="flood_guard",
                status="throttled",
                instance=instance,
                message_id=msg_id,
                conversation_id=conv_id,
                request_id=request_id,
                details={"messagesInWindow": count},
            )
            logger.warning("conversation_throttled", request_id=request_id, instance=instance, message_id=msg_id, messages_in_window=count)
            return {"status": "throttled"}

    save_event(normalized)
    save_pipeline_event(
        stage="normalized",
        status="ok",
        instance=instance,
        message_id=msg_id or None,
        conversation_id=conv_id,
        request_id=request_id,
    )

    normalized_kind = (normalized.get("message") or {}).get("kind")
    if normalized_kind == "text":
        logger.info(
            "incoming_text_message",
            request_id=request_id,
            instance=normalized.get("instance"),
            sender=normalized.get("sender"),
        )
    else:
        logger.info(
            "webhook_normalized",
            request_id=request_id,
            source_event=normalized.get("event"),
            instance=normalized.get("instance"),
            kind=normalized_kind,
        )

    bot_payload = _to_bot_payload(normalized)
    if not bot_payload:
        logger.debug(
            "webhook_not_forwarded_non_business",
            request_id=request_id,
            instance=instance,
            layer=normalized.get("layer"),
            event_type=normalized.get("type"),
            message_type=normalized.get("messageType"),
        )
        return {"status": "not_forwarded"}

    if len(_forward_tasks) >= settings.bot_webhook_max_queue:
        save_pipeline_event(
            stage="forward_to_bot",
            status="dropped_queue_full",
            instance=instance,
            message_id=msg_id or None,
            conversation_id=conv_id,
            request_id=request_id,
            details={"queueSize": len(_forward_tasks)},
        )
        logger.error("webhook_forward_dropped_queue_full", queue_size=len(_forward_tasks))
        return {"status": "queued_dropped"}

    task = asyncio.create_task(_forward_to_bot(bot_payload, request_id))
    _track_background_task(task)

    return {"status": "ok"}


@router.get("/events")
async def get_events(instance: str | None = None, limit: int = 100):
    safe_limit = max(1, min(limit, 500))
    return {"items": list_events(instance=instance, limit=safe_limit)}
