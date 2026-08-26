"""Local-only correlation of provider status webhooks to outbound attempts.

This module intentionally performs no provider calls, retry, resend or
reconciliation.  It only attaches evidence when the provider message ID gives
an exact match inside the same runtime instance and provider.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.services.outbound_provider_attempts import OutboundProviderAttemptStore, get_outbound_provider_attempt_store


_OBSERVABLE_DELIVERY_STATES = frozenset({"sent", "delivered", "read", "played", "failed"})


@dataclass(frozen=True)
class ProviderStatusCorrelation:
    outcome: str
    attempt_id: str | None = None
    delivery_state: str | None = None
    reason: str | None = None

    def public_dict(self) -> dict[str, str | None]:
        return asdict(self)


class ProviderStatusCorrelationService:
    """Correlates only exact provider identifiers in one authorized context."""

    def __init__(self, store: OutboundProviderAttemptStore | None = None) -> None:
        self._store = store or get_outbound_provider_attempt_store()

    def correlate(self, event: dict[str, Any]) -> ProviderStatusCorrelation:
        delivery = event.get("providerDelivery") if isinstance(event.get("providerDelivery"), dict) else {}
        if str(event.get("direction") or "").lower() != "status":
            return ProviderStatusCorrelation("invalid", reason="not_a_status_event")
        instance = str(event.get("instance") or "").strip()
        provider = str(delivery.get("provider") or "").strip().lower()
        provider_message_id = str(delivery.get("providerMessageId") or "").strip()
        status = str(event.get("status") or "").strip().lower()
        if not instance or not provider or not provider_message_id or status not in _OBSERVABLE_DELIVERY_STATES:
            return ProviderStatusCorrelation("invalid", reason="missing_or_unsupported_identifier")

        candidates = self._store.provider_message_candidates(
            instance=instance, provider=provider, provider_message_id=provider_message_id,
        )
        if not candidates:
            return ProviderStatusCorrelation("not_found", delivery_state=status)
        if len(candidates) != 1:
            return ProviderStatusCorrelation("ambiguous", delivery_state=status)

        attempt = self._store.record_provider_status(
            attempt_id=str(candidates[0]["id"]), status=status, provider=provider,
            provider_message_id=provider_message_id, event_id=str(event.get("id") or "") or None,
            timestamp=event.get("sourceTimestamp") if isinstance(event.get("sourceTimestamp"), int) else event.get("timestamp"),
        )
        return ProviderStatusCorrelation(
            "matched", attempt_id=str(attempt["id"]), delivery_state=str(attempt.get("deliveryState") or status),
        )


def correlate_provider_status(event: dict[str, Any]) -> ProviderStatusCorrelation:
    """Convenience entry point used after the Timeline status event is shaped."""
    return ProviderStatusCorrelationService().correlate(event)
