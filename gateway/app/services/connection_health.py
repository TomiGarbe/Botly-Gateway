from __future__ import annotations

from typing import Any

from app.connections.lifecycle import (
    ConnectionDiagnostic,
    ConnectionHealthCheck,
    ConnectionHealthSnapshot,
    ConnectionHealthStatus,
    ConnectionLifecycleState,
    DiagnosticSeverity,
    HealthCheckStatus,
)


class ConnectionHealthService:
    def evaluate(
        self,
        raw: dict[str, Any],
        *,
        name: str,
        status: str,
        connection_type: str,
        integration: str | None = None,
        provider_state: str | None = None,
    ) -> ConnectionHealthSnapshot:
        is_cloud = connection_type == "cloud" or integration == "WHATSAPP-BUSINESS"
        checks: list[ConnectionHealthCheck] = [
            self._check_instance_created(name),
            self._check_connection_available(status, provider_state=provider_state),
        ]

        if is_cloud:
            checks.insert(1, self._check_token_configured(raw))

        diagnostics = self._diagnostics(raw, checks, is_cloud=is_cloud)
        lifecycle_state = self._lifecycle_state(
            status=status,
            checks=checks,
            diagnostics=diagnostics,
            is_cloud=is_cloud,
            provider_state=provider_state,
        )
        health = self._health_status(checks, diagnostics)

        return ConnectionHealthSnapshot(
            lifecycle_state=lifecycle_state,
            health=health,
            checks=tuple(checks),
            diagnostics=tuple(diagnostics),
        )

    def _check_instance_created(self, name: str) -> ConnectionHealthCheck:
        if name:
            return ConnectionHealthCheck("instance_created", "Instancia creada", HealthCheckStatus.PASSED)
        return ConnectionHealthCheck("instance_created", "Instancia creada", HealthCheckStatus.FAILED)

    def _check_connection_available(self, status: str, *, provider_state: str | None = None) -> ConnectionHealthCheck:
        if status == "open":
            return ConnectionHealthCheck("connection_available", "Conexion disponible", HealthCheckStatus.PASSED)
        if status == "connecting":
            return ConnectionHealthCheck(
                "connection_available",
                "Conexion disponible",
                HealthCheckStatus.WARNING,
                details="Evolution todavia esta conectando la instancia.",
            )
        if provider_state in {"created", "configured"}:
            return ConnectionHealthCheck(
                "connection_available",
                "Conexion disponible",
                HealthCheckStatus.UNKNOWN,
                details="La conexion oficial esta configurada, pero su disponibilidad no fue verificada.",
            )
        return ConnectionHealthCheck(
            "connection_available",
            "Conexion disponible",
            HealthCheckStatus.FAILED,
            details="Evolution informa que la instancia no esta abierta.",
        )

    def _check_token_configured(self, raw: dict[str, Any]) -> ConnectionHealthCheck:
        credentials = raw.get("credentials") if isinstance(raw.get("credentials"), dict) else {}
        signals = raw.get("lifecycleSignals") if isinstance(raw.get("lifecycleSignals"), dict) else {}
        configured = signals.get("tokenConfigured") if "tokenConfigured" in signals else credentials.get("hasAccessTokenRef")
        if configured is True:
            return ConnectionHealthCheck("token_configured", "Token configurado", HealthCheckStatus.PASSED)
        if configured is False:
            return ConnectionHealthCheck("token_configured", "Token configurado", HealthCheckStatus.FAILED)
        return ConnectionHealthCheck(
            "token_configured",
            "Token configurado",
            HealthCheckStatus.UNKNOWN,
            details="El Provider no puede verificar el token sin integrar Meta.",
        )

    def _diagnostics(
        self,
        raw: dict[str, Any],
        checks: list[ConnectionHealthCheck],
        *,
        is_cloud: bool,
    ) -> list[ConnectionDiagnostic]:
        diagnostics: list[ConnectionDiagnostic] = []

        signals = raw.get("lifecycleSignals") if isinstance(raw.get("lifecycleSignals"), dict) else {}
        coexistence_state = str(signals.get("coexistenceState") or "").strip().lower()
        if coexistence_state == "failed":
            diagnostics.append(
                ConnectionDiagnostic(
                    code="coexistence_failed",
                    severity=DiagnosticSeverity.ERROR,
                    message="La conexion con WhatsApp Business App fallo o fue rechazada.",
                    recommendation="Reiniciar el onboarding oficial de Meta cuando la recuperacion automatica este disponible.",
                )
            )
        if coexistence_state in {"not_available", "unknown"} and signals.get("whatsappBusinessAppAvailable") is False:
            diagnostics.append(
                ConnectionDiagnostic(
                    code="coexistence_not_active",
                    severity=DiagnosticSeverity.INFO,
                    message="La conexion opera como Cloud API estandar.",
                )
            )

        for check in checks:
            if check.status == HealthCheckStatus.FAILED:
                diagnostics.append(
                    ConnectionDiagnostic(
                        code=f"{check.code}_failed",
                        severity=DiagnosticSeverity.ERROR,
                        message=check.details or f"{check.label} fallo.",
                    )
                )
            elif check.required and check.status == HealthCheckStatus.UNKNOWN:
                diagnostics.append(
                    ConnectionDiagnostic(
                        code=f"{check.code}_unknown",
                        severity=DiagnosticSeverity.WARNING,
                        message=check.details or f"{check.label} no pudo verificarse.",
                        recommendation="Mantener este control visible hasta agregar la validacion automatica.",
                    )
                )
            elif check.status == HealthCheckStatus.WARNING:
                diagnostics.append(
                    ConnectionDiagnostic(
                        code=f"{check.code}_warning",
                        severity=DiagnosticSeverity.WARNING,
                        message=check.details or f"{check.label} requiere seguimiento.",
                    )
                )
        return diagnostics

    def _lifecycle_state(
        self,
        *,
        status: str,
        checks: list[ConnectionHealthCheck],
        diagnostics: list[ConnectionDiagnostic],
        is_cloud: bool,
        provider_state: str | None,
    ) -> ConnectionLifecycleState:
        if any(d.severity == DiagnosticSeverity.ERROR for d in diagnostics):
            if status in {"close", "disconnected", "deleted"}:
                return ConnectionLifecycleState.DISCONNECTED
            return ConnectionLifecycleState.NEEDS_ATTENTION
        if status == "connecting":
            return ConnectionLifecycleState.PROVISIONING
        if provider_state == "created":
            return ConnectionLifecycleState.PROVISIONING
        if provider_state == "configured":
            return ConnectionLifecycleState.CONFIGURED
        if status == "close":
            return ConnectionLifecycleState.DISCONNECTED

        required_checks = [check for check in checks if check.required]
        if required_checks and all(check.status == HealthCheckStatus.PASSED for check in required_checks):
            return ConnectionLifecycleState.CONNECTED
        if is_cloud and any(check.code == "token_configured" and check.status == HealthCheckStatus.PASSED for check in checks):
            return ConnectionLifecycleState.CONFIGURED
        if any(check.status in {HealthCheckStatus.UNKNOWN, HealthCheckStatus.WARNING} for check in checks):
            return ConnectionLifecycleState.WARNING
        return ConnectionLifecycleState.FAILED

    def _health_status(
        self,
        checks: list[ConnectionHealthCheck],
        diagnostics: list[ConnectionDiagnostic],
    ) -> ConnectionHealthStatus:
        if any(diagnostic.severity == DiagnosticSeverity.ERROR for diagnostic in diagnostics):
            return ConnectionHealthStatus.UNHEALTHY
        if any(check.status in {HealthCheckStatus.UNKNOWN, HealthCheckStatus.WARNING} for check in checks if check.required):
            return ConnectionHealthStatus.DEGRADED
        if checks and all(check.status == HealthCheckStatus.PASSED for check in checks if check.required):
            return ConnectionHealthStatus.HEALTHY
        return ConnectionHealthStatus.UNKNOWN
