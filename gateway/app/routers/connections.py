from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from app.models.requests import ConnectionQuickMessageRequest, ConnectionWebhookRequest, CreateConnectionRequest, UpdateConnectionRequest
from app.services.connections import (
    ChannelDisabledError,
    ConnectionClientNotFoundError,
    ConnectionNotFoundError,
    ChannelNotImplementedError,
    ProviderDisabledError,
    ProviderNotImplementedError,
    UnsupportedConnectionProviderError,
    UnsupportedConnectionChannelError,
    get_connection_service,
)
from app.services.connection_operations import (
    ConnectionOperationUnavailableError,
    get_connection_operations_service,
)
from app.services.connection_diagnostics import get_connection_diagnostics_service
from app.services.authorization import require_reviewer_client_access, require_reviewer_connection_access


_service = get_connection_service()
_operations = get_connection_operations_service()
_diagnostics = get_connection_diagnostics_service()


async def _authorize_connection_target(request: Request) -> None:
    """Apply business ownership to every per-connection management route."""
    parts = request.url.path.rstrip("/").split("/")
    if len(parts) < 3 or parts[1] != "connections":
        return
    try:
        require_reviewer_connection_access(request, await _service.get_connection(parts[2]))
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")


router = APIRouter(prefix="/connections", tags=["connections"], dependencies=[Depends(_authorize_connection_target)])


@router.get("")
async def list_connections(request: Request, client_id: str | None = Query(default=None, min_length=1, max_length=128)):
    if client_id:
        require_reviewer_client_access(request, client_id)
    connections = await _service.list_connections(client_id)
    visible = []
    for connection in connections:
        try:
            require_reviewer_connection_access(request, connection)
        except HTTPException:
            continue
        visible.append(connection.public_dict())
    return visible


@router.get("/{connection_id}")
async def get_connection(connection_id: str, request: Request):
    try:
        connection = await _service.get_connection(connection_id)
        require_reviewer_connection_access(request, connection)
        return connection.public_dict()
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_connection(body: CreateConnectionRequest, request: Request):
    try:
        require_reviewer_client_access(request, body.client_id)
        connection = _service.create_connection(
            client_id=body.client_id,
            channel=body.channel,
            name=body.name,
            provider=body.provider,
        )
        if body.provider == "evolution":
            connection = await _service.start_evolution_connection(connection.id)
        return connection.public_dict()
    except ConnectionClientNotFoundError:
        raise HTTPException(status_code=404, detail="Client not found")
    except (UnsupportedConnectionChannelError, UnsupportedConnectionProviderError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except (ChannelNotImplementedError, ChannelDisabledError, ProviderNotImplementedError, ProviderDisabledError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/{connection_id}/qr")
async def get_connection_qr(connection_id: str):
    try:
        return await _service.evolution_qr(connection_id)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except UnsupportedConnectionProviderError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except (ProviderNotImplementedError, ProviderDisabledError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.patch("/{connection_id}")
async def update_connection(connection_id: str, body: UpdateConnectionRequest, request: Request):
    try:
        require_reviewer_connection_access(request, await _service.get_connection(connection_id))
        return (await _service.update_connection(connection_id, name=body.name)).public_dict()
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(connection_id: str, request: Request) -> Response:
    try:
        require_reviewer_connection_access(request, await _service.get_connection(connection_id))
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


@router.get("/{connection_id}/webhook/deliveries")
async def get_connection_webhook_deliveries(connection_id: str, limit: int = Query(default=50, ge=1, le=200)):
    try:
        return _operations.webhook_deliveries(connection_id, limit=limit)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")


@router.get("/{connection_id}/webhook/configuration")
async def verify_connection_webhook_configuration(connection_id: str):
    """Read-only verification; this route never sends a webhook request."""
    try:
        return _operations.verify_webhook_configuration(connection_id)
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
async def get_connection_api_key(connection_id: str, reveal: bool = Query(default=False)):
    try:
        return _operations.api_key(connection_id, reveal=reveal)
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
        result = await _operations.reconnect(connection_id)
        return {"ok": True, **result}
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ConnectionOperationUnavailableError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{connection_id}/status")
async def get_connection_status(connection_id: str, request: Request):
    try:
        require_reviewer_connection_access(request, await _service.get_connection(connection_id))
        availability = await _diagnostics.verify_availability(connection_id)
        summary = availability["diagnostics"]["summary"]
        return {
            "connected": bool(availability["runtime_available"]),
            "last_activity_at": availability.get("last_activity_at"),
            "last_heartbeat_at": summary.get("last_heartbeat_at"),
            "deprecated": True,
            "diagnostic": "verify_availability",
        }
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{connection_id}/availability")
async def verify_connection_availability(connection_id: str):
    try:
        return await _diagnostics.verify_availability(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{connection_id}/diagnostics")
async def get_connection_diagnostics(connection_id: str):
    try:
        return await _diagnostics.snapshot(connection_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/{connection_id}/messages")
async def send_connection_quick_message(connection_id: str, body: ConnectionQuickMessageRequest, request: Request):
    try:
        require_reviewer_connection_access(request, await _service.get_connection(connection_id))
        return await _operations.send_quick_message(connection_id, number=body.number, text=body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        status_code = getattr(exc, "status_code", 502)
        raise HTTPException(status_code=status_code if isinstance(status_code, int) else 502, detail="Message delivery failed")


@router.get("/{connection_id}/activity")
async def get_connection_activity(connection_id: str, request: Request, limit: int = Query(default=5, ge=1, le=20)):
    try:
        require_reviewer_connection_access(request, await _service.get_connection(connection_id))
        return {"items": _operations.recent_activity(connection_id, limit)}
    except KeyError:
        raise HTTPException(status_code=404, detail="Connection not found")
