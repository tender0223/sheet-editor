/* 验证公式栏、统一编辑入口、自动补全、双框修复（synthetic 事件驱动） */
const fs = require("fs");
const path = require("path");

const PORT = process.env.CDP_PORT || "9333";
const SHOT_DIR = path.join(__dirname, "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!res.ok) return null;
    const items = await res.json();
    return items.find((item) => item.type === "page" && item.url.includes("127.0.0.1")) || null;
  } catch (err) {
    return null;
  }
}

/* 单一 WebSocket 会话复用：CEF 下每条命令新建连接会得到空响应 */
let cdpSock = null;
let cdpReady = null;
let cdpId = 0;
const cdpPending = new Map();
function send(wsUrl, method, params) {
  if (!cdpSock || cdpSock.readyState > 1) {
    cdpSock = new WebSocket(wsUrl);
    cdpReady = new Promise((resolve, reject) => {
      cdpSock.addEventListener("open", resolve, { once: true });
      cdpSock.addEventListener("error", reject, { once: true });
    });
    cdpId = 0;
    cdpSock.addEventListener("message", (event) => {
      const m = JSON.parse(event.data.toString());
      if (m.id && cdpPending.has(m.id)) {
        const { resolve, reject } = cdpPending.get(m.id);
        cdpPending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }
  return cdpReady.then(() => new Promise((resolve, reject) => {
    const mid = ++cdpId;
    cdpPending.set(mid, { resolve, reject });
    cdpSock.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => {
      if (cdpPending.has(mid)) {
        cdpPending.delete(mid);
        reject(new Error("超时: " + method));
      }
    }, 30000);
  }));
}

async function evaluate(wsUrl, expression) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await send(wsUrl, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const result = resp && resp.result;
      if (!result) throw new Error("empty");
      if (result.exceptionDetails) {
        throw new Error("eval-exc: " + JSON.stringify(result.exceptionDetails).slice(0, 200));
      }
      return result.value;
    } catch (err) {
      if (String(err.message).indexOf("eval-exc:") === 0) throw err;
      if (attempt === 3) throw new Error("evaluate 失败(" + expression.slice(0, 60) + "): " + err.message);
      await sleep(600);
    }
  }
}

async function shot(wsUrl, name) {
  const result = await send(wsUrl, "Page.captureScreenshot", { format: "png" });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log("截图:", file);
}

