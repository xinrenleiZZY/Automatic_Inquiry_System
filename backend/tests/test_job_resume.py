"""作业续跑回归测试（不碰浏览器、不发消息）。

用法（任意目录）：
    python backend/tests/test_job_resume.py

覆盖两点：
  1) 续跑仍沿用“每客户最多轮数”，由 task_contacts 的独立状态接着跑；
  2) skip_launch=true -> 不调用启动/联系商家，直接进入采集。
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import handlers                       # noqa: E402
from app.api.flows import _resume_rounds       # noqa: E402

FAILED: list[str] = []


def case(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'OK ' if ok else 'NG '} {name}" + (f" | {detail}" if detail else ""))
    if not ok:
        FAILED.append(name)


# --- 1) 客户独立状态续跑 --------------------------------------------------
case("续跑保留每客户 5 轮上限",
     _resume_rounds({"rounds": 5}, "客户A 第 4/5 轮") == 5)
case("没有进度也保留原轮数",
     _resume_rounds({"rounds": 3}, "") == 3)


# --- 2) skip_launch -------------------------------------------------------
async def _fake_autocollect(payload: dict) -> dict:
    return {"resumed": True, "rounds_done": payload.get("rounds")}


async def _must_not_launch(payload: dict) -> dict:
    raise AssertionError("续跑时不该调用启动/联系商家")


def check_skip_launch() -> dict:
    old_launch = handlers._campaign_launch
    old_collect = handlers._campaign_autocollect
    handlers._campaign_launch = _must_not_launch       # type: ignore[assignment]
    handlers._campaign_autocollect = _fake_autocollect  # type: ignore[assignment]
    try:
        return asyncio.run(handlers._campaign_fullauto({
            "id": 7, "skip_launch": True, "resume_of": "j_old",
            "rounds": 2, "send_feishu": False,
        }))
    finally:
        handlers._campaign_launch = old_launch          # type: ignore[assignment]
        handlers._campaign_autocollect = old_collect    # type: ignore[assignment]


res = check_skip_launch()
case("续跑跳过启动阶段", res.get("launch", {}).get("skipped") is True)
case("续跑保留来源作业号", res.get("launch", {}).get("resume_of") == "j_old")
case("续跑进入采集阶段", res.get("autocollect", {}).get("resumed") is True)

print()
if FAILED:
    print(f"共 {len(FAILED)} 项失败：" + "、".join(FAILED))
    sys.exit(1)
print("全部通过：作业续跑逻辑正常")
