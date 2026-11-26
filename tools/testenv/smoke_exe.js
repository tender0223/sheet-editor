/* 打包 exe 冒烟：--debug 跳过单实例，CDP 读取公式与筛选界面 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const exe = path.resolve(ROOT, process.argv[2] || "dist/表格编辑器-Win10轻量版.exe");
const fixture = path.resolve(ROOT, "tools", "testenv", "tmpfiles", "公式与筛选.xlsx");
const shotName = process.argv[3] || "45-exe-light.png";
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

(async () => {
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: path.join(ROOT, "tools", "testenv", "appdata-exe"),
  });
  const child = spawn(exe, ["--debug", fixture], { env, cwd: ROOT, stdio: "ignore" });
  let page = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !page) {
    try {
      const res = await fetch("http://127.0.0.1:9333/json/list");
      const items = await res.json();
      page = items.find((x) => x.type === "page" && x.url.includes("127.0.0.1"));
    } catch (err) {}
    if (!page) await sleep(700);
  }
  if (!page) {
    console.error("失败: CDP 未就绪（窗口没有起来）");
    child.kill();
    process.exit(1);
  }
  const ws = page.webSocketDebuggerUrl;
  let info = null;
  for (let i = 0; i < 40; i++) {
    const r = await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const rows = [...document.querySelectorAll("#tbody tr[data-r]")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()));
        return {
          tabs: [...document.querySelectorAll("#tabbar .tab-name")].map((n) => n.textContent.trim()),
          rows,
          formulaLoaded: typeof window.SheetFormula !== "undefined"
        };
      })()`,
      returnByValue: true,
    });
    info = r.result.value;
    if (info.tabs.length && info.rows.length) break;
    await sleep(500);
  }
  const r = await send(ws, "Page.captureScreenshot", { format: "png" });
  const shot = path.join(__dirname, "shots", shotName);
  fs.writeFileSync(shot, Buffer.from(r.data, "base64"));

  const checks = [
    ["标签页已打开", info.tabs.length >= 1, info.tabs],
    ["公式引擎已加载", info.formulaLoaded === true, info.formulaLoaded],
    ["金额 35 已计算", info.rows.some((row) => row.includes("35")), info.rows[0]],
    ["合计 207 已计算", info.rows.some((row) => row.includes("207"))],
  ];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) failed++;
  }
  console.log("截图:", shot);
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (err) {}
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("错误:", err.message); process.exit(1); });