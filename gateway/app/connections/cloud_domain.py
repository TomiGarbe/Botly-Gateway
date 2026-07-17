from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class CloudConnectionStatus(str, Enum):
    CREATED = "created"
    CONFIGURED = "configured"
    DISCONNECTED = "disconnected"
    DELETED = "deleted"


@dataclass(frozen=True)
class CloudCredentials:
    phone_number_id: str | None = None
    business_account_id: str | None = None
    access_token_ref: str | None = None
    connection_metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def is_configured(self) -> bool:
        return bool(self.phone_number_id and self.business_account_id and self.access_token_ref)

    def public_dict(self) -> dict[str, Any]:
        return {
            "phoneNumberId": self.phone_number_id,
            "businessAccountId": self.business_account_id,
            "hasAccessTokenRef": bool(self.access_token_ref),
            "connectionMetadata": dict(self.connection_metadata),
        }


@dataclass
class CloudConnectionRecord:
    id: str
    name: str
    status: CloudConnectionStatus
    credentials: CloudCredentials = field(default_factory=CloudCredentials)

    def public_instance(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status.value,
            "connectionType": "cloud",
            "integration": "WHATSAPP-BUSINESS",
            "credentials": self.credentials.public_dict(),
        }
