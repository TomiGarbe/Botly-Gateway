"""Stable, payload-free read contracts for operational analytics."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class AnalyticsRange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fromUtc: str
    toUtc: str
    inclusiveStart: bool = True
    exclusiveEnd: bool = True
    granularity: Literal["hour", "day"]


class StatusCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    success: int = 0
    failed: int = 0
    timeout: int = 0
    network_error: int = 0
    configuration_error: int = 0
    unknown: int = 0


class LatencyMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sampleCount: int = 0
    averageMs: float | None = None
    p95Ms: float | None = None


class ProviderAnalytics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str
    totalDeliveries: int
    messages: int
    inbound: int
    outbound: int
    statusEvents: int
    technical: StatusCounts
    deliveryStates: dict[str, int]
    reconciliationStates: dict[str, int]
    technicalSuccessRate: float | None
    technicalFailureRate: float | None
    technicalUnknownRate: float | None
    latency: LatencyMetrics


class WebhookAnalytics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    totalDeliveries: int
    technical: StatusCounts
    testDeliveries: int
    realDeliveries: int
    totalAttempts: int
    retries: int
    technicalSuccessRate: float | None
    technicalFailureRate: float | None
    latency: LatencyMetrics


class AttemptAnalytics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    totalAttempts: int
    technical: StatusCounts
    deliveryStates: dict[str, int]
    accepted: int
    pendingReconciliation: int
    reconciled: int
    stillUnknown: int


class ManualActionAnalytics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    totalActions: int
    resendTotal: int
    resendCompleted: int
    resendFailed: int
    resendBlocked: int


class AnalyticsSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    totalMessages: int
    inboundMessages: int
    outboundMessages: int
    providerDeliveries: int
    providerTechnicalSuccess: int
    providerFailures: int
    providerUnknown: int
    pendingReconciliation: int
    webhookDeliveries: int
    webhookFailures: int


class ConnectionAnalytics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connectionId: str
    connectionName: str
    provider: str
    totalProviderDeliveries: int
    messages: int
    failedDeliveries: int
    unknownDeliveries: int
    timeoutDeliveries: int
    pendingReconciliation: int
    webhookFailures: int


class TimeSeriesPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bucketStartUtc: str
    messages: int
    providerFailures: int
    providerUnknown: int
    webhookFailures: int


class AnalyticsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    range: AnalyticsRange
    summary: AnalyticsSummary
    providers: list[ProviderAnalytics]
    attempts: AttemptAnalytics
    manualActions: ManualActionAnalytics
    webhooks: WebhookAnalytics
    connections: list[ConnectionAnalytics]
    timeseries: list[TimeSeriesPoint]