(async () => {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = await listPage();
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("CDP 未就绪（请用 --dev --debug 启动应用）");
  const ws = page.webSocketDebuggerUrl;



  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(ok ? "通过:" : "失败:", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  /* 工具：向元素派发键盘事件 / 打字进编辑器 */
  const UTILS = `
  window.__fx = {
    keyGrid(key) {
      document.getElementById("grid-wrap").dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    keyEditor(key) {
      const ed = window.__sheetDev.state.editing;
      const input = ed ? ed.input : null;
      if (input) input.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    typeInto(text) {
      const ed = window.__sheetDev.state.editing;
      const input = ed ? ed.input : null;
      if (!input) return false;
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    clickCell(r, c) {
      const td = document.querySelector('#tbody td.cell[data-r="' + r + '"][data-c="' + c + '"]');
      if (!td) return false;
      td.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    },
    dblCell(r, c) {
      const td = document.querySelector('#tbody td.cell[data-r="' + r + '"][data-c="' + c + '"]');
      if (!td) return false;
      td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return true;
    },
    cellText(r, c) {
      const td = document.querySelector('#tbody td.cell[data-r="' + r + '"][data-c="' + c + '"]');
      return td ? td.textContent.trim() : null;
    },
    keyEditorUp(key) {
      const ed = window.__sheetDev.state.editing;
      const input = ed ? ed.input : null;
      if (!input) return;
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    },
    clickCellRaw(r, c, shiftKey) {
      const td = document.querySelector('#tbody td.cell[data-r="' + r + '"][data-c="' + c + '"]');
      if (!td) return false;
      td.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: !!shiftKey }));
      return true;
    },
    refs() {
      const boxes = [...document.querySelectorAll(".ref-box")];
      return {
        count: boxes.length,
        active: boxes.filter((b) => b.classList.contains("active")).length,
        handles: document.querySelectorAll(".ref-handle").length,
        texts: [...document.querySelectorAll(".ref-tag")].map((n) => n.textContent.trim()),
      };
    },
    ac() {
      const menu = document.querySelector(".ac-menu");
      if (!menu || menu.hidden) return { visible: false };
      return {
        visible: true,
        labels: [...menu.querySelectorAll(".ac-label")].map((n) => n.textContent.trim()),
        active: menu.querySelector(".ac-item.active .ac-label")
          ? menu.querySelector(".ac-item.active .ac-label").textContent.trim() : null,
      };
    },
  };
  true`;
  await evaluate(ws, UTILS);

  // 等文件打开；dev 新 tab 需要主动调用 openPaths
  let opened = false;
  for (let i = 0; i < 40; i++) {
    opened = await evaluate(ws, `(() => {
      const d = window.__sheetDev; if (!d) return false;
      return d.state.files.length > 0;
    })()`);
    if (opened) break;
    if (i === 6) {
      await evaluate(ws, `window.__sheetDev.openPaths([
        "D:\\\\agent\\\\项目\\\\excel\\\\tools\\\\testenv\\\\tmpfiles\\\\fx-ui-test.xlsx"
      ])`).catch(() => {});
    }
    await sleep(500);
  }

  // 1. 公式栏存在且可见
  let bar = await evaluate(ws, `(() => {
    const bar = document.getElementById("formula-bar");
    return { exists: !!bar, hidden: bar ? bar.hidden : null };
  })()`);
  assert("公式栏存在且未隐藏", bar.exists && bar.hidden === false, bar);

  // 2. 点击 E2（data-r=0 data-c=4，含公式），名称框与公式栏内容
  await evaluate(ws, `__fx.clickCell(0, 4)`);
  await sleep(150);
  let sync = await evaluate(ws, `(() => {
    const f = window.__sheetDev.state.files[0];
    return {
      nameBox: document.getElementById("name-box").value,
      barValue: document.getElementById("formula-input").value,
      raw: f.rows[0][4],
    };
  })()`);
  assert("名称框显示 E2", sync.nameBox === "E2", sync);
  assert("公式栏显示原始公式", sync.barValue === "=C2*D2", sync);

  // 3. 双框修复：进入编辑后 cell-input 无自身边框阴影
  await evaluate(ws, `__fx.dblCell(0, 4)`);
  await sleep(150);
  let frame = await evaluate(ws, `(() => {
    const td = document.querySelector("td.editing");
    if (!td) return { editing: false };
    const input = td.querySelector(".cell-input");
    const inputShadow = input ? getComputedStyle(input).boxShadow : null;
    const editingCount = document.querySelectorAll("td.editing").length;
    return { editing: true, editingCount, inputShadow, value: input ? input.value : null };
  })()`);
  assert("进入编辑只挂一个 td.editing", frame.editing && frame.editingCount === 1, frame);
  assert("单元格输入框自身无第二圈边框", frame.inputShadow === "none", frame.inputShadow);
  assert("编辑框显示原始公式", frame.value === "=C2*D2", frame.value);

  // 4. 公式栏焦点转移：编辑中 focus 公式栏 → 会话保持且不提交
  await evaluate(ws, `(() => {
    const bar = document.getElementById("formula-input");
    bar.focus();
    bar.dispatchEvent(new FocusEvent("focus"));
    return true;
  })()`);
  await sleep(150);
  let transfer = await evaluate(ws, `(() => {
    const d = window.__sheetDev;
    return {
      stillEditing: !!d.state.editing,
      viaBar: d.state.editing ? d.state.editing.viaBar : null,
      rowStillRaw: d.state.files[0].rows[0][4] === "=C2*D2",
      barFocused: document.activeElement === document.getElementById("formula-input"),
    };
  })()`);
  assert("焦点转移到公式栏保持编辑会话", transfer.stillEditing && transfer.viaBar === true && transfer.rowStillRaw, transfer);
  // 公式栏里继续输入也应同步回单元格输入框
  await evaluate(ws, `(() => {
    const input = document.getElementById("formula-input");
    input.value = "=C2*D2*10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
  let mirror = await evaluate(ws, `(() => {
    const td = document.querySelector("td.editing .cell-input");
    return { cellMirror: td ? td.value : null };
  })()`);
  assert("公式栏输入同步回单元格", mirror.cellMirror === "=C2*D2*10", mirror);
  await evaluate(ws, `__fx.keyEditor("Escape")`);
  await sleep(150);
  let cancelled = await evaluate(ws, `(() => ({
    editingGone: !window.__sheetDev.state.editing,
    rawKept: window.__sheetDev.state.files[0].rows[0][4] === "=C2*D2",
  }))()`);
  assert("Esc 取消编辑且不写入公式栏文本", cancelled.editingGone && cancelled.rawKept, cancelled);

  // 5. 直接键入字符进入编辑 + =1*2 立即计算
  await evaluate(ws, `__fx.clickCell(0, 1)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(120);
  let typing = await evaluate(ws, `(() => {
    const td = document.querySelector("td.editing");
    const input = td ? td.querySelector(".cell-input") : null;
    return {
      editing: !!td,
      cellValue: input ? input.value : null,
      barMirror: document.getElementById("formula-input").value,
    };
  })()`);
  assert("键入 = 直接进入编辑", typing.editing && typing.cellValue === "=", typing);
  await evaluate(ws, `__fx.typeInto("=1*2")`);
  await sleep(120);
  typing = await evaluate(ws, `(() => ({
    cellValue: document.querySelector("td.editing .cell-input").value,
    barMirror: document.getElementById("formula-input").value,
  }))()`);
  assert("公式栏实时同步 =1*2", typing.barMirror === "=1*2" && typing.cellValue === "=1*2", typing);
  await evaluate(ws, `__fx.keyEditor("Enter")`);
  await sleep(200);
  let calc = await evaluate(ws, `(() => ({
    shown: __fx.cellText(0, 1),
    raw: window.__sheetDev.state.files[0].rows[0][1],
  }))()`);
  assert("=1*2 计算结果为 2", calc.shown === "2" && calc.raw === "=1*2", calc);

  // 6. 自动补全：键入 =SU 出现 SUM（常用函数优先），Tab 采纳
  await evaluate(ws, `__fx.clickCell(0, 0)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("=SU")`);
  await sleep(200);
  let ac = await evaluate(ws, `__fx.ac()`);
  assert("输入 =SU 弹出补全且 SUM 优先", ac.visible && ac.labels.includes("SUM") && ac.active === "SUM", ac);
  await evaluate(ws, `__fx.keyEditor("Tab")`);
  await sleep(150);
  let accepted = await evaluate(ws, `(() => ({
    value: (document.querySelector("td.editing .cell-input") || {}).value || null,
    ac: __fx.ac(),
  }))()`);
  assert("Tab 采纳为 SUM(", accepted.value === "=SUM(" && accepted.ac.visible === false, accepted);
  await evaluate(ws, `__fx.typeInto("=SUM(C2:D5)")`);
  await sleep(120);
  await evaluate(ws, `__fx.keyEditor("Enter")`);
  await sleep(200);
  let sum = await evaluate(ws, `__fx.cellText(0, 0)`);
  assert("SUM(C2:D5) 结果 = 26", sum === "26", sum);

  // 7. 数据变更后自动重算：C2 数量 3.5→10，E2 应变 20
  await evaluate(ws, `__fx.dblCell(0, 2)`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("10")`);
  await evaluate(ws, `__fx.keyEditor("Enter")`);
  await sleep(200);
  let recalc = await evaluate(ws, `__fx.cellText(0, 4)`);
  assert("修改 C2 后 E2 自动重算为 20", recalc === "20", recalc);

  // 8. 名称框跳转 B4（第 4 个 Excel 行 = 数据第 3 行）
  await evaluate(ws, `(() => {
    const box = document.getElementById("name-box");
    box.focus();
    box.value = "B4";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  let jump = await evaluate(ws, `(() => {
    const f = window.__sheetDev.state.files[0];
    return { active: f.activeCell, barValue: document.getElementById("formula-input").value };
  })()`);
  assert("名称框 B4 跳转", jump.active && jump.active.r === 2 && jump.active.c === 1 && jump.barValue === "橙子", jump);

  // 9. IF 函数与错误提示
  await evaluate(ws, `__fx.clickCell(1, 0)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(100);
  await evaluate(ws, `__fx.typeInto("=IF(D2>1, \\"高\\", \\"低\\")")`);
  await sleep(100);
  await evaluate(ws, `__fx.keyEditor("Enter")`);
  await sleep(200);
  let ifRes = await evaluate(ws, `__fx.cellText(1, 0)`);
  assert("IF 函数返回 高", ifRes === "高", ifRes);

  await evaluate(ws, `__fx.clickCell(2, 0)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(100);
  await evaluate(ws, `__fx.typeInto("=NOSUCHFUNC(1)")`);
  await sleep(100);
  await evaluate(ws, `__fx.keyEditor("Enter")`);
  await sleep(200);
  let errRes = await evaluate(ws, `(() => ({
    text: __fx.cellText(2, 0),
    marked: !!document.querySelector('#tbody td.cell[data-r="2"][data-c="0"].cell-error'),
  }))()`);
  assert("未知函数显示 #NAME? 并标红", errRes.text === "#NAME?" && errRes.marked, errRes);

  // 10. 上下键切换候选（keydown 后 keyup 不重置选中项；候选 SUM/SUMIF 两项）
  await evaluate(ws, `__fx.clickCell(3, 0)`);
  await sleep(120);
  await evaluate(ws, `__fx.keyGrid("=")`);
  await sleep(100);
  await evaluate(ws, `__fx.typeInto("=SUM")`);
  await sleep(200);
  await evaluate(ws, `__fx.keyEditorUp("ArrowDown")`);
  await sleep(150);
  await evaluate(ws, `__fx.keyEditorUp("ArrowDown")`);
  await sleep(150);
  let acNav = await evaluate(ws, `(() => {
    const menu = document.querySelector(".ac-menu");
    return { active: menu && menu.querySelector(".ac-item.active .ac-label") ? menu.querySelector(".ac-item.active .ac-label").textContent.trim() : null, hidden: menu ? menu.hidden : null };
  })()`);
  assert("上下键切换候选选中项（两次循环回 SUM）", acNav.active === "SUM" && acNav.hidden === false, acNav);
  await evaluate(ws, `__fx.keyEditorUp("ArrowUp")`);
  await sleep(150);
  let acNav2 = await evaluate(ws, `(() => {
    const menu = document.querySelector(".ac-menu");
    return menu.querySelector(".ac-item.active .ac-label").textContent.trim();
  })()`);
  assert("上键回选前一项 SUMIF", acNav2 === "SUMIF", acNav2);
  await evaluate(ws, `__fx.keyEditor("Escape")`);
  await sleep(120);

  // 11. 引用高亮：编辑 =SUM(C2:D5,B4) 出现两个框、一个角标，光标所在引用高亮
  await evaluate(ws, `__fx.dblCell(3, 0)`);
  await sleep(100);
  await evaluate(ws, `__fx.typeInto("=SUM(C2:D5,B4)")`);
  await sleep(200);
  let refs1 = await evaluate(ws, `__fx.refs()`);
  assert("引用高亮框出现 2 个", refs1.count === 2, refs1);
  assert("范围引用角标出现 1 个", refs1.handles === 1, refs1);
  assert("高亮标签文本正确", refs1.texts.includes("C2:D5") && refs1.texts.includes("B4"), refs1);

  // 光标移到最后（在 B4 上）→ B4 为 active
  await evaluate(ws, `(() => {
    const input = window.__sheetDev.state.editing.input;
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  let refs2 = await evaluate(ws, `__fx.refs()`);
  assert("光标在 B4 时该框为强调态", refs2.count === 2 && refs2.active === 1, refs2);

  // 12. 编辑公式时点击单元格插入引用（先把光标移到右括号前）
  await evaluate(ws, `(() => {
    const input = window.__sheetDev.state.editing.input;
    input.setSelectionRange(input.value.length - 1, input.value.length - 1);
    return true;
  })()`);
  await evaluate(ws, `__fx.clickCellRaw(1, 2)`);
  await sleep(150);
  let inserted = await evaluate(ws, `(() => ({
    value: window.__sheetDev.state.editing.input.value,
    editing: !!window.__sheetDev.state.editing,
  }))()`);
  assert("点击单元格插入引用 C3", inserted.editing && inserted.value === "=SUM(C2:D5,B4,C3)", inserted);

  // 13. Shift+点击插入区域
  await evaluate(ws, `__fx.clickCellRaw(2, 2, true)`);
  await sleep(150);
  let ranged = await evaluate(ws, `(() => ({
    value: window.__sheetDev.state.editing.input.value,
  }))()`);
  assert("Shift+点击插入区域 C3:C4", ranged.value === "=SUM(C2:D5,B4,C3,C3:C4)", ranged);

  // 14. 角标弹窗切换区域
  await evaluate(ws, `__fx.typeInto("=SUM(C2:D5)")`);
  await sleep(200);
  await evaluate(ws, `(() => {
    const h = document.querySelector(".ref-handle");
    if (!h) return false;
    h.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  let popOpen = await evaluate(ws, `(() => {
    const pop = document.querySelector(".ref-pop");
    return { visible: pop && !pop.hidden, value: pop ? pop.querySelector(".ref-pop-input").value : null };
  })()`);
  assert("角标弹窗打开且显示 C2:D5", popOpen.visible && popOpen.value === "C2:D5", popOpen);
  await evaluate(ws, `(() => {
    const input = document.querySelector(".ref-pop-input");
    input.value = "C2:C5";
    return true;
  })()`);
  await evaluate(ws, `(() => {
    document.querySelector('.ref-pop [data-act="ok"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  let popApplied = await evaluate(ws, `(() => ({
    value: window.__sheetDev.state.editing.input.value,
    popHidden: document.querySelector(".ref-pop").hidden,
    editorFocused: document.activeElement === window.__sheetDev.state.editing.input,
  }))()`);
  assert("弹窗确定后公式区域改为 C2:C5", popApplied.value === "=SUM(C2:C5)" && popApplied.popHidden && popApplied.editorFocused, popApplied);

  // 15. 非公式编辑时点击单元格：不插引用、不弹高亮（真实提交由 blur 完成）
  await evaluate(ws, `__fx.keyEditor("Escape")`);
  await sleep(120);
  await evaluate(ws, `__fx.dblCell(3, 1)`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("普通文本")`);
  await sleep(100);
  await evaluate(ws, `__fx.clickCellRaw(1, 1)`);
  await sleep(200);
  let plainClick = await evaluate(ws, `(() => ({
    valueKept: window.__sheetDev.state.editing && window.__sheetDev.state.editing.input.value === "普通文本",
    noRefs: document.querySelectorAll(".ref-box").length === 0,
  }))()`);
  assert("非公式编辑点击单元格不插引用", plainClick.valueKept && plainClick.noRefs, plainClick);

  await shot(ws, "60-formula-bar.png");

  // 深色主题 + 补全菜单截图
  await evaluate(ws, `document.documentElement.setAttribute("data-theme", "dark")`);
  await evaluate(ws, `__fx.dblCell(0, 4)`);
  await sleep(120);
  await evaluate(ws, `__fx.typeInto("=A")`);
  await sleep(200);
  await shot(ws, "61-dark-ac.png");
  await evaluate(ws, `(() => {
    window.__sheetDev.state.editing = null;
    document.documentElement.setAttribute("data-theme", "light");
    document.body.focus();
    return true;
  })()`);
  await sleep(300);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
