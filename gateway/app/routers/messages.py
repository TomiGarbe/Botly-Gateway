import time
import uuid
import base64
from io import StringIO
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import ValidationError

from app.connections import get_connection_manager
from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.requests import (
    SendTextRequest,
    SendMediaRequest,
    SendButtonsRequest,
    SendListRequest,
    CheckNumbersRequest,
    SendUploadedMediaRequest,
    SendMessageRequest,
)
from app.services.media import consume_uploaded_file, file_to_base64, get_uploaded_file
from app.services.normalization import save_business_event, save_event, save_pipeline_event
from app.services.reliability import mark_outbound
from app.platforms.meta import MetaPlatformError
from app.providers.whatsapp_official import get_official_whatsapp_provider
from app.services.credential_manager import get_credential_manager

logger = get_logger(__name__)
router = APIRouter(tags=["messages"])
_connection_manager = get_connection_manager()
_MEDIA_TYPES = {"image", "audio", "video", "document", "file", "pdf"}


def _normalize_media_type(raw: str, mime_type: str) -> str:
    value = (raw or "").strip().lower()
    if value in ("image", "audio", "video", "document"):
        return value
    if value == "pdf":
        return "document"
    if value == "file":
        if mime_type == "application/pdf":
            return "document"
        return "document"
    return "document"


