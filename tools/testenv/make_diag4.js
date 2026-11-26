/* 生成数据诊断脚本 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cdp_fx.js"), "utf8");
const sendDef = /\/\* 单一 WebSocket 会话复用[\s\S]*?^}\)/m.exec(src)[0];
const evalDef = /async function evaluate\(wsUrl, expression\) \{[\s\S]*?\n\}/m.exec(src)[0];
const body = sendDef + "\n" + evalDef + `
(async () => {
  const items = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const main = items.find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = main.webSocketDebuggerUrl;
  const ev = (e) => evaluate(ws, e);
  const out = await ev("(function(){ var f = window.__sheetDev.state.files[0]; var eng = window.SheetFormula; var get = function(r, c){ if (r === 0) return f.header[c]; var row = f.rows[r-1]; return row ? String(row[c]) : ''; }; return JSON.stringify({ rows: f.rows.slice(0, 5).map(function(r, i){ return i + ': ' + r.join(' | '); }), b4: get(4, 1), d4: get(4, 3), evalB4D4: String(eng.evaluate('=B4&D4', { get: get })) }); })()");
  console.log(out);
  process.exit(0);
})().catch(function(e){ console.error("ERR:", e.message.slice(0, 200)); process.exit(1); });
`;
fs.writeFileSync(path.join(__dirname, "diag_tmp5.js"), body);
console.log("written");
