from __future__ import annotations

import asyncio
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.models.canonical_v2 import CanonicalInboundV2, CanonicalOutboundV2, GroupPolicy, GroupBindingRequest, GroupReplayRequest, OutboundAccepted
from app.services import group_transport as groups
from app.services.connection_registry import ConnectionRegistry
from app.services.core_inbound_dispatcher import CoreInboundDeliveryStore, CoreInboundDispatcher
from app.services.normalization import normalize_webhook
from app.services.event_pipeline import process_incoming_webhook
from app.services.canonical_outbound import CanonicalOutboundService, CanonicalOutboundError
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore

ROOT = Path(__file__).parents[2] / 'docs' / 'contracts' / 'canonical-v2'


def provider_payload(author='author-a@lid', group='synthetic-team@g.us', own=False):
    return {'event': 'messages.upsert', 'instance': 'synthetic-instance', 'data': {
        'key': {'id': 'synthetic-message', 'remoteJid': group, 'participant': author, 'fromMe': own},
        'pushName': 'Synthetic author', 'messageTimestamp': 1790000000,
        'message': {'extendedTextMessage': {'text': 'Botly example', 'contextInfo': {
            'mentionedJid': ['bot@lid'], 'stanzaId': 'synthetic-quote', 'participant': 'bot@lid',
            'quotedMessage': {'extendedTextMessage': {'text': 'old text', 'contextInfo': {'mentionedJid': ['quoted-only@lid']}}}}}}}}


@pytest.fixture
def harness(tmp_path, monkeypatch):
    from app.services import core_inbound_dispatcher as inbound
    registry = ConnectionRegistry(tmp_path / 'registry.json')
    channel_id = str(uuid4())
    policy = GroupPolicy(connectionRef='conn-a', coreChannelId=channel_id, bindingId='binding-a',
                         contractVersion='canonical-v2', enabled=True,
                         evolutionApiProfile='evolution-v2-sendText',
                         authorizedGroups=['synthetic-team@g.us', 'synthetic-other@g.us'],
                         botAccount={'externalId': 'bot@lid', 'displayName': None})
    record = {'id': 'conn-a', 'client_id': 'client-a', 'legacy_name': 'synthetic-instance',
              'provider_id': 'evolution', 'channel_id': 'whatsapp',
              'core_channel': {'channelId': channel_id, 'bindingId': 'binding-a', 'groupTransport': policy.model_dump()}}
    registry.save_connection_record('synthetic-instance', record)
    monkeypatch.setattr(groups, 'get_connection_registry', lambda: registry)
    monkeypatch.setattr('app.services.connection_registry.get_connection_registry', lambda: registry)
    monkeypatch.setattr(groups.get_settings(), 'enable_group_messages', True)
    store = CoreInboundDeliveryStore(tmp_path / 'outbox.json')
    credentials = SimpleNamespace(get_api_key=lambda **kwargs: 'synthetic-channel-credential')
    settings = SimpleNamespace(core_inbound_url='https://core.invalid/inbound', bot_webhook_timeout=1,
                               core_inbound_delivery_max_attempts=3, core_inbound_delivery_backoff_base_seconds=0)
    dispatcher = CoreInboundDispatcher(store=store, credentials=credentials, settings_factory=lambda: settings)
    monkeypatch.setattr(inbound, 'get_core_inbound_dispatcher', lambda: dispatcher)
    return registry, record, policy, store, dispatcher


def test_authors_groups_connections_and_current_mentions(harness):
    registry, record, policy, store, dispatcher = harness
    events = []
    for author, group in [('author-a@lid', 'synthetic-team@g.us'), ('author-b@lid', 'synthetic-team@g.us'),
                          ('author-a@lid', 'synthetic-other@g.us')]:
        payload = provider_payload(author, group)
        payload['data']['key']['id'] += author
        assert groups.ingest_group(payload, normalize_webhook(payload)) == 'group_queued'
        events.append(store.list()[-1]['canonicalEvent'])
    assert events[0]['author']['externalId'] != events[1]['author']['externalId']
    assert events[0]['chat'] == events[1]['chat']
    assert events[0]['chat'] != events[2]['chat']
    assert events[0]['message']['mentions'] == [{'externalId': 'bot@lid', 'displayName': None}]
    assert events[0]['message']['quoted']['author']['externalId'] == 'bot@lid'
    assert len({e['eventId'] for e in events}) == 3
    # Same provider message ID and group on another authenticated connection is distinct.
    other = deepcopy(record)
    other.update(id='conn-b', legacy_name='second-instance')
    other['core_channel']['bindingId'] = 'binding-b'
    other['core_channel']['groupTransport'].update(connectionRef='conn-b', bindingId='binding-b')
    registry.save_connection_record('second-instance', other)
    payload = provider_payload()
    payload['instance'] = 'second-instance'
    assert groups.ingest_group(payload, normalize_webhook(payload)) == 'group_queued'
    assert len(store.list()) == 4


