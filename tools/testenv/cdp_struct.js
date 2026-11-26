/* 插入/删除行后公式引用自动换算 */
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

const cell = (r, c) => `(() => {
  const td = document.querySelector('#tbody tr[data-r="${r}"] td[data-c="${c}"]');
  return td ? { text: td.textContent.trim(), raw: td.getAttribute("title") } : null;
})()`;

(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const page = (await res.json()).find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = page.webSocketDebuggerUrl;
  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  // 复位：关闭冻结、滚到顶部
  const freeze = await evaluate(ws, `document.querySelector("#btn-freeze").getAttribute("aria-pressed")`);
  if (freeze === "true") await evaluate(ws, `document.querySelector("#btn-freeze").click()`);
  await evaluate(ws, `(() => { document.querySelector("#grid-wrap").scrollTop = 0; return true; })()`);
  await sleep(400);

  const before = await evaluate(ws, cell(1, 3));
  assert("D3 原始公式", before.raw === "=SUM($C$2:C3)", before);

  // 选中第 1 条数据行，插入一行
  await evaluate(ws, `(() => {
    const tr = document.querySelector('#tbody tr[data-r="0"]');
    tr.querySelector("td.rownum").click();
    return true;
  })()`);
  await sleep(200);
  await evaluate(ws, `document.querySelector("#btn-insert-row").click()`);
  await sleep(500);

  const d2 = await evaluate(ws, cell(0, 3));
  const d4 = await evaluate(ws, cell(2, 3));
  assert("插入后 D2 引用不变", d2.raw === "=SUM($C$2:C2)", d2);
  assert("插入后 D4 引用下移", d4.raw === "=SUM($C$2:C4)", d4);

  // 撤销恢复
  await evaluate(ws, `document.querySelector("#btn-undo").click()`);
  await sleep(400);
  const restored = await evaluate(ws, cell(1, 3));
  assert("撤销恢复原公式", restored.raw === "=SUM($C$2:C3)", restored);

  // 删除第 1 条数据行：引用它的公式应变为 #REF!
  await evaluate(ws, `(() => {
    document.querySelector('#tbody tr[data-r="0"] td.rownum').click();
    return true;
  })()`);
  await sleep(200);
  const delOk = await evaluate(ws, `(() => {
    const btn = document.querySelector("#btn-delete-rows");
    if (!btn || btn.offsetParent === null) return "no-btn";
    btn.click();
    return "clicked";
  })()`);
  if (delOk === "clicked") {
    let confirmed = false;
    for (let i = 0; i < 20 && !confirmed; i++) {
      confirmed = await evaluate(ws, `(() => {
        const btn = [...document.querySelectorAll(".modal .modal-foot button")].find((b) => b.textContent.trim() === "删除");
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (!confirmed) await sleep(200);
    }
    await sleep(700);
    const ref = await evaluate(ws, `(() => {
      const td = document.querySelector('#tbody tr[data-r="0"] td[data-c="3"]');
      return td ? { text: td.textContent.trim(), raw: td.getAttribute("title") } : null;
    })()`);
    assert("删除后引用失效", ref && String(ref.raw).includes("#REF!"), ref);
  } else {
    console.log("未找到删除行按钮，跳过删除用例:", delOk);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("错误:", err.message); process.exit(1); });