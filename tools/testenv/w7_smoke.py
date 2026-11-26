# -*- coding: utf-8 -*-
"""验证单文件：带文件参数启动、二次启动转交、窗口出现耗时。"""
import ctypes
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXE = os.path.join(ROOT, "dist", "表格编辑器.exe")
APPDATA = os.path.join(ROOT, "tools", "testenv", "appdata-w7")
FILE1 = os.path.join(os.environ["TEMP"], "sheet-dblclick.xlsx")
FILE2 = os.path.join(os.environ["TEMP"], "sheet-dblclick-2.xlsx")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def find_window():
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == "表格编辑器":
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(callback, 0)
    return found[0] if found else None


def launch(args):
    env = dict(os.environ)
    env["LOCALAPPDATA"] = APPDATA
    return subprocess.Popen([EXE] + args, cwd=ROOT, env=env)


def wait_window(deadline):
    while time.time() < deadline:
        hwnd = find_window()
        if hwnd:
            return hwnd
        time.sleep(0.2)
    return None


def main():
    os.makedirs(APPDATA, exist_ok=True)
    start = time.time()
    first = launch(["--debug", FILE1])
    hwnd = wait_window(start + 60)
    if not hwnd:
        print("失败: 首次启动没有窗口")
        first.terminate()
        return 1
    print("首次启动窗口耗时 %.1f 秒" % (time.time() - start))
    time.sleep(3)

    start2 = time.time()
    second = launch([FILE2])
    try:
        code = second.wait(timeout=60)
        print("第二次启动退出码 %s，耗时 %.1f 秒" % (code, time.time() - start2))
    except subprocess.TimeoutExpired:
        print("失败: 第二次启动没有退出")
        second.terminate()
        first.terminate()
        return 1
    time.sleep(2)
    print("窗口数量:", len([1 for _ in [find_window()] if _]))
    user32.PostMessageW(hwnd, 0x0010, 0, 0)
    try:
        first.wait(timeout=20)
    except subprocess.TimeoutExpired:
        first.terminate()
        print("失败: 主进程没有退出")
        return 1
    print("主进程已退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
