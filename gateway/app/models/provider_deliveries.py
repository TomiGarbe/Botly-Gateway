"""Public, deliberately small contracts for provider delivery diagnostics."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class ProviderDeliveryListItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    timestamp: int | None = None
    direction: str | None = None
    operation: str | None = None
    provider: str | None = None
    semanticStatus: str | None = None
    deliveryState: str | None = None
    reconciliationState: str | None = None
    messageId: str | None = None
    conversationId: str | None = None
    channelId: str | None = None
    connectionId: str | None = None
    providerMessageId: str | None = None
    durationMs: float | int | None = None
    attemptCount: int | None = None
    retryCount: int | None = None
    correlationId: str | None = None
    isTest: bool = False


class ProviderDeliveryListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ProviderDeliveryListItem]
    total: int
    limit: int
    offset: int


class ProviderDeliveryDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: ProviderDeliveryListItem
    identity: dict[str, Any]
    correlation: dict[str, Any]
    request: dict[str, Any]
    response: dict[str, Any]
    error: dict[str, Any] | None = None
    metadata: dict[str, Any]


class ProviderReconciliationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reconciliationId: str
    attemptId: str
    provider: str
    startedAt: int
    completedAt: int
    status: str
    providerMessageId: str | None = None
    observedState: str | None = None
    confidence: str
    reason: str | None = None
    error: str | None = None


class ProviderResendRequest(BaseModel):
    """The client may only explicitly confirm the server-resolved resend."""
    model_config = ConfigDict(extra="forbid")

    confirmCurrentConfiguration: Literal[True]


class ProviderResendResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: dict[str, Any]
    actionId: str
    idempotent: bool
    newAttemptId: str | None = None
    newDeliveryId: str | None = None
    provider: str | None = None
