"""Instagram conversation history for Core imports (Instagram Login Graph API).

Meta returns message details only for the 20 most recent messages of each
conversation, and no group chats: this is the whole available history.
"""
from datetime import datetime
from typing import Any

import httpx

from app.core.config import get_settings
from app.services.credential_manager import ProviderAccountReference, get_credential_manager

MESSAGE_FIELDS = "id,created_time,from,to,message,attachments"
_ATTACHMENT_KINDS = (("image_data", "image"), ("video_data", "video"), ("audio_data", "audio"), ("file_url", "document"))


def _epoch(value: Any) -> int | None:
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00").replace("+0000", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return None


def _attachments(message: dict[str, Any]) -> list[dict[str, Any]]:
    data = (message.get("attachments") or {}).get("data") if isinstance(message.get("attachments"), dict) else None
    result = []
    for item in data if isinstance(data, list) else []:
        for key, kind in _ATTACHMENT_KINDS:
            value = item.get(key) if isinstance(item, dict) else None
            url = value.get("url") if isinstance(value, dict) else value if isinstance(value, str) else None
            if url:
                result.append({"kind": kind, "url": url})
                break
    return result


def history_message(message: dict[str, Any], account_id: str) -> dict[str, Any] | None:
    sender = message.get("from") if isinstance(message.get("from"), dict) else {}
    recipients = ((message.get("to") or {}).get("data") or []) if isinstance(message.get("to"), dict) else []
    occurred = _epoch(message.get("created_time"))
    if not message.get("id") or not sender.get("id") or occurred is None:
        return None
    outbound = str(sender.get("id")) == account_id
    counterpart = next((item for item in recipients if isinstance(item, dict) and str(item.get("id")) != account_id), {}) if outbound else sender
    if not counterpart.get("id"):
        return None
    text = message.get("message") if isinstance(message.get("message"), str) and message.get("message") else None
    attachments = _attachments(message)
    if text is None and not attachments:
        return None  # reactions, unsupported shares and deleted messages carry no content
    return {
        "type": "instagram",
        "message": {
            "providerMessageId": str(message["id"]),
            "direction": "outbound" if outbound else "inbound",
            "externalContactId": str(counterpart["id"]),
            "contactName": counterpart.get("username") or None,
            "kind": "text" if text is not None else attachments[0]["kind"],
            "content": text,
            "attachments": attachments,
            "occurredAt": occurred,
        },
    }


async def instagram_history_page(record: dict[str, Any], cursor: str | None, *, credentials=None,
                                 client_factory=httpx.AsyncClient, page_size: int = 10) -> dict[str, Any]:
    account_id = str(((record.get("provider_account") or {}).get("providerAccountId")) or "")
    token = (credentials or get_credential_manager()).get_provider_access_token(ProviderAccountReference("meta", "instagram", account_id))
    if not account_id or not token:
        raise ValueError("instagram_credentials_unavailable")
    settings = get_settings()
    base = f"{settings.instagram_graph_api_url.rstrip('/')}/{settings.instagram_graph_api_version}"
    # Bearer header, never a query param: httpx errors and access logs would expose the token.
    headers = {"Authorization": f"Bearer {token}"}
    params = {"platform": "instagram", "limit": page_size, "fields": f"id,updated_time,messages{{{MESSAGE_FIELDS}}}"}
    if cursor:
        params["after"] = cursor
    async with client_factory(timeout=30) as client:
        response = await client.get(f"{base}/me/conversations", params=params, headers=headers)
        response.raise_for_status()
        payload = response.json()
        conversations = payload.get("data") if isinstance(payload.get("data"), list) else []
        items, scanned, updated = [], 0, []
        for conversation in conversations:
            stamp = _epoch(conversation.get("updated_time"))
            if stamp is not None:
                updated.append(stamp)
            messages = ((conversation.get("messages") or {}).get("data") or [])[:20]
            for message in messages:
                if isinstance(message, dict) and "created_time" not in message and message.get("id"):
                    # Older API versions return only ids from the edge; fetch the detail.
                    detail = await client.get(f"{base}/{message['id']}", params={"fields": MESSAGE_FIELDS}, headers=headers)
                    message = detail.json() if detail.status_code == 200 else {}
                scanned += 1
                item = history_message(message, account_id) if isinstance(message, dict) else None
                if item:
                    items.append(item)
    paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
    next_cursor = ((paging.get("cursors") or {}).get("after")) if paging.get("next") else None
    return {"records": scanned, "conversations": len(conversations), "pages": 0,
            "oldestTimestamp": min(updated) if updated else None, "nextCursor": next_cursor, "items": items}
