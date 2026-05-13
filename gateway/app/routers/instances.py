from fastapi import APIRouter, HTTPException, status

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.requests import CreateInstanceRequest
from app.services import evolution

logger = get_logger(__name__)
router = APIRouter(prefix="/instances", tags=["instances"])

_WEBHOOK_EVENTS = [
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "CONNECTION_UPDATE",
    "QRCODE_UPDATED",
    "SEND_MESSAGE",
]


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_instance(body: CreateInstanceRequest):
    try:
        result = await evolution.create_instance(
            instance_name=body.instance_name,
            qrcode=body.qrcode,
            token=body.token,
        )
    except Exception as exc:
        logger.error("create_instance_failed", instance=body.instance_name, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Evolution error: {exc}")

    # Configurar webhook automáticamente si se pidió
    if body.auto_configure_webhook:
        settings = get_settings()
        webhook_url = f"http://gateway:{settings.gateway_port}/webhooks/evolution"
        try:
            await evolution.set_webhook(body.instance_name, webhook_url, _WEBHOOK_EVENTS)
            logger.info("webhook_configured", instance=body.instance_name, url=webhook_url)
        except Exception as exc:
            # No falla la creación, solo loguea el error
            logger.warning("webhook_configure_failed", instance=body.instance_name, error=str(exc))

    return result


@router.get("/")
async def list_instances():
    try:
        return await evolution.fetch_instances()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{instance_name}/state")
async def get_state(instance_name: str):
    try:
        return await evolution.get_connection_state(instance_name)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{instance_name}/qr")
async def get_qr(instance_name: str):
    try:
        return await evolution.get_qr(instance_name)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.delete("/{instance_name}/logout")
async def logout(instance_name: str):
    try:
        return await evolution.logout_instance(instance_name)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.delete("/{instance_name}")
async def delete(instance_name: str):
    try:
        return await evolution.delete_instance(instance_name)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
