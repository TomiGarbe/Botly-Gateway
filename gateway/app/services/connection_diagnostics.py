from __future__ import annotations

from typing import Any

from app.services.credential_manager import get_credential_manager


class ConnectionDiagnosticsService:
    def diagnose(self, instance: dict[str, Any], *, raw: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        raw = raw or {}
        diagnostics: list[dict[str, Any]] = []
        name = str(instance.get("name") or raw.get("name") or "")
        connection_type = str(instance.get("connectionType") or raw.get("connectionType") or "")
        is_cloud = connection_type == "cloud" or instance.get("integration") == "WHATSAPP-BUSINESS"
        if not is_cloud:
            return diagnostics

        credentials_info = get_credential_manager().get_official_credentials_info(name) if name else None
        lifecycle_signals = raw.get("lifecycleSignals") if isinstance(raw.get("lifecycleSignals"), dict) else {}

        if not credentials_info and lifecycle_signals.get("tokenConfigured") is not True:
            diagnostics.append({
                "code": "official_credentials_missing",
                "severity": "error",
                "message": "La conexion oficial no tiene credenciales registradas en el Provider.",
                "action": "Completar Embedded Signup nuevamente o recrear la conexion oficial.",
            })
        if credentials_info and not credentials_info.access_token_hash:
            diagnostics.append({
                "code": "official_token_hash_missing",
                "severity": "warning",
                "message": "La referencia de token existe, pero falta la huella para auditoria.",
                "action": "Actualizar la credencial mediante el CredentialManager.",
            })

        if lifecycle_signals.get("coexistenceState") == "failed":
            diagnostics.append({
                "code": "coexistence_failed",
                "severity": "error",
                "message": "La conexion con WhatsApp Business App fallo o fue deshabilitada.",
                "action": "Revisar la cuenta desde WhatsApp Business App y repetir el flujo oficial de Meta.",
            })
        return diagnostics
