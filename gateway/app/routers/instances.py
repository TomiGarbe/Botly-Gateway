import asyncio
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.core.config import get_settings
from app.core.logging import get_logger
from app.connections import get_connection_manager
from app.models.requests import CreateInstanceRequest
from app.services import instance_auth
from app.services.audit import audit_event
from app.services.connection_diagnostics import ConnectionDiagnosticsService
from app.services.credential_manager import get_credential_manager
from app.services.connection_metadata import delete_connection_metadata, enrich_instance_payload
from app.services.instance_webhooks import delete_all_instance_webhooks
from app.services.instances_contract import normalize_instance, normalize_instance_list, normalize_instance_status

logger = get_logger(__name__)
router = APIRouter(prefix="/instances", tags=["instances"])
_connection_manager = get_connection_manager()

_WEBHOOK_EVENTS = [
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "CONNECTION_UPDATE",
    "QRCODE_UPDATED",
    "SEND_MESSAGE",
]

def _validate_instance_name(instance_name: str) -> str:
    cleaned = str(instance_name or "").strip()
    if not cleaned or cleaned == "-" or not all(ch.islower() or ch.isdigit() or ch == "_" for ch in cleaned):
        raise HTTPException(status_code=400, detail="Nombre de instancia invalido")
    return cleaned


def _apply_http_error(exc: Exception, *, fallback_status: int = 502) -> HTTPException:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        status_code = status if 100 <= status <= 599 else fallback_status
        return HTTPException(status_code=status_code, detail=str(exc))
    return HTTPException(status_code=fallback_status, detail=f"Evolution error: {exc}")


async def _configure_webhook_if_needed(instance_name: str) -> bool:
    settings = get_settings()
    webhook_url = f"http://gateway:{settings.gateway_port}/webhooks/evolution"

    try:
        configured = await _connection_manager.get_webhook(instance_name)
        current_url = configured.get("webhook", {}).get("url") if isinstance(configured, dict) else None
        if current_url == webhook_url:
            return True
    except Exception as exc:
        logger.warning("webhook_lookup_failed", instance=instance_name, error=str(exc))

    try:
        await _connection_manager.set_webhook(instance_name, webhook_url, _WEBHOOK_EVENTS)
        logger.info("webhook_configured", instance=instance_name, url=webhook_url)
        audit_event("webhook_configured", instance=instance_name, url=webhook_url, events=_WEBHOOK_EVENTS)
        return True
    except Exception as exc:
        logger.warning("webhook_configure_failed", instance=instance_name, error=str(exc))
        return False


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_instance(body: CreateInstanceRequest):
    instance_name = _validate_instance_name(body.instance_name)
    try:
        result = await _connection_manager.create(
            instance_name=instance_name,
            qrcode=body.qrcode,
            token=body.token,
            phone_number_id=body.phone_number_id,
            business_id=body.business_id,
            connection_type=body.connection_type,
        )
    except Exception as exc:
        logger.error("create_instance_failed", instance=instance_name, error=str(exc))
        raise _apply_http_error(exc)

    if body.auto_configure_webhook:
        await _configure_webhook_if_needed(instance_name)
    # Devuelve el token en claro una unica vez para que el panel pueda revelarlo.
    api_key_payload = instance_auth.create_or_regenerate_instance_key(instance_name, instance_id=instance_name)
    if body.connection_type == "cloud" and body.token and body.phone_number_id and body.business_id:
        get_credential_manager().upsert_official_credentials(
            instance_name=instance_name,
            access_token=body.token,
            phone_number_id=body.phone_number_id,
            business_account_id=body.business_id,
            source="manual_fallback",
            metadata={"onboarding": "manual_fallback"},
        )

    if isinstance(result, dict):
        normalized = normalize_instance(result)
        if normalized:
            return {"instance": normalized, "apiKey": api_key_payload.get("apiKey")}

    logger.warning("create_instance_response_unusable", instance=instance_name, raw=result)
    fallback_status = "open" if body.connection_type == "cloud" else "connecting"
    return {
        "instance": {
            "id": instance_name,
            "name": instance_name,
            "status": fallback_status,
            "connectionType": body.connection_type,
        },
        "apiKey": api_key_payload.get("apiKey"),
    }


