"""表格编辑器：桌面窗口 + 本地服务。"""
import argparse
import atexit
import hmac
import json
import logging
import os
import queue
import secrets
import shutil
import socket
import struct
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse, parse_qs

import sheetio

APP_NAME = "表格编辑器"
APP_VERSION = "1.2.1"
MAX_BODY = 64 * 1024 * 1024
MUTEX_NAME = "Local\\SheetEditor-3f9c1a4e8b2d4c17"
ASSOC_PROGID = "SheetEditor.TableFile"
ASSOC_EXTS = (".xlsx", ".html", ".htm")
WEBVIEW2_CLIENT = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
WEBVIEW_RUNTIME_VERSION = "109.0.1518.140"
BUNDLE_MAGIC = b"SEWVBND1"
BUNDLE_TRAILER = struct.calcsize("<8sQQ")
_mutex_handle = None


def _window_owner_is_app(hwnd):
    """只认本程序自己的窗口，避免把同名文件夹的资源管理器窗口当成已运行实例。"""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return False
    handle = kernel32.OpenProcess(0x1000, False, pid.value)
    if not handle:
        return False
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return False
        name = os.path.basename(buf.value).lower()
    finally:
        kernel32.CloseHandle(handle)
    own = os.path.basename(sys.executable).lower()
    if own.startswith("python"):
        return name.startswith("python")
    return name == own


def _app_window():
    import ctypes
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def callback(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == APP_NAME and _window_owner_is_app(hwnd):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(callback, 0)
    return found[0] if found else None


def instance_file():
    return os.path.join(data_dir(), "运行实例.json")


def write_instance(port):
    payload = {
        "port": int(port),
        "token": STATE.token,
        "pid": os.getpid(),
    }
    try:
        os.makedirs(data_dir(), exist_ok=True)
        tmp = instance_file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, instance_file())
    except OSError:
        logging.exception("写入运行实例信息失败")


def remove_instance():
    try:
        with open(instance_file(), "r", encoding="utf-8") as f:
            info = json.load(f)
        if not isinstance(info, dict) or int(info.get("pid") or 0) != os.getpid():
            return
    except (OSError, ValueError, TypeError):
        return
    try:
        os.remove(instance_file())
    except OSError:
        pass


def forward_open(files, timeout=2):
    """把双击的文件交给已经运行的窗口打开。"""
    if not files:
        return False
    try:
        with open(instance_file(), "r", encoding="utf-8") as f:
            info = json.load(f)
        if not isinstance(info, dict):
            return False
        port = int(info.get("port") or 0)
        token = str(info.get("token") or "")
    except (OSError, ValueError, TypeError):
        return False
    if not port or not token:
        return False
    import urllib.request
    body = json.dumps({"paths": files}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%d/api/open-request" % port, data=body,
        headers={"Content-Type": "application/json; charset=utf-8",
                 "X-Sheet-Token": token})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return False
    return bool(payload.get("ok"))


def acquire_single_instance(files=()):
    """已有窗口在运行时把文件转交给它、切到前台并返回 False。"""
    global _mutex_handle
    if os.name != "nt":
        return True
    import ctypes
    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    kernel32.SetLastError(0)
    _mutex_handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not _mutex_handle:
        return True
    if kernel32.GetLastError() != 183:
        return True
    forwarded = not files
    hwnd = None
    # 首次启动要解压内置内核时，等久一点，不要重复开窗重复解压
    wait = 180 if (bundle_info()[0] and not runtime_cache_ready()) else 10
    deadline = time.time() + wait
    while time.time() < deadline:
        if files and not forwarded:
            forwarded = forward_open(files)
        hwnd = _app_window()
        if hwnd and (forwarded or not files):
            break
        time.sleep(0.15)
    if not hwnd:
        # 文件已经交给别的窗口时不再重复开窗
        return False if forwarded else True
    if not forwarded:
        # 转交失败（旧版本或服务未就绪）时另开一个窗口，保证文件能打开
        return True
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)
    else:
        user32.ShowWindow(hwnd, 5)
    # 前台窗口属于其他进程时 Windows 会拦截 SetForegroundWindow，
    # 先尝试附加线程，个别系统仍需按键或最小化恢复才能取得焦点。
    current = kernel32.GetCurrentThreadId()
    fg = user32.GetForegroundWindow()
    attached = []
    for win in (fg, hwnd):
        if not win:
            continue
        tid = user32.GetWindowThreadProcessId(win, None)
        if tid and tid != current and user32.AttachThreadInput(current, tid, True):
            attached.append(tid)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.SetFocus(hwnd)
    for tid in attached:
        user32.AttachThreadInput(current, tid, False)
    if user32.GetForegroundWindow() != hwnd:
        # 部分系统仍会拦截，用一次 Alt 按键解除前台锁
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        user32.SetForegroundWindow(hwnd)
        if user32.GetForegroundWindow() != hwnd:
            user32.ShowWindow(hwnd, 6)
            time.sleep(0.2)
            user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
    return False


def resource_dir():
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "static")


def data_dir():
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(os.path.abspath(base), APP_NAME)


