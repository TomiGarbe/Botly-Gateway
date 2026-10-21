"""Service-only Core authorization and canonical-v2 outbound endpoints."""
import hmac
from fastapi import APIRouter, Header, HTTPException, Request
from app.core.config import get_settings
from app.models.canonical_v2 import CanonicalOutboundV2, GroupPolicy, GroupBindingRequest, GroupReplayRequest, AutomaticRequest
from app.services.connection_registry import get_connection_registry
from app.services.group_transport import require_policy
from app.services.canonical_outbound import CanonicalOutboundService, CanonicalOutboundError

router = APIRouter(tags=['group-transport'])


@router.post('/v2/group-transport/automatic')
async def automatic_transport(body: AutomaticRequest, request: Request):
    from app.services.group_automatic import automatic_binding
    return await automatic_binding(body, request)


def require_core_service(request: Request):
    expected = str(get_settings().gateway_control_plane_api_key or '')
    provided = request.headers.get('Authorization', '')
    if not expected or not hmac.compare_digest(provided, 'Bearer ' + expected):
        raise HTTPException(403, 'Core control-plane service authentication required')


@router.put('/v2/group-transport/policy')
async def put_policy(body: GroupPolicy, request: Request):
    require_core_service(request)
    registry = get_connection_registry()
    try:
        registry.update_group_transport_policy(body.model_dump())
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(409, 'Connection/channel/binding mismatch')
    return body


@router.post('/v2/outbound/messages', status_code=202)
async def send_message(body: CanonicalOutboundV2, request: Request,
                       version: str = Header(..., alias='X-Botly-Contract-Version')):
    if version != 'canonical-v2':
        raise HTTPException(400, 'Expected canonical-v2')
    # Instance credentials scope connection; global service credentials must
    # explicitly specify the connection/binding in the strict v2 body.
    if getattr(request.state, 'auth_method', None) not in {'instance_api_key', 'gateway_api_key'}:
        raise HTTPException(403, 'Service authentication required')
    try:
        return await CanonicalOutboundService().deliver(message=body, authenticated_instance=getattr(request.state, 'auth_instance', None))
    except CanonicalOutboundError as exc:
        raise HTTPException(exc.status_code, {'code': exc.code, 'message': str(exc)}) from exc


@router.post('/v2/group-transport/binding')
async def bind_group_transport(body: GroupBindingRequest, request: Request):
    require_core_service(request)
    from app.services.core_control_plane import get_core_control_plane_client, CoreControlPlaneError
    from app.services.core_channel_credentials import get_core_channel_credential_store
    registry = get_connection_registry()
    record = registry.connection_record_by_id(body.connectionRef)
    if not record or (record.get('provider_id'), record.get('channel_id')) != ('evolution', 'whatsapp'):
        raise HTTPException(409, 'Expected an Evolution WhatsApp connection')
    try:
        result = await get_core_control_plane_client().bind(
            gateway_client_id=record['client_id'], gateway_connection_id=record['id'],
            core_channel_id=body.coreChannelId, channel_type='whatsapp')
    except CoreControlPlaneError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    if result.channel.id != body.coreChannelId or result.channel.channel_type != 'whatsapp':
        raise HTTPException(502, 'Core returned a mismatched channel')
    credential_ref = get_core_channel_credential_store().upsert(
        connection_id=record['id'], core_channel_id=result.channel.id, channel_api_key=result.dispatch_credential)
    binding = {'channelId': result.channel.id, 'bindingId': result.id, 'credentialRef': credential_ref}
    # Rebinding always disables groups and invalidates queued events from the old binding.
    if registry.update_connection_record(record['id'], {'core_channel': binding}) is None:
        get_core_channel_credential_store().delete(record['id'])
        raise HTTPException(409, 'Connection no longer exists')
    return {'connectionRef': record['id'], 'coreChannelId': result.channel.id, 'bindingId': result.id}


@router.post('/v2/group-transport/deliveries/{delivery_id}/replay')
async def replay_group(delivery_id: str, body: GroupReplayRequest, request: Request):
    require_core_service(request)
    from app.services.core_inbound_dispatcher import get_core_inbound_dispatcher
    registry = get_connection_registry()
    dispatcher = get_core_inbound_dispatcher()
    delivery = dispatcher._store.get(delivery_id)
    try:
        record = registry.connection_record_by_id(body.connectionRef)
        event = (delivery or {}).get('canonicalEvent') or {}
        policy = require_policy(record, group_id=event['chat']['externalId'])
        if policy.bindingId != body.bindingId or policy.coreChannelId != body.coreChannelId:
            raise ValueError('Binding mismatch')
        return dispatcher._store.replay_group(delivery_id, connection_id=body.connectionRef,
                                              core_channel_id=body.coreChannelId, binding_id=body.bindingId)
    except (ValueError, TypeError, AttributeError, KeyError):
        raise HTTPException(409, 'Replay connection/channel/group/binding mismatch')
