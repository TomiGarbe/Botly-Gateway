from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, HTTPException, status

from app.domain import RegistryError
from app.provisioning import (
    CatalogItem,
    ConnectionRequest,
    ConnectionStart,
    ProvisionRequest,
    ProvisionedChannel,
    ProvisioningResource,
    ProvisioningResourceNotFoundError,
    ProvisioningResourceUnsupportedError,
    ProvisioningService,
)

router = APIRouter(prefix="/api/v1/provisioning", tags=["provisioning"])


@lru_cache
def get_provisioning_service() -> ProvisioningService:
    return ProvisioningService()


@router.get("/catalog", response_model=list[CatalogItem])
async def get_catalog():
    return get_provisioning_service().list_catalog()


@router.get("/resources", response_model=list[ProvisioningResource])
async def get_resources():
    return get_provisioning_service().list_resources()


@router.get("/channels", response_model=list[ProvisionedChannel])
async def get_channels():
    return get_provisioning_service().list_channels()


@router.post("/connect", response_model=ConnectionStart)
async def connect(body: ConnectionRequest):
    try:
        return get_provisioning_service().start_connection(body)
    except RegistryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/provision", response_model=ProvisionedChannel, status_code=status.HTTP_201_CREATED)
async def provision(body: ProvisionRequest):
    try:
        return get_provisioning_service().provision_resource(body.resource_id)
    except ProvisioningResourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ProvisioningResourceUnsupportedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