def test_quote_mentions_do_not_invoke_and_unknown_author_not_group(harness):
    registry, record, policy, store, dispatcher = harness
    payload = provider_payload(None)
    info = payload['data']['message']['extendedTextMessage']['contextInfo']
    info['mentionedJid'] = []
    info['participant'] = 'unknown-quoted-author@lid'
    assert groups.ingest_group(payload, normalize_webhook(payload)) == 'group_queued'
    event = store.list()[0]['canonicalEvent']
    assert event['message']['mentions'] == []
    assert event['author']['externalId'] is None
    assert 'invoked' not in event  # text "Botly" is never a transport invocation decision


def test_duplicates_retry_restart_and_replay_preserve_entire_event(harness):
    registry, record, policy, store, dispatcher = harness
    payload = provider_payload(own=True)
    assert process_incoming_webhook(payload, 'request-1')['status'] == 'group_queued'
    assert process_incoming_webhook(payload, 'request-2')['status'] == 'group_queued'
    assert len(store.list()) == 1
    original = deepcopy(store.list()[0]['canonicalEvent'])
    assert original['message']['fromMe'] is True
    sent = []
    def receive(request):
        sent.append(json.loads(request.content))
        assert request.headers['X-Botly-Contract-Version'] == 'canonical-v2'
        return httpx.Response(503 if len(sent) == 1 else 200)
    dispatcher._client_factory = lambda timeout: httpx.AsyncClient(transport=httpx.MockTransport(receive))
    async def deliver():
        await dispatcher._deliver(store.claim_due(limit=1, lease_seconds=5)[0], dispatcher._settings_factory())
        # Simulate restart by reopening durable outbox, then retry.
        restarted = CoreInboundDeliveryStore(store._path)
        await dispatcher._deliver(restarted.claim_due(limit=1, lease_seconds=5)[0], dispatcher._settings_factory())
    asyncio.run(deliver())
    assert sent == [original, original]
    assert store.list()[0]['status'] == 'delivered'
    assert groups.ingest_group(payload, normalize_webhook(payload)) == 'group_queued'
    assert len(store.list()) == 1


@pytest.mark.parametrize('change', ['disabled', 'group', 'channel', 'connection', 'binding', 'global'])
def test_denied_groups_never_reach_legacy(harness, monkeypatch, change):
    registry, record, policy, store, dispatcher = harness
    if change == 'global':
        monkeypatch.setattr(groups.get_settings(), 'enable_group_messages', False)
    elif change == 'disabled':
        record['core_channel']['groupTransport']['enabled'] = False
    elif change == 'group':
        record['core_channel']['groupTransport']['authorizedGroups'] = []
    elif change == 'channel':
        record['channel_id'] = 'instagram'
    else:
        record['core_channel']['groupTransport'][{'connection': 'connectionRef', 'binding': 'bindingId'}[change]] = 'wrong'
    registry.save_connection_record('synthetic-instance', record)
    assert process_incoming_webhook(provider_payload(), 'req')['status'] == 'ignored_group'
    assert store.list() == []


def test_revocation_blocks_queued_delivery(harness):
    registry, record, policy, store, dispatcher = harness
    groups.ingest_group(provider_payload(), normalize_webhook(provider_payload()))
    record['core_channel']['groupTransport']['authorizedGroups'] = []
    registry.save_connection_record('synthetic-instance', record)
    asyncio.run(dispatcher._deliver(store.claim_due(limit=1, lease_seconds=5)[0], dispatcher._settings_factory()))
    assert store.list()[0]['lastError'] == 'group_authorization_revoked_or_binding_changed'


