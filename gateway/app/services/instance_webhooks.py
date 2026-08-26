from __future__ import annotations

import base64
import copy
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlparse, urlsplit, urlunsplit

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.secret_protection import REDACTED, SecretCipher, SecretRedactor
from app.services.webhook_deliveries import (
    append_webhook_delivery,
    delivery_detail,
    delivery_list_item,
    filter_deliveries,
    get_webhook_delivery as get_stored_webhook_delivery,
    list_instance_deliveries,
    list_webhook_deliveries,
)

logger = get_logger(__name__)
_LOCK = threading.Lock()
_DEFAULT_EVENT_FILTERS = {"business": True, "transport": False, "operational": False}

AuthType = Literal["NONE", "BEARER", "API_KEY", "BASIC", "CUSTOM_HEADERS", "QUERY_PARAM"]


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _storage_path() -> Path:
    settings = get_settings()
    return Path(settings.instance_webhooks_path).resolve()


def _empty_store() -> dict[str, Any]:
    return {"instances": {}}


def _ensure_private_storage_unlocked(path: Path) -> None:
    """Enforce private permissions even if the volume/path already existed."""
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


def _read_store_unlocked() -> dict[str, Any]:
    path = _storage_path()
    _ensure_private_storage_unlocked(path)
    if not path.exists():
        return _empty_store()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.error("instance_webhooks_store_read_failed", error=str(exc))
        return _empty_store()
    if not isinstance(raw, dict):
        return _empty_store()
    instances = raw.get("instances")
    if not isinstance(instances, dict):
        return _empty_store()
    return {"instances": instances}


def _write_store_unlocked(store: dict[str, Any]) -> None:
    path = _storage_path()
    _ensure_private_storage_unlocked(path)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(store, ensure_ascii=True, indent=2), encoding="utf-8")
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(path)


def _backup_legacy_store_unlocked(store: dict[str, Any]) -> None:
    """Preserve a private, one-time rollback copy before encrypting legacy data."""
    path = _storage_path()
    backup = path.with_suffix(f"{path.suffix}.pre-encryption-backup")
    if backup.exists():
        _ensure_private_storage_unlocked(backup)
        return
    _ensure_private_storage_unlocked(backup)
    temporary = backup.with_suffix(f"{backup.suffix}.tmp")
    temporary.write_text(json.dumps(store, ensure_ascii=True, indent=2), encoding="utf-8")
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(backup)


def _secret_ciphers() -> tuple[SecretCipher, ...]:
    settings = get_settings()
    configured = str(getattr(settings, "instance_webhooks_encryption_key", "") or "").strip()
    fallback = str(getattr(settings, "gateway_api_key", "") or "").strip()
    materials = [item for item in (configured, fallback) if item]
    return tuple(SecretCipher(item) for index, item in enumerate(materials) if item not in materials[:index])


def _secret_cipher() -> SecretCipher:
    ciphers = _secret_ciphers()
    if not ciphers:
        raise RuntimeError("No hay clave configurada para proteger secretos de webhook")
    return ciphers[0]


def _decrypt_secret_value(value: object) -> str:
    raw = str(value or "")
    if not SecretCipher.is_encrypted(raw):
        return raw
    for cipher in _secret_ciphers():
        try:
            return cipher.decrypt_or_legacy(raw)[0]
        except RuntimeError:
            continue
    raise RuntimeError("No se pudo descifrar un secreto de webhook")


