from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.connections import get_connection_manager
from app.services.instances_contract import normalize_instance_list
from app.services.operations import OPERATION_TYPES, cancel_job, create_job, duplicate_job, get_job, list_jobs, queue_summary, retry_job

router = APIRouter(prefix="/operations", tags=["operations"])
_manager = get_connection_manager()


class OperationCreate(BaseModel):
    type: Literal["smoke_test", "reconnect", "provisioning_retry", "credentials_revalidate", "health_refresh", "reindex", "synchronize", "export", "import", "retry"]
    targets: list[str] = Field(default_factory=list, max_length=10_000)
    scope: Literal["selected", "all"] = "selected"
    operator: str | None = Field(default=None, max_length=120)
    policy: dict = Field(default_factory=dict)


def _scope(request: Request, targets: list[str]) -> list[str]:
    auth_instance = getattr(request.state, "auth_instance", None)
    if auth_instance and any(name != auth_instance for name in targets):
        raise HTTPException(status_code=403, detail="Token no autorizado para una o más conexiones")
    return [auth_instance] if auth_instance else targets


async def _all_names() -> list[str]:
    raw = await _manager.list_instances()
    return [item["name"] for item in normalize_instance_list(raw if isinstance(raw, list) else [])]


@router.get("")
@router.get("/", include_in_schema=False)
async def get_operations(request: Request, status: str | None = None, connection: str | None = None, limit: int = 500):
    auth_instance = getattr(request.state, "auth_instance", None)
    if auth_instance and connection and connection != auth_instance:
        raise HTTPException(status_code=403, detail="Token no autorizado para esta conexión")
    return {"items": list_jobs(status=status, connection=auth_instance or connection, limit=limit)}


@router.get("/summary")
async def get_operations_summary(request: Request):
    if getattr(request.state, "auth_instance", None):
        jobs = list_jobs(connection=request.state.auth_instance)
        return {"active": sum(item["status"] in {"running", "retrying"} for item in jobs), "queued": sum(item["status"] == "pending" for item in jobs), "errors": sum(item["status"] == "error" for item in jobs), "recent": jobs[:8], "workers": []}
    return queue_summary()


@router.post("")
async def post_operation(body: OperationCreate, request: Request):
    targets = await _all_names() if body.scope == "all" else body.targets
    targets = _scope(request, targets)
    try:
        return create_job(operation_type=body.type, targets=targets, operator=body.operator, policy=body.policy)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{job_id}")
async def get_operation(job_id: str, request: Request):
    job = get_job(job_id)
    if not job: raise HTTPException(status_code=404, detail="Operación no encontrada")
    _scope(request, list(job.get("targets") or []))
    return job


@router.post("/{job_id}/cancel")
async def post_cancel(job_id: str, request: Request):
    job = get_job(job_id)
    if not job: raise HTTPException(status_code=404, detail="Operación no encontrada")
    _scope(request, list(job.get("targets") or []))
    return cancel_job(job_id)


@router.post("/{job_id}/retry")
async def post_retry(job_id: str, request: Request, operator: str | None = None):
    job = get_job(job_id)
    if not job: raise HTTPException(status_code=404, detail="Operación no encontrada")
    _scope(request, list(job.get("targets") or []))
    value = retry_job(job_id, operator=operator)
    if not value: raise HTTPException(status_code=404, detail="Operación no encontrada")
    return value


@router.post("/{job_id}/duplicate")
async def post_duplicate(job_id: str, request: Request, operator: str | None = None):
    job = get_job(job_id)
    if not job: raise HTTPException(status_code=404, detail="Operación no encontrada")
    _scope(request, list(job.get("targets") or []))
    value = duplicate_job(job_id, operator=operator)
    if not value: raise HTTPException(status_code=404, detail="Operación no encontrada")
    return value
