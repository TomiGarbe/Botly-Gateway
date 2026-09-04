from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse

from app.core.logging import get_logger
from app.models.requests import CoreChannelBindingRequest, ConnectionQuickMessageRequest, ConnectionWebhookRequest, CreateConnectionRequest, UpdateConnectionRequest
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
from app.services.credential_manager import ProviderAccountReference, get_credential_manager
from app.services.gateway_settings import get_gateway_settings_service
from app.services.instagram_oauth import InstagramOAuthError, InstagramOAuthIntent, InstagramOAuthService, InstagramOAuthStateStore


_service = get_connection_service()
_operations = get_connection_operations_service()
_diagnostics = get_connection_diagnostics_service()
logger = get_logger(__name__)


async def _authorize_connection_target(request: Request) -> None:
    """Apply business ownership to every per-connection management route."""
    parts = request.url.path.rstrip("/").split("/")
    if len(parts) < 3 or parts[1] != "connections":
        return
    if len(parts) >= 4 and parts[2] == "meta" and parts[3] == "instagram":
        return
    try:
        require_reviewer_connection_access(request, await _service.get_connection(parts[2]))
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")


router = APIRouter(prefix="/connections", tags=["connections"], dependencies=[Depends(_authorize_connection_target)])
_instagram_oauth = InstagramOAuthService()
_instagram_oauth_states = InstagramOAuthStateStore()


def _authenticated_actor_id(request: Request) -> str:
    user = getattr(request.state, "user", None)
    actor_id = str(getattr(user, "id", "") or "").strip()
    if not actor_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Instagram OAuth requires an authenticated user session")
    return actor_id


@router.get("/meta/instagram/authorize")
async def authorize_instagram(request: Request, connection_id: str = Query(..., min_length=1, max_length=128)):
    """Create a server-owned OAuth intent and redirect to Meta Instagram Login."""
    try:
        actor_id = _authenticated_actor_id(request)
        connection = await _service.get_connection(connection_id)
        require_reviewer_connection_access(request, connection)
        record = _service.require_instagram_meta_connection(connection_id)
        get_gateway_settings_service().require_channel_available("instagram")
        get_gateway_settings_service().require_provider_available("meta")
        _instagram_oauth.validate_configuration()
        state = _instagram_oauth_states.create(
            InstagramOAuthIntent(connection_id=connection_id, client_id=str(record["client_id"]), actor_id=actor_id)
        )
        return RedirectResponse(_instagram_oauth.authorization_url(state=state), status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except (UnsupportedConnectionProviderError, InstagramOAuthError) as exc:
        raise HTTPException(status_code=getattr(exc, "status_code", 422), detail=str(exc))


@router.get("/meta/instagram/callback")
async def instagram_oauth_callback(
    state: str | None = Query(default=None),
    code: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
):
    """Complete a state-bound OAuth intent. This callback intentionally accepts no IDs from clients."""
    try:
        intent = _instagram_oauth_states.consume(state)
        if error:
            raise InstagramOAuthError("Instagram authorization was denied" if error == "access_denied" else "Instagram authorization failed")
        if not code:
            raise InstagramOAuthError("OAuth code is required")
        if intent.provider_id != "meta" or intent.channel_type != "instagram":
            raise InstagramOAuthError("OAuth state has an invalid provider/channel binding", status_code=500)
        record = _service.require_instagram_meta_connection(intent.connection_id)
        if str(record.get("client_id") or "") != intent.client_id:
            raise InstagramOAuthError("OAuth state tenant binding is invalid", status_code=403)
        token = await _instagram_oauth.exchange_code(code)
        account_data = await _instagram_oauth.discover_account(token.access_token)
        account = ProviderAccountReference("meta", "instagram", account_data.provider_account_id)
        _service.assert_instagram_provider_account_available(intent.connection_id, account)
        get_credential_manager().upsert_provider_credentials(
            account=account,
            access_token=token.access_token,
            access_token_ref=f"meta://instagram/{account.provider_account_id}/token",
            source="instagram_business_login",
            scopes=token.granted_scopes,
            expires_at=token.expires_at,
            metadata={"tokenType": "bearer"},
        )
        connection = _service.bind_instagram_provider_account(
            connection_id=intent.connection_id,
            account=account,
            metadata=account_data.metadata(),
            required_scopes=_instagram_oauth.requested_scopes(),
        )
        return {"ok": True, "connection": connection.public_dict()}
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except (UnsupportedConnectionProviderError, InstagramOAuthError) as exc:
        raise HTTPException(status_code=getattr(exc, "status_code", 422), detail=str(exc))


@router.get("/{connection_id}/instagram/readiness")
async def instagram_connection_readiness(connection_id: str, request: Request):
    try:
        connection = await _service.get_connection(connection_id)
        require_reviewer_connection_access(request, connection)
        _service.require_instagram_meta_connection(connection_id)
        return _service.instagram_readiness(connection_id, required_scopes=_instagram_oauth.requested_scopes())
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except (UnsupportedConnectionProviderError, InstagramOAuthError) as exc:
        raise HTTPException(status_code=getattr(exc, "status_code", 422), detail=str(exc))


@router.post("/{connection_id}/instagram/disconnect")
async def disconnect_instagram(connection_id: str, request: Request):
    try:
        _authenticated_actor_id(request)
        connection = await _service.get_connection(connection_id)
        require_reviewer_connection_access(request, connection)
        return _service.disconnect_instagram_connection(connection_id).public_dict()
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except UnsupportedConnectionProviderError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.put("/{connection_id}/instagram/core-channel")
async def bind_instagram_core_channel(connection_id: str, body: CoreChannelBindingRequest, request: Request):
    """Store a server-side Core Channel binding; the API key is never returned."""
    try:
        _authenticated_actor_id(request)
        connection = await _service.get_connection(connection_id)
        require_reviewer_connection_access(request, connection)
        return _service.bind_instagram_core_channel(
            connection_id=connection_id,
            core_channel_id=body.core_channel_id,
            channel_api_key=body.channel_api_key,
        ).public_dict()
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    except (UnsupportedConnectionProviderError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))


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
    except Exception as exc:
        logger.error("connection_reconnect_failed", connection_id=connection_id, error=str(exc))
        raise HTTPException(
            status_code=getattr(exc, "status_code", 502),
            detail="Evolution reconnect/webhook verification failed",
        )


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
