"""自动流程启动前必须先把暂停任务恢复为 running。"""

import pytest

from app import config, store
from app.api import campaigns


@pytest.mark.asyncio
async def test_auto_start_resumes_paused_campaign(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "API_DB", tmp_path / "api.db")
    store.init_db()
    calls: list[tuple[str, dict]] = []

    async def fake_bridge_call(cmd: str, args: dict, timeout: int = 0) -> dict:
        calls.append((cmd, args))
        if cmd == "events.reconcile":
            return {"recovered": 1, "inserted": 0, "items": []}
        return {"id": args["id"], "status": "running"}

    monkeypatch.setattr(campaigns.bridge, "call", fake_bridge_call)
    monkeypatch.setattr(
        campaigns.repo, "get_campaign",
        lambda _cid: {"id": 8, "status": "paused"},
    )

    result = await campaigns._ensure_campaign_running(8, "tester")  # noqa: SLF001

    assert result["status"] == "running"
    assert calls == [
        ("campaign.update", {"id": 8, "patch": {"status": "running"}}),
        ("events.reconcile", {"campaignId": 8}),
    ]
