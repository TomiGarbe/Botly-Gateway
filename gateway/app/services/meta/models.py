from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from app.platforms.meta import MetaCredentials, MetaToken


class OnboardingType(str, Enum):
    STANDARD = "STANDARD"
    COEXISTENCE = "COEXISTENCE"


class MetaOnboardingState(str, Enum):
    OAUTH_OK = "OAUTH_OK"
    TOKEN_VALID = "TOKEN_VALID"
    DISCOVERY_OK = "DISCOVERY_OK"
    APP_SUBSCRIBED = "APP_SUBSCRIBED"
    PHONE_REGISTERED = "PHONE_REGISTERED"
    PHONE_VERIFIED = "PHONE_VERIFIED"
    WEBHOOK_VERIFIED = "WEBHOOK_VERIFIED"
    EVOLUTION_READY = "EVOLUTION_READY"
    CREDENTIALS_PERSISTED = "CREDENTIALS_PERSISTED"
    READY = "READY"


@dataclass(frozen=True)
class TokenVerification:
    app_id: str | None
    business_id: str | None
    expires_at: int | None
    scopes: tuple[str, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class DiscoveryResult:
    waba_id: str
    phone_number_id: str
    display_phone_number: str | None
    phone: dict[str, Any]
    waba: dict[str, Any]


@dataclass
class MetaOnboardingRecord:
    instance_name: str
    onboarding_type: OnboardingType
    steps: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)
    updated_at: str | None = None

    def completed(self, state: MetaOnboardingState) -> bool:
        return state.value in self.steps

    def public_dict(self) -> dict[str, Any]:
        required_states = (
            MetaOnboardingState.OAUTH_OK,
            MetaOnboardingState.TOKEN_VALID,
            MetaOnboardingState.DISCOVERY_OK,
            MetaOnboardingState.APP_SUBSCRIBED,
            MetaOnboardingState.PHONE_REGISTERED,
            MetaOnboardingState.PHONE_VERIFIED,
            MetaOnboardingState.WEBHOOK_VERIFIED,
            MetaOnboardingState.EVOLUTION_READY,
            MetaOnboardingState.CREDENTIALS_PERSISTED,
        )
        ready = self.completed(MetaOnboardingState.READY) and all(self.completed(state) for state in required_states)
        payload = {
            "status": "READY" if ready else "INCOMPLETE",
            "onboardingType": self.onboarding_type.value,
            "steps": {
                "oauth": self.completed(MetaOnboardingState.OAUTH_OK),
                "token": self.completed(MetaOnboardingState.TOKEN_VALID),
                "discovery": self.completed(MetaOnboardingState.DISCOVERY_OK),
                "subscription": self.completed(MetaOnboardingState.APP_SUBSCRIBED),
                "phone": self.completed(MetaOnboardingState.PHONE_REGISTERED)
                and self.completed(MetaOnboardingState.PHONE_VERIFIED),
                "webhook": self.completed(MetaOnboardingState.WEBHOOK_VERIFIED),
                "evolution": self.completed(MetaOnboardingState.EVOLUTION_READY),
                "credentials": self.completed(MetaOnboardingState.CREDENTIALS_PERSISTED),
            },
            "completedStates": dict(self.steps),
            "warnings": list(self.warnings),
            "errors": list(self.errors),
            "details": dict(self.details),
            "updatedAt": self.updated_at,
        }
        if not ready:
            payload["blockingStage"] = (
                self.errors[-1].get("stage")
                if self.errors
                else next((state.value.lower() for state in required_states if not self.completed(state)), "ready")
            )
        return payload


@dataclass(frozen=True)
class MetaOnboardingResult:
    token: MetaToken
    credentials: MetaCredentials
    discovery: DiscoveryResult
    instance: dict[str, Any]
    record: MetaOnboardingRecord
    resources: tuple[Any, ...] = ()
    channels: tuple[Any, ...] = ()
