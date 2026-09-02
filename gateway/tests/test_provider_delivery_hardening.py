from __future__ import annotations

import asyncio

import pytest

from app.services import normalization, provider_deliveries, provider_status_correlation
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore, execute_outbound_attempt
from app.services.provider_deliveries import ProviderDeliveryQueryService


def _reset_timeline() -> None:
    normalization._business_events.clear()
    normalization._operational_events.clear()
    normalization._business_event_keys.clear()
    normalization._business_event_keys_order.clear()


def test_logical_message_projection_merges_local_send_and_provider_echo(monkeypatch) -> None:
    """The audit stream keeps both facts, while Messages shows one message."""
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    normalization.save_event({
        "id": "local-send", "layer": "business", "event": "LOCAL_OUTBOUND_SEND", "instance": "runtime-a", "timestamp": 100,
        "direction": "outbound", "type": "message", "subtype": "text", "messageType": "text", "text": "hola",
        "status": "sent", "sender": "runtime-a", "recipient": "5491100000000", "message": {"id": "provider-message-1", "kind": "text", "text": "hola"},
        "raw": {"provider": "evolution", "providerMessageId": "provider-message-1"},
    })
    echo = normalization.normalize_webhook({
        "event": "MESSAGES_UPSERT", "instance": "runtime-a", "provider": "evolution",
        "data": {"key": {"id": "provider-message-1", "remoteJid": "5491100000000@s.whatsapp.net", "fromMe": True}, "message": {"conversation": "hola"}},
    })
    echo["id"] = "provider-echo"
    echo["timestamp"] = 110
    normalization.save_event(echo)
    status = normalization.normalize_webhook({
        "event": "MESSAGES_UPDATE", "instance": "runtime-a", "provider": "evolution",
        "data": {"key": {"id": "provider-message-1", "fromMe": True}, "status": "delivered"},
    })
    status["id"] = "delivery-status"
    status["timestamp"] = 120
    normalization.save_event(status)

    evidence = normalization.list_events(instance="runtime-a", limit=10)
    timeline = normalization.list_logical_messages("runtime-a")

    assert len([event for event in evidence if event.get("type") == "message"]) == 2
    assert len(timeline) == 1
    assert timeline[0]["messageId"] == "provider-message-1"
    assert timeline[0]["status"] == "delivered"
    assert timeline[0]["payload"]["sourceEvent"] == "LOCAL_OUTBOUND_SEND"
    assert timeline[0]["payload"]["sourceEventIds"] == ["local-send", "provider-echo"]


def _attempt(store: OutboundProviderAttemptStore, *, provider: str = "meta", message_id: str = "provider-1") -> dict:
    attempt = store.create(instance="runtime-a", provider=provider, message_type="text", recipient="5491100000000", text="hola")

    async def sender():
        return {"messageId": message_id} if provider == "meta" else {"key": {"id": message_id}}

    _, completed = asyncio.run(execute_outbound_attempt(attempt=attempt, sender=sender, store=store))
    return completed


@pytest.mark.parametrize("status", ["sent", "delivered", "read", "failed"])
def test_meta_status_matches_exact_attempt_and_keeps_technical_result(tmp_path, status: str) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store)
    result = provider_status_correlation.ProviderStatusCorrelationService(store).correlate({
        "id": f"status-{status}", "instance": "runtime-a", "direction": "status", "status": status,
        "sourceTimestamp": 123, "providerDelivery": {"provider": "meta", "providerMessageId": "provider-1"},
    })

    assert result.outcome == "matched"
    assert result.attempt_id == attempt["id"]
    stored = store.list(instance="runtime-a")[0]
    assert stored["semanticStatus"] == "success"
    assert stored["deliveryState"] == status
    assert stored["reconciliationState"] == "not_required"
    assert stored["lastProviderStatus"]["eventId"] == f"status-{status}"