def outbound_body(policy):
    return {'contractVersion': 'canonical-v2', 'connectionRef': policy.connectionRef, 'bindingId': policy.bindingId,
            'channel': {'id': policy.coreChannelId, 'type': 'whatsapp', 'provider': 'evolution'},
            'recipient': {'type': 'group', 'externalId': 'synthetic-team@g.us'},
            'replyTo': {'providerMessageId': 'synthetic-message', 'chatExternalId': 'synthetic-team@g.us',
                        'authorExternalId': 'author-a@lid', 'text': 'Botly example', 'fromMe': False},
            'message': {'kind': 'text', 'content': 'Synthetic group reply'}, 'idempotencyKey': 'synthetic-outbound'}


def test_outbound_http_adapter_exact_jid_and_idempotency(harness, tmp_path):
    from app.adapters.evolution.adapter import EvolutionAdapter
    from app.adapters.evolution.client import EvolutionClient
    registry, record, policy, store, dispatcher = harness
    requests = []
    def receive(request):
        requests.append(json.loads(request.content))
        assert request.url.path == '/message/sendText/synthetic-instance'
        return httpx.Response(200, json={'key': {'id': 'synthetic-provider-outbound'}})
    async def deliver():
        client = EvolutionClient()
        client._client = httpx.AsyncClient(base_url='https://evolution.invalid', transport=httpx.MockTransport(receive))
        adapter = EvolutionAdapter(client)
        service = CanonicalOutboundService(registry=registry, connection_manager=adapter,
                                           attempt_store=OutboundProviderAttemptStore(tmp_path / 'attempts.json'))
        message = CanonicalOutboundV2.model_validate(outbound_body(policy))
        first = await service.deliver(message=message, authenticated_instance='synthetic-instance')
        second = await service.deliver(message=message, authenticated_instance='synthetic-instance')
        assert first['providerMessageId'] == second['providerMessageId']
        await client.close()
    asyncio.run(deliver())
    assert requests == [{'number': 'synthetic-team@g.us', 'text': 'Synthetic group reply',
                         'quoted': {'key': {'remoteJid': 'synthetic-team@g.us', 'id': 'synthetic-message',
                                             'participant': 'author-a@lid', 'fromMe': False},
                                    'message': {'conversation': 'Botly example'}}}]


@pytest.mark.parametrize('field,value', [('bindingId', 'wrong'), ('connectionRef', 'wrong')])
def test_outbound_binding_mismatch(harness, field, value):
    registry, record, policy, store, dispatcher = harness
    body = outbound_body(policy)
    body[field] = value
    with pytest.raises(CanonicalOutboundError):
        asyncio.run(CanonicalOutboundService(registry=registry).deliver(
            message=CanonicalOutboundV2.model_validate(body), authenticated_instance='synthetic-instance'))


def test_schema_fixtures():
    from jsonschema import Draft202012Validator
    for name, model in [('inbound', CanonicalInboundV2), ('outbound', CanonicalOutboundV2), ('policy', GroupPolicy), ('binding', GroupBindingRequest), ('replay', GroupReplayRequest), ('accepted', OutboundAccepted)]:
        schema = json.loads((ROOT / f'{name}.schema.json').read_text())
        assert schema == model.model_json_schema(by_alias=True)
        for fixture in (ROOT / 'fixtures').glob(f'{name}-*.json'):
            value = json.loads(fixture.read_text())
            Draft202012Validator(schema).validate(value)
            model.model_validate(value)


def test_policy_authentication(harness, monkeypatch):
    from app.routers import group_transport as routes
    registry, record, policy, store, dispatcher = harness
    monkeypatch.setattr(routes, 'get_connection_registry', lambda: registry)
    monkeypatch.setattr(routes.get_settings(), 'gateway_control_plane_api_key', 'synthetic-service-key')
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    assert client.put('/v2/group-transport/policy', json=policy.model_dump()).status_code == 403
    assert client.put('/v2/group-transport/policy', json=policy.model_dump(),
                      headers={'Authorization': 'Bearer synthetic-service-key'}).status_code == 200
    bad = policy.model_dump()
    bad['coreChannelId'] = 'wrong'
    assert client.put('/v2/group-transport/policy', json=bad,
                      headers={'Authorization': 'Bearer synthetic-service-key'}).status_code == 409


def test_receipts_and_membership_not_customer_messages(harness):
    registry, record, policy, store, dispatcher = harness
    for event, expected in [('messages.update', 'group_receipt_unsupported'), ('group-participants.update', 'group_membership_unsupported')]:
        payload = provider_payload()
        payload['event'] = event
        assert process_incoming_webhook(payload, 'req')['status'] == expected
    assert store.list() == []


