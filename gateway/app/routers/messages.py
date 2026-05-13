from fastapi import APIRouter, HTTPException

from app.core.logging import get_logger
from app.models.requests import (
    SendTextRequest,
    SendMediaRequest,
    SendButtonsRequest,
    SendListRequest,
    CheckNumbersRequest,
)
from app.services import evolution

logger = get_logger(__name__)
router = APIRouter(prefix="/instances/{instance_name}/messages", tags=["messages"])


@router.post("/text")
async def send_text(instance_name: str, body: SendTextRequest):
    try:
        return await evolution.send_text(instance_name, body.number, body.text)
    except Exception as exc:
        logger.error("send_text_failed", instance=instance_name, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/media")
async def send_media(instance_name: str, body: SendMediaRequest):
    try:
        return await evolution.send_media(
            instance_name, body.number, body.media_url, body.mediatype, body.caption
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/buttons")
async def send_buttons(instance_name: str, body: SendButtonsRequest):
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
        return await evolution.send_buttons(instance_name, payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/list")
async def send_list(instance_name: str, body: SendListRequest):
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
        return await evolution.send_list(instance_name, payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/check-numbers")
async def check_numbers(instance_name: str, body: CheckNumbersRequest):
    try:
        return await evolution.check_whatsapp_numbers(instance_name, body.numbers)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
