import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.routers import operations as operations_router
from app.services import operations


def test_only_real_queue_operation_can_be_created_or_duplicated(tmp_path, monkeypatch):
    monkeypatch.setattr(operations, "_path", lambda: tmp_path / "operations.json")
    job = operations.create_job(operation_type="reconnect", targets=["one"], operator="operator")

    duplicated = operations.duplicate_job(job["id"])

    assert job["operation"]["type"] == "reconnect"
    assert duplicated and duplicated["operation"]["type"] == "reconnect"


def test_pending_real_operation_can_be_cancelled(tmp_path, monkeypatch):
    monkeypatch.setattr(operations, "_path", lambda: tmp_path / "operations.json")
    job = operations.create_job(operation_type="reconnect", targets=["one"])

    cancelled = operations.cancel_job(job["id"])

    assert cancelled and cancelled["status"] == "cancelled"


def test_retired_operations_are_rejected_and_historical_jobs_do_not_complete(tmp_path, monkeypatch):
    monkeypatch.setattr(operations, "_path", lambda: tmp_path / "operations.json")

    with pytest.raises(operations.DeprecatedOperationError):
        operations.create_job(operation_type="health_refresh", targets=["one"])
    with pytest.raises(operations.DeprecatedOperationError):
        operations.create_job(operation_type="sync_meta", targets=["one"])

    result = asyncio.run(operations._execute_target("synchronize", "one", {"name": "one"}, "historic-job"))
    assert result["status"] == "error"
    assert "retired" in str(result["error"])

    meta_result = asyncio.run(operations._execute_target("reconnect", "meta", {"name": "meta", "connectionType": "cloud"}, "meta-job"))
    assert meta_result["status"] == "error"
    assert "stateless" in str(meta_result["error"])


def test_legacy_operation_endpoint_returns_deprecation_instead_of_completed_job():
    app = FastAPI()
    app.include_router(operations_router.router)
    client = TestClient(app)

    response = client.post("/operations", json={"type": "health_refresh", "targets": ["one"]})

    assert response.status_code == 410
    assert response.headers["deprecation"] == "true"
    assert "diagnostics" in response.json()["detail"]