@router.get("/")
async def list_instances():
    try:
        instances = await _connection_manager.list_instances()
    except Exception as exc:
        raise _apply_http_error(exc)

    enriched_instances = [enrich_instance_payload(item) if isinstance(item, dict) else item for item in instances]
    normalized = normalize_instance_list(enriched_instances)
    for item in normalized:
        instance_auth.ensure_instance_key(item["name"], instance_id=item.get("id"))
    return normalized


@router.get("/{instance_name}/diagnostics")
async def get_diagnostics(instance_name: str):
    instance_name = _validate_instance_name(instance_name)
    try:
        result = await _connection_manager.get_status(instance_name)
    except Exception as exc:
        raise _apply_http_error(exc)

    raw = enrich_instance_payload(result if isinstance(result, dict) else {})
    if isinstance(raw.get("instance"), dict):
        raw = {**raw, "name": instance_name}
    else:
        raw = {**raw, "name": instance_name}
    normalized = normalize_instance(raw)
    if not normalized:
        raise HTTPException(status_code=404, detail="Instancia no encontrada")
    return {
        "id": normalized["id"],
        "name": normalized["name"],
        "connectionType": normalized.get("connectionType"),
        "integration": normalized.get("integration"),
        "status": normalized["status"],
        "lifecycleState": normalized.get("lifecycleState"),
        "health": normalized.get("health"),
        "healthChecks": normalized.get("healthChecks", []),
        "diagnostics": normalized.get("diagnostics", []),
        "supportDiagnostics": ConnectionDiagnosticsService().diagnose(normalized, raw=raw),
    }


@router.get("/{instance_name}/state")
async def get_state(instance_name: str):
    instance_name = _validate_instance_name(instance_name)
    try:
        result = await _connection_manager.get_status(instance_name)
        state = normalize_instance_status(result.get("instance", {}).get("state"))
        return {"id": instance_name, "name": instance_name, "status": state}
    except Exception as exc:
        raise _apply_http_error(exc)


@router.get("/{instance_name}/qr")
async def get_qr(instance_name: str, refresh: bool = Query(default=False)):
    instance_name = _validate_instance_name(instance_name)
    try:
        state_data = await _connection_manager.get_status(instance_name)
        state = normalize_instance_status(state_data.get("instance", {}).get("state"))

        instance_payload = {"id": instance_name, "name": instance_name, "status": state}
        if state == "open":
            return {"instance": instance_payload, "qrcode": None}

        now = time.time()
        if refresh:
            await asyncio.sleep(0.4)

        qr_data = await _connection_manager.connect(instance_name)

        qrcode = qr_data.get("qrcode") if isinstance(qr_data, dict) else None
        if not isinstance(qrcode, dict):
            qrcode = {"base64": qr_data.get("base64"), "code": qr_data.get("code")} if isinstance(qr_data, dict) else {}

        return {
            "instance": instance_payload,
            "qrcode": qrcode,
            "fetchedAt": int(now),
            "nextRecommendedRefreshAt": int(now + 45),
        }
    except Exception as exc:
        logger.warning("qr_fetch_failed", instance=instance_name, error=str(exc))
        raise _apply_http_error(exc)


@router.post("/{instance_name}/reconnect")
async def reconnect(instance_name: str):
    instance_name = _validate_instance_name(instance_name)
    try:
        try:
            await _connection_manager.reconnect(instance_name)
        except Exception as restart_exc:
            if getattr(restart_exc, "status_code", None) is None:
                raise
            logger.warning("instance_restart_failed_fallback_qr", instance=instance_name, error=str(restart_exc))

        await asyncio.sleep(1.0)
        state = await _connection_manager.get_status(instance_name)
        normalized_state = normalize_instance_status(state.get("instance", {}).get("state"))

        payload: dict[str, Any] = {"instance": {"id": instance_name, "name": instance_name, "status": normalized_state}}
        if normalized_state != "open":
            payload["qr"] = await _connection_manager.connect(instance_name)
        return payload
    except Exception as exc:
        raise _apply_http_error(exc)


