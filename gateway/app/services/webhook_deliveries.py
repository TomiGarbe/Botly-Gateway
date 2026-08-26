"""Independent, safe persistence for webhook delivery evidence.

Webhook configuration remains in ``instance_webhooks.json`` for compatibility.
This store owns only delivery executions and may be replaced by a database later.
"""
from __future__ import annotations

import copy
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.secret_protection import REDACTED, SecretRedactor
from app.models.observability import COMMON_SEMANTIC_STATUSES

logger = get_logger(__name__)
_LOCK = threading.Lock()


@dataclass(frozen=True)
class WebhookDeliveryFilters:
    """Identifier-only query contract for a single, owned webhook."""

    status: str | None = None
    operation: str | None = None
    event_type: str | None = None
    is_test: bool | None = None
    delivery_id: str | None = None
    event_id: str | None = None
    request_id: str | None = None
    correlation_id: str | None = None
    search: str | None = None
    date_from: int | None = None
    date_to: int | None = None


def _path() -> Path:
    settings = get_settings()
    configured = str(getattr(settings, "webhook_deliveries_path", "") or "").strip()
    if configured:
        return Path(configured).resolve()
    # Compatibility for tests and older configurations which only provide the
    # webhook configuration path.
    config_path = Path(str(getattr(settings, "instance_webhooks_path", "/tmp/botly_instance_webhooks.json")))
    return config_path.with_name("webhook_deliveries.json").resolve()


def _retention() -> int:
    return max(1, min(int(getattr(get_settings(), "webhook_delivery_retention", 250) or 250), 10_000))


def _max_payload_bytes() -> int:
    return max(1_024, min(int(getattr(get_settings(), "webhook_delivery_max_payload_bytes", 16_384) or 16_384), 1_048_576))


def _empty() -> dict[str, Any]:
    return {"version": 1, "deliveries": []}


def _ensure_private(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    if path.exists():
        try:
            path.chmod(0o600)
        except OSError:
            pass


def _read_unlocked() -> dict[str, Any]:
    path = _path()
    _ensure_private(path)
    if not path.exists():
        return _empty()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("webhook_delivery_store_read_failed", path=str(path), error=str(exc))
        return _empty()
    if not isinstance(value, dict) or not isinstance(value.get("deliveries"), list):
        return _empty()
    return {"version": 1, "deliveries": value["deliveries"]}


def _write_unlocked(store: dict[str, Any]) -> None:
    path = _path()
    _ensure_private(path)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(store, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(path)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _bounded(value: Any, limit: int) -> str:
    raw = str(value or "")
    encoded = raw.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return raw
    return encoded[:limit].decode("utf-8", errors="ignore") + "…[truncated]"


def _safe_value(value: Any, limit: int) -> Any:
    redacted = SecretRedactor.redact_json(copy.deepcopy(value))
    if isinstance(redacted, dict):
        return {str(key): _safe_value(item, limit) for key, item in redacted.items()}
    if isinstance(redacted, list):
        return [_safe_value(item, limit) for item in redacted[:25]]
    if isinstance(redacted, str):
        return _bounded(redacted, limit)
    return redacted


def _safe_preview(value: Any, limit: int) -> str:
    raw = SecretRedactor.redact_url(str(value or ""))
    return _bounded(SecretRedactor.redact_json_preview(raw), limit)


def _semantic_status(entry: dict[str, Any], success: bool, status_code: int, error_type: str | None) -> str:
    if success:
        return "success"
    explicit = str(entry.get("semanticStatus") or "").strip().lower()
    if explicit in COMMON_SEMANTIC_STATUSES:
        return explicit
    if error_type == "timeout":
        return "timeout"
    if error_type in {"dns_error", "dns_fail", "network_error", "connection_error", "connection_refused", "connect_error", "read_error", "write_error", "transport_error", "ssl_fail"}:
        return "network_error"
    if error_type in {"invalid_url", "configuration_error"}:
        return "configuration_error"
    return "failed" if status_code or error_type or entry.get("error") else "failed"


def _safe_request_url(url: Any, query: Any) -> tuple[str | None, dict[str, str]]:
    raw = str(url or "").strip()
    extra = query if isinstance(query, dict) else {}
    try:
        parsed = urlsplit(raw)
        values = [*parse_qsl(parsed.query, keep_blank_values=True), *[(str(key), str(value)) for key, value in extra.items()]]
        safe_query = {key: REDACTED if SecretRedactor.is_sensitive_name(key) else _bounded(value, 512) for key, value in values}
        safe_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(list(safe_query.items())), parsed.fragment)) if raw else ""
        return SecretRedactor.redact_url(safe_url) or None, safe_query
    except ValueError:
        return SecretRedactor.redact_url(raw) or None, _safe_value(extra, 512)


