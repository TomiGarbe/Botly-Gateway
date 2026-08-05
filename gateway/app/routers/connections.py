from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response, status

from app.models.requests import ConnectionQuickMessageRequest, ConnectionWebhookRequest, CreateConnectionRequest, UpdateConnectionRequest
from app.services.connections import (
    ConnectionClientNotFoundError,
    ConnectionNotFoundError,
    UnsupportedConnectionChannelError,
    get_connection_service,
)
from app.services.connection_operations import (
    ConnectionOperationUnavailableError,
    get_connection_operations_service,
)
from app.services.connection_diagnostics import get_connection_diagnostics_service


router = APIRouter(prefix="/connections", tags=["connections"])
_service = get_connection_service()
_operations = get_connection_operations_service()
_diagnostics = get_connection_diagnostics_service()


@router.get("")
async def list_connections(client_id: str | None = Query(default=None, min_length=1, max_length=128)):
    return [connection.public_dict() for connection in await _service.list_connections(client_id)]


@router.get("/{connection_id}")
async def get_connection(connection_id: str):
    try:
        return (await _service.get_connection(connection_id)).public_dict()
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_connection(body: CreateConnectionRequest):
    try:
        return _service.create_connection(client_id=body.client_id, channel=body.channel).public_dict()
    except ConnectionClientNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")
    except UnsupportedConnectionChannelError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.patch("/{connection_id}")
async def update_connection(connection_id: str, body: UpdateConnectionRequest):
    try:
        return (await _service.update_connection(connection_id, name=body.name)).public_dict()
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(connection_id: str) -> Response:
    try:
        await _service.delete_connection(connection_id)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{connection_id}/webhook")
async def get_connection_webhook(connection_id: str):
    try:
        return _operations.webhook(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.get("/{connection_id}/integration-endpoints")
async def get_connection_integration_endpoints(connection_id: str):
    try:
        return _operations.integration_endpoints(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ConnectionOperationUnavailableError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.put("/{connection_id}/webhook")
async def update_connection_webhook(connection_id: str, body: ConnectionWebhookRequest):
    try:
        return _operations.update_webhook(
            connection_id,
            body.url,
            auth_type=body.auth_type,
            auth_config=body.auth_config,
            custom_headers=body.custom_headers,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/{connection_id}/webhook/test")
async def test_connection_webhook(connection_id: str):
    try:
        return await _operations.test_webhook(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ConnectionOperationUnavailableError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{connection_id}/api-key")
async def get_connection_api_key(connection_id: str):
    try:
        return _operations.api_key(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.post("/{connection_id}/api-key/regenerate")
async def regenerate_connection_api_key(connection_id: str):
    try:
        return _operations.regenerate_api_key(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.post("/{connection_id}/reconnect")
async def reconnect_connection(connection_id: str):
    try:
        await _operations.reconnect(connection_id)
        return {"ok": True}
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ConnectionOperationUnavailableError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{connection_id}/status")
async def get_connection_status(connection_id: str):
    try:
        return await _operations.status(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.get("/{connection_id}/diagnostics")
async def get_connection_diagnostics(connection_id: str):
    try:
        return await _diagnostics.snapshot(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/{connection_id}/messages")
async def send_connection_quick_message(connection_id: str, body: ConnectionQuickMessageRequest):
    try:
        return await _operations.send_quick_message(connection_id, number=body.number, text=body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        status_code = getattr(exc, "status_code", 502)
        raise HTTPException(status_code=status_code if isinstance(status_code, int) else 502, detail="Message delivery failed")


@router.get("/{connection_id}/activity")
async def get_connection_activity(connection_id: str, limit: int = Query(default=5, ge=1, le=20)):
    try:
        return {"items": _operations.recent_activity(connection_id, limit)}
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
