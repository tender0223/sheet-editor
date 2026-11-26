/* 生成 viaBar 时序诊断脚本 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cdp_fx.js"), "utf8");
const sendDef = /\/\* 单一 WebSocket 会话复用[\s\S]*?^}\)/m.exec(src)[0];
const evalDef = /async function evaluate\(wsUrl, expression\) \{[\s\S]*?\n\}/m.exec(src)[0];

const body = sendDef + "\n" + evalDef + `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const items = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const main = items.find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = main.webSocketDebuggerUrl;
  const ev = async (expr) => evaluate(ws, expr);
  const via = () => ev("JSON.stringify({via: window.__sheetDev.state.editing ? window.__sheetDev.state.editing.viaBar : null, ae: (document.activeElement.className || document.activeElement.id || '?').slice(0, 25)})");
  await ev("(function(){ document.querySelector('#tbody td.cell[data-r=\\"0\\"][data-c=\\"4\\"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return true; })()");
  await sleep(150);
  console.log("1 after dblclick:", await via());
  await ev("(function(){ document.getElementById('formula-input').dispatchEvent(new FocusEvent('focus')); return true; })()");
  console.log("2 after synthetic focus:", await via());
  await ev("(function(){ document.getElementById('formula-input').focus(); return true; })()");
  await sleep(100);
  console.log("3 after real focus():", await via());
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message.slice(0, 250)); process.exit(1); });
`;

fs.writeFileSync(path.join(__dirname, "diag_tmp2.js"), body);
console.log("written diag_tmp2.js");
