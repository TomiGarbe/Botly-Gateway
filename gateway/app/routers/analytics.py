"""Ownership-aware, read-only operational analytics."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

from app.models.analytics import AnalyticsResponse
from app.services.analytics import get_analytics_service
from app.services.authorization import require_reviewer_connection_access
from app.services.connections import ConnectionNotFoundError, get_connection_service


router = APIRouter(prefix="/analytics", tags=["analytics"])
_connections = get_connection_service()
_analytics = get_analytics_service()


def _milliseconds(value: datetime) -> int:
    normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return int(normalized.astimezone(timezone.utc).timestamp() * 1000)


async def _owned_connections(request: Request, connection_id: str | None) -> list[object]:
    if connection_id:
        try:
            selected = await _connections.get_connection(connection_id)
        except ConnectionNotFoundError:
            raise HTTPException(status_code=404, detail="Connection not found")
        require_reviewer_connection_access(request, selected)
        return [selected]
    candidates = await _connections.list_connections()
    owned = []
    for connection in candidates:
        try:
            require_reviewer_connection_access(request, connection)
        except HTTPException:
            continue
        owned.append(connection)
    return owned


def _range(
    *, preset: str, date_from: datetime | None, date_to: datetime | None, now: datetime,
) -> tuple[int, int]:
    if date_from or date_to:
        if preset != "custom" or date_from is None or date_to is None:
            raise HTTPException(status_code=422, detail="Custom analytics range requires both date_from and date_to")
        start, end = _milliseconds(date_from), _milliseconds(date_to)
    else:
        end_dt = now.astimezone(timezone.utc)
        if preset == "today":
            start_dt = end_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        elif preset == "7d":
            start_dt = end_dt - timedelta(days=7)
        elif preset == "30d":
            start_dt = end_dt - timedelta(days=30)
        else:
            start_dt = end_dt - timedelta(hours=24)
        start, end = _milliseconds(start_dt), _milliseconds(end_dt)
    if start >= end:
        raise HTTPException(status_code=422, detail="date_from must be before date_to; the end is exclusive")
    return start, end


@router.get("", response_model=AnalyticsResponse)
async def analytics_route(
    request: Request,
    preset: Literal["today", "24h", "7d", "30d", "custom"] = "24h",
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    connection_id: str | None = Query(default=None, min_length=1, max_length=128),
    granularity: Literal["hour", "day"] = "hour",
):
    """Read-only UTC range ``[date_from, date_to)`` over owned connections."""
    if preset != "custom" and (date_from or date_to):
        raise HTTPException(status_code=422, detail="Preset ranges do not accept date_from or date_to")
    if preset == "custom" and (date_from is None or date_to is None):
        raise HTTPException(status_code=422, detail="Custom analytics range requires both date_from and date_to")
    from_ms, to_ms = _range(preset=preset, date_from=date_from, date_to=date_to, now=datetime.now(timezone.utc))
    connections = await _owned_connections(request, connection_id)
    return _analytics.snapshot(connections=connections, from_ms=from_ms, to_ms=to_ms, granularity=granularity)
