from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class DashboardOverallStatus:
    state: str
    label: str


@dataclass(frozen=True)
class DashboardMetrics:
    clients: int
    connections: int
    connected: int
    active_alerts: int


@dataclass(frozen=True)
class DashboardReference:
    id: str
    name: str


@dataclass(frozen=True)
class DashboardActivity:
    id: str
    kind: str
    description: str
    occurred_at: int
    severity: str
    client: DashboardReference | None = None
    connection: DashboardReference | None = None

    def public_dict(self) -> dict:
        return {
            **asdict(self),
            "client": asdict(self.client) if self.client else None,
            "connection": asdict(self.connection) if self.connection else None,
        }


@dataclass(frozen=True)
class DashboardAttention:
    severity: str
    status: str
    client: DashboardReference
    connection: DashboardReference

    def public_dict(self) -> dict:
        return {
            "severity": self.severity,
            "status": self.status,
            "client": asdict(self.client),
            "connection": asdict(self.connection),
        }


@dataclass(frozen=True)
class DashboardSnapshot:
    overall: DashboardOverallStatus
    metrics: DashboardMetrics
    recent_activity: tuple[DashboardActivity, ...]
    attention: tuple[DashboardAttention, ...]

    def public_dict(self) -> dict:
        return {
            "overall": asdict(self.overall),
            "metrics": asdict(self.metrics),
            "recent_activity": [item.public_dict() for item in self.recent_activity],
            "attention": [item.public_dict() for item in self.attention],
        }