def _system_webview2_installed():
    try:
        import winreg
    except ImportError:
        return True
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients"),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\EdgeUpdate\Clients"),
    ]
    for root, path in keys:
        try:
            with winreg.OpenKey(root, path + "\\" + WEBVIEW2_CLIENT) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
        except OSError:
            continue
        if version and str(version) != "0.0.0.0":
            return True
    return False


class _ExeReader:
    """把 exe 末尾追加的内核压缩包当成只读文件流。"""

    def __init__(self, handle, length):
        self._handle = handle
        self._left = length

    def read(self, size=-1):
        if self._left <= 0:
            return b""
        if size is None or size < 0:
            size = self._left
        data = self._handle.read(min(size, self._left))
        self._left -= len(data)
        return data

    def readable(self):
        return True

    def seekable(self):
        return False

    def close(self):
        self._handle.close()


def runtime_cache_dir():
    return os.path.join(data_dir(), "WebView2", WEBVIEW_RUNTIME_VERSION)


def runtime_cache_ready():
    runtime = runtime_cache_dir()
    required = (
        "msedgewebview2.exe",
        "msedge.dll",
        WEBVIEW_RUNTIME_VERSION + ".manifest",
        os.path.join("EBWebView", "x86", "EmbeddedBrowserWebView.dll"),
    )
    return all(os.path.isfile(os.path.join(runtime, name)) for name in required)


def bundle_info():
    """返回随 exe 追加的内核压缩包 (offset, length)；没有则返回 (0, 0)。"""
    if not getattr(sys, "frozen", False):
        return 0, 0
    try:
        total = os.path.getsize(sys.executable)
        if total <= BUNDLE_TRAILER:
            return 0, 0
        with open(sys.executable, "rb") as f:
            f.seek(-BUNDLE_TRAILER, os.SEEK_END)
            magic, offset, length = struct.unpack("<8sQQ", f.read(BUNDLE_TRAILER))
    except (OSError, struct.error):
        return 0, 0
    if magic != BUNDLE_MAGIC or not offset or not length:
        return 0, 0
    if offset + length > total - BUNDLE_TRAILER:
        return 0, 0
    return offset, length


def _show_wait_dialog(title, text):
    import ctypes
    threading.Thread(
        target=lambda: ctypes.windll.user32.MessageBoxW(
            None, text, title, 0x00000040 | 0x00010000),
        daemon=True).start()
    time.sleep(0.15)


def _close_wait_dialog(title):
    import ctypes
    hwnd = ctypes.windll.user32.FindWindowW("#32770", title)
    if hwnd:
        ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)


def extract_bundled_runtime(offset, length):
    import tarfile
    cache = runtime_cache_dir()
    part = cache + ".part"
    if os.path.isdir(part):
        shutil.rmtree(part, ignore_errors=True)
    os.makedirs(part, exist_ok=True)
    title = APP_NAME + " - 正在准备"
    _show_wait_dialog(title, "首次启动需要准备内置浏览器内核，大约需要半分钟，请稍候。")
    try:
        with open(sys.executable, "rb") as exe:
            exe.seek(offset)
            with tarfile.open(fileobj=_ExeReader(exe, length), mode="r|xz") as tar:
                for member in tar:
                    parts = [p for p in member.name.replace("\\", "/").split("/")
                             if p not in ("", ".")]
                    if not parts or ".." in parts:
                        continue
                    member.name = "/".join(parts)
                    tar.extract(member, part)
    finally:
        _close_wait_dialog(title)
    try:
        os.replace(part, cache)
    except OSError:
        if not runtime_cache_ready():
            raise
        shutil.rmtree(part, ignore_errors=True)
    return cache


def configure_webview_runtime():
    """Win7 没有系统 WebView2，改用随包携带的固定版本内核。"""
    try:
        major = sys.getwindowsversion().major
    except AttributeError:
        major = 10
    force_bundled = os.environ.get("SHEET_EDITOR_WEBVIEW_RUNTIME") == "bundled"
    if major >= 10 and not force_bundled and _system_webview2_installed():
        return
    base = getattr(sys, "_MEIPASS", "")
    legacy = os.path.join(base, "webview2") if base else ""
    if legacy and os.path.isfile(os.path.join(legacy, "msedgewebview2.exe")):
        runtime = legacy
    elif runtime_cache_ready():
        runtime = runtime_cache_dir()
    else:
        offset, length = bundle_info()
        if not offset:
            if major < 10:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    None,
                    "这台电脑没有安装 WebView2 运行库，无法显示程序窗口。\n"
                    "请改用 Win7 兼容版（文件体积更大，需在 Win7 上首次启动时准备内核）。",
                    APP_NAME, 0x00000010 | 0x00010000)
            return
        try:
            if os.path.isdir(runtime_cache_dir()):
                shutil.rmtree(runtime_cache_dir(), ignore_errors=True)
            runtime = extract_bundled_runtime(offset, length)
        except Exception:
            logging.exception("解压内置 WebView2 内核失败")
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, "内置浏览器内核解压失败，请查看日志：\n%s" % traceback.format_exc(),
                APP_NAME, 0x00000010 | 0x00010000)
            return
    os.environ["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"] = runtime
    logging.info("使用内置 WebView2 内核 %s", runtime)


