"""Shared read-contract vocabulary for delivery observability domains.

Webhook and provider deliveries intentionally keep separate persistence and API
resources.  This module only names the fields that both expose to readers so
serializers and presentation layers can evolve consistently.
"""
from __future__ import annotations

from typing import Any, TypedDict


COMMON_SEMANTIC_STATUSES = frozenset({
    "success",
    "failed",
    "timeout",
    "network_error",
    "configuration_error",
    "unknown",
})


class ObservabilityEvent(TypedDict, total=False):
    """Conceptual read model shared by, but not persisted as, deliveries."""

    id: str | None
    timestamp: int | None
    operation: str | None
    semanticStatus: str | None
    source: dict[str, Any]
    destination: dict[str, Any]
    durationMs: float | int | None
    attemptCount: int | None
    correlationId: str | None
    request: dict[str, Any]
    response: dict[str, Any]
    error: dict[str, Any] | str | None
    metadata: dict[str, Any]
