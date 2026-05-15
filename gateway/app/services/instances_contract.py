from __future__ import annotations

from typing import Any

from app.core.logging import get_logger

logger = get_logger(__name__)

VALID_INSTANCE_STATES = {"open", "connecting", "close"}


def normalize_instance_status(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if value in VALID_INSTANCE_STATES:
        return value
    return "close"


def normalize_instance(raw: dict[str, Any]) -> dict[str, Any] | None:
    name = str(raw.get("instanceName") or raw.get("name") or raw.get("instance", {}).get("instanceName") or "").strip()
    if not name:
        logger.warning("instance_contract_invalid_missing_name", raw=raw)
        return None

    status = normalize_instance_status(
        raw.get("connectionStatus")
        or raw.get("instance", {}).get("state")
        or raw.get("status")
    )
    instance_id = str(
        raw.get("instanceId")
        or raw.get("id")
        or raw.get("instance", {}).get("instanceId")
        or name
    ).strip()
    if not instance_id:
        instance_id = name

    normalized = {
        "id": instance_id,
        "name": name,
        "status": status,
        "profileName": raw.get("profileName") or raw.get("profile") or raw.get("instance", {}).get("profileName"),
        "phone": raw.get("ownerJid") or raw.get("phone") or raw.get("instance", {}).get("ownerJid"),
        "avatarUrl": raw.get("profilePicUrl") or raw.get("avatarUrl"),
        "lastSeen": raw.get("lastSeen"),
        "createdAt": raw.get("createdAt"),
    }
    return {key: value for key, value in normalized.items() if value is not None}


def normalize_instance_list(raw_items: Any) -> list[dict[str, Any]]:
    items = raw_items if isinstance(raw_items, list) else []
    normalized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            logger.warning("instance_contract_invalid_type", value_type=type(item).__name__)
            continue
        mapped = normalize_instance(item)
        if mapped:
            normalized.append(mapped)
    return normalized
