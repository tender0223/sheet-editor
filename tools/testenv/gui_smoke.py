# -*- coding: utf-8 -*-
import ctypes
import os
import subprocess
import sys
import time

from PIL import ImageGrab

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXE = os.path.join(ROOT, "dist", "表格编辑器.exe")
SHOT = os.path.join(ROOT, "tools", "testenv", "shots", "21-exe-home.png")
TITLE = "表格编辑器"

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def find_windows():
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == TITLE and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def launch():
    env = dict(os.environ)
    env["LOCALAPPDATA"] = os.path.join(ROOT, "tools", "testenv", "appdata")
    return subprocess.Popen([EXE], cwd=ROOT, env=env)


def main():
    first = launch()
    deadline = time.time() + 40
    hwnd = 0
    while time.time() < deadline:
        wins = find_windows()
        if wins:
            hwnd = wins[0]
            break
        time.sleep(0.4)
    if not hwnd:
        print("失败: 没有找到程序窗口")
        first.terminate()
        return 1
    user32.ShowWindow(hwnd, 9)
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002)
    user32.SetForegroundWindow(hwnd)
    time.sleep(3)

    from ctypes import wintypes
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    img = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom))
    img.save(SHOT)
    user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0001 | 0x0002)
    print("截图:", SHOT, img.size)

    second = launch()
    try:
        code = second.wait(timeout=25)
    except subprocess.TimeoutExpired:
        print("失败: 第二个实例没有退出")
        second.terminate()
        return 1
    time.sleep(1.5)
    wins = find_windows()
    fg = user32.GetForegroundWindow()
    fbuf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(fg, fbuf, 256)
    print("第二个实例退出码:", code)
    print("窗口数量:", len(wins))
    print("前台窗口:", fbuf.value)
    if len(wins) != 1:
        return 1
    if fbuf.value != TITLE:
        print("警告: 前台窗口不是表格编辑器")

    user32.PostMessageW(wins[0], 0x0010, 0, 0)
    try:
        first.wait(timeout=15)
        print("主实例已退出")
    except subprocess.TimeoutExpired:
        print("失败: 主实例未退出")
        first.terminate()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
