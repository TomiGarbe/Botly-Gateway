"""Connection-owned Webhook API prepared for the future Webhooks Center UI."""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Header, HTTPException, Query, Request

from app.models.requests import ManualWebhookActionRequest, WebhookCenterCreateRequest, WebhookCenterPatchRequest, WebhookEnabledRequest, WebhookTestRequest
from app.core.secret_protection import REDACTED, SecretRedactor
from app.services.audit import audit_event
from app.services.authorization import require_reviewer_connection_access, require_webhook_delivery_manual_action_access, require_webhook_delivery_repeat_test_access
from app.services.connections import ConnectionNotFoundError, get_connection_service
from app.services.instance_webhooks import (
    build_auth_headers,
    build_auth_query_params,
    create_webhook,
    delete_webhook,
    find_webhook_by_id,
    get_webhook,
    get_webhook_delivery,
    list_webhook_delivery_page,
    set_webhook_enabled,
    set_webhook_filters,
    update_webhook,
)
from app.services.webhook_delivery import diagnose_webhook_target, dispatch_webhook_with_retry
from app.services.manual_delivery_actions import ManualActionConflictError, create_or_get_action, update_action

router = APIRouter(prefix="/webhooks", tags=["webhooks-center"])
_connections = get_connection_service()


def _runtime_name(connection: Any) -> str:
    technical = getattr(connection, "technical", {})
    value = technical.get("legacy_instance_name") if isinstance(technical, dict) else None
    return str(value or "").strip()


def _validate_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=422, detail="Webhook URL must be a valid HTTP(S) URL")
    return str(value).strip()


def _public_webhook(item: dict[str, Any]) -> dict[str, Any]:
    """A listing/detail contract with configuration and safe activity only."""
    return {
        key: value
        for key, value in item.items()
        if key != "dispatchHistory"
    }


def _test_payload(instance_name: str, override: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": f"webhook_center_test_{uuid.uuid4().hex}",
        "event": "TEST_WEBHOOK",
        "instance": instance_name,
        "timestamp": int(time.time() * 1000),
        "type": "connection_test",
        "status": "received",
        "text": "test webhook",
        "meta": {"source": "webhook_center_test"},
    }
    if override:
        payload.update(override)
    # A manual test must not spoof another runtime or lose its stable origin.
    payload["instance"] = instance_name
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    payload["meta"] = {**meta, "source": "webhook_center_test"}
    return payload


def _contains_redacted_value(value: Any) -> bool:
    if isinstance(value, dict):
        return any(_contains_redacted_value(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_redacted_value(item) for item in value)
    return isinstance(value, str) and REDACTED in value


def _redelivery_payload(source: dict[str, Any]) -> dict[str, Any]:
    request_data = source.get("request") if isinstance(source.get("request"), dict) else {}
    preview = request_data.get("payloadPreview")
    if bool(request_data.get("payloadTruncated")) or not isinstance(preview, str) or not preview.strip():
        raise HTTPException(status_code=409, detail="Delivery payload is not available for safe redelivery")
    try:
        payload = json.loads(preview)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=409, detail="Delivery payload is not a reconstructible JSON object") from exc
    if not isinstance(payload, dict) or _contains_redacted_value(payload):
        raise HTTPException(status_code=409, detail="Delivery payload is incomplete or contains redacted values")
    return payload


def _observable_destination_drift(source: dict[str, Any], current_url: str) -> bool:
    request_data = source.get("request") if isinstance(source.get("request"), dict) else {}
    original = str(source.get("destinationUrl") or request_data.get("url") or "").strip()
    if not original:
        raise HTTPException(status_code=409, detail="Original destination is not available for safe redelivery")
    return SecretRedactor.redact_url(original) != SecretRedactor.redact_url(current_url)


def _validate_current_webhook_configuration(item: dict[str, Any]) -> str:
    url = _validate_url(str(item.get("url") or ""))
    try:
        build_auth_headers(item)
        build_auth_query_params(item)
    except Exception as exc:
        raise HTTPException(status_code=409, detail="Webhook configuration is not valid for redelivery") from exc
    return url


async def _connection_for_id(request: Request, connection_id: str):
    try:
        connection = await _connections.get_connection(connection_id)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="Connection not found")
    require_reviewer_connection_access(request, connection)
    if not _runtime_name(connection):
        raise HTTPException(status_code=409, detail="Connection runtime is not available")
    return connection


async def _webhook_target(request: Request, webhook_id: str) -> tuple[Any, str, dict[str, Any]]:
    found = find_webhook_by_id(webhook_id, reveal_secrets=True)
    if not found:
        raise HTTPException(status_code=404, detail="Webhook not found")
    instance_name, webhook = found
    try:
        connection = await _connections.get_connection_by_runtime_name(instance_name)
    except ConnectionNotFoundError:
        # A webhook without a product connection is deliberately not exposed.
        raise HTTPException(status_code=404, detail="Webhook not found")
    require_reviewer_connection_access(request, connection)
    return connection, instance_name, webhook


