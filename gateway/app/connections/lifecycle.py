from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ConnectionLifecycleState(str, Enum):
    PROVISIONING = "provisioning"
    CONFIGURED = "configured"
    CONNECTED = "connected"
    WARNING = "warning"
    DISCONNECTED = "disconnected"
    NEEDS_ATTENTION = "needs_attention"
    FAILED = "failed"


class ConnectionHealthStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


class DiagnosticSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    RECOMMENDATION = "recommendation"
    INFO = "info"


class HealthCheckStatus(str, Enum):
    PASSED = "passed"
    WARNING = "warning"
    FAILED = "failed"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ConnectionDiagnostic:
    code: str
    severity: DiagnosticSeverity
    message: str
    recommendation: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "severity": self.severity.value,
            "message": self.message,
        }
        if self.recommendation:
            payload["recommendation"] = self.recommendation
        if self.metadata:
            payload["metadata"] = dict(self.metadata)
        return payload


@dataclass(frozen=True)
class ConnectionHealthCheck:
    code: str
    label: str
    status: HealthCheckStatus
    required: bool = True
    details: str | None = None

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "label": self.label,
            "status": self.status.value,
            "required": self.required,
        }
        if self.details:
            payload["details"] = self.details
        return payload


@dataclass(frozen=True)
class ConnectionHealthSnapshot:
    lifecycle_state: ConnectionLifecycleState
    health: ConnectionHealthStatus
    checks: tuple[ConnectionHealthCheck, ...] = field(default_factory=tuple)
    diagnostics: tuple[ConnectionDiagnostic, ...] = field(default_factory=tuple)

    def public_dict(self) -> dict[str, Any]:
        return {
            "lifecycleState": self.lifecycle_state.value,
            "health": self.health.value,
            "checks": [check.public_dict() for check in self.checks],
            "diagnostics": [diagnostic.public_dict() for diagnostic in self.diagnostics],
        }
