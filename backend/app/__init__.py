"""Automatic Inquiry System · 接口层（Python）。

本包只做三件事：
  1. 暴露 REST 接口给前端（8 个页面）；
  2. 用「单 worker 串行队列」仲裁所有会动浏览器的动作；
  3. 只读查询 im.db 出报表。

它不重写任何 CDP 逻辑——那些都在冻结的 tools/qianniu/** 里，
通过 tools/api/bridge.mjs 调用。
"""

__version__ = "1.0.0"