def test_explicit_replay_preserves_identity_and_scope(harness):
    registry, record, policy, store, dispatcher = harness
    payload = provider_payload()
    groups.ingest_group(payload, normalize_webhook(payload))
    delivery = store.list()[0]
    store.fail_permanently(delivery['id'], error='synthetic_failure')
    with pytest.raises(ValueError):
        store.replay_group(delivery['id'], connection_id='wrong', core_channel_id=policy.coreChannelId, binding_id=policy.bindingId)
    result = store.replay_group(delivery['id'], connection_id=policy.connectionRef,
                                core_channel_id=policy.coreChannelId, binding_id=policy.bindingId)
    assert result['eventId'] == delivery['eventId']
    assert store.get(delivery['id'])['canonicalEvent'] == delivery['canonicalEvent']
    assert len(store.list()) == 1


@pytest.mark.parametrize('case', ['group-as-direct', 'unauthorized', 'channel', 'provider', 'media', 'lid'])
def test_outbound_invalid_combinations(harness, case):
    registry, record, policy, store, dispatcher = harness
    body = outbound_body(policy)
    if case == 'group-as-direct':
        body['recipient']['type'] = 'direct'
    elif case == 'unauthorized':
        body['recipient']['externalId'] = 'unauthorized@g.us'
    elif case == 'channel':
        body['channel']['id'] = str(uuid4())
    elif case == 'provider':
        body['channel']['provider'] = 'meta'
    elif case == 'media':
        body['message']['kind'] = 'image'
    else:
        body['recipient'] = {'type': 'direct', 'externalId': 'opaque-author@lid'}
    body.pop('replyTo')
    with pytest.raises(CanonicalOutboundError):
        asyncio.run(CanonicalOutboundService(registry=registry).deliver(
            message=CanonicalOutboundV2.model_validate(body), authenticated_instance='synthetic-instance'))


def test_v1_and_legacy_reject_group_before_number_conversion(harness):
    from pydantic import ValidationError
    from app.models.canonical_outbound import CanonicalOutboundMessage
    from app.models.requests import SendMessageRequest, SendTextRequest, ConnectionQuickMessageRequest
    registry, record, policy, store, dispatcher = harness
    body = outbound_body(policy)
    for field in ['contractVersion', 'connectionRef', 'bindingId', 'replyTo']:
        del body[field]
    del body['recipient']['type']
    with pytest.raises(CanonicalOutboundError):
        asyncio.run(CanonicalOutboundService(registry=registry).deliver(
            message=CanonicalOutboundMessage.model_validate(body), authenticated_instance='synthetic-instance'))
    for model, value in [(SendMessageRequest, {'number': 'synthetic@g.us', 'type': 'text', 'text': 'example'}),
                         (SendTextRequest, {'number': 'synthetic@g.us', 'text': 'example'}),
                         (ConnectionQuickMessageRequest, {'recipient': 'synthetic@g.us', 'text': 'example'})]:
        with pytest.raises(ValidationError):
            model.model_validate(value)


def test_published_provider_fixtures_project_exactly():
    for fixture in (ROOT / 'fixtures').glob('provider-*.json'):
        payload = json.loads(fixture.read_text())
        expected = json.loads((ROOT / 'fixtures' / fixture.name.replace('provider-', 'inbound-')).read_text())
        policy = GroupPolicy.model_validate(json.loads((ROOT / 'fixtures' / 'policy-disabled.json').read_text()))
        record = {'id': policy.connectionRef, 'legacy_name': 'synthetic-instance'}
        assert groups.projection(payload, normalize_webhook(payload), record, policy) == expected


def test_missing_timestamp_and_identity_are_unknown(harness):
    registry, record, policy, store, dispatcher = harness
    payload = provider_payload(None)
    del payload['data']['messageTimestamp']
    del payload['data']['key']['fromMe']
    event = groups.projection(payload, normalize_webhook(payload), record, policy)
    assert event['occurredAt'] is None
    assert event['message']['fromMe'] is None
    assert event['author']['externalId'] is None


