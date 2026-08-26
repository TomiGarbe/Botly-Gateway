from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.models.requests import CreateClientRequest, UpdateClientRequest
from app.services.clients import ClientHasConnectionsError, ClientNotFoundError, get_client_service
from app.services.authorization import is_meta_reviewer, require_reviewer_client_access
from app.core.config import get_settings


router = APIRouter(prefix="/clients", tags=["clients"])
_service = get_client_service()


@router.get("")
async def list_clients(request: Request):
    clients = _service.list_client_overviews()
    if is_meta_reviewer(getattr(request.state, "user", None)):
        allowed = str(getattr(request.state.user, "business_id", ""))
        clients = [client for client in clients if client.client.id == allowed]
    return [client.public_dict() for client in clients]


@router.get("/{client_id}")
async def get_client(client_id: str, request: Request):
    require_reviewer_client_access(request, client_id)
    try:
        return _service.get_client_overview(client_id).public_dict()
    except ClientNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_client(body: CreateClientRequest):
    try:
        return _service.get_client_overview(
            _service.create_client(body.name, body.description).id
        ).public_dict()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.patch("/{client_id}")
async def update_client(client_id: str, body: UpdateClientRequest):
    try:
        changes = body.model_fields_set
        client = _service.update_client(
            client_id,
            name=body.name if "name" in changes else None,
            description=body.description if "description" in changes else ...,
        )
        return _service.get_client_overview(client.id).public_dict()
    except ClientNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.put("/{client_id}")
async def replace_client(client_id: str, body: CreateClientRequest):
    try:
        client = _service.update_client(
            client_id,
            name=body.name,
            description=body.description,
        )
        return _service.get_client_overview(client.id).public_dict()
    except ClientNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(client_id: str) -> Response:
    try:
        _service.delete_client(client_id)
    except ClientNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")
    except ClientHasConnectionsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
