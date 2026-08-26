from __future__ import annotations

import asyncio

import pytest

from app.adapters.evolution.errors import EvolutionError
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore
from app.services.provider_reconciliation import (
    EvolutionProviderReconciler,
    ProviderLookupResult,
    ProviderReconciliationService,
    ReconciliationConflictError,
)


def _attempt(store: OutboundProviderAttemptStore, *, provider: str = "meta", provider_message_id: str | None = "provider-1") -> dict:
    attempt = store.create(instance="runtime-a", provider=provider, message_type="text", recipient="5491100000000", text="hola")
    return store._update(attempt["id"], {
        "semanticStatus": "timeout", "deliveryState": "unknown", "reconciliationState": "pending",
        "providerMessageId": provider_message_id,
    })


class _Lookup:
    def __init__(self, result: ProviderLookupResult, *, wait: bool = False) -> None:
        self.result = result
        self.calls = 0
        self.wait = wait

    async def lookup(self, _attempt: dict) -> ProviderLookupResult:
        self.calls += 1
        if self.wait:
            await asyncio.sleep(0.05)
        return self.result


@pytest.mark.parametrize("state", ["accepted", "delivered", "failed"])
def test_confirmed_reconciliation_updates_delivery_but_preserves_technical_status(tmp_path, state: str) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store)
    lookup = _Lookup(ProviderLookupResult("found", observed_state=state, confidence="confirmed", reason="found_by_provider_id"))
    service = ProviderReconciliationService(store=store, reconcilers={"meta": lookup})

    result = asyncio.run(service.reconcile(attempt_id=attempt["id"], instance="runtime-a"))

    assert result.status == "found" and result.observedState == state and result.confidence == "confirmed"
    stored = store.get(attempt["id"])
    assert stored and stored["semanticStatus"] == "timeout"
    assert stored["deliveryState"] == state
    assert stored["reconciliationState"] == "not_required"
    assert stored["lastReconciliation"]["reconciliationId"] == result.reconciliationId


@pytest.mark.parametrize("result", [
    ProviderLookupResult("not_found", reason="provider_message_not_found"),
    ProviderLookupResult("inconclusive", reason="missing_provider_message_id"),
    ProviderLookupResult("unavailable", reason="provider_timeout", error="Authorization: Bearer private-token"),
])
def test_uncertain_results_never_turn_unknown_into_failed(tmp_path, result: ProviderLookupResult) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store)
    service = ProviderReconciliationService(store=store, reconcilers={"meta": _Lookup(result)})

    reconciliation = asyncio.run(service.reconcile(attempt_id=attempt["id"], instance="runtime-a"))

    stored = store.get(attempt["id"])
    assert stored and stored["deliveryState"] == "unknown" and stored["reconciliationState"] == "pending"
    assert reconciliation.status == result.status
    assert "private-token" not in str(stored)
    assert "private-token" not in str(reconciliation.public_dict())


def test_meta_reconciler_is_explicitly_inconclusive_without_an_invented_graph_lookup(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store, provider="meta", provider_message_id="wamid.1")
    result = asyncio.run(ProviderReconciliationService(store=store).reconcile(attempt_id=attempt["id"], instance="runtime-a"))

    assert result.status == "inconclusive"
    assert result.reason == "meta_cloud_has_no_supported_message_status_lookup"
    stored = store.get(attempt["id"])
    assert stored and stored["deliveryState"] == "unknown" and stored["reconciliationState"] == "pending"


class _EvolutionAdapter:
    def __init__(self, payload: object | Exception) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str]] = []

    async def find_message_by_id(self, instance: str, message_id: str):
        self.calls.append((instance, message_id))
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


@pytest.mark.parametrize(
    ("payload", "status", "observed"),
    [
        ({"records": [{"key": {"id": "evo-1"}, "status": "DELIVERY_ACK"}]}, "found", "delivered"),
        ({"messages": {"records": [{"key": {"id": "evo-1"}, "status": "READ"}]}}, "found", "read"),
        ({"records": []}, "not_found", None),
    ],
)
def test_evolution_reconciler_uses_exact_provider_message_id(payload, status: str, observed: str | None) -> None:
    adapter = _EvolutionAdapter(payload)
    result = asyncio.run(EvolutionProviderReconciler(adapter).lookup({"instance": "runtime-evo", "providerMessageId": "evo-1"}))
    assert adapter.calls == [("runtime-evo", "evo-1")]
    assert result.status == status and result.observed_state == observed


@pytest.mark.parametrize("error", [
    EvolutionError("timeout Authorization: Bearer private", status_code=504),
    EvolutionError("forbidden api_key=private", status_code=403),
    EvolutionError("provider down", status_code=502),
])
def test_evolution_lookup_errors_are_unavailable_not_message_failed(error: EvolutionError) -> None:
    result = asyncio.run(EvolutionProviderReconciler(_EvolutionAdapter(error)).lookup({"instance": "runtime-evo", "providerMessageId": "evo-1"}))
    assert result.status == "unavailable"
    assert result.observed_state is None
    assert "private" not in str(result)


def test_concurrent_reconciliation_allows_one_effective_lookup(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store)
    lookup = _Lookup(ProviderLookupResult("inconclusive", reason="not_ready"), wait=True)
    service = ProviderReconciliationService(store=store, reconcilers={"meta": lookup})

    async def run():
        first = asyncio.create_task(service.reconcile(attempt_id=attempt["id"], instance="runtime-a"))
        await asyncio.sleep(0)
        second = asyncio.create_task(service.reconcile(attempt_id=attempt["id"], instance="runtime-a"))
        return await asyncio.gather(first, second, return_exceptions=True)

    results = asyncio.run(run())
    assert lookup.calls == 1
    assert sum(isinstance(item, ReconciliationConflictError) for item in results) == 1
    assert sum(not isinstance(item, Exception) for item in results) == 1
