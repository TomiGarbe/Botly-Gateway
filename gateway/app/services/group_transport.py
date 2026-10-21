"""Core-authorized group transport. No contacts or AI invocation heuristics."""
import hashlib
import json
from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.canonical_v2 import CanonicalInboundV2, GroupPolicy, valid_group_id
from app.services.connection_registry import get_connection_registry

logger = get_logger(__name__)


def require_policy(record, *, group_id=None, policy=None):
    binding = (record or {}).get('core_channel') or {}
    value = policy if policy is not None else binding.get('groupTransport')
    parsed = GroupPolicy.model_validate(value)
    if (record.get('provider_id'), record.get('channel_id')) != ('evolution', 'whatsapp'):
        raise ValueError('Unsupported group provider/channel')
    if (parsed.connectionRef != record.get('id') or parsed.coreChannelId != binding.get('channelId')
            or parsed.bindingId != binding.get('bindingId') or not parsed.bindingId):
        raise ValueError('Group binding mismatch')
    if policy is None and (not get_settings().enable_group_messages or not parsed.enabled):
        raise ValueError('Group transport disabled')
    if policy is None and parsed.admission == 'account':
        from app.services.instance_webhooks import list_instance_webhooks
        hooks = [h for h in list_instance_webhooks(record['legacy_name']) if h.get('enabled')]
        if len(hooks) != 1 or hooks[0].get('url') != binding.get('inboundUrl'):
            raise ValueError('Account webhook changed')
    if group_id is not None and (not valid_group_id(group_id) or group_id in parsed.excludedGroups
                                 or (parsed.admission == 'explicit' and group_id not in parsed.authorizedGroups)):
        raise ValueError('Group not authorized')
    return parsed


def projection(payload, normalized, record, policy):
    data = payload.get('data') or {}
    key = data.get('key') or {}
    context = normalized.get('context') or {}
    info = context.get('contextInfo')
    quote = context.get('quoted')
    group_id = key.get('remoteJid')
    names = {item['externalId']: item['displayName'] for item in
             (record.get('core_channel') or {}).get('groupDirectory', [])}
    # Missing author is unknown, never the group or its digits.
    author = {'externalId': key.get('participant') or None, 'displayName': data.get('pushName') or None}
    timestamp = data.get('messageTimestamp')
    try:
        timestamp = int(timestamp) * 1000 if timestamp is not None else None
    except (TypeError, ValueError):
        timestamp = None
    message_id = key.get('id')
    scope = [record['id'], policy.bindingId, group_id, message_id, key.get('fromMe'), 'message']
    event = {
        'contractVersion': 'canonical-v2',
        'eventId': 'wa2_' + hashlib.sha256(json.dumps(scope, separators=(',', ':')).encode()).hexdigest(),
        'eventType': 'message', 'occurredAt': timestamp,
        'transport': {'provider': 'evolution', 'channelType': 'whatsapp',
                      'providerAccountRef': record['legacy_name'], 'connectionRef': record['id'],
                      'coreChannelId': policy.coreChannelId, 'bindingId': policy.bindingId},
        'chat': {'type': 'group', 'externalId': group_id, 'displayName': names.get(group_id)},
        'author': author, 'botAccount': policy.botAccount.model_dump(),
        'message': {'providerMessageId': message_id, 'kind': normalized.get('subtype') or 'unknown',
                    'text': normalized.get('text'), 'fromMe': key.get('fromMe'),
                    'mentions': [{'externalId': item, 'displayName': None} for item in info.get('mentionedJid', [])]
                                if isinstance(info, dict) and isinstance(info.get('mentionedJid', []), list) else None,
                    'quoted': {'providerMessageId': info.get('stanzaId'),
                               'author': {'externalId': info.get('participant'), 'displayName': None},
                               'chatExternalId': info.get('remoteJid')} if quote else None},
    }
    return CanonicalInboundV2.model_validate(event).model_dump()


def ingest_group(payload, normalized):
    from app.services.core_inbound_dispatcher import get_core_inbound_dispatcher
    record = get_connection_registry().connection_record(str(payload.get('instance') or ''))
    group_id = ((payload.get('data') or {}).get('key') or {}).get('remoteJid')
    try:
        policy = require_policy(record, group_id=group_id)
    except (ValueError, TypeError, AttributeError):
        return 'ignored_group'
    provider_event = str(payload.get('event') or '').upper().replace('.', '_').replace('-', '_')
    if provider_event == 'MESSAGES_UPDATE':
        return 'group_receipt_unsupported'
    if provider_event in {'GROUP_PARTICIPANTS_UPDATE', 'GROUPS_UPSERT', 'GROUPS_UPDATE'}:
        return 'group_membership_unsupported'
    # Receipt/membership shapes are not verified; do not manufacture messages.
    if normalized.get('type') != 'message' or provider_event != 'MESSAGES_UPSERT':
        return 'group_unsupported_event'
    try:
        event = projection(payload, normalized, record, policy)
    except (ValueError, TypeError):
        return 'group_invalid_event'
    dispatcher = get_core_inbound_dispatcher()
    delivery, created = dispatcher.persist(event)  # durable before provider acknowledgment
    logger.info("group_transport_event_persisted", delivery_id=delivery["id"],
                event_id=delivery["eventId"], connection_id=record["id"], created=created)
    return 'group_queued'
