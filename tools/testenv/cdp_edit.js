/* 编辑公式 + 保存：界面显示计算值，xlsx 保留公式 */
const fs = require("fs");
const path = require("path");
const PORT = process.env.CDP_PORT || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(wsUrl);
    const t = setTimeout(() => { s.close(); reject(new Error("timeout")); }, 20000);
    s.addEventListener("open", () => s.send(JSON.stringify({ id: 1, method, params: params || {} })));
    s.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id !== 1) return;
      clearTimeout(t); s.close();
      if (m.error) return reject(new Error(m.error.message));
      resolve(m.result);
    });
    s.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws")); });
  });
}

async function evaluate(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function shot(ws, name) {
  const r = await send(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(__dirname, "shots", name), Buffer.from(r.data, "base64"));
}

(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const page = (await res.json()).find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = page.webSocketDebuggerUrl;
  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  await evaluate(ws, `(() => { const w = document.querySelector("#grid-wrap"); w.scrollTop = 0; return w.scrollTop; })()`);
  await sleep(500);

  // 双击第 2 行“金额”单元格并输入公式
  const edited = await evaluate(ws, `(() => {
    const td = document.querySelector('#tbody tr[data-r="0"] td[data-c="2"]');
    if (!td) return "no-cell";
    td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector(".cell-input");
    if (!input) return "no-input";
    input.value = "=A2*20";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return "ok";
  })()`);
  await sleep(500);
  const afterEdit = await evaluate(ws, `(() => {
    const td = document.querySelector('#tbody tr[data-r="0"] td[data-c="2"]');
    return {
      text: td ? td.textContent.trim() : "",
      formula: td ? td.classList.contains("formula-cell") : false,
      error: td ? td.classList.contains("cell-error") : false
    };
  })()`);
  assert("编辑生效", edited === "ok", edited);
  assert("显示计算值 20", afterEdit.text === "20", afterEdit);
  assert("标记为公式单元格", afterEdit.formula && !afterEdit.error, afterEdit);

  // 累计列也应随公式重算：D2 仍是 10（不受影响）
  const cum = await evaluate(ws, `document.querySelector('#tbody tr[data-r="0"] td[data-c="3"]').textContent.trim()`);
  assert("累计公式随单元格重算", cum === "20", cum);
  const downstream = await evaluate(ws, `document.querySelector('#tbody tr[data-r="1"] td[data-c="3"]').textContent.trim()`);
  assert("下游公式重算", downstream === "40", downstream);
  await shot(ws, "38-formula-edit.png");

  // 输入非法公式看报错样式
  await evaluate(ws, `(() => {
    const td = document.querySelector('#tbody tr[data-r="1"] td[data-c="2"]');
    td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector(".cell-input");
    input.value = "=1/0";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const errCell = await evaluate(ws, `(() => {
    const td = document.querySelector('#tbody tr[data-r="1"] td[data-c="2"]');
    return { text: td.textContent.trim(), error: td.classList.contains("cell-error") };
  })()`);
  assert("除零显示 #DIV/0!", errCell.text === "#DIV/0!" && errCell.error, errCell);

  // 撤销恢复
  await evaluate(ws, `document.querySelector("#btn-undo").click()`);
  await sleep(400);
  const undone = await evaluate(ws, `document.querySelector('#tbody tr[data-r="1"] td[data-c="2"]').textContent.trim()`);
  assert("撤销恢复正常值", undone === "20", undone);

  // Ctrl+S 保存
  await evaluate(ws, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }))`);
  await sleep(1500);
  await shot(ws, "39-after-save.png");
  console.log("当前状态:", JSON.stringify(await evaluate(ws, `document.querySelector("#status-extra").textContent`)));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("错误:", err.message); process.exit(1); });