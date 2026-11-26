# -*- coding: utf-8 -*-
import argparse
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PYTHON = os.path.join(ROOT, "tools", "win7build", "python38-32", "python.exe")
APP = os.path.join(ROOT, "app.py")
BASE = os.path.join(ROOT, "tools", "testenv", "close-test")
EXE = ""
TOKEN = "sheet-editor-close-smoke"
PORT = 18765
CDP_PORT = 9334
FIXTURE = os.path.join(ROOT, "tools", "testenv", "tmpfiles", "长表格.xlsx")
CDP_EVAL = os.path.join(ROOT, "tools", "testenv", "cdp_eval.js")
RUNTIME = os.path.join(
    ROOT, "tools", "testenv", "appdata-bundled", "表格编辑器",
    "WebView2", "109.0.1518.140")
START_TIMEOUT = 45
WINDOW_TIMEOUT = 30
TITLE = "表格编辑器"
WM_CLOSE = 0x0010

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetDlgItem.restype = wintypes.HWND
user32.GetDlgCtrlID.argtypes = [wintypes.HWND]
user32.GetDlgCtrlID.restype = ctypes.c_int
user32.EnumChildWindows.argtypes = [wintypes.HWND, ctypes.c_void_p, wintypes.LPARAM]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def owned_pids(proc):
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        return {proc.pid}
    children = {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
    while ok:
        children.setdefault(entry.th32ParentProcessID, []).append(entry.th32ProcessID)
        ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    kernel32.CloseHandle(snapshot)
    result = {proc.pid}
    pending = [proc.pid]
    while pending:
        parent = pending.pop()
        for child in children.get(parent, []):
            if child not in result:
                result.add(child)
                pending.append(child)
    return result


def find_windows(pid, title=TITLE, class_name=None, visible_only=True):
    found = []
    pids = {pid} if isinstance(pid, int) else set(pid)

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value not in pids:
            return True
        if visible_only and not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        if buf.value != title:
            return True
        if class_name:
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if cls.value != class_name:
                return True
        found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    return found


def wait_for(predicate, timeout, interval=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def api(action, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:%d/api/%s" % (PORT, action), data=body,
        headers={"Content-Type": "application/json", "X-Sheet-Token": TOKEN})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=3) as resp:
        return json.loads(resp.read().decode("utf-8"))


def server_ready():
    try:
        return api("ping", {})
    except Exception:
        return None


def wait_cdp(proc, timeout):
    url = "http://127.0.0.1:%d/json/list" % CDP_PORT
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("测试实例提前退出，退出码 %s" % proc.returncode)
        try:
            with opener.open(url, timeout=1) as response:
                items = json.loads(response.read().decode("utf-8"))
            if any(item.get("type") == "page" and ("127.0.0.1:%d/" % PORT) in item.get("url", "") for item in items):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def cdp_eval(expression):
    result = subprocess.run(
        ["node", CDP_EVAL, str(CDP_PORT), str(PORT), expression],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip() or "CDP 执行失败")
    return json.loads(result.stdout.decode("utf-8") or "null")


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def launch(name):
    folder = os.path.join(BASE, name)
    temp = os.path.join(folder, "temp")
    local = os.path.join(BASE, "local") if EXE else os.path.join(folder, "local")
    logs = os.path.join(folder, "logs")
    for path in (temp, local, logs):
        os.makedirs(path, exist_ok=True)
    env = dict(os.environ)
    env.update({
        "PYTHONNOUSERSITE": "1",
        "PYTHONIOENCODING": "utf-8",
        "SHEET_EDITOR_TOKEN": TOKEN,
        "LOCALAPPDATA": local,
        "TEMP": temp,
        "TMP": temp,
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": (
            "--remote-debugging-port=%d --remote-allow-origins=*" % CDP_PORT),
    })
    command = [EXE] if EXE else [PYTHON, APP]
    if EXE:
        env["SHEET_EDITOR_WEBVIEW_RUNTIME"] = "bundled"
        if name == "delayed-dirty":
            env["SHEET_EDITOR_WEBVIEW_RUNTIME"] = "system"
            env["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"] = RUNTIME
    log_path = os.path.join(logs, "process.log")
    stream = open(log_path, "wb")
    proc = subprocess.Popen(
        command + ["--debug", "--dev", "--port", str(PORT)],
        cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
    return proc, stream, log_path


def stop_own(proc, stream, log_path):
    if proc.poll() is None:
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            pass
    stream.close()
    if os.path.exists(log_path):
        print("日志:", log_path)


def close_and_wait(proc, hwnd, timeout=20):
    start = time.time()
    user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, time.time() - start
    return code, time.time() - start


def click_dialog(proc, button_id):
    def dialog():
        wins = find_windows(owned_pids(proc), TITLE, "#32770")
        return wins[0] if wins else None

    hwnd = wait_for(dialog, 10)
    if not hwnd:
        return False
    button = user32.GetDlgItem(hwnd, button_id)
    if not button:
        controls = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def callback(child, _):
            text = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(child, text, 256)
            controls.append((user32.GetDlgCtrlID(child), text.value))
            return True

        user32.EnumChildWindows(hwnd, callback, 0)
        print("确认框按钮缺失，按钮 %s，实际控件 %s" % (button_id, controls))
        return False
    user32.PostMessageW(hwnd, 0x0111, button_id, 0)
    if wait_for(lambda: not find_windows(owned_pids(proc), TITLE, "#32770"), 5) is not None:
        return True
    controls = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def callback(child, _):
        text = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(child, text, 256)
        controls.append((user32.GetDlgCtrlID(child), text.value))
        return True

    user32.EnumChildWindows(hwnd, callback, 0)
    print("确认框按钮点击后未关闭，按钮 %s，实际控件 %s" % (button_id, controls))
    return False


def scenario_clean():
    proc, stream, log_path = launch("clean")
    try:
        assert wait_for(server_ready, START_TIMEOUT), "服务未就绪"
        hwnd = wait_for(lambda: (find_windows(owned_pids(proc)) or [None])[0], WINDOW_TIMEOUT)
        assert hwnd, "窗口未出现"
        code, elapsed = close_and_wait(proc, hwnd)
        assert code is not None, "无修改关闭后进程未退出"
        print("无修改关闭通过，退出码 %s，耗时 %.1f 秒" % (code, elapsed))
    finally:
        stop_own(proc, stream, log_path)


def scenario_cancel_then_close():
    proc, stream, log_path = launch("cancel")
    try:
        assert wait_for(server_ready, START_TIMEOUT), "服务未就绪"
        hwnd = wait_for(lambda: (find_windows(owned_pids(proc)) or [None])[0], WINDOW_TIMEOUT)
        assert hwnd, "窗口未出现"
        api("dirty", {"dirty": True})
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        assert click_dialog(proc, 7), "有修改关闭时未显示确认框或“否”按钮不可用"
        time.sleep(1)
        assert proc.poll() is None, "选择“否”后进程仍退出"
        assert find_windows(owned_pids(proc)), "选择“否”后主窗口未保留"
        print("有修改选择“否”后取消关闭通过")
        api("dirty", {"dirty": False})
        code, elapsed = close_and_wait(proc, hwnd)
        assert code is not None, "取消后再次关闭进程未退出"
        print("取消后再次关闭通过，退出码 %s，耗时 %.1f 秒" % (code, elapsed))
    finally:
        stop_own(proc, stream, log_path)


def scenario_confirm_close():
    proc, stream, log_path = launch("confirm")
    try:
        assert wait_for(server_ready, START_TIMEOUT), "服务未就绪"
        hwnd = wait_for(lambda: (find_windows(owned_pids(proc)) or [None])[0], WINDOW_TIMEOUT)
        assert hwnd, "窗口未出现"
        api("dirty", {"dirty": True})
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        assert click_dialog(proc, 6), "有修改关闭时未显示确认框或“是”按钮不可用"
        code, elapsed = close_and_wait(proc, hwnd)
        assert code is not None, "选择“是”后进程未退出"
        print("有修改选择“是”关闭通过，退出码 %s，耗时 %.1f 秒" % (code, elapsed))
    finally:
        stop_own(proc, stream, log_path)


def scenario_delayed_dirty():
    proc, stream, log_path = launch("delayed-dirty")
    try:
        assert wait_for(server_ready, START_TIMEOUT), "服务未就绪"
        hwnd = wait_for(lambda: (find_windows(owned_pids(proc)) or [None])[0], WINDOW_TIMEOUT)
        assert hwnd, "窗口未出现"
        assert wait_cdp(proc, WINDOW_TIMEOUT), "CDP 未就绪"
        api("dirty", {"dirty": False})

        def page_ready():
            try:
                return cdp_eval("!!window.__sheetDev")
            except Exception:
                return False

        assert wait_for(page_ready, 30), "页面调试接口未就绪"
        expression = (
            "(async () => { const dev = window.__sheetDev; "
            "await dev.openPaths([%s]); const f = dev.state.files[0]; "
            "f.dirty = true; return !!f && window.__sheetHasUnsavedChanges(); })()"
            % json.dumps(FIXTURE))
        marked = cdp_eval(expression)
        assert marked is True, "页面未保存状态未生效"
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        assert click_dialog(proc, 6), "页面已修改但后端标记延迟时未提示关闭确认"
        start = time.time()
        try:
            code = proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            code = None
        assert code is not None, "延迟标记场景选择“是”后进程未退出"
        print("页面修改先于后端标记时关闭通过，退出码 %s，耗时 %.1f 秒" % (code, time.time() - start))
    finally:
        stop_own(proc, stream, log_path)


def main():
    global EXE, BASE, START_TIMEOUT, WINDOW_TIMEOUT, CDP_PORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", default="")
    args = parser.parse_args()
    CDP_PORT = free_port()
    if args.exe:
        EXE = os.path.abspath(args.exe)
        if not os.path.isfile(EXE):
            raise RuntimeError("成品不存在：%s" % EXE)
        BASE = os.path.join(ROOT, "tools", "testenv", "close-test-exe")
        START_TIMEOUT = 180
        WINDOW_TIMEOUT = 90
    os.makedirs(BASE, exist_ok=True)
    scenario_clean()
    scenario_cancel_then_close()
    scenario_confirm_close()
    scenario_delayed_dirty()
    print("关闭回归全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
