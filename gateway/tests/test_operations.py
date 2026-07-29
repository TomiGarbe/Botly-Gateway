import asyncio

from app.services import operations


def test_bulk_job_is_queued_then_executed_with_target_history(tmp_path, monkeypatch):
    monkeypatch.setattr(operations, "_path", lambda: tmp_path / "operations.json")
    job = operations.create_job(operation_type="smoke_test", targets=["one", "two"], operator="operator")

    result = asyncio.run(operations.run_next_job(worker_id="test-worker", instances=[{"name": "one"}, {"name": "two"}]))

    assert result is not None
    assert result["status"] == "completed"
    assert result["progress"]["total"] == 2
    assert len(result["results"]) == 2
    assert all(item["status"] == "skipped" for item in result["results"])
    assert operations.worker_summary()[0]["id"] == "test-worker"


def test_pending_operation_can_be_cancelled_or_duplicated(tmp_path, monkeypatch):
    monkeypatch.setattr(operations, "_path", lambda: tmp_path / "operations.json")
    job = operations.create_job(operation_type="health_refresh", targets=["one"])

    cancelled = operations.cancel_job(job["id"])
    duplicate = operations.duplicate_job(job["id"])

    assert cancelled and cancelled["status"] == "cancelled"
    assert duplicate and duplicate["sourceJobId"] == job["id"]
