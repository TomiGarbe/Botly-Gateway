"""Read-only operator view of a connection's WhatsApp group transport."""

from typing import Any


def _ms(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def group_overview(record: dict[str, Any], deliveries: list[dict[str, Any]], *, directory_loaded: bool) -> dict[str, Any]:
    binding = record.get("core_channel") or {}
    policy = binding.get("groupTransport") or {}
    excluded = set(policy.get("excludedGroups") or [])
    authorized = set(policy.get("authorizedGroups") or [])
    participants = binding.get("participantPhones") or {}
    groups: dict[str, dict[str, Any]] = {}
    for item in binding.get("groupDirectory") or []:
        external_id = item.get("externalId")
        if external_id:
            groups[external_id] = {"externalId": external_id, "displayName": item.get("displayName") or external_id}

    for delivery in deliveries:
        event = delivery.get("canonicalEvent") or {}
        chat = event.get("chat") or {}
        external_id = chat.get("externalId")
        if chat.get("type") != "group" or not external_id:
            continue
        group = groups.setdefault(external_id, {"externalId": external_id, "displayName": chat.get("displayName") or external_id})
        status = delivery.get("status")
        group["delivered"] = group.get("delivered", 0) + (status == "delivered")
        group["failed"] = group.get("failed", 0) + (status in {"failed", "dead_letter", "retry"})
        created = _ms(delivery.get("createdAt"))
        if created >= _ms(group.get("lastEventAt")):
            group["lastEventAt"] = created
            group["lastEventStatus"] = status
            group["lastError"] = delivery.get("lastError") if status != "delivered" else None

    admission = policy.get("admission") or "explicit"
    items = []
    for external_id, group in groups.items():
        if external_id in excluded:
            state = "excluded"
        elif admission == "account" or external_id in authorized:
            state = "captured"
        else:
            state = "not_authorized"
        items.append({
            **group,
            "state": state,
            "participants": len(participants.get(external_id) or {}),
            "delivered": group.get("delivered", 0),
            "failed": group.get("failed", 0),
            "lastEventAt": group.get("lastEventAt"),
            "lastEventStatus": group.get("lastEventStatus"),
            "lastError": group.get("lastError"),
        })
    items.sort(key=lambda item: (-_ms(item["lastEventAt"]), item["displayName"].lower()))
    return {
        "configured": bool(policy),
        "enabled": bool(policy.get("enabled")),
        "admission": admission,
        "coreChannelId": binding.get("channelId"),
        "botIdentities": binding.get("accountIdentities") or ([policy["botAccount"]["externalId"]] if (policy.get("botAccount") or {}).get("externalId") else []),
        "directoryLoaded": directory_loaded or bool(binding.get("groupDirectory")),
        "groups": items,
    }