def test_failed_persistence_is_not_acknowledged(harness, monkeypatch):
    from app.services.core_inbound_dispatcher import CoreInboundPersistenceError
    registry, record, policy, store, dispatcher = harness
    def fail(data):
        raise OSError('synthetic disk failure')
    monkeypatch.setattr(store, '_write_unlocked', fail)
    with pytest.raises(CoreInboundPersistenceError):
        process_incoming_webhook(provider_payload(), 'req')
    assert store.list() == []


def test_evolution_http_ingress_never_fans_out_legacy(harness, monkeypatch):
    from app.routers import webhooks
    registry, record, policy, store, dispatcher = harness
    async def authenticated(payload, key):
        return {'accepted': True, 'mode': 'synthetic-test'}
    async def forbidden_fanout(*args, **kwargs):
        pytest.fail('Group reached legacy webhook fanout')
    monkeypatch.setattr(webhooks, '_connection_registry', registry)
    monkeypatch.setattr(webhooks, 'validate_evolution_auth', authenticated)
    monkeypatch.setattr(webhooks, '_forward_to_instance_webhooks', forbidden_fanout)
    monkeypatch.setattr(webhooks, 'save_pipeline_event', lambda **kwargs: None)
    app = FastAPI()
    app.include_router(webhooks.router)
    client = TestClient(app, raise_server_exceptions=False)
    payload = provider_payload()
    assert client.post('/webhooks/evolution', json=payload).json() == {'status': 'group_queued'}
    assert client.post('/webhooks/evolution', json=payload).json() == {'status': 'group_queued'}
    assert len(store.list()) == 1
    payload['instance'] = 'wrong-instance'
    assert client.post('/webhooks/evolution', json=payload).status_code == 404
    payload['instance'] = 'synthetic-instance'
    payload['data']['key']['id'] = 'second-message'
    def disk_failure(data):
        raise OSError('synthetic disk failure')
    monkeypatch.setattr(store, '_write_unlocked', disk_failure)
    assert client.post('/webhooks/evolution', json=payload).status_code == 500
    async def unauthenticated(payload, key):
        return {'accepted': False, 'mode': 'rejected'}
    monkeypatch.setattr(webhooks, 'validate_evolution_auth', unauthenticated)
    monkeypatch.setattr(webhooks.settings, 'allow_insecure_evolution_webhooks', True)
    assert client.post('/webhooks/evolution', json=payload).status_code == 403


def test_whatsapp_binding_uses_authenticated_core_and_disables_groups(harness, monkeypatch, tmp_path):
    from app.routers import group_transport as routes
    from app.services.core_control_plane import CoreControlPlaneClient
    from app.services.core_channel_credentials import CoreChannelCredentialStore
    registry, record, policy, store, dispatcher = harness
    calls = []
    def receive(request):
        calls.append(json.loads(request.content))
        assert request.headers['Authorization'] == 'Bearer synthetic-control-secret'
        assert request.headers['X-Botly-Gateway-Client-Id'] == record['client_id']
        return httpx.Response(200, json={
            'binding': {'id': 'new-binding'}, 'dispatch_credential': 'synthetic-dispatch-secret',
            'channel': {'id': policy.coreChannelId, 'name': 'Synthetic channel', 'channel_type': 'whatsapp', 'status': 'active'}})
    settings = SimpleNamespace(core_control_plane_url='https://core.invalid/control-plane',
                               gateway_control_plane_api_key='synthetic-control-secret')
    core = CoreControlPlaneClient(settings_factory=lambda: settings,
        client=httpx.AsyncClient(base_url='https://core.invalid/control-plane/', transport=httpx.MockTransport(receive)))
    credentials = CoreChannelCredentialStore(tmp_path / 'encrypted.json')
    monkeypatch.setattr(routes, 'get_connection_registry', lambda: registry)
    monkeypatch.setattr('app.services.core_control_plane.get_core_control_plane_client', lambda: core)
    monkeypatch.setattr('app.services.core_channel_credentials.get_core_channel_credential_store', lambda: credentials)
    monkeypatch.setattr(routes.get_settings(), 'gateway_control_plane_api_key', 'synthetic-control-secret')
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    response = client.post('/v2/group-transport/binding', json={
        'connectionRef': record['id'], 'coreChannelId': policy.coreChannelId},
        headers={'Authorization': 'Bearer synthetic-control-secret'})
    assert response.status_code == 200
    assert response.json()['bindingId'] == 'new-binding'
    assert 'secret' not in response.text
    assert 'groupTransport' not in registry.connection_record('synthetic-instance')['core_channel']
    assert credentials.get_api_key(connection_id=record['id'], core_channel_id=policy.coreChannelId) == 'synthetic-dispatch-secret'
    assert 'synthetic-dispatch-secret' not in (tmp_path / 'encrypted.json').read_text()
    assert calls == [{'gateway_connection_id': record['id'], 'core_channel_id': policy.coreChannelId, 'channel_type': 'whatsapp'}]
    asyncio.run(core._client.aclose())


