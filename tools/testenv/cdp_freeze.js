/* 冻结首行：长表格滚动后仍贴顶、可编辑 */
const fs = require("fs");
const path = require("path");
const PORT = process.env.CDP_PORT || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("调试连接超时")); }, 15000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params: params || {} })));
    socket.addEventListener("message", (event) => {
      const m = JSON.parse(event.data.toString());
      if (m.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (m.error) return reject(new Error(m.error.message));
      resolve(m.result);
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("调试连接失败")); });
  });
}

async function evaluate(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function shot(ws, name) {
  const r = await send(ws, "Page.captureScreenshot", { format: "png" });
  const file = path.join(__dirname, "shots", name);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("截图:", file);
}

const READ = `(() => {
  const wrap = document.querySelector("#grid-wrap");
  const frozen = [...document.querySelectorAll("#tbody tr.frozen-row")];
  const rows = [...document.querySelectorAll("#tbody tr[data-r]")];
  const txt = (tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
  const head = document.querySelector("#thead");
  return {
    scrollTop: wrap.scrollTop,
    freezeOn: document.querySelector("#btn-freeze").getAttribute("aria-pressed"),
    frozenCount: frozen.length,
    frozenRow: frozen[0] ? txt(frozen[0]) : null,
    firstRows: rows.slice(0, 4).map(txt),
    thTop: head.querySelector("th") ? head.querySelector("th").getBoundingClientRect().top : null,
    frozenTop: frozen[0] ? frozen[0].querySelector("td").getBoundingClientRect().top : null,
    errors: [...document.querySelectorAll("td.cell-error")].map((td) => td.textContent.trim())
  };
})()`;

(async () => {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const items = await res.json();
      page = items.find((x) => x.type === "page" && x.url.includes("127.0.0.1"));
    } catch (err) {}
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("CDP 未就绪");
  const ws = page.webSocketDebuggerUrl;

  let info = null;
  for (let i = 0; i < 60; i++) {
    info = await evaluate(ws, READ);
    const tabs = await evaluate(ws, `document.querySelectorAll("#tabbar .tab").length`);
    if (tabs) break;
    await sleep(500);
  }

  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  if (info.freezeOn !== "true") {
    await evaluate(ws, `document.querySelector("#btn-freeze").click()`);
    await sleep(400);
  }
  const start = await evaluate(ws, READ);
  assert("冻结行存在", start.frozenCount === 1, start.frozenCount);
  assert("冻结行是第 2 行", start.frozenRow && start.frozenRow[0] === "2" && start.frozenRow[3] === "项目01", start.frozenRow);

  await evaluate(ws, `(() => { const w = document.querySelector("#grid-wrap"); w.scrollTop = 700; return w.scrollTop; })()`);
  await sleep(600);
  const after = await evaluate(ws, READ);
  assert("已滚动", after.scrollTop >= 650, after.scrollTop);
  assert("滚动后表头固定", Math.abs(after.thTop - 160) < 3, after.thTop);
  assert("滚动后冻结行紧贴表头下沿", after.frozenCount === 1 && Math.abs(after.frozenTop - 199) < 3, { frozenTop: after.frozenTop, thTop: after.thTop });
  assert("滚动后冻结行仍是第 2 行", after.frozenRow && after.frozenRow[0] === "2" && after.frozenRow[3] === "项目01", after.frozenRow);
  const laterRows = after.firstRows.filter((r) => r[0] !== "2");
  assert("后续渲染行号大于 2", laterRows.every((r) => Number(r[0]) > 2), laterRows);
  assert("累计公式已计算", after.frozenRow && after.frozenRow[5] === "10", after.frozenRow);
  assert("无计算错误", after.errors.length === 0, after.errors);
  await shot(ws, "36-frozen-long.png");

  // 冻结行可双击编辑
  await evaluate(ws, `(() => {
    const td = document.querySelector("#tbody tr.frozen-row td[data-c]");
    if (!td) return false;
    td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const editing = await evaluate(ws, `(() => {
    const input = document.querySelector("#tbody tr.frozen-row input.cell-input");
    return { open: !!input, value: input ? input.value : "" };
  })()`);
  assert("冻结行可编辑", editing.open, editing);
  await evaluate(ws, `(() => { const i = document.querySelector(".cell-input"); if (i) i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(200);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});