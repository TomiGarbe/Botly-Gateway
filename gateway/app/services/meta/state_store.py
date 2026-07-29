from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.meta.models import MetaOnboardingRecord, MetaOnboardingState, OnboardingType

logger = get_logger(__name__)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class MetaOnboardingStore:
    """Atomic JSON store; it intentionally never contains access tokens."""

    def _path(self) -> Path:
        settings = get_settings()
        return Path(str(getattr(settings, "meta_onboarding_path", "/tmp/botly_meta_onboarding.json")))

    def _load(self) -> dict[str, Any]:
        path = self._path()
        if not path.exists():
            return {"onboardings": {}}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("onboardings"), dict):
                return payload
        except Exception as exc:
            logger.warning("meta_onboarding_store_load_failed", path=str(path), error=str(exc))
        return {"onboardings": {}}

    def _save(self, payload: dict[str, Any]) -> None:
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        temp.replace(path)

    def get(self, instance_name: str) -> MetaOnboardingRecord | None:
        raw = self._load()["onboardings"].get(instance_name)
        return self._record(raw) if isinstance(raw, dict) else None

    def start(self, instance_name: str, onboarding_type: OnboardingType) -> MetaOnboardingRecord:
        record = self.get(instance_name)
        if record is None or record.onboarding_type != onboarding_type:
            record = MetaOnboardingRecord(instance_name=instance_name, onboarding_type=onboarding_type)
            self.put(record)
        return record

    def advance(self, record: MetaOnboardingRecord, state: MetaOnboardingState, *, details: dict[str, Any] | None = None) -> MetaOnboardingRecord:
        record.steps.setdefault(state.value, _now())
        if details:
            record.details.update(details)
        # A successful complete run supersedes errors recorded by an interrupted
        # earlier attempt.  Keeping them made a READY record look failed forever.
        if state == MetaOnboardingState.READY:
            record.errors = []
        record.updated_at = _now()
        self.put(record)
        return record

    def warn(self, record: MetaOnboardingRecord, message: str) -> None:
        if message not in record.warnings:
            record.warnings.append(message)
        record.updated_at = _now()
        self.put(record)

    def fail(self, record: MetaOnboardingRecord, *, code: str, message: str, detail: dict[str, Any] | None = None) -> None:
        # READY is a statement about the current run, never a historical flag.
        # Removing it makes the public status accurately identify a failed retry.
        record.steps.pop(MetaOnboardingState.READY.value, None)
        error = {
            "code": code,
            "message": message,
            "stage": _stage_for_error(code),
            "resource": _resource_for_error(code, detail),
            "action": _action_for_error(code),
        }
        if detail:
            error["detail"] = detail
        record.errors = [item for item in record.errors if item.get("code") != code]
        record.errors.append(error)
        record.updated_at = _now()
        self.put(record)

    def put(self, record: MetaOnboardingRecord) -> None:
        payload = self._load()
        payload["onboardings"][record.instance_name] = {
            "instanceName": record.instance_name,
            "onboardingType": record.onboarding_type.value,
            "steps": dict(record.steps),
            "warnings": list(record.warnings),
            "errors": list(record.errors),
            "details": dict(record.details),
            "updatedAt": record.updated_at,
        }
        self._save(payload)

    def _record(self, raw: dict[str, Any]) -> MetaOnboardingRecord:
        try:
            onboarding_type = OnboardingType(str(raw.get("onboardingType") or OnboardingType.STANDARD.value))
        except ValueError:
            onboarding_type = OnboardingType.STANDARD
        return MetaOnboardingRecord(
            instance_name=str(raw.get("instanceName") or ""),
            onboarding_type=onboarding_type,
            steps=raw.get("steps") if isinstance(raw.get("steps"), dict) else {},
            warnings=raw.get("warnings") if isinstance(raw.get("warnings"), list) else [],
            errors=raw.get("errors") if isinstance(raw.get("errors"), list) else [],
            details=raw.get("details") if isinstance(raw.get("details"), dict) else {},
            updated_at=raw.get("updatedAt"),
        )


def _stage_for_error(code: str) -> str:
    if code.startswith("token_"):
        return "token_validation"
    if code.startswith("discovery_"):
        return "discovery"
    if code.startswith("subscription_"):
        return "waba_subscription"
    if code.startswith("phone_registration"):
        return "phone_registration"
    if code.startswith("phone_verification"):
        return "phone_verification"
    if code.startswith("webhook_"):
        return "webhook_configuration"
    if code.startswith("evolution_"):
        return "evolution_provisioning"
    return "onboarding"


def _resource_for_error(code: str, detail: dict[str, Any] | None) -> str | None:
    detail = detail or {}
    for key in ("resource", "phoneNumberId", "phone_number_id", "wabaId", "businessAccountId", "field"):
        value = detail.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return None


def _action_for_error(code: str) -> str:
    actions = {
        "token_invalid": "Reiniciar Embedded Signup y autorizar la aplicacion correcta.",
        "token_scopes_missing": "Reiniciar Embedded Signup y aceptar los permisos de WhatsApp solicitados.",
        "discovery_failed": "Verificar que la WABA y el numero seleccionados pertenecen a la misma cuenta.",
        "subscription_failed": "Revisar permisos de la WABA y reintentar la suscripcion de la app.",
        "phone_registration_failed": "Revisar el estado y el PIN del numero en Meta antes de reintentar.",
        "phone_verification_failed": "Completar la verificacion del numero en Meta y volver a intentar.",
        "webhook_invalid": "Configurar META_APP_SECRET y META_WEBHOOK_VERIFY_TOKEN y verificar /webhooks/meta en Meta.",
        "evolution_failed": "Revisar la instancia Cloud de Evolution y su conectividad antes de reintentar.",
    }
    return actions.get(code, "Revisar el detalle de la etapa y reintentar el onboarding.")
