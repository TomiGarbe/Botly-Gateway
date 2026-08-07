from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.requests import UpdateChannelSettingsRequest, UpdateProviderSettingsRequest
from app.services.gateway_settings import ChannelNotImplementedError, ProviderNotImplementedError, get_gateway_settings_service


router = APIRouter(prefix="/settings", tags=["settings"])
_service = get_gateway_settings_service()


@router.get("/channels")
async def get_channels():
    return {"channels": _service.channels()}


@router.patch("/channels")
async def update_channels(body: UpdateChannelSettingsRequest):
    try:
        updates = {channel_id: update.enabled for channel_id, update in body.channels.items()}
        return {"channels": _service.update_channels(updates)}
    except (ValueError, ChannelNotImplementedError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/providers")
async def get_providers():
    return {"providers": _service.providers()}


@router.patch("/providers")
async def update_providers(body: UpdateProviderSettingsRequest):
    try:
        updates = {provider_id: update.enabled for provider_id, update in body.providers.items()}
        return {"providers": _service.update_providers(updates)}
    except (ValueError, ProviderNotImplementedError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
