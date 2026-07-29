from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.connections import get_connection_manager
from app.services.automations import create_automation, execute_automation, get_automation, list_automations, list_executions, summary, update_automation
from app.services.instances_contract import normalize_instance_list

router = APIRouter(prefix="/automations", tags=["automations"])
_manager = get_connection_manager()


class AutomationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    provider: str | None = Field(default=None, max_length=120)
    company: str | None = Field(default=None, max_length=120)
    connection: str | None = Field(default=None, max_length=64)
    trigger: dict[str, Any] = Field(default_factory=lambda: {"type": "manual"})
    conditions: list[dict[str, Any]] = Field(default_factory=list)
    actions: list[dict[str, Any]] = Field(default_factory=list)
    retryPolicy: dict[str, Any] = Field(default_factory=dict)


class AutomationUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    provider: str | None = Field(default=None, max_length=120)
    company: str | None = Field(default=None, max_length=120)
    connection: str | None = Field(default=None, max_length=64)
    status: Literal["active", "paused", "error"] | None = None
    trigger: dict[str, Any] | None = None
    conditions: list[dict[str, Any]] | None = None
    actions: list[dict[str, Any]] | None = None
    retryPolicy: dict[str, Any] | None = None


def _scope(request: Request, connection: str | None) -> str | None:
    auth_instance = getattr(request.state, "auth_instance", None)
    if auth_instance and connection and auth_instance != connection:
        raise HTTPException(status_code=403, detail="Token no autorizado para esta conexión")
    return auth_instance or connection


async def _instances() -> list[dict[str, Any]]:
    raw = await _manager.list_instances()
    return normalize_instance_list(raw if isinstance(raw, list) else [])


@router.get("")
@router.get("/", include_in_schema=False)
async def get_automations(request: Request, status: str | None = None, connection: str | None = None):
    return {"items": list_automations(status=status, connection=_scope(request, connection))}


@router.get("/summary")
async def get_summary(request: Request):
    scoped = _scope(request, None)
    if not scoped:
        return summary()
    items = list_automations(connection=scoped)
    executions = list_executions(connection=scoped, limit=20)
    return {"active": sum(item.get("status") == "active" for item in items), "paused": sum(item.get("status") == "paused" for item in items), "errors": sum(item.get("status") == "error" for item in items), "failedExecutions": sum(item.get("status") == "failed" for item in executions), "recentExecutions": executions[:8]}


@router.get("/executions")
async def get_executions(request: Request, automationId: str | None = None, connection: str | None = None, limit: int = 500):
    return {"items": list_executions(automation_id=automationId, connection=_scope(request, connection), limit=limit)}


@router.post("")
async def post_automation(body: AutomationCreate, request: Request):
    payload = body.model_dump()
    payload["connection"] = _scope(request, payload.get("connection"))
    try:
        return create_automation(payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/{automation_id}")
async def patch_automation(automation_id: str, body: AutomationUpdate, request: Request):
    current = get_automation(automation_id)
    if not current:
        raise HTTPException(status_code=404, detail="Automatización no encontrada")
    payload = body.model_dump(exclude_unset=True)
    _scope(request, str(payload.get("connection") or current.get("connection") or "") or None)
    try:
        updated = update_automation(automation_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Automatización no encontrada")
    return updated


@router.post("/{automation_id}/execute")
async def post_execute(automation_id: str, request: Request, operator: str | None = None):
    automation = get_automation(automation_id)
    if not automation:
        raise HTTPException(status_code=404, detail="Automatización no encontrada")
    _scope(request, str(automation.get("connection") or "") or None)
    execution = await execute_automation(automation_id, instances=await _instances(), trigger="manual", operator=operator)
    if not execution:
        raise HTTPException(status_code=404, detail="Automatización no encontrada")
    return execution
