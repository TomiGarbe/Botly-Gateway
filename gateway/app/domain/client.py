from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Client:
    """Product owner of one or more Gateway connections."""

    id: str
    name: str
    description: str | None
    created_at: str
    updated_at: str

    def public_dict(self) -> dict[str, str | None]:
        return asdict(self)


@dataclass(frozen=True)
class ClientOverview:
    """Client data enriched with the relations needed by the product UI."""

    client: Client
    connection_count: int
    last_activity_at: str | None = None

    def public_dict(self) -> dict[str, str | int | None]:
        return {
            **self.client.public_dict(),
            "connection_count": self.connection_count,
            "last_activity_at": self.last_activity_at,
        }
