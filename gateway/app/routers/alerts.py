from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.connections import get_connection_manager
from app.services.alerts import alert_summary, evaluate_alerts, list_alerts, update_alert
from app.services.instances_contract import normalize_instance_list
from app.services.normalization import list_events

router = APIRouter(prefix="/alerts", tags=["alerts"])
_manager = get_connection_manager()


class AlertStatusUpdate(BaseModel):
    status: Literal["new", "acknowledged", "in_progress", "resolved", "dismissed"]


async def _evaluate() -> list[dict]:
    raw = await _manager.list_instances()
    instances = normalize_instance_list(raw if isinstance(raw, list) else [])
    return evaluate_alerts(instances, list_events(instance=None, limit=500))


def _scope(request: Request, instance: str | None) -> str | None:
    auth_instance = getattr(request.state, "auth_instance", None)
    if auth_instance and instance and auth_instance != instance:
        raise HTTPException(status_code=403, detail="Token no autorizado para esta instancia")
    return auth_instance or instance


@router.get("")
@router.get("/", include_in_schema=False)
async def get_alerts(request: Request, status: str | None = None, severity: str | None = None, instance: str | None = None, limit: int = 500):
    scoped = _scope(request, instance)
    await _evaluate()
    return {"items": list_alerts(status=status, severity=severity, instance=scoped, limit=limit)}


@router.get("/summary")
async def get_alert_summary(request: Request, instance: str | None = None):
    scoped = _scope(request, instance)
    await _evaluate()
    items = list_alerts(instance=scoped, limit=1000)
    return alert_summary(items)


@router.patch("/{alert_id}")
async def patch_alert(alert_id: str, body: AlertStatusUpdate, request: Request):
    item = next((candidate for candidate in list_alerts(limit=1000) if candidate.get("id") == alert_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Alerta no encontrada")
    _scope(request, str(item.get("connection") or "") or None)
    updated = update_alert(alert_id, status=body.status)
    if not updated:
        raise HTTPException(status_code=400, detail="Estado de alerta inválido")
    return updated
