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
  const r = await send(ws, "Runtime.evaluate", {
    expression: `(() => {
      const wrap = document.querySelector("#grid-wrap");
      const grid = document.querySelector("#grid");
      const thead = document.querySelector("#thead");
      const th = document.querySelector("#thead th");
      const frozen = document.querySelector("#tbody tr.frozen-row td");
      const cs = (el) => el ? getComputedStyle(el) : null;
      return {
        wrapTop: wrap.getBoundingClientRect().top,
        wrapScrollTop: wrap.scrollTop,
        docScroll: document.scrollingElement.scrollTop,
        gridPos: cs(grid).position,
        headPos: cs(thead).position,
        thPos: cs(th).position,
        thTop: cs(th).top,
        thRectTop: th.getBoundingClientRect().top,
        theadRectTop: thead.getBoundingClientRect().top,
        frozenPos: cs(frozen).position,
        frozenTopCss: cs(frozen).top,
        frozenRectTop: frozen.getBoundingClientRect().top,
        tbodyHead: document.querySelector("#tbody").firstElementChild ? document.querySelector("#tbody").firstElementChild.className : ""
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r.result.value, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });