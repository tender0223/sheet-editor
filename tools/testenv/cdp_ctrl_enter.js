/* 验证 Ctrl+Enter 直接提交（不移动） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = "9333";
async function listPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const items = await res.json();
    return items.find((i) => i.type === "page" && i.url.includes("127.0.0.1")) || null;
  } catch (e) { return null; }
}
/* 单一 WebSocket 会话复用：CEF 下每条命令新建连接会得到空响应 */
let cdpSock = null;
let cdpReady = null;
let cdpId = 0;
const cdpPending = new Map();
function send(wsUrl, method, params) {
  if (!cdpSock || cdpSock.readyState > 1) {
    cdpSock = new WebSocket(wsUrl);
    cdpReady = new Promise((resolve, reject) => {
      cdpSock.addEventListener("open", resolve, { once: true });
      cdpSock.addEventListener("error", reject, { once: true });
    });
    cdpId = 0;
    cdpSock.addEventListener("message", (event) => {
      const m = JSON.parse(event.data.toString());
      if (m.id && cdpPending.has(m.id)) {
        const { resolve, reject } = cdpPending.get(m.id);
        cdpPending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }
  return cdpReady.then(() => new Promise((resolve, reject) => {
    const mid = ++cdpId;
    cdpPending.set(mid, { resolve, reject });
    cdpSock.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => {
      if (cdpPending.has(mid)) {
        cdpPending.delete(mid);
        reject(new Error("超时: " + method));
      }
    }, 30000);
  }));
}
async function evaluate(wsUrl, expression) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await send(wsUrl, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      const result = resp && resp.result;
      if (!result) throw new Error("empty");
      if (result.exceptionDetails) {
        throw new Error("eval-exc: " + JSON.stringify(result.exceptionDetails).slice(0, 200));
      }
      return result.value;
    } catch (err) {
      if (String(err.message).indexOf("eval-exc:") === 0) throw err;
      if (attempt === 3) throw new Error("evaluate 失败(" + expression.slice(0, 60) + "): " + err.message);
      await sleep(600);
    }
  }
}
(async () => {
  /* 直连主窗口（应用需以 --debug --dev 启动） */
  const page = await listPage();
  if (!page) throw new Error("CDP 未就绪（请用 --dev --debug 启动应用）");
  const ws = page.webSocketDebuggerUrl;

  const results = [];
  const assert = (name, ok, detail) => {
    results.push(ok);
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  for (let i = 0; i < 40; i++) {
    const opened = await evaluate(ws, `window.__sheetDev && window.__sheetDev.state.files.length > 0`).catch(() => false);
    if (opened) break;
    if (i === 6) await evaluate(ws, `window.__sheetDev.openPaths([
      "D:\\\\agent\\\\项目\\\\excel\\\\tools\\\\testenv\\\\tmpfiles\\\\fx-ui-test.xlsx"
    ])`).catch(() => {});
    await sleep(500);
  }

  const UTILS = `
  window.__fx = {
    keyGrid(key, ctrl) {
      document.getElementById("grid-wrap").dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    },
    keyEditor(key, ctrl) {
      const ed = window.__sheetDev.state.editing;
      const input = ed ? ed.input : null;
      if (input) input.dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    },
    typeInto(text) {
      const ed = window.__sheetDev.state.editing;
      const input = ed ? ed.input : null;
      if (!input) return false;
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    clickCell(r, c) {
      const td = document.querySelector('#tbody td.cell[data-r="' + r + '"][data-c="' + c + '"]');
      if (!td) return false;
      td.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    },
    cellText(r, c) {
      const td = document.querySelector('#tbody td.cell[data-r="' + r + '"][data-c="' + c + '"]');
      return td ? td.textContent.trim() : null;
    },
  };
  true`;
  await evaluate(ws, UTILS);
  /* 每个用例前把真实焦点重置到网格（模拟用户点击表格后的状态） */
  await evaluate(ws, "(function(){ document.getElementById('grid-wrap').focus(); return true; })()");

  // Ctrl+Enter：直接提交且不移动
  await evaluate(ws, `__fx.clickCell(1, 1)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("=C2+C3")`);
  await sleep(120);
  await evaluate(ws, `__fx.keyEditor("Enter", true)`);
  await sleep(250);
  let r1 = await evaluate(ws, `(() => {
    const f = window.__sheetDev.state.files[0];
    return {
      shown: __fx.cellText(1, 1),
      raw: f.rows[1][1],
      active: f.activeCell,
      editing: !!window.__sheetDev.state.editing,
    };
  })()`);
  assert("Ctrl+Enter 提交后显示 5.5", r1.shown === "5.5" && r1.raw === "=C2+C3", r1);
  assert("Ctrl+Enter 光标留在原单元格", r1.active && r1.active.r === 1 && r1.active.c === 1 && !r1.editing, r1);

  // 对照：普通 Enter 提交并下移
  await evaluate(ws, `__fx.clickCell(2, 1)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("=1+1")`);
  await sleep(120);
  await evaluate(ws, `__fx.keyEditor("Enter")`);
  await sleep(250);
  let r2 = await evaluate(ws, `(() => {
    const f = window.__sheetDev.state.files[0];
    return { active: f.activeCell, shown: __fx.cellText(2, 1) };
  })()`);
  assert("普通 Enter 提交并下移到 B5", r2.active && r2.active.r === 3 && r2.active.c === 1 && r2.shown === "2", r2);

  // 公式栏 Ctrl+Enter 同样生效
  await evaluate(ws, `__fx.clickCell(3, 1)`);
  await sleep(120);
  await evaluate(ws, `(() => { const bar = document.getElementById("formula-input"); bar.focus(); bar.dispatchEvent(new FocusEvent("focus")); return true; })()`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("=COUNTA(A2:A5)")`);
  await sleep(120);
  await evaluate(ws, `__fx.keyEditor("Enter", true)`);
  await sleep(250);
  let r3 = await evaluate(ws, `(() => ({
    shown: __fx.cellText(3, 1),
    raw: window.__sheetDev.state.files[0].rows[3][1],
  }))()`);
  assert("公式栏 Ctrl+Enter 提交 COUNTA = 4", r3.shown === "4" && r3.raw === "=COUNTA(A2:A5)", r3);

  const failed = results.filter((x) => !x).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("错误:", err.message); process.exit(1); });
