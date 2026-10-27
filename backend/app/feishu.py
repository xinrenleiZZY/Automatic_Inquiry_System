"""飞书推送：一段「比价表总结」+ 该任务的「比价表文件」。

沿用 feishu_api_tools 里的约定，不自造一套：
  - 应用机器人：FEISHU_APP_ID / FEISHU_APP_SECRET 换 tenant_access_token，
    用 im/v1/messages 发送；接收方优先 FEISHU_GROUP_WHITELIST（可多个群），
    否则用 FEISHU_CHAT_ID。
  - 自定义机器人：没配应用机器人时退回 FEISHU_WEBHOOK_URL（只能发文本卡片，
    发不了文件 —— 飞书 Webhook 本身不支持文件消息）。

比它多出来的能力（本次需求要用的）：
  - upload_file()：im/v1/files 上传，拿 file_key
  - send_file() ：msg_type=file 把文件发进群

未配置时所有方法都返回 False/None，不会抛异常打断作业。
"""

import json
import logging
import time
from pathlib import Path

import httpx

from . import config

logger = logging.getLogger(__name__)

OPEN_FEISHU_BASE = "https://open.feishu.cn/open-apis"

# 飞书不限类型的文件类型；xls/pdf 等会被飞书当成对应类型预览，CSV 用 stream 最稳
DEFAULT_FILE_TYPE = "stream"
MAX_FILE_BYTES = 30 * 1024 * 1024          # 飞书单文件上限


