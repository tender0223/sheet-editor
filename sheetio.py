"""表格读取与保存：兼容 Excel 导出的 HTML 版表格（常见于 .xlsx/.html）和标准 xlsx。"""
import html
import os
import re
import shutil
import tempfile
from datetime import date, datetime, time
from html.parser import HTMLParser

DEFAULT_HEADER = ["序号", "账号", "密码", "服", "等级", "姓名",
                  "金卡", "金币", "银币", "金矿石", "银矿石", "自定义采集"]

MAX_ROWS = 200000

NEW_HTML_HEAD = (
    '<html xmlns:x="urn:schemas-microsoft-com:office:excel">'
    '<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>'
    '<style>\n.str{mso-number-format:"\\@"}\n</style>\n'
    '<table border="1">'
)
NEW_HTML_TAIL = "\n</table>\n</html>\n"

_HTML_TABLE_RE = re.compile(r"<table\b[^>]*>", re.I)
_HTML_TABLE_END_RE = re.compile(r"</table\s*>", re.I)
_CHARSET_RE = re.compile(rb"charset\s*=\s*[\"']?\s*([A-Za-z0-9_\-]+)", re.I)
_TAG_NAME_RE = re.compile(r"<\s*([A-Za-z][\w:.-]*)")


class SheetError(Exception):
    pass


class _TableHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.table_depth = 0
        self.rows = []
        self._cells = None
        self._cell = None
        self._row_raw = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.table_depth += 1
            return
        if self.table_depth != 1:
            return
        if tag == "tr":
            self._close_row()
            self._cells = []
            self._row_raw = self.get_starttag_text() or "<tr>"
        elif tag in ("td", "th") and self._cells is not None:
            self._close_cell()
            self._cell = {
                "tag": tag,
                "raw": self.get_starttag_text() or ("<%s>" % tag),
                "text": [],
            }
        elif tag == "br" and self._cell is not None:
            self._cell["text"].append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag == "br" and self._cell is not None:
            self._cell["text"].append("\n")

    def handle_endtag(self, tag):
        if tag == "table":
            self.table_depth = max(0, self.table_depth - 1)
            return
        if self.table_depth != 1:
            return
        if tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr":
            self._close_row()

    def handle_data(self, data):
        if self._cell is not None:
            self._cell["text"].append(data)

    def _close_cell(self):
        if self._cell is None:
            return
        text = "".join(self._cell["text"]).replace("\xa0", " ")
        self._cells.append({
            "tag": self._cell["tag"],
            "raw": self._cell["raw"],
            "text": text.strip(),
        })
        self._cell = None

    def _close_row(self):
        self._close_cell()
        if self._cells is not None:
            self.rows.append({"raw": self._row_raw, "cells": self._cells})
        self._cells = None

    def close(self):
        super().close()
        self._close_row()


def _decode(raw):
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig"
    m = _CHARSET_RE.search(raw[:4096])
    if m:
        name = m.group(1).decode("ascii", "ignore").lower()
        if name in ("utf-8", "utf8"):
            try:
                return raw.decode("utf-8"), "utf-8"
            except UnicodeDecodeError:
                pass
        if name in ("gb2312", "gbk", "gb18030", "x-gbk"):
            return raw.decode("gb18030"), "gb18030"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("gb18030"), "gb18030"


def _is_xlsx(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"PK\x03\x04"
    except OSError:
        return False


def _cell_text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return ("%.10f" % value).rstrip("0").rstrip(".")
    if isinstance(value, datetime):
        if value.hour == 0 and value.minute == 0 and value.second == 0:
            return value.strftime("%Y-%m-%d")
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, (date, time)):
        return value.isoformat()
    return str(value).replace("\xa0", " ").strip()


def _trim(rows, cols):
    out = []
    for row in rows:
        row = list(row[:cols]) + [""] * max(0, cols - len(row))
        out.append(row)
    return out


def _normalize(header, data):
    while data and all(not c for c in data[-1]):
        data.pop()
    width = len(header)
    for row in data:
        last = 0
        for i, c in enumerate(row):
            if c:
                last = i + 1
        width = max(width, last)
    for row in data:
        if len(row) > width:
            del row[width:]
    width = max(width, 1)
    header = _trim([header], width)[0]
    data = _trim(data, width)
    return header, data


def load_file(path):
    """返回 (给前端的数据, 保存模板)。"""
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise SheetError("文件不存在：%s" % path)
    if os.path.getsize(path) == 0:
        raise SheetError("文件是空的：%s" % os.path.basename(path))
    if _is_xlsx(path):
        return _load_xlsx(path), {"kind": "xlsx"}
    with open(path, "rb") as f:
        raw = f.read()
    head = raw.lstrip()[:8].lower()
    if not head.startswith(b"<"):
        raise SheetError("不支持的文件格式：%s" % os.path.basename(path))
    return _load_html(raw, path)