@router.get("")
async def list_webhooks(request: Request, connection_id: str | None = Query(default=None, min_length=1, max_length=128)):
    connections = [await _connection_for_id(request, connection_id)] if connection_id else await _connections.list_connections()
    items: list[dict[str, Any]] = []
    for connection in connections:
        try:
            require_reviewer_connection_access(request, connection)
        except HTTPException:
            continue
        runtime_name = _runtime_name(connection)
        if not runtime_name:
            continue
        from app.services.instance_webhooks import list_instance_webhooks
        for webhook in list_instance_webhooks(runtime_name, reveal_secrets=False):
            items.append({"connectionId": connection.id, **_public_webhook(webhook)})
    return {"items": items}


@router.post("")
async def create_webhook_route(body: WebhookCenterCreateRequest, request: Request):
    connection = await _connection_for_id(request, body.connection_id)
    item = create_webhook(
        _runtime_name(connection),
        name=body.name,
        url=_validate_url(body.url),
        enabled=body.enabled,
        auth_type=body.authType,
        auth_config=body.authConfig,
        custom_headers=body.customHeaders,
        event_filters=body.eventFilters,
    )
    return {"connectionId": connection.id, **_public_webhook(item)}


@router.get("/{webhook_id}")
async def get_webhook_route(webhook_id: str, request: Request):
    connection, instance_name, _item = await _webhook_target(request, webhook_id)
    public_item = get_webhook(instance_name, webhook_id, reveal_secrets=False)
    if not public_item:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return {"connectionId": connection.id, **_public_webhook(public_item)}


