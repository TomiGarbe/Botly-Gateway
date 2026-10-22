import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.models.canonical_v2 import HistoryPageRequest
from app.services import history_export
from app.services.instagram_history import history_message, instagram_history_page

ACCOUNT = "17841400000000000"


def message(mid, sender, recipient, *, text="hola", at="2026-10-20T15:00:00+0000", attachments=None):
    value = {"id": mid, "created_time": at, "from": {"id": sender, "username": f"u{sender}"},
             "to": {"data": [{"id": recipient, "username": f"u{recipient}"}]}}
    if text is not None:
        value["message"] = text
    if attachments:
        value["attachments"] = {"data": attachments}
    return value


def test_history_message_maps_both_directions_and_skips_empty_messages():
    inbound = history_message(message("m1", "555", ACCOUNT), ACCOUNT)["message"]
    assert (inbound["direction"], inbound["externalContactId"], inbound["contactName"], inbound["kind"]) == ("inbound", "555", "u555", "text")
    assert inbound["occurredAt"] == int(datetime(2026, 10, 20, 15, tzinfo=timezone.utc).timestamp())
    outbound = history_message(message("m2", ACCOUNT, "555", text="te respondo"), ACCOUNT)["message"]
    assert (outbound["direction"], outbound["externalContactId"]) == ("outbound", "555")
    photo = history_message(message("m3", "555", ACCOUNT, text=None, attachments=[{"image_data": {"url": "https://cdn/x.jpg"}}]), ACCOUNT)["message"]
    assert (photo["kind"], photo["content"], photo["attachments"]) == ("image", None, [{"kind": "image", "url": "https://cdn/x.jpg"}])
    assert history_message(message("m4", "555", ACCOUNT, text=None), ACCOUNT) is None


def test_instagram_page_paginates_and_fetches_details_when_only_ids_are_returned(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request.url)
        assert request.headers["Authorization"] == "Bearer token"
        if request.url.path.endswith("/me/conversations"):
            assert request.url.params["platform"] == "instagram"
            return httpx.Response(200, json={
                "data": [{"id": "c1", "updated_time": "2026-10-21T10:00:00+0000",
                          "messages": {"data": [message("m1", "555", ACCOUNT), {"id": "m2"}]}}],
                "paging": {"cursors": {"after": "CURSOR2"}, "next": "https://next"}})
        assert request.url.path.endswith("/m2")
        return httpx.Response(200, json=message("m2", ACCOUNT, "555", text="respuesta"))

    record = {"provider_account": {"providerAccountId": ACCOUNT}}
    credentials = SimpleNamespace(get_provider_access_token=lambda account: "token")
    page = asyncio.run(instagram_history_page(record, None, credentials=credentials,
                                              client_factory=lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler))))
    assert page["nextCursor"] == "CURSOR2" and page["records"] == 2 and page["conversations"] == 1
    assert [item["message"]["direction"] for item in page["items"]] == ["inbound", "outbound"]
    assert page["oldestTimestamp"] == int(datetime(2026, 10, 21, 10, tzinfo=timezone.utc).timestamp())
    assert "access_token" not in str(calls[0])


def test_history_endpoint_routes_instagram_and_checks_core_binding(monkeypatch):
    record = {"id": "ig-conn", "legacy_name": "setup_ig", "provider_id": "meta", "channel_id": "instagram"}
    registry = SimpleNamespace(connection_record_by_id=lambda ref: record if ref == "ig-conn" else None, connection_record=lambda ref: None)
    monkeypatch.setattr("app.services.connections.get_connection_service",
                        lambda: SimpleNamespace(instagram_core_channel_binding=lambda cid: {"channelId": "core-ig"}))
    seen = []
    async def fake_page(rec, cursor):
        seen.append(cursor)
        return {"items": [], "nextCursor": None, "records": 0}
    request = SimpleNamespace(state=SimpleNamespace(auth_method="instance_api_key", auth_instance="setup_ig"))
    body = HistoryPageRequest(coreChannelId="core-ig", connectionRef="ig-conn", page=2, cursor="ABC")
    assert asyncio.run(history_export.history_page(body, request, registry=registry, instagram_page=fake_page))["nextCursor"] is None
    assert seen == ["ABC"]
    other = HistoryPageRequest(coreChannelId="core-other", connectionRef="ig-conn", page=1)
    with pytest.raises(HTTPException) as error:
        asyncio.run(history_export.history_page(other, request, registry=registry, instagram_page=fake_page))
    assert error.value.status_code == 409
