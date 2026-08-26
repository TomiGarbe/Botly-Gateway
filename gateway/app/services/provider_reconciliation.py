"""Read-only, provider-specific reconciliation for uncertain outbound attempts."""
from __future__ import annotations

import asyncio
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Protocol

from app.adapters.evolution.adapter import EvolutionAdapter, get_evolution_adapter
from app.adapters.evolution.errors import EvolutionError
from app.core.secret_protection import SecretRedactor
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore, get_outbound_provider_attempt_store


_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT_ATTEMPTS: set[str] = set()
_OBSERVED_STATES = frozenset({"accepted", "sent", "delivered", "read", "played", "failed"})
_INLINE_SECRET = re.compile(r"(?i)((?:authorization|access[_-]?token|api[_-]?key|cookie|secret|credential)\s*[:=]\s*(?:bearer\s+)?)([^\s,;]+)")


def _now() -> int:
    return int(time.time() * 1000)


def _safe(value: Any, limit: int = 500) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    redacted = SecretRedactor.redact_json_preview(text, max_chars=limit)
    return _INLINE_SECRET.sub(r"\1[REDACTED]", redacted)[:limit]


@dataclass(frozen=True)
class ProviderLookupResult:
    status: str
    observed_state: str | None = None
    confidence: str = "inconclusive"
    reason: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ReconciliationResult:
    reconciliationId: str
    attemptId: str
    provider: str
    startedAt: int
    completedAt: int
    status: str
    providerMessageId: str | None
    observedState: str | None
    confidence: str
    reason: str | None
    error: str | None

    def public_dict(self) -> dict[str, Any]:
        return SecretRedactor.redact_json(asdict(self))


class ReconciliationConflictError(RuntimeError):
    pass


class ReconciliationNotEligibleError(RuntimeError):
    pass


class ReconciliationOwnershipError(RuntimeError):
    pass


class ProviderReconciler(Protocol):
    async def lookup(self, attempt: dict[str, Any]) -> ProviderLookupResult: ...


class MetaProviderReconciler:
    """Meta Cloud exposes delivery status through webhooks, not a wamid GET API.

    The current Botly Graph capability is the documented send endpoint and the
    status webhook already processed locally.  Issuing an invented Graph GET by
    wamid would create false confidence, so this reconciler reports the explicit
    limitation instead of guessing or sending a message.
    """

    async def lookup(self, attempt: dict[str, Any]) -> ProviderLookupResult:
        if not str(attempt.get("providerMessageId") or "").strip():
            return ProviderLookupResult("inconclusive", reason="missing_provider_message_id")
        return ProviderLookupResult("inconclusive", reason="meta_cloud_has_no_supported_message_status_lookup")


class EvolutionProviderReconciler:
    def __init__(self, adapter: EvolutionAdapter | None = None) -> None:
        self._adapter = adapter or get_evolution_adapter()

    async def lookup(self, attempt: dict[str, Any]) -> ProviderLookupResult:
        message_id = str(attempt.get("providerMessageId") or "").strip()
        if not message_id:
            return ProviderLookupResult("inconclusive", reason="missing_provider_message_id")
        try:
            payload = await self._adapter.find_message_by_id(str(attempt.get("instance") or ""), message_id)
        except EvolutionError as exc:
            status = int(exc.status_code or 0)
            reason = "provider_unavailable"
            if status in {401, 403}:
                reason = "provider_auth_or_permission_error"
            elif status == 504 or "timeout" in str(exc).lower():
                reason = "provider_timeout"
            elif status == 502 or "transport" in str(exc).lower():
                reason = "provider_network_error"
            return ProviderLookupResult("unavailable", reason=reason, error=_safe(str(exc)))
        except Exception as exc:
            return ProviderLookupResult("unavailable", reason="provider_lookup_error", error=_safe(str(exc)))

        matches = [item for item in _message_records(payload) if _message_id(item) == message_id]
        if not matches:
            return ProviderLookupResult("not_found", reason="provider_message_not_found")
        if len(matches) != 1:
            return ProviderLookupResult("inconclusive", reason="ambiguous_provider_message_lookup")
        observed = _observed_state(matches[0])
        if observed is None:
            return ProviderLookupResult("found", confidence="confirmed", reason="found_by_provider_id")
        return ProviderLookupResult("found", observed_state=observed, confidence="confirmed", reason="found_by_provider_id")