@router.patch("/{webhook_id}")
async def patch_webhook_route(webhook_id: str, body: WebhookCenterPatchRequest, request: Request):
    connection, instance_name, current = await _webhook_target(request, webhook_id)
    item = update_webhook(
        instance_name,
        webhook_id,
        name=body.name if body.name is not None else str(current.get("name") or ""),
        url=_validate_url(body.url) if body.url is not None else str(current.get("url") or ""),
        enabled=body.enabled if body.enabled is not None else bool(current.get("enabled")),
        auth_type=body.authType or str(current.get("authType") or "NONE"),
        auth_config=body.authConfig,
        custom_headers=body.customHeaders,
        event_filters=body.eventFilters,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return {"connectionId": connection.id, **_public_webhook(item)}


@router.delete("/{webhook_id}")
async def delete_webhook_route(webhook_id: str, request: Request):
    _connection, instance_name, _item = await _webhook_target(request, webhook_id)
    if not delete_webhook(instance_name, webhook_id):
        raise HTTPException(status_code=404, detail="Webhook not found")
    # Delivery evidence remains independent for retention/audit purposes.
    return {"ok": True}


@router.patch("/{webhook_id}/enabled")
async def set_enabled_route(webhook_id: str, body: WebhookEnabledRequest, request: Request):
    connection, instance_name, _item = await _webhook_target(request, webhook_id)
    item = set_webhook_enabled(instance_name, webhook_id, body.enabled)
    if not item:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return {"connectionId": connection.id, **_public_webhook(item)}


@router.patch("/{webhook_id}/filters")
async def set_filters_route(webhook_id: str, body: dict[str, bool], request: Request):
    connection, instance_name, _item = await _webhook_target(request, webhook_id)
    item = set_webhook_filters(instance_name, webhook_id, body)
    if not item:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return {"connectionId": connection.id, **_public_webhook(item)}


@router.get("/{webhook_id}/test-payload")
async def get_test_webhook_payload(webhook_id: str, request: Request):
    _connection, instance_name, _item = await _webhook_target(request, webhook_id)
    return {"payload": _test_payload(instance_name)}


@router.post("/{webhook_id}/test")
async def test_webhook_route(webhook_id: str, request: Request, body: WebhookTestRequest | None = None):
    connection, instance_name, item = await _webhook_target(request, webhook_id)
    require_webhook_delivery_manual_action_access(request, connection)
    if not item.get("enabled"):
        raise HTTPException(status_code=409, detail="Webhook is disabled")
    request_id = f"webhook-test-{webhook_id[:8]}-{uuid.uuid4().hex[:10]}"
    result = await dispatch_webhook_with_retry(
        payload=_test_payload(instance_name, body.payload if body else None), request_id=request_id, item=item, test_mode=True,
    )
    return {
        "ok": bool(result.get("ok")), "status": int(result.get("statusCode") or 0), "error": result.get("error"),
        "retriesUsed": int(result.get("retriesUsed") or 0), "latencyMs": result.get("latencyMs"),
        "deliveryType": "test", "deliveryId": result.get("deliveryId"), "requestId": request_id, "webhookId": webhook_id,
    }


@router.post("/{webhook_id}/deliveries/{delivery_id}/repeat-test")
async def repeat_test_delivery_route(
    webhook_id: str,
    delivery_id: str,
    request: Request,
    body: ManualWebhookActionRequest | None = None,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=128),
):
    """Repeat a *test* as a new delivery using the current webhook configuration."""
    connection, instance_name, item = await _webhook_target(request, webhook_id)
    require_webhook_delivery_repeat_test_access(request, connection)
    source = get_webhook_delivery(instance_name, webhook_id, delivery_id)
    if not source:
        raise HTTPException(status_code=404, detail="Webhook delivery not found")
    if not bool(source.get("isTest")):
        raise HTTPException(status_code=409, detail="Only webhook test deliveries can be repeated")
    if not item.get("enabled"):
        raise HTTPException(status_code=409, detail="Webhook is disabled")
    _validate_url(str(item.get("url") or ""))

    actor_id = str(getattr(request.state.user, "id", "") or "").strip()
    try:
        action, created = create_or_get_action(
            action="repeat_test", source_delivery_id=delivery_id, target_id=webhook_id,
            connection_id=str(connection.id), actor_id=actor_id, idempotency_key=idempotency_key,
            reason=body.reason if body else None,
        )
    except ManualActionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail="Too many repeat-test actions for this webhook") from exc

    if not created:
        return {"actionId": action["id"], "action": action["action"], "status": action["status"], "risk": action["risk"], "sourceDeliveryId": action["sourceDeliveryId"], "newDeliveryId": action.get("newDeliveryId"), "configurationSource": "current", "result": action.get("result")}

    update_action(action["id"], status="running")
    try:
        result = await dispatch_webhook_with_retry(
            payload=_test_payload(instance_name), request_id=f"manual-test-{action['id'][-12:]}", item=item,
            test_mode=True, manual_action_id=action["id"],
        )
    except Exception as exc:
        update_action(action["id"], status="failed", result={"error": "Webhook test dispatcher failed"})
        audit_event("manual_webhook_repeat_test_failed", instance=instance_name, actionId=action["id"], sourceDeliveryId=delivery_id, webhookId=webhook_id, connectionId=str(connection.id), actorId=actor_id, error="dispatcher_exception")
        raise HTTPException(status_code=502, detail="Webhook test could not be completed") from exc

    safe_result = {
        "ok": bool(result.get("ok")), "statusCode": int(result.get("statusCode") or 0),
        "latencyMs": result.get("latencyMs"), "retriesUsed": int(result.get("retriesUsed") or 0),
        "error": result.get("error"),
    }
    status = "completed" if safe_result["ok"] else "failed"
    completed = update_action(action["id"], status=status, result=safe_result, new_delivery_id=result.get("deliveryId"))
    audit_event(
        "manual_webhook_repeat_test_completed" if status == "completed" else "manual_webhook_repeat_test_failed",
        instance=instance_name, actionId=action["id"], sourceDeliveryId=delivery_id, newDeliveryId=result.get("deliveryId"),
        webhookId=webhook_id, connectionId=str(connection.id), actorId=actor_id, result=status,
    )
    return {
        "actionId": action["id"], "action": "repeat_test", "status": status, "risk": "safe",
        "sourceDeliveryId": delivery_id, "newDeliveryId": result.get("deliveryId"), "configurationSource": "current",
        "result": completed.get("result") if completed else safe_result,
    }


