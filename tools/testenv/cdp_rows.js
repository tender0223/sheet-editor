const PORT = process.env.CDP_PORT || "9333";
function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(wsUrl);
    const t = setTimeout(() => { s.close(); reject(new Error("timeout")); }, 15000);
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
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const page = (await res.json()).find((i) => i.type === "page" && i.url.includes("127.0.0.1"));
  const ws = page.webSocketDebuggerUrl;
  const evalx = async (expression) => {
    const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  await evalx(`(() => { const i = document.querySelector(".cell-input"); if (i) i.blur(); const w = document.querySelector("#grid-wrap"); w.scrollTop = 700; return w.scrollTop; })()`);
  await new Promise((r) => setTimeout(r, 500));
  console.log(JSON.stringify(await evalx(`(() => {
    const wrap = document.querySelector("#grid-wrap");
    const rows = [...document.querySelectorAll("#tbody tr")];
    return {
      scrollTop: wrap.scrollTop,
      clientHeight: wrap.clientHeight,
      wrapTop: wrap.getBoundingClientRect().top,
      total: document.querySelector("#tbody").getBoundingClientRect().height,
      rows: rows.map((tr) => {
        const r = tr.getBoundingClientRect();
        return {
          cls: tr.className,
          dataR: tr.dataset.r || null,
          top: Math.round(r.top),
          height: Math.round(r.height),
          label: tr.querySelector("td") ? tr.querySelector("td").textContent.trim() : ""
        };
      })
    };
  })()`), null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });