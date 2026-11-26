/* 多列筛选 AND、搜索叠加、筛选计数与清除 */
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

const READ = `(() => ({
  rows: [...document.querySelectorAll("#tbody tr[data-r]")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())),
  extra: document.querySelector("#status-extra").textContent,
  filterActive: document.querySelectorAll(".th-filter.active").length
}))()`;

async function setOnlyValue(ws, col, value) {
  await evaluate(ws, `document.querySelector('.th-filter[data-filter="${col}"]').click()`);
  await sleep(300);
  await evaluate(ws, `(() => {
    const all = document.querySelector(".filter-all-box");
    all.checked = false;
    all.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  await evaluate(ws, `(() => {
    const hit = [...document.querySelectorAll(".filter-value")].find((l) => l.querySelector(".filter-label").textContent.trim() === ${JSON.stringify(value)});
    if (!hit) return false;
    const box = hit.querySelector("input");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  await evaluate(ws, `document.querySelector('.filter-pop [data-act="ok"]').click()`);
  await sleep(350);
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

  // 等待标签
  for (let i = 0; i < 60; i++) {
    const tabs = await evaluate(ws, `document.querySelectorAll("#tabbar .tab").length`);
    if (tabs) break;
    await sleep(500);
  }
  if (!(await evaluate(ws, `document.querySelector("#clearFilterHidden")`))) {}
  const clearHidden = await evaluate(ws, `document.querySelector("#btn-clear-filter").hidden`);
  if (!clearHidden) await evaluate(ws, `document.querySelector("#btn-clear-filter").click()`);
  await sleep(300);

  await setOnlyValue(ws, 0, "华东");
  const one = await evaluate(ws, READ);
  assert("地区筛选 3 行", one.extra.includes("筛选后 3 行"), one.extra);

  await setOnlyValue(ws, 1, "苹果");
  const two = await evaluate(ws, READ);
  assert("两列 AND 后 2 行", two.extra.includes("筛选后 2 行"), two.extra);
  assert("AND 结果正确", two.rows.length === 2 && two.rows.every((r) => r.includes("华东") && r.includes("苹果")), two.rows);
  assert("两列都有筛选标记", two.filterActive === 2, two.filterActive);
  await shot(ws, "40-multi-filter.png");

  // 搜索叠加“仅显示匹配行”
  await evaluate(ws, `(() => {
    const input = document.querySelector("#search-input");
    input.value = "苹果";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const searchInfo = await evaluate(ws, `(() => ({
    extra: document.querySelector("#status-extra").textContent,
    marks: document.querySelectorAll("#tbody mark").length
  }))()`);
  assert("搜索高亮 2 处", searchInfo.marks >= 2, searchInfo);
  await shot(ws, "41-filter-search.png");

  await evaluate(ws, `(() => { const c = document.querySelector("#search-filter"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await sleep(400);
  const only = await evaluate(ws, READ);
  assert("仅显示匹配行后 2 行", only.rows.length === 2, only.rows.length);
  await shot(ws, "42-only-match.png");

  // 清除筛选
  await evaluate(ws, `document.querySelector("#btn-clear-filter").click()`);
  await sleep(400);
  const cleared = await evaluate(ws, READ);
  assert("清除筛选恢复", cleared.filterActive === 0 && !cleared.extra.includes("筛选后"), cleared.extra);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("错误:", err.message); process.exit(1); });