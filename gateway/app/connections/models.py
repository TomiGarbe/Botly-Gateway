from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.connections.capabilities import ConnectionCapabilities
from app.connections.types import ConnectionType


@dataclass
class ConnectionConfiguration:
    public: dict[str, Any] = field(default_factory=dict)
    private: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class ConnectionModel:
    id: str
    name: str
    connection_type: ConnectionType
    status: str
    capabilities: ConnectionCapabilities
    configuration: ConnectionConfiguration = field(default_factory=ConnectionConfiguration)