def _load_xlsx(path):
    from openpyxl import load_workbook
    try:
        wb = load_workbook(path, read_only=True, data_only=False)
    except Exception as exc:
        raise SheetError("无法打开 Excel 文件：%s" % exc)
    try:
        ws = wb.worksheets[0]
        sheet_name = ws.title
        rows = []
        for values in ws.iter_rows(values_only=True):
            rows.append([_cell_text(v) for v in values])
            if len(rows) > MAX_ROWS:
                raise SheetError("表格行数超过 %d 行，暂不支持" % MAX_ROWS)
    finally:
        wb.close()
    if not rows:
        raise SheetError("表格没有内容：%s" % os.path.basename(path))
    header, data = _normalize(rows[0], rows[1:])
    return {
        "kind": "xlsx",
        "encoding": "Excel",
        "sheet": sheet_name,
        "header": header,
        "rows": data,
    }


def _load_html(raw, path):
    text, encoding = _decode(raw)
    m = _HTML_TABLE_RE.search(text)
    end = None
    for end in _HTML_TABLE_END_RE.finditer(text):
        pass
    if not m or not end or end.start() < m.end():
        raise SheetError("文件里没有找到表格：%s" % os.path.basename(path))
    prefix = text[:m.end()]
    suffix = text[end.start():]
    fragment = text[m.end():end.start()]

    parser = _TableHTMLParser()
    parser.table_depth = 1
    try:
        parser.feed(fragment)
        parser.close()
    except Exception as exc:
        raise SheetError("表格内容解析失败：%s" % exc)
    trs = [r for r in parser.rows if r["cells"]]
    if not trs:
        raise SheetError("文件里没有找到可用的表格数据")

    header_row = trs[0]
    data_rows = trs[1:]
    header = [c["text"] for c in header_row["cells"]]
    data = [[c["text"] for c in r["cells"]] for r in data_rows]
    header, data = _normalize(header, data)

    eol = "\r\n" if "\r\n" in text[:200000] else "\n"
    frag_start = fragment[:2000]
    m_tr = re.search(r"\n([ \t]*)<tr\b", frag_start, re.I)
    m_cell = re.search(r"\n([ \t]*)<(?:td|th)\b", frag_start, re.I)
    template = {
        "kind": "html",
        "encoding": encoding,
        "eol": eol,
        "prefix": prefix,
        "suffix": suffix,
        "header_tr": header_row["raw"],
        "data_tr": (data_rows[0]["raw"] if data_rows else ""),
        "header_cells": [c["raw"] for c in header_row["cells"]],
        "data_cells": ([c["raw"] for c in data_rows[0]["cells"]] if data_rows else []),
        "tr_indent": (m_tr.group(1) if m_tr else "  "),
        "cell_indent": (m_cell.group(1) if m_cell else (m_tr.group(1) if m_tr else "  ") + "  "),
    }
    return {
        "kind": "html",
        "encoding": "GBK" if encoding == "gb18030" else "UTF-8",
        "sheet": "",
        "header": header,
        "rows": data,
    }, template


def new_template():
    return {
        "kind": "html",
        "encoding": "utf-8",
        "eol": "\r\n",
        "prefix": NEW_HTML_HEAD,
        "suffix": NEW_HTML_TAIL,
        "header_tr": "<tr>",
        "data_tr": "<tr>",
        "header_cells": ["<th x:str>"],
        "data_cells": ["<td x:str>"],
        "tr_indent": "  ",
        "cell_indent": "    ",
    }


def _tag_of(raw, fallback):
    m = _TAG_NAME_RE.match(raw or "")
    return m.group(1).lower() if m else fallback


def _render_html(template, header, rows):
    eol = template.get("eol") or "\n"
    tr_ind = template.get("tr_indent") or "  "
    cell_ind = template.get("cell_indent") or (tr_ind + "  ")
    htr = template.get("header_tr") or "<tr>"
    dtr = template.get("data_tr") or htr
    hcells = template.get("header_cells") or ["<th x:str>"]
    dcells = template.get("data_cells") or ["<td x:str>"]
    hcells = list(hcells)
    dcells = list(dcells)
    if not hcells:
        hcells = ["<th x:str>"]
    if not dcells:
        dcells = ["<td x:str>"]

    out = [template.get("prefix", NEW_HTML_HEAD), eol]
    out.append(tr_ind + htr)
    for i, value in enumerate(header):
        raw = hcells[i] if i < len(hcells) else hcells[-1]
        out.append(eol + cell_ind + raw + _cell_html(value) + "</" + _tag_of(raw, "th") + ">")
    out.append(eol + tr_ind + "</tr>")
    for row in rows:
        out.append(eol + tr_ind + dtr)
        for i, value in enumerate(row):
            raw = dcells[i] if i < len(dcells) else dcells[-1]
            out.append(eol + cell_ind + raw + _cell_html(value) + "</" + _tag_of(raw, "td") + ">")
        out.append(eol + tr_ind + "</tr>")
    out.append(eol + template.get("suffix", NEW_HTML_TAIL))
    return "".join(out)