def sanitize_delivery(entry: dict[str, Any]) -> dict[str, Any]:
    """Normalize an execution record without retaining credentials or large data."""
    request = entry.get("request") if isinstance(entry.get("request"), dict) else {}
    response = entry.get("response") if isinstance(entry.get("response"), dict) else {}
    attempts = entry.get("attempts") if isinstance(entry.get("attempts"), list) else []
    byte_limit = _max_payload_bytes()
    preview_limit = min(byte_limit, 4_000)
    response_limit = min(byte_limit, 2_000)
    webhook_id = str(entry.get("webhookId") or "").strip()
    is_test = bool(entry.get("isTest") or entry.get("testMode") or (entry.get("metadata") or {}).get("test"))
    error_type = str(entry.get("errorType") or "").strip() or None
    status_code = _as_int(entry.get("statusCode", entry.get("responseCode")))
    success = bool(entry.get("success"))
    request_url, request_query = _safe_request_url(request.get("url") or entry.get("destinationUrl"), request.get("query"))
    timestamp = _as_int(entry.get("timestamp"), int(time.time() * 1000))
    safe_error = _safe_preview(entry.get("error"), response_limit) or None
    semantic_status = _semantic_status(entry, success, status_code, error_type)
    correlation_id = str(entry.get("correlationId") or entry.get("dispatchId") or "").strip() or None
    event_id = str(entry.get("eventId") or "").strip() or None
    metadata = _safe_value(entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}, preview_limit)
    metadata = {**metadata, **{key: value for key, value in {"eventId": event_id, "requestId": str(entry.get("requestId") or "").strip() or None, "connectionId": str(entry.get("connectionId") or "").strip() or None}.items() if value}}
    return {
        "id": str(entry.get("id") or entry.get("deliveryId") or f"delivery_{uuid.uuid4().hex}"),
        # Compatibility aliases are deliberately safe and help legacy
        # consumers transition from dispatch history to deliveries.
        "dispatchId": str(entry.get("dispatchId") or entry.get("correlationId") or "").strip() or None,
        "webhookId": webhook_id,
        "webhookName": _bounded(entry.get("webhookName"), 256) or None,
        "instanceName": str(entry.get("instanceName") or "").strip() or None,
        "destinationUrl": SecretRedactor.redact_url(str(entry.get("destinationUrl") or "")) or None,
        "timestamp": timestamp,
        "operation": str(entry.get("operation") or ("webhook.test" if is_test else "webhook.delivery")),
        "semanticStatus": semantic_status,
        "source": {"service": "botly_gateway", "instanceName": str(entry.get("instanceName") or "").strip() or None},
        "destination": {"type": "webhook", "webhookId": webhook_id, "url": SecretRedactor.redact_url(str(entry.get("destinationUrl") or "")) or None},
        "eventType": str(entry.get("eventType") or entry.get("eventSubtype") or "").strip() or None,
        "status": str(entry.get("status") or "failed").strip() or "failed",
        "success": success,
        "failure": bool(entry.get("failure", not success)),
        "statusCode": status_code,
        "responseCode": status_code,
        "durationMs": _as_float(entry.get("durationMs")),
        "attemptCount": max(1, _as_int(entry.get("attemptCount"), len(attempts) or 1)),
        "retryCount": max(0, _as_int(entry.get("retryCount"))),
        "firstAttemptAt": _as_int(entry.get("firstAttemptAt"), timestamp),
        "lastAttemptAt": _as_int(entry.get("lastAttemptAt"), timestamp),
        "correlationId": correlation_id,
        "eventId": event_id,
        "requestId": str(entry.get("requestId") or "").strip() or None,
        "messageId": str(entry.get("messageId") or "").strip() or None,
        "conversationId": str(entry.get("conversationId") or "").strip() or None,
        "isTest": is_test,
        "error": safe_error,
        "errorType": error_type,
        "errorDetail": {"code": error_type or semantic_status, "category": error_type or semantic_status, "message": safe_error, "retryable": entry.get("retryable") if isinstance(entry.get("retryable"), bool) else None} if safe_error or error_type else None,
        "retryable": entry.get("retryable") if isinstance(entry.get("retryable"), bool) else None,
        "request": {
            "method": str(request.get("method") or "POST"),
            "url": request_url,
            "query": request_query,
            "headers": SecretRedactor.redact_headers(request.get("headers") if isinstance(request.get("headers"), dict) else {}),
            "payloadSummary": _safe_value(request.get("payloadSummary") if isinstance(request.get("payloadSummary"), dict) else {}, preview_limit),
            "payloadSizeBytes": _as_int(request.get("payloadSizeBytes")),
            "payloadPreview": _safe_preview(request.get("payloadPreview"), preview_limit),
            "payloadTruncated": bool(request.get("payloadTruncated")),
        },
        "response": {
            "status": status_code or None,
            "headers": SecretRedactor.redact_headers(response.get("headers") if isinstance(response.get("headers"), dict) else {}),
            "bodyPreview": _safe_preview(response.get("bodyPreview"), response_limit),
        },
        "attempts": [_safe_value(item, response_limit) for item in attempts if isinstance(item, dict)][:10],
        "metadata": metadata,
    }