@router.delete("/{instance_name}/logout")
async def logout(instance_name: str):
    instance_name = _validate_instance_name(instance_name)
    try:
        result = await _connection_manager.disconnect(instance_name)
        return {"ok": True, "instance": {"id": instance_name, "name": instance_name, "status": "close"}, "raw": result}
    except Exception as exc:
        # Idempotencia operativa: si Evolution rechaza logout por estado/ausencia, tratamos como cerrado.
        if getattr(exc, "status_code", None) in (400, 404):
            logger.warning("logout_idempotent_fallback", instance=instance_name, error=str(exc))
            return {"ok": True, "instance": {"id": instance_name, "name": instance_name, "status": "close"}, "stale": True}
        raise _apply_http_error(exc)


@router.delete("/{instance_name}")
async def delete(instance_name: str):
    instance_name = _validate_instance_name(instance_name)
    try:
        result = await _connection_manager.delete(instance_name)
        instance_auth.delete_instance_key_record(instance_name)
        delete_all_instance_webhooks(instance_name)
        delete_connection_metadata(instance_name)
        get_credential_manager().delete_official_credentials(instance_name)
        audit_event("connection_deleted", instance=instance_name)
        return {"ok": True, "instance": {"id": instance_name, "name": instance_name, "status": "close"}, "raw": result}
    except Exception as exc:
        if getattr(exc, "status_code", None) == 404:
            logger.warning("delete_idempotent_fallback", instance=instance_name, error=str(exc))
            instance_auth.delete_instance_key_record(instance_name)
            delete_all_instance_webhooks(instance_name)
            delete_connection_metadata(instance_name)
            get_credential_manager().delete_official_credentials(instance_name)
            audit_event("connection_deleted", instance=instance_name, stale=True)
            return {"ok": True, "instance": {"id": instance_name, "name": instance_name, "status": "close"}, "stale": True}
        raise _apply_http_error(exc)


@router.get("/{instance_name}/api-key")
async def get_instance_api_key(instance_name: str, request: Request, reveal: bool = Query(default=False)):
    instance_name = _validate_instance_name(instance_name)
    auth_instance = getattr(request.state, "auth_instance", None)
    if auth_instance and auth_instance != instance_name:
        raise HTTPException(status_code=403, detail="Token no autorizado para esta instancia")
    if reveal:
        raise HTTPException(status_code=403, detail="No se permite revelar API keys completas")
    instance_auth.ensure_instance_key(instance_name, instance_id=instance_name)
    return instance_auth.get_instance_key_info(instance_name, reveal=False)


@router.post("/{instance_name}/api-key/regenerate")
async def regenerate_instance_api_key(instance_name: str, request: Request):
    instance_name = _validate_instance_name(instance_name)
    if not bool(getattr(request.state, "is_admin", False)):
        raise HTTPException(status_code=403, detail="Solo admin puede regenerar API key")
    return instance_auth.create_or_regenerate_instance_key(instance_name, instance_id=instance_name)


@router.delete("/{instance_name}/api-key")
async def revoke_api_key(instance_name: str, request: Request):
    instance_name = _validate_instance_name(instance_name)
    if not bool(getattr(request.state, "is_admin", False)):
        raise HTTPException(status_code=403, detail="Solo admin puede revocar API key")
    return instance_auth.revoke_instance_key(instance_name)


@router.post("/{instance_name}/api-key/enable")
async def enable_api_key(instance_name: str, request: Request):
    instance_name = _validate_instance_name(instance_name)
    if not bool(getattr(request.state, "is_admin", False)):
        raise HTTPException(status_code=403, detail="Solo admin puede habilitar API key")
    return instance_auth.create_or_regenerate_instance_key(instance_name, instance_id=instance_name)
