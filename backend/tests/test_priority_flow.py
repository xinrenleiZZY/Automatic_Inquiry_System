"""队列优先级和全自动流程表的基础回归。"""

import asyncio

import pytest

from app import config, store
from app import handlers
from app.queue import JobQueue, handler


@pytest.mark.asyncio
async def test_priority_queue_runs_events_before_flow_steps(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "API_DB", tmp_path / "api.db")
    store.init_db()
    order: list[str] = []

    @handler("test.priority")
    async def _run(payload: dict) -> dict:
        order.append(str(payload.get("name")))
        await asyncio.sleep(0.05)
        return {"ok": True}

    q = JobQueue()
    await q.start()
    try:
        await q.submit("test.priority", {"name": "normal"}, priority=10)
        await q.submit("test.priority", {"name": "event"}, priority=0)
        await q.submit("test.priority", {"name": "flow"}, priority=20)
        await asyncio.sleep(0.7)
    finally:
        await q.stop()

    assert order == ["event", "normal", "flow"]


def test_flow_run_and_due_step(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "API_DB", tmp_path / "api.db")
    store.init_db()
    flow = store.create_flow_run(10, {"id": 10})
    step = store.create_flow_step(flow["id"], 10, 1, "advance", {"id": 10}, run_after=0)
    assert [s["id"] for s in store.due_flow_steps(limit=5)] == [step["id"]]
    assert store.claim_flow_step(step["id"]) is True
    assert store.get_flow_step(step["id"])["status"] == "queued"


def test_terminate_flow_cancels_flow_and_open_steps(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "API_DB", tmp_path / "api.db")
    store.init_db()
    flow = store.create_flow_run(10, {"id": 10})
    pending = store.create_flow_step(flow["id"], 10, 1, "collect", {"id": 10})
    running = store.create_flow_step(flow["id"], 10, 2, "audit", {"id": 10})
    done = store.create_flow_step(flow["id"], 10, 3, "audit", {"id": 10})
    store.update_flow_step(running["id"], status="running")
    store.update_flow_step(done["id"], status="done")

    result = store.terminate_flow_run(flow["id"], "测试终止")

    assert result["canceled_steps"] == 2
    assert store.get_flow_run(flow["id"])["status"] == "canceled"
    assert store.get_flow_step(pending["id"])["status"] == "canceled"
    assert store.get_flow_step(running["id"])["status"] == "canceled"
    assert store.get_flow_step(done["id"])["status"] == "done"


@pytest.mark.asyncio
async def test_flow_step_observes_current_job_cancellation(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "API_DB", tmp_path / "api.db")
    store.init_db()
    flow = store.create_flow_run(10, {"id": 10})
    step = store.create_flow_step(flow["id"], 10, 1, "collect", {"id": 10})
    job = store.create_job("flow.step", {"step_id": step["id"]}, priority=20)
    store.update_job(job["id"], status="canceled", error="任务中心终止流程")
    monkeypatch.setattr(handlers.repo, "get_campaign",
                        lambda _cid: {"id": 10, "status": "running"})

    result = await handlers._flow_step({  # noqa: SLF001
        "step_id": step["id"], "_jobId": job["id"],
    })

    assert result["stopped"] == "用户终止任务"
    assert store.get_flow_step(step["id"])["status"] == "canceled"
    assert store.get_flow_run(flow["id"])["status"] == "canceled"