def setup_logging():
    try:
        os.makedirs(os.path.join(data_dir(), "日志"), exist_ok=True)
        handler = RotatingFileHandler(
            os.path.join(data_dir(), "日志", "app.log"),
            maxBytes=1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.basicConfig(level=logging.INFO, handlers=[handler])
    except OSError:
        logging.basicConfig(level=logging.INFO)


HISTORY_LIMIT = 20
_history_lock = threading.Lock()


def history_file():
    return os.path.join(data_dir(), "历史记录.json")


def _read_history():
    try:
        with open(history_file(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    items = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "")
        key = path.lower()
        if not path or key in seen:
            continue
        seen.add(key)
        try:
            stamp = float(entry.get("time") or 0)
        except (TypeError, ValueError):
            stamp = 0
        items.append({"path": path, "name": os.path.basename(path), "time": stamp})
        if len(items) >= HISTORY_LIMIT:
            break
    return items


def _write_history(items):
    try:
        os.makedirs(data_dir(), exist_ok=True)
        tmp = history_file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, history_file())
    except OSError:
        logging.exception("写入历史记录失败")


def list_history():
    with _history_lock:
        items = _read_history()
    for item in items:
        item["exists"] = os.path.isfile(item["path"])
    return items


def add_history(paths):
    now = time.time()
    with _history_lock:
        items = _read_history()
        for raw in paths:
            path = os.path.abspath(str(raw))
            key = path.lower()
            items = [it for it in items if it["path"].lower() != key]
            items.insert(0, {"path": path, "name": os.path.basename(path), "time": now})
        del items[HISTORY_LIMIT:]
        _write_history(items)
    return list_history()


def clear_history():
    with _history_lock:
        _write_history([])


def remove_history(path):
    target = os.path.abspath(str(path)) if path else ""
    if not target:
        return 0
    key = target.lower()
    with _history_lock:
        items = _read_history()
        kept = [it for it in items if it["path"].lower() != key]
        removed = len(items) - len(kept)
        if removed:
            _write_history(kept)
    return removed


def prune_history():
    with _history_lock:
        items = _read_history()
        kept = [it for it in items if os.path.isfile(it["path"])]
        removed = len(items) - len(kept)
        if removed:
            _write_history(kept)
    return removed


DEFAULT_THEME = {"mode": "light", "accent": "#2563eb"}
_settings_lock = threading.Lock()


def settings_file():
    return os.path.join(data_dir(), "设置.json")


def _clean_theme(raw):
    raw = raw if isinstance(raw, dict) else {}
    mode = raw.get("mode")
    if mode not in ("light", "dark", "system"):
        mode = DEFAULT_THEME["mode"]
    accent = raw.get("accent")
    if not isinstance(accent, str) or len(accent) != 7 or not accent.startswith("#"):
        accent = DEFAULT_THEME["accent"]
    else:
        try:
            int(accent[1:], 16)
        except ValueError:
            accent = DEFAULT_THEME["accent"]
        else:
            accent = accent.lower()
    return {"mode": mode, "accent": accent}


def _clean_template(raw):
    raw = raw if isinstance(raw, dict) else {}
    path = str(raw.get("path") or "").strip()
    if path:
        path = os.path.abspath(path)
    return {
        "path": path,
        "openOnStart": bool(raw.get("openOnStart")),
        "useOnNew": bool(raw.get("useOnNew")),
    }


def read_settings():
    try:
        with open(settings_file(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    template = _clean_template(raw.get("template"))
    template["exists"] = bool(template["path"] and os.path.isfile(template["path"]))
    return {"theme": _clean_theme(raw.get("theme")), "template": template}


def write_settings(raw):
    current = read_settings()
    settings = {
        "theme": _clean_theme(raw.get("theme", current["theme"])),
        "template": _clean_template(raw.get("template", current["template"])),
    }
    with _settings_lock:
        try:
            os.makedirs(data_dir(), exist_ok=True)
            tmp = settings_file() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)
            os.replace(tmp, settings_file())
        except OSError:
            logging.exception("写入设置失败")
    result = read_settings()
    return result


ASSOC_BACKUP = "关联备份.json"


def _reg_write(sub, name, value, kind=None):
    import winreg
    if kind is None:
        kind = winreg.REG_SZ
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, sub, 0, winreg.KEY_WRITE) as key:
        winreg.SetValueEx(key, name, 0, kind, value)


def _reg_delete_tree(sub):
    import winreg

    def walk(path):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
                children = []
                index = 0
                while True:
                    try:
                        children.append(winreg.EnumKey(key, index))
                        index += 1
                    except OSError:
                        break
        except OSError:
            return
        for child in children:
            walk(path + "\\" + child)
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
        except OSError:
            pass

    walk(sub)


def _class_default(ext):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Classes" + "\\" + ext) as key:
            value, _ = winreg.QueryValueEx(key, "")
            return str(value or "")
    except OSError:
        return ""


def _openwith_has(ext):
    import winreg
    try:
        with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Classes\%s\OpenWithProgids" % ext) as key:
            winreg.QueryValueEx(key, ASSOC_PROGID)
            return True
    except OSError:
        return False


def _user_choice(ext):
    import winreg
    try:
        with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\%s\UserChoice" % ext) as key:
            value, _ = winreg.QueryValueEx(key, "ProgId")
            return str(value or "")
    except OSError:
        return ""


def _is_ours(progid):
    value = str(progid or "").lower()
    if not value:
        return False
    if value == ASSOC_PROGID.lower():
        return True
    exe = os.path.basename(sys.executable).lower()
    return value in (exe, "applications\\" + exe)


def assoc_status():
    items = []
    for ext in ASSOC_EXTS:
        default = _class_default(ext)
        choice = _user_choice(ext)
        effective = choice or default
        items.append({
            "ext": ext,
            "default": default,
            "userChoice": choice,
            "effective": effective,
            "isDefault": _is_ours(effective),
            "inOpenWith": _openwith_has(ext),
        })
    return items


def _assoc_command():
    exe = sys.executable
    if getattr(sys, "frozen", False):
        return '"%s" "%%1"' % exe
    return '"%s" "%s" "%%1"' % (exe, os.path.abspath(__file__))


def _read_assoc_backup():
    try:
        with open(os.path.join(data_dir(), ASSOC_BACKUP), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _write_assoc_backup(data):
    try:
        os.makedirs(data_dir(), exist_ok=True)
        with open(os.path.join(data_dir(), ASSOC_BACKUP), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("写入关联备份失败")


def register_assoc(exts):
    import winreg
    exe = sys.executable
    command = _assoc_command()
    icon = '"%s",0' % exe
    prog = r"Software\Classes" + "\\" + ASSOC_PROGID
    _reg_write(prog, "", "表格编辑器 表格文件")
    _reg_write(prog + r"\DefaultIcon", "", icon)
    _reg_write(prog + r"\shell\open\command", "", command)
    _reg_write(prog + r"\Application", "ApplicationName", APP_NAME)
    _reg_write(prog + r"\Application", "ApplicationIcon", icon)

    if getattr(sys, "frozen", False):
        app_key = r"Software\Classes\Applications" + "\\" + os.path.basename(exe)
        _reg_write(app_key, "FriendlyAppName", APP_NAME)
        _reg_write(app_key + r"\shell\open\command", "", command)
        for ext in ASSOC_EXTS:
            _reg_write(app_key + r"\SupportedTypes", ext, "")

    backup = _read_assoc_backup()
    changed = []
    for ext in exts:
        ext = str(ext).lower()
        if ext not in ASSOC_EXTS:
            continue
        if ext not in backup:
            backup[ext] = {"default": _class_default(ext)}
            _write_assoc_backup(backup)
        try:
            with winreg.CreateKeyEx(
                    winreg.HKEY_CURRENT_USER,
                    r"Software\Classes" + "\\" + ext, 0, winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, ASSOC_PROGID)
            with winreg.CreateKeyEx(
                    winreg.HKEY_CURRENT_USER,
                    r"Software\Classes\%s\OpenWithProgids" % ext,
                    0, winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, ASSOC_PROGID, 0, winreg.REG_NONE, b"")
        except OSError:
            logging.exception("关联 %s 失败", ext)
            continue
        changed.append(ext)
    try:
        import ctypes
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    except Exception:
        pass
    return changed


def unregister_assoc(exts):
    import winreg
    backup = _read_assoc_backup()
    removed = []
    for ext in exts:
        ext = str(ext).lower()
        if ext not in ASSOC_EXTS:
            continue
        try:
            if _is_ours(_class_default(ext)):
                old = (backup.get(ext) or {}).get("default") or ""
                with winreg.OpenKey(
                        winreg.HKEY_CURRENT_USER,
                        r"Software\Classes" + "\\" + ext, 0, winreg.KEY_SET_VALUE) as key:
                    if old:
                        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, old)
                    else:
                        winreg.DeleteValue(key, "")
        except OSError:
            pass
        try:
            with winreg.OpenKey(
                    winreg.HKEY_CURRENT_USER,
                    r"Software\Classes\%s\OpenWithProgids" % ext,
                    0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, ASSOC_PROGID)
        except OSError:
            pass
        removed.append(ext)
    still_used = any(_class_default(ext).lower() == ASSOC_PROGID.lower() for ext in ASSOC_EXTS)
    if not still_used:
        if getattr(sys, "frozen", False):
            exe = os.path.basename(sys.executable)
            _reg_delete_tree(r"Software\Classes\Applications" + "\\" + exe)
        _reg_delete_tree(r"Software\Classes" + "\\" + ASSOC_PROGID)
    try:
        import ctypes
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    except Exception:
        pass
    return removed


def open_default_apps():
    import subprocess
    try:
        major = sys.getwindowsversion().major
    except AttributeError:
        major = 10
    if major >= 10:
        os.startfile("ms-settings:defaultapps")
    else:
        subprocess.Popen(["control.exe", "/name", "Microsoft.DefaultPrograms"])


class DialogWorker(threading.Thread):
    """在独立线程里弹出 Windows 原生对话框，避免打包 tcl/tk 的六百多个文件。"""

    def __init__(self):
        super().__init__(daemon=True)
        self.tasks = queue.Queue()
        self.ready = threading.Event()
        self.enabled = False

    def run(self):
        try:
            import ctypes
            ctypes.windll.ole32.OleInitialize(None)
            self.enabled = True
        except Exception:
            logging.exception("初始化文件对话框失败")
        self.ready.set()
        while True:
            fn, done, box = self.tasks.get()
            try:
                box["value"] = fn()
            except Exception as exc:
                box["error"] = str(exc)
                logging.exception("文件对话框异常")
            finally:
                done.set()

    def run_dialog(self, fn):
        if not self.enabled:
            raise sheetio.SheetError("文件对话框不可用，请重新启动程序")
        done = threading.Event()
        box = {}
        self.tasks.put((fn, done, box))
        done.wait()
        if "error" in box:
            raise sheetio.SheetError(box["error"])
        return box.get("value")


class AppState:
    def __init__(self):
        self.token = os.environ.get("SHEET_EDITOR_TOKEN") or secrets.token_urlsafe(24)
        self.sheets = {}
        self.dirty = False
        self.lock = threading.Lock()
        self.pending = []
        self.dialogs = DialogWorker()

    def queue_open(self, paths):
        added = 0
        with self.lock:
            known = set(self.pending)
            for raw in paths:
                path = os.path.abspath(str(raw)) if str(raw).strip() else ""
                if path and path not in known:
                    self.pending.append(path)
                    known.add(path)
                    added += 1
        return added

    def take_pending(self):
        with self.lock:
            items = self.pending
            self.pending = []
        return items

    def add_sheet(self, template, path=""):
        sid = secrets.token_hex(8)
        with self.lock:
            self.sheets[sid] = {"template": template, "path": path}
        return sid

    def get_entry(self, sid):
        with self.lock:
            return self.sheets.get(sid)

    def set_entry(self, sid, template, path):
        with self.lock:
            self.sheets[sid] = {"template": template, "path": path}


STATE = AppState()


def _dialog_owner():
    import ctypes
    return _app_window() or ctypes.windll.user32.GetForegroundWindow()


def _filter_string(filters):
    parts = []
    for label, pattern in filters:
        parts.append("%s (%s)" % (label, pattern.replace(";", ", ")))
        parts.append(pattern)
    return "\0".join(parts) + "\0\0"


def _common_file_dialog(multi, title, initial_dir="", initial_name="", def_ext="",
                        filters=(), save=False):
    import ctypes
    from ctypes import wintypes

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", wintypes.LPARAM),
            ("lpfnHook", wintypes.LPVOID),
            ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", wintypes.LPVOID),
            ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]

    size = 65536 if multi else 1024
    buf = ctypes.create_unicode_buffer(size)
    if initial_name:
        buf.value = initial_name

    spec = OPENFILENAMEW()
    spec.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    spec.hwndOwner = _dialog_owner()
    spec.lpstrFilter = _filter_string(filters) if filters else None
    spec.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
    spec.nMaxFile = size
    spec.lpstrInitialDir = initial_dir or None
    spec.lpstrTitle = title
    spec.lpstrDefExt = def_ext or None
    flags = 0x00080000 | 0x00000008  # OFN_EXPLORER | OFN_NOCHANGEDIR
    if save:
        flags |= 0x00000002 | 0x00000800  # OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST
    else:
        flags |= 0x00001000 | 0x00000800  # OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST
        if multi:
            flags |= 0x00000200  # OFN_ALLOWMULTISELECT
    spec.Flags = flags

    api = ctypes.windll.comdlg32.GetSaveFileNameW if save else ctypes.windll.comdlg32.GetOpenFileNameW
    api.argtypes = [ctypes.POINTER(OPENFILENAMEW)]
    api.restype = wintypes.BOOL
    if not api(ctypes.byref(spec)):
        return []

    if save or not multi:
        return [buf.value]
    # 多选返回 "目录\0文件1\0文件2\0..."；个别系统直接给完整路径
    parts = [p for p in ctypes.wstring_at(buf, size).split("\0") if p]
    if not parts:
        return []
    if len(parts) == 1:
        return parts
    base = parts[0]
    return [p if os.path.isabs(p) else os.path.join(base, p) for p in parts[1:]]


def _ask_open_files():
    return _common_file_dialog(
        True, "打开表格文件",
        filters=[("表格文件", "*.xlsx;*.html;*.htm"),
                 ("Excel 文件", "*.xlsx"), ("所有文件", "*.*")])


def _ask_save_file(initial_dir="", initial_name=""):
    paths = _common_file_dialog(
        False, "保存为", initial_dir or "", initial_name or "新表格.xlsx",
        def_ext="xlsx",
        filters=[("表格文件", "*.xlsx"), ("网页表格", "*.html"), ("所有文件", "*.*")],
        save=True)
    return paths[0] if paths else ""


def _ask_folder():
    import ctypes
    from ctypes import wintypes

    class BROWSEINFOW(ctypes.Structure):
        _fields_ = [
            ("hwndOwner", wintypes.HWND),
            ("pidlRoot", wintypes.LPVOID),
            ("pszDisplayName", wintypes.LPWSTR),
            ("lpszTitle", wintypes.LPCWSTR),
            ("ulFlags", wintypes.UINT),
            ("lpfn", wintypes.LPVOID),
            ("lParam", wintypes.LPARAM),
            ("iImage", ctypes.c_int),
        ]

    shell32 = ctypes.windll.shell32
    shell32.SHBrowseForFolderW.argtypes = [ctypes.POINTER(BROWSEINFOW)]
    shell32.SHBrowseForFolderW.restype = wintypes.LPVOID
    shell32.SHGetPathFromIDListW.argtypes = [wintypes.LPVOID, wintypes.LPWSTR]
    shell32.SHGetPathFromIDListW.restype = wintypes.BOOL
    ctypes.windll.ole32.CoTaskMemFree.argtypes = [wintypes.LPVOID]

    shown = ctypes.create_unicode_buffer(260)
    info = BROWSEINFOW()
    info.hwndOwner = _dialog_owner()
    info.pszDisplayName = ctypes.cast(shown, wintypes.LPWSTR)
    info.lpszTitle = "选择文件夹"
    info.ulFlags = 0x0001 | 0x0040  # BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
    pidl = shell32.SHBrowseForFolderW(ctypes.byref(info))
    if not pidl:
        return ""
    try:
        path = ctypes.create_unicode_buffer(1024)
        return path.value if shell32.SHGetPathFromIDListW(pidl, path) else ""
    finally:
        ctypes.windll.ole32.CoTaskMemFree(pidl)


def _confirm_exit(hwnd=None):
    import ctypes
    owner = hwnd or _dialog_owner()
    result = ctypes.windll.user32.MessageBoxW(
        owner, "还有未保存的修改，确定要退出吗？", APP_NAME,
        0x00000004 | 0x00000020 | 0x00040000)  # 是/否 + 问号图标 + 置顶
    return result == 6  # IDYES


class Handler(BaseHTTPRequestHandler):
    server_version = "SheetEditor/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        logging.debug(fmt, *args)

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._host_allowed():
            return self._json({"ok": False, "error": "请求来源无效"}, 403)
        if path.startswith("/api/"):
            if not self._authorized(parsed):
                return self._json({"ok": False, "error": "访问令牌无效"}, 403)
            if path == "/api/ping":
                return self._json({"ok": True, "version": APP_VERSION, "name": APP_NAME})
            if path == "/api/history":
                return self._json({"ok": True, "items": list_history()})
            if path == "/api/settings":
                return self._json({"ok": True, "settings": read_settings()})
            return self._json({"ok": False, "error": "接口不存在"}, 404)
        self._serve_static(parsed)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._host_allowed() or not self._origin_allowed():
            return self._json({"ok": False, "error": "请求来源无效"}, 403)
        if not self._authorized(parsed):
            self.close_connection = True
            return self._json({"ok": False, "error": "访问令牌无效"}, 403)
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return self._json({"ok": False, "error": "请求格式错误"}, 400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json({"ok": False, "error": "请求格式错误"}, 400)
        if length < 0:
            return self._json({"ok": False, "error": "请求格式错误"}, 400)
        if length > MAX_BODY:
            self.close_connection = True
            return self._json({"ok": False, "error": "提交的数据过大"}, 413)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._json({"ok": False, "error": "请求格式错误"}, 400)
        if not isinstance(data, dict):
            return self._json({"ok": False, "error": "请求格式错误"}, 400)

        path = parsed.path
        try:
            if path == "/api/ping":
                return self._json({"ok": True, "version": APP_VERSION, "name": APP_NAME})
            if path == "/api/history":
                action = data.get("action")
                removed = 0
                if action == "clear":
                    clear_history()
                elif action == "remove":
                    removed = remove_history(data.get("path") or "")
                elif action == "prune":
                    removed = prune_history()
                payload = {"ok": True, "items": list_history()}
                if action in ("remove", "prune"):
                    payload["removed"] = removed
                return self._json(payload)
            if path == "/api/settings":
                if "theme" in data or "template" in data:
                    return self._json({"ok": True, "settings": write_settings(data)})
                return self._json({"ok": True, "settings": read_settings()})
            if path == "/api/template":
                return self._open_template(data)
            if path == "/api/pending":
                return self._json({"ok": True, "paths": STATE.take_pending()})
            if path == "/api/open-request":
                added = STATE.queue_open(self._paths(data))
                return self._json({"ok": True, "added": added})
            if path == "/api/assoc":
                return self._assoc(data)
            if path == "/api/open":
                return self._open(data)
            if path == "/api/save":
                return self._save(data)
            if path == "/api/export":
                return self._export(data)
            if path == "/api/dialog/open-files":
                return self._json({"ok": True, "paths": STATE.dialogs.run_dialog(_ask_open_files)})
            if path == "/api/dialog/save-file":
                return self._json({"ok": True, "path": STATE.dialogs.run_dialog(
                    lambda: _ask_save_file(data.get("dir"), data.get("name")))})
            if path == "/api/dialog/folder":
                folder = STATE.dialogs.run_dialog(_ask_folder)
                if not folder:
                    return self._json({"ok": True, "paths": []})
                return self._json({"ok": True, "paths": _list_folder(folder)})
            if path == "/api/dirty":
                STATE.dirty = bool(data.get("dirty"))
                return self._json({"ok": True})
            return self._json({"ok": False, "error": "接口不存在"}, 404)
        except sheetio.SheetError as exc:
            return self._json({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:
            logging.error("接口异常 %s\n%s", path, traceback.format_exc())
            return self._json({"ok": False, "error": "操作失败：%s" % exc}, 500)

    def _allowed_hosts(self):
        port = int(self.server.server_address[1])
        return {"127.0.0.1:%d" % port, "localhost:%d" % port}

    def _host_allowed(self):
        return (self.headers.get("Host") or "").lower() in self._allowed_hosts()

    def _origin_allowed(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.scheme == "http" and (parsed.netloc or "").lower() in self._allowed_hosts()

    def _paths(self, data):
        raw = data.get("paths")
        if not isinstance(raw, list):
            raise sheetio.SheetError("文件路径格式错误")
        return [str(item) for item in raw if str(item).strip()]

    def _table_data(self, data):
        header = data.get("header")
        rows = data.get("rows")
        if not isinstance(header, list) or not header:
            raise sheetio.SheetError("表头不能为空")
        if not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
            raise sheetio.SheetError("表格数据格式错误")
        display_rows = data.get("displayRows")
        if display_rows is not None and (
                not isinstance(display_rows, list)
                or any(not isinstance(row, list) for row in display_rows)):
            raise sheetio.SheetError("显示数据格式错误")
        return header, rows, display_rows

    def _authorized(self, parsed):
        supplied = self.headers.get("X-Sheet-Token") or ""
        if supplied and hmac.compare_digest(str(supplied), STATE.token):
            return True
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "sheet_token" and hmac.compare_digest(value, STATE.token):
                return True
        qs = parse_qs(parsed.query)
        supplied = qs.get("token", [""])[0]
        return bool(supplied) and hmac.compare_digest(str(supplied), STATE.token)

    def _assoc(self, data):
        action = data.get("action") or "status"
        raw_exts = data.get("exts") or []
        if not isinstance(raw_exts, list):
            return self._json({"ok": False, "error": "文件类型格式错误"}, 400)
        exts = [str(x).lower() for x in raw_exts]
        if action == "status":
            return self._json({"ok": True, "items": assoc_status(), "exts": list(ASSOC_EXTS)})
        if action == "apply":
            changed = register_assoc(exts)
            items = assoc_status()
            pending = [it["ext"] for it in items
                       if it["ext"] in changed and not it["isDefault"]]
            return self._json({"ok": True, "changed": changed, "items": items,
                               "needsConfirm": pending})
        if action == "remove":
            removed = unregister_assoc(exts)
            return self._json({"ok": True, "removed": removed, "items": assoc_status()})
        if action == "settings":
            open_default_apps()
            return self._json({"ok": True})
        return self._json({"ok": False, "error": "未知操作"}, 400)

    def _open(self, data):
        result = []
        errors = []
        for raw in self._paths(data):
            path = os.path.abspath(str(raw))
            try:
                sheet, template = sheetio.load_file(path)
                sid = STATE.add_sheet(template, path)
                sheet.update({
                    "id": sid,
                    "path": path,
                    "name": os.path.basename(path),
                    "size": os.path.getsize(path),
                })
                result.append(sheet)
            except sheetio.SheetError as exc:
                errors.append({"path": path, "name": os.path.basename(path), "error": str(exc)})
            except Exception as exc:
                logging.error("打开失败 %s\n%s", path, traceback.format_exc())
                errors.append({"path": path, "name": os.path.basename(path), "error": "打开失败：%s" % exc})
        if result:
            add_history([item["path"] for item in result])
        return self._json({"ok": True, "sheets": result, "errors": errors})

    def _open_template(self, data):
        path = str(data.get("path") or "")
        if not path or not os.path.isfile(path):
            return self._json({"ok": False, "error": "默认模板文件不存在，请重新设置"}, 400)
        sheet, template = sheetio.load_file(os.path.abspath(path))
        sid = STATE.add_sheet(template, "")
        sheet.update({
            "id": sid,
            "path": "",
            "sourcePath": os.path.abspath(path),
            "name": os.path.basename(path) + "（模板副本）",
            "size": os.path.getsize(path),
            "isTemplate": True,
        })
        return self._json({"ok": True, "sheet": sheet})

    def _save(self, data):
        sid = data.get("id") or ""
        entry = STATE.get_entry(sid)
        target = data.get("path") or ""
        if target:
            target = os.path.abspath(str(target))
        elif entry and entry.get("path"):
            target = entry["path"]
        if not target:
            return self._json({"ok": False, "error": "请先选择保存位置"}, 400)
        ext = os.path.splitext(target)[1].lower()
        if ext not in (".xlsx", ".html", ".htm"):
            return self._json({"ok": False, "error": "只能保存为 .xlsx、.html 或 .htm 文件"}, 400)
        header, rows, display_rows = self._table_data(data)
        template = (entry or {}).get("template")
        if template is None:
            template = sheetio.new_template()
        if ext == ".xlsx" and template.get("kind") != "xlsx":
            template = {"kind": "xlsx"}
        elif ext in (".html", ".htm") and template.get("kind") != "html":
            template = sheetio.new_template()
        result = sheetio.save_file(target, header, rows, template, backup=True,
                                   display_rows=display_rows)
        STATE.set_entry(sid, template, target)
        add_history([target])
        result.update({"ok": True, "name": os.path.basename(target)})
        return self._json(result)

    def _export(self, data):
        path = str(data.get("path") or "")
        if not path:
            return self._json({"ok": False, "error": "请选择导出位置"}, 400)
        path = os.path.abspath(path)
        ext = os.path.splitext(path)[1].lower()
        if ext not in (".xlsx", ".html", ".htm"):
            return self._json({"ok": False, "error": "只能导出为 .xlsx、.html 或 .htm 文件"}, 400)
        header, rows, display_rows = self._table_data(data)
        if ext in (".html", ".htm"):
            if display_rows is None:
                display_rows = rows
            result = sheetio.export_html(path, header, display_rows)
        else:
            result = sheetio.export_xlsx(path, header, rows,
                                         data.get("sheet_name") or "数据")
        result.update({"ok": True})
        return self._json(result)

    def _serve_static(self, parsed):
        path = parsed.path
        if path in ("", "/"):
            path = "/index.html"
        name = os.path.basename(path)
        allowed = {"index.html", "app.js", "formula.js", "style.css", "favicon.svg"}
        if name not in allowed:
            return self._json({"ok": False, "error": "页面不存在"}, 404)
        full = os.path.join(resource_dir(), name)
        if not os.path.isfile(full):
            return self._json({"ok": False, "error": "页面不存在"}, 404)
        with open(full, "rb") as f:
            body = f.read()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(os.path.splitext(name)[1], "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if name == "index.html" and self._authorized(parsed):
            self.send_header(
                "Set-Cookie",
                "sheet_token=%s; Path=/; SameSite=Strict; HttpOnly" % STATE.token)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def _list_folder(folder):
    found = []
    for name in sorted(os.listdir(folder)):
        full = os.path.join(folder, name)
        if os.path.isfile(full) and os.path.splitext(name)[1].lower() in (".xlsx", ".html", ".htm"):
            try:
                with open(full, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            if head[:1] == b"<" or head == b"PK\x03\x04":
                found.append(full)
    return found


def _free_port(preferred=0):
    if preferred:
        return preferred
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def main():
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-window", action="store_true")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--dev", action="store_true", help="页面注入 dev 调试接口（自动化测试用）")
    parser.add_argument("files", nargs="*", help="要打开的文件")
    args = parser.parse_args()

    files = []
    for raw in args.files:
        path = os.path.abspath(raw)
        if os.path.isfile(path):
            files.append(path)
        else:
            logging.warning("忽略无法打开的文件：%s", raw)

    # 调试实例与已发布程序并存：不占单实例互斥量，也不改写它的实例文件
    if not args.no_window and not args.debug and not acquire_single_instance(files):
        return

    setup_logging()
    STATE.dialogs.start()
    STATE.dialogs.ready.wait(5)

    port = _free_port(args.port)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/?token=%s" % (port, STATE.token)
    if args.dev:
        url += "&dev=1"
    logging.info("服务已启动 http://127.0.0.1:%d/", port)

    if not args.no_window:
        if not args.debug:
            write_instance(port)
            atexit.register(remove_instance)
        if files:
            STATE.queue_open(files)

    if args.no_window:
        print(url, flush=True)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    configure_webview_runtime()

    try:
        import webview
    except Exception:
        logging.exception("无法加载窗口组件，改用浏览器打开")
        webview = None

    if webview is not None:
        start_options = {"gui": "edgechromium", "private_mode": False, "debug": args.debug}
        if args.debug:
            webview.settings["REMOTE_DEBUGGING_PORT"] = 9333
            # 调试实例与正式实例隔离浏览器配置，避免同时运行时争抢用户数据目录
            start_options["storage_path"] = os.path.join(
                os.environ.get("TEMP", "."), "表格编辑器-debug")
        else:
            start_options["storage_path"] = os.path.join(data_dir(), "WebView2Profile")
        try:
            window = webview.create_window(
                APP_NAME, url, width=1380, height=860, min_size=(1080, 640),
                background_color="#f6f7f9", confirm_close=False)

            close_state = {"confirmed": False, "asking": False}

            def on_closing():
                if close_state["confirmed"]:
                    close_state["confirmed"] = False
                    return True
                if close_state["asking"]:
                    return False
                close_state["asking"] = True
                hwnd = window.native.Handle.ToInt64()

                def confirm_close():
                    try:
                        dirty = STATE.dirty
                        try:
                            current = window.evaluate_js(
                                "typeof window.__sheetHasUnsavedChanges === 'function' "
                                "? window.__sheetHasUnsavedChanges() : null")
                            if current is not None:
                                dirty = dirty or bool(current)
                                logging.info("关闭检查：页面未保存=%s，后端未保存=%s", current, STATE.dirty)
                        except Exception:
                            logging.exception("读取未保存状态失败")
                            dirty = True
                        if not dirty or STATE.dialogs.run_dialog(lambda: _confirm_exit(hwnd)):
                            close_state["confirmed"] = True
                            import ctypes
                            ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)
                    except Exception:
                        logging.exception("退出确认失败")
                    finally:
                        close_state["asking"] = False

                # pywebview 在窗口线程执行此回调，不能在这里等待页面或模态框。
                threading.Thread(target=confirm_close, daemon=True).start()
                return False

            window.events.closing += on_closing
            webview.start(**start_options)
            return
        except Exception:
            logging.exception("桌面窗口启动失败，改用浏览器打开")

    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logging.exception("程序异常退出")
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, "程序启动失败，请查看日志：\n%s" % traceback.format_exc(),
                APP_NAME, 0x10)  # MB_ICONERROR
        except Exception:
            pass
