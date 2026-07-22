from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.domain import ChannelId, RegistryError, get_default_domain_registry

router = APIRouter(prefix="/channels", tags=["channels"])


@router.get("/")
async def list_channels():
    domain = get_default_domain_registry()
    channels = [
        channel
        for channel in domain.public_channels()
        if channel.get("visible") is True
    ]
    channels.sort(key=lambda item: int(item.get("sortOrder") or 0))
    return {"items": channels}


@router.get("/{channel_id}")
async def get_channel(channel_id: ChannelId):
    domain = get_default_domain_registry()
    try:
        channel = domain.channels.require(channel_id).public_dict()
    except RegistryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not channel.get("visible"):
        raise HTTPException(status_code=404, detail="Channel not found")
    return channel
