from app.connections.capabilities import BaileysCapabilities, CloudCapabilities, ConnectionCapabilities
from app.connections.cloud_domain import (
    CloudConnectionRecord,
    CloudConnectionStatus,
    CloudCredentials,
)
from app.connections.lifecycle import (
    ConnectionDiagnostic,
    ConnectionHealthCheck,
    ConnectionHealthSnapshot,
    ConnectionHealthStatus,
    ConnectionLifecycleState,
    DiagnosticSeverity,
    HealthCheckStatus,
)
from app.connections.models import ConnectionConfiguration, ConnectionModel
from app.connections.types import ConnectionType


def get_connection_manager():
    from app.connections.manager import get_connection_manager as _get_connection_manager

    return _get_connection_manager()


def __getattr__(name: str):
    if name == "ConnectionManager":
        from app.connections.manager import ConnectionManager

        return ConnectionManager
    raise AttributeError(name)

__all__ = [
    "BaileysCapabilities",
    "CloudCapabilities",
    "CloudConnectionRecord",
    "CloudConnectionStatus",
    "CloudCredentials",
    "ConnectionCapabilities",
    "ConnectionConfiguration",
    "ConnectionDiagnostic",
    "ConnectionHealthCheck",
    "ConnectionHealthSnapshot",
    "ConnectionHealthStatus",
    "ConnectionLifecycleState",
    "ConnectionManager",
    "ConnectionModel",
    "ConnectionType",
    "DiagnosticSeverity",
    "HealthCheckStatus",
    "get_connection_manager",
]
