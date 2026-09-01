"""Deterministic Evolution inbound-webhook configuration and verification."""
from __future__ import annotations

from typing import Any

from app.adapters.evolution.errors import EvolutionError
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

EVOLUTION_WEBHOOK_EVENTS = [
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "CONNECTION_UPDATE",
    "QRCODE_UPDATED",
    "SEND_MESSAGE",
]
_SECRET_HEADER = "x-evolution-webhook-secret"


def evolution_webhook_url() -> str:
    settings = get_settings()
    return f"http://gateway:{settings.gateway_port}/webhooks/evolution"


def evolution_webhook_headers() -> dict[str, str]:
    secret = str(getattr(get_settings(), "evolution_webhook_secret", "") or "").strip()
    return {_SECRET_HEADER: secret} if secret else {}


def _configuration_node(response: Any) -> dict[str, Any]:
    """Accept Evolution's known flat and wrapped read representations."""
    if not isinstance(response, dict):
        return {}
    candidates = (response, response.get("webhook"), response.get("data"))
    for candidate in candidates:
        if isinstance(candidate, dict) and any(key in candidate for key in ("enabled", "url", "events", "webhookUrl")):
            return candidate
    return {}


def _normalized_events(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item).strip().upper() for item in value if str(item).strip()}


def validate_evolution_webhook_configuration(response: Any, *, url: str, headers: dict[str, str]) -> None:
    node = _configuration_node(response)
    enabled = node.get("enabled") is True
    current_url = str(node.get("url") or node.get("webhookUrl") or "").rstrip("/")
    expected_url = url.rstrip("/")
    events = _normalized_events(node.get("events") or node.get("webhookEvents"))
    mismatch: list[str] = []
    if not enabled:
        mismatch.append("enabled")
    if current_url != expected_url:
        mismatch.append("url")
    if "MESSAGES_UPSERT" not in events:
        mismatch.append("MESSAGES_UPSERT")
    expected_secret = headers.get(_SECRET_HEADER)
    current_headers = node.get("headers") if isinstance(node.get("headers"), dict) else {}
    if expected_secret and str(current_headers.get(_SECRET_HEADER) or "") != expected_secret:
        mismatch.append(_SECRET_HEADER)
    if mismatch:
        raise EvolutionError(
            message=f"Evolution webhook configuration mismatch: {', '.join(mismatch)}",
            status_code=502,
            detail={"mismatch": mismatch, "url": current_url, "events": sorted(events)},
            retryable=False,
        )


async def ensure_evolution_webhook(
    connection_manager: Any,
    instance_name: str,
    *,
    force_configure: bool = False,
) -> dict[str, Any]:
    """Ensure Evolution has the exact inbound callback required by Gateway.

    A read happens first on recovery/reconnect.  Initial provisioning forces a
    write, then every path verifies the remote effective configuration.
    """
    url = evolution_webhook_url()
    headers = evolution_webhook_headers()
    configured: dict[str, Any] | None = None
    if not force_configure:
        try:
            configured = await connection_manager.get_webhook(instance_name, connection_type="baileys")
            validate_evolution_webhook_configuration(configured, url=url, headers=headers)
            logger.info("evolution_webhook_verified", instance=instance_name, url=url, events=EVOLUTION_WEBHOOK_EVENTS)
            return configured
        except EvolutionError as exc:
            logger.warning("evolution_webhook_requires_repair", instance=instance_name, error=str(exc))
        except Exception as exc:
            logger.warning("evolution_webhook_lookup_failed", instance=instance_name, error=str(exc))

    logger.info("evolution_webhook_configuration_started", instance=instance_name, url=url, events=EVOLUTION_WEBHOOK_EVENTS)
    await connection_manager.set_webhook(
        instance_name,
        url,
        EVOLUTION_WEBHOOK_EVENTS,
        headers=headers,
        connection_type="baileys",
    )
    configured = await connection_manager.get_webhook(instance_name, connection_type="baileys")
    validate_evolution_webhook_configuration(configured, url=url, headers=headers)
    logger.info("evolution_webhook_verified", instance=instance_name, url=url, events=EVOLUTION_WEBHOOK_EVENTS)
    return configured
