const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = process.env.CDP_PORT || "9333";
const SOURCE = "D:/Autowork/项目/家族/config/4399_2026-11-19.xlsx";
const SOURCE_NATIVE = SOURCE.replace(/\//g, "\\");
const FIXTURE = path.join(ROOT, "tools", "testenv", "tmpfiles", "长表格.xlsx").replace(/\\/g, "/");
const OUT_DIR = path.join(ROOT, "tools", "testenv", "tmpfiles");
const SHOT_DIR = path.join(__dirname, "shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "通过:" : "失败:") + name + (detail === undefined ? "" : " " + JSON.stringify(detail)));
}

async function listPage() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const items = await response.json();
  return items.find((item) => item.type === "page" && item.url.startsWith("http://127.0.0.1:"));
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data.toString());
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error("超时：" + method));
    }, 30000);
    pending.set(mid, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error("脚本异常：" + JSON.stringify(response.exceptionDetails).slice(0, 300));
    }
    return response.result.value;
  };
  const shot = async (name) => {
    const response = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, Buffer.from(response.data, "base64"));
    console.log("截图:" + file);
  };
  return { ws, evaluate, shot, send };
}

async function waitFor(evaluate, expression, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(expression);
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error("等待超时：" + expression.slice(0, 100) + " 当前值=" + JSON.stringify(value));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

(async () => {
  let page = null;
  for (let i = 0; i < 90 && !page; i++) {
    try { page = await listPage(); } catch (_) {}
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("CDP 未就绪");
  const { ws, evaluate, shot, send } = await connect(page);
  const sourceHash = sha256(SOURCE);

  await waitFor(evaluate, "!!window.__sheetDev", Boolean);
  await evaluate(`fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: { path: "", openOnStart: false, useOnNew: false } })
  }).then(r => r.json())`);
  await evaluate(`(async () => {
    const dev = window.__sheetDev;
    let f = dev.state.files.find(x => x.name === "长表格.xlsx");
    if (!f) await dev.openPaths([${JSON.stringify(FIXTURE)}]);
    f = dev.state.files.find(x => x.name === "长表格.xlsx");
    dev.activate(f.id);
    dev.setFreezeMode("none");
    return true;
  })()`);
  await sleep(250);

  const quick = await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    dev.startEdit(0, 1, "1×2=");
    const input = dev.state.editing && dev.state.editing.input;
    if (!input) return { started: false };
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const preview = document.querySelector(".calc-preview");
    return { started: true, visible: !preview.hidden, text: preview.textContent.trim() };
  })()`);
  assert("快速计算预览显示结果 2", quick.started && quick.visible && quick.text.includes("2"), quick);
  await shot("release-quick-calc.png");
  await evaluate(`(() => {
    const ed = window.__sheetDev.state.editing;
    ed.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(200);
  const quickCommit = await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    return { raw: f.rows[0][1], active: f.activeCell, editing: !!dev.state.editing };
  })()`);
  assert("Ctrl+Enter 将 1×2= 提交为 2", quickCommit.raw === "2" && !quickCommit.editing, quickCommit);
  assert("Ctrl+Enter 光标留在原单元格", quickCommit.active && quickCommit.active.r === 0 && quickCommit.active.c === 1, quickCommit.active);

  await evaluate(`window.__sheetDev.undo()`);
  await sleep(120);
  let undoValue = await evaluate(`window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx").rows[0][1]`);
  assert("快速计算可撤销", undoValue === "项目01", undoValue);
  await evaluate(`window.__sheetDev.redo()`);
  await sleep(120);
  undoValue = await evaluate(`window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx").rows[0][1]`);
  assert("快速计算可重做", undoValue === "2", undoValue);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.startEdit(0, 1, "=SUM(C2:C4)");
    dev.state.editing.input.dispatchEvent(new Event("input", { bubbles: true }));
    dev.state.editing.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(220);
  const formula = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    const td = document.querySelector('#tbody td.cell[data-r="0"][data-c="1"]');
    return { raw: f.rows[0][1], shown: td ? td.textContent.trim() : null };
  })()`);
  assert("公式输入并显示计算结果 60", formula.raw === "=SUM(C2:C4)" && formula.shown === "60", formula);

  await evaluate(`document.querySelector('#tbody td.cell[data-r="0"][data-c="1"]').click()`);
  const selectedRefs = await evaluate(`(() => ({
    boxes: document.querySelectorAll(".ref-box").length,
    tags: [...document.querySelectorAll(".ref-tag")].map(x => x.textContent.trim()),
    handles: document.querySelectorAll(".ref-handle").length,
    editing: !!window.__sheetDev.state.editing
  }))()`);
  assert("选中公式单元格自动高亮引用区域", selectedRefs.boxes === 1 && selectedRefs.tags.includes("C2:C4") && selectedRefs.handles === 0 && !selectedRefs.editing, selectedRefs);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.startEdit(0, 1, "=SUM(A2:A4)+AVERAGE(B2:B4)+MAX(C2:C4)");
    dev.state.editing.input.dispatchEvent(new Event("input", { bubbles: true }));
    dev.state.editing.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    document.querySelector('#tbody td.cell[data-r="0"][data-c="1"]').click();
    return true;
  })()`);
  await sleep(180);
  const allFunctionRefs = await evaluate(`[...document.querySelectorAll(".ref-tag")].map(x => x.textContent.trim())`);
  assert("选中多函数公式时高亮全部引用", allFunctionRefs.length === 3 && ["A2:A4", "B2:B4", "C2:C4"].every(x => allFunctionRefs.includes(x)), allFunctionRefs);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    f.dirty = false;
    document.getElementById("btn-template").click();
    return true;
  })()`);
  await sleep(120);
  const modalRefs = await evaluate(`(() => ({
    modal: !!document.querySelector(".modal"),
    boxes: document.querySelectorAll(".ref-box").length,
    tags: document.querySelectorAll(".ref-tag").length,
    focused: document.activeElement && document.activeElement.id
  }))()`);
  assert("打开默认模板弹窗后隐藏公式引用高亮", modalRefs.modal && modalRefs.boxes === 0 && modalRefs.tags === 0, modalRefs);
  await shot("release-ref-hidden-modal.png");
  await evaluate(`(() => {
    const close = [...document.querySelectorAll(".modal-foot button")].find(b => b.textContent.trim() === "关闭");
    if (close) close.click();
    document.querySelector('#tbody td.cell[data-r="0"][data-c="1"]').click();
    return true;
  })()`);
  await sleep(80);
  const searchFocusRefs = await evaluate(`(() => {
    const search = document.getElementById("search-input");
    search.focus();
    search.value = "项目";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    return { focused: document.activeElement === search, boxes: document.querySelectorAll(".ref-box").length };
  })()`);
  assert("焦点进入搜索框后隐藏公式引用高亮", searchFocusRefs.focused && searchFocusRefs.boxes === 0, searchFocusRefs);
  await evaluate(`(() => {
    const search = document.getElementById("search-input");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('#tbody td.cell[data-r="0"][data-c="1"]').click();
    return true;
  })()`);
  await sleep(80);
  const restoredRefs = await evaluate(`document.querySelectorAll(".ref-box").length`);
  assert("重新选中公式单元格后恢复引用高亮", restoredRefs === 3, restoredRefs);
  const nameBoxRect = await evaluate(`(() => {
    const rect = document.getElementById("name-box").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: nameBoxRect.x, y: nameBoxRect.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: nameBoxRect.x, y: nameBoxRect.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: nameBoxRect.x, y: nameBoxRect.y, button: "left", clickCount: 1 });
  await sleep(80);
  const nameBoxFocus = await evaluate(`(() => ({
    focused: document.activeElement === document.getElementById("name-box"),
    boxes: document.querySelectorAll(".ref-box").length,
  }))()`);
  const nameBoxRefs = await evaluate(`(() => {
    const name = document.getElementById("name-box");
    const hidden = document.querySelectorAll(".ref-box").length === 0;
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { hidden, restored: document.querySelectorAll(".ref-box").length, gridFocused: document.activeElement === document.getElementById("grid-wrap") };
  })()`);
  assert("名称框聚焦隐藏高亮且跳转后恢复", nameBoxFocus.focused && nameBoxRefs.hidden && nameBoxRefs.restored === 3 && nameBoxRefs.gridFocused, { ...nameBoxFocus, ...nameBoxRefs });

  const tabComplete = await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.startEdit(5, 1, "=SU");
    const input = dev.state.editing.input;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const menuVisible = !document.querySelector(".ac-menu").hidden;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    const result = { menuVisible, value: input.value, start: input.selectionStart, end: input.selectionEnd, menuHidden: document.querySelector(".ac-menu").hidden };
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return result;
  })()`);
  assert("Tab 补全函数自动加右括号且光标在括号内", tabComplete.menuVisible && tabComplete.value === "=SUM()" && tabComplete.start === 5 && tabComplete.end === 5 && tabComplete.menuHidden, tabComplete);

  await evaluate(`window.__sheetDev.setFreezeMode("both")`);
  await sleep(150);
  await evaluate(`window.scrollTo(0, 0); document.getElementById("grid-wrap").scrollTop = 650; true`);
  await sleep(500);
  const frozen = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    const row = document.querySelector("#tbody tr.frozen-row");
    const wrap = document.getElementById("grid-wrap");
    return {
      first: f.freezeFirst,
      col: f.freezeCol,
      scrollTop: wrap.scrollTop,
      row: !!row,
      label: document.getElementById("freeze-label").textContent.trim(),
      rowTop: row ? row.getBoundingClientRect().top : null,
      headBottom: document.getElementById("thead").getBoundingClientRect().bottom
    };
  })()`);
  const frozenStyle = await evaluate(`(() => {
    const cell = document.querySelector("#tbody td.frozen-col");
    const head = document.querySelector("#thead th.frozen-col");
    return {
      cellPosition: cell ? getComputedStyle(cell).position : null,
      cellLeft: cell ? parseFloat(getComputedStyle(cell).left) : null,
      headPosition: head ? getComputedStyle(head).position : null,
    };
  })()`);
  assert("同时冻结首行和首列", frozen.first && frozen.col && frozen.row, { first: frozen.first, col: frozen.col, row: frozen.row });
  assert("长表格滚动后冻结行仍固定", frozen.scrollTop >= 600 && Math.abs(frozen.rowTop - frozen.headBottom) < 3, { scrollTop: frozen.scrollTop, rowTop: frozen.rowTop, headBottom: frozen.headBottom });
  assert("首列使用 sticky 固定", frozenStyle.cellPosition === "sticky" && frozenStyle.headPosition === "sticky" && frozenStyle.cellLeft > 0, frozenStyle);
  assert("冻结按钮显示当前模式", frozen.label === "冻结首行和首列", frozen.label);
  await shot("release-freeze-both.png");

  for (const mode of ["row", "col", "none"]) {
    await evaluate(`window.__sheetDev.setFreezeMode(${JSON.stringify(mode)})`);
    await sleep(100);
    const current = await evaluate(`(() => {
      const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
      return { first: f.freezeFirst, col: f.freezeCol };
    })()`);
    const expected = { row: [true, false], col: [false, true], none: [false, false] }[mode];
    assert("冻结模式切换：" + mode, current.first === expected[0] && current.col === expected[1], current);
  }

  await evaluate(`document.getElementById("grid-wrap").scrollTop = 0`);
  await sleep(200);
  await evaluate(`document.querySelector('#thead button[data-filter="2"]').click()`);
  await sleep(120);
  await evaluate(`(() => {
    const pop = document.querySelector(".filter-pop");
    const search = pop.querySelector(".filter-search");
    search.value = "800";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
  const filterCount = await evaluate(`document.querySelectorAll(".filter-value").length`);
  assert("列筛选可搜索唯一值", filterCount === 1, filterCount);
  await evaluate(`document.querySelector(".filter-value input").click()`);
  await sleep(80);
  await evaluate(`document.querySelector('.filter-pop [data-act="ok"]').click()`);
  await sleep(220);
  const filtered = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    return { filters: Object.keys(f.filters), status: document.getElementById("status-extra").textContent.trim(), visibleRows: document.querySelectorAll("#tbody tr[data-r]").length };
  })()`);
  assert("按列筛选可排除指定值", filtered.filters.length === 1 && filtered.status.includes("筛选后 79 行"), filtered);
  await evaluate(`document.getElementById("btn-clear-filter").click()`);
  await sleep(180);
  const cleared = await evaluate(`Object.keys(window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx").filters).length`);
  assert("可一次清除全部筛选", cleared === 0, cleared);

  await evaluate(`document.getElementById("btn-export").click()`);
  await sleep(100);
  const exportMenu = await evaluate(`({ hidden: document.getElementById("export-menu").hidden, items: [...document.querySelectorAll("#export-menu button")].map(b => b.textContent.trim()) })`);
  assert("导出菜单包含 Excel 和网页", !exportMenu.hidden && exportMenu.items.length === 2, exportMenu);
  await shot("release-export-menu.png");
  await evaluate(`document.getElementById("btn-export").click()`);

  const xlsxPath = path.join(OUT_DIR, "release-export.xlsx");
  const htmlPath = path.join(OUT_DIR, "release-result.html");
  const exportXlsx = await evaluate(`(async () => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: ${JSON.stringify(xlsxPath.replace(/\\/g, "/"))}, header: f.header, rows: f.rows, sheet_name: "验收" })
    });
    return response.json();
  })()`);
  assert("Excel 导出接口成功", exportXlsx.ok === true && fs.existsSync(xlsxPath) && fs.statSync(xlsxPath).size > 1000, { ok: exportXlsx.ok, bytes: fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath).size : 0 });
  const exportHtml = await evaluate(`(async () => {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: ${JSON.stringify(htmlPath.replace(/\\/g, "/"))},
        header: ["算式", "结果"],
        rows: [["=1+2", "=1+2"]],
        displayRows: [["=1+2", "3"]]
      })
    });
    return response.json();
  })()`);
  const htmlText = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
  assert("网页导出写入计算结果", exportHtml.ok === true && htmlText.includes("<table") && htmlText.includes(">3<"), { ok: exportHtml.ok });

  const attachment = await evaluate(`(async () => {
    const dev = window.__sheetDev;
    const before = dev.state.files.length;
    await dev.openPaths([${JSON.stringify(SOURCE)}]);
    await new Promise(r => setTimeout(r, 400));
    const f = dev.state.files[dev.state.files.length - 1];
    return { id: f.id, active: dev.state.activeId, opened: dev.state.files.length === before + 1, rows: f.rows.length, columns: f.header.length, header: f.header.slice(0, 3), kind: f.kind, path: f.path };
  })()`);
  assert("指定附件可打开、自动激活且规模正确", attachment.opened && attachment.id === attachment.active && attachment.rows === 367 && attachment.columns === 13, { opened: attachment.opened, active: attachment.id === attachment.active, rows: attachment.rows, columns: attachment.columns, kind: attachment.kind });
  assert("指定附件表头正确", attachment.header[0] === "序号" && attachment.header[1] === "账号" && attachment.header[2] === "密码", attachment.header);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    const attachment = dev.state.files.find(x => x.name === "4399_2026-11-19.xlsx");
    dev.activate(attachment.id);
    document.getElementById("btn-template").click();
    return true;
  })()`);
  await sleep(120);
  const templateDialog = await evaluate(`(() => {
    const modal = document.querySelector(".modal");
    return {
      title: modal && modal.querySelector(".modal-head").textContent.trim(),
      path: modal && modal.querySelector(".template-path") ? modal.querySelector(".template-path").textContent.trim() : "",
      start: modal && modal.querySelector("#template-start") ? modal.querySelector("#template-start").checked : false,
      useNew: modal && modal.querySelector("#template-new") ? modal.querySelector("#template-new").checked : false,
    };
  })()`);
  assert("可将当前附件设为默认模板", templateDialog.title === "默认模板" && templateDialog.path === SOURCE_NATIVE && templateDialog.start && templateDialog.useNew, { title: templateDialog.title, start: templateDialog.start, useNew: templateDialog.useNew });
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".modal-foot button")];
    buttons.find(b => b.textContent.trim() === "保存设置").click();
    return true;
  })()`);
  await sleep(300);
  const settings = await evaluate(`window.__sheetDev.state.settings.template`);
  assert("模板启动和新建选项已保存", settings.path === SOURCE_NATIVE && settings.exists && settings.openOnStart && settings.useOnNew, { exists: settings.exists, openOnStart: settings.openOnStart, useOnNew: settings.useOnNew });

  const beforeCopy = await evaluate(`window.__sheetDev.state.files.length`);
  await evaluate(`window.__sheetDev.openTemplate(${JSON.stringify(SOURCE)})`);
  await sleep(350);
  const copy = await evaluate(`(() => {
    const files = window.__sheetDev.state.files;
    const f = files[files.length - 1];
    return { id: f.id, count: files.length, rows: f.rows.length, path: f.path, sourcePath: f.sourcePath, isTemplate: f.isTemplate, name: f.name };
  })()`);
  assert("模板以独立副本打开", copy.count === beforeCopy + 1 && copy.rows === 367 && copy.path === "" && copy.isTemplate && copy.sourcePath === SOURCE_NATIVE, { count: copy.count, path: copy.path, isTemplate: copy.isTemplate });
  const copyEditStart = await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.startEdit(0, 0, "模板副本测试");
    const ed = dev.state.editing;
    if (!ed) return { started: false, active: dev.state.activeId };
    ed.input.dispatchEvent(new Event("input", { bubbles: true }));
    return { started: true, value: ed.input.value, fileId: ed.fileId, active: dev.state.activeId };
  })()`);
  assert("模板副本可进入编辑会话", copyEditStart.started && copyEditStart.value === "模板副本测试" && copyEditStart.fileId === copy.id && copyEditStart.fileId === copyEditStart.active, copyEditStart);
  const copyCommit = await evaluate(`(() => {
    const dev = window.__sheetDev;
    const ed = dev.state.editing;
    const f = dev.state.files.find(x => x.id === ed.fileId);
    const before = { value: ed.input.value, raw: f.rows[ed.r][ed.c], viaBar: ed.viaBar };
    window.__copyKeySeen = false;
    ed.input.addEventListener("keydown", () => { window.__copyKeySeen = true; }, { once: true });
    ed.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    return { id: f.id, before, seen: window.__copyKeySeen, editing: !!dev.state.editing, raw: f.rows[ed.r][ed.c], dirty: f.dirty };
  })()`);
  await sleep(180);
  const copyChanged = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.id === ${JSON.stringify(copy.id)});
    return f ? { value: f.rows[0][0], dirty: f.dirty } : null;
  })()`);
  assert("模板副本可编辑且标记为未保存", copyChanged && copyChanged.value === "模板副本测试" && copyChanged.dirty && !copyCommit.editing, { ...copyCommit, after: copyChanged });
  assert("编辑模板副本不写回源文件", sha256(SOURCE) === sourceHash);

  const beforeNew = await evaluate(`window.__sheetDev.state.files.length`);
  await evaluate(`document.getElementById("btn-new").click()`);
  await sleep(450);
  const newCopy = await evaluate(`(() => {
    const files = window.__sheetDev.state.files;
    const f = files[files.length - 1];
    return { count: files.length, rows: f.rows.length, isTemplate: f.isTemplate, sourcePath: f.sourcePath };
  })()`);
  assert("新建表格自动套用默认模板", newCopy.count === beforeNew + 1 && newCopy.rows === 367 && newCopy.isTemplate && newCopy.sourcePath === SOURCE_NATIVE, { count: newCopy.count, rows: newCopy.rows, isTemplate: newCopy.isTemplate });

  const editA = path.join(OUT_DIR, "regression-edit-a.xlsx").replace(/\\/g, "/");
  const editB = path.join(OUT_DIR, "regression-edit-b.xlsx").replace(/\\/g, "/");
  fs.copyFileSync(FIXTURE, editA);
  fs.copyFileSync(FIXTURE, editB);
  await evaluate(`window.__sheetDev.openPaths(${JSON.stringify([editA, editB])})`);
  await sleep(400);
  const switched = await evaluate(`(async () => {
    const dev = window.__sheetDev;
    const a = dev.state.files.find(x => x.name === "regression-edit-a.xlsx");
    const b = dev.state.files.find(x => x.name === "regression-edit-b.xlsx");
    const oldB = b.rows[0][1];
    dev.activate(a.id);
    dev.startEdit(0, 1, "文件甲修改");
    dev.state.editing.input.dispatchEvent(new Event("input", { bubbles: true }));
    dev.activate(b.id);
    return { a: a.rows[0][1], b: b.rows[0][1], oldB, editing: !!dev.state.editing };
  })()`);
  assert("切换文件会提交原文件编辑且不会串写", switched.a === "文件甲修改" && switched.b === switched.oldB && !switched.editing, switched);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    const a = dev.state.files.find(x => x.name === "regression-edit-a.xlsx");
    dev.activate(a.id);
    dev.startEdit(0, 1, "1+1=");
    dev.state.editing.input.dispatchEvent(new Event("input", { bubbles: true }));
    dev.state.editing.input.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(700);
  const savedEdit = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "regression-edit-a.xlsx");
    return { value: f.rows[0][1], dirty: f.dirty, editing: !!window.__sheetDev.state.editing };
  })()`);
  assert("Ctrl+S 先提交未完成编辑再保存", savedEdit.value === "2" && !savedEdit.dirty && !savedEdit.editing, savedEdit);

  const visibleSelection = await evaluate(`(() => {
    const dev = window.__sheetDev;
    const b = dev.state.files.find(x => x.name === "regression-edit-b.xlsx");
    b.rows[0][2] = "甲"; b.rows[1][2] = "乙"; b.rows[2][2] = "丙";
    b.filters[2] = new Set(["甲", "丙"]);
    b._visDirty = true;
    dev.activate(b.id);
    dev.selectRange(0, 2);
    return { size: b.sel.size, first: b.sel.has(0), hidden: b.sel.has(1), last: b.sel.has(2) };
  })()`);
  assert("筛选后范围选择不包含隐藏行", visibleSelection.size === 2 && visibleSelection.first && visibleSelection.last && !visibleSelection.hidden, visibleSelection);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    dev.activate(f.id);
    f.sel = new Set();
    f.activeCell = { r: 0, c: 1 };
    f.rows[0][1] = "=SUM(C2:E2)";
    window.__fillBefore = [0, 1, f.rows.length - 1].map(r => f.rows[r][1]);
    window.__fillCount = f.rows.length;
    document.getElementById("btn-fill-formula").click();
    return true;
  })()`);
  await sleep(120);
  const fillBefore = await evaluate(`window.__fillBefore`);
  const fillDialog = await evaluate(`(() => {
    const modal = document.querySelector(".modal");
    return {
      open: !!modal,
      scope: modal && modal.querySelector('input[name="fill-scope"]:checked').value,
      col: modal && modal.querySelector("#fill-col").value,
      formula: modal && modal.querySelector("#fill-formula").value,
      preview: modal && modal.querySelector("#fill-preview").textContent.trim(),
    };
  })()`);
  assert("公式填充弹窗默认整列并带入当前公式", fillDialog.open && fillDialog.scope === "all" && fillDialog.col === "1" && fillDialog.formula === "=SUM(C2:E2)", fillDialog);
  await shot("release-formula-fill.png");
  await evaluate(`(() => {
    const modal = document.querySelector(".modal");
    const input = modal.querySelector("#fill-formula");
    input.value = "=SUM($C$2:$E$2)+A2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    [...modal.querySelectorAll(".modal-foot button")].find(b => b.textContent.trim() === "开始填充").click();
    return true;
  })()`);
  await sleep(250);
  const fillApplied = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    return {
      count: f.rows.length,
      first: f.rows[0][1],
      second: f.rows[1][1],
      last: f.rows[f.rows.length - 1][1],
      rule: f.formulaFill["1"],
      modal: !!document.querySelector(".modal"),
    };
  })()`);
  assert("整列公式填充随行平移并保留绝对引用", fillApplied.first === "=SUM($C$2:$E$2)+A2" && fillApplied.second === "=SUM($C$2:$E$2)+A3" && fillApplied.last === "=SUM($C$2:$E$2)+A" + (fillApplied.count + 1) && fillApplied.rule && fillApplied.rule.baseRow === 0 && !fillApplied.modal, fillApplied);
  const fillUndo = await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.undo();
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    return { values: [0, 1, f.rows.length - 1].map(r => f.rows[r][1]), hasRule: !!f.formulaFill["1"] };
  })()`);
  assert("公式填充可撤销且恢复填充规则", JSON.stringify(fillUndo.values) === JSON.stringify(fillBefore) && !fillUndo.hasRule, fillUndo);
  const fillRedo = await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.redo();
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    return { second: f.rows[1][1], rule: f.formulaFill["1"] };
  })()`);
  assert("公式填充可重做", fillRedo.second === "=SUM($C$2:$E$2)+A3" && fillRedo.rule && fillRedo.rule.baseRow === 0, fillRedo);
  const fillInsert = await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    const before = f.rows.length;
    f.sel = new Set([1]);
    f.activeCell = { r: 1, c: 1 };
    dev.insertRow();
    return { before, after: f.rows.length, inserted: f.rows[2][1], previous: f.rows[1][1] };
  })()`);
  assert("新增数据行自动套用整列公式", fillInsert.after === fillInsert.before + 1 && fillInsert.inserted === "=SUM($C$2:$E$2)+A4" && fillInsert.previous === "=SUM($C$2:$E$2)+A3", fillInsert);
  const insertUndo = await evaluate(`(() => {
    const dev = window.__sheetDev;
    dev.undo();
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    return { count: f.rows.length, restored: f.rows[2][1], rule: f.formulaFill["1"] };
  })()`);
  assert("撤销新增行恢复原公式与填充规则", insertUndo.count === fillApplied.count && insertUndo.restored === "=SUM($C$2:$E$2)+A4" && insertUndo.rule && insertUndo.rule.baseRow === 0, insertUndo);
  await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    window.__selectedBefore = f.rows[1][1];
    f.rows[2][1] = "=C4";
    f.sel = new Set([0, 2]);
    f.activeCell = { r: 2, c: 1 };
    dev.openFormulaFill();
    return true;
  })()`);
  await sleep(100);
  const selectedBefore = await evaluate(`window.__selectedBefore`);
  const selectedScope = await evaluate(`document.querySelector('input[name="fill-scope"]:checked').value`);
  assert("多行选中时公式填充默认仅选中行", selectedScope === "selected", selectedScope);
  await evaluate(`[...document.querySelectorAll(".modal-foot button")].find(b => b.textContent.trim() === "开始填充").click()`);
  await sleep(180);
  const selectedFill = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    return { first: f.rows[0][1], middle: f.rows[1][1], selected: f.rows[2][1], rule: f.formulaFill["1"] };
  })()`);
  assert("公式填充只修改选中行且未选行保持不变", selectedFill.first === "=C2" && selectedFill.middle === selectedBefore && selectedFill.selected === "=C4" && selectedFill.rule && selectedFill.rule.baseRow === 2, selectedFill);
  await evaluate(`window.__sheetDev.undo()`);
  const pasteShift = await evaluate(`(async () => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    f.activeCell = { r: 4, c: 1 };
    dev.state.clipboard = { text: "=A2+B2", startR: 0, startC: 0 };
    await dev.pasteBlock("=A2+B2");
    return f.rows[4][1];
  })()`);
  assert("内部剪贴板粘贴公式时同步平移引用", pasteShift === "=B6+C6", pasteShift);

  await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    f.formulaFill["1"] = { formula: "=C2", baseRow: 0 };
    f.rows[0][1] = "=C2";
    f.rows[0][0] = "重复";
    f.rows[1][0] = "重复";
    window.__dedupeCount = f.rows.length;
    dev.openDedupe();
    return true;
  })()`);
  await evaluate(`(() => {
    const modal = document.querySelector(".modal");
    modal.querySelector('input[name="dedupe-keep"][value="last"]').checked = true;
    [...modal.querySelectorAll(".modal-foot button")].find(b => b.textContent.trim() === "删除重复行").click();
    return true;
  })()`);
  const dedupeFill = await evaluate(`(() => {
    const f = window.__sheetDev.state.files.find(x => x.name === "长表格.xlsx");
    return { count: f.rows.length, before: window.__dedupeCount, rule: f.formulaFill["1"] };
  })()`);
  assert("去重删除填充基准行后模板保持有效", dedupeFill.count === dedupeFill.before - 1 && dedupeFill.rule && dedupeFill.rule.baseRow === 0 && dedupeFill.rule.formula === "=C2", dedupeFill);
  const dedupeInsert = await evaluate(`(() => {
    const dev = window.__sheetDev;
    const f = dev.state.files.find(x => x.name === "长表格.xlsx");
    const before = f.rows.length;
    dev.insertRow();
    return { inserted: f.rows[before][1], expected: "=C" + (before + 2) };
  })()`);
  assert("去重后新增行继续套用整列公式", dedupeInsert.inserted === dedupeInsert.expected, dedupeInsert);

  await evaluate(`fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: { path: ${JSON.stringify(SOURCE)}, openOnStart: true, useOnNew: true } })
  }).then(r => r.json())`);

  const failed = results.filter((item) => !item.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("错误:" + error.stack);
  process.exit(1);
});
