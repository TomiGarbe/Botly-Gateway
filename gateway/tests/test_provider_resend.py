from __future__ import annotations

import asyncio
import copy
import json
from types import SimpleNamespace

import pytest

from app.services.manual_delivery_actions import get_action
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore
from app.services.provider_reconciliation import ProviderLookupResult
from app.services.provider_resend import ProviderResendService, ResendBlockedError, ResendConflictError


def _settings(tmp_path):
    return SimpleNamespace(
        manual_delivery_actions_path=str(tmp_path / "manual-actions.json"),
        manual_delivery_action_retention=100, manual_delivery_action_rate_limit=20,
        manual_delivery_action_rate_window_seconds=60,
    )


class _Adapter:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []

    async def send_text(self, instance: str, recipient: str, text: str) -> dict:
        self.sent.append((instance, recipient, text))
        return {"key": {"id": f"new-provider-id-{len(self.sent)}"}}


class _Reconciler:
    def __init__(self, result: ProviderLookupResult, *, wait: bool = False) -> None:
        self.result = result
        self.wait = wait
        self.calls = 0

    async def lookup(self, _attempt: dict) -> ProviderLookupResult:
        self.calls += 1
        if self.wait:
            await asyncio.sleep(0.05)
        return self.result


def _failed_attempt(store: OutboundProviderAttemptStore, *, provider: str = "evolution", media: dict | None = None) -> dict:
    attempt = store.create(
        instance="runtime-evolution", provider=provider, message_type="text", recipient="5491100000000",
        text="texto exacto", provider_operation="messages.sendText", media=media,
    )
    return store._update(attempt["id"], {
        "semanticStatus": "failed", "attemptState": "completed", "deliveryState": "failed",
        "reconciliationState": "not_required", "providerMessageId": "original-provider-id",
        "error": {"category": "http_error", "message": "safe failure", "httpStatus": 400},
    })


def _service(monkeypatch, tmp_path, result: ProviderLookupResult, **kwargs):
    monkeypatch.setattr("app.services.manual_delivery_actions.get_settings", lambda: _settings(tmp_path))
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    adapter = _Adapter()
    reconciler = _Reconciler(result, **kwargs)
    return store, adapter, reconciler, ProviderResendService(store=store, adapter=adapter, reconciler=reconciler)


def _resend(service: ProviderResendService, source: dict, *, key: str = "resend-key", provider: str = "evolution"):
    return service.resend(
        source_attempt_id=source["id"], source_delivery_id=source["id"], connection_id="connection-a",
        actor_id="actor-a", idempotency_key=key, confirmed=True, current_provider=provider,
        current_instance="runtime-evolution", connection_active=True,
    )


def test_safe_evolution_resend_creates_linked_attempt_and_preserves_original(monkeypatch, tmp_path) -> None:
    store, adapter, reconciler, service = _service(monkeypatch, tmp_path, ProviderLookupResult("found", "failed", "confirmed", "confirmed_failed"))
    source = _failed_attempt(store)
    original = copy.deepcopy(source)

    outcome = asyncio.run(_resend(service, source))

    new_attempt = outcome["newAttempt"]
    assert outcome["idempotent"] is False and reconciler.calls == 1
    assert adapter.sent == [("runtime-evolution", "5491100000000", "texto exacto")]
    assert new_attempt["id"] != source["id"]
    assert new_attempt["retryOf"] == source["id"]
    assert new_attempt["sourceDeliveryId"] == source["id"]
    assert new_attempt["triggeredByManualActionId"] == outcome["action"]["id"]
    assert new_attempt["semanticStatus"] == "success" and new_attempt["deliveryState"] == "accepted"
    assert new_attempt["providerMessageId"] == "new-provider-id-1"
    assert store.get(source["id"]) == original
    action = get_action(outcome["action"]["id"])
    assert action and action["status"] == "completed" and action["sourceAttemptId"] == source["id"]
    assert action["newAttemptId"] == new_attempt["id"] and action["newDeliveryId"] == new_attempt["id"]
    assert action["reconciliationResult"]["confidence"] == "confirmed"
    assert "texto exacto" not in json.dumps(action)


@pytest.mark.parametrize("fresh", [
    ProviderLookupResult("found", "accepted", "confirmed"),
    ProviderLookupResult("found", "sent", "confirmed"),
    ProviderLookupResult("found", "delivered", "confirmed"),
    ProviderLookupResult("found", "read", "confirmed"),
    ProviderLookupResult("found", "played", "confirmed"),
    ProviderLookupResult("inconclusive", reason="missing_provider_message_id"),
    ProviderLookupResult("not_found", reason="provider_message_not_found"),
])
def test_non_failed_fresh_evidence_never_resends(monkeypatch, tmp_path, fresh: ProviderLookupResult) -> None:
    store, adapter, _reconciler, service = _service(monkeypatch, tmp_path, fresh)
    source = _failed_attempt(store)
    with pytest.raises(ResendBlockedError):
        asyncio.run(_resend(service, source))
    assert adapter.sent == []


def test_unknown_and_non_reconstructable_or_meta_sources_are_blocked(monkeypatch, tmp_path) -> None:
    store, adapter, _reconciler, service = _service(monkeypatch, tmp_path, ProviderLookupResult("found", "failed", "confirmed"))
    source = _failed_attempt(store)
    unknown = store._update(source["id"], {"deliveryState": "unknown", "reconciliationState": "pending"})
    with pytest.raises(ResendBlockedError, match="RECONCILE_FIRST"):
        asyncio.run(_resend(service, unknown))

    media = _failed_attempt(store, media={"kind": "image", "source": "upload"})
    with pytest.raises(ResendBlockedError, match="media_not_reconstructable"):
        asyncio.run(_resend(service, media, key="media"))

    meta = _failed_attempt(store, provider="meta")
    with pytest.raises(ResendBlockedError, match="provider_resend_blocked"):
        asyncio.run(_resend(service, meta, key="meta", provider="meta"))
    assert adapter.sent == []


def test_same_key_is_idempotent_and_other_key_is_rejected_after_success(monkeypatch, tmp_path) -> None:
    store, adapter, _reconciler, service = _service(monkeypatch, tmp_path, ProviderLookupResult("found", "failed", "confirmed"))
    source = _failed_attempt(store)
    first = asyncio.run(_resend(service, source, key="same"))
    repeated = asyncio.run(_resend(service, source, key="same"))
    assert repeated["idempotent"] is True and repeated["action"]["id"] == first["action"]["id"]
    with pytest.raises(ResendConflictError):
        asyncio.run(_resend(service, source, key="other"))
    assert len(adapter.sent) == 1


def test_concurrent_resends_produce_one_side_effect(monkeypatch, tmp_path) -> None:
    store, adapter, _reconciler, service = _service(monkeypatch, tmp_path, ProviderLookupResult("found", "failed", "confirmed"), wait=True)
    source = _failed_attempt(store)

    async def run():
        first = asyncio.create_task(_resend(service, source, key="first"))
        await asyncio.sleep(0)
        second = asyncio.create_task(_resend(service, source, key="second"))
        return await asyncio.gather(first, second, return_exceptions=True)

    outcomes = asyncio.run(run())
    assert len(adapter.sent) == 1
    assert sum(isinstance(value, ResendConflictError) for value in outcomes) == 1
    assert sum(not isinstance(value, Exception) for value in outcomes) == 1
