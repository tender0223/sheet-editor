/* 精确复刻 cdp_fx 测试 1-4 步，逐步打印 viaBar */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cdp_fx.js"), "utf8");
const sendDef = /\/\* 单一 WebSocket 会话复用[\s\S]*?^}\)/m.exec(src)[0];
const evalDef = /async function evaluate\(wsUrl, expression\) \{[\s\S]*?\n\}/m.exec(src)[0];
const utilM = /const UTILS = `([\s\S]*?)`;/.exec(src);
const UTILS = utilM[1];

const body = sendDef + "\n" + evalDef + "\nconst UTILS = " + JSON.stringify(UTILS) + ";\n" + `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const items = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const main = items.find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = main.webSocketDebuggerUrl;
  const ev = (expr) => evaluate(ws, expr);
  await ev(UTILS);
  await ev("(function(){ return __fx.clickCell(0, 4); })()");
  await sleep(150);
  await ev("(function(){ return __fx.dblCell(0, 4); })()");
  await sleep(150);
  console.log("step3 editing:", await ev("JSON.stringify({via: window.__sheetDev.state.editing && window.__sheetDev.state.editing.viaBar, ae: (document.activeElement.className||'').slice(0,20)})"));
  await ev("(function(){ document.getElementById('formula-input').focus(); return true; })()");
  await sleep(150);
  console.log("step4 after focus:", await ev("JSON.stringify({via: window.__sheetDev.state.editing && window.__sheetDev.state.editing.viaBar, ae: (document.activeElement.className||'').slice(0,20), edIsBar: window.__sheetDev.state.editing && window.__sheetDev.state.editing.input === document.getElementById('formula-input')})"));
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message.slice(0, 250)); process.exit(1); });
`;
fs.writeFileSync(path.join(__dirname, "diag_tmp4.js"), body);
console.log("written");
