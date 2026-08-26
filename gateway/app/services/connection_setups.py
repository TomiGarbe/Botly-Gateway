"""Durable lifecycle for connection creation before it becomes inventory."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from app.connections import ConnectionManager, get_connection_manager
from app.core.config import get_settings
from app.services.connection_registry import ConnectionRegistry, get_connection_registry
from app.services.gateway_settings import GatewaySettingsService, get_gateway_settings_service


ACTIVE_STATES = {"draft", "onboarding", "provisioning"}
TERMINAL_STATES = {"ready", "failed", "cancelled", "cleanup_pending", "expired"}
_TRANSITIONS = {
    "draft": {"onboarding", "provisioning", "failed", "cancelled", "cleanup_pending", "expired"},
    "onboarding": {"provisioning", "failed", "cancelled", "cleanup_pending", "expired"},
    "provisioning": {"ready", "failed", "cleanup_pending", "expired"},
    "failed": {"cleanup_pending"},
    "cancelled": {"cleanup_pending"},
    "expired": {"cleanup_pending"},
    "cleanup_pending": set(),
    "ready": set(),
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


class ConnectionSetupNotFoundError(KeyError):
    pass


class InvalidConnectionSetupTransition(ValueError):
    pass


class ConnectionSetupConflictError(ValueError):
    pass


class ConnectionSetupService:
    """Own setup records and atomically promote only completed provisioning."""

    def __init__(self, connection_manager: ConnectionManager | None = None, registry: ConnectionRegistry | None = None, gateway_settings: GatewaySettingsService | None = None) -> None:
        self._connection_manager = connection_manager or get_connection_manager()
        self._registry = registry or get_connection_registry()
        self._gateway_settings = gateway_settings or get_gateway_settings_service()

    def _validate_request(self, *, client_id: str, channel: str, provider: str) -> None:
        if self._registry.get_client(client_id) is None:
            raise ConnectionSetupNotFoundError(client_id)
        self._gateway_settings.require_channel_available(channel)
        if channel != "whatsapp":
            raise ValueError("Only WhatsApp is available for new connections")
        if provider not in {"meta", "evolution"}:
            raise ValueError(f"Unsupported provider: {provider}")
        self._gateway_settings.require_provider_available(provider)

    @staticmethod
    def _public(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"], "client_id": record["client_id"], "name": record["name"],
            "provider": record["provider_id"], "channel": record["channel_id"], "state": record["state"],
            "created_at": record["created_at"], "updated_at": record["updated_at"], "expires_at": record["expires_at"],
            "connection_id": record.get("connection_id"), "runtime_name": record.get("runtime_name"),
            "cleanup_required": bool(record.get("cleanup_required")),
            "cleanup": record.get("cleanup") if isinstance(record.get("cleanup"), dict) else None,
            "external_resources": list(record.get("external_resources") or []),
            "diagnostic": record.get("diagnostic"),
        }

    def _record(self, setup_id: str) -> dict[str, Any]:
        record = self._registry.setup_record_by_id(setup_id)
        if record is None:
            raise ConnectionSetupNotFoundError(setup_id)
        return self._expire_if_due(record)

    def _expire_if_due(self, record: dict[str, Any]) -> dict[str, Any]:
        if record.get("state") not in ACTIVE_STATES:
            return record
        try:
            expires_at = datetime.fromisoformat(str(record["expires_at"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            return record
        if expires_at > _now():
            return record
        if record.get("external_resources"):
            return self._transition_record(record, "cleanup_pending", {"cleanup_required": True, "cleanup_final_state": "expired"})
        return self._transition_record(record, "expired")

    def create(self, *, client_id: str, channel: str, name: str | None, provider: str, idempotency_key: str | None = None) -> dict[str, Any]:
        self._validate_request(client_id=client_id, channel=channel, provider=provider)
        key = str(idempotency_key or "").strip()
        if key:
            existing = self._registry.setup_record_by_idempotency_key(client_id, key)
            if existing:
                if existing.get("provider_id") != provider or existing.get("channel_id") != channel:
                    raise ConnectionSetupConflictError("Idempotency key is already associated with a different setup")
                return self._public(self._expire_if_due(existing))
        now = _now()
        ttl = max(60, int(getattr(get_settings(), "connection_setup_ttl_seconds", 3600)))
        setup_id = str(uuid4())
        clean_name = str(name or "").strip() or ("WhatsApp Oficial" if provider == "meta" else "WhatsApp Evolution")
        record = {
            "id": setup_id, "client_id": client_id, "name": clean_name, "provider_id": provider,
            "channel_id": channel, "state": "draft", "created_at": _iso(now), "updated_at": _iso(now),
            "expires_at": _iso(now + timedelta(seconds=ttl)), "idempotency_key": key or None,
            "runtime_name": f"setup_{setup_id.replace('-', '')[:24]}", "external_resources": [],
            "cleanup_required": False, "diagnostic": None,
        }
        if self._registry.save_setup_record_for_client(record) is None:
            raise ConnectionSetupNotFoundError(client_id)
        return self._public(record)

    def get(self, setup_id: str) -> dict[str, Any]:
        return self._public(self._record(setup_id))

    def raw(self, setup_id: str) -> dict[str, Any]:
        return self._record(setup_id)

    def _transition_record(self, record: dict[str, Any], target: str, changes: dict[str, Any] | None = None) -> dict[str, Any]:
        current = str(record.get("state") or "")
        if target == current:
            return record
        if target not in _TRANSITIONS.get(current, set()):
            raise InvalidConnectionSetupTransition(f"Invalid setup transition: {current} -> {target}")
        updated = self._registry.update_setup_record(record["id"], {"state": target, "updated_at": _iso(_now()), **(changes or {})})
        if updated is None:
            raise ConnectionSetupNotFoundError(record["id"])
        return updated

    def transition(self, setup_id: str, target: str) -> dict[str, Any]:
        return self._public(self._transition_record(self._record(setup_id), target))

    def begin_meta(self, setup_id: str) -> dict[str, Any]:
        record = self._record(setup_id)
        if record.get("provider_id") != "meta":
            raise ConnectionSetupConflictError("This setup does not use Meta")
        return self._public(self._transition_record(record, "onboarding") if record["state"] == "draft" else record)

    def begin_meta_provisioning(self, setup_id: str) -> dict[str, Any]:
        """Claim the callback before Graph work so retries resume one setup."""
        record = self._record(setup_id)
        if record.get("provider_id") != "meta":
            raise ConnectionSetupConflictError("This setup does not use Meta")
        if record["state"] == "onboarding":
            record = self._transition_record(record, "provisioning")
        if record["state"] != "provisioning":
            raise ConnectionSetupConflictError("Meta setup cannot be provisioned from its current state")
        return self._public(record)

    async def provision_evolution(self, setup_id: str) -> dict[str, Any]:
        record = self._record(setup_id)
        if record.get("provider_id") != "evolution":
            raise ConnectionSetupConflictError("This setup does not use Evolution")
        if record.get("state") == "ready":
            return self._public(record)
        record = self._transition_record(record, "provisioning") if record["state"] == "draft" else record
        if record["state"] != "provisioning":
            raise ConnectionSetupConflictError("Evolution setup cannot be provisioned from its current state")
        try:
            await self._connection_manager.create(record["runtime_name"], qrcode=True, connection_type="baileys")
        except Exception:
            # A timeout can be ambiguous; do not delete an instance without proof of ownership.
            updated = self._transition_record(record, "cleanup_pending", {"cleanup_required": True, "diagnostic": {"code": "evolution_create_uncertain", "message": "La creación de la instancia no pudo confirmarse."}})
            return self._public(updated)
        resources = [{"kind": "evolution_instance", "identifier": record["runtime_name"], "ownership_confirmed": True}]
        record = self._registry.update_setup_record(record["id"], {"external_resources": resources, "updated_at": _iso(_now())}) or record
        try:
            await self._connection_manager.set_webhook(record["runtime_name"], f"http://gateway:{get_settings().gateway_port}/webhooks/evolution", ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED", "SEND_MESSAGE"], connection_type="baileys")
        except Exception:
            # Instance ownership is known, so expose a manual compensation state.
            return self._public(self._transition_record(record, "cleanup_pending", {"cleanup_required": True, "diagnostic": {"code": "evolution_webhook_failed", "message": "La instancia fue creada, pero no se pudo configurar su webhook."}}))
        return self._public(self._promote(record, status_state="connecting", status_health="unknown"))

    def complete_meta(self, setup_id: str, *, phone_number_id: str, business_account_id: str) -> dict[str, Any]:
        record = self._record(setup_id)
        if record.get("provider_id") != "meta":
            raise ConnectionSetupConflictError("This setup does not use Meta")
        if record.get("state") == "ready":
            return self._public(record)
        if record["state"] != "provisioning":
            raise ConnectionSetupConflictError("Meta setup cannot be completed from its current state")
        resources = [{"kind": "meta_phone_number", "identifier": phone_number_id, "ownership_confirmed": False}, {"kind": "meta_business_account", "identifier": business_account_id, "ownership_confirmed": False}]
        record = self._registry.update_setup_record(record["id"], {"external_resources": resources, "updated_at": _iso(_now())}) or record
        return self._public(self._promote(record, status_state="connected", status_health="healthy"))

    def mark_meta_failed(self, setup_id: str) -> dict[str, Any]:
        record = self._record(setup_id)
        if record["state"] not in ACTIVE_STATES:
            return self._public(record)
        return self._public(self._transition_record(record, "failed", {"diagnostic": {"code": "meta_onboarding_failed", "message": "No se pudo completar el onboarding de Meta."}}))

    def _promote(self, setup: dict[str, Any], *, status_state: str, status_health: str) -> dict[str, Any]:
        if setup.get("state") != "provisioning":
            raise InvalidConnectionSetupTransition("Only provisioning setups can be promoted")
        now = _iso(_now())
        connection_id = str(uuid4())
        connection = {"id": connection_id, "legacy_name": setup["runtime_name"], "client_id": setup["client_id"], "name": setup["name"], "provider_id": setup["provider_id"], "provider_display_name": "Meta" if setup["provider_id"] == "meta" else "Evolution", "channel_id": setup["channel_id"], "channel_display_name": "WhatsApp", "status_state": status_state, "status_health": status_health, "created_at": now, "updated_at": now}
        result = self._registry.promote_setup_to_connection(setup["id"], connection, {"state": "ready", "connection_id": connection_id, "updated_at": now})
        if result is None:
            raise ConnectionSetupNotFoundError(setup["id"])
        return result[0]

    def cancel(self, setup_id: str) -> dict[str, Any]:
        record = self._record(setup_id)
        if record["state"] in {"cancelled", "cleanup_pending", "expired", "failed"}:
            return self._public(record)
        if record["state"] == "ready":
            raise InvalidConnectionSetupTransition("Ready setups represent operational connections and cannot be cancelled")
        target = "cleanup_pending" if record.get("external_resources") else "cancelled"
        changes = {"cleanup_required": target == "cleanup_pending"}
        if target == "cleanup_pending":
            changes["cleanup_final_state"] = "cancelled"
        return self._public(self._transition_record(record, target, changes))

    def expire_active(self) -> int:
        # Registry intentionally exposes no public mutable collection: snapshot is a safe sweep input.
        count = 0
        for record in self._registry.snapshot().get("setups", {}).values():
            if isinstance(record, dict) and record.get("state") in ACTIVE_STATES:
                before = record.get("state")
                after = self._expire_if_due(record).get("state")
                count += int(before != after)
        return count


def get_connection_setup_service() -> ConnectionSetupService:
    return ConnectionSetupService()
