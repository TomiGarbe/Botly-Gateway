from __future__ import annotations

from dataclasses import dataclass

from app.connections.types import ConnectionType


@dataclass
class ConnectionNotImplementedError(NotImplementedError):
    connection_type: ConnectionType
    operation: str
    status_code: int = 501

    def __str__(self) -> str:
        return f"{self.connection_type.value} connection operation '{self.operation}' is not implemented yet."
