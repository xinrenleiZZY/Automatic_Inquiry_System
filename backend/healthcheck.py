"""容器健康检查：端口从 APP_PORT 读取，避免把端口写死在 Dockerfile / compose 里。"""

import os
import sys
import urllib.request

port = os.getenv("APP_PORT", "6900")
url = "http://127.0.0.1:" + port + "/api/health"
try:
    with urllib.request.urlopen(url, timeout=5) as resp:
        sys.exit(0 if resp.status == 200 else 1)
except Exception as exc:  # noqa: BLE001
    print("健康检查失败（" + url + "）：" + str(exc))
    sys.exit(1)