def test_correlation_is_not_found_invalid_or_ambiguous_without_mutation(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    first = _attempt(store, message_id="same-provider-id")
    second = _attempt(store, message_id="same-provider-id")
    service = provider_status_correlation.ProviderStatusCorrelationService(store)

    assert service.correlate({"instance": "runtime-a", "direction": "status", "status": "delivered", "providerDelivery": {"provider": "evolution", "providerMessageId": "same-provider-id"}}).outcome == "not_found"
    assert service.correlate({"instance": "runtime-a", "direction": "status", "status": "delivered", "providerDelivery": {"provider": "meta", "providerMessageId": "missing-provider-id"}}).outcome == "not_found"
    assert service.correlate({"instance": "runtime-a", "direction": "status", "status": "delivered", "providerDelivery": {"provider": "meta", "providerMessageId": ""}}).outcome == "invalid"
    assert service.correlate({"instance": "runtime-a", "direction": "status", "status": "delivered", "providerDelivery": {"provider": "meta", "providerMessageId": "same-provider-id"}}).outcome == "ambiguous"

    attempts = {item["id"]: item for item in store.list(instance="runtime-a")}
    assert attempts[first["id"]]["deliveryState"] == "accepted"
    assert attempts[second["id"]]["deliveryState"] == "accepted"


def test_normalized_meta_and_evolution_statuses_link_without_becoming_inbound(monkeypatch, tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    meta_attempt = _attempt(store, provider="meta", message_id="wamid.1")
    evolution_attempt = _attempt(store, provider="evolution", message_id="evo.1")
    monkeypatch.setattr(provider_status_correlation, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()

    for provider, identifier, status in (("meta", "wamid.1", "delivered"), ("evolution", "evo.1", "read")):
        event = normalization.normalize_webhook({
            "event": "MESSAGES_UPDATE", "instance": "runtime-a", "provider": provider,
            "data": {"key": {"id": identifier, "remoteJid": "5491100000000", "fromMe": True}, "status": status},
        })
        assert normalization.save_event(event) is True

    deliveries = [event["providerDelivery"] for event in normalization.list_events(instance="runtime-a", limit=10)]
    assert {(item["provider"], item["outboundAttemptId"], item["deliveryState"]) for item in deliveries} == {
        ("meta", meta_attempt["id"], "delivered"), ("evolution", evolution_attempt["id"], "read"),
    }
    assert all(item["direction"] == "status" and item["operation"] == "provider.message.status" for item in deliveries)


def test_evolution_status_without_key_stays_status_and_is_not_correlated(monkeypatch, tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    monkeypatch.setattr(provider_status_correlation, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    event = normalization.normalize_webhook({"event": "MESSAGES_UPDATE", "instance": "runtime-a", "provider": "evolution", "data": {"status": "delivered"}})
    normalization.save_event(event)

    delivery = normalization.list_events(instance="runtime-a", limit=1)[0]["providerDelivery"]
    assert delivery["provider"] == "evolution"
    assert delivery["direction"] == "status"
    assert delivery["operation"] == "provider.message.status"
    assert delivery["outboundAttemptId"] is None
    assert delivery["metadata"]["statusCorrelation"]["outcome"] == "invalid"


def test_meta_failed_status_is_delivery_evidence_not_a_technical_rewrite(monkeypatch, tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store, provider="meta", message_id="wamid.failed")
    monkeypatch.setattr(provider_status_correlation, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    event = normalization.normalize_webhook({"event": "MESSAGES_UPDATE", "instance": "runtime-a", "provider": "meta", "data": {"key": {"id": "wamid.failed"}, "status": "failed"}})
    normalization.save_event(event)

    stored = store.list(instance="runtime-a")[0]
    delivery = normalization.list_events(instance="runtime-a", limit=1)[0]["providerDelivery"]
    assert stored["semanticStatus"] == "success"
    assert stored["deliveryState"] == "failed"
    assert delivery["outboundAttemptId"] == attempt["id"]
    assert delivery["deliveryState"] == "failed"


def test_distinct_status_progression_is_not_deduplicated(monkeypatch, tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store, provider="meta", message_id="wamid.progress")
    monkeypatch.setattr(provider_status_correlation, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    for status in ("sent", "delivered", "read"):
        event = normalization.normalize_webhook({"event": "MESSAGES_UPDATE", "instance": "runtime-a", "provider": "meta", "data": {"key": {"id": "wamid.progress"}, "status": status}})
        assert normalization.save_event(event) is True

    events = normalization.list_events(instance="runtime-a", limit=10)
    assert [event["status"] for event in events] == ["read", "delivered", "sent"]
    assert store.list(instance="runtime-a")[0]["deliveryState"] == "read"
    assert all(event["providerDelivery"]["outboundAttemptId"] == attempt["id"] for event in events)


@pytest.mark.parametrize(
    ("semantic", "delivery", "reconciliation"),
    [("success", "accepted", "not_required"), ("timeout", "unknown", "pending"), ("network_error", "unknown", "pending")],
)
def test_attempt_and_timeline_reference_produce_one_outbound_delivery(monkeypatch, tmp_path, semantic: str, delivery: str, reconciliation: str) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = store.create(instance="runtime-a", provider="meta", message_type="text", recipient="5491100000000", text="hola")
    attempt = store._update(attempt["id"], {"semanticStatus": semantic, "deliveryState": delivery, "reconciliationState": reconciliation})
    monkeypatch.setattr(provider_deliveries, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    normalization.save_event({
        "id": f"timeline-{semantic}", "layer": "business", "event": "LOCAL_OUTBOUND_SEND", "instance": "runtime-a", "timestamp": 10,
        "direction": "outbound", "status": "sent", "message": {"id": "local-1", "kind": "text"},
        "raw": {"provider": "meta", "providerMessageId": "provider-1", "outboundAttemptId": attempt["id"]},
    })

    page = ProviderDeliveryQueryService().list(instance="runtime-a", limit=20, offset=0)
    assert page["total"] == 1
    assert page["items"][0]["id"] == attempt["id"]
    assert page["items"][0]["semanticStatus"] == semantic
    assert page["items"][0]["deliveryState"] == delivery
    assert page["items"][0]["reconciliationState"] == reconciliation
    detail = ProviderDeliveryQueryService().detail(provider_deliveries.provider_delivery_from_attempt(attempt))
    assert detail["summary"]["deliveryState"] == delivery
    assert detail["summary"]["reconciliationState"] == reconciliation


def test_timeout_without_timeline_and_legacy_event_remain_safe(monkeypatch, tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = store.create(instance="runtime-a", provider="meta", message_type="text", recipient="5491100000000", text="hola")
    attempt = store._update(attempt["id"], {"semanticStatus": "timeout", "deliveryState": "unknown", "reconciliationState": "pending"})
    monkeypatch.setattr(provider_deliveries, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    normalization.save_event({
        "id": "legacy", "layer": "business", "event": "LOCAL_OUTBOUND_SEND", "instance": "runtime-a", "timestamp": 20,
        "direction": "outbound", "status": "sent", "message": {"id": "legacy-message", "kind": "text"}, "raw": {"provider": "evolution"},
    })

    page = ProviderDeliveryQueryService().list(instance="runtime-a", limit=20, offset=0)
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id[attempt["id"]]["semanticStatus"] == "timeout"
    assert by_id[attempt["id"]]["deliveryState"] == "unknown"
    assert by_id[attempt["id"]]["reconciliationState"] == "pending"
    assert by_id["legacy"]["deliveryState"] is None
    assert by_id["legacy"]["reconciliationState"] is None


def test_correlated_status_is_visible_beside_one_outbound_attempt(monkeypatch, tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = _attempt(store, message_id="wamid.2")
    monkeypatch.setattr(provider_status_correlation, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(provider_deliveries, "get_outbound_provider_attempt_store", lambda: store)
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    status = normalization.normalize_webhook({"event": "MESSAGES_UPDATE", "instance": "runtime-a", "provider": "meta", "data": {"key": {"id": "wamid.2"}, "status": "delivered"}})
    normalization.save_event(status)

    page = ProviderDeliveryQueryService().list(instance="runtime-a", limit=20, offset=0)
    assert {(item["direction"], item["deliveryState"]) for item in page["items"]} == {("outbound", "delivered"), ("status", "delivered")}
    assert len([item for item in page["items"] if item["direction"] == "outbound"]) == 1
