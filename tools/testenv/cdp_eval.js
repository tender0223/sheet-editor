const cdpPort = process.argv[2];
const appPort = process.argv[3];
const expression = process.argv[4] || "true";

(async () => {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const items = await response.json();
  const page = items.find((item) => item.type === "page" && item.url.includes(`127.0.0.1:${appPort}/`));
  if (!page) throw new Error("未找到测试页面");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
      resolve();
    }, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const timer = setTimeout(() => {
    ws.close();
    console.error("CDP 执行超时");
    process.exit(1);
  }, 20000);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data.toString());
    if (message.id !== 1) return;
    clearTimeout(timer);
    ws.close();
    if (message.error) {
      console.error(message.error.message);
      process.exit(1);
    }
    if (message.result.exceptionDetails) {
      console.error(JSON.stringify(message.result.exceptionDetails));
      process.exit(1);
    }
    console.log(JSON.stringify(message.result.result.value));
  });
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
