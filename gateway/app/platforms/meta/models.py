from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


@dataclass(frozen=True)
class MetaPlatformConfig:
    enabled: bool
    app_id: str | None
    config_id: str | None
    graph_version: str
    supports_coexistence: bool = True
    coexistence_feature_type: str = "whatsapp_business_app_onboarding"
    missing: tuple[str, ...] = ()

    def public_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "app_id": self.app_id,
            "config_id": self.config_id,
            "graph_version": self.graph_version,
            "supports_coexistence": self.supports_coexistence,
            "coexistence_feature_type": self.coexistence_feature_type,
            "missing": list(self.missing),
        }


@dataclass(frozen=True)
class MetaToken:
    access_token: str
    token_type: str | None = None
    expires_in: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "hasAccessToken": bool(self.access_token),
            "metadata": dict(self.metadata),
        }
        if self.token_type:
            payload["tokenType"] = self.token_type
        if self.expires_in is not None:
            payload["expiresIn"] = self.expires_in
        return payload


@dataclass(frozen=True)
class MetaCredentials:
    access_token: str
    phone_number_id: str
    business_account_id: str
    token_type: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def access_token_ref(self) -> str:
        return f"meta://waba/{self.business_account_id}/phones/{self.phone_number_id}/token"

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "phoneNumberId": self.phone_number_id,
            "businessAccountId": self.business_account_id,
            "hasAccessToken": bool(self.access_token),
            "accessTokenRef": self.access_token_ref,
            "metadata": dict(self.metadata),
        }
        if self.token_type:
            payload["tokenType"] = self.token_type
        return payload


class MetaResourceType(str, Enum):
    WHATSAPP_BUSINESS = "WHATSAPP_BUSINESS"
    INSTAGRAM = "INSTAGRAM"
    MESSENGER = "MESSENGER"
    FACEBOOK_PAGE = "FACEBOOK_PAGE"


class MetaResourceStatus(str, Enum):
    DISCOVERED = "DISCOVERED"
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"
    REMOVED = "REMOVED"


@dataclass(frozen=True)
class MetaResource:
    id: str
    platform_id: str
    resource_type: MetaResourceType
    external_id: str
    display_name: str
    status: MetaResourceStatus = MetaResourceStatus.DISCOVERED
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None
    deleted_at: str | None = None

    @classmethod
    def build(
        cls,
        *,
        resource_type: MetaResourceType,
        external_id: str,
        display_name: str,
        status: MetaResourceStatus | str = MetaResourceStatus.DISCOVERED,
        metadata: dict[str, Any] | None = None,
        platform_id: str = "meta",
        created_at: str | None = None,
        updated_at: str | None = None,
        deleted_at: str | None = None,
    ) -> "MetaResource":
        resource_id = f"{platform_id}:{resource_type.value}:{external_id}"
        return cls(
            id=resource_id,
            platform_id=platform_id,
            resource_type=resource_type,
            external_id=external_id,
            display_name=display_name,
            status=MetaResourceStatus(status),
            metadata=dict(metadata or {}),
            created_at=created_at,
            updated_at=updated_at,
            deleted_at=deleted_at,
        )

    def public_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "platformId": self.platform_id,
            "resourceType": self.resource_type.value,
            "type": self.resource_type.value,
            "externalId": self.external_id,
            "displayName": self.display_name,
            "status": self.status.value,
            "metadata": dict(self.metadata),
        }
        if self.created_at:
            payload["createdAt"] = self.created_at
        if self.updated_at:
            payload["updatedAt"] = self.updated_at
        if self.deleted_at:
            payload["deletedAt"] = self.deleted_at
        return payload
