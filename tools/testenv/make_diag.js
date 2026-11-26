/* 诊断：上下键切换候选 + viaBar 状态 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cdp_fx.js"), "utf8");
const sendDef = /\/\* 单一 WebSocket 会话复用[\s\S]*?^}\)/m.exec(src)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const code = sendDef + `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const items = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const main = items.find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = main.webSocketDebuggerUrl;
  const ev = async (expr) => evaluate(ws, expr);

  /* —— 场景 A：上下键切换候选 —— */
  await ev("(function(){ const td = document.querySelector('#tbody td.cell[data-r=\\"0\\"][data-c=\\"0\\"]'); td.dispatchEvent(new MouseEvent('click', {bubbles:true})); return true; })()");
  await sleep(120);
  await ev("(function(){ document.getElementById('grid-wrap').dispatchEvent(new KeyboardEvent('keydown', {key:'=', bubbles:true})); return true; })()");
  await sleep(120);
  await ev("(function(){ const ed = window.__sheetDev.state.editing; ed.input.value='=SUM'; ed.input.setSelectionRange(5,5); ed.input.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
  await sleep(250);
  const before = await ev("(function(){ const m = document.querySelector('.ac-menu'); return {hidden:m.hidden, active:m.querySelector('.ac-item.active .ac-label').textContent, n:m.querySelectorAll('.ac-item').length}; })()");
  console.log("A before arrows:", JSON.stringify(before));
  const sync1 = await ev("(function(){ const input = window.__sheetDev.state.editing.input; input.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true})); const m = document.querySelector('.ac-menu'); return {active:m.querySelector('.ac-item.active .ac-label').textContent, hidden:m.hidden}; })()");
  console.log("A sync after keydown:", JSON.stringify(sync1));
  const sync2 = await ev("(function(){ const input = window.__sheetDev.state.editing.input; input.dispatchEvent(new KeyboardEvent('keyup', {key:'ArrowDown', bubbles:true})); const m = document.querySelector('.ac-menu'); return {active:m.querySelector('.ac-item.active .ac-label').textContent, hidden:m.hidden}; })()");
  console.log("A sync after keyup:", JSON.stringify(sync2));

  /* —— 场景 B：焦点转移到公式栏 —— */
  await ev("(function(){ document.querySelector('#tbody td.cell[data-r=\\"0\\"][data-c=\\"4\\"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return true; })()");
  await sleep(150);
  const st1 = await ev("JSON.stringify({via: window.__sheetDev.state.editing && window.__sheetDev.state.editing.viaBar, ae: (document.activeElement.className||'').slice(0,30)})");
  console.log("B editing (cell focused):", st1);
  await ev("(function(){ document.getElementById('formula-input').focus(); return true; })()");
  const st2 = await ev("JSON.stringify({viaBar: window.__sheetDev.state.editing && window.__sheetDev.state.editing.viaBar, barFocused: document.activeElement === document.getElementById('formula-input')})");
  console.log("B after focus bar:", st2);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message.slice(0, 300)); process.exit(1); });
`;

// evaluate 在 sendDef 里未定义（cdp_fx 的 evaluate 是独立函数），追加
const evalDef = /async function evaluate\(wsUrl, expression\) \{[\s\S]*?\n\}/m.exec(src)[0];
fs.writeFileSync(path.join(__dirname, "diag_tmp.js"), "const sleep0=null;\n" + evalDef + "\n" + code);
console.log("diag written");