def _message_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    candidates: list[Any] = [payload.get("records"), payload.get("messages")]
    for parent in (payload.get("data"), payload.get("response"), payload.get("messages")):
        if isinstance(parent, dict):
            candidates.extend([parent.get("records"), parent.get("messages"), parent.get("data")])
    for candidate in candidates:
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
    return []


def _message_id(message: dict[str, Any]) -> str:
    key = message.get("key") if isinstance(message.get("key"), dict) else {}
    nested = message.get("message") if isinstance(message.get("message"), dict) else {}
    nested_key = nested.get("key") if isinstance(nested.get("key"), dict) else {}
    return str(key.get("id") or nested_key.get("id") or message.get("id") or "").strip()


def _observed_state(message: dict[str, Any]) -> str | None:
    candidates = [message.get("status")]
    nested = message.get("message") if isinstance(message.get("message"), dict) else {}
    candidates.extend([nested.get("status"), (message.get("key") or {}).get("status") if isinstance(message.get("key"), dict) else None])
    aliases = {"pending": "sent", "server_ack": "sent", "delivery_ack": "delivered", "read_ack": "read", "playedback": "played"}
    for value in candidates:
        state = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
        state = aliases.get(state, state)
        if state in _OBSERVED_STATES:
            return state
    # A unique record keyed by the original message ID confirms acceptance by
    # Evolution's message store even when it does not expose a lifecycle value.
    return "accepted"


class ProviderReconciliationService:
    def __init__(
        self, *, store: OutboundProviderAttemptStore | None = None,
        reconcilers: dict[str, ProviderReconciler] | None = None,
    ) -> None:
        self._store = store or get_outbound_provider_attempt_store()
        self._reconcilers = reconcilers or {"meta": MetaProviderReconciler(), "evolution": EvolutionProviderReconciler()}

    async def reconcile(
        self, *, attempt_id: str, instance: str | None = None, connection_id: str | None = None,
    ) -> ReconciliationResult:
        attempt = self._store.get(attempt_id)
        if attempt is None:
            raise KeyError(attempt_id)
        if instance is not None and str(attempt.get("instance") or "") != str(instance):
            raise ReconciliationOwnershipError("Attempt does not belong to the selected connection")
        persisted_connection_id = str(attempt.get("connectionId") or "").strip()
        if connection_id is not None and persisted_connection_id and persisted_connection_id != str(connection_id):
            raise ReconciliationOwnershipError("Attempt does not belong to the selected connection")
        if attempt.get("reconciliationState") != "pending" or attempt.get("deliveryState") != "unknown":
            raise ReconciliationNotEligibleError("Attempt is not pending reconciliation")

        with _INFLIGHT_LOCK:
            if attempt_id in _INFLIGHT_ATTEMPTS:
                raise ReconciliationConflictError("Reconciliation is already in progress")
            _INFLIGHT_ATTEMPTS.add(attempt_id)
        started_at = _now()
        try:
            provider = str(attempt.get("provider") or "").strip().lower()
            reconciler = self._reconcilers.get(provider)
            lookup = await reconciler.lookup(attempt) if reconciler else ProviderLookupResult("inconclusive", reason="unsupported_provider")
            completed_at = _now()
            result = ReconciliationResult(
                reconciliationId=f"reconciliation_{uuid.uuid4().hex}", attemptId=str(attempt["id"]), provider=provider,
                startedAt=started_at, completedAt=completed_at, status=lookup.status,
                providerMessageId=str(attempt.get("providerMessageId") or "").strip() or None,
                observedState=lookup.observed_state, confidence=lookup.confidence,
                reason=_safe(lookup.reason, 160), error=_safe(lookup.error),
            )
            resolved = lookup.status == "found" and lookup.confidence == "confirmed" and lookup.observed_state in _OBSERVED_STATES
            self._store.record_reconciliation(
                attempt_id=attempt_id, evidence=result.public_dict(), delivery_state=lookup.observed_state if resolved else None,
                resolved=resolved,
            )
            return result
        finally:
            with _INFLIGHT_LOCK:
                _INFLIGHT_ATTEMPTS.discard(attempt_id)


_service = ProviderReconciliationService()


def get_provider_reconciliation_service() -> ProviderReconciliationService:
    return _service
