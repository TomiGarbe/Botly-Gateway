"""On-demand analytics over existing observability stores; no analytics store."""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

from app.services.manual_delivery_actions import list_action_summaries
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore, get_outbound_provider_attempt_store
from app.services.provider_deliveries import ProviderDeliveryQueryService, get_provider_delivery_query_service
from app.services.webhook_deliveries import list_all_delivery_summaries


_STATUSES = ("success", "failed", "timeout", "network_error", "configuration_error", "unknown")


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _status_counts() -> dict[str, int]:
    return {status: 0 for status in _STATUSES}


def _add_status(counts: dict[str, int], value: Any) -> None:
    status = str(value or "").strip().lower()
    if status in counts:
        counts[status] += 1


def _latency(values: Iterable[float]) -> dict[str, float | int | None]:
    sample = sorted(values)
    if not sample:
        return {"sampleCount": 0, "averageMs": None, "p95Ms": None}
    average = round(sum(sample) / len(sample), 2)
    # Nearest-rank p95 is calculated over the individual observed durations;
    # one observation is not a meaningful percentile.
    p95 = round(sample[math.ceil(len(sample) * 0.95) - 1], 2) if len(sample) >= 2 else None
    return {"sampleCount": len(sample), "averageMs": average, "p95Ms": p95}


def _rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _bucket(timestamp: int, granularity: str) -> str:
    date = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc)
    if granularity == "day":
        date = date.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        date = date.replace(minute=0, second=0, microsecond=0)
    return date.isoformat().replace("+00:00", "Z")


