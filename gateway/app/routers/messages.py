import time
import uuid

from fastapi import APIRouter, HTTPException

from app.core.logging import get_logger
from app.models.requests import (
    SendTextRequest,
    SendMediaRequest,
    SendButtonsRequest,
    SendListRequest,
    CheckNumbersRequest,
    SendUploadedMediaRequest,
)
from app.services import evolution
from app.services.media import get_uploaded_file
from app.services.normalization import save_business_event, save_pipeline_event
from app.services.reliability import mark_outbound

logger = get_logger(__name__)
router = APIRouter(prefix="/instances/{instance_name}/messages", tags=["messages"])


@router.post("/text")
async def send_text(instance_name: str, body: SendTextRequest):
    payload_fp = mark_outbound(instance_name, body.number, "text", body.text)
    save_pipeline_event(
        stage="send_whatsapp",
        status="attempt",
        instance=instance_name,
        details={"kind": "text", "number": body.number, "outboundFingerprint": payload_fp},
    )
    try:
        result = await evolution.send_text(instance_name, body.number, body.text)
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


@router.post("/media")
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
        result = await evolution.send_media(
            instance_name, body.number, body.media_url, body.mediatype, body.caption
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


@router.post("/media/uploaded")
async def send_uploaded_media(instance_name: str, body: SendUploadedMediaRequest):
    file_data = get_uploaded_file(body.file_id)
    if not file_data:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    from app.core.config import get_settings

    settings = get_settings()
    media_url = f"http://gateway:{settings.gateway_port}/media/upload/{body.file_id}"
    try:
        payload_fp = mark_outbound(
            instance_name, body.number, body.mediatype, f"{body.caption or ''}|uploaded:{body.file_id}"
        )
        save_pipeline_event(
            stage="send_whatsapp",
            status="attempt",
            instance=instance_name,
            details={"kind": body.mediatype, "number": body.number, "outboundFingerprint": payload_fp},
        )
        result = await evolution.send_media(
            instance_name=instance_name,
            number=body.number,
            media_url=media_url,
            mediatype=body.mediatype,
            caption=body.caption,
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


@router.post("/buttons")
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
        result = await evolution.send_buttons(instance_name, payload)
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


@router.post("/list")
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
        result = await evolution.send_list(instance_name, payload)
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


@router.post("/check-numbers")
async def check_numbers(instance_name: str, body: CheckNumbersRequest):
    try:
        return await evolution.check_whatsapp_numbers(instance_name, body.numbers)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
