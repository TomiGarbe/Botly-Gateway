from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.domain import ChannelId, RegistryError, get_default_domain_registry
from app.services.features import get_feature_service

router = APIRouter(prefix="/channels", tags=["channels"])


@router.get("/")
async def list_channels():
    domain = get_default_domain_registry()
    features = get_feature_service()
    return {"items": features.public_channels(domain), **features.public_dict()}


@router.get("/{channel_id}")
async def get_channel(channel_id: ChannelId):
    domain = get_default_domain_registry()
    for channel in get_feature_service().public_channels(domain):
        if channel["id"] == channel_id.value:
            return channel
    raise HTTPException(status_code=404, detail="Channel not found")