@router.post("/{webhook_id}/deliveries/{delivery_id}/redeliver-current-target")
async def redeliver_current_target_route(
    webhook_id: str,
    delivery_id: str,
    request: Request,
    body: ManualWebhookActionRequest,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=128),
):
    """Redeliver a reconstructible real delivery to the current enabled target."""
    connection, instance_name, item = await _webhook_target(request, webhook_id)
    require_webhook_delivery_manual_action_access(request, connection)
    source = get_webhook_delivery(instance_name, webhook_id, delivery_id)
    if not source:
        raise HTTPException(status_code=404, detail="Webhook delivery not found")
    if bool(source.get("isTest")):
        raise HTTPException(status_code=409, detail="Webhook test deliveries must use repeat-test")
    if not body.confirm_current_target:
        raise HTTPException(status_code=409, detail="Current target confirmation is required for redelivery")
    if not item.get("enabled"):
        raise HTTPException(status_code=409, detail="Webhook is disabled")
    current_url = _validate_current_webhook_configuration(item)
    payload = _redelivery_payload(source)
    destination_drift = _observable_destination_drift(source, current_url)

    actor_id = str(getattr(request.state.user, "id", "") or "").strip()
    try:
        action, created = create_or_get_action(
            action="redeliver_current_target", source_delivery_id=delivery_id, target_id=webhook_id,
            connection_id=str(connection.id), actor_id=actor_id, idempotency_key=idempotency_key,
            reason=body.reason,
        )
    except ManualActionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail="Too many manual redelivery actions for this webhook") from exc

    if not created:
        return {
            "actionId": action["id"], "action": action["action"], "status": action["status"], "risk": action["risk"],
            "sourceDeliveryId": action["sourceDeliveryId"], "newDeliveryId": action.get("newDeliveryId"),
            "configurationSource": "current", "observableDestinationDrift": destination_drift, "result": action.get("result"),
        }

    update_action(action["id"], status="running")
    try:
        result = await dispatch_webhook_with_retry(
            payload=payload, request_id=f"manual-redelivery-{action['id'][-12:]}", item=item,
            manual_action_id=action["id"], bypass_filters=True,
        )
    except Exception as exc:
        update_action(action["id"], status="failed", result={"error": "Webhook redelivery dispatcher failed"})
        audit_event("manual_webhook_redelivery_failed", instance=instance_name, actionId=action["id"], sourceDeliveryId=delivery_id, webhookId=webhook_id, connectionId=str(connection.id), actorId=actor_id, destinationDrift=destination_drift, error="dispatcher_exception")
        raise HTTPException(status_code=502, detail="Webhook redelivery could not be completed") from exc

    safe_result = {
        "ok": bool(result.get("ok")), "statusCode": int(result.get("statusCode") or 0),
        "latencyMs": result.get("latencyMs"), "retriesUsed": int(result.get("retriesUsed") or 0),
        "error": result.get("error"),
    }
    status = "completed" if safe_result["ok"] else "failed"
    completed = update_action(action["id"], status=status, result=safe_result, new_delivery_id=result.get("deliveryId"))
    audit_event(
        "manual_webhook_redelivery_completed" if status == "completed" else "manual_webhook_redelivery_failed",
        instance=instance_name, actionId=action["id"], sourceDeliveryId=delivery_id, newDeliveryId=result.get("deliveryId"),
        webhookId=webhook_id, connectionId=str(connection.id), actorId=actor_id, destinationDrift=destination_drift, result=status,
    )
    return {
        "actionId": action["id"], "action": "redeliver_current_target", "status": status, "risk": "warning",
        "sourceDeliveryId": delivery_id, "newDeliveryId": result.get("deliveryId"), "configurationSource": "current",
        "observableDestinationDrift": destination_drift, "result": completed.get("result") if completed else safe_result,
    }


@router.post("/{webhook_id}/diagnose")
async def diagnose_webhook_route(webhook_id: str, request: Request):
    _connection, _instance_name, item = await _webhook_target(request, webhook_id)
    return await diagnose_webhook_target(url=_validate_url(str(item.get("url") or "")), timeout_s=8.0)


@router.get("/{webhook_id}/deliveries")
async def list_deliveries_route(
    webhook_id: str,
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: Literal["success", "failed", "timeout", "network_error", "configuration_error"] | None = None,
    operation: Literal["webhook.delivery", "webhook.test"] | None = None,
    event_type: str | None = Query(default=None, max_length=160),
    is_test: bool | None = Query(default=None),
    delivery_id: str | None = Query(default=None, min_length=1, max_length=256),
    event_id: str | None = Query(default=None, min_length=1, max_length=256),
    request_id: str | None = Query(default=None, min_length=1, max_length=256),
    correlation_id: str | None = Query(default=None, min_length=1, max_length=256),
    search: str | None = Query(default=None, min_length=1, max_length=256),
    date_from: int | None = Query(default=None, ge=0),
    date_to: int | None = Query(default=None, ge=0),
):
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(status_code=422, detail="date_from must be before or equal to date_to")
    connection, instance_name, _item = await _webhook_target(request, webhook_id)
    return list_webhook_delivery_page(
        instance_name, webhook_id, limit=limit, offset=offset, status=status, operation=operation,
        event_type=event_type, is_test=is_test, delivery_id=delivery_id, event_id=event_id,
        request_id=request_id, correlation_id=correlation_id, search=None if search == connection.id else search,
        date_from=date_from, date_to=date_to,
    )


@router.get("/{webhook_id}/deliveries/{delivery_id}")
async def get_delivery_route(webhook_id: str, delivery_id: str, request: Request):
    _connection, instance_name, _item = await _webhook_target(request, webhook_id)
    delivery = get_webhook_delivery(instance_name, webhook_id, delivery_id)
    if not delivery:
        raise HTTPException(status_code=404, detail="Webhook delivery not found")
    return delivery
