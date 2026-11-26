# -*- coding: utf-8 -*-
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PYTHON = os.path.join(ROOT, "tools", "win7build", "python38-32", "python.exe")
APP = os.path.join(ROOT, "app.py")
RUNTIME = os.path.join(
    ROOT, "tools", "testenv", "appdata-bundled", "表格编辑器",
    "WebView2", "109.0.1518.140")


def wait_cdp(port, proc, timeout=60):
    deadline = time.time() + timeout
    url = "http://127.0.0.1:%d/json/list" % port
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("测试实例提前退出，退出码 %s" % proc.returncode)
        try:
            with opener.open(url, timeout=1) as response:
                items = json.loads(response.read().decode("utf-8"))
            if any(item.get("type") == "page" for item in items):
                return
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("CDP 端口 %d 未就绪" % port)


def stop_own(proc):
    if proc.poll() is None:
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", default=os.path.join(ROOT, "tools", "testenv", "cdp_release.js"))
    parser.add_argument("--exe", default="")
    parser.add_argument("--port", type=int, default=18767)
    parser.add_argument("--cdp-port", type=int, default=9333)
    parser.add_argument("--profile", default="cdp-run")
    args = parser.parse_args()

    if not os.path.isfile(RUNTIME + "\\msedgewebview2.exe"):
        raise RuntimeError("固定 WebView2 内核不存在：%s" % RUNTIME)
    base = os.path.join(ROOT, "tools", "testenv", args.profile)
    temp = os.path.join(base, "temp")
    local = os.path.join(base, "local")
    logs = os.path.join(base, "logs")
    for folder in (temp, local, logs):
        os.makedirs(folder, exist_ok=True)
    env = dict(os.environ)
    env.update({
        "PYTHONNOUSERSITE": "1",
        "PYTHONIOENCODING": "utf-8",
        "SHEET_EDITOR_TOKEN": "sheet-editor-cdp-smoke",
        "LOCALAPPDATA": local,
        "TEMP": temp,
        "TMP": temp,
        "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER": RUNTIME,
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": (
            "--remote-debugging-port=%d --remote-allow-origins=*" % args.cdp_port),
        "CDP_PORT": str(args.cdp_port),
    })
    if args.exe:
        command = [os.path.abspath(args.exe)]
    else:
        command = [PYTHON, APP]
    command += ["--debug", "--dev", "--port", str(args.port)]
    log_path = os.path.join(logs, "process.log")
    stream = open(log_path, "wb")
    proc = subprocess.Popen(
        command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
    try:
        wait_cdp(args.cdp_port, proc)
        result = subprocess.run(["node", os.path.abspath(args.script)], cwd=ROOT, env=env)
        return result.returncode
    finally:
        stop_own(proc)
        stream.close()
        print("测试实例日志:", log_path)


if __name__ == "__main__":
    sys.exit(main())
