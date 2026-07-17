from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.connections.types import ConnectionType
from app.provisioning.types import ProvisioningState


@dataclass(frozen=True)
class ProvisioningRequest:
    instance_name: str
    connection_type: ConnectionType
    qrcode: bool = True
    token: str | None = None
    phone_number_id: str | None = None
    business_id: str | None = None
    requires_signup: bool = False
    signup_provider: str | None = None
    configuration: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SignupSession:
    id: str
    provider: str
    connection_type: ConnectionType
    state: ProvisioningState = ProvisioningState.WAITING_CONFIGURATION
    public_payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SignupResult:
    provider: str
    connection_type: ConnectionType
    configuration: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class InstanceProvisioningResult:
    instance: dict[str, Any]
    external_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProvisioningRecord:
    id: str
    instance_name: str
    connection_type: ConnectionType
    state: ProvisioningState = ProvisioningState.CREATED
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def transition(self, state: ProvisioningState, *, error: str | None = None) -> None:
        self.state = state
        self.error = error

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "instanceName": self.instance_name,
            "connectionType": self.connection_type.value,
            "state": self.state.value,
        }
        if self.error:
            payload["error"] = self.error
        if self.metadata:
            payload["metadata"] = dict(self.metadata)
        return payload


@dataclass(frozen=True)
class ProvisioningResult:
    record: ProvisioningRecord
    instance: dict[str, Any] | None = None
    signup: SignupSession | None = None

    @property
    def is_ready(self) -> bool:
        return self.record.state == ProvisioningState.READY

    def public_dict(self) -> dict[str, Any]:
        payload = {"provisioning": self.record.public_dict()}
        if self.instance is not None:
            payload["instance"] = self.instance
        if self.signup is not None:
            payload["signup"] = {
                "id": self.signup.id,
                "provider": self.signup.provider,
                "connectionType": self.signup.connection_type.value,
                "state": self.signup.state.value,
                "publicPayload": dict(self.signup.public_payload),
            }
        return payload
