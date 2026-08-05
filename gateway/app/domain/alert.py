from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class AlertReference:
    id: str
    name: str


@dataclass(frozen=True)
class Alert:
    id: str
    severity: str
    status: str
    title: str
    description: str
    client: AlertReference
    connection: AlertReference
    created_at: str
    resolved_at: str | None
    workspace_url: str

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "severity": self.severity,
            "status": self.status,
            "title": self.title,
            "description": self.description,
            "client": asdict(self.client),
            "connection": asdict(self.connection),
            "created_at": self.created_at,
            "resolved_at": self.resolved_at,
            "workspace_url": self.workspace_url,
        }