def _decrypt_auth_config(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(raw) if isinstance(raw, dict) else {}
    for key in ("token", "apiKey", "password", "queryParamValue"):
        if key in value:
            value[key] = _decrypt_secret_value(value[key])
    return value


def _encrypt_auth_config(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(raw) if isinstance(raw, dict) else {}
    cipher = _secret_cipher()
    for key in ("token", "apiKey", "password", "queryParamValue"):
        if str(value.get(key) or "").strip():
            value[key] = cipher.encrypt(str(value[key]))
    return value


def _decrypt_custom_headers(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(raw) if isinstance(raw, dict) else {}
    for key, item in value.items():
        if SecretRedactor.is_sensitive_name(key):
            value[key] = _decrypt_secret_value(item)
    return value


def _encrypt_custom_headers(raw: Any) -> dict[str, Any]:
    value = copy.deepcopy(raw) if isinstance(raw, dict) else {}
    cipher = _secret_cipher()
    for key, item in value.items():
        if SecretRedactor.is_sensitive_name(key) and str(item or "").strip():
            value[key] = cipher.encrypt(str(item))
    return value


def _transform_sensitive_url_query(raw: object, transform) -> str:
    """Transform only credential-like query values while retaining the URL shape."""
    value = str(raw or "").strip()
    try:
        parsed = urlsplit(value)
        if not parsed.query:
            return value
        query = [
            (key, transform(item) if SecretRedactor.is_sensitive_name(key) and item else item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        ]
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
    except ValueError:
        return value


def _decrypt_webhook_url(raw: object) -> str:
    return _transform_sensitive_url_query(raw, _decrypt_secret_value)


def _encrypt_webhook_url(raw: object) -> str:
    cipher = _secret_cipher()
    return _transform_sensitive_url_query(raw, lambda value: cipher.encrypt(str(value)))


def _sanitize_headers(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        k = str(key or "").strip()
        if not k:
            continue
        out[k] = str(value or "").strip()
    return out


def _sanitize_auth_config(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    allowed = ("token", "headerName", "apiKey", "username", "password", "queryParamName", "queryParamValue")
    for key in allowed:
        value = str(raw.get(key) or "").strip()
        if value:
            out[key] = value
    return out


def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _default_webhook_name(instance_name: str, record: dict[str, Any]) -> str:
    explicit = str(record.get("name") or "").strip()
    if explicit:
        return explicit[:120]
    parsed = urlparse(str(record.get("url") or "").strip())
    host = (parsed.netloc or parsed.hostname or "").strip()
    if host:
        return host[:120]
    fallback_id = str(record.get("id") or "webhook")[:8]
    return f"{instance_name}-{fallback_id}"


def _sanitize_dispatch_history_entry(record: dict[str, Any]) -> dict[str, Any]:
    request = record.get("request") if isinstance(record.get("request"), dict) else {}
    response = record.get("response") if isinstance(record.get("response"), dict) else {}
    attempts = record.get("attempts") if isinstance(record.get("attempts"), list) else []
    return {
        "timestamp": _coerce_int(record.get("timestamp"), int(time.time() * 1000)),
        "dispatchId": str(record.get("dispatchId") or "").strip() or None,
        "webhookId": str(record.get("webhookId") or "").strip() or None,
        "webhookName": str(record.get("webhookName") or "").strip() or None,
        "instanceName": str(record.get("instanceName") or "").strip() or None,
        "destinationUrl": SecretRedactor.redact_url(str(record.get("destinationUrl") or record.get("webhookUrl") or "").strip()) or None,
        "eventType": str(record.get("eventType") or record.get("eventSubtype") or "").strip() or None,
        "messageId": str(record.get("messageId") or "").strip() or None,
        "conversationId": str(record.get("conversationId") or "").strip() or None,
        "status": str(record.get("status") or "").strip() or "failed",
        "success": bool(record.get("success")),
        "failure": bool(record.get("failure", not bool(record.get("success")))),
        "statusCode": record.get("statusCode", record.get("responseCode")),
        "responseCode": record.get("responseCode", record.get("statusCode")),
        "durationMs": _coerce_float(record.get("durationMs")),
        "attemptCount": max(1, _coerce_int(record.get("attemptCount"), len(attempts) or 1)),
        "retryCount": max(0, _coerce_int(record.get("retryCount"))),
        "error": str(record.get("error") or "").strip() or None,
        "errorType": str(record.get("errorType") or "").strip() or None,
        "request": {
            "method": str(request.get("method") or "POST"),
            "headers": SecretRedactor.redact_headers(request.get("headers")),
            "payloadSummary": SecretRedactor.redact_json(request.get("payloadSummary") if isinstance(request.get("payloadSummary"), dict) else {}),
            "payloadSizeBytes": _coerce_int(request.get("payloadSizeBytes")),
            "payloadPreview": SecretRedactor.redact_json_preview(str(request.get("payloadPreview") or ""), max_chars=4000),
            "payloadTruncated": bool(request.get("payloadTruncated")),
        },
        "response": {
            "headers": SecretRedactor.redact_headers(response.get("headers")),
            "bodyPreview": SecretRedactor.redact_json_preview(str(response.get("bodyPreview") or ""), max_chars=2000),
        },
        "attempts": [SecretRedactor.redact_json(item) for item in attempts if isinstance(item, dict)][:10],
    }


def _apply_dispatch_aggregate_fields(item: dict[str, Any], *, status: str, error: str | None, status_code: int | None, latency_ms: float | None, retries_used: int, retryable: bool | None) -> dict[str, Any]:
    now = _now_iso()
    prev_success = int(item.get("successCount") or 0)
    prev_failure = int(item.get("failureCount") or 0)
    prev_retry = int(item.get("retryCount") or 0)
    prev_unhealthy = int(item.get("unhealthyCount") or 0)
    prev_consecutive = int(item.get("consecutiveFailures") or 0)
    prev_avg = float(item.get("avgLatencyMs") or 0.0)
    was_unhealthy = str(item.get("healthStatus") or "").lower() == "unhealthy"
    is_success = str(status).startswith("ok_") or status == "success"
    next_success = prev_success + (1 if is_success else 0)
    next_failure = prev_failure + (0 if is_success else 1)
    next_retry = prev_retry + max(0, int(retries_used or 0))
    next_consecutive = 0 if is_success else (prev_consecutive + 1)
    sample_count = next_success + next_failure
    next_avg = prev_avg
    if latency_ms is not None:
        next_avg = ((prev_avg * max(0, sample_count - 1)) + float(latency_ms)) / max(1, sample_count)
    next_health = "healthy"
    if next_consecutive >= 5:
        next_health = "unhealthy"
    elif next_consecutive > 0:
        next_health = "degraded"
    next_unhealthy_count = prev_unhealthy + (1 if (next_health == "unhealthy" and not was_unhealthy) else 0)
    return {
        **item,
        "lastUsedAt": now,
        "lastStatus": status,
        "lastError": (error or "")[:300] if error else None,
        "lastStatusCode": status_code,
        "lastLatencyMs": latency_ms,
        "lastSuccessAt": now if is_success else item.get("lastSuccessAt"),
        "lastFailureAt": now if not is_success else item.get("lastFailureAt"),
        "avgLatencyMs": round(next_avg, 2),
        "consecutiveFailures": next_consecutive,
        "healthStatus": next_health,
        "unhealthy": next_health == "unhealthy",
        "successCount": next_success,
        "failureCount": next_failure,
        "retryCount": next_retry,
        "unhealthyCount": next_unhealthy_count,
        "updatedAt": now,
        "lastRetryable": retryable,
    }


def _sanitize_webhook(instance_name: str, record: dict[str, Any]) -> dict[str, Any]:
    auth_type = str(record.get("authType") or "NONE").upper()
    if auth_type not in {"NONE", "BEARER", "API_KEY", "BASIC", "CUSTOM_HEADERS", "QUERY_PARAM"}:
        auth_type = "NONE"

    consecutive_failures = int(record.get("consecutiveFailures") or 0)
    success_count = int(record.get("successCount") or 0)
    failure_count = int(record.get("failureCount") or 0)
    retry_count = int(record.get("retryCount") or 0)
    unhealthy_count = int(record.get("unhealthyCount") or 0)
    avg_latency_ms = float(record.get("avgLatencyMs") or 0.0)
    status_raw = str(record.get("healthStatus") or "").strip().lower()
    if status_raw not in {"healthy", "degraded", "unhealthy"}:
        if consecutive_failures >= 5:
            status_raw = "unhealthy"
        elif consecutive_failures > 0:
            status_raw = "degraded"
        else:
            status_raw = "healthy"

    return {
        "id": str(record.get("id") or str(uuid.uuid4())[:16]),
        "instanceId": instance_name,
        "name": _default_webhook_name(instance_name, record),
        "url": str(record.get("url") or "").strip(),
        "enabled": bool(record.get("enabled", True)),
        "authType": auth_type,
        "authConfig": _sanitize_auth_config(record.get("authConfig")),
        "customHeaders": _sanitize_headers(record.get("customHeaders")),
        "createdAt": str(record.get("createdAt") or _now_iso()),
        "updatedAt": str(record.get("updatedAt") or _now_iso()),
        "lastUsedAt": record.get("lastUsedAt"),
        "lastStatus": record.get("lastStatus"),
        "lastError": record.get("lastError"),
        "lastSuccessAt": record.get("lastSuccessAt"),
        "lastFailureAt": record.get("lastFailureAt"),
        "lastStatusCode": record.get("lastStatusCode"),
        "lastLatencyMs": record.get("lastLatencyMs"),
        "avgLatencyMs": avg_latency_ms,
        "consecutiveFailures": max(0, consecutive_failures),
        "healthStatus": status_raw,
        "unhealthy": status_raw == "unhealthy",
        "successCount": max(0, success_count),
        "failureCount": max(0, failure_count),
        "retryCount": max(0, retry_count),
        "unhealthyCount": max(0, unhealthy_count),
        "eventFilters": record.get("eventFilters")
        if isinstance(record.get("eventFilters"), dict)
        else dict(_DEFAULT_EVENT_FILTERS),
        "dispatchHistory": [_sanitize_dispatch_history_entry(item) for item in record.get("dispatchHistory", []) if isinstance(item, dict)],
    }


def _hydrate_webhook(instance_name: str, record: dict[str, Any]) -> dict[str, Any]:
    """Return runtime-ready webhook data, accepting legacy plaintext storage."""
    return _sanitize_webhook(
        instance_name,
        {
            **record,
            "url": _decrypt_webhook_url(record.get("url")),
            "authConfig": _decrypt_auth_config(record.get("authConfig")),
            "customHeaders": _decrypt_custom_headers(record.get("customHeaders")),
        },
    )


def _webhook_for_storage(instance_name: str, record: dict[str, Any]) -> dict[str, Any]:
    """Encrypt sensitive values while retaining non-secret webhook configuration."""
    clean = _sanitize_webhook(instance_name, record)
    return {
        **clean,
        "url": _encrypt_webhook_url(clean.get("url")),
        "authConfig": _encrypt_auth_config(clean.get("authConfig")),
        "customHeaders": _encrypt_custom_headers(clean.get("customHeaders")),
    }


def _mask_secret(value: str, keep_start: int = 4, keep_end: int = 2) -> str:
    raw = str(value or "")
    if not raw:
        return ""
    if len(raw) <= keep_start + keep_end:
        return "*" * len(raw)
    return f"{raw[:keep_start]}...{raw[-keep_end:]}"


def _public_webhook(record: dict[str, Any], reveal_secrets: bool = False) -> dict[str, Any]:
    item = copy.deepcopy(record)
    auth = item.get("authConfig") if isinstance(item.get("authConfig"), dict) else {}
    safe_auth: dict[str, Any] = {}

    for key, value in auth.items():
        if key in {"token", "apiKey", "password", "queryParamValue"} and not reveal_secrets:
            safe_auth[key] = REDACTED
            safe_auth[f"has{key[:1].upper()}{key[1:]}"] = bool(str(value or "").strip())
        else:
            safe_auth[key] = value

    item["authConfig"] = safe_auth
    custom_headers = item.get("customHeaders") if isinstance(item.get("customHeaders"), dict) else {}
    if not reveal_secrets:
        item["customHeaders"] = {str(key): REDACTED for key in custom_headers if str(key).strip()}
        item["hasCustomHeaders"] = bool(custom_headers)
        item["url"] = SecretRedactor.redact_url(str(item.get("url") or ""))
    return item


def _merge_auth_config_update(
    *,
    previous_auth_type: str,
    previous_auth_config: dict[str, Any],
    next_auth_type: str,
    next_auth_config: dict[str, Any] | None,
) -> dict[str, Any]:
    incoming = _sanitize_auth_config(next_auth_config or {})
    if previous_auth_type != next_auth_type:
        return incoming

    previous = _sanitize_auth_config(previous_auth_config)
    merged = dict(incoming)
    for secret_key in ("token", "apiKey", "password", "queryParamValue"):
        if not str(merged.get(secret_key) or "").strip() and str(previous.get(secret_key) or "").strip():
            merged[secret_key] = previous[secret_key]
    return merged


def list_instance_webhooks(instance_name: str, reveal_secrets: bool = False) -> list[dict[str, Any]]:
    with _LOCK:
        store = _read_store_unlocked()
        raw_list = store["instances"].get(instance_name) or []
        if not isinstance(raw_list, list):
            return []
        clean = [_hydrate_webhook(instance_name, item) for item in raw_list if isinstance(item, dict)]
        protected = [_webhook_for_storage(instance_name, item) for item in clean]
        if protected != raw_list:
            _backup_legacy_store_unlocked(store)
            store["instances"][instance_name] = protected
            _write_store_unlocked(store)
    return [_public_webhook(item, reveal_secrets=reveal_secrets) for item in clean]


def protect_stored_webhook_secrets() -> int:
    """Upgrade legacy plaintext webhook credentials without deleting records."""
    with _LOCK:
        store = _read_store_unlocked()
        changed = 0
        for instance_name, raw_list in list(store["instances"].items()):
            if not isinstance(raw_list, list):
                continue
            clean = [_hydrate_webhook(str(instance_name), item) for item in raw_list if isinstance(item, dict)]
            protected = [_webhook_for_storage(str(instance_name), item) for item in clean]
            if protected != raw_list:
                store["instances"][instance_name] = protected
                changed += len(clean)
        if changed:
            # `store` still contains every unmodified instance except the ones
            # upgraded above; read the original once more for the rollback copy.
            original = _read_store_unlocked()
            _backup_legacy_store_unlocked(original)
            _write_store_unlocked(store)
        return changed


def get_webhook(instance_name: str, webhook_id: str, reveal_secrets: bool = False) -> dict[str, Any] | None:
    hooks = list_instance_webhooks(instance_name, reveal_secrets=True)
    for hook in hooks:
        if hook["id"] == webhook_id:
            return _public_webhook(hook, reveal_secrets=reveal_secrets)
    return None


def create_webhook(
    instance_name: str,
    *,
    name: str | None,
    url: str,
    enabled: bool,
    auth_type: AuthType,
    auth_config: dict[str, Any] | None,
    custom_headers: dict[str, Any] | None,
    event_filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = _now_iso()
    new_item = _sanitize_webhook(
        instance_name,
        {
            "id": str(uuid.uuid4())[:16],
            "instanceId": instance_name,
            "name": name,
            "url": url,
            "enabled": enabled,
            "authType": auth_type,
            "authConfig": auth_config or {},
            "customHeaders": custom_headers or {},
            "eventFilters": event_filters if isinstance(event_filters, dict) else dict(_DEFAULT_EVENT_FILTERS),
            "createdAt": now,
            "updatedAt": now,
            "lastUsedAt": None,
            "lastStatus": None,
            "lastError": None,
            "lastSuccessAt": None,
            "lastFailureAt": None,
            "lastStatusCode": None,
            "lastLatencyMs": None,
            "avgLatencyMs": 0.0,
            "consecutiveFailures": 0,
            "healthStatus": "healthy",
            "unhealthy": False,
            "successCount": 0,
            "failureCount": 0,
            "retryCount": 0,
            "unhealthyCount": 0,
        },
    )
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            hooks = []
        hooks.append(_webhook_for_storage(instance_name, new_item))
        store["instances"][instance_name] = hooks
        _write_store_unlocked(store)
    return _public_webhook(new_item)


def update_webhook(
    instance_name: str,
    webhook_id: str,
    *,
    name: str | None,
    url: str,
    enabled: bool,
    auth_type: AuthType,
    auth_config: dict[str, Any] | None,
    custom_headers: dict[str, Any] | None,
    event_filters: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            return None
        for idx, item in enumerate(hooks):
            if not isinstance(item, dict) or str(item.get("id")) != webhook_id:
                continue
            current = _hydrate_webhook(instance_name, item)
            merged = _sanitize_webhook(
                instance_name,
                {
                    **current,
                    "name": name or current.get("name"),
                    "url": url,
                    "enabled": enabled,
                    "authType": auth_type,
                    "authConfig": _merge_auth_config_update(
                        previous_auth_type=str(current.get("authType") or "NONE").upper(),
                        previous_auth_config=current.get("authConfig") if isinstance(current.get("authConfig"), dict) else {},
                        next_auth_type=str(auth_type or "NONE").upper(),
                        next_auth_config=auth_config,
                    ),
                    "customHeaders": custom_headers if custom_headers is not None else current.get("customHeaders"),
                    "eventFilters": event_filters if isinstance(event_filters, dict) else current.get("eventFilters"),
                    "updatedAt": _now_iso(),
                },
            )
            hooks[idx] = _webhook_for_storage(instance_name, merged)
            store["instances"][instance_name] = hooks
            _write_store_unlocked(store)
            return _public_webhook(merged)
    return None


def set_webhook_filters(instance_name: str, webhook_id: str, event_filters: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"business", "transport", "operational"}
    normalized = {k: bool(v) for k, v in event_filters.items() if k in allowed}
    if not normalized:
        normalized = dict(_DEFAULT_EVENT_FILTERS)
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            return None
        for idx, item in enumerate(hooks):
            if not isinstance(item, dict) or str(item.get("id")) != webhook_id:
                continue
            current = _hydrate_webhook(instance_name, item)
            merged = _sanitize_webhook(instance_name, {**current, "eventFilters": normalized, "updatedAt": _now_iso()})
            hooks[idx] = _webhook_for_storage(instance_name, merged)
            store["instances"][instance_name] = hooks
            _write_store_unlocked(store)
            return _public_webhook(merged)
    return None


def set_webhook_enabled(instance_name: str, webhook_id: str, enabled: bool) -> dict[str, Any] | None:
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            return None
        for idx, item in enumerate(hooks):
            if not isinstance(item, dict) or str(item.get("id")) != webhook_id:
                continue
            current = _hydrate_webhook(instance_name, item)
            merged = _sanitize_webhook(instance_name, {**current, "enabled": enabled, "updatedAt": _now_iso()})
            hooks[idx] = _webhook_for_storage(instance_name, merged)
            store["instances"][instance_name] = hooks
            _write_store_unlocked(store)
            return _public_webhook(merged)
    return None


def delete_webhook(instance_name: str, webhook_id: str) -> bool:
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            return False
        next_hooks = [item for item in hooks if isinstance(item, dict) and str(item.get("id")) != webhook_id]
        if len(next_hooks) == len(hooks):
            return False
        store["instances"][instance_name] = next_hooks
        _write_store_unlocked(store)
    return True


def delete_all_instance_webhooks(instance_name: str) -> None:
    with _LOCK:
        store = _read_store_unlocked()
        if instance_name in store["instances"]:
            del store["instances"][instance_name]
            _write_store_unlocked(store)


def list_enabled_webhooks_for_dispatch(instance_name: str) -> list[dict[str, Any]]:
    hooks = list_instance_webhooks(instance_name, reveal_secrets=True)
    return [item for item in hooks if item.get("enabled") and str(item.get("url") or "").startswith(("http://", "https://"))]


def build_auth_headers(item: dict[str, Any]) -> dict[str, str]:
    auth_type = str(item.get("authType") or "NONE").upper()
    auth = item.get("authConfig") if isinstance(item.get("authConfig"), dict) else {}
    headers: dict[str, str] = {}

    if auth_type == "BEARER":
        token = str(auth.get("token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif auth_type == "API_KEY":
        header_name = str(auth.get("headerName") or "x-api-key").strip()
        api_key = str(auth.get("apiKey") or "").strip()
        if header_name and api_key:
            headers[header_name] = api_key
    elif auth_type == "BASIC":
        username = str(auth.get("username") or "")
        password = str(auth.get("password") or "")
        if username or password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"

    custom_headers = item.get("customHeaders") if isinstance(item.get("customHeaders"), dict) else {}
    for key, value in custom_headers.items():
        k = str(key or "").strip()
        if not k:
            continue
        if k.lower() == "content-type":
            continue
        headers[k] = str(value or "").strip()

    return headers


def build_auth_query_params(item: dict[str, Any]) -> dict[str, str]:
    auth_type = str(item.get("authType") or "NONE").upper()
    auth = item.get("authConfig") if isinstance(item.get("authConfig"), dict) else {}
    if auth_type != "QUERY_PARAM":
        return {}
    name = str(auth.get("queryParamName") or "").strip()
    value = str(auth.get("queryParamValue") or "").strip()
    return {name: value} if name and value else {}


def mark_dispatch_result(instance_name: str, webhook_id: str, status: str, error: str | None = None) -> None:
    mark_dispatch_result_ex(
        instance_name,
        webhook_id,
        status=status,
        error=error,
    )


def mark_dispatch_result_ex(
    instance_name: str,
    webhook_id: str,
    *,
    status: str,
    error: str | None = None,
    status_code: int | None = None,
    latency_ms: float | None = None,
    retries_used: int = 0,
    retryable: bool | None = None,
) -> None:
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            return
        for idx, item in enumerate(hooks):
            if not isinstance(item, dict) or str(item.get("id")) != webhook_id:
                continue
            current = _hydrate_webhook(instance_name, item)
            merged = _sanitize_webhook(
                instance_name,
                _apply_dispatch_aggregate_fields(
                    current,
                    status=status,
                    error=error,
                    status_code=status_code,
                    latency_ms=latency_ms,
                    retries_used=retries_used,
                    retryable=retryable,
                ),
            )
            hooks[idx] = _webhook_for_storage(instance_name, merged)
            store["instances"][instance_name] = hooks
            _write_store_unlocked(store)
            return


def append_dispatch_history(
    instance_name: str,
    webhook_id: str,
    entry: dict[str, Any],
) -> dict[str, Any] | None:
    """Persist delivery evidence separately while retaining config aggregates.

    ``dispatchHistory`` in existing configuration records is intentionally left
    untouched so historic installations remain readable. New deliveries never
    enlarge the configuration store.
    """
    delivery = append_webhook_delivery({**entry, "instanceName": instance_name, "webhookId": webhook_id})
    with _LOCK:
        store = _read_store_unlocked()
        hooks = store["instances"].get(instance_name)
        if not isinstance(hooks, list):
            return delivery
        for idx, item in enumerate(hooks):
            if not isinstance(item, dict) or str(item.get("id")) != webhook_id:
                continue
            current = _hydrate_webhook(instance_name, item)
            merged = _sanitize_webhook(
                instance_name,
                _apply_dispatch_aggregate_fields(
                    {
                        **current,
                        "updatedAt": _now_iso(),
                    },
                    status=str(entry.get("status") or "failed"),
                    error=str(entry.get("error") or "") or None,
                    status_code=entry.get("statusCode") if isinstance(entry.get("statusCode"), int) else entry.get("responseCode"),
                    latency_ms=_coerce_float(entry.get("durationMs"), None),
                    retries_used=_coerce_int(entry.get("retryCount")),
                    retryable=entry.get("retryable") if isinstance(entry.get("retryable"), bool) else None,
                ),
            )
            hooks[idx] = _webhook_for_storage(instance_name, merged)
            store["instances"][instance_name] = hooks
            _write_store_unlocked(store)
            return delivery
    return delivery


def mask_headers_for_log(headers: dict[str, str]) -> dict[str, str]:
    return SecretRedactor.redact_headers(headers)


def list_webhook_dispatches(instance_name: str, webhook_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    item = get_webhook(instance_name, webhook_id, reveal_secrets=False)
    if not item:
        return []
    history = item.get("dispatchHistory") if isinstance(item.get("dispatchHistory"), list) else []
    legacy = [_legacy_delivery(item, row) for row in history if isinstance(row, dict)]
    current = list_webhook_deliveries(webhook_id, limit=500)
    return _merge_deliveries(current, legacy, limit=limit)


def list_webhook_delivery_page(
    instance_name: str,
    webhook_id: str,
    *,
    limit: int = 50,
    offset: int = 0,
    status: str | None = None,
    operation: str | None = None,
    event_type: str | None = None,
    is_test: bool | None = None,
    delivery_id: str | None = None,
    event_id: str | None = None,
    request_id: str | None = None,
    correlation_id: str | None = None,
    search: str | None = None,
    date_from: int | None = None,
    date_to: int | None = None,
) -> dict[str, Any]:
    """Safe, pageable delivery summaries; legacy history remains readable."""
    records = list_webhook_dispatches(instance_name, webhook_id, limit=500)
    filtered = filter_deliveries(
        records, status=status, operation=operation, event_type=event_type, is_test=is_test,
        delivery_id=delivery_id, event_id=event_id, request_id=request_id, correlation_id=correlation_id,
        search=search, date_from=date_from, date_to=date_to,
    )
    safe_limit = max(1, min(limit, 200))
    safe_offset = max(0, offset)
    return {"items": [delivery_list_item(item) for item in filtered[safe_offset:safe_offset + safe_limit]], "total": len(filtered), "limit": safe_limit, "offset": safe_offset}


def list_recent_dispatches(instance_name: str, *, limit: int = 50, success: bool | None = None) -> list[dict[str, Any]]:
    hooks = list_instance_webhooks(instance_name, reveal_secrets=False)
    items = list_instance_deliveries(instance_name, limit=500, success=success)
    legacy: list[dict[str, Any]] = []
    for hook in hooks:
        history = hook.get("dispatchHistory") if isinstance(hook.get("dispatchHistory"), list) else []
        for row in history:
            if not isinstance(row, dict):
                continue
            row_success = bool(row.get("success"))
            if success is not None and row_success != success:
                continue
            legacy.append(_legacy_delivery(hook, row))
    return _merge_deliveries(items, legacy, limit=limit)


def get_webhook_delivery(instance_name: str, webhook_id: str, delivery_id: str) -> dict[str, Any] | None:
    item = get_webhook(instance_name, webhook_id, reveal_secrets=False)
    if not item:
        return None
    stored = get_stored_webhook_delivery(webhook_id, delivery_id)
    if stored:
        return delivery_detail(stored)
    history = item.get("dispatchHistory") if isinstance(item.get("dispatchHistory"), list) else []
    for row in history:
        if isinstance(row, dict):
            legacy = _legacy_delivery(item, row)
            if legacy["id"] == delivery_id:
                return delivery_detail(legacy)
    return None


def find_webhook_by_id(webhook_id: str, *, reveal_secrets: bool = False) -> tuple[str, dict[str, Any]] | None:
    """Resolve stable webhook identity without relying on a client-supplied instance."""
    with _LOCK:
        store = _read_store_unlocked()
        candidates = [(str(instance), item) for instance, hooks in store["instances"].items() if isinstance(hooks, list) for item in hooks if isinstance(item, dict) and str(item.get("id") or "") == webhook_id]
    if not candidates:
        return None
    instance_name, raw = candidates[0]
    return instance_name, _public_webhook(_hydrate_webhook(instance_name, raw), reveal_secrets=reveal_secrets)


def _legacy_delivery(hook: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    webhook_id = str(row.get("webhookId") or hook.get("id") or "")
    correlation = str(row.get("dispatchId") or "")
    identifier = correlation or f"legacy_{webhook_id}_{_coerce_int(row.get('timestamp'))}"
    return {
        **_sanitize_dispatch_history_entry(row),
        "id": identifier,
        "correlationId": correlation or None,
        "isTest": bool(row.get("isTest") or row.get("testMode")),
        "webhookId": webhook_id,
        "webhookName": row.get("webhookName") or hook.get("name"),
        "instanceName": row.get("instanceName") or hook.get("instanceId"),
        "destinationUrl": row.get("destinationUrl") or hook.get("url"),
        "metadata": {"legacy": True},
    }


def _merge_deliveries(current: list[dict[str, Any]], legacy: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    for item in [*current, *legacy]:
        identifier = str(item.get("id") or item.get("dispatchId") or "")
        if not identifier or identifier in seen:
            continue
        seen.add(identifier)
        merged.append(item)
    merged.sort(key=lambda value: _coerce_int(value.get("timestamp")), reverse=True)
    return merged[:max(1, min(limit, 500))]


def get_dispatch_metrics(instance_name: str) -> dict[str, Any]:
    hooks = list_instance_webhooks(instance_name, reveal_secrets=False)
    total_deliveries = 0
    successful_deliveries = 0
    failed_deliveries = 0
    retries = 0
    weighted_latency = 0.0
    for hook in hooks:
        success_count = max(0, _coerce_int(hook.get("successCount")))
        failure_count = max(0, _coerce_int(hook.get("failureCount")))
        count = success_count + failure_count
        total_deliveries += count
        successful_deliveries += success_count
        failed_deliveries += failure_count
        retries += max(0, _coerce_int(hook.get("retryCount")))
        weighted_latency += _coerce_float(hook.get("avgLatencyMs")) * count
    average_response_time = round(weighted_latency / total_deliveries, 2) if total_deliveries > 0 else 0.0
    return {
        "instanceName": instance_name,
        "totalDeliveries": total_deliveries,
        "successfulDeliveries": successful_deliveries,
        "failedDeliveries": failed_deliveries,
        "retries": retries,
        "averageResponseTimeMs": average_response_time,
    }
