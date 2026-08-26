"""Ownership-aware API for Gateway <-> provider message delivery evidence."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request

from app.models.provider_deliveries import (
    ProviderDeliveryDetail, ProviderDeliveryListResponse, ProviderReconciliationResponse,
    ProviderResendRequest, ProviderResendResponse,
)
from app.services.authorization import require_provider_delivery_resend_access, require_reviewer_connection_access
from app.services.connections import ConnectionNotFoundError, get_connection_service
from app.services.provider_deliveries import get_provider_delivery_query_service
from app.services.provider_reconciliation import (
    ReconciliationConflictError,
    ReconciliationNotEligibleError,
    ReconciliationOwnershipError,
    get_provider_reconciliation_service,
)
from app.services.provider_resend import ResendBlockedError, ResendConflictError, get_provider_resend_service


router = APIRouter(prefix="/provider-deliveries", tags=["provider-deliveries"])
_connections = get_connection_service()
_deliveries = get_provider_delivery_query_service()
_reconciliation = get_provider_reconciliation_service()
_resend = get_provider_resend_service()


def _runtime_name(connection: object) -> str:
    technical = getattr(connection, "technical", {})
    value = technical.get("legacy_instance_name") if isinstance(technical, dict) else None
    return str(value or "").strip()


async def _connection_for_id(request: Request, connection_id: str):
    try:
        connection = await _connections.get_connection(connection_id)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    require_reviewer_connection_access(request, connection)
    if not _runtime_name(connection):
        raise HTTPException(status_code=409, detail="Connection runtime is not available")
    return connection


def _utc_timestamp(value: datetime) -> float:
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).timestamp()


@router.get("", response_model=ProviderDeliveryListResponse)
async def list_provider_deliveries_route(
    request: Request,
    connection_id: str = Query(..., min_length=1, max_length=128),
    provider: str | None = Query(default=None, min_length=1, max_length=64),
    direction: Literal["inbound", "outbound", "status"] | None = None,
    status: Literal["success", "failed", "timeout", "network_error", "configuration_error", "unknown"] | None = None,
    operation: Literal["provider.message.inbound", "provider.message.outbound", "provider.message.status"] | None = None,
    delivery_id: str | None = Query(default=None, min_length=1, max_length=256),
    message_id: str | None = Query(default=None, min_length=1, max_length=256),
    provider_message_id: str | None = Query(default=None, min_length=1, max_length=256),
    conversation_id: str | None = Query(default=None, min_length=1, max_length=256),
    channel_id: str | None = Query(default=None, min_length=1, max_length=128),
    correlation_id: str | None = Query(default=None, min_length=1, max_length=256),
    request_id: str | None = Query(default=None, min_length=1, max_length=256),
    event_id: str | None = Query(default=None, min_length=1, max_length=256),
    search: str | None = Query(default=None, min_length=1, max_length=256),
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    if date_from and date_to and _utc_timestamp(date_from) > _utc_timestamp(date_to):
        raise HTTPException(status_code=422, detail="date_from must be before or equal to date_to")
    connection = await _connection_for_id(request, connection_id)
    # The connection registry is the source of truth for provider values; this
    # avoids accepting a second, hard-coded provider catalog at the API edge.
    if provider is not None and provider != connection.provider.id:
        raise HTTPException(status_code=422, detail="Provider does not match connection")
    # The mandatory connection selector is itself an identifier filter.  Treat
    # a pasted connection ID as that selector rather than searching persisted
    # historical fields, which are not authoritative for ownership.
    effective_search = None if search == connection.id else search
    page = _deliveries.list(
        instance=_runtime_name(connection), limit=limit, offset=offset, provider=provider,
        direction=direction, status=status, operation=operation, delivery_id=delivery_id,
        message_id=message_id, provider_message_id=provider_message_id, conversation_id=conversation_id,
        channel_id=channel_id, correlation_id=correlation_id, request_id=request_id, event_id=event_id,
        search=effective_search, date_from=date_from, date_to=date_to,
    )
    # Connection identity comes from the ownership registry, never from the
    # historical event payload (which may be old or provider-controlled).
    for item in page["items"]:
        item["connectionId"] = connection.id
    return page


@router.get("/{delivery_id}", response_model=ProviderDeliveryDetail)
async def get_provider_delivery_route(delivery_id: str, request: Request):
    found = _deliveries.find(delivery_id)
    if not found:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    instance_name, delivery = found
    if not instance_name:
        # Historical evidence without a runtime cannot be safely assigned to a tenant.
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    try:
        connection = await _connections.get_connection_by_runtime_name(instance_name)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    require_reviewer_connection_access(request, connection)
    detail = _deliveries.detail(delivery)
    detail["summary"]["connectionId"] = connection.id
    detail["identity"]["connectionId"] = connection.id
    return detail


@router.post("/{delivery_id}/reconcile", response_model=ProviderReconciliationResponse)
async def reconcile_provider_delivery_route(delivery_id: str, request: Request):
    """Run one read-only reconciliation for the durable attempt behind a delivery."""
    if (await request.body()).strip():
        raise HTTPException(status_code=422, detail="Reconciliation does not accept a payload")
    found = _deliveries.find(delivery_id)
    if not found:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    instance_name, delivery = found
    attempt_id = str(delivery.get("attemptId") or "").strip()
    if not instance_name or not attempt_id:
        raise HTTPException(status_code=409, detail="Provider delivery is not backed by an outbound attempt")
    try:
        connection = await _connections.get_connection_by_runtime_name(instance_name)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    require_reviewer_connection_access(request, connection)
    try:
        return (await _reconciliation.reconcile(attempt_id=attempt_id, instance=instance_name, connection_id=connection.id)).public_dict()
    except KeyError:
        raise HTTPException(status_code=404, detail="Outbound attempt not found")
    except ReconciliationOwnershipError:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    except ReconciliationNotEligibleError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ReconciliationConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/{delivery_id}/resend", response_model=ProviderResendResponse)
async def resend_provider_delivery_route(
    delivery_id: str,
    body: ProviderResendRequest,
    request: Request,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=128),
):
    """Create one new Evolution attempt only after fresh failed evidence.

    The body deliberately contains no provider, target, message, credentials or
    connection identifiers; all are resolved from the immutable source record.
    """
    found = _deliveries.find(delivery_id)
    if not found:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    instance_name, delivery = found
    attempt_id = str(delivery.get("attemptId") or "").strip()
    if not instance_name or not attempt_id:
        raise HTTPException(status_code=409, detail="Provider delivery is not backed by an outbound attempt")
    try:
        connection = await _connections.get_connection_by_runtime_name(instance_name)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Provider delivery not found")
    require_provider_delivery_resend_access(request, connection)
    actor_id = str(getattr(getattr(request.state, "user", None), "id", "") or "").strip()
    if not actor_id:  # Defensive even if the authorization policy is changed.
        raise HTTPException(status_code=403, detail="Provider resend requires an authenticated operator")
    state = str(getattr(getattr(connection, "status", None), "state", "") or "").strip().lower()
    try:
        outcome = await _resend.resend(
            source_attempt_id=attempt_id, source_delivery_id=delivery_id, connection_id=str(connection.id),
            actor_id=actor_id, idempotency_key=idempotency_key,
            confirmed=body.confirmCurrentConfiguration, current_provider=str(connection.provider.id),
            current_instance=instance_name, connection_active=state in {"connected", "open", "active"},
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Outbound attempt not found")
    except (ResendBlockedError, ResendConflictError) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    new_attempt = outcome.get("newAttempt") if isinstance(outcome.get("newAttempt"), dict) else {}
    action = outcome.get("action") if isinstance(outcome.get("action"), dict) else {}
    result = action.get("result") if isinstance(action.get("result"), dict) else {}
    return {
        "action": action,
        "actionId": str(action.get("id") or ""),
        "idempotent": bool(outcome.get("idempotent")),
        "newAttemptId": str(new_attempt.get("id") or result.get("newAttemptId") or "") or None,
        "newDeliveryId": str(new_attempt.get("id") or action.get("newDeliveryId") or result.get("newDeliveryId") or "") or None,
        "provider": "evolution",
    }
