"""Official Meta WhatsApp Cloud API webhook.

Meta verifies this route with GET and sends signed notifications to the same URL
with POST.  Provider payloads are adapted to the existing Gateway event pipeline
so Cloud and Evolution-originated events have one downstream contract.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import PlainTextResponse

from app.core.config import get_settings
from app.core.logging import get_logger
from app.routers.webhooks import _to_bot_payload, _forward_to_instance_webhooks, _track_background_task, _forward_tasks
from app.services.audit import audit_event
from app.services.credential_manager import get_credential_manager
from app.services.event_pipeline import process_incoming_webhook
from app.services.normalization import save_pipeline_event

router = APIRouter(prefix="/webhooks", tags=["meta-webhook"])
logger = get_logger(__name__)


def _constant_time_equals(actual: str | None, expected: str) -> bool:
    return bool(actual and expected and hmac.compare_digest(actual, expected))


def _signature_is_valid(body: bytes, signature: str | None, app_secret: str) -> bool:
    if not signature or not signature.startswith("sha256=") or not app_secret:
        return False
    expected = hmac.new(app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature.removeprefix("sha256="), expected)


@router.get("/meta", response_class=PlainTextResponse, include_in_schema=False)
async def verify_meta_webhook(request: Request) -> PlainTextResponse:
    """Return exactly hub.challenge when Meta validates the subscription."""
    settings = get_settings()
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")
    logger.info(
        "[META_INBOUND][VERIFY] webhook verification requested",
        mode=mode,
        has_token=bool(token),
        has_challenge=bool(challenge),
    )
    if mode != "subscribe" or not challenge or not _constant_time_equals(token, settings.meta_webhook_verify_token):
        logger.warning(
            "[META_INBOUND][VERIFY][FAILED] webhook verification rejected",
            mode=mode,
            has_token=bool(token),
            has_challenge=bool(challenge),
            reason="invalid_mode_missing_challenge_or_verify_token",
        )
        audit_event("meta_webhook_verification_failed", mode=mode, hasToken=bool(token), hasChallenge=bool(challenge))
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Meta webhook verification failed")
    logger.info("[META_INBOUND][VERIFY][OK] webhook verification completed")
    audit_event("meta_webhook_verified")
    return PlainTextResponse(challenge, status_code=status.HTTP_200_OK)


def _phone_number_id(value: dict[str, Any]) -> str:
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    return str(metadata.get("phone_number_id") or "").strip()


def _message_data(message: dict[str, Any], contacts: list[dict[str, Any]]) -> dict[str, Any]:
    sender = str(message.get("from") or "").strip()
    message_type = str(message.get("type") or "unknown").strip()
    content = message.get(message_type) if isinstance(message.get(message_type), dict) else {}
    push_name = next((str((item.get("profile") or {}).get("name") or "") for item in contacts if str(item.get("wa_id") or "") == sender), "")
    key = {"id": str(message.get("id") or ""), "remoteJid": f"{sender}@s.whatsapp.net", "fromMe": False}
    # The normalizer accepts Evolution-shaped messages.  Preserve the original
    # Cloud object under the type key so media/interactive payloads remain visible.
    if message_type == "text":
        message_object: dict[str, Any] = {"conversation": str(content.get("body") or "")}
        normalized_type = "conversation"
    elif message_type == "interactive":
        reply = content.get("button_reply") or content.get("list_reply") or {}
        message_object = {"interactiveResponseMessage": {"body": {"text": str(reply.get("title") or reply.get("id") or "")}, "nativeFlowResponseMessage": {"paramsJson": json.dumps(reply)}}}
        normalized_type = "interactiveResponseMessage"
    else:
        key_name = {"image": "imageMessage", "audio": "audioMessage", "video": "videoMessage", "document": "documentMessage", "sticker": "stickerMessage", "location": "locationMessage", "contacts": "contactsArrayMessage", "reaction": "reactionMessage"}.get(message_type, message_type)
        message_object = {key_name: content}
        normalized_type = key_name
    return {"key": key, "pushName": push_name or None, "messageTimestamp": message.get("timestamp"), "messageType": normalized_type, "message": message_object}


async def _process_cloud_event(*, instance: str, event: dict[str, Any]) -> str:
    request_id = str(uuid.uuid4())[:12]
    result = process_incoming_webhook(event, request_id)
    normalized = result.get("normalized") or {}
    if result.get("status") != "ok":
        outcome = str(result.get("status") or "ignored")
        logger.warning(
            "[META_INBOUND][PIPELINE][STOPPED] message was not eligible for forwarding",
            request_id=request_id,
            instance=instance,
            outcome=outcome,
            trace=result.get("trace"),
        )
        return outcome

    message = normalized.get("message") if isinstance(normalized.get("message"), dict) else {}
    sender = str(message.get("from") or "").strip() or None
    conversation_id = str((normalized.get("meta") or {}).get("conversationId") or "").strip() or None
    contact_name = message.get("pushName") or None
    # The Gateway has no contact/conversation repository.  These two logs make
    # that intentional contract visible during the incoming-message audit.
    logger.info(
        "[META_INBOUND][CONTACT] contact context resolved",
        request_id=request_id,
        instance=instance,
        sender=sender,
        contact_name=contact_name,
        operation="no_contact_entity_store",
    )
    logger.info(
        "[META_INBOUND][CONVERSATION] conversation id derived",
        request_id=request_id,
        instance=instance,
        conversation_id=conversation_id,
        operation="no_conversation_entity_store",
    )
    payload = _to_bot_payload(normalized)
    if not payload:
        logger.warning(
            "[META_INBOUND][FRONTEND][SKIPPED] normalized event has no dispatchable business payload",
            request_id=request_id,
            instance=instance,
            layer=normalized.get("layer"),
            event_type=normalized.get("type"),
        )
        return "not_forwarded"
    if len(_forward_tasks) >= get_settings().bot_webhook_max_queue:
        logger.error(
            "[META_INBOUND][FRONTEND][FAILED] outbound event queue is full",
            request_id=request_id,
            instance=instance,
            queue_size=len(_forward_tasks),
        )
        return "queued_dropped"
    _track_background_task(asyncio.create_task(_forward_to_instance_webhooks(payload, request_id)))
    logger.info(
        "[META_INBOUND][FRONTEND] event queued for configured Gateway webhook targets",
        request_id=request_id,
        instance=instance,
        message_id=message.get("id") or None,
        conversation_id=conversation_id,
        queue_size=len(_forward_tasks),
        frontend_delivery="not_realtime; frontend reads /webhooks/events",
    )
    persist = result.get("trace", {}).get("persist", {})
    if persist.get("status") == "ok":
        logger.info(
            "[META_INBOUND][COMPLETE][OK] message processing completed successfully",
            request_id=request_id,
            instance=instance,
            message_id=message.get("id") or None,
            conversation_id=conversation_id,
        )
    else:
        logger.error(
            "[META_INBOUND][COMPLETE][FAILED] forwarding was queued but persistence failed",
            request_id=request_id,
            instance=instance,
            message_id=message.get("id") or None,
            conversation_id=conversation_id,
            error=persist.get("error") or "missing_persistence_confirmation",
        )
    return "queued"


@router.post("/meta", status_code=status.HTTP_200_OK, include_in_schema=False)
async def receive_meta_webhook(request: Request) -> dict[str, Any]:
    """Accept Meta-signed WhatsApp messages, status changes and errors."""
    settings = get_settings()
    body = await request.body()
    request_id = str(uuid.uuid4())[:12]
    source_ip = request.client.host if request.client else "unknown"
    signature = request.headers.get("X-Hub-Signature-256")
    logger.info(
        "[META_INBOUND][RECEIVED] webhook received",
        request_id=request_id,
        source_ip=source_ip,
        content_length=len(body),
        signature_required=bool(settings.meta_webhook_require_signature),
        has_signature=bool(signature),
    )
    if settings.meta_webhook_require_signature and not _signature_is_valid(body, signature, settings.meta_app_secret):
        logger.warning(
            "[META_INBOUND][SIGNATURE][FAILED] invalid Meta webhook signature",
            request_id=request_id,
            has_signature=bool(signature),
            has_app_secret=bool(settings.meta_app_secret),
            reason="missing_or_invalid_x_hub_signature_256",
        )
        audit_event("meta_webhook_signature_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Meta webhook signature")
    logger.info(
        "[META_INBOUND][SIGNATURE][OK] Meta webhook signature accepted",
        request_id=request_id,
        validation="required" if settings.meta_webhook_require_signature else "disabled_by_configuration",
    )
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        logger.warning(
            "[META_INBOUND][PAYLOAD][FAILED] invalid JSON payload",
            request_id=request_id,
            error=str(exc),
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Meta webhook JSON") from exc
    if not isinstance(payload, dict) or payload.get("object") != "whatsapp_business_account":
        logger.warning(
            "[META_INBOUND][PAYLOAD][FAILED] unsupported webhook object",
            request_id=request_id,
            object=payload.get("object") if isinstance(payload, dict) else None,
            payload_type=type(payload).__name__,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported Meta webhook object")

    logger.info(
        "[META_INBOUND][PAYLOAD][OK] payload validated",
        request_id=request_id,
        entries=len(payload.get("entry") or []),
    )

    received = {"messages": 0, "statuses": 0, "changes": 0, "errors": 0, "unmapped": 0}
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            received["changes"] += 1
            value = change.get("value") if isinstance(change.get("value"), dict) else {}
            phone_id = _phone_number_id(value)
            logger.info(
                "[META_INBOUND][CHANGE] Meta change detected",
                request_id=request_id,
                field=change.get("field"),
                phone_number_id=phone_id or None,
                messages=len(value.get("messages") or []),
                statuses=len(value.get("statuses") or []),
                errors=len(value.get("errors") or []),
            )
            instance = get_credential_manager().find_instance_by_phone_number_id(phone_id)
            if not instance:
                received["unmapped"] += 1
                logger.warning(
                    "[META_INBOUND][INSTANCE][FAILED] no Gateway instance matches Meta phone number",
                    request_id=request_id,
                    phone_number_id=phone_id or None,
                    field=change.get("field"),
                    reason="phone_number_id_not_found_in_official_credentials",
                )
                audit_event("meta_webhook_instance_unmapped", phoneNumberId=phone_id or None, field=change.get("field"))
                continue
            logger.info(
                "[META_INBOUND][INSTANCE][OK] Gateway instance resolved",
                request_id=request_id,
                instance=instance,
                phone_number_id=phone_id or None,
            )
            save_pipeline_event(
                stage="meta_webhook_change",
                status="received",
                instance=instance,
                event=str(change.get("field") or "unknown"),
                details={
                    "hasMessages": bool(value.get("messages")),
                    "hasStatuses": bool(value.get("statuses")),
                    "hasErrors": bool(value.get("errors")),
                },
            )
            contacts = [item for item in value.get("contacts") or [] if isinstance(item, dict)]
            for message in value.get("messages") or []:
                if not isinstance(message, dict):
                    logger.warning("[META_INBOUND][MESSAGE][SKIPPED] messages item is not an object", request_id=request_id, instance=instance)
                    continue
                received["messages"] += 1
                logger.info(
                    "[META_INBOUND][MESSAGE] incoming message detected",
                    request_id=request_id,
                    instance=instance,
                    message_id=message.get("id") or None,
                    sender=message.get("from") or None,
                    message_type=message.get("type") or None,
                )
                try:
                    outcome = await _process_cloud_event(instance=instance, event={"event": "MESSAGES_UPSERT", "instance": instance, "data": _message_data(message, contacts), "metaCloud": payload})
                    logger.info(
                        "[META_INBOUND][MESSAGE][RESULT] message pipeline finished",
                        request_id=request_id,
                        instance=instance,
                        message_id=message.get("id") or None,
                        outcome=outcome,
                    )
                except Exception as exc:
                    logger.exception(
                        "[META_INBOUND][MESSAGE][FAILED] unhandled pipeline exception",
                        request_id=request_id,
                        instance=instance,
                        message_id=message.get("id") or None,
                        error=str(exc),
                    )
                    raise
            for item in value.get("statuses") or []:
                if not isinstance(item, dict):
                    continue
                received["statuses"] += 1
                await _process_cloud_event(instance=instance, event={"event": "MESSAGES_UPDATE", "instance": instance, "data": {"key": {"id": str(item.get("id") or ""), "remoteJid": str(item.get("recipient_id") or ""), "fromMe": True}, "status": item.get("status"), "timestamp": item.get("timestamp")}, "metaCloud": payload})
            for error in value.get("errors") or []:
                received["errors"] += 1
                logger.error("meta_webhook_provider_error", instance=instance, error_code=error.get("code") if isinstance(error, dict) else None)
                save_pipeline_event(stage="meta_webhook_error", status="received", instance=instance, details={"error": error})
    logger.info("[META_INBOUND][RESPONSE][OK] responding HTTP 200 to Meta", request_id=request_id, **received)
    audit_event("meta_webhook_received", **received)
    return {"status": "ok", **received}
