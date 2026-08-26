from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from app.models.requests import CreateConnectionSetupRequest
from app.services.authorization import require_reviewer_client_access
from app.services.connection_setups import (
    ConnectionSetupConflictError,
    ConnectionSetupNotFoundError,
    InvalidConnectionSetupTransition,
    get_connection_setup_service,
)
from app.services.gateway_settings import ChannelDisabledError, ChannelNotImplementedError, ProviderDisabledError, ProviderNotImplementedError

_service = get_connection_setup_service()
router = APIRouter(prefix="/connection-setups", tags=["connection-setups"])


def _authorize(request: Request, setup: dict) -> None:
    require_reviewer_client_access(request, str(setup["client_id"]))


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_connection_setup(body: CreateConnectionSetupRequest, request: Request):
    try:
        require_reviewer_client_access(request, body.client_id)
        setup = _service.create(client_id=body.client_id, channel=body.channel, name=body.name, provider=body.provider, idempotency_key=body.idempotency_key or request.headers.get("Idempotency-Key"))
        if setup["state"] == "draft":
            setup = _service.begin_meta(setup["id"]) if body.provider == "meta" else await _service.provision_evolution(setup["id"])
        return setup
    except ConnectionSetupNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")
    except (ConnectionSetupConflictError, InvalidConnectionSetupTransition) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except (ValueError, ChannelNotImplementedError, ChannelDisabledError, ProviderNotImplementedError, ProviderDisabledError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/{setup_id}")
async def get_connection_setup(setup_id: str, request: Request):
    try:
        setup = _service.get(setup_id)
        _authorize(request, setup)
        return setup
    except ConnectionSetupNotFoundError:
        raise HTTPException(status_code=404, detail="Connection setup not found")


@router.post("/{setup_id}/cancel")
async def cancel_connection_setup(setup_id: str, request: Request):
    try:
        setup = _service.get(setup_id)
        _authorize(request, setup)
        return _service.cancel(setup_id)
    except ConnectionSetupNotFoundError:
        raise HTTPException(status_code=404, detail="Connection setup not found")
    except InvalidConnectionSetupTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{setup_id}/qr")
async def get_connection_setup_qr(setup_id: str, request: Request):
    """Compatibility bridge: QR is available only after Evolution provisioning promoted the setup."""
    try:
        setup = _service.get(setup_id)
        _authorize(request, setup)
        if setup.get("provider") != "evolution" or not setup.get("connection_id"):
            raise HTTPException(status_code=409, detail="Evolution setup is not ready for QR")
        from app.services.connections import get_connection_service
        return await get_connection_service().evolution_qr(str(setup["connection_id"]))
    except ConnectionSetupNotFoundError:
        raise HTTPException(status_code=404, detail="Connection setup not found")
