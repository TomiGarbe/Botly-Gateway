import asyncio

from app.services import automations


def test_automation_definition_and_execution_history_are_persistent(tmp_path, monkeypatch):
    monkeypatch.setattr(automations, "_path", lambda: tmp_path / "automations.json")
    item = automations.create_automation({
        "name": "Registrar control", "connection": "demo", "trigger": {"type": "manual"},
        "conditions": [], "actions": [{"type": "run_smoke_test", "params": {}}],
        "retryPolicy": {"maxAttempts": 0, "backoff": False},
    })

    assert item["status"] == "active"
    execution = asyncio.run(automations.execute_automation(item["id"], instances=[{"name": "demo", "status": "open"}]))

    assert execution is not None
    assert execution["status"] == "skipped"  # No test executor is simulated.
    assert automations.list_executions(automation_id=item["id"])[0]["id"] == execution["id"]
    assert automations.list_automations(connection="demo")[0]["lastResult"] == "skipped"


def test_interval_scheduler_uses_the_generic_due_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(automations, "_path", lambda: tmp_path / "automations.json")
    item = automations.create_automation({
        "name": "Intervalo", "trigger": {"type": "interval", "intervalMinutes": 1},
        "actions": [{"type": "run_smoke_test", "params": {}}], "retryPolicy": {},
    })
    assert item["nextExecutionAt"] and item["nextExecutionAt"] > item["createdAt"]
