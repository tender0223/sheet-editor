/* 通过 CDP 驱动调试窗口：公式显示、按列筛选、冻结首行 */
const fs = require("fs");
const path = require("path");

const PORT = process.env.CDP_PORT || "9333";
const SHOT_DIR = path.join(__dirname, "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!res.ok) return null;
    const items = await res.json();
    return items.find((item) => item.type === "page" && item.url.includes("127.0.0.1")) || null;
  } catch (err) {
    return null;
  }
}

function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("调试连接超时"));
    }, 15000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params: params || {} }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) return reject(new Error(message.error.message));
      resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("调试连接失败"));
    });
  });
}

async function evaluate(wsUrl, expression) {
  const result = await send(wsUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function shot(wsUrl, name) {
  const result = await send(wsUrl, "Page.captureScreenshot", { format: "png" });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log("截图:", file);
}

const READ = `(() => {
  const cells = (tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
  const rows = [...document.querySelectorAll("#tbody tr[data-r]")];
  return {
    tabs: [...document.querySelectorAll("#tabbar .tab .tab-name")].map((n) => n.textContent.trim()),
    header: [...document.querySelectorAll("#thead th")].map((th) => th.textContent.trim()),
    rows: rows.map(cells),
    frozen: document.querySelectorAll("#tbody tr.frozen-row").length,
    status: (document.querySelector("#status-meta") || {}).textContent || "",
    extra: (document.querySelector("#status-extra") || {}).textContent || "",
    filterActive: document.querySelectorAll(".th-filter.active").length,
    freezeOn: (document.querySelector("#btn-freeze") || {}).getAttribute ? document.querySelector("#btn-freeze").getAttribute("aria-pressed") : "",
    clearFilterHidden: (document.querySelector("#btn-clear-filter") || { hidden: true }).hidden,
    errors: [...document.querySelectorAll("td.cell-error")].map((td) => td.textContent.trim())
  };
})()`;

(async () => {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = await listPage();
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("CDP 未就绪");
  const ws = page.webSocketDebuggerUrl;

  let info = null;
  for (let i = 0; i < 60; i++) {
    info = await evaluate(ws, READ);
    if (info.tabs.length) break;
    await sleep(500);
  }

  // 恢复到干净状态：清筛选、关冻结
  if (!info.clearFilterHidden) {
    await evaluate(ws, `document.querySelector("#btn-clear-filter").click()`);
    await sleep(300);
  }
  if (info.freezeOn === "true") {
    await evaluate(ws, `document.querySelector("#btn-freeze").click()`);
    await sleep(300);
  }
  info = await evaluate(ws, READ);

  console.log("初始:", JSON.stringify(info));
  await shot(ws, "31-formulas.png");

  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  assert("公式金额 35", info.rows.some((r) => r.includes("35")), info.rows[0]);
  assert("公式合计 207", info.rows.some((r) => r.includes("207")));
  assert("公式均价 34.5", info.rows.some((r) => r.includes("34.5")));

  // 打开“地区”列筛选
  await evaluate(ws, `document.querySelector('.th-filter[data-filter="0"]').click()`);
  await sleep(400);
  const pop = await evaluate(ws, `(() => {
    const p = document.querySelector(".filter-pop");
    return p ? { open: true, values: [...p.querySelectorAll(".filter-label")].map((n) => n.textContent.trim()) } : { open: false };
  })()`);
  assert("筛选面板打开", pop.open, pop);
  await shot(ws, "32-filter-pop.png");

  // 只保留“华东”：先点“全选”取消全部，再单独勾选（取消全选会重建列表）
  await evaluate(ws, `(() => {
    const all = document.querySelector(".filter-all-box");
    all.checked = false;
    all.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  await evaluate(ws, `(() => {
    const p = document.querySelector(".filter-pop");
    const hit = [...p.querySelectorAll(".filter-value")].find((l) => l.querySelector(".filter-label").textContent.trim() === "华东");
    if (!hit) return false;
    const box = hit.querySelector("input");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  await evaluate(ws, `document.querySelector('.filter-pop [data-act="ok"]').click()`);
  await sleep(500);
  const filtered = await evaluate(ws, READ);
  assert("筛选后 3 行", filtered.extra.includes("筛选后 3 行"), filtered.extra);
  assert("筛掉合计行", !filtered.rows.some((r) => r.includes("合计")), filtered.rows);
  assert("筛选标记出现", filtered.filterActive === 1 && !filtered.clearFilterHidden);
  await shot(ws, "33-filtered.png");

  // 冻结首行
  await evaluate(ws, `document.querySelector("#btn-freeze").click()`);
  await sleep(500);
  const frozen = await evaluate(ws, READ);
  assert("冻结行存在", frozen.frozen === 1, frozen.frozen);
  assert("冻结行是华东", frozen.rows[0] && frozen.rows[0].includes("华东"), frozen.rows[0]);
  await shot(ws, "34-frozen.png");

  // 滚动，冻结行仍贴顶
  await evaluate(ws, `(() => { const s = document.querySelector("#grid-scroll") || document.querySelector(".grid-scroll") || document.querySelector("#tbody").parentElement; s.scrollTop = 400; return s.scrollTop; })()`);
  await sleep(500);
  const scrolled = await evaluate(ws, READ);
  assert("滚动后冻结行仍在", scrolled.frozen === 1, scrolled.frozen);
  await shot(ws, "35-frozen-scrolled.png");

  // 清除筛选
  await evaluate(ws, `document.querySelector("#btn-clear-filter").click()`);
  await sleep(500);
  const cleared = await evaluate(ws, READ);
  assert("清除筛选后恢复全表", !cleared.extra.includes("筛选后"), cleared.extra);
  assert("清除后筛选标记消失", cleared.filterActive === 0);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});