def _cell_html(value):
    text = "" if value is None else str(value)
    text = html.escape(text, quote=False)
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")


def _backup_dir():
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or tempfile.gettempdir()
    return os.path.join(base, "表格编辑器", "备份")


def backup_file(path):
    if not os.path.isfile(path):
        return None
    target_dir = _backup_dir()
    os.makedirs(target_dir, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(path))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    dest = os.path.join(target_dir, "%s.%s%s.bak" % (stem, stamp, ext))
    shutil.copy2(path, dest)
    _prune_backups(target_dir, stem)
    return dest


def _prune_backups(target_dir, stem):
    try:
        items = [n for n in os.listdir(target_dir) if n.startswith(stem + ".") and n.endswith(".bak")]
        if len(items) <= 80:
            return
        items.sort()
        for name in items[:-80]:
            try:
                os.remove(os.path.join(target_dir, name))
            except OSError:
                pass
    except OSError:
        pass


def _atomic_write(path, data):
    folder = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def save_file(path, header, rows, template, backup=True, display_rows=None):
    path = os.path.abspath(path)
    template = template or new_template()
    made_backup = backup_file(path) if backup else None
    if template.get("kind") == "xlsx":
        _save_xlsx(path, header, rows)
        return {"path": path, "kind": "xlsx", "encoding": "Excel", "backup": made_backup}

    text = _render_html(template, header, display_rows if display_rows is not None else rows)
    encoding = template.get("encoding") or "utf-8"
    try:
        data = text.encode(encoding, errors="strict")
    except UnicodeEncodeError as exc:
        bad = text[exc.start:exc.end]
        raise SheetError("内容里有无法用 %s 保存的字符“%s”，请改用 UTF-8 另存为" %
                         ("GBK" if encoding == "gb18030" else encoding.upper(), bad))
    _atomic_write(path, data)
    return {
        "path": path,
        "kind": "html",
        "encoding": "GBK" if encoding == "gb18030" else "UTF-8",
        "backup": made_backup,
    }


def _save_xlsx(path, header, rows):
    from openpyxl import Workbook, load_workbook
    if os.path.isfile(path) and _is_xlsx(path):
        try:
            wb = load_workbook(path)
        except Exception as exc:
            raise SheetError("无法写入 Excel 文件：%s" % exc)
        ws = wb.worksheets[0]
        if ws.max_row:
            ws.delete_rows(1, ws.max_row)
    else:
        wb = Workbook()
        ws = wb.active
        ws.title = "Sheet1"
    _write_values(ws, header, rows)
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", suffix=".xlsx", dir=folder)
    os.close(fd)
    try:
        wb.save(tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _write_values(ws, header, rows):
    for c, value in enumerate(header, 1):
        cell = ws.cell(row=1, column=c, value=value)
        cell.number_format = "@"
    for r, row in enumerate(rows, 2):
        for c, value in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=value)
            if isinstance(value, str) and value.startswith("="):
                cell.number_format = "General"
            else:
                cell.number_format = "@"


def export_html(path, header, rows):
    path = os.path.abspath(path)
    data = _render_html(new_template(), header, rows).encode("utf-8")
    _atomic_write(path, data)
    return {"path": path, "kind": "html", "encoding": "UTF-8"}


def export_xlsx(path, header, rows, sheet_name="数据"):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    path = os.path.abspath(path)
    wb = Workbook()
    ws = wb.active
    title = re.sub(r"[\\/*?:\[\]]", "_", sheet_name or "数据")[:31] or "数据"
    ws.title = title
    _write_values(ws, header, rows)
    fill = PatternFill("solid", fgColor="EFF3F8")
    font = Font(bold=True, color="1F2937")
    for c in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = fill
        cell.font = font
        cell.alignment = Alignment(horizontal="center", vertical="center")
    widths = []
    for i, name in enumerate(header):
        longest = len(str(name))
        for row in rows[:300]:
            if i < len(row):
                longest = max(longest, len(str(row[i])))
        widths.append(min(max(longest * 1.9 + 4, 9), 42))
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:%s%d" % (get_column_letter(max(1, len(header))), max(1, len(rows) + 1))
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", suffix=".xlsx", dir=folder)
    os.close(fd)
    try:
        wb.save(tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"path": path}