@pytest.mark.parametrize('corrupt', ['{', '{}', '{"deliveries":[null]}'])
def test_corrupt_outbox_never_replaces_history(harness, corrupt):
    from app.services.core_inbound_dispatcher import CoreInboundPersistenceError
    registry, record, policy, store, dispatcher = harness
    store._path.write_text(corrupt)
    with pytest.raises(CoreInboundPersistenceError):
        process_incoming_webhook(provider_payload(), 'req')
    assert store._path.read_text() == corrupt


def test_group_reply_requires_quote_and_rejects_cross_group(harness):
    from pydantic import ValidationError
    registry, record, policy, store, dispatcher = harness
    body = outbound_body(policy)
    body['replyTo']['chatExternalId'] = 'other@g.us'
    with pytest.raises(ValidationError):
        CanonicalOutboundV2.model_validate(body)
    body.pop('replyTo')
    with pytest.raises(CanonicalOutboundError) as error:
        asyncio.run(CanonicalOutboundService(registry=registry).deliver(
            message=CanonicalOutboundV2.model_validate(body), authenticated_instance='synthetic-instance'))
    assert error.value.code == 'group_quote_required'


def test_account_admission_discovers_new_group_but_blocks_excluded_and_changed_hook(harness, monkeypatch):
    registry, record, policy, store, dispatcher = harness
    record['core_channel']['inboundUrl'] = 'https://dev.invalid/api/v1/webhook/inbound'
    record['core_channel']['groupTransport'].update(admission='account', authorizedGroups=[], excludedGroups=['blocked@g.us'])
    hooks = [{'enabled': True, 'url': record['core_channel']['inboundUrl']}]
    monkeypatch.setattr('app.services.instance_webhooks.list_instance_webhooks', lambda *a, **kw: hooks)
    registry.save_connection_record(record['legacy_name'], record)
    payload = provider_payload(group='new-group@g.us')
    assert groups.ingest_group(payload, normalize_webhook(payload)) == 'group_queued'
    payload = provider_payload(group='blocked@g.us')
    assert groups.ingest_group(payload, normalize_webhook(payload)) == 'ignored_group'
    hooks[0]['url'] = 'https://production.invalid/api/v1/webhook/inbound'
    payload = provider_payload(group='new-group@g.us')
    assert groups.ingest_group(payload, normalize_webhook(payload)) == 'ignored_group'


def test_automatic_binding_uses_only_existing_account_webhook_and_service_credentials(harness, monkeypatch, tmp_path):
    from app.services import group_automatic as automatic
    from app.models.canonical_v2 import AutomaticRequest
    from app.services.core_channel_credentials import CoreChannelCredentialStore
    registry, record, policy, store, dispatcher = harness
    record.pop('core_channel')
    registry.save_connection_record(record['legacy_name'], record)
    hook = {'enabled': True, 'url': 'https://dev.invalid/api/v1/webhook/inbound'}
    monkeypatch.setattr(automatic, 'list_instance_webhooks', lambda *a, **kw: [hook])
    monkeypatch.setattr(automatic, 'build_auth_headers', lambda h: {'Authorization': 'Bearer synthetic-channel-credential'})
    calls = []
    async def instances():
        return [{'name': 'synthetic-instance', 'ownerJid': 'bot@s.whatsapp.net', 'ownerLid': 'bot@lid'}]
    async def directory(runtime):
        assert runtime == 'synthetic-instance'
        return [{'id': 'automatic@g.us', 'subject': 'Equipo automático'}]
    def receive(request):
        calls.append(json.loads(request.content))
        assert str(request.url) == 'https://dev.invalid/api/v1/webhook/group-transport'
        assert request.headers['Authorization'] == 'Bearer synthetic-channel-credential'
        result = policy.model_dump()
        result.update(admission='account', authorizedGroups=[])
        return httpx.Response(200, json={'policy': result, 'revision': 2})
    client_factory = lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(receive))
    credentials = CoreChannelCredentialStore(tmp_path / 'automatic-credentials.json')
    body = AutomaticRequest(coreChannelId=policy.coreChannelId, connectionRef=policy.connectionRef)
    kwargs = dict(registry=registry, adapter=SimpleNamespace(list_instances=instances, group_directory=directory),
                  client_factory=client_factory, credentials=credentials)
    request = SimpleNamespace(state=SimpleNamespace(auth_method='instance_api_key', auth_instance='synthetic-instance'))
    result = asyncio.run(automatic.automatic_binding(body, request, **kwargs))
    assert result['groups'] == 1
    assert calls[0]['botExternalIds'] == ['bot@s.whatsapp.net', 'bot@lid']
    binding = registry.connection_record_by_id('conn-a')['core_channel']
    assert binding['inboundUrl'] == hook['url']
    assert binding['groupDirectory'][0]['displayName'] == 'Equipo automático'
    request.state.auth_instance = 'other-instance'
    with pytest.raises(HTTPException) as error:
        asyncio.run(automatic.automatic_binding(body, request, **kwargs))
    assert error.value.status_code == 403 and len(calls) == 1
    request.state.auth_instance = 'synthetic-instance'
    hook['url'] = 'https://production.invalid/api/v1/webhook/inbound'
    with pytest.raises(HTTPException) as error:
        asyncio.run(automatic.automatic_binding(body, request, **kwargs))
    assert error.value.status_code == 409 and len(calls) == 1