def _clean_number(raw: Any) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _normalize_message_type(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if value in {"text", "image", "audio", "video", "document", "file", "pdf"}:
        return value
    return ""


def _validate_instance_name(raw: str) -> str:
    value = str(raw or "").strip()
    if not value or not all(ch.islower() or ch.isdigit() or ch == "_" for ch in value):
        logger.warning("invalid_instance", instance=value or None)
        raise HTTPException(status_code=400, detail="Nombre de instancia invalido")
    return value


async def _upload_file_to_base64(file: UploadFile, max_bytes: int) -> tuple[str, int]:
    size = 0
    encoded = StringIO()
    try:
        while True:
            chunk = await file.read(57 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise ValueError(f"Archivo excede {max_bytes} bytes")
            encoded.write(base64.b64encode(chunk).decode("ascii"))
    finally:
        await file.close()
    if size <= 0:
        raise ValueError("Archivo vacio")
    return encoded.getvalue(), size


def _validate_message_payload(payload: SendMessageRequest) -> tuple[str, str]:
    msg_type = _normalize_message_type(payload.type)
    number = _clean_number(payload.number)
    if len(number) < 8:
        raise HTTPException(status_code=422, detail="number invalido")

    if msg_type == "text":
        if not (payload.text or "").strip():
            raise HTTPException(status_code=422, detail="text es obligatorio para type=text")
    elif msg_type in _MEDIA_TYPES:
        if not any([(payload.mediaUrl or "").strip(), (payload.base64 or "").strip()]):
            raise HTTPException(status_code=422, detail="file/base64/mediaUrl es obligatorio para media")
    else:
        raise HTTPException(status_code=422, detail="type invalido")
    return number, msg_type


def _log_message_start(instance_name: str, msg_type: str, number: str, metadata: dict[str, Any] | None = None) -> None:
    safe_metadata = {
        str(key): type(value).__name__
        for key, value in (metadata or {}).items()
        if "token" not in str(key).lower() and "secret" not in str(key).lower()
    }
    logger.info("message_send_start", instance=instance_name, type=msg_type, number=number, metadata=safe_metadata)


def _log_message_success(instance_name: str, msg_type: str, number: str) -> None:
    logger.info("message_send_success", instance=instance_name, type=msg_type, number=number)


def _persist_local_outbound_event(
    *,
    instance_name: str,
    number: str,
    msg_type: str,
    text: str | None = None,
    caption: str | None = None,
    media: dict[str, Any] | None = None,
    evolution_result: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> None:
    content_text = (text or caption or "").strip()
    result = evolution_result if isinstance(evolution_result, dict) else {}
    key = result.get("key") if isinstance(result.get("key"), dict) else {}
    message = result.get("message") if isinstance(result.get("message"), dict) else {}
    nested_key = message.get("key") if isinstance(message.get("key"), dict) else {}
    message_id = str(
        result.get("messageId")
        or key.get("id")
        or nested_key.get("id")
        or f"local_{uuid.uuid4().hex[:12]}"
    )
    event = {
        "id": str(uuid.uuid4())[:16],
        "layer": "business",
        "event": "LOCAL_OUTBOUND_SEND",
        "instance": instance_name,
        "timestamp": int(time.time() * 1000),
        "direction": "outbound",
        "type": "message",
        "subtype": msg_type,
        "messageType": msg_type,
        "sender": instance_name,
        "recipient": number,
        "content": {"text": content_text} if content_text else {"text": ""},
        "text": content_text,
        "status": "sent",
        "fromMe": True,
        "fromBot": False,
        "forwarding": {"status": "local_api_send"},
        "error": None,
        "correlationId": correlation_id,
        "meta": {"requestId": correlation_id} if correlation_id else {},
        "message": {"id": message_id, "from": f"{number}@s.whatsapp.net", "fromMe": True, "kind": msg_type, "text": content_text},
        "media": media,
        "raw": {"source": "gateway_send_api", "providerResult": result},
    }
    save_event(event)
    logger.info("[OUTBOUND][PERSIST] local outbound persisted", instance=instance_name, number=number, message_type=msg_type, message_id=message_id)


def _received_json_log(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {"bodyType": type(data).__name__}
    return {
        "bodyType": "object",
        "keys": sorted(str(key) for key in data.keys()),
        "fieldTypes": {str(key): type(value).__name__ for key, value in data.items()},
        "number": _clean_number(data.get("number")),
        "type": str(data.get("type") or ""),
        "textLength": len(str(data.get("text") or "")),
    }


def _is_official_instance(instance_name: str) -> bool:
    return get_credential_manager().get_official_credentials_info(instance_name) is not None


async def _send_message_unified(instance_name: str, request: Request):
    instance_name = _validate_instance_name(instance_name)
    settings = get_settings()
    content_type = str(request.headers.get("content-type") or "").lower()

    try:
        if "multipart/form-data" in content_type:
            form = await request.form()
            logger.info(
                "message_send_request_received",
                instance=instance_name,
                content_type="multipart/form-data",
                fields=sorted(str(key) for key in form.keys()),
            )
            msg_type = _normalize_message_type(form.get("type"))
            number = _clean_number(form.get("number"))
            caption = str(form.get("caption") or "")
            text = str(form.get("text") or "")
            file = form.get("file")

            if len(number) < 8 or not msg_type:
                logger.warning("invalid_payload", instance=instance_name, reason="invalid_number_or_type")
                raise HTTPException(status_code=422, detail="Payload invalido")

            if msg_type == "text":
                if not text.strip():
                    logger.warning("invalid_payload", instance=instance_name, reason="missing_text")
                    raise HTTPException(status_code=422, detail="text es obligatorio para type=text")
                _log_message_start(instance_name, "text", number)
                logger.info("[OUTBOUND][SEND] gateway send request", instance=instance_name, number=number, message_type="text")
                outbound_fp = mark_outbound(instance_name, number, "text", text.strip())
                save_pipeline_event(
                    stage="send_whatsapp",
                    status="attempt",
                    instance=instance_name,
                    details={"kind": "text", "number": number, "outboundFingerprint": outbound_fp},
                )
                result = (
                    await get_official_whatsapp_provider().send_text(instance_name=instance_name, number=number, text=text.strip())
                    if _is_official_instance(instance_name)
                    else await _connection_manager.send_text(instance_name, number, text.strip())
                )
                _persist_local_outbound_event(
                    instance_name=instance_name,
                    number=number,
                    msg_type="text",
                    text=text.strip(),
                    evolution_result=result if isinstance(result, dict) else {},
                )
                save_pipeline_event(
                    stage="send_whatsapp",
                    status="accepted",
                    instance=instance_name,
                    message_id=str((result or {}).get("messageId") or "") or None if isinstance(result, dict) else None,
                    details={"kind": "text", "provider": "meta_whatsapp" if _is_official_instance(instance_name) else "evolution"},
                )
                _log_message_success(instance_name, "text", number)
                return result

            if msg_type not in _MEDIA_TYPES:
                logger.warning("unsupported_media", instance=instance_name, type=msg_type)
                raise HTTPException(status_code=422, detail="type invalido para media")
            if not isinstance(file, UploadFile):
                logger.warning("invalid_payload", instance=instance_name, reason="missing_file")
                raise HTTPException(status_code=422, detail="file es obligatorio para multipart media")

            normalized_media_type = _normalize_media_type(msg_type, (file.content_type or "").lower())
            _log_message_start(instance_name, normalized_media_type, number)
            try:
                media_base64, _ = await _upload_file_to_base64(file, settings.media_max_upload_mb * 1024 * 1024)
            except ValueError as exc:
                logger.error("upload_fail", instance=instance_name, error=str(exc))
                raise HTTPException(status_code=413, detail=str(exc)) from exc

            result = (
                await get_official_whatsapp_provider().send_media(
                    instance_name=instance_name,
                    number=number,
                    media_base64=media_base64,
                    media_type=normalized_media_type,
                    mime_type=(file.content_type or "application/octet-stream"),
                    file_name=(file.filename or "file.bin"),
                    caption=caption.strip(),
                )
                if _is_official_instance(instance_name)
                else await _connection_manager.send_media(
                    instance_name=instance_name,
                    number=number,
                    media_payload=media_base64,
                    mediatype=normalized_media_type,
                    mimetype=(file.content_type or "application/octet-stream"),
                    file_name=(file.filename or "file.bin"),
                    caption=caption.strip(),
                )
            )
            _persist_local_outbound_event(
                instance_name=instance_name,
                number=number,
                msg_type=normalized_media_type,
                caption=caption.strip(),
                media={
                    "id": str(uuid.uuid4())[:16],
                    "kind": normalized_media_type,
                    "mimeType": (file.content_type or "application/octet-stream"),
                    "fileName": (file.filename or "file.bin"),
                    "caption": caption.strip() or None,
                },
                evolution_result=result if isinstance(result, dict) else {},
            )
            _log_message_success(instance_name, normalized_media_type, number)
            return result

        data = await request.json()
        logger.info("message_send_request_received", instance=instance_name, content_type="application/json", payload=_received_json_log(data))
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=422,
                detail={"message": "El body JSON debe ser un objeto.", "field": "body", "receivedType": type(data).__name__},
            )
        payload = SendMessageRequest.model_validate(data)
        number, msg_type = _validate_message_payload(payload)
        correlation_id = str(payload.metadata.get("correlationId") or "").strip()[:120] or None
        logger.info(
            "message_send_payload_validated",
            instance=instance_name,
            payload={"number": number, "type": msg_type, "textLength": len((payload.text or "")), "metadataKeys": sorted(payload.metadata.keys())},
        )

        if msg_type == "text":
            _log_message_start(instance_name, "text", number, payload.metadata)
            logger.info("[OUTBOUND][SEND] gateway send request", instance=instance_name, number=number, message_type="text")
            outbound_fp = mark_outbound(instance_name, number, "text", (payload.text or "").strip())
            save_pipeline_event(
                stage="send_whatsapp",
                status="attempt",
                instance=instance_name,
                request_id=correlation_id,
                details={"kind": "text", "number": number, "outboundFingerprint": outbound_fp},
            )
            result = (
                await get_official_whatsapp_provider().send_text(
                    instance_name=instance_name,
                    number=number,
                    text=(payload.text or "").strip(),
                )
                if _is_official_instance(instance_name)
                else await _connection_manager.send_text(instance_name, number, (payload.text or "").strip())
            )
            _persist_local_outbound_event(
                instance_name=instance_name,
                number=number,
                msg_type="text",
                text=(payload.text or "").strip(),
                evolution_result=result if isinstance(result, dict) else {},
                correlation_id=correlation_id,
            )
            save_pipeline_event(
                stage="send_whatsapp",
                status="accepted",
                instance=instance_name,
                message_id=str((result or {}).get("messageId") or "") or None if isinstance(result, dict) else None,
                request_id=correlation_id,
                details={"kind": "text", "provider": "meta_whatsapp" if _is_official_instance(instance_name) else "evolution"},
            )
            _log_message_success(instance_name, "text", number)
            return result

        if msg_type not in _MEDIA_TYPES:
            logger.warning("unsupported_media", instance=instance_name, type=msg_type)
            raise HTTPException(status_code=422, detail="type invalido para media")
        normalized_media_type = _normalize_media_type(msg_type, "application/octet-stream")
        media_payload = (payload.mediaUrl or "").strip() or (payload.base64 or "").strip()
        _log_message_start(instance_name, normalized_media_type, number, payload.metadata)
        result = (
            await get_official_whatsapp_provider().send_media(
                instance_name=instance_name,
                number=number,
                media_base64=media_payload,
                media_type=normalized_media_type,
                mime_type="application/octet-stream",
                file_name="file.bin",
                caption=(payload.caption or "").strip(),
            )
            if _is_official_instance(instance_name)
            else await _connection_manager.send_media(
                instance_name=instance_name,
                number=number,
                media_payload=media_payload,
                mediatype=normalized_media_type,
                mimetype="application/octet-stream",
                file_name="file.bin",
                caption=(payload.caption or "").strip(),
            )
        )
        _persist_local_outbound_event(
            instance_name=instance_name,
            number=number,
            msg_type=normalized_media_type,
            caption=(payload.caption or "").strip(),
            media={
                "id": str(uuid.uuid4())[:16],
                "kind": normalized_media_type,
                "mimeType": "application/octet-stream",
                "fileName": "file.bin",
                "caption": (payload.caption or "").strip() or None,
            },
            evolution_result=result if isinstance(result, dict) else {},
        )
        _log_message_success(instance_name, normalized_media_type, number)
        return result
    except HTTPException:
        raise
    except ValidationError as exc:
        errors = exc.errors(include_url=False)
        logger.warning("message_send_validation_failed", instance=instance_name, errors=errors)
        first = errors[0] if errors else {}
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Payload invalido.",
                "field": ".".join(str(item) for item in first.get("loc", ())) or "body",
                "reason": first.get("msg", "Formato invalido"),
            },
        ) from exc
    except MetaPlatformError as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"provider": "meta_whatsapp", "cause": str(exc), "action": "Revisar token, numero destino y ventana de mensajeria de Meta."},
        )
        logger.warning("meta_whatsapp_send_failed", instance=instance_name, error=str(exc), meta_detail=exc.detail)
        raise HTTPException(
            status_code=exc.status_code,
            detail={"message": str(exc), "provider": "meta_whatsapp", "meta": exc.detail},
        ) from exc
    except Exception as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"cause": str(exc), "action": "Revisar la conectividad y el estado del proveedor de mensajeria."},
        )
        status_code = getattr(exc, "status_code", None)
        if isinstance(status_code, int):
            logger.error("evolution_fail", instance=instance_name, error=str(exc))
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        logger.exception("message_send_unexpected_error", instance=instance_name, error=str(exc))
        raise HTTPException(status_code=500, detail="Error interno al procesar el envio del mensaje.") from exc