def append_webhook_delivery(entry: dict[str, Any]) -> dict[str, Any]:
    delivery = sanitize_delivery(entry)
    if not delivery["webhookId"]:
        raise ValueError("Webhook delivery requires webhookId")
    with _LOCK:
        store = _read_unlocked()
        deliveries = [item for item in store["deliveries"] if isinstance(item, dict)]
        deliveries.append(delivery)
        same_webhook = sorted(
            (item for item in deliveries if str(item.get("webhookId") or "") == delivery["webhookId"]),
            key=lambda item: _as_int(item.get("timestamp")),
            reverse=True,
        )
        retained_ids = {str(item.get("id")) for item in same_webhook[:_retention()]}
        store["deliveries"] = [
            item for item in deliveries
            if str(item.get("webhookId") or "") != delivery["webhookId"] or str(item.get("id")) in retained_ids
        ]
        _write_unlocked(store)
    return copy.deepcopy(delivery)


def filter_deliveries(
    items: list[dict[str, Any]], *, status: str | None = None, operation: str | None = None,
    event_type: str | None = None, is_test: bool | None = None, delivery_id: str | None = None,
    event_id: str | None = None, request_id: str | None = None, correlation_id: str | None = None,
    search: str | None = None, date_from: int | None = None, date_to: int | None = None,
) -> list[dict[str, Any]]:
    filters = WebhookDeliveryFilters(
        status=status, operation=operation, event_type=event_type, is_test=is_test, delivery_id=delivery_id,
        event_id=event_id, request_id=request_id, correlation_id=correlation_id, search=search,
        date_from=date_from, date_to=date_to,
    )
    filtered = items
    if filters.status:
        filtered = [item for item in filtered if str(item.get("semanticStatus") or item.get("status") or "").lower() == filters.status.lower()]
    if filters.operation:
        filtered = [item for item in filtered if str(item.get("operation") or "") == filters.operation]
    if filters.event_type:
        filtered = [item for item in filtered if str(item.get("eventType") or "") == filters.event_type]
    if filters.is_test is not None:
        filtered = [item for item in filtered if bool(item.get("isTest")) is filters.is_test]
    comparisons = {"id": filters.delivery_id, "eventId": filters.event_id, "requestId": filters.request_id, "correlationId": filters.correlation_id}
    for key, expected in comparisons.items():
        if expected is not None:
            filtered = [item for item in filtered if str(item.get(key) or "") == expected]
    if filters.search is not None:
        filtered = [item for item in filtered if any(
            str(item.get(key) or "") == filters.search
            for key in ("id", "webhookId", "eventId", "requestId", "correlationId")
        )]
    if filters.date_from is not None:
        filtered = [item for item in filtered if _as_int(item.get("timestamp")) >= filters.date_from]
    if filters.date_to is not None:
        filtered = [item for item in filtered if _as_int(item.get("timestamp")) <= filters.date_to]
    return sorted(filtered, key=lambda item: (_as_int(item.get("timestamp")), str(item.get("id") or "")), reverse=True)


