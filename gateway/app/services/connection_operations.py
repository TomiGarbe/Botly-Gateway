from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from app.connections import ConnectionManager, get_connection_manager
from app.core.config import get_settings
from app.services import instance_auth
from app.services.connection_registry import ConnectionRegistry, get_connection_registry
from app.services.instance_webhooks import (
    create_webhook,
    list_instance_webhooks,
    update_webhook,
)
from app.services.normalization import list_events, save_business_event, save_pipeline_event
from app.services.webhook_delivery import dispatch_webhook_with_retry


class ConnectionOperationUnavailableError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class ConnectionOperationsService:
    """Connection-scoped facade over runtime operations kept during migration."""

    def __init__(
        self,
        connection_manager: ConnectionManager | None = None,
        registry: ConnectionRegistry | None = None,
    ) -> None:
        self._connection_manager = connection_manager or get_connection_manager()
        self._registry = registry or get_connection_registry()

    def _record(self, connection_id: str) -> dict[str, Any]:
        record = self._registry.connection_record_by_id(connection_id)
        if record is None:
            raise KeyError(connection_id)
        return record

    def _runtime_name(self, connection_id: str) -> str:
        record = self._record(connection_id)
        runtime_name = str(record.get("legacy_name") or "").strip()
        if not runtime_name:
            raise ConnectionOperationUnavailableError("Connection runtime is not available")
        return runtime_name

    @staticmethod
    def _webhook_payload(item: dict[str, Any] | None) -> dict[str, Any]:
        if item is None:
            return {
                "configured": False,
                "enabled": False,
                "url": None,
                "id": None,
                "last_delivery_at": None,
                "last_error": None,
                "successful_deliveries": 0,
                "failed_deliveries": 0,
                "auth_type": "NONE",
                "auth_header_name": None,
                "query_param_name": None,
                "custom_header_name": None,
                "has_auth_secret": False,
            }
        auth = item.get("authConfig") if isinstance(item.get("authConfig"), dict) else {}
        custom_headers = item.get("customHeaders") if isinstance(item.get("customHeaders"), dict) else {}
        auth_type = str(item.get("authType") or "NONE").upper()
        secret_key = {"BEARER": "hasToken", "API_KEY": "hasApiKey", "QUERY_PARAM": "hasQueryParamValue"}.get(auth_type)
        return {
            "configured": True,
            "enabled": bool(item.get("enabled")),
            "url": str(item.get("url") or "") or None,
            "id": str(item.get("id") or "") or None,
            "last_delivery_at": item.get("lastUsedAt"),
            "last_error": item.get("lastError"),
            "successful_deliveries": int(item.get("successCount") or 0),
            "failed_deliveries": int(item.get("failureCount") or 0),
            "auth_type": auth_type,
            "auth_header_name": str(auth.get("headerName") or "") or None,
            "query_param_name": str(auth.get("queryParamName") or "") or None,
            "custom_header_name": next((str(key) for key in custom_headers if str(key).strip()), None),
            "has_auth_secret": bool(auth.get(secret_key)) if secret_key else bool(custom_headers),
        }

    def webhook(self, connection_id: str) -> dict[str, Any]:
        runtime_name = self._runtime_name(connection_id)
        hooks = list_instance_webhooks(runtime_name, reveal_secrets=False)
        return self._webhook_payload(hooks[0] if hooks else None)

    def integration_endpoints(self, connection_id: str) -> dict[str, str]:
        runtime_name = self._runtime_name(connection_id)
        settings = get_settings()
        base_url = str(settings.public_app_url or "").strip().rstrip("/")
        if not base_url:
            base_url = f"http://127.0.0.1:{settings.gateway_port}"
        return {
            "message_api_url": f"{base_url}/messages/{runtime_name}",
            "meta_webhook_url": f"{base_url}/webhooks/meta",
        }

    def update_webhook(
        self,
        connection_id: str,
        url: str,
        *,
        auth_type: str | None = None,
        auth_config: dict[str, str] | None = None,
        custom_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        runtime_name = self._runtime_name(connection_id)
        clean_url = str(url or "").strip()
        parsed = urlparse(clean_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Webhook URL must be a valid HTTP(S) URL")

        hooks = list_instance_webhooks(runtime_name, reveal_secrets=False)
        if hooks:
            current = hooks[0]
            next_auth_type = auth_type or str(current.get("authType") or "NONE")
            item = update_webhook(
                runtime_name,
                str(current["id"]),
                name=str(current.get("name") or "Webhook"),
                url=clean_url,
                enabled=bool(current.get("enabled", True)),
                auth_type=next_auth_type,
                auth_config=auth_config,
                custom_headers=custom_headers,
                event_filters=current.get("eventFilters") if isinstance(current.get("eventFilters"), dict) else None,
            )
        else:
            item = create_webhook(
                runtime_name,
                name="Webhook",
                url=clean_url,
                enabled=True,
                auth_type=auth_type or "NONE",
                auth_config=auth_config,
                custom_headers=custom_headers,
            )
        return self._webhook_payload(item)

    async def test_webhook(self, connection_id: str) -> dict[str, Any]:
        runtime_name = self._runtime_name(connection_id)
        hooks = list_instance_webhooks(runtime_name, reveal_secrets=True)
        if not hooks:
            raise ConnectionOperationUnavailableError("Webhook is not configured")
        item = hooks[0]
        if not item.get("enabled"):
            raise ConnectionOperationUnavailableError("Webhook is disabled")
        payload = {
            "id": "connection_webhook_test",
            "event": "TEST_WEBHOOK",
            "instance": runtime_name,
            "timestamp": int(time.time() * 1000),
            "type": "connection_test",
            "status": "received",
            "text": "test webhook",
        }
        result = await dispatch_webhook_with_retry(
            payload=payload,
            request_id=f"connection-test-{connection_id[:8]}",
            item=item,
            test_mode=True,
        )
        self._registry.update_connection_record(connection_id, {"last_activity_at": _now(), "updated_at": _now()})
        return {
            "ok": bool(result.get("ok")),
            "status": int(result.get("statusCode") or 0),
            "error": result.get("error"),
        }

    def api_key(self, connection_id: str, *, reveal: bool = False) -> dict[str, Any]:
        runtime_name = self._runtime_name(connection_id)
        instance_auth.ensure_instance_key(runtime_name, instance_id=connection_id)
        return self._api_key_payload(instance_auth.get_instance_key_info(runtime_name, reveal=reveal))

    def regenerate_api_key(self, connection_id: str) -> dict[str, Any]:
        runtime_name = self._runtime_name(connection_id)
        result = instance_auth.create_or_regenerate_instance_key(runtime_name, instance_id=connection_id)
        return self._api_key_payload(result, api_key=str(result.get("apiKey") or "") or None)

    @staticmethod
    def _api_key_payload(item: dict[str, Any], api_key: str | None = None) -> dict[str, Any]:
        payload = {
            "enabled": bool(item.get("enabled")),
            "has_api_key": bool(item.get("hasApiKey")),
            "masked_api_key": item.get("maskedApiKey"),
            "created_at": item.get("createdAt"),
            "can_reveal_api_key": bool(item.get("canRevealApiKey")),
        }
        value = api_key or item.get("apiKey")
        if value:
            payload["api_key"] = value
        return payload

    async def reconnect(self, connection_id: str) -> None:
        runtime_name = self._runtime_name(connection_id)
        records = await self._connection_manager.list_instances()
        if not any(str(item.get("name") or item.get("instanceName") or "") == runtime_name for item in records if isinstance(item, dict)):
            raise ConnectionOperationUnavailableError("Connection is not ready to reconnect")
        await self._connection_manager.reconnect(runtime_name)
        self._registry.update_connection_record(
            connection_id,
            {"status_state": "connecting", "last_activity_at": _now(), "updated_at": _now()},
        )
        save_pipeline_event(stage="connection_reconnect", status="started", instance=runtime_name, event="CONNECTION_RECONNECT")

    async def status(self, connection_id: str) -> dict[str, Any]:
        record = self._record(connection_id)
        runtime_name = self._runtime_name(connection_id)
        records = await self._connection_manager.list_instances()
        runtime = next(
            (
                item
                for item in records
                if isinstance(item, dict) and str(item.get("name") or item.get("instanceName") or "") == runtime_name
            ),
            None,
        )
        heartbeat_at = _now()
        if runtime is not None:
            self._registry.update_connection_record(
                connection_id,
                {"last_heartbeat_at": heartbeat_at, "updated_at": heartbeat_at},
            )
        raw_state = str((runtime or {}).get("status") or (runtime or {}).get("connectionStatus") or "").lower()
        connected = raw_state in {"open", "connected"}
        return {
            "connected": connected,
            "last_activity_at": record.get("last_activity_at"),
            "last_heartbeat_at": heartbeat_at if runtime is not None else record.get("last_heartbeat_at"),
        }

    async def send_quick_message(self, connection_id: str, *, number: str, text: str) -> dict[str, Any]:
        runtime_name = self._runtime_name(connection_id)
        clean_number = "".join(character for character in str(number or "") if character.isdigit())
        clean_text = str(text or "").strip()
        if len(clean_number) < 8:
            raise ValueError("Recipient number is invalid")
        if not clean_text:
            raise ValueError("Message text is required")
        save_pipeline_event(
            stage="send_whatsapp",
            status="attempt",
            instance=runtime_name,
            details={"kind": "text", "number": clean_number},
        )
        try:
            result = await self._connection_manager.send_text(runtime_name, clean_number, clean_text)
        except Exception as exc:
            save_pipeline_event(
                stage="send_whatsapp",
                status="failed",
                instance=runtime_name,
                details={"kind": "text", "error": str(exc)[:180]},
            )
            raise
        now_ms = int(time.time() * 1000)
        save_business_event(
            {
                "id": str(uuid.uuid4())[:16],
                "layer": "business",
                "event": "CONNECTION_QUICK_SEND",
                "instance": runtime_name,
                "timestamp": now_ms,
                "direction": "outbound",
                "type": "message",
                "messageType": "text",
                "recipient": clean_number,
                "text": clean_text,
                "status": "sent",
                "fromMe": True,
                "message": {"id": None, "kind": "text", "text": clean_text},
            }
        )
        self._registry.update_connection_record(connection_id, {"last_activity_at": _now(), "updated_at": _now()})
        save_pipeline_event(stage="send_whatsapp", status="ok", instance=runtime_name, details={"kind": "text"})
        return {"ok": True, "result": result}

    def recent_activity(self, connection_id: str, limit: int = 5) -> list[dict[str, Any]]:
        runtime_name = self._runtime_name(connection_id)
        events = list_events(instance=runtime_name, limit=max(1, min(limit, 20)))
        return [self._activity_payload(event) for event in events]

    @staticmethod
    def _activity_payload(event: dict[str, Any]) -> dict[str, Any]:
        pipeline = event.get("pipeline") if isinstance(event.get("pipeline"), dict) else {}
        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        direction = str(event.get("direction") or "")
        stage = str(pipeline.get("stage") or "")
        event_name = str(event.get("event") or "")
        severity = str(event.get("severity") or "INFO")
        if severity in {"ERROR", "CRITICAL"}:
            description = "Error operativo"
        elif direction == "outbound" or "send" in stage:
            description = "Mensaje enviado"
        elif direction == "inbound":
            description = "Mensaje recibido"
        elif "reconnect" in stage or "RECONNECT" in event_name:
            description = "Reconexión iniciada"
        elif "dispatch" in stage:
            description = "Webhook enviado"
        elif "webhook" in stage or "WEBHOOK" in event_name:
            description = "Webhook recibido"
        elif "test" in stage or "TEST" in event_name:
            description = "Prueba ejecutada"
        elif "status" in stage or "connection" in stage:
            description = "Estado de conexión actualizado"
        else:
            description = str(event.get("description") or "Actividad de conexión")

        error = details.get("error") or (event.get("error") if isinstance(event.get("error"), str) else None)
        technical = {
            "Componente": event.get("component") or "Gateway",
            "Severidad": severity,
            "Evento": event_name or "Actividad",
            "Etapa": stage or None,
            "Resultado": event.get("result") or event.get("status") or None,
            "Correlación": event.get("correlationId") or None,
            "Duración": f"{event['durationMs']} ms" if event.get("durationMs") is not None else None,
            "Error": str(error) if error else None,
            "Acción sugerida": event.get("action") or details.get("action"),
        }
        return {
            "id": str(event.get("id") or ""),
            "occurred_at": int(event.get("timestamp") or 0),
            "description": description,
            "status": str(event.get("result") or event.get("status") or "unknown"),
            "severity": severity,
            "technical": {key: value for key, value in technical.items() if value not in (None, "")},
        }


def get_connection_operations_service() -> ConnectionOperationsService:
    return ConnectionOperationsService()