class FeishuNotifier:
    """比价表推送。用法见 send_price_report()。"""

    def __init__(self, chat_ids: list[str] | None = None) -> None:
        self.webhook_url = config.FEISHU_WEBHOOK_URL
        self.app_id = config.FEISHU_APP_ID
        self.app_secret = config.FEISHU_APP_SECRET
        self.chat_id = config.FEISHU_CHAT_ID
        self.receive_id_type = config.FEISHU_RECEIVE_ID_TYPE or "chat_id"
        if chat_ids is not None:
            self._chat_ids = [c.strip() for c in chat_ids if c and c.strip()]
        else:
            self._chat_ids = [c.strip() for c in (config.FEISHU_GROUP_WHITELIST or "").split(",") if c.strip()]
        self._token: str | None = None
        self._token_expire_at: float = 0.0

    # ------------------------------------------------------------------
    # 配置状态
    # ------------------------------------------------------------------
    @property
    def app_mode(self) -> bool:
        """是否配了应用机器人（只有它能发文件）"""
        return bool(self.app_id and self.app_secret)

    @property
    def enabled(self) -> bool:
        return self.app_mode or bool(self.webhook_url)

    @property
    def chat_ids(self) -> list[str]:
        return self._chat_ids or ([self.chat_id] if self.chat_id else [])

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "app_mode": self.app_mode,
            "webhook_mode": bool(self.webhook_url) and not self.app_mode,
            "targets": self.chat_ids,
            "can_send_file": self.app_mode,
        }

    # ------------------------------------------------------------------
    # 底层：token / 请求
    # ------------------------------------------------------------------
    async def _get_tenant_access_token(self) -> str | None:
        now = time.time()
        if self._token and self._token_expire_at > now + 60:
            return self._token
        if not self.app_mode:
            return None
        url = f"{OPEN_FEISHU_BASE}/auth/v3/tenant_access_token/internal"
        payload = {"app_id": self.app_id, "app_secret": self.app_secret}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                result = resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.error("获取飞书 tenant_access_token 失败: %s", exc)
            return None
        if result.get("code") != 0:
            logger.error("获取飞书 tenant_access_token 失败: %s", result)
            return None
        self._token = result.get("tenant_access_token")
        self._token_expire_at = now + int(result.get("expire", 7200))
        return self._token

    async def _send_via_app(self, msg_type: str, content: dict, chat_id: str | None = None) -> bool:
        """应用机器人发消息（im/v1/messages）"""
        target = chat_id or self.chat_id
        if not target:
            logger.warning("飞书未配置接收群（FEISHU_CHAT_ID / FEISHU_GROUP_WHITELIST）")
            return False
        token = await self._get_tenant_access_token()
        if not token:
            return False
        url = f"{OPEN_FEISHU_BASE}/im/v1/messages?receive_id_type={self.receive_id_type}"
        payload = {
            "receive_id": target,
            "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False),
        }
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(url, headers={"Authorization": f"Bearer {token}"}, json=payload)
                result = resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.error("飞书发送消息异常: %s", exc)
            return False
        if result.get("code") == 0:
            return True
        logger.error("飞书发送消息失败: %s", result)
        return False

    async def _send_webhook(self, payload: dict) -> bool:
        if not self.webhook_url:
            return False
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(self.webhook_url, json=payload)
                result = resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.error("飞书 Webhook 发送异常: %s", exc)
            return False
        if result.get("code") == 0:
            return True
        logger.error("飞书 Webhook 发送失败: %s", result)
        return False

    # ------------------------------------------------------------------
    # 对外：文本 / 卡片 / 文件
    # ------------------------------------------------------------------
    async def list_chats(self) -> list[dict]:
        """列出应用机器人所在的群（拿 chat_id 用）"""
        token = await self._get_tenant_access_token()
        if not token:
            return []
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{OPEN_FEISHU_BASE}/im/v1/chats?page_size=50",
                    headers={"Authorization": f"Bearer {token}"},
                )
                result = resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.error("获取飞书群列表失败: %s", exc)
            return []
        if result.get("code") != 0:
            logger.error("获取飞书群列表失败: %s", result)
            return []
        return (result.get("data") or {}).get("items", [])

    async def send_text(self, text: str, chat_id: str | None = None) -> bool:
        """发一段纯文本（发到指定群或默认群）"""
        if not self.enabled:
            logger.warning("飞书未配置，跳过发送")
            return False
        if self.app_mode:
            targets = [chat_id] if chat_id else self.chat_ids
            if not targets:
                logger.warning("飞书未配置接收群（FEISHU_CHAT_ID / FEISHU_GROUP_WHITELIST）")
                return False
            ok = False
            for cid in targets:
                if await self._send_via_app("text", {"text": text}, chat_id=cid):
                    ok = True
            return ok
        return await self._send_webhook({"msg_type": "text", "content": {"text": text}})

    async def send_card(self, card: dict, chat_id: str | None = None) -> bool:
        """发交互卡片（比价表总结用这个）"""
        if not self.enabled:
            logger.warning("飞书未配置，跳过发送")
            return False
        if self.app_mode:
            targets = [chat_id] if chat_id else self.chat_ids
            if not targets:
                logger.warning("飞书未配置接收群（FEISHU_CHAT_ID / FEISHU_GROUP_WHITELIST）")
                return False
            ok = False
            for cid in targets:
                if await self._send_via_app("interactive", card, chat_id=cid):
                    ok = True
            return ok
        return await self._send_webhook({"msg_type": "interactive", "card": card})

    async def upload_file(self, path: str | Path, file_type: str = DEFAULT_FILE_TYPE) -> str | None:
        """上传文件到飞书，返回 file_key（只有应用机器人能做）"""
        p = Path(path)
        if not self.app_mode:
            logger.warning("飞书发文件需应用机器人模式（FEISHU_APP_ID/FEISHU_APP_SECRET）")
            return None
        if not p.is_file():
            logger.error("飞书上传失败：文件不存在 %s", p)
            return None
        if p.stat().st_size > MAX_FILE_BYTES:
            logger.error("飞书上传失败：文件超过 30MB %s", p)
            return None
        token = await self._get_tenant_access_token()
        if not token:
            return None
        try:
            with p.open("rb") as fh:
                files = {"file": (p.name, fh.read(), "application/octet-stream")}
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{OPEN_FEISHU_BASE}/im/v1/files",
                    headers={"Authorization": f"Bearer {token}"},
                    data={"file_type": file_type, "file_name": p.name},
                    files=files,
                )
                result = resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.error("飞书上传文件异常: %s", exc)
            return None
        if result.get("code") == 0:
            return (result.get("data") or {}).get("file_key")
        logger.error("飞书上传文件失败: %s", result)
        return None

    async def send_file(self, path: str | Path, chat_id: str | None = None,
                        file_type: str = DEFAULT_FILE_TYPE) -> bool:
        """把文件发到群（msg_type=file）。Webhook 模式发不了，返回 False。"""
        if not self.app_mode:
            logger.warning("飞书发文件需应用机器人模式（FEISHU_APP_ID/FEISHU_APP_SECRET）")
            return False
        file_key = await self.upload_file(path, file_type=file_type)
        if not file_key:
            return False
        targets = [chat_id] if chat_id else self.chat_ids
        if not targets:
            logger.warning("飞书未配置接收群（FEISHU_CHAT_ID / FEISHU_GROUP_WHITELIST）")
            return False
        ok = False
        for cid in targets:
            if await self._send_via_app("file", {"file_key": file_key}, chat_id=cid):
                ok = True
        return ok

    # ------------------------------------------------------------------
    # 对外：比价表 = 总结卡片 + 文件
    # ------------------------------------------------------------------
    async def send_price_report(self, card: dict, file_path: str | Path | None = None,
                                chat_id: str | None = None) -> dict:
        """先发总结卡片，再把比价表文件发出去。

        返回 {"ok","card_sent","file_sent","file_skipped","error","targets"}，
        便于作业结果里直接看到"发没发出去、发哪了"。
        """
        out: dict = {
            "ok": False, "card_sent": False, "file_sent": None,
            "file_skipped": False, "error": "", "targets": self.chat_ids,
        }
        if not self.enabled:
            out["error"] = ("飞书未配置：请在 .env 里设置 FEISHU_APP_ID / FEISHU_APP_SECRET / "
                            "FEISHU_CHAT_ID（或 FEISHU_WEBHOOK_URL）")
            return out

        out["card_sent"] = await self.send_card(card, chat_id=chat_id)

        if file_path is None:
            out["file_skipped"] = True
        elif not self.app_mode:
            out["file_skipped"] = True
            out["error"] = "当前是 Webhook 模式，飞书自定义机器人不支持文件消息，只发了总结"
        else:
            out["file_sent"] = await self.send_file(file_path, chat_id=chat_id)
            if not out["file_sent"]:
                out["error"] = "比价表文件发送失败（看服务日志里的飞书返回码）"

        out["ok"] = bool(out["card_sent"]) and (out["file_sent"] is not False)
        return out


notifier = FeishuNotifier()
