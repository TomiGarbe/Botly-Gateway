"""Append-only records and guards for operator-triggered delivery actions.

The store deliberately contains action metadata only.  Delivery evidence and
webhook configuration remain owned by their existing stores, so an action can
link them without copying payloads or credentials.
"""
from __future__ import annotations

import copy
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from app.core.config import get_settings
from app.core.secret_protection import SecretRedactor


ManualActionType = Literal[
    "repeat_test", "redeliver_current_target", "resend_provider_outbound", "reprocess_inbound",
]
ManualActionRisk = Literal["safe", "warning", "ambiguous", "blocked"]
ManualActionStatus = Literal["pending", "running", "completed", "failed", "blocked"]

ACTION_TYPES = frozenset({"repeat_test", "redeliver_current_target", "resend_provider_outbound", "reprocess_inbound"})
ENABLED_ACTION_TYPES = frozenset({"repeat_test", "redeliver_current_target", "resend_provider_outbound"})
ACTION_RISKS: dict[str, ManualActionRisk] = {
    "repeat_test": "safe",
    "redeliver_current_target": "warning",
    "resend_provider_outbound": "warning",
    "reprocess_inbound": "blocked",
}
_LOCK = threading.Lock()


class ManualActionConflictError(ValueError):
    """An idempotency key was previously used for another operation."""


def _path() -> Path:
    settings = get_settings()
    configured = str(getattr(settings, "manual_delivery_actions_path", "") or "").strip()
    if configured:
        return Path(configured).resolve()
    deliveries_path = str(getattr(settings, "webhook_deliveries_path", "") or "").strip()
    if deliveries_path:
        return Path(deliveries_path).resolve().with_name("manual_delivery_actions.json")
    webhooks_path = Path(str(getattr(settings, "instance_webhooks_path", "/tmp/botly_instance_webhooks.json")))
    return webhooks_path.resolve().with_name("manual_delivery_actions.json")


def _retention() -> int:
    return max(100, min(int(getattr(get_settings(), "manual_delivery_action_retention", 2_000) or 2_000), 10_000))


def _rate_limit() -> tuple[int, int]:
    settings = get_settings()
    return (
        max(1, min(int(getattr(settings, "manual_delivery_action_rate_limit", 10) or 10), 100)),
        max(1, min(int(getattr(settings, "manual_delivery_action_rate_window_seconds", 60) or 60), 3_600)),
    )


def _empty() -> dict[str, Any]:
    return {"version": 1, "actions": []}