def delivery_list_item(item: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "webhookId", "timestamp", "operation", "eventType", "semanticStatus", "status", "success", "statusCode", "durationMs", "attemptCount", "retryCount", "correlationId", "eventId", "requestId", "messageId", "conversationId", "isTest", "errorType", "retryable")
    return {key: item.get(key) for key in keys}


def delivery_detail(item: dict[str, Any]) -> dict[str, Any]:
    """Full safe delivery contract. Flat fields remain for transition callers."""
    safe = sanitize_delivery(item)
    safe["summary"] = {
        key: safe.get(key)
        for key in ("id", "timestamp", "operation", "eventType", "semanticStatus", "status", "success", "statusCode", "durationMs", "attemptCount", "retryCount", "correlationId", "eventId", "requestId", "messageId", "conversationId", "isTest", "source", "destination")
    }
    return safe


def list_webhook_deliveries(webhook_id: str, *, limit: int = 50, success: bool | None = None) -> list[dict[str, Any]]:
    with _LOCK:
        items = [copy.deepcopy(item) for item in _read_unlocked()["deliveries"] if isinstance(item, dict) and str(item.get("webhookId") or "") == webhook_id]
    if success is not None:
        items = [item for item in items if bool(item.get("success")) is success]
    return filter_deliveries(items)[:max(1, min(limit, 500))]


def get_webhook_delivery(webhook_id: str, delivery_id: str) -> dict[str, Any] | None:
    with _LOCK:
        for item in _read_unlocked()["deliveries"]:
            if isinstance(item, dict) and str(item.get("webhookId") or "") == webhook_id and str(item.get("id") or "") == delivery_id:
                return copy.deepcopy(item)
    return None


def list_instance_deliveries(instance_name: str, *, limit: int = 50, success: bool | None = None) -> list[dict[str, Any]]:
    with _LOCK:
        items = [copy.deepcopy(item) for item in _read_unlocked()["deliveries"] if isinstance(item, dict) and str(item.get("instanceName") or "") == instance_name]
    if success is not None:
        items = [item for item in items if bool(item.get("success")) is success]
    items.sort(key=lambda item: _as_int(item.get("timestamp")), reverse=True)
    return items[:max(1, min(limit, 500))]


def list_all_delivery_summaries() -> list[dict[str, Any]]:
    """Return one bounded, payload-free read for aggregate observability.

    Analytics deliberately consumes this projection instead of creating or
    retaining another delivery representation.  ``instanceName`` is included
    solely to resolve connection ownership before aggregation.
    """
    fields = (
        "id", "instanceName", "webhookId", "timestamp", "semanticStatus", "success",
        "durationMs", "attemptCount", "retryCount", "isTest", "operation",
    )
    with _LOCK:
        return [
            {field: copy.deepcopy(item.get(field)) for field in fields}
            for item in _read_unlocked()["deliveries"] if isinstance(item, dict)
        ]
