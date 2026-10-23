import asyncio
import os
from types import SimpleNamespace

import httpx
import pytest

from app.models.canonical_v2 import HistoryPageRequest
from app.services import history_export
from app.services.cloud_coexistence import (
    CloudHistoryStore, cloud_message_data, history_records, record_history_chunk, request_coexistence_sync,
)
from app.services.connection_registry import ConnectionRegistry

BUSINESS = "5491100000000"


def chunk(phase=0, progress=40, errors=None):
    value = {"metadata": {"phase": phase, "chunk_order": 1, "progress": progress},
             "threads": [{"id": "5491122223333", "messages": [
                 {"from": "5491122223333", "id": "wamid.in", "timestamp": "1790000000", "type": "text", "text": {"body": "hola"}, "history_context": {"status": "READ"}},
                 {"from": BUSINESS, "to": "5491122223333", "id": "wamid.out", "timestamp": "1790000100", "type": "text", "text": {"body": "buen día"}},
                 {"from": "5491122223333", "id": "wamid.media", "timestamp": "1790000200", "type": "media_placeholder"},
             ]}]}
    if errors:
        value["errors"] = errors
    return value


@pytest.fixture
def registry(tmp_path):
    registry = ConnectionRegistry(tmp_path / "registry.json")
    registry.save_connection_record("cloud-runtime", {"id": "cloud-conn", "client_id": "c", "legacy_name": "cloud-runtime",
                                                      "provider_id": "meta", "channel_id": "whatsapp"})
    return registry


def test_history_chunk_keeps_both_directions_and_skips_media_placeholders():
    records = history_records(chunk(), BUSINESS)
    assert [(r["key"]["id"], r["key"]["fromMe"], r["key"]["remoteJid"]) for r in records] == [
        ("wamid.in", False, "5491122223333@s.whatsapp.net"), ("wamid.out", True, "5491122223333@s.whatsapp.net")]
    assert records[1]["message"] == {"conversation": "buen día"} and records[1]["messageTimestamp"] == "1790000100"


def test_echo_is_an_outbound_record_for_the_customer():
    echo = cloud_message_data({"from": BUSINESS, "to": "5491144445555", "id": "wamid.echo", "timestamp": "1", "type": "text", "text": {"body": "ok"}}, from_me=True)
    assert echo["key"] == {"id": "wamid.echo", "remoteJid": "5491144445555@s.whatsapp.net", "fromMe": True}


def test_chunks_are_stored_once_and_progress_is_tracked(tmp_path, registry):
    store = CloudHistoryStore("", path=tmp_path / "cloud_history.json")
    assert record_history_chunk("cloud-runtime", chunk(), BUSINESS, store=store, registry=registry) == 2
    record_history_chunk("cloud-runtime", chunk(phase=2, progress=100), BUSINESS, store=store, registry=registry)
    state = registry.connection_record_by_id("cloud-conn")["coexistence"]
    assert (state["history"], state["historyPhase"]) == ("complete", 2)
    records, total = store.page("cloud-runtime", 1, 10)
    assert total == 2 and [r["key"]["id"] for r in records] == ["wamid.out", "wamid.in"]  # deduplicated, newest first


def test_declined_history_is_recorded(tmp_path, registry):
    store = CloudHistoryStore("", path=tmp_path / "cloud_history.json")
    record_history_chunk("cloud-runtime", chunk(errors=[{"code": 2593109, "title": "History sharing declined"}]), BUSINESS, store=store, registry=registry)
    assert registry.connection_record_by_id("cloud-conn")["coexistence"]["history"] == "declined"
    assert store.page("cloud-runtime", 1, 10)[1] == 0


@pytest.mark.skipif(not os.environ.get("GATEWAY_TEST_DATABASE_URL"), reason="GATEWAY_TEST_DATABASE_URL not set")
def test_postgres_store_pages_newest_first():
    import psycopg
    url = os.environ["GATEWAY_TEST_DATABASE_URL"]
    with psycopg.connect(url) as connection:
        connection.execute("DROP TABLE IF EXISTS botly_gateway_cloud_history")
    store = CloudHistoryStore(url)
    store.add("cloud-runtime", history_records(chunk(), BUSINESS))
    store.add("cloud-runtime", history_records(chunk(), BUSINESS))
    records, total = store.page("cloud-runtime", 1, 1)
    assert total == 2 and records[0]["key"]["id"] == "wamid.out"


def test_cloud_history_is_served_like_evolution_history(tmp_path, registry):
    store = CloudHistoryStore("", path=tmp_path / "cloud_history.json")
    record_history_chunk("cloud-runtime", chunk(), BUSINESS, store=store, registry=registry)
    request = SimpleNamespace(state=SimpleNamespace(auth_method="instance_api_key", auth_instance="cloud-runtime"))
    body = HistoryPageRequest(coreChannelId="core-1", connectionRef="cloud-conn", page=1, pageSize=50)
    page = asyncio.run(history_export.history_page(body, request, registry=registry, cloud_store=store))
    assert (page["pages"], page["records"], page["oldestTimestamp"]) == (1, 2, 1790000000)
    assert [item["type"] for item in page["items"]] == ["direct", "direct"]
    assert [item["payload"]["direction"] for item in page["items"]] == ["outbound", "inbound"]
    assert page["items"][0]["payload"]["messageTimestamp"] == "1790000100"


def test_sync_request_asks_meta_for_contacts_and_history(registry, monkeypatch):
    calls = []
    def handler(request):
        calls.append((request.url.path, request.headers["Authorization"], request.content))
        if b"history" in request.content:
            return httpx.Response(400, json={"error": {"message": "Sync window expired"}})
        return httpx.Response(200, json={"request_id": "req-contacts"})
    info = SimpleNamespace(phone_number_id="PNID")
    monkeypatch.setattr("app.services.cloud_coexistence.get_credential_manager",
                        lambda: SimpleNamespace(get_official_credentials_info=lambda i: info, get_official_access_token=lambda i: "tok"))
    result = asyncio.run(request_coexistence_sync("cloud-runtime", registry=registry,
                                                  client_factory=lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler))))
    assert [c[0].rsplit("/", 2)[-2:] for c in calls] == [["PNID", "smb_app_data"], ["PNID", "smb_app_data"]]
    assert all(c[1] == "Bearer tok" for c in calls)
    assert result == {"smb_app_state_sync": {"requestId": "req-contacts"}, "history": {"error": "Sync window expired"}}
    state = registry.connection_record_by_id("cloud-conn")["coexistence"]
    assert state["history"] == "failed" and state["contacts"] == {"requestId": "req-contacts"}
