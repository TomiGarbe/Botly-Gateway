from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status

from app.models.requests import CreateClientRequest, UpdateClientRequest
from app.services.clients import ClientHasConnectionsError, ClientNotFoundError, get_client_service


router = APIRouter(prefix="/clients", tags=["clients"])
_service = get_client_service()


@router.get("")
async def list_clients():
    return [client.public_dict() for client in _service.list_client_overviews()]


@router.get("/{client_id}")
async def get_client(client_id: str):
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