@router.post("/messages/{instance_name}")
async def send_message_public(instance_name: str, request: Request):
    return await _send_message_unified(instance_name, request)


@router.post("/instances/{instance_name}/messages", deprecated=True)
async def send_message_legacy(instance_name: str, request: Request):
    logger.warning("deprecated_endpoint_usage", endpoint="/instances/{instance_name}/messages", replacement="/messages/{instance_name}")
    return await _send_message_unified(instance_name, request)


@router.post("/instances/{instance_name}/messages/text", deprecated=True)
async def send_text(instance_name: str, body: SendTextRequest):
    payload_fp = mark_outbound(instance_name, body.number, "text", body.text)
    save_pipeline_event(
        stage="send_whatsapp",
        status="attempt",
        instance=instance_name,
        details={"kind": "text", "number": body.number, "outboundFingerprint": payload_fp},
    )
    try:
        result = await _connection_manager.send_text(instance_name, body.number, body.text)
        save_business_event(
            {
                "id": str(uuid.uuid4())[:16],
                "layer": "business",
                "event": "LOCAL_TEXT_SEND",
                "instance": instance_name,
                "timestamp": int(time.time() * 1000),
                "direction": "outbound",
                "type": "message",
                "messageType": "text",
                "sender": instance_name,
                "recipient": body.number,
                "content": body.text,
                "text": body.text,
                "status": "sent",
                "fromMe": True,
                "fromBot": False,
                "forwarding": {"status": "local_api_send"},
                "error": None,
                "message": {"id": None, "from": instance_name, "kind": "text", "text": body.text},
                "media": None,
            }
        )
        logger.info("text_message_outgoing_sent", instance=instance_name, recipient=body.number)
        save_pipeline_event(stage="send_whatsapp", status="ok", instance=instance_name, details={"kind": "text"})
        return result
    except Exception as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"kind": "text", "error": str(exc)[:180]},
        )
        logger.error("send_text_failed", instance=instance_name, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/instances/{instance_name}/messages/media", deprecated=True)
async def send_media(instance_name: str, body: SendMediaRequest):
    payload_fp = mark_outbound(
        instance_name, body.number, body.mediatype, f"{body.caption or ''}|{body.media_url or ''}"
    )
    save_pipeline_event(
        stage="send_whatsapp",
        status="attempt",
        instance=instance_name,
        details={"kind": body.mediatype, "number": body.number, "outboundFingerprint": payload_fp},
    )
    try:
        result = await _connection_manager.send_media(
            instance_name, body.number, body.media_url, body.mediatype, body.mimetype, body.file_name, body.caption
        )
        save_business_event(
            {
                "id": str(uuid.uuid4())[:16],
                "layer": "business",
                "event": "LOCAL_MEDIA_SEND",
                "instance": instance_name,
                "timestamp": int(time.time() * 1000),
                "direction": "outbound",
                "type": "message",
                "messageType": body.mediatype,
                "sender": instance_name,
                "recipient": body.number,
                "content": body.caption or body.media_url,
                "text": body.caption,
                "status": "sent",
                "fromMe": True,
                "fromBot": False,
                "forwarding": {"status": "local_api_send"},
                "error": None,
                "message": {"id": None, "from": instance_name, "kind": body.mediatype, "text": body.caption},
                "media": {"id": str(uuid.uuid4())[:16], "kind": body.mediatype, "caption": body.caption, "url": body.media_url},
            }
        )
        save_pipeline_event(stage="send_whatsapp", status="ok", instance=instance_name, details={"kind": body.mediatype})
        return result
    except Exception as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"kind": body.mediatype, "error": str(exc)[:180]},
        )
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/instances/{instance_name}/messages/media/uploaded", deprecated=True)
async def send_uploaded_media(instance_name: str, body: SendUploadedMediaRequest):
    file_data = get_uploaded_file(body.file_id)
    if not file_data:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    settings = get_settings()
    file_name = str(file_data.get("fileName") or "file.bin")
    mime_type = str(file_data.get("contentType") or "application/octet-stream")
    normalized_media_type = _normalize_media_type(body.mediatype, mime_type)
    file_size = int(file_data.get("size") or 0)
    max_bytes = settings.media_max_upload_mb * 1024 * 1024
    if file_size > max_bytes:
        raise HTTPException(status_code=413, detail=f"Archivo excede {settings.media_max_upload_mb}MB")

    path = Path(str(file_data.get("path") or ""))
    if not path.exists():
        raise HTTPException(status_code=404, detail="Archivo no encontrado en disco")

    logger.info(
        "media_send_start",
        instance=instance_name,
        fileId=body.file_id,
        mediatype=normalized_media_type,
        mimeType=mime_type,
        fileName=file_name,
        size=file_size,
    )
    try:
        media_base64, actual_size = file_to_base64(path, max_bytes)
        if settings.debug:
            logger.info(
                "media_send_payload_debug",
                mediatype=normalized_media_type,
                mimetype=mime_type,
                fileName=file_name,
                caption=body.caption,
                mediaPreview=media_base64[:48] + "...",
                size=actual_size,
            )
        payload_fp = mark_outbound(
            instance_name, body.number, normalized_media_type, f"{body.caption or ''}|uploaded:{body.file_id}"
        )
        save_pipeline_event(
            stage="send_whatsapp",
            status="attempt",
            instance=instance_name,
            details={"kind": normalized_media_type, "number": body.number, "outboundFingerprint": payload_fp},
        )
        result = await _connection_manager.send_media(
            instance_name=instance_name,
            number=body.number,
            media_payload=media_base64,
            mediatype=normalized_media_type,
            mimetype=mime_type,
            file_name=file_name,
            caption=body.caption,
        )
        consume_uploaded_file(body.file_id)
        save_business_event(
            {
                "id": str(uuid.uuid4())[:16],
                "layer": "business",
                "event": "LOCAL_MEDIA_SEND",
                "instance": instance_name,
                "timestamp": int(time.time() * 1000),
                "direction": "outbound",
                "type": "message",
                "messageType": normalized_media_type,
                "sender": instance_name,
                "recipient": body.number,
                "content": body.caption or f"uploaded:{body.file_id}",
                "text": body.caption,
                "status": "sent",
                "fromMe": True,
                "fromBot": False,
                "forwarding": {"status": "local_api_send"},
                "error": None,
                "message": {"id": None, "from": instance_name, "kind": normalized_media_type, "text": body.caption},
                "media": {"id": body.file_id, "kind": normalized_media_type, "caption": body.caption, "mimeType": mime_type, "fileName": file_name},
            }
        )
        save_pipeline_event(stage="send_whatsapp", status="ok", instance=instance_name, details={"kind": normalized_media_type})
        logger.info(
            "media_send_success",
            instance=instance_name,
            fileId=body.file_id,
            mediatype=normalized_media_type,
            mimeType=mime_type,
            size=file_size,
        )
        return result
    except ValueError as exc:
        logger.warning(
            "media_send_fail",
            instance=instance_name,
            fileId=body.file_id,
            mediatype=normalized_media_type,
            mimeType=mime_type,
            size=file_size,
            error=str(exc),
        )
        raise HTTPException(status_code=413, detail=str(exc))
    except Exception as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"kind": normalized_media_type, "error": str(exc)[:180]},
        )
        logger.warning(
            "media_send_fail",
            instance=instance_name,
            fileId=body.file_id,
            mediatype=normalized_media_type,
            mimeType=mime_type,
            size=file_size,
            error=str(exc),
        )
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/instances/{instance_name}/messages/buttons")
async def send_buttons(instance_name: str, body: SendButtonsRequest):
    payload_fp = mark_outbound(instance_name, body.number, "buttons", body.title or body.description or "")
    save_pipeline_event(
        stage="send_whatsapp",
        status="attempt",
        instance=instance_name,
        details={"kind": "buttons", "number": body.number, "outboundFingerprint": payload_fp},
    )
    payload = {
        "number": body.number,
        "title": body.title,
        "description": body.description,
        "footer": body.footer,
        "buttons": [
            {"type": "reply", "displayText": b.display_text, "id": b.id}
            for b in body.buttons
        ],
    }
    try:
        result = await _connection_manager.send_buttons(instance_name, payload)
        save_pipeline_event(stage="send_whatsapp", status="ok", instance=instance_name, details={"kind": "buttons"})
        return result
    except Exception as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"kind": "buttons", "error": str(exc)[:180]},
        )
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/instances/{instance_name}/messages/list")
async def send_list(instance_name: str, body: SendListRequest):
    payload_fp = mark_outbound(instance_name, body.number, "list", body.title or body.description or "")
    save_pipeline_event(
        stage="send_whatsapp",
        status="attempt",
        instance=instance_name,
        details={"kind": "list", "number": body.number, "outboundFingerprint": payload_fp},
    )
    payload = {
        "number": body.number,
        "title": body.title,
        "description": body.description,
        "buttonText": body.button_text,
        "footerText": body.footer_text,
        "sections": [
            {
                "title": s.title,
                "rows": [
                    {"title": r.title, "description": r.description, "rowId": r.row_id}
                    for r in s.rows
                ],
            }
            for s in body.sections
        ],
    }
    try:
        result = await _connection_manager.send_list(instance_name, payload)
        save_pipeline_event(stage="send_whatsapp", status="ok", instance=instance_name, details={"kind": "list"})
        return result
    except Exception as exc:
        save_pipeline_event(
            stage="send_whatsapp",
            status="failed",
            instance=instance_name,
            details={"kind": "list", "error": str(exc)[:180]},
        )
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/instances/{instance_name}/messages/check-numbers")
async def check_numbers(instance_name: str, body: CheckNumbersRequest):
    try:
        return await _connection_manager.check_whatsapp_numbers(instance_name, body.numbers)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
