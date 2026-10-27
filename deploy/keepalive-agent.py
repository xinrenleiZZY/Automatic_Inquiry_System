"""无窗口地执行 Host Agent 保活脚本。

为什么需要这一层：
    start-host-agent.ps1 是 PowerShell 脚本，必须由 powershell.exe 执行。
    powershell.exe 是控制台程序，即使传 -WindowStyle Hidden，
    Windows 也会先创建并显示控制台窗口、再由 PowerShell 自己隐藏，
    屏幕上仍会闪一下（实测每 5 分钟一次可见蓝底窗口）。

    pythonw.exe 是 GUI 子系统程序，自身不创建控制台；
    这里再用 CREATE_NO_WINDOW 启动 powershell.exe，
    子进程从头到尾就没有控制台窗口，因此绝不会闪。

用法（计划任务动作）：
    pythonw.exe "E:\\...\\deploy\\keepalive-agent.py"

退出码：
    0  PowerShell 执行完毕（其自身退出码通过返回值体现）
    2  start-host-agent.ps1 不存在
"""

import pathlib
import subprocess
import sys

# CREATE_NO_WINDOW：不为子进程分配控制台
CREATE_NO_WINDOW = 0x08000000

HERE = pathlib.Path(__file__).resolve().parent
START_SCRIPT = HERE / "start-host-agent.ps1"
SYSTEM_DIR = HERE.parent


def main() -> int:
    if not START_SCRIPT.is_file():
        return 2

    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", str(START_SCRIPT),
        ],
        cwd=str(SYSTEM_DIR),
        creationflags=CREATE_NO_WINDOW,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=240,
    )
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
