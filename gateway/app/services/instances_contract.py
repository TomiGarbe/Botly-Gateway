from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.services.connection_health import ConnectionHealthService

logger = get_logger(__name__)
_health_service = ConnectionHealthService()

VALID_INSTANCE_STATES = {"open", "connecting", "close"}
INTEGRATION_TO_CONNECTION_TYPE = {
    "WHATSAPP-BUSINESS": "cloud",
    "WHATSAPP-BAILEYS": "baileys",
}


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

    raw_state = raw.get("connectionStatus") or raw.get("instance", {}).get("state") or raw.get("status")
    provider_state = str(raw_state or "").strip().lower()
    status = normalize_instance_status(raw_state)
    integration = str(
        raw.get("integration")
        or raw.get("instance", {}).get("integration")
        or raw.get("config", {}).get("integration")
        or ""
    ).strip()
    raw_connection_type = str(raw.get("connectionType") or raw.get("connection_type") or "").strip().lower()
    connection_type = raw_connection_type or INTEGRATION_TO_CONNECTION_TYPE.get(integration, "baileys")
    coexistence = raw.get("coexistence") if isinstance(raw.get("coexistence"), dict) else None
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
        "phone": raw.get("ownerJid") or raw.get("phone") or raw.get("number") or raw.get("instance", {}).get("ownerJid"),
        "avatarUrl": raw.get("profilePicUrl") or raw.get("avatarUrl"),
        "lastSeen": raw.get("lastSeen"),
        "createdAt": raw.get("createdAt"),
        "integration": integration or None,
        "connectionType": connection_type,
        "coexistence": coexistence,
    }
    health = _health_service.evaluate(
        raw,
        name=name,
        status=status,
        connection_type=connection_type,
        integration=integration or None,
        provider_state=provider_state,
    ).public_dict()
    normalized["lifecycleState"] = health["lifecycleState"]
    normalized["health"] = health["health"]
    normalized["healthChecks"] = health["checks"]
    normalized["diagnostics"] = health["diagnostics"]
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
