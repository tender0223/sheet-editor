const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE;
const TMP = process.env.TMPFILES || path.join(__dirname, "tmpfiles");
const OUT = path.join(__dirname, "shots");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("通过: " + msg);
}

async function activeInfo(page) {
  return page.evaluate(() => {
    const s = window.__sheetDev.state;
    const f = s.files.find((x) => x.id === s.activeId);
    return {
      id: f.id,
      name: f.name,
      rows: f.rows.length,
      cols: f.header.length,
      header: f.header.slice(),
      encoding: f.encoding,
      kind: f.kind,
      dirty: f.dirty,
      sel: f.sel.size,
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new",
    args: ["--window-size=1400,900", "--force-device-scale-factor=1"],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.waitForFunction("!!window.__sheetDev");
  await sleep(400);

  const boot = await page.evaluate(() => ({
    toasts: document.querySelectorAll(".toast").length,
    empty: !document.querySelector("#empty").hidden,
  }));
  assert(boot.toasts === 0, "启动后没有报错提示");
  assert(boot.empty, "无文件时显示空状态");
  await page.screenshot({ path: path.join(OUT, "01-empty.png") });

  /* 1. 同时打开 4 个文件 */
  await page.evaluate(async (paths) => {
    await window.__sheetDev.openPaths(paths);
  }, [
    path.join(TMP, "4399_2026-09-17.html"),
    path.join(TMP, "4399_2026-09-26.xlsx"),
    path.join(TMP, "4399_2026-10-04.xlsx"),
    path.join(TMP, "4399_2026-09-28.xlsx"),
  ]);
  await sleep(800);
  let info = await activeInfo(page);
  const multi = await page.evaluate(() => ({
    tabs: document.querySelectorAll(".tab").length,
    headerText: [...document.querySelectorAll("thead th .th-name")].map((n) => n.textContent),
    renderedRows: document.querySelectorAll("tbody tr[data-r]").length,
  }));
  assert(multi.tabs === 4, "同时打开 4 个文件并生成 4 个标签");
  assert(info.rows === 2000 && info.cols === 12, "2000 行文件正常显示");
  assert(multi.headerText.includes("自定义采集"), "表头中文正常");
  assert(multi.renderedRows > 5 && multi.renderedRows < 60, "虚拟滚动只渲染可视区域");
  await page.screenshot({ path: path.join(OUT, "02-multi.png") });

  /* 2. 搜索、高亮、当项定位、仅显示匹配行 */
  await page.click("#search-input");
  await page.type("#search-input", "636630");
  await sleep(500);
  const searchInfo = await page.evaluate(() => ({
    count: document.querySelector("#search-count").textContent,
    marks: document.querySelectorAll("tbody mark").length,
    current: document.querySelectorAll("tbody mark.current").length,
    total: window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId).search.list.length,
  }));
  assert(searchInfo.total > 0, "搜索命中记录");
  assert(searchInfo.marks > 0, "命中内容已高亮");
  assert(searchInfo.current === 1, "当前命中项高亮唯一");
  await page.screenshot({ path: path.join(OUT, "03-search.png") });

  await page.click("#btn-next");
  await sleep(250);
  const countAfter = await page.$eval("#search-count", (n) => n.textContent);
  assert(countAfter.startsWith("2 /"), "下一处切换到第 2 个结果");

  await page.click("#search-filter");
  await sleep(400);
  const filtered = await page.evaluate(() => ({
    rendered: document.querySelectorAll("tbody tr[data-r]").length,
    hint: document.querySelector(".hint-row") ? document.querySelector(".hint-row").innerText : "",
  }));
  assert(filtered.rendered <= 20, "仅显示匹配行生效");
  await page.screenshot({ path: path.join(OUT, "04-filter.png") });
  await page.click("#search-filter");
  await sleep(250);

  await page.click("#search-input", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await sleep(300);
  const cleared = await page.$eval("#search-count", (n) => n.textContent);
  assert(cleared === "0 / 0", "清空搜索后计数归零");

  /* 3. GBK 文件解码 */
  const tabs = await page.evaluate(() => window.__sheetDev.state.files.map((f) => ({ id: f.id, name: f.name })));
  const gbkTab = tabs.find((t) => t.name.includes("09-17"));
  await page.click(`.tab[data-id="${gbkTab.id}"]`);
  await sleep(400);
  const gbkInfo = await page.evaluate(() => {
    const s = window.__sheetDev.state;
    const f = s.files.find((x) => x.id === s.activeId);
    return { encoding: f.encoding, rows: f.rows.length, first: f.rows[0].slice(0, 6) };
  });
  assert(gbkInfo.encoding === "GBK" && gbkInfo.first[1] === "6555617328", "GBK 文件解码正确");
  await page.screenshot({ path: path.join(OUT, "05-gbk.png") });

  /* 4. Shift 连续选择，且不会选中界面文字 */
  await page.click("tbody tr[data-r='0'] td.cell[data-c='5']");
  await page.keyboard.down("Shift");
  await page.click("tbody tr[data-r='4'] td.cell[data-c='5']");
  await page.keyboard.up("Shift");
  await sleep(300);
  const selInfo = await page.evaluate(() => ({
    barHidden: document.querySelector("#batchbar").hidden,
    count: document.querySelector("#sel-count").textContent,
    stateSel: window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId).sel.size,
    userSelect: getComputedStyle(document.querySelector(".grid")).userSelect,
    nativeSel: String(window.getSelection()),
  }));
  assert(!selInfo.barHidden && selInfo.stateSel === 5, "Shift 连续选中 5 行并显示批量条");
  assert(selInfo.userSelect === "none" && selInfo.nativeSel === "", "选择行时不会误选文字");
  await page.screenshot({ path: path.join(OUT, "06-selection.png") });
  await page.click("#btn-clear-sel");
  await sleep(200);

  /* 5. 单元格编辑与撤销 */
  await page.click("tbody tr[data-r='1'] td.cell[data-c='5']", { clickCount: 2 });
  await sleep(200);
  assert(!!(await page.$(".cell-input")), "双击进入单元格编辑");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type("测试姓名");
  await page.keyboard.press("Enter");
  await sleep(300);
  let edited = await page.evaluate(() => {
    const f = window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId);
    return { value: f.rows[1][5], dirty: f.dirty, tabDot: document.querySelectorAll(".tab-dot").length };
  });
  assert(edited.value === "测试姓名" && edited.dirty && edited.tabDot === 1, "编辑生效并标记未保存");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(350);
  edited = await page.evaluate(() => {
    const f = window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId);
    return { value: f.rows[1][5], dirty: f.dirty };
  });
  assert(edited.value === "" && !edited.dirty, "撤销恢复原值并清除未保存标记");

  /* 6. 批量修改（前缀） */
  await page.click("tbody tr[data-r='0'] td.cell[data-c='5']");
  await page.keyboard.down("Shift");
  await page.click("tbody tr[data-r='3'] td.cell[data-c='5']");
  await page.keyboard.up("Shift");
  await page.click("#btn-batch-edit");
  await sleep(300);
  assert(!!(await page.$(".modal")), "批量修改弹窗打开");
  await page.screenshot({ path: path.join(OUT, "07-batch-modal.png") });
  await page.select("#batch-col", "5");
  await page.select("#batch-op", "prefix");
  const prefixVisible = await page.evaluate(() => !document.querySelector('[data-op="prefix"]').hidden);
  assert(prefixVisible, "切换为添加前缀后显示对应输入框");
  await page.type("#batch-prefix", "改_");
  await page.click(".modal .btn.primary");
  await sleep(900);
  const batchResult = await page.evaluate(() => {
    const f = window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId);
    return { rows: [0, 1, 2, 3].map((r) => f.rows[r][5]), other: f.rows[4][5] };
  });
  assert(batchResult.rows.every((v) => v.startsWith("改_")), "批量前缀应用到选中 4 行");
  assert(!batchResult.other.startsWith("改_"), "未选中的行不受影响");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(400);

  /* 7. 插入行与撤销 */
  const beforeInsert = (await activeInfo(page)).rows;
  await page.click("#btn-insert-row");
  await sleep(400);
  assert((await activeInfo(page)).rows === beforeInsert + 1, "插入空白行");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(400);
  assert((await activeInfo(page)).rows === beforeInsert, "撤销插入行");

  /* 8. 原格式保存 GBK 极简 HTML */
  const saveGb = await page.evaluate(async () => {
    const s = window.__sheetDev.state;
    const f = s.files.find((x) => x.id === s.activeId);
    const ok = await window.__sheetDev.saveFile(f, { forceDialog: false });
    return { ok, path: f.path, dirty: f.dirty, encoding: f.encoding, kind: f.kind };
  });
  await sleep(700);
  assert(saveGb.ok && !saveGb.dirty && saveGb.encoding === "GBK", "GBK 文件保存成功并保持编码");

  /* 9. WPS 版式文件：去重、撤销、编辑并保存 */
  const wpsTab = tabs.find((t) => t.name.includes("09-26"));
  await page.click(`.tab[data-id="${wpsTab.id}"]`);
  await sleep(500);
  assert((await activeInfo(page)).rows === 770, "WPS 版式文件读取 770 行");

  await page.evaluate(() => window.__sheetDev.openDedupe());
  await sleep(300);
  const dedupePreview = await page.$eval("#dedupe-preview", (n) => n.innerText);
  console.log("去重预览:", dedupePreview.replace(/\n/g, " | "));
  await page.screenshot({ path: path.join(OUT, "08-dedupe.png") });
  await page.click(".modal .btn.danger");
  await sleep(700);
  const afterDedupe = (await activeInfo(page)).rows;
  assert(afterDedupe < 770, "去重减少了行数");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(500);
  assert((await activeInfo(page)).rows === 770, "撤销去重恢复行数");

  await page.click("tbody tr[data-r='2'] td.cell[data-c='1']", { clickCount: 2 });
  await sleep(200);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type("保存校验值");
  await page.keyboard.press("Enter");
  await sleep(300);
  const saveWps = await page.evaluate(async () => {
    const s = window.__sheetDev.state;
    const f = s.files.find((x) => x.id === s.activeId);
    const ok = await window.__sheetDev.saveFile(f, { forceDialog: false });
    return { ok, dirty: f.dirty, encoding: f.encoding };
  });
  await sleep(700);
  assert(saveWps.ok && !saveWps.dirty && saveWps.encoding === "UTF-8", "WPS 文件保存成功并保持 UTF-8");

  /* 10. 右键表头菜单 */
  await page.click("thead th[data-col='5']", { button: "right" });
  await sleep(250);
  const menuItems = await page.$$eval(".context-menu button", (nodes) => nodes.map((n) => n.textContent));
  assert(menuItems.includes("重命名此列") && menuItems.includes("删除此列"), "表头右键菜单可用");
  await page.screenshot({ path: path.join(OUT, "09-context.png") });
  await page.keyboard.press("Escape");

  /* 11. 帮助 */
  await page.click("#btn-help");
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, "10-help.png") });
  await page.keyboard.press("Escape");

  /* 12. 新建表格、粘贴多行多列 */
  await page.click("#btn-new");
  await sleep(300);
  await page.click("#new-columns", { clickCount: 3 });
  await page.type("#new-columns", "姓名,账号,区服,备注,金额");
  await page.click(".modal .btn.primary");
  await sleep(500);
  let fresh = await activeInfo(page);
  assert(fresh.name === "未命名表格.xlsx" && fresh.cols === 5 && fresh.rows === 0, "新建 5 列表格");

  await page.evaluate(() => window.__sheetDev.insertRow());
  await sleep(300);
  await page.click("tbody tr[data-r='0'] td.cell[data-c='0']");
  await page.evaluate(() =>
    window.__sheetDev.pasteBlock("甲\t1001\t一区\t备注甲\t10\t额外\n乙\t1002\t二区\t备注乙\t20\t额外\n丙\t1003\t三区\t备注丙\t30\t额外\n丁\t1004\t四区\t备注丁\t40\t额外")
  );
  await sleep(500);
  fresh = await activeInfo(page);
  assert(fresh.rows === 4 && fresh.cols === 6, "粘贴 4 行 6 列并自动扩展列");
  const pasted = await page.evaluate(() => {
    const f = window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId);
    return { first: f.rows[0].slice(0, 3), last: f.rows[3].slice(0, 3) };
  });
  assert(pasted.first[0] === "甲" && pasted.last[2] === "四区", "粘贴内容正确");
  await page.screenshot({ path: path.join(OUT, "11-newfile.png") });

  /* 13. 列重命名、插入、删除 */
  await page.click("thead th[data-col='0']", { button: "right" });
  await sleep(200);
  await page.evaluate(() =>
    [...document.querySelectorAll(".context-menu button")].find((b) => b.textContent === "重命名此列").click()
  );
  await sleep(300);
  await page.click("#prompt-input", { clickCount: 3 });
  await page.type("#prompt-input", "客户姓名");
  await page.click(".modal .btn.primary");
  await sleep(300);
  assert((await activeInfo(page)).header[0] === "客户姓名", "重命名列生效");

  await page.click("thead th[data-col='0']", { button: "right" });
  await sleep(200);
  await page.evaluate(() =>
    [...document.querySelectorAll(".context-menu button")].find((b) => b.textContent === "在左侧插入列").click()
  );
  await sleep(300);
  await page.click("#prompt-input", { clickCount: 3 });
  await page.type("#prompt-input", "新列");
  await page.click(".modal .btn.primary");
  await sleep(300);
  fresh = await activeInfo(page);
  assert(fresh.cols === 7 && fresh.header[0] === "新列" && fresh.header[1] === "客户姓名", "插入列生效");

  await page.click("thead th[data-col='6']", { button: "right" });
  await sleep(200);
  await page.evaluate(() =>
    [...document.querySelectorAll(".context-menu button")].find((b) => b.textContent === "删除此列").click()
  );
  await sleep(300);
  await page.click(".modal .btn.danger");
  await sleep(300);
  assert((await activeInfo(page)).cols === 6, "删除列生效");
  await page.screenshot({ path: path.join(OUT, "12-columns.png") });

  /* 14. 保存新表格（HTML 结构 .xlsx） */
  const newPath = path.join(TMP, "新建表格.xlsx");
  const saveNew = await page.evaluate(async (target) => {
    const f = window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId);
    f.path = target;
    f.dir = target.replace(/[\\/][^\\/]+$/, "");
    const ok = await window.__sheetDev.saveFile(f, { forceDialog: false });
    return { ok, dirty: f.dirty, encoding: f.encoding, kind: f.kind };
  }, newPath);
  await sleep(700);
  assert(saveNew.ok && !saveNew.dirty, "新表格保存成功");

  /* 15. 导出标准 xlsx */
  const exportPath = path.join(TMP, "导出校验.xlsx");
  const exportRes = await page.evaluate(async (target) => {
    const s = window.__sheetDev.state;
    const f = s.files.find((x) => x.id === s.activeId);
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sheet-Token": s.token },
      body: JSON.stringify({ path: target, header: f.header, rows: f.rows, sheet_name: "数据" }),
    });
    return res.json();
  }, exportPath);
  assert(exportRes.ok, "导出标准 xlsx 成功");

  /* 16. 大批量操作可取消 */
  const tab928 = tabs.find((t) => t.name.includes("09-28"));
  await page.click(`.tab[data-id="${tab928.id}"]`);
  await sleep(500);
  await page.evaluate(() => {
    window.__cancelWatch = setInterval(() => {
      const btn = document.querySelector(".progress-cancel");
      if (btn && !btn.disabled) btn.click();
    }, 20);
  });
  await page.evaluate(() => window.__sheetDev.openBatchEdit());
  await sleep(300);
  await page.select("#batch-col", "0");
  await page.select("#batch-op", "set");
  await page.type("#batch-value", "取消测试");
  await page.click(".modal .btn.primary");
  await sleep(1400);
  await page.evaluate(() => clearInterval(window.__cancelWatch));
  const cancelInfo = await page.evaluate(() => ({
    toast: [...document.querySelectorAll(".toast")].map((n) => n.textContent).join(" | "),
    progress: !!document.querySelector(".progress-card"),
    first: window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId).rows[0][0],
  }));
  assert(/已取消/.test(cancelInfo.toast), "大批量操作可中途取消");
  assert(!cancelInfo.progress, "取消后进度条已关闭");
  assert(cancelInfo.first === "取消测试", "取消前已处理的部分保留，可撤销");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(600);
  const firstUndone = await page.evaluate(
    () => window.__sheetDev.state.files.find((x) => x.id === window.__sheetDev.state.activeId).rows[0][0]
  );
  assert(firstUndone !== "取消测试", "撤销取消前的部分修改");

  /* 17. 全部保存（仅剩 09-28 有改动） */
  await page.click("#btn-insert-row");
  await sleep(300);
  await page.click("#btn-save-all");
  await sleep(1500);
  const allSaved = await page.evaluate(() => window.__sheetDev.state.files.map((f) => ({ name: f.name, dirty: f.dirty })));
  assert(allSaved.every((f) => !f.dirty), "全部保存清除所有未保存标记");

  /* 18. 最近打开的历史记录 */
  const history = await page.evaluate(() => window.__sheetDev.state.history);
  assert(history.length >= 4, "打开和保存后记录历史，共 " + history.length + " 条");
  assert(history.some((x) => x.name.includes("09-28")), "历史记录包含刚编辑的文件");
  assert(history.every((x) => x.exists !== false), "历史记录文件都存在");
  await page.click("#btn-history");
  await sleep(400);
  const historyModal = await page.evaluate(() => ({
    title: [...document.querySelectorAll(".modal h3")].map((n) => n.textContent).join("|"),
    rows: document.querySelectorAll("#history-list .recent-item").length,
  }));
  assert(historyModal.rows === history.length, "历史弹窗列出全部记录");
  await page.screenshot({ path: path.join(OUT, "18-history.png") });
  await page.evaluate(() => {
    [...document.querySelectorAll(".modal button")].find((b) => b.textContent.trim() === "关闭").click();
  });
  await sleep(200);

  /* 19. 深色主题与自定义强调色 */
  await page.click("#btn-theme");
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, "17-theme.png") });
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="theme-mode"][value="dark"]');
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(300);
  const dark = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    saved: JSON.parse(localStorage.getItem("sheet.theme.v1")).mode,
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  }));
  assert(dark.attr === "dark" && dark.saved === "dark", "切换深色主题并写入本地存储");
  assert(dark.bg === "#0e141d", "深色主题生效");
  await page.evaluate(() => {
    [...document.querySelectorAll(".modal button")].find((b) => b.textContent.trim() === "完成").click();
  });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, "16-dark.png") });

  await page.click("#btn-theme");
  await sleep(300);
  await page.click('.theme-swatch[data-color="#15803d"]');
  await sleep(250);
  const accent = await page.evaluate(() => ({
    primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    saved: JSON.parse(localStorage.getItem("sheet.theme.v1")).accent,
    hex: document.querySelector("#theme-hex").textContent,
  }));
  assert(accent.primary === "rgb(21, 128, 61)" && accent.saved === "#15803d", "自定义强调色立即生效");
  assert(accent.hex === "#15803D", "强调色数值同步显示");
  await sleep(500);
  const savedSettings = await page.evaluate(async () => {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sheet-Token": window.__sheetDev.state.token },
      body: JSON.stringify({}),
    });
    return (await res.json()).settings;
  });
  assert(savedSettings.theme.mode === "dark" && savedSettings.theme.accent === "#15803d", "主题写入程序设置文件");
  await page.evaluate(() => {
    [...document.querySelectorAll(".modal button")].find((b) => b.textContent.trim() === "完成").click();
  });
  await sleep(200);

  /* 20. 刷新后主题保持，空状态显示最近打开 */
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.waitForFunction("!!window.__sheetDev");
  await sleep(600);
  const restored = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: JSON.parse(localStorage.getItem("sheet.theme.v1")).mode,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    recentHidden: document.querySelector("#recent-home").hidden,
    recentCount: document.querySelectorAll("#recent-home-list .recent-item").length,
  }));
  assert(restored.theme === "dark" && restored.mode === "dark", "重启页面后保持深色主题");
  assert(restored.accent === "rgb(21, 128, 61)", "重启页面后保持自定义强调色");
  assert(!restored.recentHidden && restored.recentCount > 0, "空状态展示最近打开列表");
  await page.screenshot({ path: path.join(OUT, "19-recent-home.png") });

  /* 21. 清空历史记录 */
  await page.click("#btn-history");
  await sleep(300);
  await page.evaluate(() => {
    [...document.querySelectorAll(".modal button")].find((b) => b.textContent.trim() === "清空记录").click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".modal .btn.danger")];
    buttons[buttons.length - 1].click();
  });
  await sleep(600);
  const historyCleared = await page.evaluate(async () => {
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sheet-Token": window.__sheetDev.state.token },
      body: JSON.stringify({ action: "list" }),
    });
    const data = await res.json();
    return { items: (data.items || []).length, home: document.querySelector("#recent-home").hidden };
  });
  assert(historyCleared.items === 0, "清空历史记录生效");
  assert(historyCleared.home, "清空后不再显示最近打开列表");
  await page.evaluate(() => {
    const close = [...document.querySelectorAll(".modal button")].find((b) => b.textContent.trim() === "关闭");
    if (close) close.click();
  });
  await sleep(200);

  /* 恢复浅色默认主题，避免影响后续人工查看 */
  await page.evaluate(async () => {
    const theme = { mode: "light", accent: "#2563eb" };
    localStorage.setItem("sheet.theme.v1", JSON.stringify(theme));
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sheet-Token": window.__sheetDev.state.token },
      body: JSON.stringify({ theme }),
    });
  });

  console.log("CONSOLE ERRORS:", errors);
  assert(errors.length === 0, "没有前端报错");

  await browser.close();
  console.log("全部测试通过");
})().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