def _ensure_private(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass


def _read_unlocked() -> dict[str, Any]:
    path = _path()
    _ensure_private(path)
    if not path.exists():
        return _empty()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return _empty()
    return value if isinstance(value, dict) and isinstance(value.get("actions"), list) else _empty()


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


def _timestamp() -> int:
    return int(time.time() * 1000)


def _safe_text(value: Any, limit: int = 500) -> str | None:
    text = SecretRedactor.redact_json_preview(str(value or ""), max_chars=limit).strip()
    return text or None


def _public(action: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "id", "action", "sourceDeliveryId", "targetId", "connectionId", "actorId", "reason",
        "createdAt", "startedAt", "finishedAt", "status", "risk", "result", "newDeliveryId",
        "newAttemptId",
        "configurationSource",
        "sourceAttemptId", "provider", "reconciliationResult", "confirmation", "observableDestinationDrift",
    }
    return {key: copy.deepcopy(value) for key, value in action.items() if key in allowed}


def create_or_get_action(
    *, action: ManualActionType, source_delivery_id: str, target_id: str, connection_id: str,
    actor_id: str, idempotency_key: str, reason: str | None = None,
    extra: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], bool]:
    """Atomically create an append-only action or return its idempotent twin."""
    if action not in ACTION_TYPES:
        raise ValueError("Unsupported manual delivery action")
    if action not in ENABLED_ACTION_TYPES:
        raise PermissionError("This manual delivery action is not enabled")
    now = _timestamp()
    safe_reason = _safe_text(reason)
    with _LOCK:
        store = _read_unlocked()
        actions = [item for item in store["actions"] if isinstance(item, dict)]
        for existing in actions:
            if str(existing.get("idempotencyKey") or "") != idempotency_key:
                continue
            same_operation = (
                existing.get("action") == action
                and existing.get("sourceDeliveryId") == source_delivery_id
                and existing.get("targetId") == target_id
                and existing.get("connectionId") == connection_id
                and existing.get("reason") == safe_reason
            )
            if not same_operation:
                raise ManualActionConflictError("Idempotency-Key already belongs to a different manual action")
            return _public(existing), False

        # A resend is not a normal retry mechanism.  Once one has started or
        # completed for an attempt, a different key must not turn it into a
        # second provider side effect.  Blocked/failed actions remain useful
        # evidence, but do not permanently suppress a later manual review.
        if action == "resend_provider_outbound":
            prior_resend = next((
                item for item in actions
                if item.get("action") == action
                and item.get("targetId") == target_id
                and item.get("connectionId") == connection_id
                and item.get("status") in {"pending", "running", "completed"}
            ), None)
            if prior_resend is not None:
                raise ManualActionConflictError("A resend already exists for this outbound attempt")

        limit, window_seconds = _rate_limit()
        earliest = now - window_seconds * 1000
        recent = sum(
            1 for item in actions
            if item.get("actorId") == actor_id and item.get("targetId") == target_id and item.get("action") == action
            and int(item.get("createdAt") or 0) >= earliest
        )
        if recent >= limit:
            raise RuntimeError("Manual delivery action rate limit exceeded")

        record = {
            "id": f"manual_action_{uuid.uuid4().hex}", "action": action,
            "sourceDeliveryId": source_delivery_id, "targetId": target_id, "connectionId": connection_id,
            "actorId": actor_id, "reason": safe_reason, "createdAt": now, "startedAt": None,
            "finishedAt": None, "status": "pending", "risk": ACTION_RISKS[action], "result": None,
            "newDeliveryId": None, "configurationSource": "current", "idempotencyKey": idempotency_key,
        }
        record.update(SecretRedactor.redact_json(copy.deepcopy(extra or {})))
        actions.append(record)
        store["actions"] = sorted(actions, key=lambda item: int(item.get("createdAt") or 0), reverse=True)[:_retention()]
        _write_unlocked(store)
        return _public(record), True


def update_action(
    action_id: str, *, status: ManualActionStatus, result: dict[str, Any] | None = None,
    new_delivery_id: str | None = None, new_attempt_id: str | None = None,
    reconciliation_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if status not in {"pending", "running", "completed", "failed", "blocked"}:
        raise ValueError("Invalid manual action status")
    with _LOCK:
        store = _read_unlocked()
        for item in store["actions"]:
            if not isinstance(item, dict) or item.get("id") != action_id:
                continue
            now = _timestamp()
            if status == "running" and item.get("startedAt") is None:
                item["startedAt"] = now
            if status in {"completed", "failed", "blocked"}:
                item["finishedAt"] = now
            item["status"] = status
            if result is not None:
                item["result"] = SecretRedactor.redact_json(copy.deepcopy(result))
            if new_delivery_id:
                item["newDeliveryId"] = new_delivery_id
            if new_attempt_id:
                item["newAttemptId"] = new_attempt_id
            if reconciliation_result is not None:
                item["reconciliationResult"] = SecretRedactor.redact_json(copy.deepcopy(reconciliation_result))
            _write_unlocked(store)
            return _public(item)
    return None


def get_action(action_id: str) -> dict[str, Any] | None:
    with _LOCK:
        for item in _read_unlocked()["actions"]:
            if isinstance(item, dict) and item.get("id") == action_id:
                return _public(item)
    return None


def list_action_summaries() -> list[dict[str, Any]]:
    """One bounded, secret-free read for analytics and operational counts."""
    fields = ("id", "action", "connectionId", "provider", "createdAt", "status", "risk")
    with _LOCK:
        return [
            {field: copy.deepcopy(item.get(field)) for field in fields}
            for item in _read_unlocked()["actions"] if isinstance(item, dict)
        ]
