const PORT = process.env.CDP_PORT || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("timeout")); }, 15000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params: params || {} })));
    socket.addEventListener("message", (event) => {
      const m = JSON.parse(event.data.toString());
      if (m.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (m.error) return reject(new Error(m.error.message));
      resolve(m.result);
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
  });
}

async function ev(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const page = (await res.json()).find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = page.webSocketDebuggerUrl;

  console.log("step0", await ev(ws, `[...document.querySelectorAll("#tbody tr[data-r]")].length`));
  await ev(ws, `document.querySelector('.th-filter[data-filter="0"]').click()`);
  await sleep(300);
  console.log("step1", await ev(ws, `!!document.querySelector(".filter-pop")`));
  console.log("uncheck", await ev(ws, `(() => {
    const p = document.querySelector(".filter-pop");
    [...p.querySelectorAll(".filter-value input")].forEach((b) => { b.checked = false; b.dispatchEvent(new Event("change", { bubbles: true })); });
    return [...p.querySelectorAll(".filter-value input")].map((b) => b.checked);
  })()`));
  console.log("check-one", await ev(ws, `(() => {
    const p = document.querySelector(".filter-pop");
    const hit = [...p.querySelectorAll(".filter-value")].find((l) => l.querySelector(".filter-label").textContent.trim() === "华东");
    const box = hit.querySelector("input");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return [...p.querySelectorAll(".filter-value")].map((l) => [l.querySelector(".filter-label").textContent.trim(), l.querySelector("input").checked]);
  })()`));
  console.log("ok-click", await ev(ws, `(() => {
    const btn = document.querySelector('.filter-pop [data-act="ok"]');
    if (!btn) return "no-btn";
    btn.click();
    return "clicked";
  })()`));
  await sleep(400);
  console.log("step2", await ev(ws, `(() => ({
    pop: !!document.querySelector(".filter-pop"),
    active: document.querySelectorAll(".th-filter.active").length,
    extra: document.querySelector("#status-extra").textContent,
    rows: [...document.querySelectorAll("#tbody tr[data-r]")].map((tr) => tr.querySelector("td:nth-child(3)").textContent.trim())
  }))()`));
})().catch((err) => { console.error(err.message); process.exit(1); });