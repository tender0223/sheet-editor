/* 逐步重现 cdp_ctrl_enter 第 1 步 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cdp_fx.js"), "utf8");
const sendDef = /\/\* 单一 WebSocket 会话复用[\s\S]*?^}\)/m.exec(src)[0];
const evalDef = /async function evaluate\(wsUrl, expression\) \{[\s\S]*?\n\}/m.exec(src)[0];
const utilM = /const UTILS = `([\s\S]*?)`;/.exec(src);
const body = sendDef + "\n" + evalDef + "\nconst UTILS = " + JSON.stringify(utilM[1]) + ";\n" + `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const items = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const main = items.find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = main.webSocketDebuggerUrl;
  const ev = (e) => evaluate(ws, e);
  const snap = (tag) => ev("(function(){ var ed = window.__sheetDev.state.editing; return tag + ' | via=' + (ed ? ed.viaBar : '-') + ' | input=' + (ed ? (ed.input === document.getElementById('formula-input') ? 'bar' : 'cell') : '-') + ' | val=' + (ed ? JSON.stringify(ed.input.value) : '-') + ' | ae=' + (document.activeElement.className || document.activeElement.id || '?').slice(0, 20); })(' + JSON.stringify(tag) + ')");
  await ev(UTILS);
  await ev("(function(){ document.getElementById('grid-wrap').focus(); return true; })()");
  await ev("(function(){ return __fx.clickCell(1, 1); })()");
  await sleep(120);
  console.log(await snap("S1 click"));
  await ev("(function(){ return __fx.keyGrid('='); })()");
  await sleep(120);
  console.log(await snap("S2 key ="));
  await ev("(function(){ return __fx.typeInto('=1*2'); })()");
  await sleep(120);
  console.log(await snap("S3 typeInto"));
  await ev("(function(){ return __fx.keyEditor('Enter', true); })()");
  await sleep(250);
  console.log(await snap("S4 ctrl+enter"));
  console.log("raw:", await ev("window.__sheetDev.state.files[0].rows[1][1]"));
  process.exit(0);
})().catch(function(e){ console.error("ERR:", e.message.slice(0, 250)); process.exit(1); });
`;
fs.writeFileSync(path.join(__dirname, "diag_tmp6.js"), body);
console.log("written");
