"""Bounded, safe query view for Gateway <-> provider message interactions."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.core.secret_protection import SecretRedactor
from app.models.observability import COMMON_SEMANTIC_STATUSES
from app.services.normalization import list_events
from app.services.outbound_provider_attempts import get_outbound_provider_attempt_store, provider_delivery_from_attempt


DIRECTIONS = frozenset({"inbound", "outbound", "status"})
SEMANTIC_STATUSES = COMMON_SEMANTIC_STATUSES
OPERATIONS = frozenset({"provider.message.inbound", "provider.message.outbound", "provider.message.status"})

_LIST_FIELDS = (
    "id", "timestamp", "direction", "operation", "provider", "semanticStatus",
    "deliveryState", "reconciliationState",
    "messageId", "conversationId", "channelId", "connectionId", "providerMessageId",
    "durationMs", "attemptCount", "retryCount", "correlationId", "isTest",
)
_INLINE_SECRET = re.compile(r"(?i)(?:access[_-]?token|api[_-]?key|authorization|cookie|signature|secret|token|credential)\s*[:=]")


@dataclass(frozen=True)
class ProviderDeliveryFilters:
    """Validated identifier filters; deliberately excludes request/response payloads."""

    provider: str | None = None
    direction: str | None = None
    status: str | None = None
    operation: str | None = None
    delivery_id: str | None = None
    message_id: str | None = None
    provider_message_id: str | None = None
    conversation_id: str | None = None
    channel_id: str | None = None
    correlation_id: str | None = None
    request_id: str | None = None
    event_id: str | None = None
    search: str | None = None
    date_from: datetime | None = None
    date_to: datetime | None = None


def _safe_json(value: Any, key: str | None = None) -> Any:
    """Apply shared redaction plus safe URL and provider-error handling."""
    if isinstance(value, dict):
        return {str(name): _safe_json("[REDACTED]" if SecretRedactor.is_sensitive_name(name) else item, str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [_safe_json(item, key) for item in value]
    if isinstance(value, str):
        sanitized = SecretRedactor.redact_url(value) if key in {"url", "uri", "endpoint"} else value
        return "[REDACTED]" if _INLINE_SECRET.search(sanitized) else sanitized
    return SecretRedactor.redact_json(value)


def _timestamp(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _date_timestamp(value: datetime | None) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


class ProviderDeliveryQueryService:
    """Queries the existing bounded timeline once; it never creates delivery storage."""

    @staticmethod
    def _legacy_delivery(event: dict[str, Any]) -> dict[str, Any] | None:
        """Read old business events without backfilling or fabricating identifiers."""
        if event.get("layer") != "business":
            return None
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        meta = event.get("meta") if isinstance(event.get("meta"), dict) else {}
        pipeline = event.get("pipeline") if isinstance(event.get("pipeline"), dict) else {}
        raw = event.get("raw") if isinstance(event.get("raw"), dict) else {}
        direction = str(event.get("direction") or "").strip().lower()
        if direction not in DIRECTIONS:
            direction = None
        result = str(event.get("result") or event.get("status") or "").strip().lower()
        error = event.get("error") if isinstance(event.get("error"), dict) else None
        semantic_status = result if result in SEMANTIC_STATUSES else ("failed" if error else None)
        return {
            "id": str(event.get("id") or "").strip() or None,
            "timestamp": _timestamp(event.get("timestamp")),
            "direction": direction,
            "operation": f"provider.message.{direction}" if direction else None,
            "provider": str(raw.get("provider") or raw.get("providerName") or event.get("provider") or "").strip() or None,
            "semanticStatus": semantic_status,
            "deliveryState": None,
            "reconciliationState": None,
            "messageId": message.get("id") or event.get("messageId"),
            "conversationId": meta.get("conversationId") or pipeline.get("conversationId"),
            "channelId": meta.get("channelId"),
            "connectionId": meta.get("connectionId"),
            "providerMessageId": raw.get("providerMessageId"),
            "requestId": event.get("requestId") or meta.get("requestId") or pipeline.get("requestId"),
            "eventId": event.get("eventId"),
            "durationMs": event.get("durationMs"),
            "attemptCount": None,
            "retryCount": None,
            "correlationId": event.get("correlationId") or meta.get("requestId") or pipeline.get("requestId"),
            "isTest": bool(event.get("isTest") or meta.get("isTest")),
            "request": {},
            "response": {},
            "error": error,
            "metadata": {"legacy": True, "event": event.get("event")},
        }

    def _records(self, instance: str | None = None) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        # The timeline has its own retention bound.  Reading it once avoids N+1
        # reads while preserving every record that can currently be retained.
        events = list_events(instance=instance, limit=10_000)
        attempts = get_outbound_provider_attempt_store().list(instance=instance)
        attempt_ids = {str(item.get("id") or "") for item in attempts}
        records: list[tuple[dict[str, Any], dict[str, Any]]] = [
            ({"instance": item.get("instance")}, provider_delivery_from_attempt(item)) for item in attempts
        ]
        for event in events:
            delivery = event.get("providerDelivery") if isinstance(event.get("providerDelivery"), dict) else self._legacy_delivery(event)
            if isinstance(delivery, dict):
                if (
                    str(delivery.get("direction") or "") == "outbound"
                    and str(delivery.get("outboundAttemptId") or "") in attempt_ids
                ):
                    continue
                # Keep identifier comparisons cheap.  The list serializer and
                # detail view both redact before a record can leave this module.
                records.append((event, delivery))
        return records

    @staticmethod
    def _list_item(delivery: dict[str, Any]) -> dict[str, Any]:
        item = {key: delivery.get(key) for key in _LIST_FIELDS}
        item["timestamp"] = _timestamp(item["timestamp"])
        item["isTest"] = bool(item["isTest"])
        return _safe_json(item)

    @staticmethod
    def _matches(
        delivery: dict[str, Any], filters: ProviderDeliveryFilters,
    ) -> bool:
        comparisons = {
            "provider": filters.provider, "direction": filters.direction, "semanticStatus": filters.status,
            "operation": filters.operation, "id": filters.delivery_id, "messageId": filters.message_id,
            "providerMessageId": filters.provider_message_id, "conversationId": filters.conversation_id,
            "channelId": filters.channel_id, "correlationId": filters.correlation_id,
            "requestId": filters.request_id, "eventId": filters.event_id,
        }
        for key, expected in comparisons.items():
            if expected is not None and str(delivery.get(key) or "") != expected:
                return False
        timestamp = _timestamp(delivery.get("timestamp"))
        if filters.search is not None and not any(
            str(delivery.get(key) or "") == filters.search
            for key in ("id", "messageId", "providerMessageId", "conversationId", "channelId", "connectionId", "correlationId", "requestId", "eventId")
        ):
            return False
        minimum, maximum = _date_timestamp(filters.date_from), _date_timestamp(filters.date_to)
        if minimum is not None and (timestamp is None or timestamp < minimum):
            return False
        if maximum is not None and (timestamp is None or timestamp > maximum):
            return False
        return True

    def list(
        self, *, instance: str, limit: int, offset: int, provider: str | None = None,
        direction: str | None = None, status: str | None = None, operation: str | None = None,
        message_id: str | None = None, conversation_id: str | None = None,
        channel_id: str | None = None, provider_message_id: str | None = None,
        correlation_id: str | None = None, request_id: str | None = None,
        event_id: str | None = None, delivery_id: str | None = None, search: str | None = None,
        date_from: datetime | None = None, date_to: datetime | None = None,
    ) -> dict[str, Any]:
        filters = ProviderDeliveryFilters(
            provider=provider, direction=direction, status=status, operation=operation,
            delivery_id=delivery_id, message_id=message_id, provider_message_id=provider_message_id,
            conversation_id=conversation_id, channel_id=channel_id, correlation_id=correlation_id,
            request_id=request_id, event_id=event_id, search=search, date_from=date_from, date_to=date_to,
        )
        matched = [delivery for _event, delivery in self._records(instance) if self._matches(delivery, filters)]
        # Do not rely on deque/JSON order if two provider deliveries share a timestamp.
        matched.sort(key=lambda value: (_timestamp(value.get("timestamp")) or 0, str(value.get("id") or "")), reverse=True)
        return {
            "items": [self._list_item(delivery) for delivery in matched[offset : offset + limit]],
            "total": len(matched), "limit": limit, "offset": offset,
        }

    def find(self, delivery_id: str) -> tuple[str | None, dict[str, Any]] | None:
        wanted = str(delivery_id or "").strip()
        if not wanted:
            return None
        for event, delivery in self._records():
            if str(delivery.get("id") or "") == wanted:
                return str(event.get("instance") or "").strip() or None, delivery
        return None

    def analytics_records(self) -> list[tuple[str | None, dict[str, Any]]]:
        """Bounded, payload-free projection for the analytics read model."""
        fields = (
            "id", "timestamp", "provider", "direction", "operation", "semanticStatus",
            "deliveryState", "reconciliationState", "durationMs", "attemptCount", "retryCount",
        )
        return [
            (instance, {field: delivery.get(field) for field in fields})
            for event, delivery in self._records()
            for instance in [str(event.get("instance") or "").strip() or None]
        ]

    def detail(self, delivery: dict[str, Any]) -> dict[str, Any]:
        item = self._list_item(delivery)
        result = {
            "summary": item,
            "identity": {
                "id": item["id"], "messageId": item["messageId"], "providerMessageId": item["providerMessageId"],
                "connectionId": item["connectionId"], "channelId": item["channelId"],
            },
            "correlation": {"requestId": delivery.get("requestId"), "correlationId": item["correlationId"], "conversationId": item["conversationId"], "eventId": delivery.get("eventId"), "attemptId": delivery.get("attemptId")},
            "request": delivery.get("request") if isinstance(delivery.get("request"), dict) else {},
            "response": delivery.get("response") if isinstance(delivery.get("response"), dict) else {},
            "error": delivery.get("error") if isinstance(delivery.get("error"), dict) else None,
            "metadata": delivery.get("metadata") if isinstance(delivery.get("metadata"), dict) else {},
        }
        return _safe_json(result)


_service = ProviderDeliveryQueryService()


def get_provider_delivery_query_service() -> ProviderDeliveryQueryService:
    return _service
