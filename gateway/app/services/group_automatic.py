"""Account discovery reuses the connection's existing Core webhook authorization."""

import asyncio
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import HTTPException

from app.adapters.evolution import get_evolution_adapter
from app.core.config import get_settings
from app.models.canonical_v2 import AutomaticRegistration, GroupPolicy, valid_group_id
from app.services.connection_registry import get_connection_registry
from app.services.core_channel_credentials import get_core_channel_credential_store
from app.services.instance_webhooks import build_auth_headers, list_instance_webhooks
from app.services.group_participants import participant_directory

_locks: dict[str, asyncio.Lock] = {}


def connected_identity(records, runtime):
    if not isinstance(records, list):
        raise ValueError("invalid_instance_directory")
    selected = []
    for item in records:
        if not isinstance(item, dict):
            continue
        nested = item.get("instance") if isinstance(item.get("instance"), dict) else item
        if (nested.get("name") or nested.get("instanceName")) == runtime:
            selected.append((item, nested))
    if len(selected) != 1:
        raise ValueError("account_not_uniquely_identified")
    outer, instance = selected[0]
    ids = []
    me = instance.get("me") if isinstance(instance.get("me"), dict) else {}
    for value in (instance.get("ownerJid"), instance.get("ownerLid"), outer.get("ownerJid"), outer.get("ownerLid"),
                  me.get("id"), me.get("lid")):
        if (isinstance(value, str) and value.count("@") == 1 and
                value.rsplit("@", 1)[-1] in {"s.whatsapp.net", "lid"} and
                len(value) <= 255 and not any(c.isspace() or ord(c) < 32 for c in value)):
            if value not in ids:
                ids.append(value)
    return ids


def linked_account_identities(identities, directory):
    # Accept aliases only when provider metadata explicitly links them to an
    # already verified self identity. Never derive a LID from a phone number.
    result = list(identities)
    for group in directory if isinstance(directory, list) else []:
        for member in group.get("participants", []) if isinstance(group, dict) else []:
            if not isinstance(member, dict):
                continue
            aliases = [member.get(key) for key in ("id", "phoneNumber", "lid")]
            if not any(value in identities for value in aliases if isinstance(value, str)):
                continue
            for value in aliases:
                if (isinstance(value, str) and value.count("@") == 1 and len(value) <= 255
                        and value.rsplit("@", 1)[-1] in {"s.whatsapp.net", "lid"}
                        and not any(c.isspace() or ord(c) < 32 for c in value) and value not in result):
                    result.append(value)
    return result


def group_directory(value):
    if not isinstance(value, list) or len(value) > 1000:
        raise ValueError("invalid_or_over_capacity_group_directory")
    result = {}
    for item in value:
        if not isinstance(item, dict) or not valid_group_id(str(item.get("id") or "")):
            raise ValueError("invalid_group_directory_entry")
        identifier = item["id"]
        name = item.get("subject") or item.get("name") or identifier
        if not isinstance(name, str):
            raise ValueError("invalid_group_name")
        result[identifier] = {"externalId": identifier, "displayName": name[:160] or identifier[:160]}
    return list(result.values())


async def automatic_binding(body, request, *, registry=None, adapter=None, client_factory=httpx.AsyncClient, credentials=None):
    registry = registry or get_connection_registry()
    method = getattr(request.state, "auth_method", None)
    if method not in {"gateway_api_key", "instance_api_key"}:
        raise HTTPException(403, "Connection service authentication required")
    record = registry.connection_record_by_id(body.connectionRef) or registry.connection_record(body.connectionRef)
    if not record or (record.get("provider_id"), record.get("channel_id")) != ("evolution", "whatsapp"):
        raise HTTPException(409, "Expected an Evolution WhatsApp connection")
    runtime, connection = record["legacy_name"], record["id"]
    if method == "instance_api_key" and getattr(request.state, "auth_instance", None) != runtime:
        raise HTTPException(403, "Connection credential mismatch")
    if not get_settings().enable_group_messages:
        raise HTTPException(409, "Automatic group transport is unavailable")
    # The caller cannot redirect a Core credential: use only the webhook already
    # configured for this exact account and require the known Core path.
    hooks = [h for h in list_instance_webhooks(runtime, reveal_secrets=True) if h.get("enabled")]
    if len(hooks) != 1:
        raise HTTPException(409, "Core webhook must be uniquely configured")
    hook = hooks[0]
    parsed = urlparse(hook.get("url") or "")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.path != "/api/v1/webhook/inbound" or parsed.query or parsed.fragment:
        raise HTTPException(409, "Expected a Core inbound webhook")
    headers = build_auth_headers(hook)
    authorization = headers.get("Authorization", "")
    if not authorization.startswith("Bearer ") or not authorization[7:].strip():
        raise HTTPException(409, "Core channel authentication is missing")
    lock = _locks.setdefault(connection, asyncio.Lock())
    async with lock:
        prior = record.get("core_channel") or {}
        if prior and (prior.get("channelId") != body.coreChannelId or
                      prior.get("inboundUrl") not in {None, hook["url"]}):
            raise HTTPException(409, "Connection is already bound to another Core channel")
        adapter = adapter or get_evolution_adapter()
        try:
            identities = connected_identity(await adapter.list_instances(), runtime)
            raw_groups = await adapter.group_directory(runtime)
            groups = group_directory(raw_groups)
            identities = linked_account_identities(identities, raw_groups)
            participants = participant_directory(raw_groups)
            registration = AutomaticRegistration(connectionRef=connection, coreChannelId=body.coreChannelId,
                gatewayClientId=record["client_id"], providerAccountRef=runtime,
                botExternalIds=identities, groups=groups)
            callback = urlunparse((parsed.scheme, parsed.netloc, "/api/v1/webhook/group-transport", "", "", ""))
            async with client_factory(timeout=12, follow_redirects=False) as client:
                response = await client.post(callback, json=registration.model_dump(), headers=headers)
            if response.status_code >= 300:
                raise ValueError("core_registration_failed")
            result = response.json()
            policy = GroupPolicy.model_validate(result["policy"])
            if (policy.connectionRef != connection or policy.coreChannelId != body.coreChannelId or
                    policy.admission != "account" or not policy.enabled):
                raise ValueError("mismatched_account_registration")
            current = registry.connection_record_by_id(connection)
            if not current or current.get("legacy_name") != runtime or current.get("client_id") != record["client_id"]:
                raise ValueError("connection_changed")
            current_hooks = [h for h in list_instance_webhooks(runtime, reveal_secrets=True) if h.get("enabled")]
            if len(current_hooks) != 1 or current_hooks[0].get("url") != hook["url"] or build_auth_headers(current_hooks[0]) != headers:
                raise ValueError("webhook_changed")
            store = credentials or get_core_channel_credential_store()
            reference = store.upsert(connection_id=connection, core_channel_id=body.coreChannelId,
                                     channel_api_key=authorization[7:].strip())
            binding = {"channelId": body.coreChannelId, "bindingId": policy.bindingId,
                "credentialRef": reference, "inboundUrl": hook["url"], "groupTransport": policy.model_dump(),
                "groupDirectory": groups, "participantPhones": participants}
            if registry.update_connection_record(connection, {"core_channel": binding}) is None:
                raise ValueError("connection_deleted")
        except (asyncio.CancelledError, HTTPException):
            raise
        except Exception:
            raise HTTPException(503, "Account discovery or Core registration could not be confirmed") from None
    return {"connectionRef": connection, "coreChannelId": body.coreChannelId,
            "bindingId": policy.bindingId, "revision": result["revision"], "groups": len(groups)}
