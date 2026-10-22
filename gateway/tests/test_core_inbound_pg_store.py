import json
import os
import threading
import uuid

import pytest

from app.services import core_inbound_dispatcher as inbound
from app.services.core_inbound_pg_store import PostgresCoreInboundDeliveryStore

URL = os.environ.get("GATEWAY_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="GATEWAY_TEST_DATABASE_URL not set")


def event(message_id="m-1", event_id=None, chat="team@g.us"):
    return {"contractVersion": "canonical-v2", "eventId": event_id or f"evt-{uuid.uuid4().hex}", "eventType": "message",
            "transport": {"provider": "evolution", "channelType": "whatsapp", "providerAccountRef": "acc",
                          "connectionRef": "conn-a", "coreChannelId": "core-1", "bindingId": "binding-a"},
            "chat": {"type": "group", "externalId": chat}, "message": {"providerMessageId": message_id, "fromMe": False}}


@pytest.fixture
def store(tmp_path):
    import psycopg
    with psycopg.connect(URL) as connection:
        connection.execute("DROP TABLE IF EXISTS botly_gateway_core_inbound_deliveries")
    return PostgresCoreInboundDeliveryStore(URL, legacy_path=tmp_path / "inbound_deliveries.json")


def test_enqueue_deduplicates_by_event_and_provider_message(store):
    first, created = store.enqueue(event=event("m-1", "evt-1"), core_channel_id="core-1")
    assert created and first["status"] == "pending"
    same_event, created = store.enqueue(event=event("m-other", "evt-1"), core_channel_id="core-1")
    assert not created and same_event["id"] == first["id"]
    same_message, created = store.enqueue(event=event("m-1", "evt-2"), core_channel_id="core-1")
    assert not created and same_message["id"] == first["id"]
    assert len(store.list()) == 1 and store.list_for_connection("conn-a")[0]["id"] == first["id"]


def test_claim_lease_retry_dead_letter_and_replay(store, monkeypatch):
    delivery, _ = store.enqueue(event=event(), core_channel_id="core-1")
    [claimed] = store.claim_due(limit=10, lease_seconds=60)
    assert claimed["status"] == "delivering" and claimed["attemptCount"] == 1
    assert store.claim_due(limit=10, lease_seconds=60) == []  # leased
    retried = store.retry_or_dead_letter(delivery["id"], error="core_down", max_attempts=2, backoff_seconds=0)
    assert retried["status"] == "retry"
    store.claim_due(limit=10, lease_seconds=60)
    dead = store.retry_or_dead_letter(delivery["id"], error="core_down", max_attempts=2, backoff_seconds=0)
    assert dead["status"] == "dead_letter"
    replay = store.replay_group(delivery["id"], connection_id="conn-a", core_channel_id="core-1", binding_id="binding-a")
    assert replay["status"] == "pending"
    with pytest.raises(ValueError):
        store.replay_group(delivery["id"], connection_id="conn-a", core_channel_id="other", binding_id="binding-a")
    [again] = store.claim_due(limit=10, lease_seconds=60)
    done = store.complete(again["id"])
    assert done["status"] == "delivered" and store.get(delivery["id"])["deliveredAt"]


def test_concurrent_claims_never_hand_out_the_same_delivery(store):
    for index in range(20):
        store.enqueue(event=event(f"m-{index}"), core_channel_id="core-1")
    results, barrier = [], threading.Barrier(4)
    def worker():
        barrier.wait()
        results.extend(item["id"] for item in store.claim_due(limit=10, lease_seconds=60))
    threads = [threading.Thread(target=worker) for _ in range(4)]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]
    assert len(results) == len(set(results)) == 20


def test_old_delivered_entries_are_pruned_on_write(store, monkeypatch):
    old, _ = store.enqueue(event=event("m-old"), core_channel_id="core-1")
    store._update(old["id"], {"status": "delivered", "deliveredAt": inbound._now() - 8 * 86_400_000})
    failed, _ = store.enqueue(event=event("m-failed"), core_channel_id="core-1")
    store._update(failed["id"], {"status": "dead_letter"})
    store.enqueue(event=event("m-new"), core_channel_id="core-1")
    ids = {item["id"] for item in store.list()}
    assert old["id"] not in ids and failed["id"] in ids


def test_legacy_json_outbox_is_imported_once(tmp_path):
    import psycopg
    with psycopg.connect(URL) as connection:
        connection.execute("DROP TABLE IF EXISTS botly_gateway_core_inbound_deliveries")
    legacy = tmp_path / "inbound_deliveries.json"
    json_store = inbound.CoreInboundDeliveryStore(legacy)
    pending, _ = json_store.enqueue(event=event("m-legacy"), core_channel_id="core-1")
    store = PostgresCoreInboundDeliveryStore(URL, legacy_path=legacy)
    assert [item["id"] for item in store.list()] == [pending["id"]]
    assert not legacy.exists() and (tmp_path / "inbound_deliveries.json.migrated").exists()
    assert store.enqueue(event=event("m-legacy"), core_channel_id="core-1")[1] is False
