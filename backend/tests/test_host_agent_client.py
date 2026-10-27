"""Windows host agent integration test.

Normal unit-test runs skip it. With the agent already running:

    $env:AIS_RUN_HOST_AGENT_TEST="1"
    python -m pytest backend/tests/test_host_agent_client.py -q

HOST_AGENT_URL may override the default http://127.0.0.1:7400.
"""

import os

import pytest

from app import config
from app.hostcontrol import HostAgentClient


@pytest.mark.asyncio
async def test_host_agent_snapshot_and_bridge_rpc(tmp_path, monkeypatch):
    if os.getenv("AIS_RUN_HOST_AGENT_TEST") != "1":
        pytest.skip("set AIS_RUN_HOST_AGENT_TEST=1 with the host agent running")
    if not config.HOST_AGENT_TOKEN:
        pytest.skip("HOST_AGENT_TOKEN is not configured")

    monkeypatch.setattr(config, "HOST_AGENT_REMOTE", True)
    monkeypatch.setattr(config, "HOST_AGENT_URL", os.getenv(
        "HOST_AGENT_URL", "http://127.0.0.1:7400",
    ).rstrip("/"))
    monkeypatch.setattr(config, "IM_DB", tmp_path / "im.snapshot.db")

    client = HostAgentClient()
    try:
        health = await client.ping()
        assert health["ok"] is True
        snapshot = await client.refresh_snapshot(required=True)
        assert snapshot.stat().st_size > 0
        commands = await client.rpc("bridge.commands", {})
        assert commands
    finally:
        await client.stop()
