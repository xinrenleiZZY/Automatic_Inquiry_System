"""单 worker 串行队列 —— 全系统唯一的浏览器仲裁者。

为什么必须串行：聊天窗口是独占资源（发送/读消息都要求「当前打开的就是那个会话」）。
并发度恒为 1，所以这里不需要 Celery/Redis——要的只是「排队 + 可观测 + 可暂停」。

所有会动浏览器的动作都必须 submit 到这条队列；只读查询（repo.py）不进队列。
"""

import asyncio
import json
import time
import traceback
from typing import Any, Awaitable, Callable

from . import store

Handler = Callable[[dict], Awaitable[Any]]

_HANDLERS: dict[str, Handler] = {}


def handler(job_type: str):
    """注册作业处理器。"""

    def deco(fn: Handler) -> Handler:
        _HANDLERS[job_type] = fn
        return fn

    return deco


def known_types() -> list[str]:
    return sorted(_HANDLERS)


class JobQueue:
    def __init__(self) -> None:
        # (priority, seq, job_id)。数字越小越先执行：
        # 0=新消息事件，10=人工操作，20=全自动步骤，30=后台维护。
        self._queue: asyncio.PriorityQueue[tuple[int, int, str]] = asyncio.PriorityQueue()
        self._seq = 0
        self._worker: asyncio.Task | None = None
        self._running = False
        self._paused = False
        self._current: dict | None = None
        self._processed = 0
        self._failed = 0
        self._started_at: float | None = None

    # ------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._running and self._worker is not None and not self._worker.done()

    async def start(self) -> None:
        if self.running:
            return
        self._running = True
        self._started_at = time.time()
        self._worker = asyncio.create_task(self._loop())
        store.add_log("info", "queue", "串行队列已启动")

    async def stop(self) -> None:
        self._running = False
        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._worker = None
        store.add_log("info", "queue", "串行队列已停止")

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    # ------------------------------------------------------------------
    async def submit(self, job_type: str, payload: dict | None = None,
                     created_by: str = "", priority: int = 10) -> dict:
        if job_type not in _HANDLERS:
            raise ValueError(f"未知作业类型：{job_type}（可用：{', '.join(known_types())}）")
        if not self.running:
            await self.start()
        job = store.create_job(job_type, payload, created_by, priority=priority)
        self._seq += 1
        await self._queue.put((int(priority), self._seq, job["id"]))
        return job

    def progress(self, job_id: str, text: str, step: int | None = None) -> None:
        cur = store.get_job(job_id) or {}
        prog = cur.get("progress") or {}
        if not isinstance(prog, dict):
            prog = {}
        prog["text"] = text
        if step is not None:
            prog["step"] = step
        else:
            prog["step"] = int(prog.get("step") or 0) + 1
        prog["at"] = int(time.time() * 1000)
        store.update_job(job_id, progress=prog)

    # ------------------------------------------------------------------
    async def _loop(self) -> None:
        while self._running:
            if self._paused:
                await asyncio.sleep(1)
                continue
            try:
                _priority, _seq, job_id = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                raise
            # 取到任务后再确认一次暂停状态：
            # 否则"暂停"时刚提交的任务会因为 worker 正阻塞在 get() 上而被立刻执行（竞态）。
            while self._paused and self._running:
                await asyncio.sleep(0.5)
            if not self._running:
                return
            await self._run_one(job_id)

    async def _run_one(self, job_id: str) -> None:
        job = store.get_job(job_id)
        if not job:
            return
        # 排队期间被取消的作业直接跳过 —— 否则"取消"只是改了个状态，照样会执行
        if job.get("status") == "canceled":
            store.add_log("info", "queue", f"作业 {job_id}（{job.get('type')}）已被取消，跳过执行")
            return
        fn = _HANDLERS.get(job.get("type") or "")
        now = int(time.time() * 1000)
        self._current = {"id": job_id, "type": job.get("type"), "started_at": now}
        store.update_job(job_id, status="running", started_at=now,
                         progress={"step": 0, "text": "开始执行", "at": now})
        # 每个作业单独留一份日志（source=job:<id>），「日志中心」的详情窗口直接读它
        jlog = f"job:{job_id}"
        store.add_log("info", jlog,
                      f"开始执行 {job.get('type')}｜参数 {json.dumps(job.get('payload') or {}, ensure_ascii=False)[:400]}")
        try:
            if fn is None:
                raise ValueError(f"没有注册处理器：{job.get('type')}")
            # 把作业号塞进 payload：长耗时处理器（如自动采集）要能写进度、能看"有没有被取消"
            payload = dict(job.get("payload") or {})
            payload.setdefault("_jobId", job_id)
            result = await fn(payload)
            finished = int(time.time() * 1000)
            # 长耗时作业（自动采集）可能在跑的途中被点了"停止"：
            # 它自己会优雅收尾，这里要保留 canceled 状态，别被"已完成"覆盖掉。
            if (store.get_job(job_id) or {}).get("status") == "canceled":
                store.update_job(job_id, status="canceled", result=result, finished_at=finished,
                                 progress={"text": "已停止", "at": finished})
                store.add_log("warn", jlog, f"已按用户要求停止｜用时 {int((finished - now) / 1000)}s")
            else:
                store.update_job(job_id, status="done", result=result,
                                 finished_at=finished,
                                 progress={"text": "已完成", "at": finished})
                store.add_log("info", jlog,
                              f"完成｜用时 {int((finished - now) / 1000)}s｜结果 "
                              f"{json.dumps(result, ensure_ascii=False, default=str)[:600]}")
            self._processed += 1
        except asyncio.CancelledError:
            store.update_job(job_id, status="canceled", error="队列被停止",
                             finished_at=int(time.time() * 1000))
            raise
        except Exception as exc:  # noqa: BLE001
            self._failed += 1
            detail = str(exc) or exc.__class__.__name__
            store.update_job(job_id, status="failed", error=detail,
                             finished_at=int(time.time() * 1000),
                             progress={"text": "失败：" + detail[:200],
                                       "at": int(time.time() * 1000)})
            store.add_log("error", jlog, f"失败：{detail}")
            store.add_log("error", "queue", f"作业 {job_id}（{job.get('type')}）失败：{detail}")
            store.add_log("error", "queue", traceback.format_exc()[-1500:])
            # 失败告警：推飞书群。
            # 用 create_task 放到后台跑——告警要走网络，不能卡住队列；
            # 告警本身出错也只记日志，绝不影响上面这条失败记录。
            try:
                from .alerts import notify_job_failure
                failed_job = {
                    **(job or {}),
                    "status": "failed",
                    "error": detail,
                    "started_at": (job or {}).get("started_at") or now,
                    "finished_at": int(time.time() * 1000),
                }
                asyncio.create_task(notify_job_failure(job_id, failed_job))
            except Exception:  # noqa: BLE001
                pass
        finally:
            self._current = None

    # ------------------------------------------------------------------
    def status(self) -> dict:
        return {
            "running": self.running,
            "paused": self._paused,
            "depth": self._queue.qsize(),
            "current": self._current,
            "processed": self._processed,
            "failed": self._failed,
            "uptime_sec": int(time.time() - self._started_at) if self._started_at else 0,
            "queued_in_db": store.count_jobs("queued"),
        }


queue = JobQueue()