def test_development_instance_scope_excludes_other_callbacks(monkeypatch):
    from app.adapters.evolution.adapter import EvolutionAdapter
    from app.core.config import get_settings
    class Client:
        async def request(self, *args, **kwargs):
            return [{'name': 'dev'}, {'instance': {'instanceName': 'production'}}]
    monkeypatch.setattr(get_settings(), 'evolution_instance_scope', 'dev')
    assert asyncio.run(EvolutionAdapter(Client()).list_instances()) == [{'name': 'dev'}]


def test_self_lid_is_only_accepted_from_explicit_provider_link():
    from app.services.group_automatic import linked_account_identities
    directory = [{'participants': [
        {'id': 'self@lid', 'phoneNumber': 'self@s.whatsapp.net'},
        {'id': 'unrelated@lid', 'phoneNumber': 'other@s.whatsapp.net'},
    ]}]
    assert linked_account_identities(['self@s.whatsapp.net'], directory) == ['self@s.whatsapp.net', 'self@lid']


def test_group_author_phone_is_verified_and_scoped_to_the_group(harness):
    from app.services.group_participants import participant_directory
    registry, record, policy, store, dispatcher = harness
    record['core_channel']['participantPhones'] = participant_directory([
        {'id': 'synthetic-team@g.us', 'participants': [{'id': 'person@lid', 'phoneNumber': '5491100000001@s.whatsapp.net'}]},
        {'id': 'synthetic-other@g.us', 'participants': [{'id': 'other@lid', 'phoneNumber': '5491100000002@s.whatsapp.net'}]},
    ])
    for identity, alternate, group_id, expected in [
        ('person@lid', None, 'synthetic-team@g.us', '5491100000001'),
        ('person@lid', None, 'synthetic-other@g.us', None),
        ('5491100000001@lid', None, 'synthetic-team@g.us', None),
        ('5491100000001@s.whatsapp.net', None, 'synthetic-team@g.us', '5491100000001'),
        ('new@lid', '5491100000001@s.whatsapp.net', 'synthetic-team@g.us', '5491100000001'),
        ('person@lid', '5491100000002@s.whatsapp.net', 'synthetic-team@g.us', None),
    ]:
        payload = provider_payload(author=identity, group=group_id)
        payload['data']['key']['participantAlt'] = alternate
        projected = groups.projection(payload, normalize_webhook(payload), record, policy)
        assert projected['author']['externalId'] == identity
        assert projected['authorPhoneNumber'] == expected


def test_conflicting_participant_directory_does_not_authorize_alias():
    from app.services.group_participants import participant_directory
    result = participant_directory([{'id': 'group@g.us', 'participants': [
        {'id': 'person@lid', 'phoneNumber': '5491100000001@s.whatsapp.net'},
        {'id': 'person@lid', 'phoneNumber': '5491100000002@s.whatsapp.net'},
    ]}])
    assert result == {'group@g.us': {}}
