"""Provider history pages for Core imports. Never reaches the live delivery pipeline."""

from fastapi import HTTPException

from app.adapters.evolution import get_evolution_adapter
from app.core.logging import get_logger
from app.services.connection_registry import get_connection_registry
from app.services.group_transport import projection, require_policy
from app.services.normalization import normalize_webhook

logger = get_logger(__name__)

_DIRECT_SUFFIXES = ("@s.whatsapp.net", "@lid")
# Not conversation content: they would surface as empty attachments.
_SKIPPED_TYPES = {"reactionMessage", "secretEncryptedMessage", "albumMessage", "protocolMessage"}


def history_item(record, runtime, value):
    """Project one stored provider record exactly like its live webhook."""
    key = value.get("key") if isinstance(value, dict) else None
    remote = key.get("remoteJid") if isinstance(key, dict) else None
    if not isinstance(remote, str) or not key.get("id") or value.get("messageType") in _SKIPPED_TYPES:
        return None
    payload = {"event": "messages.upsert", "instance": runtime, "data": value}
    if remote.endswith("@g.us"):
        try:
            policy = require_policy(record, group_id=remote)
            normalized = normalize_webhook(payload)
            if normalized.get("type") != "message":
                return None
            return {"type": "group", "event": projection(payload, normalized, record, policy)}
        except (ValueError, TypeError, AttributeError, KeyError):
            return None
    if remote.endswith(_DIRECT_SUFFIXES):
        from app.routers.webhooks import _to_bot_payload

        bot_payload = _to_bot_payload(normalize_webhook(payload))
        if not bot_payload:
            return None
        # Live payloads carry receive time; Core prefers the provider's own timestamp.
        return {"type": "direct", "payload": {**bot_payload, "messageTimestamp": value.get("messageTimestamp")}}
    return None  # newsletters, status broadcasts


async def history_page(body, request, *, registry=None, adapter=None, instagram_page=None):
    registry = registry or get_connection_registry()
    method = getattr(request.state, "auth_method", None)
    if method not in {"gateway_api_key", "instance_api_key"}:
        raise HTTPException(403, "Connection service authentication required")
    record = registry.connection_record_by_id(body.connectionRef) or registry.connection_record(body.connectionRef)
    kind = (record or {}).get("provider_id"), (record or {}).get("channel_id")
    if kind not in {("evolution", "whatsapp"), ("meta", "instagram")}:
        raise HTTPException(409, "History is available for Evolution WhatsApp and Instagram connections")
    runtime = record["legacy_name"]
    if method == "instance_api_key" and getattr(request.state, "auth_instance", None) != runtime:
        raise HTTPException(403, "Connection credential mismatch")
    if kind == ("meta", "instagram"):
        return await _instagram_page(body, record, instagram_page=instagram_page)
    binding = record.get("core_channel") or {}
    if binding and binding.get("channelId") != body.coreChannelId:
        raise HTTPException(409, "Connection is bound to another Core channel")
    adapter = adapter or get_evolution_adapter()
    try:
        result = await adapter.find_messages(runtime, page=body.page, page_size=body.pageSize)
        block = result.get("messages") if isinstance(result, dict) else None
        records = block.get("records") if isinstance(block, dict) else None
        if not isinstance(records, list):
            raise ValueError("invalid_history_page")
    except HTTPException:
        raise
    except Exception:
        logger.warning("history_page_unavailable", runtime=runtime, page=body.page)
        raise HTTPException(503, "Provider history is unavailable") from None
    items, timestamps = [], []
    for value in records:
        try:
            timestamps.append(int(value.get("messageTimestamp")))
        except (TypeError, ValueError, AttributeError):
            pass
        item = history_item(record, runtime, value)
        if item:
            items.append(item)
    return {
        "page": body.page,
        "pages": int(block.get("pages") or 0),
        "total": int(block.get("total") or 0),
        "records": len(records),
        "oldestTimestamp": min(timestamps) if timestamps else None,
        "items": items,
    }


async def _instagram_page(body, record, *, instagram_page=None):
    from app.services.connections import get_connection_service
    from app.services.instagram_history import instagram_history_page

    binding = get_connection_service().instagram_core_channel_binding(record["id"]) or {}
    if binding.get("channelId") != body.coreChannelId:
        raise HTTPException(409, "Connection is bound to another Core channel")
    try:
        return await (instagram_page or instagram_history_page)(record, body.cursor)
    except Exception:
        logger.warning("instagram_history_unavailable", connection_id=record["id"])
        raise HTTPException(503, "Instagram history is unavailable") from None
