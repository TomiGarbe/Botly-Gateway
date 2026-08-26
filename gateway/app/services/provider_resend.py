"""Conservative Evolution-only manual resend of confirmed failed text sends."""
from __future__ import annotations

import threading
from dataclasses import asdict, dataclass
from typing import Any

from app.adapters.evolution.adapter import EvolutionAdapter, get_evolution_adapter
from app.services.manual_delivery_actions import ManualActionConflictError, create_or_get_action, update_action
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore, execute_outbound_attempt, get_outbound_provider_attempt_store
from app.services.provider_reconciliation import EvolutionProviderReconciler, ProviderLookupResult


_LOCK = threading.Lock()
_INFLIGHT: set[str] = set()


class ResendBlockedError(RuntimeError): pass
class ResendConflictError(RuntimeError): pass


@dataclass(frozen=True)
class ResendDecision:
    outcome: str
    reason: str
    reconstructable: bool = False
    request: dict[str, str] | None = None


def reconstruct_outbound_request(attempt: dict[str, Any]) -> ResendDecision:
    """Only exact, fully retained Evolution text requests are reconstructable."""
    payload = attempt.get("requestPayload") if isinstance(attempt.get("requestPayload"), dict) else {}
    message_type = str(attempt.get("messageType") or payload.get("messageType") or "").strip().lower()
    text = str(payload.get("text") or "")
    recipient = str(payload.get("recipient") or attempt.get("recipient") or "").strip()
    operation = str(payload.get("providerOperation") or "").strip()
    rendered = str(payload)
    if message_type != "text": return ResendDecision("BLOCKED", "message_type_not_fully_reconstructable")
    if payload.get("media") is not None or attempt.get("mediaReference") is not None: return ResendDecision("BLOCKED", "media_not_reconstructable")
    if not text or not recipient or operation != "messages.sendText": return ResendDecision("BLOCKED", "missing_required_text_request_data")
    if "[REDACTED]" in rendered: return ResendDecision("BLOCKED", "required_request_data_redacted")
    return ResendDecision("SAFE_RESEND", "fully_reconstructable_text", True, {"text": text, "recipient": recipient, "operation": operation})


class ProviderResendService:
    def __init__(self, *, store: OutboundProviderAttemptStore | None = None, adapter: EvolutionAdapter | None = None, reconciler: EvolutionProviderReconciler | None = None) -> None:
        self._store = store or get_outbound_provider_attempt_store()
        self._adapter = adapter or get_evolution_adapter()
        self._reconciler = reconciler or EvolutionProviderReconciler(self._adapter)

    async def resend(
        self, *, source_attempt_id: str, source_delivery_id: str, connection_id: str, actor_id: str,
        idempotency_key: str, confirmed: bool, current_provider: str, current_instance: str,
        connection_active: bool,
    ) -> dict[str, Any]:
        source = self._store.get(source_attempt_id)
        if source is None: raise KeyError(source_attempt_id)
        if not confirmed: raise ResendBlockedError("explicit_confirmation_required")
        if str(source.get("provider") or "").strip().lower() != "evolution" or str(current_provider or "").strip().lower() != "evolution":
            raise ResendBlockedError("provider_resend_blocked")
        if str(source.get("instance") or "") != str(current_instance or ""):
            raise ResendBlockedError("connection_runtime_drift")
        persisted_connection_id = str(source.get("connectionId") or "").strip()
        if persisted_connection_id and persisted_connection_id != connection_id:
            raise ResendBlockedError("connection_ownership_drift")
        if not connection_active: raise ResendBlockedError("connection_not_active")
        if source.get("deliveryState") in {"accepted", "sent", "delivered", "read", "played"}:
            raise ResendBlockedError("provider_already_accepted_message")
        if source.get("deliveryState") != "failed" or source.get("reconciliationState") != "not_required":
            raise ResendBlockedError("RECONCILE_FIRST")
        reconstructed = reconstruct_outbound_request(source)
        if not reconstructed.reconstructable: raise ResendBlockedError(reconstructed.reason)

        try:
            action, created = create_or_get_action(
                action="resend_provider_outbound", source_delivery_id=source_delivery_id, target_id=source_attempt_id,
                connection_id=connection_id, actor_id=actor_id, idempotency_key=idempotency_key,
                extra={"sourceAttemptId": source_attempt_id, "provider": "evolution", "confirmation": True,
                       "configurationSource": "current", "observableDestinationDrift": False,
                       "reconciliationResult": None},
            )
        except ManualActionConflictError as exc:
            raise ResendConflictError(str(exc)) from exc
        if not created:
            return {"action": action, "idempotent": True}
        with _LOCK:
            if source_attempt_id in _INFLIGHT:
                update_action(action["id"], status="blocked", result={"reason": "source_attempt_resend_in_progress"})
                raise ResendConflictError("source_attempt_resend_in_progress")
            _INFLIGHT.add(source_attempt_id)
        try:
            # Fresh, exact-ID Evolution evidence is mandatory immediately before send.
            lookup: ProviderLookupResult = await self._reconciler.lookup(source)
            if not (lookup.status == "found" and lookup.confidence == "confirmed" and lookup.observed_state == "failed"):
                update_action(action["id"], status="blocked", result={"reason": "fresh_reconciliation_not_confirmed_failed", "reconciliationResult": asdict(lookup)})
                raise ResendBlockedError("fresh_reconciliation_not_confirmed_failed")
            update_action(action["id"], status="running", reconciliation_result=asdict(lookup))
            request = reconstructed.request or {}
            new_attempt = self._store.create(
                instance=str(source["instance"]), provider="evolution", message_type="text", recipient=request["recipient"], text=request["text"],
                provider_operation=request["operation"], retry_of_attempt_id=source_attempt_id,
                triggered_by_manual_action_id=action["id"], source_delivery_id=source_delivery_id,
            )
            update_action(action["id"], status="running", new_attempt_id=new_attempt["id"])
            try:
                result, completed = await execute_outbound_attempt(
                    attempt=new_attempt,
                    sender=lambda: self._adapter.send_text(str(source["instance"]), request["recipient"], request["text"]),
                    store=self._store,
                )
            except Exception:
                update_action(action["id"], status="failed", result={"reason": "resend_provider_call_failed", "sourceAttemptId": source_attempt_id}, new_delivery_id=new_attempt["id"], new_attempt_id=new_attempt["id"])
                raise
            completed_action = update_action(action["id"], status="completed", new_delivery_id=completed["id"], result={
                "sourceAttemptId": source_attempt_id, "reconciliationResult": asdict(lookup), "newAttemptId": completed["id"],
                "newDeliveryId": completed["id"], "providerMessageId": completed.get("providerMessageId"), "result": "accepted",
            }, new_attempt_id=completed["id"])
            return {"action": completed_action, "idempotent": False, "newAttempt": completed, "providerResult": result}
        finally:
            with _LOCK: _INFLIGHT.discard(source_attempt_id)


_service = ProviderResendService()
def get_provider_resend_service() -> ProviderResendService: return _service
