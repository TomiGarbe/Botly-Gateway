from app.services import normalization


def _reset_timeline() -> None:
    """Keep provider-delivery assertions independent from restored activity."""
    normalization._business_events.clear()
    normalization._operational_events.clear()
    normalization._business_event_keys.clear()
    normalization._business_event_keys_order.clear()


def test_provider_delivery_is_normalized_without_duplicate_message(monkeypatch) -> None:
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    event = {
        "id": "event-1", "layer": "business", "event": "LOCAL_OUTBOUND_SEND", "instance": "runtime-a", "timestamp": 100,
        "direction": "outbound", "messageType": "image", "status": "sent", "meta": {"requestId": "request-1", "conversationId": "conversation-1"},
        "message": {"id": "message-1", "kind": "image"}, "media": {"id": "media-1", "kind": "image", "mimeType": "image/png", "fileName": "photo.png", "mediaKey": "never-log"},
        "raw": {"provider": "evolution", "providerMessageId": "provider-1", "token": "never-log"},
    }
    assert normalization.save_event(event) is True
    stored = normalization.list_events(instance="runtime-a", limit=1)[0]
    delivery = stored["providerDelivery"]
    assert delivery["id"] == "event-1"
    assert delivery["operation"] == "provider.message.outbound"
    assert delivery["semanticStatus"] == "success"
    assert delivery["messageId"] == "message-1"
    assert delivery["providerMessageId"] == "provider-1"
    assert delivery["requestId"] == "request-1"
    assert delivery["request"]["body"]["media"] == {"id": "media-1", "kind": "image", "mimeType": "image/png", "fileName": "photo.png"}
    assert "never-log" not in str(stored)
    assert normalization.list_provider_deliveries(instance="runtime-a", direction="outbound", message_id="message-1") == [{key: delivery.get(key) for key in ("id", "timestamp", "direction", "operation", "semanticStatus", "provider", "messageId", "conversationId", "channelId", "connectionId", "providerMessageId", "durationMs", "correlationId")}]


def test_provider_delivery_maps_safe_error_categories(monkeypatch) -> None:
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    event = {"id": "event-2", "layer": "business", "event": "MESSAGES_UPSERT", "instance": "runtime-b", "timestamp": 200, "direction": "inbound", "message": {"id": "message-2", "kind": "text"}, "error": {"code": "timeout", "message": "token=private timed out"}}
    normalization.save_event(event)
    delivery = normalization.list_events(instance="runtime-b", limit=1)[0]["providerDelivery"]
    assert delivery["operation"] == "provider.message.inbound"
    assert delivery["semanticStatus"] == "timeout"
    assert "private" not in str(delivery)


def test_meta_and_status_updates_keep_their_real_provider_and_direction(monkeypatch) -> None:
    monkeypatch.setattr(normalization, "_persist_business_events", lambda: True)
    _reset_timeline()
    event = normalization.normalize_webhook({
        "event": "MESSAGES_UPDATE", "instance": "runtime-meta", "provider": "meta",
        "data": {"key": {"id": "wamid.1", "remoteJid": "5491100000000", "fromMe": True}, "status": "delivered"},
    })
    normalization.save_event(event)
    delivery = normalization.list_events(instance="runtime-meta", limit=1)[0]["providerDelivery"]
    assert delivery["provider"] == "meta"
    assert delivery["direction"] == "status"
    assert delivery["operation"] == "provider.message.status"