class AnalyticsService:
    """Reads each bounded source once and only retains scalar fields in memory."""

    def __init__(
        self, *, provider_deliveries: ProviderDeliveryQueryService | None = None,
        attempts: OutboundProviderAttemptStore | None = None,
    ) -> None:
        self._provider_deliveries = provider_deliveries or get_provider_delivery_query_service()
        self._attempts = attempts or get_outbound_provider_attempt_store()

    def snapshot(
        self, *, connections: list[Any], from_ms: int, to_ms: int, granularity: str,
    ) -> dict[str, Any]:
        if granularity not in {"hour", "day"}:
            raise ValueError("Unsupported analytics granularity")
        allowed_by_instance = {
            str(getattr(connection, "technical", {}).get("legacy_instance_name") or "").strip(): connection
            for connection in connections
            if str(getattr(connection, "technical", {}).get("legacy_instance_name") or "").strip()
        }
        allowed_ids = {str(getattr(connection, "id", "")) for connection in connections}
        provider_rows = [
            (instance, row) for instance, row in self._provider_deliveries.analytics_records()
            if instance in allowed_by_instance and self._in_range(row.get("timestamp"), from_ms, to_ms)
        ]
        attempt_rows = [
            row for row in self._attempts.list()
            if str(row.get("instance") or "") in allowed_by_instance and self._in_range(row.get("createdAt"), from_ms, to_ms)
        ]
        webhook_rows = [
            row for row in list_all_delivery_summaries()
            if str(row.get("instanceName") or "") in allowed_by_instance and self._in_range(row.get("timestamp"), from_ms, to_ms)
        ]
        action_rows = [
            row for row in list_action_summaries()
            if str(row.get("connectionId") or "") in allowed_ids and self._in_range(row.get("createdAt"), from_ms, to_ms)
        ]
        providers = self._providers(provider_rows)
        connection_metrics = self._connections(connections, provider_rows, webhook_rows)
        return {
            "range": {
                "fromUtc": self._iso(from_ms), "toUtc": self._iso(to_ms),
                "inclusiveStart": True, "exclusiveEnd": True, "granularity": granularity,
            },
            "summary": self._summary(provider_rows, attempt_rows, webhook_rows),
            "providers": providers,
            "attempts": self._attempt_metrics(attempt_rows),
            "manualActions": self._action_metrics(action_rows),
            "webhooks": self._webhook_metrics(webhook_rows),
            "connections": connection_metrics,
            "timeseries": self._timeseries(provider_rows, webhook_rows, granularity),
        }

    @staticmethod
    def _in_range(value: Any, from_ms: int, to_ms: int) -> bool:
        timestamp = _int(value)
        return timestamp is not None and from_ms <= timestamp < to_ms

    @staticmethod
    def _iso(timestamp: int) -> str:
        return datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    def _summary(self, providers: list[tuple[str | None, dict[str, Any]]], attempts: list[dict[str, Any]], webhooks: list[dict[str, Any]]) -> dict[str, int]:
        messages = [row for _instance, row in providers if row.get("direction") in {"inbound", "outbound"}]
        return {
            "totalMessages": len(messages), "inboundMessages": sum(row.get("direction") == "inbound" for row in messages),
            "outboundMessages": sum(row.get("direction") == "outbound" for row in messages),
            "providerDeliveries": len(providers), "providerTechnicalSuccess": sum(row.get("semanticStatus") == "success" for _instance, row in providers),
            "providerFailures": sum(row.get("semanticStatus") == "failed" for _instance, row in providers),
            "providerUnknown": sum(row.get("semanticStatus") == "unknown" for _instance, row in providers),
            "pendingReconciliation": sum(row.get("reconciliationState") == "pending" for row in attempts),
            "webhookDeliveries": len(webhooks), "webhookFailures": sum(row.get("semanticStatus") != "success" for row in webhooks),
        }

    def _providers(self, rows: list[tuple[str | None, dict[str, Any]]]) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for _instance, row in rows:
            provider = str(row.get("provider") or "").strip().lower()
            if provider:  # Do not invent a provider for legacy data.
                grouped[provider].append(row)
        result = []
        for provider, entries in grouped.items():
            counts, states, recon, latency = _status_counts(), defaultdict(int), defaultdict(int), []
            inbound = outbound = status_events = 0
            for row in entries:
                _add_status(counts, row.get("semanticStatus"))
                state = str(row.get("deliveryState") or "").strip()
                reconciliation = str(row.get("reconciliationState") or "").strip()
                if state: states[state] += 1
                if reconciliation: recon[reconciliation] += 1
                direction = row.get("direction")
                inbound += direction == "inbound"
                outbound += direction == "outbound"
                status_events += direction == "status"
                value = _number(row.get("durationMs"))
                if value is not None: latency.append(value)
            total = len(entries)
            result.append({
                "provider": provider, "totalDeliveries": total, "messages": inbound + outbound,
                "inbound": inbound, "outbound": outbound, "statusEvents": status_events,
                "technical": counts, "deliveryStates": dict(sorted(states.items())),
                "reconciliationStates": dict(sorted(recon.items())),
                "technicalSuccessRate": _rate(counts["success"], total), "technicalFailureRate": _rate(counts["failed"], total),
                "technicalUnknownRate": _rate(counts["unknown"], total), "latency": _latency(latency),
            })
        return sorted(result, key=lambda row: row["provider"])

    def _attempt_metrics(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        counts, states = _status_counts(), defaultdict(int)
        pending = reconciled = unknown = accepted = 0
        for row in rows:
            _add_status(counts, row.get("semanticStatus"))
            state = str(row.get("deliveryState") or "").strip()
            reconciliation = str(row.get("reconciliationState") or "").strip()
            if state: states[state] += 1
            accepted += state == "accepted"
            pending += reconciliation == "pending"
            unknown += state == "unknown"
            reconciled += reconciliation == "not_required" and isinstance(row.get("lastReconciliation"), dict)
        return {"totalAttempts": len(rows), "technical": counts, "deliveryStates": dict(sorted(states.items())), "accepted": accepted, "pendingReconciliation": pending, "reconciled": reconciled, "stillUnknown": unknown}

    def _action_metrics(self, rows: list[dict[str, Any]]) -> dict[str, int]:
        resends = [row for row in rows if row.get("action") == "resend_provider_outbound"]
        return {"totalActions": len(rows), "resendTotal": len(resends), "resendCompleted": sum(row.get("status") == "completed" for row in resends), "resendFailed": sum(row.get("status") == "failed" for row in resends), "resendBlocked": sum(row.get("status") == "blocked" for row in resends)}

    def _webhook_metrics(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        counts, latency = _status_counts(), []
        for row in rows:
            _add_status(counts, row.get("semanticStatus"))
            value = _number(row.get("durationMs"))
            if value is not None: latency.append(value)
        total = len(rows)
        return {"totalDeliveries": total, "technical": counts, "testDeliveries": sum(bool(row.get("isTest")) for row in rows), "realDeliveries": sum(not bool(row.get("isTest")) for row in rows), "totalAttempts": sum(max(1, _int(row.get("attemptCount")) or 1) for row in rows), "retries": sum(max(0, _int(row.get("retryCount")) or 0) for row in rows), "technicalSuccessRate": _rate(counts["success"], total), "technicalFailureRate": _rate(counts["failed"], total), "latency": _latency(latency)}

    def _connections(self, connections: list[Any], provider_rows: list[tuple[str | None, dict[str, Any]]], webhook_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = []
        for connection in connections:
            runtime = str(getattr(connection, "technical", {}).get("legacy_instance_name") or "")
            providers = [row for instance, row in provider_rows if instance == runtime]
            webhooks = [row for row in webhook_rows if str(row.get("instanceName") or "") == runtime]
            messages = [row for row in providers if row.get("direction") in {"inbound", "outbound"}]
            result.append({
                "connectionId": str(connection.id), "connectionName": str(getattr(connection, "name", "") or connection.id), "provider": str(getattr(getattr(connection, "provider", None), "id", "") or ""),
                "totalProviderDeliveries": len(providers), "messages": len(messages),
                "failedDeliveries": sum(row.get("semanticStatus") == "failed" for row in providers),
                "unknownDeliveries": sum(row.get("semanticStatus") == "unknown" for row in providers),
                "timeoutDeliveries": sum(row.get("semanticStatus") == "timeout" for row in providers),
                "pendingReconciliation": sum(row.get("reconciliationState") == "pending" for row in providers),
                "webhookFailures": sum(row.get("semanticStatus") != "success" for row in webhooks),
            })
        return sorted(result, key=lambda row: (-(row["failedDeliveries"] + row["unknownDeliveries"] + row["webhookFailures"]), row["connectionName"].lower()))

    def _timeseries(self, providers: list[tuple[str | None, dict[str, Any]]], webhooks: list[dict[str, Any]], granularity: str) -> list[dict[str, Any]]:
        buckets: dict[str, dict[str, int]] = {}
        def add(timestamp: Any, field: str) -> None:
            value = _int(timestamp)
            if value is None: return
            key = _bucket(value, granularity)
            buckets.setdefault(key, {"bucketStartUtc": key, "messages": 0, "providerFailures": 0, "providerUnknown": 0, "webhookFailures": 0})[field] += 1
        for _instance, row in providers:
            if row.get("direction") in {"inbound", "outbound"}: add(row.get("timestamp"), "messages")
            if row.get("semanticStatus") == "failed": add(row.get("timestamp"), "providerFailures")
            if row.get("semanticStatus") == "unknown": add(row.get("timestamp"), "providerUnknown")
        for row in webhooks:
            if row.get("semanticStatus") != "success": add(row.get("timestamp"), "webhookFailures")
        return [buckets[key] for key in sorted(buckets)]


_service = AnalyticsService()


def get_analytics_service() -> AnalyticsService:
    return _service
