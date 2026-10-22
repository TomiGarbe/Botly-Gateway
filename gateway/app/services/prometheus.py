"""Prometheus text exposition for the Gateway's own counters and Core outbox."""

import re
import time
from typing import Any

_LABEL_SAFE = re.compile(r'[\\"\n]')


def _label(value: Any) -> str:
    return _LABEL_SAFE.sub("_", str(value))


def render_metrics(pipeline: dict[str, Any], deliveries: list[dict[str, Any]], *, now_ms: int | None = None) -> str:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    lines = [
        "# HELP botly_gateway_pipeline_events_total Inbound pipeline counters since process start.",
        "# TYPE botly_gateway_pipeline_events_total counter",
    ]
    for name, value in sorted((pipeline.get("counters") or {}).items()):
        lines.append(f'botly_gateway_pipeline_events_total{{counter="{_label(name)}"}} {int(value)}')

    by_status: dict[str, int] = {}
    oldest_pending: int | None = None
    for item in deliveries:
        status = str(item.get("status") or "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        if status in {"pending", "retry", "delivering"}:
            created = int(item.get("createdAt") or 0)
            oldest_pending = created if oldest_pending is None else min(oldest_pending, created)
    lines += [
        "# HELP botly_gateway_core_outbox_deliveries Gateway -> Core deliveries currently stored, by status.",
        "# TYPE botly_gateway_core_outbox_deliveries gauge",
    ]
    for status in sorted({"pending", "retry", "delivering", "delivered", "dead_letter", "failed", *by_status}):
        lines.append(f'botly_gateway_core_outbox_deliveries{{status="{_label(status)}"}} {by_status.get(status, 0)}')
    age = max(0.0, (now_ms - oldest_pending) / 1000) if oldest_pending else 0.0
    lines += [
        "# HELP botly_gateway_core_outbox_oldest_pending_seconds Age of the oldest undelivered Core event (0 when none).",
        "# TYPE botly_gateway_core_outbox_oldest_pending_seconds gauge",
        f"botly_gateway_core_outbox_oldest_pending_seconds {age:.3f}",
    ]
    return "\n".join(lines) + "\n"
