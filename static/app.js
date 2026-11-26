(function () {
  "use strict";

  const ROW_H = 34;
  const MAX_UNDO = 40;
  const DEFAULT_HEADER = ["序号", "账号", "密码", "服", "等级", "姓名",
    "金卡", "金币", "银币", "金矿石", "银矿石", "自定义采集"];

  const state = {
    files: [],
    activeId: null,
    busy: false,
    lastDirty: false,
    editing: null,
    token: "",
    clipboard: null,
    activeModal: null,
    modalStack: [],
    history: [],
    theme: { mode: "light", accent: "#2563eb" },
    settings: { template: { path: "", openOnStart: false, useOnNew: false, exists: false } },
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    tabbar: $("tabbar"),
    toolbar: $("toolbar"),
    batchbar: $("batchbar"),
    empty: $("empty"),
    gridWrap: $("grid-wrap"),
    grid: $("grid"),
    colgroup: $("colgroup"),
    thead: $("thead"),
    tbody: $("tbody"),
    statusPath: $("status-path"),
    statusMeta: $("status-meta"),
    statusExtra: $("status-extra"),
    searchInput: $("search-input"),
    searchScope: $("search-scope"),
    searchCount: $("search-count"),
    searchFilter: $("search-filter"),
    modalRoot: $("modal-root"),
    toastRoot: $("toast-root"),
    loading: $("loading"),
    loadingText: $("loading-text"),
    moreMenu: $("more-menu"),
    recentHome: $("recent-home"),
    recentHomeList: $("recent-home-list"),
    formulaBar: $("formula-bar"),
    nameBox: $("name-box"),
    formulaInput: $("formula-input"),
    exportMenu: $("export-menu"),
    freezeMenu: $("freeze-menu"),
    freezeLabel: $("freeze-label"),
    checkAll: null,
  };

  /* 公式自动补全菜单（全局唯一实例） */
  const acMenu = document.createElement("div");
  acMenu.className = "ac-menu";
  acMenu.hidden = true;
  document.body.appendChild(acMenu);
  let acItems = [];
  let acIndex = 0;
  let acOwner = null;

  const calcPreview = document.createElement("div");
  calcPreview.className = "calc-preview";
  calcPreview.hidden = true;
  document.body.appendChild(calcPreview);

  /* 公式引用高亮层与区域角标弹窗（全局唯一实例） */
  const refLayer = document.createElement("div");
  refLayer.className = "ref-layer";
  document.body.appendChild(refLayer);
  const refPop = document.createElement("div");
  refPop.className = "ref-pop";
  refPop.hidden = true;
  refPop.innerHTML = `<div class="ref-pop-title">引用区域</div>
    <input class="ref-pop-input" spellcheck="false" autocomplete="off">
    <div class="ref-pop-actions">
      <button type="button" class="mini-btn" data-act="remove" title="从公式中删除此引用">删除</button>
      <button type="button" class="btn small" data-act="cancel">取消</button>
      <button type="button" class="btn small primary" data-act="ok">确定</button>
    </div>`;
  document.body.appendChild(refPop);
  let refPopTarget = null; /* { start, end } 在公式文本中的位置 */

  const COMMON_FUNCS = ["SUM", "AVERAGE", "MAX", "MIN", "IF", "COUNT", "COUNTA",
    "ROUND", "IFERROR", "VLOOKUP", "COUNTIF", "SUMIF", "CONCAT", "TODAY", "NOW"];

  /* 基础工具 */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(value) {
    return esc(value).replace(/"/g, "&quot;");
  }
  function active() {
    return state.files.find((f) => f.id === state.activeId) || null;
  }
  function isTextInput(target) {
    if (!target || !target.closest) return false;
    return !!target.closest("input, textarea, select, [contenteditable='true']");
  }
  function baseName(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }
  function dirName(path) {
    const s = String(path || "");
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i > 0 ? s.slice(0, i) : "";
  }
  function stem(name) {
    return String(name || "").replace(/\.[^.\\/]+$/, "");
  }
  function signature(f) {
    return JSON.stringify([f.header, f.rows]);
  }
  function padRow(row, width) {
    const out = row.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  }
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  function textWidth(value) {
    let width = 0;
    for (const ch of String(value == null ? "" : value)) {
      width += /[\u1100-\uFFFF]/.test(ch) ? 13 : 7.2;
    }
    return width;
  }

  function toast(message, kind) {
    const node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = message;
    el.toastRoot.appendChild(node);
    setTimeout(() => {
      node.style.transition = "opacity .2s ease, transform .2s ease";
      node.style.opacity = "0";
      node.style.transform = "translateY(4px)";
      setTimeout(() => node.remove(), 220);
    }, kind === "error" ? 4200 : 2300);
  }

  function setLoading(on, text) {
    state.busy = !!on;
    el.loading.hidden = !on;
    if (text) el.loadingText.textContent = text;
  }

  async function api(path, body) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["X-Sheet-Token"] = state.token;
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {}),
      });
    } catch (err) {
      throw new Error("无法连接本地服务，请重新启动程序");
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error("本地服务返回异常");
    }
    if (!data || data.ok === false) {
      throw new Error((data && data.error) || "操作失败");
    }
    return data;
  }

  /* 主题 */
  const THEME_KEY = "sheet.theme.v1";
  const THEME_PRESETS = [
    { name: "蓝", color: "#2563eb" },
    { name: "青", color: "#0d9488" },
    { name: "绿", color: "#15803d" },
    { name: "橙", color: "#ea580c" },
    { name: "紫", color: "#7c3aed" },
    { name: "玫红", color: "#e11d48" },
  ];

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return [37, 99, 235];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixRgb(a, b, ratio) {
    return a.map((v, i) => Math.round(v + (b[i] - v) * ratio));
  }

  function loadTheme() {
    const fallback = { mode: "light", accent: "#2563eb" };
    try {
      const saved = JSON.parse(localStorage.getItem(THEME_KEY) || "null");
      if (!saved || typeof saved !== "object") return fallback;
      const mode = ["light", "dark", "system"].includes(saved.mode) ? saved.mode : "light";
      const accent = /^#[0-9a-f]{6}$/i.test(saved.accent || "") ? saved.accent : "#2563eb";
      return { mode, accent };
    } catch (err) {
      return fallback;
    }
  }

  function themeIsDark() {
    return state.theme.mode === "dark" ||
      (state.theme.mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyTheme() {
    const dark = themeIsDark();
    const root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    const rgb = hexToRgb(state.theme.accent);
    const hover = mixRgb(rgb, [0, 0, 0], .16);
    const selText = mixRgb(rgb, dark ? [255, 255, 255] : [0, 0, 0], dark ? .62 : .32);
    const pack = (v) => v.join(", ");
    root.style.setProperty("--primary", "rgb(" + pack(rgb) + ")");
    root.style.setProperty("--primary-2", "rgb(" + pack(hover) + ")");
    root.style.setProperty("--primary-rgb", pack(rgb));
    root.style.setProperty("--primary-soft", "rgba(" + pack(rgb) + ", " + (dark ? .18 : .09) + ")");
    root.style.setProperty("--primary-line", "rgba(" + pack(rgb) + ", " + (dark ? .58 : .45) + ")");
    root.style.setProperty("--sel", "rgba(" + pack(rgb) + ", " + (dark ? .24 : .1) + ")");
    root.style.setProperty("--sel-strong", "rgba(" + pack(rgb) + ", " + (dark ? .36 : .18) + ")");
    root.style.setProperty("--sel-text", "rgb(" + pack(selText) + ")");
  }

  let themeSaveTimer = 0;

  function persistTheme() {
    clearTimeout(themeSaveTimer);
    themeSaveTimer = setTimeout(() => {
      api("/api/settings", { theme: state.theme }).catch(() => {});
    }, 250);
  }

  async function loadSettings() {
    try {
      const res = await api("/api/settings", {});
      state.settings = res.settings || state.settings;
      const theme = res.settings && res.settings.theme;
      if (theme && theme.mode) {
        state.theme = { mode: theme.mode, accent: theme.accent };
        try {
          localStorage.setItem(THEME_KEY, JSON.stringify(state.theme));
        } catch (err) {}
        applyTheme();
      }
    } catch (err) {}
  }

  function setTheme(patch) {
    state.theme = Object.assign({}, state.theme, patch);
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(state.theme));
    } catch (err) {}
    applyTheme();
    persistTheme();
  }

  function refreshThemeFields(modal) {
    const theme = state.theme;
    modal.body.querySelectorAll('input[name="theme-mode"]').forEach((radio) => {
      radio.checked = radio.value === theme.mode;
    });
    const color = modal.body.querySelector("#theme-color");
    if (color) color.value = theme.accent;
    const hex = modal.body.querySelector("#theme-hex");
    if (hex) hex.textContent = theme.accent.toUpperCase();
    modal.body.querySelectorAll(".theme-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color.toLowerCase() === theme.accent.toLowerCase());
    });
  }

  function openThemeDialog() {
    const theme = state.theme;
    const swatches = THEME_PRESETS.map((preset) =>
      `<button type="button" class="theme-swatch${preset.color.toLowerCase() === theme.accent.toLowerCase() ? " active" : ""}" data-color="${preset.color}" title="${preset.name}" aria-label="${preset.name}" style="background:${preset.color}"></button>`
    ).join("");
    const content = `<div class="form-row">
        <label>主题模式</label>
        <div class="field"><div class="seg">
          <label><input type="radio" name="theme-mode" value="light" ${theme.mode === "light" ? "checked" : ""}>浅色</label>
          <label><input type="radio" name="theme-mode" value="dark" ${theme.mode === "dark" ? "checked" : ""}>深色</label>
          <label><input type="radio" name="theme-mode" value="system" ${theme.mode === "system" ? "checked" : ""}>跟随系统</label>
        </div></div>
      </div>
      <div class="form-row">
        <label>强调色</label>
        <div class="field">
          <div class="theme-swatches" id="theme-swatches">${swatches}</div>
          <div class="theme-custom">
            <span class="theme-custom-label">自定义</span>
            <input type="color" class="theme-color" id="theme-color" value="${theme.accent}">
            <span class="theme-hex" id="theme-hex">${theme.accent.toUpperCase()}</span>
          </div>
        </div>
      </div>
      <div class="hint-box">主题会自动保存，下次启动继续使用。强调色会应用到按钮、选中行、搜索框等位置。</div>`;
    const modal = showModal({
      title: "外观与主题",
      content,
      buttons: [
        {
          label: "恢复默认", onClick: () => {
            setTheme({ mode: "light", accent: "#2563eb" });
            refreshThemeFields(modal);
            return false;
          }
        },
        { label: "完成", primary: true },
      ],
    });
    modal.body.querySelectorAll('input[name="theme-mode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked) setTheme({ mode: radio.value });
      });
    });
    modal.body.querySelectorAll(".theme-swatch").forEach((btn) => {
      btn.addEventListener("click", () => {
        setTheme({ accent: btn.dataset.color });
        refreshThemeFields(modal);
      });
    });
    const color = modal.body.querySelector("#theme-color");
    color.addEventListener("input", () => {
      setTheme({ accent: color.value });
      const hex = modal.body.querySelector("#theme-hex");
      if (hex) hex.textContent = color.value.toUpperCase();
      modal.body.querySelectorAll(".theme-swatch").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.color.toLowerCase() === color.value.toLowerCase());
      });
    });
  }

  function openTemplateDialog() {
    const f = active();
    if (f && f.path && f.dirty) {
      toast("请先保存当前修改，再设为默认模板", "error");
      return;
    }
    const configured = state.settings.template || { path: "", openOnStart: false, useOnNew: false };
    const currentPath = f ? (f.path || f.sourcePath || "") : "";
    const path = currentPath || configured.path || "";
    const useCurrent = !!currentPath;
    const openOnStart = useCurrent ? true : !!configured.openOnStart;
    const useOnNew = useCurrent ? true : !!configured.useOnNew;
    const content = path ? `<div class="form-row">
        <label>模板文件</label>
        <div class="field"><div class="template-path" title="${escAttr(path)}">${esc(path)}</div></div>
      </div>
      <div class="template-options">
        <label><input type="checkbox" id="template-start" ${openOnStart ? "checked" : ""}>启动时自动打开模板副本</label>
        <label><input type="checkbox" id="template-new" ${useOnNew ? "checked" : ""}>点击“新建表格”时使用此模板</label>
      </div>
      <div class="hint-box">模板始终以副本方式打开，修改不会写回源文件。若文件有未保存修改，请先保存后再设为模板。</div>` :
      `<div class="hint-box">还没有设置默认模板。请先打开并保存一个表格文件，再点击顶部“默认模板”进行设置。</div>`;
    const buttons = [{ label: "关闭", primary: !path }];
    if (configured.path) {
      buttons.push({
        label: "清除默认模板", danger: true, onClick: async () => {
          const res = await api("/api/settings", {
            template: { path: "", openOnStart: false, useOnNew: false },
          });
          state.settings = res.settings;
          renderToolbar();
          toast("已清除默认模板");
          return true;
        },
      });
    }
    if (path) {
      buttons.push({
        label: "保存设置", primary: true, onClick: async ({ body }) => {
          const res = await api("/api/settings", {
            template: {
              path,
              openOnStart: body.querySelector("#template-start").checked,
              useOnNew: body.querySelector("#template-new").checked,
            },
          });
          state.settings = res.settings;
          renderToolbar();
          toast("默认模板已设置", "success");
          return true;
        },
      });
    }
    showModal({
      title: "默认模板",
      desc: useCurrent ? "把当前文件设为模板，下次启动或新建表格时直接使用。" : "管理启动时默认打开的模板文件。",
      content,
      width: "580px",
      buttons,
    });
  }

  /* 历史记录 */
  function formatHistoryTime(stamp) {
    const seconds = Number(stamp) || 0;
    if (!seconds) return "";
    const date = new Date(seconds * 1000);
    if (isNaN(date.getTime())) return "";
    const now = new Date();
    const diff = (now - date) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    const hhmm = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
    if (date.toDateString() === now.toDateString()) return "今天 " + hhmm;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "昨天 " + hhmm;
    return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + hhmm;
  }

  function recentItemHTML(item, opts) {
    const missing = item.exists === false;
    const row = `<button type="button" class="recent-item${missing ? " missing" : ""}" data-path="${escAttr(item.path)}" title="${escAttr(item.path)}">
        <span class="rmain"><span class="rname">${esc(item.name)}</span><span class="rpath">${esc(item.path)}</span></span>
        ${missing ? '<span class="recent-tag">不存在</span>' : ""}
        <span class="rtime">${esc(formatHistoryTime(item.time))}</span>
      </button>`;
    if (!(opts && opts.removable && missing)) return row;
    return `<div class="recent-row">${row}<button type="button" class="recent-remove" data-remove="${escAttr(item.path)}" title="从历史记录中移除这条">移除</button></div>`;
  }

  function renderRecentHome() {
    if (!el.recentHome) return;
    const items = (state.history || []).slice(0, 5);
    el.recentHome.hidden = !items.length || !!active();
    if (!el.recentHome.hidden) {
      el.recentHomeList.innerHTML = items.map(recentItemHTML).join("");
    }
  }

  async function refreshHistory() {
    try {
      const res = await api("/api/history", { action: "list" });
      state.history = res.items || [];
      renderRecentHome();
    } catch (err) {}
  }

  function openHistoryItem(path) {
    const item = (state.history || []).find((x) => x.path === path);
    if (item && item.exists === false) {
      toast("文件不存在，可能已被移动或删除", "error");
      return;
    }
    openPaths([path]);
  }

  function openHistory() {
    const items = state.history || [];
    const descText = () => {
      const list = state.history || [];
      const missing = list.filter((x) => x.exists === false).length;
      return "最多保留最近 20 个文件，点击即可重新打开。" +
        (missing ? ` 其中 ${missing} 个文件已不存在，可单独移除。` : "");
    };
    const content = `<div class="recent-list modal-list" id="history-list">${
      items.length ? items.map((x) => recentItemHTML(x, { removable: true })).join("") : '<div class="recent-empty">还没有打开记录</div>'
    }</div>`;
    const modal = showModal({
      title: "最近打开",
      desc: descText(),
      content,
      buttons: [
        {
          label: "清除失效记录", onClick: async () => {
            const left = (state.history || []).filter((x) => x.exists === false).length;
            if (!left) {
              toast("没有失效的文件记录");
              return false;
            }
            const ok = await confirmDialog("清除失效记录",
              `确定移除 ${left} 条文件已不存在的记录吗？不会删除任何文件。`, "清除");
            if (!ok) return false;
            try {
              const res = await api("/api/history", { action: "prune" });
              state.history = res.items || [];
              renderRecentHome();
              toast(`已清除 ${res.removed || 0} 条失效记录`);
            } catch (err) {
              toast(err.message, "error");
              return false;
            }
            return true;
          }
        },
        {
          label: "清空记录", danger: true, onClick: async () => {
            if (!(state.history || []).length) {
              toast("历史记录已经是空的");
              return false;
            }
            const ok = await confirmDialog("清空历史记录", "确定清空所有最近打开记录吗？不会删除任何文件。", "清空");
            if (!ok) return false;
            try {
              await api("/api/history", { action: "clear" });
              state.history = [];
              renderRecentHome();
              toast("已清空历史记录");
            } catch (err) {
              toast(err.message, "error");
            }
            return true;
          }
        },
        { label: "关闭", primary: true },
      ],
    });
    modal.body.addEventListener("click", async (ev) => {
      const rm = ev.target.closest(".recent-remove[data-remove]");
      if (rm) {
        ev.preventDefault();
        ev.stopPropagation();
        const path = rm.dataset.remove;
        try {
          const res = await api("/api/history", { action: "remove", path });
          state.history = res.items || [];
          renderRecentHome();
          const list = modal.body.querySelector("#history-list");
          if (list) {
            list.innerHTML = state.history.length
              ? state.history.map((x) => recentItemHTML(x, { removable: true })).join("")
              : '<div class="recent-empty">还没有打开记录</div>';
          }
          const descEl = modal.modal.querySelector(".modal-desc");
          if (descEl) descEl.textContent = descText();
          toast("已从历史记录中移除");
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }
      const btn = ev.target.closest(".recent-item[data-path]");
      if (!btn) return;
      modal.close();
      openHistoryItem(btn.dataset.path);
    });
  }

  async function clearAllHistory() {
    if (!(state.history || []).length) return;
    const ok = await confirmDialog("清空历史记录", "确定清空所有最近打开记录吗？不会删除任何文件。", "清空");
    if (!ok) return;
    try {
      await api("/api/history", { action: "clear" });
      state.history = [];
      renderRecentHome();
      toast("已清空历史记录");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* 文件对象 */
  function makeFile(data) {
    const header = (data.header || []).map((v) => String(v == null ? "" : v));
    const width = Math.max(header.length, 1);
    const rows = (data.rows || []).map((row) => padRow(
      (row || []).map((v) => String(v == null ? "" : v)), width));
    const f = {
      id: data.id,
      name: data.name || "未命名表格.xlsx",
      path: data.path || "",
      sourcePath: data.sourcePath || "",
      dir: data.path ? dirName(data.path) : "",
      kind: data.kind || "html",
      encoding: data.encoding || "UTF-8",
      sheet: data.sheet || "",
      isTemplate: !!data.isTemplate,
      header,
      rows,
      widths: [],
      numW: 52,
      cbW: 38,
      undo: [],
      redo: [],
      sel: new Set(),
      anchor: null,
      activeCell: null,
      scrollTop: 0,
      dirty: false,
      isNew: !!data.isNew,
      search: { q: "", scope: -1, filter: false, list: [], byCell: new Map(), index: -1, activeRange: null },
      filters: {},
      freezeFirst: false,
      freezeCol: false,
      formulaCache: new Map(),
      formulaActive: new Set(),
      formulaFill: {},
      _visDirty: true,
      _vis: null,
    };
    f.widths = computeWidths(f);
    f.savedSig = signature(f);
    return f;
  }

  function computeWidths(f) {
    const widths = [];
    for (let c = 0; c < f.header.length; c++) {
      let w = textWidth(f.header[c]) + 28;
      const limit = Math.min(f.rows.length, 400);
      for (let r = 0; r < limit; r++) {
        w = Math.max(w, textWidth(cellText(f, r, c)) + 24);
      }
      widths.push(clamp(Math.round(w), 66, 280));
    }
    return widths;
  }

  function ensureWidths(f) {
    if (!f.widths || f.widths.length !== f.header.length) {
      f.widths = computeWidths(f);
    }
  }

  /* 公式计算 */
  function isFormula(value) {
    return typeof value === "string" && value.charAt(0) === "=";
  }

  function invalidateCalculations(f) {
    if (!f.formulaCache) f.formulaCache = new Map();
    if (!f.formulaActive) f.formulaActive = new Set();
    f.formulaCache.clear();
    f.formulaActive.clear();
  }

  function cellRaw(f, r, c) {
    const row = f.rows[r];
    const value = row ? row[c] : "";
    return value == null ? "" : value;
  }

  function formulaResult(f, r, c) {
    const raw = cellRaw(f, r, c);
    if (!isFormula(raw)) return { text: String(raw), value: raw, error: false };
    const key = r + ":" + c;
    const cached = f.formulaCache.get(key);
    if (cached) return cached;
    if (f.formulaActive.has(key)) {
      return { text: SheetFormula.ERR.CIRC, value: SheetFormula.error(SheetFormula.ERR.CIRC), error: true };
    }
    f.formulaActive.add(key);
    let value;
    try {
      value = SheetFormula.evaluate(raw, { get: (rr, cc) => refCellValue(f, rr, cc) });
    } catch (err) {
      value = SheetFormula.error(SheetFormula.ERR.VALUE);
    }
    f.formulaActive.delete(key);
    const shown = SheetFormula.display(value);
    const result = { text: shown.text, value, error: shown.error };
    f.formulaCache.set(key, result);
    return result;
  }

  function refCellValue(f, r, c) {
    if (c < 0 || c >= f.header.length || r < 0) return "";
    if (r === 0) return f.header[c] == null ? "" : String(f.header[c]);
    const row = r - 1;
    if (row >= f.rows.length) return "";
    const result = formulaResult(f, row, c);
    return isFormula(cellRaw(f, row, c)) ? result.value : result.text;
  }

  function cellText(f, r, c) {
    return formulaResult(f, r, c).text;
  }

  function hasFormulas(f) {
    return f.rows.some((row) => row.some((value) => isFormula(value)));
  }

  function displayRowsOf(f) {
    return f.rows.map((row, r) => row.map((_, c) => cellText(f, r, c)));
  }

  function remapFormulas(f, rowMap, colMap) {
    for (const row of f.rows) {
      for (let c = 0; c < row.length; c++) {
        if (!isFormula(row[c])) continue;
        row[c] = SheetFormula.remapRefs(row[c], { rows: rowMap || null, cols: colMap || null });
      }
    }
  }

  function remapFormulaFillColumns(f, colMap) {
    const next = {};
    for (const key of Object.keys(f.formulaFill || {})) {
      const col = colMap(Number(key));
      if (col < 0) continue;
      next[col] = {
        formula: SheetFormula.remapRefs(f.formulaFill[key].formula, { cols: colMap }),
        baseRow: f.formulaFill[key].baseRow,
      };
    }
    f.formulaFill = next;
  }

  function remapFormulaFillRows(f, rowMap, baseRowMap) {
    const mapBase = baseRowMap || rowMap;
    for (const rule of Object.values(f.formulaFill || {})) {
      const oldBase = rule.baseRow;
      const mappedBase = mapBase(oldBase);
      if (mappedBase >= 0) {
        rule.formula = SheetFormula.remapRefs(rule.formula, { rows: rowMap });
        rule.baseRow = mappedBase;
        continue;
      }
      let nextBase = -1;
      for (let r = oldBase + 1; r < f.rows.length; r++) {
        const mapped = mapBase(r);
        if (mapped >= 0) {
          nextBase = mapped;
          break;
        }
      }
      if (nextBase < 0) {
        for (let r = oldBase - 1; r >= 0; r--) {
          const mapped = mapBase(r);
          if (mapped >= 0) {
            nextBase = mapped;
            break;
          }
        }
      }
      if (nextBase < 0) nextBase = 0;
      rule.formula = SheetFormula.shiftRefs(rule.formula, nextBase - oldBase, 0, rowMap);
      rule.baseRow = nextBase;
    }
  }

  function applyFormulaFillRules(f, indices) {
    for (const r of indices) {
      if (!f.rows[r]) continue;
      for (const key of Object.keys(f.formulaFill || {})) {
        const col = Number(key);
        if (col >= f.header.length) continue;
        const rule = f.formulaFill[key];
        f.rows[r][col] = SheetFormula.shiftRefs(rule.formula, r - rule.baseRow, 0);
      }
    }
  }

  function fillFormula(f, col, indices, formula, baseRow) {
    if (!f.formulaFill) f.formulaFill = {};
    f.formulaFill[col] = { formula, baseRow };
    for (const r of indices) {
      f.rows[r][col] = SheetFormula.shiftRefs(formula, r - baseRow, 0);
    }
  }

  function deleteMapFromSet(set) {
    const removed = Array.from(set).sort((a, b) => a - b);
    return (i) => {
      if (set.has(i)) return -1;
      let shift = 0;
      for (const d of removed) {
        if (d < i) shift++;
        else break;
      }
      return i - shift;
    };
  }

  /* 公式使用 Excel 行号：第 1 行是表头，第一条数据是第 2 行 */
  function deleteRowRefMap(set) {
    const inner = deleteMapFromSet(set);
    return (i) => {
      if (i === 0) return 0;
      const mapped = inner(i - 1);
      return mapped < 0 ? -1 : mapped + 1;
    };
  }

  /* 标签与工具条 */
  function renderTabs() {
    const show = state.files.length > 0;
    el.tabbar.hidden = !show;
    if (!show) {
      el.tabbar.innerHTML = "";
      return;
    }
    el.tabbar.innerHTML = state.files.map((f) => {
      return `<div class="tab${f.id === state.activeId ? " active" : ""}" data-id="${f.id}" title="${escAttr(f.path || (f.sourcePath ? "模板副本，源文件：" + f.sourcePath : "尚未保存"))}">
        <span class="tab-name">${esc(f.name)}</span>
        ${f.dirty ? '<span class="tab-dot" title="有未保存的修改"></span>' : ""}
        <button class="tab-close" data-close="${f.id}" title="关闭" aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"></path></svg>
        </button>
      </div>`;
    }).join("");
    const tab = el.tabbar.querySelector(".tab.active");
    if (tab) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderToolbar() {
    const f = active();
    el.toolbar.hidden = !f;
    el.formulaBar.hidden = !f;
    if (!f) {
      hideAutocomplete();
      el.exportMenu.hidden = true;
      el.freezeMenu.hidden = true;
    }
    $("btn-save").disabled = !f;
    $("btn-save-as").disabled = !f;
    $("btn-export").disabled = !f;
    $("btn-insert-row").disabled = !f;
    $("btn-fill-formula").disabled = !f;
    $("btn-undo").disabled = !f || !f.undo.length;
    $("btn-redo").disabled = !f || !f.redo.length;
    const freezeBtn = $("btn-freeze");
    freezeBtn.disabled = !f;
    const frozen = !!(f && (f.freezeFirst || f.freezeCol));
    const freezeMode = !f ? "none" : f.freezeFirst && f.freezeCol ? "both" : f.freezeFirst ? "row" : f.freezeCol ? "col" : "none";
    const freezeText = { none: "冻结窗格", row: "冻结首行", col: "冻结首列", both: "冻结首行和首列" };
    el.freezeLabel.textContent = freezeText[freezeMode];
    freezeBtn.classList.toggle("active", frozen);
    freezeBtn.setAttribute("aria-pressed", frozen ? "true" : "false");
    el.freezeMenu.querySelectorAll("button[data-freeze]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.freeze === freezeMode);
    });
    const template = state.settings.template;
    $("btn-template").classList.toggle("active", !!(template && template.path && template.exists));
    $("btn-clear-filter").hidden = !(f && hasActiveFilters(f));
    $("btn-save-all").disabled = !state.files.some((x) => x.dirty);
    el.searchInput.disabled = !f;
    el.searchScope.disabled = !f;
    $("btn-prev").disabled = !f || !f.search.list.length;
    $("btn-next").disabled = !f || !f.search.list.length;
  }

  function renderSearchScope() {
    const f = active();
    if (!f) {
      el.searchScope.innerHTML = "";
      return;
    }
    if (f.search.scope >= f.header.length) f.search.scope = -1;
    const sig = f.header.join("\u0001");
    if (el.searchScope.dataset.sig !== sig || el.searchScope.dataset.file !== f.id) {
      const options = ['<option value="-1">全部列</option>'];
      f.header.forEach((name, i) => {
        options.push(`<option value="${i}">${esc(name || "第 " + (i + 1) + " 列")}</option>`);
      });
      el.searchScope.innerHTML = options.join("");
      el.searchScope.dataset.sig = sig;
      el.searchScope.dataset.file = f.id;
    }
    el.searchScope.value = String(f.search.scope);
  }

  function syncSearchInput() {
    const f = active();
    const value = f ? f.search.q : "";
    if (el.searchInput.value !== value) el.searchInput.value = value;
    el.searchFilter.checked = f ? f.search.filter : false;
  }

  function updateSearchCount() {
    const f = active();
    const total = f ? f.search.list.length : 0;
    const idx = f ? f.search.index : -1;
    el.searchCount.textContent = total ? `${idx + 1} / ${total}` : "0 / 0";
    $("btn-prev").disabled = !total;
    $("btn-next").disabled = !total;
  }

  function updateUndoButtons() {
    const f = active();
    $("btn-undo").disabled = !f || !f.undo.length;
    $("btn-redo").disabled = !f || !f.redo.length;
  }

  function renderBatchBar() {
    const f = active();
    const count = f ? f.sel.size : 0;
    el.batchbar.hidden = !f || count === 0;
    if (count) $("sel-count").textContent = count;
    if (!count) closeMoreMenu();
  }

  function renderStatus() {
    const f = active();
    if (!f) {
      el.statusPath.textContent = "就绪";
      el.statusPath.title = "";
      el.statusMeta.textContent = "";
      el.statusExtra.textContent = "";
      return;
    }
    el.statusPath.textContent = f.path || (f.isTemplate ? "模板副本（尚未保存）" : "尚未保存（保存时选择位置）");
    el.statusPath.title = f.path ? "点击复制文件路径" : (f.sourcePath ? "模板源文件：" + f.sourcePath : "");
    el.statusMeta.textContent = `${f.header.length} 列 · ${f.rows.length} 行 · ${f.kind === "xlsx" ? "Excel 工作簿" : "网页表格"} · ${f.encoding}`;
    const parts = [`已选 ${f.sel.size}`];
    if (hasActiveFilters(f)) {
      const shown = visibleRows(f).length;
      parts.push(`筛选后 ${shown} 行`);
    }
    if (f.search.q) parts.push(`匹配 ${f.search.list.length}`);
    if (f.dirty) parts.push("已修改");
    el.statusExtra.textContent = parts.join(" · ");
  }

  function syncDirty() {
    const any = state.files.some((f) => f.dirty) || hasPendingEdit();
    if (any !== state.lastDirty) {
      state.lastDirty = any;
      api("/api/dirty", { dirty: any }).catch(() => {});
    }
  }

  function markChanged(f) {
    f.dirty = true;
    invalidateCalculations(f);
    renderTabs();
    renderStatus();
    renderToolbar();
    syncDirty();
  }

  /* 表格渲染 */
  function hasActiveFilters(f) {
    return !!(f && f.filters && Object.keys(f.filters).length);
  }

  function rowMatchesFilters(f, r) {
    for (const key of Object.keys(f.filters)) {
      const col = Number(key);
      const allowed = f.filters[key];
      if (!allowed || col < 0 || col >= f.header.length) continue;
      if (!allowed.has(cellText(f, r, col))) return false;
    }
    return true;
  }

  function isFilteredView(f) {
    return !!(f.search.filter && f.search.q) || hasActiveFilters(f);
  }

  function visibleRows(f) {
    if (!f._vis || f._visDirty) {
      let rows;
      if (f.search.filter && f.search.q) {
        const set = new Set(f.search.list.map((m) => m.r));
        rows = Array.from(set).sort((a, b) => a - b);
      } else {
        rows = Array.from({ length: f.rows.length }, (_, i) => i);
      }
      if (hasActiveFilters(f)) rows = rows.filter((r) => rowMatchesFilters(f, r));
      f._vis = rows;
      f._visDirty = false;
    }
    return f._vis;
  }

  function pruneSelection(f) {
    if (!isFilteredView(f)) return;
    const vis = new Set(visibleRows(f));
    for (const r of f.sel) if (!vis.has(r)) f.sel.delete(r);
    if (f.anchor != null && !vis.has(f.anchor)) f.anchor = vis.size ? visibleRows(f)[0] : null;
    if (f.activeCell && !vis.has(f.activeCell.r)) {
      f.activeCell = vis.size ? { r: visibleRows(f)[0], c: f.activeCell.c } : null;
    }
  }

  function renderGrid() {
    const f = active();
    if (!f) return;
    ensureWidths(f);
    renderHeader(f);
    renderBody();
    el.gridWrap.scrollTop = f.scrollTop;
    renderBody();
    updateSearchCount();
  }

  function renderHeader(f) {
    const widths = f.widths;
    const numW = clamp(Math.round(Number(f.numW) || 52), 40, 220);
    const cbW = clamp(Math.round(Number(f.cbW) || 38), 30, 160);
    f.numW = numW;
    f.cbW = cbW;
    f.freezeLeft = numW + cbW;
    el.colgroup.innerHTML = `<col style="width:${numW}px"><col style="width:${cbW}px">` +
      widths.map((w) => `<col style="width:${w}px">`).join("");
    el.grid.style.setProperty("--num-w", numW + "px");
    el.grid.style.setProperty("--cb-w", cbW + "px");
    el.grid.style.setProperty("--freeze-left", f.freezeLeft + "px");
    const total = numW + cbW + widths.reduce((a, b) => a + b, 0);
    el.grid.style.width = Math.max(total, el.gridWrap.clientWidth - 2) + "px";
    el.thead.innerHTML = `<tr>
      <th class="rownum" title="第 1 行是表头，数据行与公式行号一致"><div class="th-inner"><span class="th-name">1</span><span class="col-resize" data-col="num" title="拖动调整行号列宽，双击恢复默认"></span></div></th>
      <th class="cbcol"><div class="th-inner"><input type="checkbox" id="check-all" aria-label="全选当前显示的行"><span class="col-resize" data-col="cb" title="拖动调整多选列宽，双击恢复默认"></span></div></th>
      ${f.header.map((name, i) => `<th data-col="${i}"${f.freezeCol && i === 0 ? ' class="frozen-col"' : ""} title="右键管理此列"><div class="th-inner"><span class="th-name">${esc(name || "未命名列")}</span><button type="button" class="th-filter${f.filters[i] ? " active" : ""}" data-filter="${i}" title="筛选“${escAttr(name || "未命名列")}”" aria-label="筛选此列"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 6h16l-6.2 7.2V19l-3.6-1.9v-3.9z"></path></svg></button><span class="col-resize" data-col="${i}"></span></div></th>`).join("")}
    </tr>`;
    el.checkAll = $("check-all");
    updateHeaderCheckbox();
  }

  function updateHeaderCheckbox() {
    const box = el.thead.querySelector("#check-all");
    if (!box) return;
    const f = active();
    if (!f) return;
    const vis = visibleRows(f);
    let selected = 0;
    for (const r of vis) if (f.sel.has(r)) selected++;
    box.checked = vis.length > 0 && selected === vis.length;
    box.indeterminate = selected > 0 && selected < vis.length;
    box.disabled = vis.length === 0;
  }

  function renderBody() {
    const f = active();
    if (!f) return;
    pruneSelection(f);
    const vis = visibleRows(f);
    const cols = f.header.length;
    const wrap = el.gridWrap;
    const viewTop = wrap.scrollTop;
    const viewHeight = wrap.clientHeight || 600;
    const start = Math.max(0, Math.floor(viewTop / ROW_H) - 6);
    const end = Math.min(vis.length, Math.ceil((viewTop + viewHeight) / ROW_H) + 6);
    const parts = [];
    const activeRange = f.search.activeRange;
    const freeze = !!(f.freezeFirst && vis.length);
    if (freeze) parts.push(rowHTML(f, vis[0], activeRange, "frozen-row"));
    if (!vis.length) {
      const text = f.rows.length ? "没有符合筛选条件的行" : "暂无数据，可点击工具栏“插入行”添加一行";
      parts.push(`<tr class="hint-row"><td colspan="${cols + 2}">${text}</td></tr>`);
    } else {
      let first = start;
      if (freeze && first === 0) first = 1;
      const spacerRows = freeze && start > 0 ? start - 1 : start;
      if (spacerRows > 0) {
        parts.push(`<tr class="spacer" aria-hidden="true"><td colspan="${cols + 2}" style="height:${spacerRows * ROW_H}px"></td></tr>`);
      }
      for (let i = first; i < end; i++) {
        parts.push(rowHTML(f, vis[i], activeRange));
      }
      if (end < vis.length) {
        parts.push(`<tr class="spacer" aria-hidden="true"><td colspan="${cols + 2}" style="height:${(vis.length - end) * ROW_H}px"></td></tr>`);
      }
    }
    el.tbody.innerHTML = parts.join("");
    updateHeaderCheckbox();
    updateRefHighlight();
  }

  function rowHTML(f, r, activeRange, extraClass) {
    const row = f.rows[r] || [];
    const selected = f.sel.has(r);
    let cells = "";
    for (let c = 0; c < f.header.length; c++) {
      const raw = cellRaw(f, r, c);
      const view = formulaResult(f, r, c);
      const isActive = f.activeCell && f.activeCell.r === r && f.activeCell.c === c;
      const isForm = isFormula(raw);
      let inner;
      const ranges = f.search.byCell.get(r + ":" + c);
      if (ranges && ranges.length) {
        inner = markRanges(view.text, ranges, activeRange, r, c);
      } else {
        inner = esc(view.text);
      }
      const cls = "cell" + (isActive ? " active-cell" : "") + (view.error ? " cell-error" : "") +
        (isForm ? " formula-cell" : "") + (f.freezeCol && c === 0 ? " frozen-col" : "");
      cells += `<td class="${cls}" data-r="${r}" data-c="${c}" title="${escAttr(raw)}">${inner}</td>`;
    }
    const rowCls = [selected ? "selected" : "", extraClass || ""].filter(Boolean).join(" ");
    return `<tr data-r="${r}"${rowCls ? ` class="${rowCls}"` : ""}>
      <td class="rownum" title="第 ${r + 2} 行">${r + 2}</td>
      <td class="cbcol"><input type="checkbox" ${selected ? "checked" : ""} aria-label="选择第 ${r + 2} 行"></td>
      ${cells}
    </tr>`;
  }

  function markRanges(raw, ranges, activeRange, r, c) {
    let out = "";
    let pos = 0;
    for (const m of ranges) {
      if (m.start < pos) continue;
      out += esc(raw.slice(pos, m.start));
      const key = r + ":" + c + ":" + m.start;
      out += `<mark${key === activeRange ? ' class="current"' : ""}>${esc(raw.slice(m.start, m.start + m.len))}</mark>`;
      pos = m.start + m.len;
    }
    out += esc(raw.slice(pos));
    return out;
  }

  function paintSelection() {
    const f = active();
    if (!f) return;
    const rows = el.tbody.querySelectorAll("tr[data-r]");
    for (const tr of rows) {
      const r = Number(tr.dataset.r);
      const selected = f.sel.has(r);
      tr.classList.toggle("selected", selected);
      const cb = tr.querySelector("input[type=checkbox]");
      if (cb) cb.checked = selected;
      for (const td of tr.querySelectorAll("td.cell")) {
        const c = Number(td.dataset.c);
        td.classList.toggle("active-cell",
          !!f.activeCell && f.activeCell.r === r && f.activeCell.c === c);
      }
    }
    updateHeaderCheckbox();
    renderFormulaBar();
    updateRefHighlight();
  }

  function scrollRowIntoView(f, r) {
    const vis = visibleRows(f);
    const pos = vis.indexOf(r);
    if (pos < 0) return;
    const wrap = el.gridWrap;
    const headH = 38;
    const top = headH + pos * ROW_H;
    const viewTop = wrap.scrollTop + headH;
    const viewBottom = wrap.scrollTop + wrap.clientHeight;
    if (top < viewTop) {
      wrap.scrollTop = Math.max(0, top - headH - 10);
    } else if (top + ROW_H > viewBottom) {
      wrap.scrollTop = top + ROW_H - wrap.clientHeight + 16;
    }
  }

  /* 搜索 */
  function recomputeSearch(f, keepIndex) {
    const q = f.search.q;
    f.search.list = [];
    f.search.byCell = new Map();
    f.search.activeRange = null;
    if (q) {
      const needle = q.toLowerCase();
      const cols = f.search.scope >= 0 && f.search.scope < f.header.length
        ? [f.search.scope]
        : f.header.map((_, i) => i);
      for (let r = 0; r < f.rows.length; r++) {
        for (const c of cols) {
          const text = cellText(f, r, c);
          if (!text) continue;
          const lower = text.toLowerCase();
          let pos = 0;
          while (true) {
            const idx = lower.indexOf(needle, pos);
            if (idx < 0) break;
            const item = { r, c, start: idx, len: needle.length };
            f.search.list.push(item);
            const key = r + ":" + c;
            let arr = f.search.byCell.get(key);
            if (!arr) {
              arr = [];
              f.search.byCell.set(key, arr);
            }
            arr.push(item);
            pos = idx + Math.max(1, needle.length);
          }
        }
      }
    }
    if (!keepIndex) f.search.index = f.search.list.length ? 0 : -1;
    else if (f.search.index >= f.search.list.length) f.search.index = f.search.list.length ? f.search.list.length - 1 : -1;
    syncActiveRange(f);
    f._visDirty = true;
  }

  function syncActiveRange(f) {
    const m = f.search.list[f.search.index];
    f.search.activeRange = m ? m.r + ":" + m.c + ":" + m.start : null;
  }

  function runSearchFromInput() {
    const f = active();
    if (!f) return;
    f.search.q = el.searchInput.value;
    recomputeSearch(f, false);
    f.activeCell = null;
    el.gridWrap.scrollTop = 0;
    if (f.search.index >= 0) {
      const m = f.search.list[0];
      f.activeCell = { r: m.r, c: m.c };
      scrollRowIntoView(f, m.r);
    }
    renderBody();
    updateSearchCount();
    renderStatus();
  }

  function gotoMatch(delta) {
    const f = active();
    if (!f || !f.search.list.length) return;
    const total = f.search.list.length;
    f.search.index = (f.search.index + delta + total) % total;
    syncActiveRange(f);
    const m = f.search.list[f.search.index];
    f.activeCell = { r: m.r, c: m.c };
    scrollRowIntoView(f, m.r);
    renderBody();
    updateSearchCount();
  }

  function setFilter(on) {
    const f = active();
    if (!f) return;
    f.search.filter = on;
    f._visDirty = true;
    el.gridWrap.scrollTop = 0;
    renderBody();
    renderStatus();
  }

  /* 按列筛选 */
  let filterPop = null;
  let filterPopCol = -1;
  let filterPopDocDown = null;
  let filterPopEsc = null;

  function closeFilterPop() {
    if (!filterPop) return;
    filterPop.remove();
    filterPop = null;
    filterPopCol = -1;
    if (filterPopDocDown) document.removeEventListener("mousedown", filterPopDocDown, true);
    if (filterPopEsc) document.removeEventListener("keydown", filterPopEsc, true);
    filterPopDocDown = null;
    filterPopEsc = null;
  }

  function filterValuesOf(f, col) {
    const counts = new Map();
    for (let r = 0; r < f.rows.length; r++) {
      const text = cellText(f, r, col);
      counts.set(text, (counts.get(text) || 0) + 1);
    }
    const values = Array.from(counts.keys());
    values.sort((a, b) => {
      const na = a.trim() === "" ? null : Number(a);
      const nb = b.trim() === "" ? null : Number(b);
      const va = na != null && isFinite(na);
      const vb = nb != null && isFinite(nb);
      if (va && vb) return na - nb;
      if (va) return -1;
      if (vb) return 1;
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    return { values, counts };
  }

  function refreshFilterView(f) {
    f._visDirty = true;
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderStatus();
    renderToolbar();
  }

  function openFilterPop(col, anchor) {
    closeFilterPop();
    hideRefHighlights();
    const f = active();
    if (!f || col < 0 || col >= f.header.length) return;
    const info = filterValuesOf(f, col);
    const values = info.values;
    const allSet = new Set(values);
    let selected = f.filters[col] ? new Set(f.filters[col]) : new Set(allSet);

    filterPop = document.createElement("div");
    filterPop.className = "filter-pop";
    filterPop.setAttribute("role", "dialog");
    filterPop.innerHTML = `<div class="filter-pop-head">筛选：<b>${esc(f.header[col] || "未命名列")}</b></div>
      <input type="text" class="filter-search" placeholder="搜索列中的值" autocomplete="off" spellcheck="false">
      <label class="filter-all"><input type="checkbox" class="filter-all-box"> 全选</label>
      <div class="filter-values"></div>
      <div class="filter-pop-foot">
        <button type="button" class="btn small ghost" data-act="clear">清除该列</button>
        <span class="grow"></span>
        <button type="button" class="btn small" data-act="cancel">取消</button>
        <button type="button" class="btn small primary" data-act="ok">确定</button>
      </div>`;
    document.body.appendChild(filterPop);
    filterPopCol = col;

    const search = filterPop.querySelector(".filter-search");
    const allBox = filterPop.querySelector(".filter-all-box");
    const list = filterPop.querySelector(".filter-values");
    const MAX_SHOW = 1000;
    let keyword = "";

    function shownValues() {
      if (!keyword) return values.slice(0, MAX_SHOW);
      const needle = keyword.toLowerCase();
      return values.filter((v) => (v || "（空白）").toLowerCase().includes(needle)).slice(0, MAX_SHOW);
    }

    function renderList() {
      const shown = shownValues();
      if (!shown.length) {
        list.innerHTML = '<div class="filter-empty">没有匹配的值</div>';
      } else {
        list.innerHTML = shown.map((v) => {
          const idx = values.indexOf(v);
          const label = v === "" ? "（空白）" : v;
          const count = info.counts.get(v) || 0;
          return `<label class="filter-value"><input type="checkbox" data-idx="${idx}"${selected.has(v) ? " checked" : ""}><span class="filter-label" title="${escAttr(label)}">${esc(label)}</span><span class="filter-count">${count}</span></label>`;
        }).join("") + (values.length > MAX_SHOW && !keyword ? `<div class="filter-more">仅显示前 ${MAX_SHOW} 个值，可用上方搜索缩小范围</div>` : "");
      }
      const scopeValues = keyword ? shownValues() : values;
      const allShown = scopeValues.length > 0 && scopeValues.every((v) => selected.has(v));
      allBox.checked = allShown;
      allBox.indeterminate = !allShown && scopeValues.some((v) => selected.has(v));
    }

    list.addEventListener("change", (ev) => {
      const box = ev.target.closest("input[data-idx]");
      if (!box) return;
      const v = values[Number(box.dataset.idx)];
      if (box.checked) selected.add(v);
      else selected.delete(v);
      renderList();
    });
    allBox.addEventListener("change", () => {
      const scopeValues = keyword ? shownValues() : values;
      if (allBox.checked) scopeValues.forEach((v) => selected.add(v));
      else scopeValues.forEach((v) => selected.delete(v));
      renderList();
    });
    search.addEventListener("input", () => {
      keyword = search.value.trim();
      renderList();
    });

    filterPop.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "cancel") {
        closeFilterPop();
        return;
      }
      if (act === "clear") {
        delete f.filters[col];
        closeFilterPop();
        refreshFilterView(f);
        return;
      }
      if (act === "ok") {
        if (!selected.size) {
          toast("请至少保留一个值", "error");
          return;
        }
        if (selected.size >= values.length) delete f.filters[col];
        else f.filters[col] = new Set(selected);
        closeFilterPop();
        refreshFilterView(f);
      }
    });

    const rect = anchor.getBoundingClientRect();
    const width = 292;
    const height = 380;
    let left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    filterPop.style.left = left + "px";
    filterPop.style.top = top + "px";

    filterPopDocDown = (ev) => {
      if (!filterPop) return;
      if (filterPop.contains(ev.target)) return;
      if (ev.target.closest && ev.target.closest(".th-filter")) return;
      closeFilterPop();
    };
    filterPopEsc = (ev) => {
      if (ev.key === "Escape") closeFilterPop();
    };
    document.addEventListener("mousedown", filterPopDocDown, true);
    document.addEventListener("keydown", filterPopEsc, true);

    renderList();
    search.focus();
  }

  function clearAllFilters() {
    const f = active();
    if (!f || !hasActiveFilters(f)) return;
    f.filters = {};
    refreshFilterView(f);
    toast("已清除全部筛选");
  }

  function setFreezeMode(mode) {
    const f = active();
    if (!f) return;
    f.freezeFirst = mode === "row" || mode === "both";
    f.freezeCol = mode === "col" || mode === "both";
    el.freezeMenu.hidden = true;
    renderHeader(f);
    renderBody();
    renderToolbar();
    const text = { none: "已取消冻结", row: "已冻结首行", col: "已冻结首列", both: "已冻结首行和首列" };
    toast(text[mode] || text.none);
  }

  /* 编辑 */
  /* 编辑会话统一由 state.editing 管理：
     - cellInput 挂在单元格里的输入框（可能因虚拟滚动被销毁，此时仅公式栏可编辑）
     - input 指向当前持有焦点的编辑器（单元格输入框或公式栏输入框）
     - viaBar 为 true 表示焦点在公式栏，两端内容实时互相同步 */
  function cellRefName(r, c) {
    return SheetFormula.colLetter(c) + (r + 2);
  }

  function mountCellEditor(r, c, value, focus) {
    const td = el.tbody.querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`);
    if (!td) return null;
    const input = document.createElement("input");
    input.className = "cell-input";
    input.value = value;
    td.innerHTML = "";
    td.classList.add("editing");
    td.appendChild(input);
    input.addEventListener("input", () => {
      syncEditValue(input.value, false);
      updateAutocomplete();
      updateRefHighlight();
      updateQuickCalcPreview();
    });
    input.addEventListener("keydown", onEditorKeydown);
    input.addEventListener("keyup", updateAutocomplete);
    input.addEventListener("click", updateAutocomplete);
    input.addEventListener("blur", onEditorBlur);
    if (focus) input.focus();
    return input;
  }

  function startEdit(r, c, initial) {
    if (state.busy) return;
    const f = active();
    if (!f || f.search.filter) {
      toast("筛选状态下不能编辑，请先取消“仅显示匹配行”", "error");
      return;
    }
    let td = el.tbody.querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`);
    if (!td) {
      f.activeCell = { r, c };
      scrollRowIntoView(f, r);
      renderBody();
      paintSelection();
      return;
    }
    if (state.editing) commitEdit();
    const raw = f.rows[r][c] == null ? "" : f.rows[r][c];
    const value = initial != null ? String(initial) : raw;
    f.activeCell = { r, c };
    const input = mountCellEditor(r, c, value, true);
    if (!input) return;
    if (initial == null) input.select();
    else input.setSelectionRange(value.length, value.length);
    state.editing = { fileId: f.id, r, c, cellInput: input, input, viaBar: false };
    renderFormulaBar();
    updateAutocomplete();
    updateRefHighlight();
  }

  function beginBarEdit(r, c, syncValue) {
    const f = active();
    if (!f || state.busy) return;
    if (f.search.filter) {
      toast("筛选状态下不能编辑，请先取消“仅显示匹配行”", "error");
      el.formulaInput.blur();
      return;
    }
    if (state.editing) return;
    const raw = f.rows[r][c] == null ? "" : f.rows[r][c];
    const cellInput = mountCellEditor(r, c, raw, false);
    state.editing = { fileId: f.id, r, c, cellInput, input: el.formulaInput, viaBar: true };
    if (syncValue && el.formulaInput.value !== raw) el.formulaInput.value = raw;
    renderFormulaBar();
    updateAutocomplete();
    updateRefHighlight();
  }

  function syncFocusState() {
    /* CEF 下脚本调用 focus() 偶发不派发 focus 事件，
       在编辑相关入口按真实焦点校正编辑会话的方向，避免 viaBar 状态漂移 */
    const ed = state.editing;
    if (!ed) return;
    const ae = document.activeElement;
    if (ae === el.formulaInput) {
      if (!ed.viaBar) {
        ed.viaBar = true;
        ed.input = el.formulaInput;
      }
    } else if (ed.cellInput && ae === ed.cellInput) {
      if (ed.viaBar) {
        ed.viaBar = false;
        ed.input = ed.cellInput;
      }
    }
  }

  function syncEditValue(value, fromBar) {
    syncFocusState();
    const ed = state.editing;
    if (!ed) return;
    if (fromBar) {
      if (ed.cellInput && document.activeElement !== ed.cellInput && ed.cellInput.value !== value) {
        ed.cellInput.value = value;
      }
    } else if (document.activeElement !== el.formulaInput && el.formulaInput.value !== value) {
      el.formulaInput.value = value;
    }
    syncDirty();
  }

  function hasPendingEdit() {
    const ed = state.editing;
    if (!ed || !ed.input) return false;
    const f = state.files.find((item) => item.id === ed.fileId);
    if (!f || !f.rows[ed.r] || ed.c >= f.header.length) return false;
    const old = f.rows[ed.r][ed.c] == null ? "" : f.rows[ed.r][ed.c];
    const quick = SheetFormula.quickEvaluate(ed.input.value);
    return (quick.ok ? quick.text : ed.input.value) !== old;
  }

  function updateQuickCalcPreview() {
    const ed = state.editing;
    if (!ed || !ed.input) {
      calcPreview.hidden = true;
      return;
    }
    const result = SheetFormula.quickEvaluate(ed.input.value);
    if (!result.ok) {
      calcPreview.hidden = true;
      return;
    }
    const rect = ed.input.getBoundingClientRect();
    calcPreview.textContent = "计算结果：" + result.text + "（回车确认）";
    calcPreview.hidden = false;
    const box = calcPreview.getBoundingClientRect();
    let top = rect.bottom + 5;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 5);
    calcPreview.style.left = clamp(rect.left, 8, Math.max(8, window.innerWidth - box.width - 8)) + "px";
    calcPreview.style.top = top + "px";
  }

  function hideQuickCalcPreview() {
    calcPreview.hidden = true;
  }

  function onEditorKeydown(ev) {
    syncFocusState();
    const ed = state.editing;
    if (!ed) return;
    const acVisible = !acMenu.hidden;
    if (acVisible && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      ev.stopPropagation();
      moveAcSelection(ev.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (acVisible && ev.key === "Tab") {
      ev.preventDefault();
      ev.stopPropagation();
      acceptAcSelection();
      return;
    }
    if (ev.key === "Escape") {
      /* WPS 习惯：Esc 直接取消整个编辑（顺带关闭补全菜单） */
      ev.preventDefault();
      ev.stopPropagation();
      cancelEdit();
    } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      /* Ctrl+Enter：直接提交，光标留在当前单元格 */
      ev.preventDefault();
      ev.stopPropagation();
      const changed = commitEdit();
      if (changed) toast("已提交（Ctrl+Enter）");
      focusGrid();
    } else if (ev.key === "Enter") {
      /* Enter 直接确认输入（WPS 习惯）；候选只用 Tab 或点击采纳 */
      ev.preventDefault();
      ev.stopPropagation();
      const changed = commitEdit();
      moveActive(1, 0, changed);
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      ev.stopPropagation();
      const changed = commitEdit();
      moveActive(0, ev.shiftKey ? -1 : 1, changed);
    }
  }

  function onEditorBlur(ev) {
    const ed = state.editing;
    if (!ed) return;
    const source = ev.target === el.formulaInput ? "bar" : "cell";
    const other = source === "bar" ? ed.cellInput : el.formulaInput;
    if (ev.relatedTarget === other && other) {
      /* 焦点在单元格编辑框与公式栏之间转移时保持同一编辑会话 */
      if (source === "bar") {
        ed.viaBar = false;
        ed.input = ed.cellInput;
        ed.cellInput.focus();
        ed.cellInput.setSelectionRange(ed.cellInput.value.length, ed.cellInput.value.length);
      } else {
        ed.viaBar = true;
        ed.input = el.formulaInput;
        el.formulaInput.focus();
      }
      updateAutocomplete();
      return;
    }
    if (ev.relatedTarget && acMenu.contains(ev.relatedTarget)) return;
    if (ev.relatedTarget && refPop.contains(ev.relatedTarget)) return;
    commitEdit();
  }

  function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    syncDirty();
    hideAutocomplete();
    hideQuickCalcPreview();
    hideRefHighlights();
    renderBody();
    if (document.activeElement === el.formulaInput) el.formulaInput.blur();
    renderFormulaBar();
    focusGrid();
  }

  function commitEdit() {
    const ed = state.editing;
    if (!ed) return false;
    let value = ed.input.value;
    const quick = SheetFormula.quickEvaluate(value);
    if (quick.ok) value = quick.text;
    state.editing = null;
    hideAutocomplete();
    hideQuickCalcPreview();
    hideRefHighlights();
    const f = state.files.find((item) => item.id === ed.fileId);
    if (!f) {
      renderFormulaBar();
      syncDirty();
      return false;
    }
    if (!f.rows[ed.r] || ed.c >= f.header.length) {
      renderFormulaBar();
      syncDirty();
      return false;
    }
    const old = f.rows[ed.r][ed.c] == null ? "" : f.rows[ed.r][ed.c];
    if (value === old) {
      renderBody();
      renderFormulaBar();
      syncDirty();
      return false;
    }
    pushUndo(f);
    f.rows[ed.r][ed.c] = value;
    markChanged(f);
    recomputeSearch(f, true);
    renderBody();
    renderFormulaBar();
    updateSearchCount();
    return true;
  }

  /* 公式栏 */
  function renderFormulaBar() {
    const f = active();
    el.formulaBar.hidden = !f;
    if (!f) {
      if (document.activeElement === el.formulaInput || document.activeElement === el.nameBox) {
        document.activeElement.blur();
      }
      hideAutocomplete();
      return;
    }
    const ed = state.editing;
    if (ed) {
      el.nameBox.value = cellRefName(ed.r, ed.c);
      if (el.formulaInput.value !== ed.input.value) el.formulaInput.value = ed.input.value;
      return;
    }
    const ac = f.activeCell;
    if (!ac) {
      el.nameBox.value = "";
      if (document.activeElement !== el.formulaInput && el.formulaInput.value) el.formulaInput.value = "";
      return;
    }
    el.nameBox.value = cellRefName(ac.r, ac.c);
    if (document.activeElement !== el.formulaInput && el.formulaInput.value !== cellRaw(f, ac.r, ac.c)) {
      el.formulaInput.value = cellRaw(f, ac.r, ac.c);
    }
  }

  function jumpToRef(text) {
    const f = active();
    if (!f) return;
    const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(String(text || "").trim());
    if (!m) {
      toast("请输入有效引用，如 B3", "error");
      renderFormulaBar();
      return;
    }
    const col = SheetFormula.colIndex(m[1]);
    const excelRow = parseInt(m[2], 10);
    if (col < 0 || col >= f.header.length || excelRow < 2 || excelRow - 2 >= f.rows.length) {
      toast("引用超出表格范围", "error");
      renderFormulaBar();
      return;
    }
    const r = excelRow - 2;
    f.activeCell = { r, c: col };
    f.sel.clear();
    f.sel.add(r);
    f.anchor = r;
    scrollRowIntoView(f, r);
    renderBody();
    paintSelection();
    renderBatchBar();
    renderStatus();
    focusGrid();
  }

  /* 公式自动补全（VS Code 风格：输入 = 公式时提示函数与单元格引用） */
  let acLastToken = null;

  function sigOf(name) {
    const sigs = SheetFormula.signatures || {};
    return sigs[name] || (name + "(…)");
  }

  function formulaTokenAt(text, caret) {
    if (!/^\s*=/.test(text)) return null;
    const before = text.slice(0, caret);
    const m = /[A-Za-z_$][A-Za-z0-9_$.]*$/.exec(before);
    return m ? m[0] : "";
  }

  function updateAutocomplete() {
    syncFocusState();
    const ed = state.editing;
    if (!ed) {
      hideAutocomplete();
      return;
    }
    const input = ed.input;
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    const token = formulaTokenAt(input.value, caret);
    if (token === null) {
      hideAutocomplete();
      return;
    }
    const items = [];
    const upper = token.toUpperCase();
    if (upper) {
      /* 常用函数排在前面，其次按字母序补全其余 */
      const commonHit = COMMON_FUNCS.filter((name) => name.startsWith(upper));
      const restHit = SheetFormula.functions.filter((name) =>
        name.startsWith(upper) && !commonHit.includes(name));
      for (const name of commonHit.concat(restHit)) {
        items.push({ label: name, desc: sigOf(name), insert: name + "()", kind: "fn" });
        if (items.length >= 18) break;
      }
      const refM = /^\$?([A-Za-z]{1,2})\$?(\d{0,7})$/.exec(token);
      if (refM) {
        const f = active();
        const col = SheetFormula.colIndex(refM[1]);
        if (f && col >= 0 && col < f.header.length) {
          const digitPart = refM[2];
          const totalExcelRow = f.rows.length + 1;
          let count = 0;
          for (let row = 1; row <= totalExcelRow && count < 14; row++) {
            if (digitPart && !String(row).startsWith(digitPart)) continue;
            items.push({
              label: SheetFormula.colLetter(col) + row,
              desc: "单元格引用",
              insert: SheetFormula.colLetter(col) + row,
              kind: "ref",
            });
            count++;
          }
        }
      }
    } else {
      for (const name of COMMON_FUNCS) {
        items.push({ label: name, desc: sigOf(name), insert: name + "()", kind: "fn" });
      }
    }
    if (!items.length) {
      hideAutocomplete();
      return;
    }
    /* token 未变化且菜单已开时保留当前选中（避免 keyup/方向键导致选中项被重置） */
    if (!acMenu.hidden && acOwner === input && token === acLastToken && acIndex < items.length) return;
    acLastToken = token;
    acItems = items;
    acIndex = 0;
    acOwner = input;
    renderAcMenu(input);
  }

  function renderAcMenu(input) {
    acMenu.innerHTML = acItems.map((item, i) =>
      `<div class="ac-item${i === acIndex ? " active" : ""}" data-idx="${i}">
        <span class="ac-icon ${item.kind}">${item.kind === "fn" ? "fx" : "⌗"}</span>
        <span class="ac-label">${esc(item.label)}</span>
        <span class="ac-desc">${esc(item.desc || "")}</span>
      </div>`).join("") +
      `<div class="ac-foot">${esc(acItems[acIndex].desc || "")}</div>`;
    const rect = input.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    let left = clamp(rect.left, 8, window.innerWidth - width - 8);
    let top = rect.bottom + 4;
    const height = acMenu.offsetHeight || 200;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    acMenu.style.left = left + "px";
    acMenu.style.top = top + "px";
    acMenu.hidden = false;
  }

  function moveAcSelection(delta) {
    if (!acItems.length) return;
    acIndex = (acIndex + delta + acItems.length) % acItems.length;
    const activeItem = acMenu.querySelector(".ac-item.active");
    if (activeItem) activeItem.scrollIntoView({ block: "nearest" });
    const foot = acMenu.querySelector(".ac-foot");
    if (foot) foot.textContent = acItems[acIndex].desc || "";
    acMenu.querySelectorAll(".ac-item").forEach((node) => {
      node.classList.toggle("active", Number(node.dataset.idx) === acIndex);
    });
  }

  function acceptAcSelection() {
    const item = acItems[acIndex];
    const input = acOwner;
    if (!item || !input || input !== (state.editing && state.editing.input)) {
      hideAutocomplete();
      return;
    }
    hideAutocomplete();
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    const before = input.value.slice(0, caret);
    const m = /[A-Za-z_$][A-Za-z0-9_$.]*$/.exec(before);
    const tokenLen = m ? m[0].length : 0;
    const start = caret - tokenLen;
    input.setRangeText(item.insert, start, caret, "end");
    const nextCaret = start + item.insert.length - (item.kind === "fn" ? 1 : 0);
    input.setSelectionRange(nextCaret, nextCaret);
    syncEditValue(input.value, input === el.formulaInput);
    input.focus();
    /* 采纳后不再立即重弹菜单，避免循环追加；继续输入时由 input 事件重新触发 */
  }

  function hideAutocomplete() {
    if (!acMenu.hidden) acMenu.hidden = true;
    acItems = [];
    acIndex = 0;
    acOwner = null;
    acLastToken = null;
  }

  /* 公式引用高亮：选中或编辑 = 公式时标出全部引用，
     编辑时当前引用用强调色，范围引用右下角提供角标切换区域 */
  const REF_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];
  let refSnap = []; /* 最近一次高亮的引用快照（含公式内位置） */

  function hideRefHighlights() {
    refLayer.innerHTML = "";
    refSnap = [];
    hideRefPopup();
  }

  function canShowRefHighlights() {
    if (state.activeModal) return false;
    const target = document.activeElement;
    if (!target || target === document.body || target === el.gridWrap) return true;
    if (target === el.formulaInput || (state.editing && target === state.editing.cellInput)) return true;
    if (refPop.contains(target) || acMenu.contains(target) || refLayer.contains(target)) return true;
    return !isTextInput(target);
  }

  function updateRefHighlight() {
    refLayer.innerHTML = "";
    refSnap = [];
    const ed = state.editing;
    const f = active();
    if (!f || !canShowRefHighlights()) {
      hideRefPopup();
      return;
    }
    if (!ed) hideRefPopup();
    let value;
    let caret = null;
    if (ed) {
      value = ed.input.value;
      caret = ed.input.selectionStart == null ? value.length : ed.input.selectionStart;
    } else {
      if (!f.activeCell) return;
      value = cellRaw(f, f.activeCell.r, f.activeCell.c);
    }
    if (!/^\s*=/.test(value)) return;
    const refs = SheetFormula.parseRefs(value.slice(1)).map((ref) => ({
      ...ref, start: ref.start + 1, end: ref.end + 1,
    }));
    refSnap = refs;
    if (!refs.length) return;
    const wrapRect = el.gridWrap.getBoundingClientRect();
    refs.forEach((ref, idx) => {
      /* 公式空间行 → 数据行（DOM data-r = 行-1） */
      let r1 = ref.r1 - 1;
      let r2 = ref.r2 - 1;
      const c1 = ref.c1;
      const c2 = ref.c2;
      if (r2 < 0) return; /* 只引用表头行，跳过 */
      r1 = Math.max(0, r1);
      r2 = Math.min(r2, f.rows.length - 1);
      if (r1 > r2 || c1 >= f.header.length) return;
      const tdA = el.tbody.querySelector(`td.cell[data-r="${r1}"][data-c="${c1}"]`);
      const tdB = el.tbody.querySelector(`td.cell[data-r="${r2}"][data-c="${c2}"]`);
      if (!tdA || !tdB) return; /* 在虚拟滚动可视区外，跳过 */
      const a = tdA.getBoundingClientRect();
      const b = tdB.getBoundingClientRect();
      const color = REF_COLORS[idx % REF_COLORS.length];
      /* 光标落在引用上或紧邻（如参数末尾后跟右括号）时视为当前引用 */
      const isActive = caret != null && caret >= ref.start - 1 && caret <= ref.end + 1;
      let left = Math.min(a.left, b.left);
      let top = Math.min(a.top, b.top);
      let right = Math.max(a.right, b.right);
      let bottom = Math.max(a.bottom, b.bottom);
      /* 裁剪到表格可视区，避免盖住工具栏/表头 */
      const clipTop = Math.max(wrapRect.top + 38, top);
      const clipBottom = Math.min(wrapRect.bottom, bottom);
      if (clipBottom <= clipTop) return;
      const box = document.createElement("div");
      box.className = "ref-box" + (isActive ? " active" : "");
      box.style.left = left + "px";
      box.style.top = clipTop + "px";
      box.style.width = (right - left) + "px";
      box.style.height = (clipBottom - clipTop) + "px";
      box.style.borderColor = color;
      if (isActive) box.style.background = color + "22";
      if (ref.range || isActive) {
        const tag = document.createElement("div");
        tag.className = "ref-tag";
        tag.style.background = color;
        tag.textContent = ref.text;
        tag.style.top = Math.max(clipTop, top - 16) + "px";
        tag.style.left = left + "px";
        refLayer.appendChild(tag);
      }
      refLayer.appendChild(box);
      if (ref.range && ed) {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "ref-handle";
        handle.title = "点击切换引用区域";
        handle.style.left = (right - 7) + "px";
        handle.style.top = (Math.min(clipBottom, bottom) - 7) + "px";
        handle.style.background = color;
        handle.dataset.idx = idx;
        refLayer.appendChild(handle);
      }
    });
  }

  function hideRefPopup() {
    if (!refPop.hidden) refPop.hidden = true;
    refPopTarget = null;
  }

  function showRefPopup(idx, anchorRect) {
    const ed = state.editing;
    const ref = refSnap[idx];
    if (!ed || !ref) return;
    const value = ed.input.value;
    if (value.slice(ref.start, ref.end) !== ref.text) {
      /* 公式已变化则按文本重新定位 */
      const fresh = SheetFormula.parseRefs(value.slice(1));
      const hit = fresh.find((x) => x.text === ref.text && x.start + 1 === ref.start);
      if (!hit) {
        toast("公式内容已变化，请重新点击角标", "error");
        return;
      }
      refSnap = fresh.map((x) => ({ ...x, start: x.start + 1, end: x.end + 1 }));
      refPopTarget = { start: hit.start + 1, end: hit.end + 1 };
    } else {
      refPopTarget = { start: ref.start, end: ref.end };
    }
    refPop.querySelector(".ref-pop-input").value = ref.text;
    refPop.hidden = false;
    const width = 250;
    let left = clamp(anchorRect.left - 120, 8, window.innerWidth - width - 8);
    let top = anchorRect.bottom + 6;
    const height = refPop.offsetHeight || 110;
    if (top + height > window.innerHeight - 8) top = anchorRect.top - height - 6;
    refPop.style.left = left + "px";
    refPop.style.top = top + "px";
    const input = refPop.querySelector(".ref-pop-input");
    input.focus();
    input.select();
  }

  function applyRefPopup(remove) {
    const ed = state.editing;
    const target = refPopTarget;
    if (!ed || !target) {
      hideRefPopup();
      return;
    }
    const input = ed.input;
    if (remove) {
      input.setRangeText("", target.start, target.end, "end");
    } else {
      const text = refPop.querySelector(".ref-pop-input").value.trim();
      const m = /^\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$/.exec(text);
      if (!m) {
        toast("请输入有效引用，如 C2 或 C2:D5", "error");
        return;
      }
      input.setRangeText(text, target.start, target.end, "end");
    }
    hideRefPopup();
    syncEditValue(input.value, input === el.formulaInput);
    input.focus();
    updateAutocomplete();
    updateRefHighlight();
  }

  function bindRefPopup() {
    refLayer.addEventListener("click", (ev) => {
      const handle = ev.target.closest(".ref-handle");
      if (!handle) return;
      const idx = Number(handle.dataset.idx);
      showRefPopup(idx, handle.getBoundingClientRect());
    });
    refPop.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") {
        ev.preventDefault();
        hideRefPopup();
        const ed = state.editing;
        if (ed) ed.input.focus();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        applyRefPopup(false);
      }
    });
    refPop.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "ok") applyRefPopup(false);
      else if (btn.dataset.act === "remove") applyRefPopup(true);
      else {
        hideRefPopup();
        const ed = state.editing;
        if (ed) ed.input.focus();
      }
    });
  }

  function moveActive(dr, dc, alreadyRendered) {
    const f = active();
    if (!f || !f.rows.length) {
      if (!alreadyRendered) renderBody();
      return;
    }
    let base = f.activeCell || (state.editing ? { r: state.editing.r, c: state.editing.c } : null) || { r: 0, c: 0 };
    let r;
    let c;
    if (isFilteredView(f)) {
      const vis = visibleRows(f);
      const pos = Math.max(0, vis.indexOf(base.r));
      const nextPos = clamp(dr ? pos + dr : pos, 0, vis.length - 1);
      r = vis[nextPos];
      c = clamp(base.c + dc, 0, f.header.length - 1);
    } else {
      r = clamp(base.r + dr, 0, f.rows.length - 1);
      c = clamp(base.c + dc, 0, f.header.length - 1);
    }
    f.activeCell = { r, c };
    if (!f.sel.has(r)) {
      f.sel.clear();
      f.sel.add(r);
      f.anchor = r;
    }
    renderBatchBar();
    renderStatus();
    scrollRowIntoView(f, r);
    paintSelection();
  }

  /* 撤销 */
  function snapshot(f) {
    const filters = {};
    for (const key of Object.keys(f.filters || {})) filters[key] = new Set(f.filters[key]);
    const formulaFill = {};
    for (const key of Object.keys(f.formulaFill || {})) {
      formulaFill[key] = {
        formula: f.formulaFill[key].formula,
        baseRow: f.formulaFill[key].baseRow,
      };
    }
    return { header: f.header.slice(), rows: f.rows.map((row) => row.slice()), filters, formulaFill };
  }

  function pushUndo(f) {
    f.undo.push(snapshot(f));
    if (f.undo.length > MAX_UNDO) f.undo.shift();
    f.redo.length = 0;
    updateUndoButtons();
  }

  function applySnapshot(f, snap) {
    f.header = snap.header.slice();
    f.rows = snap.rows.map((row) => row.slice());
    const filters = {};
    for (const key of Object.keys(snap.filters || {})) filters[key] = new Set(snap.filters[key]);
    f.filters = filters;
    f.formulaFill = {};
    for (const key of Object.keys(snap.formulaFill || {})) {
      f.formulaFill[key] = {
        formula: snap.formulaFill[key].formula,
        baseRow: snap.formulaFill[key].baseRow,
      };
    }
    invalidateCalculations(f);
    ensureWidths(f);
    if (f.search.scope >= f.header.length) f.search.scope = -1;
    if (!f.rows.length) {
      f.activeCell = null;
      f.anchor = null;
    } else {
      if (f.activeCell) {
        f.activeCell.r = clamp(f.activeCell.r, 0, f.rows.length - 1);
        f.activeCell.c = clamp(f.activeCell.c, 0, Math.max(0, f.header.length - 1));
      }
      if (f.anchor != null && f.anchor >= f.rows.length) f.anchor = f.rows.length - 1;
    }
    f.sel.forEach((r) => {
      if (r >= f.rows.length) f.sel.delete(r);
    });
  }

  function afterDataChange(f) {
    invalidateCalculations(f);
    f._visDirty = true;
    recomputeSearch(f, true);
    renderSearchScope();
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderStatus();
    renderTabs();
    renderBatchBar();
    updateUndoButtons();
    renderToolbar();
    syncDirty();
  }

  function undo() {
    const f = active();
    if (!f || !f.undo.length || state.busy) return;
    const snap = f.undo.pop();
    f.redo.push(snapshot(f));
    if (f.redo.length > MAX_UNDO) f.redo.shift();
    applySnapshot(f, snap);
    f.dirty = signature(f) !== f.savedSig;
    afterDataChange(f);
    toast("已撤销");
  }

  function redo() {
    const f = active();
    if (!f || !f.redo.length || state.busy) return;
    const snap = f.redo.pop();
    f.undo.push(snapshot(f));
    if (f.undo.length > MAX_UNDO) f.undo.shift();
    applySnapshot(f, snap);
    f.dirty = signature(f) !== f.savedSig;
    afterDataChange(f);
    toast("已重做");
  }

  /* 标签切换 */
  function activate(id, force) {
    if (state.busy && !force) return;
    if (state.editing) commitEdit();
    const prev = active();
    if (prev) prev.scrollTop = el.gridWrap.scrollTop;
    state.activeId = id;
    renderTabs();
    renderToolbar();
    renderBatchBar();
    renderStatus();
    renderSearchScope();
    syncSearchInput();
    updateSearchCount();
    const f = active();
    if (!f) {
      hideRefHighlights();
      el.empty.hidden = false;
      el.gridWrap.hidden = true;
      el.toolbar.hidden = true;
      renderRecentHome();
      return;
    }
    el.empty.hidden = true;
    el.gridWrap.hidden = false;
    renderGrid();
    paintSelection();
    runSearchIfNeeded(f);
  }

  function runSearchIfNeeded(f) {
    if (f.search.q) {
      recomputeSearch(f, true);
      scrollRowIntoView(f, f.search.list.length ? f.search.list[Math.max(0, f.search.index)].r : 0);
      renderBody();
    }
    updateSearchCount();
  }

  /* 文件打开 */
  async function openViaDialog() {
    if (state.busy) return;
    try {
      const res = await api("/api/dialog/open-files", {});
      if (!res.paths || !res.paths.length) return;
      await openPaths(res.paths);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function openFolder() {
    if (state.busy) return;
    try {
      const res = await api("/api/dialog/folder", {});
      if (!res.paths || !res.paths.length) {
        toast("所选文件夹里没有找到表格文件");
        return;
      }
      await openPaths(res.paths);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function openPaths(paths) {
    if (state.busy) return;
    const fresh = [];
    for (const path of paths) {
      const existing = state.files.find((f) => f.path && f.path.toLowerCase() === String(path).toLowerCase());
      if (existing) {
        fresh.push({ existing });
      } else {
        fresh.push({ path });
      }
    }
    const need = fresh.filter((x) => x.path).map((x) => x.path);
    if (!need.length) {
      const first = fresh[0] && fresh[0].existing;
      if (first) {
        activate(first.id);
        toast("该文件已经打开");
      }
      return;
    }
    setLoading(true, "正在读取文件…");
    try {
      const res = await api("/api/open", { paths: need });
      (res.errors || []).slice(0, 3).forEach((e) => toast(`${e.name}：${e.error}`, "error"));
      if (res.errors && res.errors.length > 3) {
        toast(`另有 ${res.errors.length - 3} 个文件打开失败`, "error");
      }
      let last = null;
      for (const sheet of res.sheets || []) {
        const f = makeFile(sheet);
        state.files.push(f);
        last = f;
      }
      const existed = fresh.find((x) => x.existing);
      if (last) {
        activate(last.id, true);
      } else if (existed) {
        activate(existed.existing.id, true);
      }
      renderTabs();
      renderToolbar();
      refreshHistory();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function openTemplate(path) {
    if (!path || state.busy) return false;
    setLoading(true, "正在从默认模板创建副本…");
    try {
      const res = await api("/api/template", { path });
      const f = makeFile(res.sheet);
      state.files.push(f);
      activate(f.id, true);
      renderTabs();
      renderToolbar();
      toast("已从默认模板创建副本，源文件不会被修改", "success");
      return true;
    } catch (err) {
      toast(err.message, "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  /* 双击文件由已运行窗口接管 */
  let pendingPolling = false;
  async function pollPendingOpens() {
    if (pendingPolling || state.busy) return;
    pendingPolling = true;
    try {
      const res = await api("/api/pending", {});
      if (res.paths && res.paths.length) await openPaths(res.paths);
    } catch (err) {
      // 服务未就绪时静默，下一轮再试
    } finally {
      pendingPolling = false;
    }
  }

  function newFileDialog() {
    if (state.busy) return;
    const template = state.settings.template;
    if (template && template.useOnNew && template.path) {
      if (!template.exists) {
        toast("默认模板文件不存在，请在“默认模板”中重新设置", "error");
        return;
      }
      openTemplate(template.path);
      return;
    }
    const content = `<div class="form-row">
      <label>列名</label>
      <div class="field">
        <input class="input" id="new-columns" value="${escAttr(DEFAULT_HEADER.join(","))}">
        <div class="hint-box">用英文逗号分隔列名，之后也可以在表头上右键增删改列。</div>
      </div>
    </div>`;
    showModal({
      title: "新建表格",
      desc: "新表格默认使用与原文件一致的 12 列结构。",
      content,
      buttons: [
        { label: "取消" },
        {
          label: "创建", primary: true, onClick: ({ body }) => {
            const raw = body.querySelector("#new-columns").value;
            const header = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
            if (!header.length) {
              toast("至少填写一列", "error");
              return false;
            }
            const f = makeFile({
              id: "new-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now()),
              name: "未命名表格.xlsx",
              path: "",
              kind: "html",
              encoding: "UTF-8",
              header,
              rows: [],
              isNew: true,
            });
            state.files.push(f);
            activate(f.id);
            toast("已创建新表格，保存时选择位置");
          }
        },
      ],
    });
  }

  /* 关闭文件 */
  async function closeFile(id) {
    const f = state.files.find((x) => x.id === id);
    if (!f) return;
    if (state.busy) return;
    if (state.editing && state.editing.fileId === id) commitEdit();
    if (f.dirty) {
      const choice = await askCloseChoice(f);
      if (!choice) return;
      if (choice === "save") {
        const ok = await saveFile(f, { forceDialog: !f.path });
        if (!ok) return;
      }
    }
    const index = state.files.findIndex((x) => x.id === id);
    state.files.splice(index, 1);
    if (state.activeId === id) {
      const next = state.files[Math.min(index, state.files.length - 1)];
      state.activeId = next ? next.id : null;
    }
    renderTabs();
    renderToolbar();
    renderBatchBar();
    renderStatus();
    if (state.activeId) {
      activate(state.activeId);
    } else {
      hideRefHighlights();
      el.empty.hidden = false;
      el.gridWrap.hidden = true;
      el.toolbar.hidden = true;
      el.tabbar.hidden = true;
      el.searchInput.value = "";
      el.searchCount.textContent = "0 / 0";
      el.statusPath.textContent = "就绪";
      el.statusMeta.textContent = "";
      el.statusExtra.textContent = "";
      renderRecentHome();
    }
    syncDirty();
  }

  function askCloseChoice(f) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        modal.close();
      };
      const modal = showModal({
        title: "关闭文件",
        desc: `“${esc(f.name)}”还有未保存的修改。`,
        buttons: [
          { label: "取消", onClick: () => finish(null) },
          { label: "不保存关闭", danger: true, onClick: () => finish("discard") },
          { label: "保存并关闭", primary: true, onClick: () => finish("save") },
        ],
        onClose: () => {
          if (!done) {
            done = true;
            resolve(null);
          }
        },
      });
    });
  }

  /* 保存 */
  async function saveFile(f, opts) {
    opts = opts || {};
    if (!f || state.busy) return false;
    if (state.editing && state.editing.fileId === f.id) commitEdit();
    let target = f.path;
    if (!target || opts.forceDialog) {
      try {
        const res = await api("/api/dialog/save-file", {
          dir: f.dir || "",
          name: f.name || "新表格.xlsx",
        });
        if (!res.path) return false;
        target = res.path;
      } catch (err) {
        toast(err.message, "error");
        return false;
      }
    }
    setLoading(true, "正在保存…");
    try {
      const payload = {
        id: f.id,
        path: target,
        header: f.header,
        rows: f.rows,
      };
      if (hasFormulas(f)) payload.displayRows = displayRowsOf(f);
      const res = await api("/api/save", payload);
      f.path = res.path;
      f.dir = dirName(res.path);
      f.name = res.name || baseName(res.path);
      f.kind = res.kind || f.kind;
      f.encoding = res.encoding || f.encoding;
      f.isNew = false;
      f.isTemplate = false;
      f.sourcePath = "";
      f.savedSig = signature(f);
      f.dirty = false;
      renderTabs();
      renderStatus();
      renderToolbar();
      syncDirty();
      toast("已保存 " + f.name + (res.backup ? "（原文件已备份）" : ""), "success");
      refreshHistory();
      return true;
    } catch (err) {
      toast(err.message, "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function saveActive() {
    const f = active();
    if (!f) return;
    if (state.editing) commitEdit();
    await saveFile(f, { forceDialog: !f.path });
  }

  async function saveAsActive() {
    const f = active();
    if (!f) return;
    if (state.editing) commitEdit();
    await saveFile(f, { forceDialog: true });
  }

  async function saveAll() {
    if (state.busy) return;
    if (state.editing) commitEdit();
    const dirty = state.files.filter((f) => f.dirty);
    if (!dirty.length) {
      toast("没有需要保存的修改");
      return;
    }
    let saved = 0;
    for (const f of dirty) {
      const ok = await saveFile(f, { forceDialog: !f.path });
      if (ok) saved++;
      if (!active()) break;
    }
    if (saved) toast(`已保存 ${saved} 个文件`, "success");
  }

  async function exportFile(format) {
    const f = active();
    if (!f || state.busy) return;
    if (state.editing) commitEdit();
    const ext = format === "html" ? "html" : "xlsx";
    try {
      const res = await api("/api/dialog/save-file", {
        dir: f.dir || "",
        name: stem(f.name || "新表格") + "_导出." + ext,
      });
      if (!res.path) return;
      let target = res.path;
      const validExt = ext === "html" ? /\.html?$/i : /\.xlsx$/i;
      if (!validExt.test(target)) target = target.replace(/\.[^.\\/]+$/, "") + "." + ext;
      setLoading(true, ext === "html" ? "正在导出网页表格…" : "正在导出 Excel…");
      const payload = {
        path: target,
        header: f.header,
        rows: f.rows,
        sheet_name: stem(f.name || "数据"),
      };
      if (hasFormulas(f)) payload.displayRows = displayRowsOf(f);
      await api("/api/export", payload);
      toast("已导出 " + baseName(target), "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  /* 行与列操作 */
  function insertRow() {
    const f = active();
    if (!f || state.busy) return;
    let index = f.rows.length;
    if (f.sel.size) {
      index = 0;
      for (const r of f.sel) if (r >= index) index = r + 1;
    } else if (f.activeCell) index = f.activeCell.r + 1;
    pushUndo(f);
    const rowMap = (i) => (i === 0 ? 0 : i - 1 >= index ? i + 1 : i);
    remapFormulas(f, rowMap, null);
    remapFormulaFillRows(f, rowMap, (i) => (i >= index ? i + 1 : i));
    f.rows.splice(index, 0, new Array(f.header.length).fill(""));
    applyFormulaFillRules(f, [index]);
    f.sel = new Set([index]);
    f.anchor = index;
    f.activeCell = { r: index, c: 0 };
    markChanged(f);
    afterDataChange(f);
    scrollRowIntoView(f, index);
    renderBody();
    toast("已插入空白行");
  }

  function selectRange(a, b) {
    const f = active();
    f.sel = new Set();
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const rows = isFilteredView(f) ? visibleRows(f) : null;
    if (rows) {
      for (const r of rows) if (r >= lo && r <= hi) f.sel.add(r);
    } else {
      for (let r = lo; r <= hi; r++) f.sel.add(r);
    }
  }

  async function deleteSelectedRows() {
    const f = active();
    if (!f || !f.sel.size || state.busy) return;
    const count = f.sel.size;
    const ok = await confirmDialog("删除选中行", `确定删除选中的 ${count} 行吗？此操作可以用 Ctrl+Z 撤销。`, "删除");
    if (!ok) return;
    pushUndo(f);
    const rowMap = deleteRowRefMap(f.sel);
    remapFormulas(f, rowMap, null);
    remapFormulaFillRows(f, rowMap, deleteMapFromSet(f.sel));
    f.rows = f.rows.filter((_, i) => !f.sel.has(i));
    f.sel.clear();
    f.anchor = null;
    f.activeCell = null;
    markChanged(f);
    afterDataChange(f);
    toast(`已删除 ${count} 行`);
  }

  function clearSelectedRows() {
    const f = active();
    if (!f || !f.sel.size) return;
    pushUndo(f);
    for (const r of f.sel) f.rows[r] = new Array(f.header.length).fill("");
    markChanged(f);
    afterDataChange(f);
    toast("已清空所选行内容");
  }

  async function deleteEmptyRows() {
    const f = active();
    if (!f || state.busy) return;
    const empties = [];
    f.rows.forEach((row, i) => {
      if (row.every((v) => !String(v || "").trim())) empties.push(i);
    });
    if (!empties.length) {
      toast("没有空行");
      return;
    }
    const ok = await confirmDialog("删除空行", `共找到 ${empties.length} 个空行，确定删除吗？`, "删除");
    if (!ok) return;
    const set = new Set(empties);
    pushUndo(f);
    const rowMap = deleteRowRefMap(set);
    remapFormulas(f, rowMap, null);
    remapFormulaFillRows(f, rowMap, deleteMapFromSet(set));
    f.rows = f.rows.filter((_, i) => !set.has(i));
    f.sel.clear();
    f.activeCell = null;
    markChanged(f);
    afterDataChange(f);
    toast(`已删除 ${empties.length} 个空行`);
  }

  function renumber() {
    const f = active();
    if (!f || !f.rows.length) return;
    let col = f.header.findIndex((h) => String(h).includes("序号"));
    if (col < 0) col = 0;
    pushUndo(f);
    f.rows.forEach((row, i) => {
      row[col] = String(i + 1);
    });
    markChanged(f);
    recomputeSearch(f, true);
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderStatus();
    renderTabs();
    updateUndoButtons();
    renderToolbar();
    syncDirty();
    toast("已按当前顺序重新编号");
  }

  function renameColumn(col) {
    const f = active();
    if (!f) return;
    promptDialog("列名", "修改列名", f.header[col], (value) => {
      const name = value.trim();
      if (!name) {
        toast("列名不能为空", "error");
        return false;
      }
      pushUndo(f);
      f.header[col] = name;
      markChanged(f);
      recomputeSearch(f, true);
      ensureWidths(f);
      renderSearchScope();
      renderHeader(f);
      renderBody();
      updateSearchCount();
      renderTabs();
      updateUndoButtons();
      renderToolbar();
      syncDirty();
      return true;
    });
  }

  function insertColumn(col) {
    const f = active();
    if (!f) return;
    promptDialog("插入列", "新列的列名", "新列", (value) => {
      const name = value.trim() || "新列";
      pushUndo(f);
      const colMap = (i) => (i >= col ? i + 1 : i);
      remapFormulas(f, null, colMap);
      remapFormulaFillColumns(f, colMap);
      const shifted = {};
      for (const key of Object.keys(f.filters)) {
        const i = Number(key);
        shifted[i >= col ? i + 1 : i] = f.filters[key];
      }
      f.filters = shifted;
      f.header.splice(col, 0, name);
      f.rows.forEach((row) => row.splice(col, 0, ""));
      f.widths.splice(col, 0, Math.max(90, Math.round(textWidth(name) + 30)));
      if (f.activeCell && f.activeCell.c >= col) f.activeCell.c++;
      markChanged(f);
      recomputeSearch(f, true);
      ensureWidths(f);
      renderSearchScope();
      renderHeader(f);
      renderBody();
      updateSearchCount();
      renderTabs();
      updateUndoButtons();
      renderToolbar();
      syncDirty();
      return true;
    });
  }

  async function deleteColumn(col) {
    const f = active();
    if (!f) return;
    if (f.header.length <= 1) {
      toast("至少要保留一列", "error");
      return;
    }
    const ok = await confirmDialog("删除列", `确定删除列“${f.header[col]}”及该列所有数据吗？`, "删除");
    if (!ok) return;
    pushUndo(f);
    const colMap = (i) => (i === col ? -1 : i > col ? i - 1 : i);
    remapFormulas(f, null, colMap);
    remapFormulaFillColumns(f, colMap);
    const shifted = {};
    for (const key of Object.keys(f.filters)) {
      const i = Number(key);
      if (i === col) continue;
      shifted[i > col ? i - 1 : i] = f.filters[key];
    }
    f.filters = shifted;
    f.header.splice(col, 1);
    f.rows.forEach((row) => row.splice(col, 1));
    f.widths.splice(col, 1);
    if (f.search.scope === col) f.search.scope = -1;
    else if (f.search.scope > col) f.search.scope--;
    if (f.activeCell) f.activeCell.c = clamp(f.activeCell.c, 0, f.header.length - 1);
    markChanged(f);
    recomputeSearch(f, true);
    ensureWidths(f);
    renderSearchScope();
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderTabs();
    updateUndoButtons();
    renderToolbar();
    syncDirty();
  }

  /* 剪贴板 */
  async function writeClipboard(text, meta, label) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = legacyCopy(text);
    }
    if (copied) {
      state.clipboard = { text, ...meta };
      toast(label);
    } else {
      toast("复制失败，请重试", "error");
    }
  }

  async function copySelection() {
    const f = active();
    if (!f) return;
    let rows = [...f.sel].sort((a, b) => a - b);
    if (!rows.length && f.activeCell) rows = [f.activeCell.r];
    if (!rows.length) return;
    const text = rows.map((r) => f.rows[r].map((v) => String(v == null ? "" : v).replace(/\t/g, " ")).join("\t")).join("\r\n");
    await writeClipboard(text, { startR: rows[0], startC: 0 }, `已复制 ${rows.length} 行`);
  }

  async function copyCell(r, c) {
    const f = active();
    if (!f) return;
    const value = cellRaw(f, r, c);
    const text = String(value == null ? "" : value).replace(/\t/g, " ").replace(/[\r\n]+/g, " ");
    await writeClipboard(text, { startR: r, startC: c }, "已复制单元格");
  }

  function legacyCopy(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  async function pasteBlock(text) {
    const f = active();
    if (!f || !f.activeCell || !text) return;
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) return;
    if (lines.length > 20000) {
      toast("一次粘贴的行数过多", "error");
      return;
    }
    const matrix = lines.map((line) => line.split("\t"));
    const startR = f.activeCell.r;
    const startC = f.activeCell.c;
    const clip = state.clipboard && state.clipboard.text === text ? state.clipboard : null;
    const sourceR = clip ? clip.startR : startR;
    const sourceC = clip ? clip.startC : startC;
    const needRows = startR + matrix.length;
    const needCols = startC + Math.max(...matrix.map((row) => row.length));
    const oldRowCount = f.rows.length;
    pushUndo(f);

    while (f.header.length < needCols) {
      f.header.push("列" + (f.header.length + 1));
      f.widths.push(90);
    }
    f.rows.forEach((row) => {
      while (row.length < f.header.length) row.push("");
    });
    while (f.rows.length < needRows) f.rows.push(new Array(f.header.length).fill(""));
    if (needRows > oldRowCount) {
      const added = [];
      for (let r = oldRowCount; r < needRows; r++) added.push(r);
      applyFormulaFillRules(f, added);
    }
    matrix.forEach((line, i) => {
      line.forEach((value, j) => {
        f.rows[startR + i][startC + j] = isFormula(value)
          ? SheetFormula.shiftRefs(value, startR + i - sourceR, startC + j - sourceC)
          : value;
      });
    });
    f.sel = new Set();
    for (let i = 0; i < matrix.length; i++) f.sel.add(startR + i);
    f.anchor = startR;
    markChanged(f);
    recomputeSearch(f, true);
    ensureWidths(f);
    renderSearchScope();
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderTabs();
    renderBatchBar();
    renderStatus();
    updateUndoButtons();
    renderToolbar();
    syncDirty();
    toast(`已粘贴 ${matrix.length} 行 × ${Math.max(...matrix.map((r) => r.length))} 列`);
  }

  function openFormulaFill() {
    const f = active();
    if (!f || state.busy) return;
    if (!f.rows.length) {
      toast("请先插入数据行", "error");
      return;
    }
    const defaultScope = f.sel.size > 1 ? "selected" : "all";
    const activeFormula = f.activeCell && isFormula(cellRaw(f, f.activeCell.r, f.activeCell.c))
      ? cellRaw(f, f.activeCell.r, f.activeCell.c)
      : "";
    const content = `<div class="form-row">
        <label>应用范围</label>
        <div class="field"><div class="seg">
          <label><input type="radio" name="fill-scope" value="selected" ${defaultScope === "selected" ? "checked" : "disabled"}>选中行（${f.sel.size}）</label>
          <label><input type="radio" name="fill-scope" value="all" ${defaultScope === "all" ? "checked" : ""}>全部行（${f.rows.length}）</label>
        </div></div>
      </div>
      <div class="form-row">
        <label>目标列</label>
        <div class="field"><select class="input" id="fill-col">${f.header.map((h, i) => `<option value="${i}"${f.activeCell && f.activeCell.c === i ? " selected" : ""}>${esc(h || "第 " + (i + 1) + " 列")}</option>`).join("")}</select></div>
      </div>
      <div class="form-row">
        <label>公式</label>
        <div class="field"><input class="input" id="fill-formula" value="${escAttr(activeFormula)}" placeholder="例如 =SUM(C2:E2)" autocomplete="off" spellcheck="false"></div>
      </div>
      <div class="hint-box" id="fill-preview"></div>
      <div class="hint-box">相对引用会按目标行自动调整，$ 绝对引用保持不变；以后新增数据行也会自动套用此公式。</div>`;
    const modal = showModal({
      title: "公式填充",
      desc: "将一个公式批量应用到整列或选中行。",
      content,
      buttons: [
        { label: "取消" },
        { label: "开始填充", primary: true, onClick: () => applyFormulaFill(modal) },
      ],
    });
    const formulaInput = modal.body.querySelector("#fill-formula");
    const preview = modal.body.querySelector("#fill-preview");
    const updatePreview = () => {
      const scope = modal.body.querySelector('input[name="fill-scope"]:checked').value;
      const indices = scope === "selected" ? [...f.sel].sort((a, b) => a - b) : f.rows.map((_, i) => i);
      const formula = formulaInput.value.trim();
      const baseRow = activeFormula && f.activeCell ? f.activeCell.r : (indices[0] || 0);
      const sample = formula && indices.length
        ? SheetFormula.shiftRefs(formula, indices[0] - baseRow, 0)
        : "请输入以 = 开头的公式";
      preview.textContent = `将处理 ${indices.length} 行，首行公式：${sample}`;
    };
    formulaInput.addEventListener("input", updatePreview);
    modal.body.querySelectorAll('input[name="fill-scope"]').forEach((radio) => radio.addEventListener("change", updatePreview));
    updatePreview();
    if (!activeFormula) setTimeout(() => formulaInput.focus(), 50);
  }

  function applyFormulaFill(modal) {
    const f = active();
    if (!f) return false;
    const formula = modal.body.querySelector("#fill-formula").value.trim();
    if (!/^=/.test(formula)) {
      toast("请输入以 = 开头的公式", "error");
      return false;
    }
    const scope = modal.body.querySelector('input[name="fill-scope"]:checked').value;
    const col = Number(modal.body.querySelector("#fill-col").value);
    const indices = scope === "selected" ? [...f.sel].sort((a, b) => a - b) : f.rows.map((_, i) => i);
    if (!indices.length) {
      toast("没有可填充的行", "error");
      return false;
    }
    const activeFormula = f.activeCell && isFormula(cellRaw(f, f.activeCell.r, f.activeCell.c));
    const baseRow = activeFormula ? f.activeCell.r : indices[0];
    modal.close();
    pushUndo(f);
    fillFormula(f, col, indices, formula, baseRow);
    markChanged(f);
    recomputeSearch(f, true);
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderTabs();
    renderBatchBar();
    renderStatus();
    updateUndoButtons();
    renderToolbar();
    syncDirty();
    toast(`已填充 ${indices.length} 行，新增行将自动套用`, "success");
    return true;
  }

  /* 右键菜单 */
  let contextMenu = null;

  function closeContextMenu() {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
  }

  function showContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.textContent = item.label;
      if (item.danger) btn.className = "danger";
      btn.addEventListener("click", () => {
        closeContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
    menu.style.left = "0px";
    menu.style.top = "0px";
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
    contextMenu = menu;
  }

  /* 弹窗 */
  function showModal(opts) {
    hideRefHighlights();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    if (opts.width) modal.style.width = opts.width;
    modal.innerHTML = `<div class="modal-head">${esc(opts.title || "")}</div>
      ${opts.desc ? `<div class="modal-desc">${opts.desc}</div>` : ""}
      <div class="modal-body"></div>
      <div class="modal-foot"></div>`;
    const body = modal.querySelector(".modal-body");
    if (typeof opts.content === "string") body.innerHTML = opts.content;
    else if (opts.content) body.appendChild(opts.content);
    const foot = modal.querySelector(".modal-foot");
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
      const index = state.modalStack.indexOf(handle);
      if (index >= 0) state.modalStack.splice(index, 1);
      state.activeModal = state.modalStack[state.modalStack.length - 1] || null;
      if (opts.onClose) opts.onClose();
    };
    const handle = { close, body, modal };
    for (const b of opts.buttons || []) {
      const btn = document.createElement("button");
      btn.className = "btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "");
      btn.textContent = b.label;
      btn.addEventListener("click", async () => {
        if (b.onClick) {
          let result;
          try {
            result = await b.onClick(handle);
          } catch (err) {
            toast(err.message, "error");
            return;
          }
          if (result === false) return;
        }
        close();
      });
      foot.appendChild(btn);
    }
    overlay.appendChild(modal);
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) close();
    });
    modal.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.target.matches("textarea, select, button")) {
        const primary = foot.querySelector(".btn.primary");
        if (primary) {
          ev.preventDefault();
          primary.click();
        }
      }
    });
    document.body.appendChild(overlay);
    state.modalStack.push(handle);
    state.activeModal = handle;
    const first = modal.querySelector("input, select, textarea");
    if (first) setTimeout(() => { try { first.focus(); first.select && first.select(); } catch (e) {} }, 40);
    return handle;
  }

  function confirmDialog(title, message, okLabel) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        modal.close();
      };
      const modal = showModal({
        title,
        desc: esc(message).replace(/\n/g, "<br>"),
        buttons: [
          { label: "取消", onClick: () => finish(false) },
          { label: okLabel || "确定", danger: true, onClick: () => finish(true) },
        ],
        onClose: () => {
          if (!done) {
            done = true;
            resolve(false);
          }
        },
      });
    });
  }

  function promptDialog(title, label, value, onSubmit) {
    const content = `<div class="form-row"><label>${esc(label)}</label>
      <div class="field"><input class="input" id="prompt-input" value="${escAttr(value || "")}"></div></div>`;
    const modal = showModal({
      title,
      content,
      buttons: [
        { label: "取消" },
        {
          label: "确定", primary: true, onClick: ({ body }) => {
            const v = body.querySelector("#prompt-input").value;
            return onSubmit(v);
          }
        },
      ],
    });
    const input = modal.body.querySelector("#prompt-input");
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  /* 进度 */
  function createProgress(title, total) {
    const card = document.createElement("div");
    card.className = "progress-card";
    card.innerHTML = `<div class="progress-head">
        <span class="progress-title">${esc(title)}</span>
        <span class="progress-text">0 / ${total}</span>
      </div>
      <div class="progress-track"><div class="progress-bar"></div></div>
      <div class="progress-foot"><button class="progress-cancel">取消</button></div>`;
    const bar = card.querySelector(".progress-bar");
    const text = card.querySelector(".progress-text");
    const cancel = card.querySelector(".progress-cancel");
    const ctrl = { canceled: false, shown: false, close: null };
    cancel.addEventListener("click", () => {
      ctrl.canceled = true;
      cancel.textContent = "正在取消…";
      cancel.disabled = true;
    });
    const timer = setTimeout(() => {
      if (ctrl.closed) return;
      document.body.appendChild(card);
      ctrl.shown = true;
    }, 200);
    ctrl.set = (done, all) => {
      bar.style.width = (all ? Math.round(done / all * 100) : 0) + "%";
      text.textContent = `${done} / ${all}`;
    };
    ctrl.close = () => {
      ctrl.closed = true;
      clearTimeout(timer);
      card.remove();
    };
    return ctrl;
  }

  async function runProgress(title, total, worker) {
    const ctrl = createProgress(title, total);
    const chunk = Math.max(60, Math.ceil(total / 18));
    let done = 0;
    try {
      for (let i = 0; i < total; i += chunk) {
        if (ctrl.canceled) break;
        const end = Math.min(total, i + chunk);
        for (let k = i; k < end; k++) worker(k);
        done = end;
        ctrl.set(done, total);
        await nextFrame();
      }
    } finally {
      ctrl.close();
    }
    return { done, canceled: ctrl.canceled };
  }

  /* 批量修改 */
  function openBatchEdit() {
    const f = active();
    if (!f || state.busy) return;
    const selected = f.sel.size;
    const content = `<div class="form-row">
        <label>应用范围</label>
        <div class="field"><div class="seg">
          <label><input type="radio" name="batch-scope" value="selected" ${selected ? "checked" : "disabled"}>选中行（${selected}）</label>
          <label><input type="radio" name="batch-scope" value="all" ${selected ? "" : "checked"}>全部行（${f.rows.length}）</label>
        </div></div>
      </div>
      <div class="form-row">
        <label>目标列</label>
        <div class="field"><select class="input" id="batch-col">${f.header.map((h, i) => `<option value="${i}">${esc(h || "第 " + (i + 1) + " 列")}</option>`).join("")}</select></div>
      </div>
      <div class="form-row">
        <label>处理方式</label>
        <div class="field"><select class="input" id="batch-op">
          <option value="set">设为固定值</option>
          <option value="replace">查找并替换</option>
          <option value="prefix">添加前缀</option>
          <option value="suffix">添加后缀</option>
          <option value="clear">清空内容</option>
        </select></div>
      </div>
      <div class="form-row" data-op="set">
        <label>新值</label>
        <div class="field"><input class="input" id="batch-value" placeholder="要写入的内容"></div>
      </div>
      <div class="form-row" data-op="replace">
        <label>查找内容</label>
        <div class="field"><input class="input" id="batch-find" placeholder="留空则不处理"></div>
      </div>
      <div class="form-row" data-op="replace">
        <label>替换为</label>
        <div class="field"><input class="input" id="batch-replace" placeholder="可留空，表示删除查找内容"></div>
      </div>
      <div class="form-row" data-op="prefix">
        <label>前缀</label>
        <div class="field"><input class="input" id="batch-prefix"></div>
      </div>
      <div class="form-row" data-op="suffix">
        <label>后缀</label>
        <div class="field"><input class="input" id="batch-suffix"></div>
      </div>
      <div class="hint-box" id="batch-preview"></div>`;

    const modal = showModal({
      title: "批量修改",
      content,
      buttons: [
        { label: "取消" },
        { label: "开始处理", primary: true, onClick: () => applyBatchEdit(modal) },
      ],
    });

    const opSelect = modal.body.querySelector("#batch-op");
    const preview = modal.body.querySelector("#batch-preview");
    const updateRows = () => {
      const op = opSelect.value;
      modal.body.querySelectorAll("[data-op]").forEach((row) => {
        row.hidden = row.dataset.op !== op;
      });
      updatePreview();
    };
    const updatePreview = () => {
      const scope = modal.body.querySelector('input[name="batch-scope"]:checked').value;
      const count = scope === "selected" ? f.sel.size : f.rows.length;
      preview.innerHTML = `将处理 <b>${count}</b> 行，处理过程中可以随时取消，完成后可用 Ctrl+Z 撤销。`;
    };
    opSelect.addEventListener("change", updateRows);
    modal.body.querySelectorAll('input[name="batch-scope"]').forEach((r) => r.addEventListener("change", updatePreview));
    updateRows();
  }

  async function applyBatchEdit(modal) {
    const f = active();
    if (!f) return false;
    const body = modal.body;
    const scope = body.querySelector('input[name="batch-scope"]:checked').value;
    const col = Number(body.querySelector("#batch-col").value);
    const op = body.querySelector("#batch-op").value;
    const valueOf = (id) => body.querySelector(id).value;
    if (op === "replace" && !valueOf("#batch-find")) {
      toast("请填写要查找的内容", "error");
      return false;
    }
    const indices = scope === "selected" ? [...f.sel].sort((a, b) => a - b) : f.rows.map((_, i) => i);
    if (!indices.length) {
      toast("没有可处理的行", "error");
      return false;
    }
    modal.close();
    pushUndo(f);
    state.busy = true;
    const find = valueOf("#batch-find");
    const replace = valueOf("#batch-replace");
    const setting = valueOf("#batch-value");
    const prefix = valueOf("#batch-prefix");
    const suffix = valueOf("#batch-suffix");
    const result = await runProgress("正在批量修改", indices.length, (k) => {
      const r = indices[k];
      const old = f.rows[r][col] == null ? "" : String(f.rows[r][col]);
      let next = old;
      if (op === "set") next = setting;
      else if (op === "replace") next = find ? old.split(find).join(replace) : old;
      else if (op === "prefix") next = prefix + old;
      else if (op === "suffix") next = old + suffix;
      else if (op === "clear") next = "";
      f.rows[r][col] = next;
    });
    state.busy = false;
    markChanged(f);
    recomputeSearch(f, true);
    renderHeader(f);
    renderBody();
    updateSearchCount();
    renderStatus();
    renderTabs();
    renderBatchBar();
    updateUndoButtons();
    renderToolbar();
    syncDirty();
    if (result.canceled) {
      toast(`已取消，处理了 ${result.done} 行，可撤销`, "error");
    } else {
      toast(`批量处理完成，共 ${result.done} 行`, "success");
    }
    return true;
  }

  /* 去重 */
  function openDedupe() {
    const f = active();
    if (!f || state.busy) return;
    const columns = f.header.map((h, i) => `<option value="${i}" ${String(h).includes("账号") ? "selected" : ""}>${esc(h || "第 " + (i + 1) + " 列")}</option>`).join("");
    const content = `<div class="form-row">
        <label>检查范围</label>
        <div class="field"><div class="seg">
          <label><input type="radio" name="dedupe-scope" value="all" checked>全部行（${f.rows.length}）</label>
          <label><input type="radio" name="dedupe-scope" value="selected" ${f.sel.size ? "" : "disabled"}>选中行（${f.sel.size}）</label>
        </div></div>
      </div>
      <div class="form-row">
        <label>依据列</label>
        <div class="field"><select class="input" id="dedupe-col">${columns}</select></div>
      </div>
      <div class="form-row">
        <label>保留</label>
        <div class="field"><div class="seg">
          <label><input type="radio" name="dedupe-keep" value="first" checked>每组保留第一行</label>
          <label><input type="radio" name="dedupe-keep" value="last">保留最后一行</label>
        </div></div>
      </div>
      <div class="hint-box" id="dedupe-preview"></div>`;
    const modal = showModal({
      title: "删除重复行",
      desc: "按所选列的值判断重复，比较时忽略首尾空格。",
      content,
      buttons: [
        { label: "取消" },
        { label: "删除重复行", danger: true, primary: false, onClick: () => applyDedupe(modal) },
      ],
    });
    const refresh = () => {
      const plan = buildDedupePlan(f, modal.body);
      modal.body.querySelector("#dedupe-preview").innerHTML = plan.remove.size
        ? `将删除 <b>${plan.remove.size}</b> 行重复数据，保留 ${plan.total - plan.remove.size} 行。`
        : "没有发现重复数据。";
    };
    modal.body.querySelectorAll("input, select").forEach((node) => {
      node.addEventListener("change", refresh);
      node.addEventListener("input", refresh);
    });
    refresh();
  }

  function buildDedupePlan(f, body) {
    const scope = body.querySelector('input[name="dedupe-scope"]:checked').value;
    const col = Number(body.querySelector("#dedupe-col").value);
    const keep = body.querySelector('input[name="dedupe-keep"]:checked').value;
    const indices = scope === "selected" ? [...f.sel].sort((a, b) => a - b) : f.rows.map((_, i) => i);
    const seen = new Map();
    const remove = new Set();
    for (const r of indices) {
      const key = String(f.rows[r][col] == null ? "" : f.rows[r][col]).trim().toLowerCase();
      if (!key) continue;
      if (!seen.has(key)) {
        seen.set(key, r);
      } else if (keep === "first") {
        remove.add(r);
      } else {
        remove.add(seen.get(key));
        seen.set(key, r);
      }
    }
    return { remove, total: indices.length };
  }

  function applyDedupe(modal) {
    const f = active();
    if (!f) return false;
    const plan = buildDedupePlan(f, modal.body);
    if (!plan.remove.size) {
      toast("没有发现重复数据");
      return false;
    }
    pushUndo(f);
    const rowMap = deleteRowRefMap(plan.remove);
    remapFormulas(f, rowMap, null);
    remapFormulaFillRows(f, rowMap, deleteMapFromSet(plan.remove));
    f.rows = f.rows.filter((_, i) => !plan.remove.has(i));
    f.sel.clear();
    f.activeCell = null;
    markChanged(f);
    afterDataChange(f);
    toast(`已删除 ${plan.remove.size} 个重复行`, "success");
    return true;
  }

  /* 事件绑定 */
  function bindEvents() {
    $("btn-open").addEventListener("click", openViaDialog);
    $("btn-open-empty").addEventListener("click", openViaDialog);
    $("btn-open-folder").addEventListener("click", openFolder);
    $("btn-new").addEventListener("click", newFileDialog);
    $("btn-new-empty").addEventListener("click", newFileDialog);
    $("btn-template").addEventListener("click", openTemplateDialog);
    $("btn-save").addEventListener("click", saveActive);
    $("btn-save-as").addEventListener("click", saveAsActive);
    $("btn-export").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!active()) return;
      el.freezeMenu.hidden = true;
      el.exportMenu.hidden = !el.exportMenu.hidden;
    });
    el.exportMenu.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-export]");
      if (!btn) return;
      el.exportMenu.hidden = true;
      exportFile(btn.dataset.export);
    });
    $("btn-save-all").addEventListener("click", saveAll);
    $("btn-history").addEventListener("click", openHistory);
    $("recent-clear").addEventListener("click", clearAllHistory);
    $("btn-theme").addEventListener("click", openThemeDialog);
    el.recentHomeList.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".recent-item[data-path]");
      if (btn) openHistoryItem(btn.dataset.path);
    });
    $("btn-undo").addEventListener("click", undo);
    $("btn-redo").addEventListener("click", redo);
    $("btn-insert-row").addEventListener("click", insertRow);
    $("btn-fill-formula").addEventListener("click", openFormulaFill);
    $("btn-freeze").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!active()) return;
      el.exportMenu.hidden = true;
      el.freezeMenu.hidden = !el.freezeMenu.hidden;
    });
    el.freezeMenu.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-freeze]");
      if (!btn) return;
      setFreezeMode(btn.dataset.freeze);
    });
    $("btn-clear-filter").addEventListener("click", clearAllFilters);
    $("btn-delete-rows").addEventListener("click", deleteSelectedRows);
    $("btn-copy").addEventListener("click", copySelection);
    $("btn-batch-edit").addEventListener("click", openBatchEdit);
    $("btn-clear-sel").addEventListener("click", () => {
      const f = active();
      if (!f) return;
      f.sel.clear();
      f.anchor = null;
      paintSelection();
      renderBatchBar();
      renderStatus();
    });

    $("btn-more").addEventListener("click", (ev) => {
      ev.stopPropagation();
      el.moreMenu.hidden = !el.moreMenu.hidden;
    });
    el.moreMenu.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      el.moreMenu.hidden = true;
      const action = btn.dataset.action;
      if (action === "dedupe") openDedupe();
      else if (action === "empty") deleteEmptyRows();
      else if (action === "renumber") renumber();
      else if (action === "clear") clearSelectedRows();
    });

    el.tabbar.addEventListener("click", (ev) => {
      const closeBtn = ev.target.closest("[data-close]");
      if (closeBtn) {
        ev.stopPropagation();
        closeFile(closeBtn.dataset.close);
        return;
      }
      const tab = ev.target.closest(".tab[data-id]");
      if (tab) activate(tab.dataset.id);
    });

    el.tbody.addEventListener("click", onGridClick);
    el.tbody.addEventListener("dblclick", (ev) => {
      const td = ev.target.closest("td.cell");
      if (!td) return;
      startEdit(Number(td.dataset.r), Number(td.dataset.c));
    });
    el.tbody.addEventListener("contextmenu", (ev) => {
      const td = ev.target.closest("td.cell");
      if (!td || state.editing) return;
      ev.preventDefault();
      const f = active();
      if (!f) return;
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      f.activeCell = { r, c };
      if (!f.sel.has(r)) {
        f.sel = new Set([r]);
        f.anchor = r;
      }
      paintSelection();
      renderBatchBar();
      renderStatus();
      const items = [{ label: "复制单元格", action: () => copyCell(r, c) }];
      if (isFormula(cellRaw(f, r, c))) {
        items.push(
          { sep: true },
          { label: "用此公式填充整列", action: openFormulaFill }
        );
      }
      showContextMenu(ev.clientX, ev.clientY, items);
    });
    el.thead.addEventListener("change", (ev) => {
      if (ev.target && ev.target.id === "check-all") {
        const f = active();
        if (!f) return;
        const vis = visibleRows(f);
        if (ev.target.checked) f.sel = new Set(vis);
        else f.sel.clear();
        paintSelection();
        renderBatchBar();
        renderStatus();
      }
    });
    el.thead.addEventListener("contextmenu", (ev) => {
      const th = ev.target.closest("th[data-col]");
      if (!th) return;
      ev.preventDefault();
      const col = Number(th.dataset.col);
      showContextMenu(ev.clientX, ev.clientY, [
        { label: "重命名此列", action: () => renameColumn(col) },
        { label: "在左侧插入列", action: () => insertColumn(col) },
        { label: "在右侧插入列", action: () => insertColumn(col + 1) },
        { sep: true },
        { label: "删除此列", danger: true, action: () => deleteColumn(col) },
      ]);
    });
    el.thead.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".th-filter");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      openFilterPop(Number(btn.dataset.filter), btn);
    });
    el.thead.addEventListener("mousedown", onResizeStart);

    el.gridWrap.addEventListener("scroll", () => {
      const f = active();
      if (!f) return;
      f.scrollTop = el.gridWrap.scrollTop;
      /* 虚拟滚动会重建表格，编辑中的内容先提交，避免编辑器被吞掉 */
      if (state.editing) commitEdit();
      if (state.scrollRaf) return;
      state.scrollRaf = requestAnimationFrame(() => {
        state.scrollRaf = 0;
        renderBody();
      });
    }, { passive: true });

    el.searchInput.addEventListener("input", runSearchFromInput);
    el.searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        gotoMatch(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        el.searchInput.value = "";
        runSearchFromInput();
        el.searchInput.blur();
      }
    });
    el.searchScope.addEventListener("change", () => {
      const f = active();
      if (!f) return;
      f.search.scope = Number(el.searchScope.value);
      runSearchFromInput();
    });
    el.searchFilter.addEventListener("change", () => setFilter(el.searchFilter.checked));
    $("btn-prev").addEventListener("click", () => gotoMatch(-1));
    $("btn-next").addEventListener("click", () => gotoMatch(1));

    $("btn-help").addEventListener("click", showHelp);
    el.statusPath.addEventListener("click", async () => {
      const f = active();
      if (!f || !f.path) return;
      try {
        await navigator.clipboard.writeText(f.path);
        toast("已复制文件路径");
      } catch (err) {
        toast("复制失败", "error");
      }
    });

    document.addEventListener("click", (ev) => {
      if (contextMenu && !ev.target.closest(".context-menu")) closeContextMenu();
      if (!ev.target.closest(".menu-wrap")) closeMoreMenu();
    });
    document.addEventListener("mousedown", (ev) => {
      if (ev.target.closest(".col-resize")) ev.preventDefault();
      /* 编辑公式时点击单元格/引用角标插入或切换引用：阻止默认行为，避免输入框失焦被提交 */
      const inRefPop = ev.target.closest(".ref-pop");
      if (state.editing && /^\s*=/.test(state.editing.input.value)
        && (ev.target.closest("#tbody td.cell")
          || ev.target.closest(".ref-handle")
          || (inRefPop && !ev.target.closest("input, button")))) {
        ev.preventDefault();
      }
    });

    document.addEventListener("focusin", (ev) => {
      if (state.activeModal) {
        hideRefHighlights();
        return;
      }
      if (ev.target === el.formulaInput
        || (state.editing && ev.target === state.editing.cellInput)
        || refPop.contains(ev.target)) {
        updateRefHighlight();
      } else if (isTextInput(ev.target)) {
        hideRefHighlights();
      }
    });
    document.addEventListener("keydown", onGlobalKeydown);
    document.addEventListener("paste", onPaste);
    document.addEventListener("copy", (ev) => {
      if (isTextInput(ev.target) || state.activeModal || state.editing) return;
      const f = active();
      if (!f || (!f.sel.size && !f.activeCell)) return;
      ev.preventDefault();
      copySelection();
    });
    el.gridWrap.addEventListener("keydown", onGridKeydown);

    /* 公式栏事件 */
    el.formulaInput.addEventListener("focus", () => {
      const f = active();
      if (!f) return;
      const ed = state.editing;
      if (ed) {
        /* 已有编辑会话时，公式栏获焦即接管输入（兼容 relatedTarget 为空的场景） */
        if (!ed.viaBar) {
          ed.viaBar = true;
          ed.input = el.formulaInput;
        }
        return;
      }
      if (!f.activeCell) return;
      beginBarEdit(f.activeCell.r, f.activeCell.c, true);
    });
    el.formulaInput.addEventListener("input", () => {
      const f = active();
      if (!f) return;
      if (!state.editing) {
        if (!f.activeCell) {
          el.formulaInput.value = "";
          el.formulaInput.blur();
          return;
        }
        beginBarEdit(f.activeCell.r, f.activeCell.c, false);
      }
      syncEditValue(el.formulaInput.value, true);
      updateAutocomplete();
      updateRefHighlight();
      updateQuickCalcPreview();
    });
    el.formulaInput.addEventListener("keydown", onEditorKeydown);
    el.formulaInput.addEventListener("keyup", updateAutocomplete);
    el.formulaInput.addEventListener("click", updateAutocomplete);
    el.formulaInput.addEventListener("blur", onEditorBlur);
    bindRefPopup();
    el.nameBox.addEventListener("focus", hideRefHighlights);
    el.nameBox.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      jumpToRef(el.nameBox.value);
    });
    el.nameBox.addEventListener("blur", () => renderFormulaBar());

    /* 自动补全菜单：mousedown 阻止夺焦，点击选中 */
    acMenu.addEventListener("mousedown", (ev) => ev.preventDefault());
    acMenu.addEventListener("click", (ev) => {
      const item = ev.target.closest(".ac-item[data-idx]");
      if (!item) return;
      acIndex = Number(item.dataset.idx);
      acceptAcSelection();
    });
    window.addEventListener("resize", hideAutocomplete);
    window.addEventListener("blur", hideAutocomplete);

    window.addEventListener("resize", () => {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(() => {
        const f = active();
        if (!f) return;
        renderHeader(f);
        renderBody();
      }, 80);
    });

    window.addEventListener("beforeunload", (ev) => {
      if (state.files.some((f) => f.dirty) || hasPendingEdit()) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  }

  function onGridClick(ev) {
    const f = active();
    if (!f) return;
    const cb = ev.target.closest("input[type=checkbox]");
    if (cb) {
      const tr = cb.closest("tr[data-r]");
      if (!tr) return;
      const r = Number(tr.dataset.r);
      if (cb.checked) f.sel.add(r);
      else f.sel.delete(r);
      f.anchor = r;
      if (f.activeCell) f.activeCell.r = r;
      else f.activeCell = { r, c: 0 };
      paintSelection();
      renderBatchBar();
      renderStatus();
      return;
    }
    const rowEl = ev.target.closest("tr[data-r]");
    if (!rowEl) return;
    const r = Number(rowEl.dataset.r);
    const td = ev.target.closest("td.cell");
    /* 编辑公式时点击单元格：插入引用而非切换选中（WPS 习惯，Shift+点击插入区域） */
    if (td && state.editing && /^\s*=/.test(state.editing.input.value)) {
      const ed = state.editing;
      const refCol = Number(td.dataset.c);
      const refRow = Number(td.dataset.r);
      if (ed.r === refRow && ed.c === refCol) return; /* 点自己不插引用 */
      let insert = cellRefName(refRow, refCol);
      if (ev.shiftKey && ed.lastRef) {
        const r1 = Math.min(ed.lastRef.r, refRow);
        const r2 = Math.max(ed.lastRef.r, refRow);
        const c1 = Math.min(ed.lastRef.c, refCol);
        const c2 = Math.max(ed.lastRef.c, refCol);
        insert = SheetFormula.colLetter(c1) + (r1 + 2) + ":" + SheetFormula.colLetter(c2) + (r2 + 2);
        ed.lastRef = null;
      } else {
        ed.lastRef = { r: refRow, c: refCol };
      }
      const input = ed.input;
      const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
      const selEnd = input.selectionEnd == null ? caret : input.selectionEnd;
      /* 光标夹在参数中间时自动补逗号，保证公式仍有效 */
      const before = input.value.slice(0, caret).replace(/\s+$/, "");
      const after = input.value.slice(selEnd).replace(/^\s+/, "");
      let insertText = insert;
      if (before && /[0-9A-Za-z$)"]$/.test(before)) {
        insertText = "," + insertText;
      }
      if (after && /^[0-9A-Za-z$(]/.test(after) && !before.endsWith("(")) {
        insertText = insertText + ",";
      }
      input.setRangeText(insertText, caret, selEnd, "end");
      syncEditValue(input.value, input === el.formulaInput);
      input.focus();
      updateAutocomplete();
      updateRefHighlight();
      return;
    }
    if (td) {
      const c = Number(td.dataset.c);
      if (ev.shiftKey && f.anchor != null) {
        selectRange(f.anchor, r);
        f.activeCell = { r, c };
      } else if (ev.ctrlKey || ev.metaKey) {
        if (f.sel.has(r)) f.sel.delete(r);
        else f.sel.add(r);
        f.anchor = r;
        f.activeCell = { r, c };
      } else {
        f.sel.clear();
        f.sel.add(r);
        f.anchor = r;
        f.activeCell = { r, c };
      }
    } else if (rowEl.querySelector(".rownum") && ev.target.closest("td.rownum")) {
      if (ev.shiftKey && f.anchor != null) selectRange(f.anchor, r);
      else {
        f.sel.clear();
        f.sel.add(r);
        f.anchor = r;
        f.activeCell = { r, c: f.activeCell ? f.activeCell.c : 0 };
      }
    } else {
      return;
    }
    focusGrid();
    paintSelection();
    renderBatchBar();
    renderStatus();
  }

  function focusGrid() {
    try {
      el.gridWrap.focus({ preventScroll: true });
    } catch (err) {
      el.gridWrap.focus();
    }
    updateRefHighlight();
  }

  function onGridKeydown(ev) {
    if (state.editing) return;
    const f = active();
    if (!f) return;
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Backspace", "Enter", "F2", "Home", "End"];
    /* 直接输入可打印字符即开始编辑（WPS/Excel 习惯） */
    const isChar = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (!keys.includes(ev.key) && !isChar) return;
    if (isTextInput(ev.target)) return;
    if (!f.activeCell) {
      f.activeCell = { r: 0, c: 0 };
      f.sel.add(0);
    }
    ev.preventDefault();
    if (isChar) {
      startEdit(f.activeCell.r, f.activeCell.c, ev.key);
      return;
    }
    if (ev.key === "ArrowUp") moveActive(-1, 0);
    else if (ev.key === "ArrowDown") moveActive(1, 0);
    else if (ev.key === "ArrowLeft") moveActive(0, -1);
    else if (ev.key === "ArrowRight") moveActive(0, 1);
    else if (ev.key === "Enter" || ev.key === "F2") startEdit(f.activeCell.r, f.activeCell.c);
    else if (ev.key === "Home") {
      f.activeCell.c = 0;
      paintSelection();
    } else if (ev.key === "End") {
      f.activeCell.c = f.header.length - 1;
      paintSelection();
    }     else if (ev.key === "Delete" || ev.key === "Backspace") {
      if (f.sel.size) deleteSelectedRows();
      else clearActiveCell();
    }
  }

  function clearActiveCell() {
    const f = active();
    if (!f || !f.activeCell) return;
    const { r, c } = f.activeCell;
    if (f.rows[r][c] === "") return;
    pushUndo(f);
    f.rows[r][c] = "";
    markChanged(f);
    recomputeSearch(f, true);
    renderBody();
    renderFormulaBar();
    updateSearchCount();
    renderTabs();
    updateUndoButtons();
    renderToolbar();
  }

  function onGlobalKeydown(ev) {
    if (ev.key === "Escape") {
      if (contextMenu) {
        closeContextMenu();
        return;
      }
    if (!el.moreMenu.hidden || !el.exportMenu.hidden || !el.freezeMenu.hidden) {
        closeMoreMenu();
        return;
      }
      if (state.activeModal) {
        state.activeModal.close();
        return;
      }
      if (state.editing) {
        cancelEdit();
        return;
      }
      if (isTextInput(ev.target)) return;
      const f = active();
      if (f && f.sel.size) {
        f.sel.clear();
        f.anchor = null;
        paintSelection();
        renderBatchBar();
        renderStatus();
      }
      return;
    }
    if (state.activeModal) return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      if (state.editing) commitEdit();
      if (ev.shiftKey) saveAsActive();
      else saveActive();
      return;
    }
    if (ctrl && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      if (active()) el.searchInput.focus();
      return;
    }
    if (ctrl && ev.key.toLowerCase() === "a") {
      if (isTextInput(ev.target)) return;
      const f = active();
      if (!f) return;
      ev.preventDefault();
      f.sel = new Set(visibleRows(f));
      f.anchor = f.sel.size ? visibleRows(f)[0] : null;
      paintSelection();
      renderBatchBar();
      renderStatus();
      return;
    }
    if (isTextInput(ev.target) || state.editing) return;
    if (ctrl && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) redo();
      else undo();
      return;
    }
    if (ctrl && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      redo();
      return;
    }
    if (ctrl && ev.key.toLowerCase() === "c") return;
    if (ev.key === "Delete" && active() && active().sel.size) {
      ev.preventDefault();
      deleteSelectedRows();
    }
  }

  function onPaste(ev) {
    if (state.activeModal || state.editing || isTextInput(ev.target)) return;
    const f = active();
    if (!f || !f.activeCell) return;
    if (isFilteredView(f)) {
      toast("筛选状态下不能粘贴，请先取消“仅显示匹配行”", "error");
      return;
    }
    const text = ev.clipboardData && ev.clipboardData.getData("text/plain");
    if (!text) return;
    ev.preventDefault();
    pasteBlock(text);
  }

  function closeMoreMenu() {
    if (!el.moreMenu.hidden) el.moreMenu.hidden = true;
    if (!el.exportMenu.hidden) el.exportMenu.hidden = true;
    if (!el.freezeMenu.hidden) el.freezeMenu.hidden = true;
  }

  /* 列宽拖动 */
  function onResizeStart(ev) {
    const handle = ev.target.closest(".col-resize");
    if (!handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    const f = active();
    if (!f) return;
    const key = handle.dataset.col;
    const isNum = key === "num";
    const isCb = key === "cb";
    const col = isNum || isCb ? -1 : Number(key);
    const startX = ev.clientX;
    const startWidth = isNum ? (f.numW || 52) : isCb ? (f.cbW || 38) : f.widths[col];
    const minW = isNum ? 40 : isCb ? 30 : 56;
    const maxW = isNum ? 220 : isCb ? 160 : 420;
    const cols = el.colgroup.querySelectorAll("col");
    const colEl = cols[isNum ? 0 : isCb ? 1 : col + 2];
    const th = handle.closest("th");
    let moved = false;
    const onMove = (e) => {
      moved = true;
      const width = clamp(Math.round(startWidth + e.clientX - startX), minW, maxW);
      if (isNum) {
        f.numW = width;
        el.grid.style.setProperty("--num-w", width + "px");
      } else if (isCb) {
        f.cbW = width;
        el.grid.style.setProperty("--cb-w", width + "px");
      } else {
        f.widths[col] = width;
      }
      if (colEl) colEl.style.width = width + "px";
      if (th) th.style.width = width + "px";
      updateTableWidth(f);
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      document.body.style.cursor = "";
    };
    const onBlur = () => cleanup();
    const onUp = () => {
      cleanup();
      if (!moved) {
        if (isNum || isCb) {
          if (isNum) f.numW = 52;
          else f.cbW = 38;
          renderHeader(f);
          renderBody();
        } else if (f.rows.length) {
          // 双击列宽手柄：按内容自适应这一列
          let width = textWidth(f.header[col]) + 30;
          const limit = Math.min(f.rows.length, 400);
          for (let r = 0; r < limit; r++) width = Math.max(width, textWidth(f.rows[r][col]) + 26);
          f.widths[col] = clamp(Math.round(width), 66, 420);
          renderHeader(f);
          renderBody();
        }
      }
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur, { once: true });
  }

  function updateTableWidth(f) {
    const numW = clamp(Math.round(Number(f.numW) || 52), 40, 220);
    const cbW = clamp(Math.round(Number(f.cbW) || 38), 30, 160);
    const total = numW + cbW + f.widths.reduce((a, b) => a + b, 0);
    el.grid.style.width = Math.max(total, el.gridWrap.clientWidth - 2) + "px";
  }

  function assocAppName(progid) {
    const value = String(progid || "");
    const lower = value.toLowerCase();
    if (!lower) return "";
    if (lower.indexOf("excel.sheet") === 0) return "Excel";
    if (lower.indexOf("et.xlsx") === 0) return "WPS";
    if (lower.indexOf("chromehtml") === 0) return "Chrome";
    if (lower.indexOf("microsoftedgehtml") === 0) return "Edge";
    if (lower.indexOf("firefoxhtml") === 0) return "Firefox";
    if (lower.indexOf("applications\\") === 0) return value.split("\\").pop();
    return value;
  }

  async function applyAssoc(action, modal) {
    const exts = Array.from(modal.body.querySelectorAll(".assoc-item input:checked"))
      .map((box) => box.value);
    if (!exts.length) {
      toast("请先勾选文件类型");
      return false;
    }
    const res = await api("/api/assoc", { action, exts });
    if (action === "apply") {
      if (!res.changed || !res.changed.length) {
        toast("没有可关联的文件类型");
        return false;
      }
      if (res.needsConfirm && res.needsConfirm.length) {
        toast("已登记打开方式；Windows 需要在“默认应用”里确认后才能双击直接打开", "error");
      } else {
        toast("已关联：" + res.changed.join("、"));
      }
    } else {
      toast(res.removed && res.removed.length
        ? "已取消关联：" + res.removed.join("、")
        : "没有需要取消的关联");
    }
    return true;
  }

  async function openAssocDialog() {
    let data;
    try {
      data = await api("/api/assoc", { action: "status" });
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const labels = { ".xlsx": "Excel 表格", ".html": "网页表格（.html）", ".htm": "网页表格（.htm）" };
    const rows = (data.items || []).map((item) => {
      const stateText = item.isDefault ? "默认打开方式"
        : (item.inOpenWith ? "已加入“打开方式”" : "未关联");
      const other = item.effective && !item.isDefault
        ? `当前：${assocAppName(item.effective)}` : "";
      return `<label class="assoc-item">
          <input type="checkbox" value="${escAttr(item.ext)}" ${item.isDefault || item.inOpenWith ? "checked" : ""}>
          <span class="assoc-ext">${esc(item.ext)}</span>
          <span class="assoc-main">${esc(labels[item.ext] || item.ext)}</span>
          <span class="assoc-state">${esc(stateText)}${other ? " · " + esc(other) : ""}</span>
        </label>`;
    }).join("");
    const content = `<div class="assoc-list">${rows}</div>
      <div class="hint-box">关联后双击文件就能用本程序打开；程序已经在运行时只会切换到已打开的窗口。移动或重命名程序后，需要重新关联一次。Windows 10/11 如果已经给同类文件指定了其他程序，需要在系统“默认应用”里把打开方式改成“表格编辑器”才会生效。</div>`;
    const modal = showModal({
      title: "文件关联",
      content,
      width: "560px",
      buttons: [
        { label: "取消关联", onClick: () => applyAssoc("remove", modal) },
        {
          label: "系统默认应用",
          onClick: () => {
            api("/api/assoc", { action: "settings" }).catch(() => {});
            return false;
          },
        },
        { label: "关联所选", primary: true, onClick: () => applyAssoc("apply", modal) },
      ],
    });
  }

  function showHelp() {
    const backup = "%LOCALAPPDATA%\\表格编辑器\\备份";
    const content = `<div class="help-section">
        <h3>支持的格式</h3>
        <p>可直接打开 Excel / WPS 导出的网页表格（扩展名通常是 .xlsx 或 .html），也能打开标准 Excel 工作簿。保存时会沿用原文件的编码（GBK 或 UTF-8）和表格结构，适合继续被其他程序读取。工具栏“导出”可生成标准 Excel 表格或带计算结果的网页表格。</p>
        <p>每次保存前，原文件会自动备份到 ${esc(backup)}。</p>
      </div>
      <div class="help-section">
        <h3>批量与选择</h3>
        <p>点击行左侧复选框，或按住 Ctrl 点击行进行多选；按住 Shift 点击可连续选择。选中后可以批量修改、删除、去重、重新编号。</p>
        <p>表头上右键可以重命名、插入或删除列。单元格双击编辑，也可以从 Excel 复制多行多列后直接在表格中粘贴。</p>
        <p>选中公式单元格后点击“公式填充”，可批量应用到全部行或选中行；相对引用随行调整，绝对引用保持不变，新增行会自动套用。</p>
      </div>
      <div class="help-section">
        <h3>外观与历史</h3>
        <p>右上角月亮/太阳图标可切换浅色与深色主题，也支持跟随系统。主题弹窗里可以挑选或自定义强调色，设置会自动保存。</p>
        <p>“最近打开”保存最多 20 个文件记录，点击即可重新打开；文件被移动或删除时会标注“不存在”。</p>
      </div>
      <div class="help-section">
        <h3>双击打开文件</h3>
        <p>在资源管理器里双击 .xlsx 或 .html 表格，可以直接用本程序打开；本程序已经开着时，文件会交给当前窗口，不会重复启动。</p>
        <p><button type="button" class="btn small" id="help-assoc">管理文件关联</button></p>
      </div>
      <div class="help-section">
        <h3>公式与函数</h3>
        <p>在单元格里以等号开头输入公式，例如 <code>=B2*C2</code>、<code>=SUM(B2:B10)</code>、<code>=IF(D2&gt;=60,"及格","不及格")</code>，纯算式如 <code>=1*2</code> 也会直接算出结果。快速计算可直接输入 <code>1×2=</code>，输入等号后会预览结果，按回车把答案写入单元格；同时支持 ×、÷、全角括号和减号。列用 A、B、C 表示；行号与 Excel 一致，表头是第 1 行、第一条数据是第 2 行，支持 $A$1 形式的绝对引用。</p>
        <p>表格上方有 WPS 风格的公式栏：左侧名称框显示当前引用（输入如 B3 回车可跳转），右侧同步显示单元格内容，输入公式时输入建议会自动弹出（函数与单元格引用，方向键切换候选，Tab 或点击采纳，Esc 取消编辑）。单元格与公式栏是同一个编辑入口，焦点可互相转移。编辑公式时直接点击单元格可插入其引用，按住 Shift 点击第二个单元格则插入区域（如 C2:D5），适合 =SUM(C2,D5) 这类多单元格累加。</p>
        <p>常用函数：SUM、AVERAGE、COUNT、COUNTA、COUNTBLANK、MAX、MIN、MEDIAN、PRODUCT、ABS、INT、MOD、POWER、SQRT、ROUND、ROUNDUP、ROUNDDOWN、SIGN、IF、IFERROR、AND、OR、NOT、CONCAT、CONCATENATE、LEN、LEFT、RIGHT、MID、TRIM、UPPER、LOWER、FIND、SUBSTITUTE、COUNTIF、SUMIF、AVERAGEIF、VLOOKUP、TODAY、NOW、RAND、RANDBETWEEN、TEXT。</p>
        <p>保存为 .xlsx 时公式会原样保留，用 Excel/WPS 打开可继续计算；保存为 HTML 表格时公式会转换为计算结果。插入或删除行列、删除重复行时，公式里的引用会自动调整；数据修改后依赖它的公式会自动重算。</p>
      </div>
      <div class="help-section">
        <h3>默认模板</h3>
        <p>顶部“默认模板”可把当前已保存的文件设为模板，并可分别勾选“启动时自动打开”和“新建表格时使用”。模板始终以副本方式打开，源文件不会被覆盖；移动或删除模板后不会影响已打开的数据。</p>
      </div>
      <div class="help-section">
        <h3>筛选与冻结窗格</h3>
        <p>点击表头名称右侧的漏斗按钮，可以勾选要显示的值，支持输入关键字搜索；多列筛选会同时生效，再次点开可清除该列。工具栏的“清除筛选”一次取消全部列筛选。</p>
        <p>“冻结窗格”下拉菜单可固定首行、首列或同时固定两者；表头与行号始终固定，适合宽表对照。</p>
      </div>
      <div class="help-section">
        <h3>快捷键</h3>
        <div class="help-list">
          <div class="help-item"><span>保存</span><kbd>Ctrl + S</kbd></div>
          <div class="help-item"><span>另存为</span><kbd>Ctrl + Shift + S</kbd></div>
          <div class="help-item"><span>撤销 / 重做</span><kbd>Ctrl + Z / Ctrl + Y</kbd></div>
          <div class="help-item"><span>查找</span><kbd>Ctrl + F</kbd></div>
          <div class="help-item"><span>编辑当前单元格</span><kbd>Enter / F2</kbd></div>
          <div class="help-item"><span>直接提交（不移动）</span><kbd>Ctrl + Enter</kbd></div>
          <div class="help-item"><span>采纳公式补全候选</span><kbd>Tab</kbd></div>
          <div class="help-item"><span>补全候选切换</span><kbd>↑ / ↓</kbd></div>
          <div class="help-item"><span>移动当前单元格</span><kbd>方向键</kbd></div>
          <div class="help-item"><span>全选当前显示行</span><kbd>Ctrl + A</kbd></div>
          <div class="help-item"><span>删除选中行</span><kbd>Delete</kbd></div>
        </div>
      </div>`;
    const modal = showModal({
      title: "使用说明",
      content,
      width: "600px",
      buttons: [{ label: "知道了", primary: true }],
    });
    const assocBtn = modal.body.querySelector("#help-assoc");
    if (assocBtn) {
      assocBtn.addEventListener("click", () => {
        modal.close();
        openAssocDialog();
      });
    }
  }

  async function openStartupTemplate() {
    try {
      const pending = await api("/api/pending", {});
      if (pending.paths && pending.paths.length) {
        await openPaths(pending.paths);
        return;
      }
      const template = state.settings.template;
      if (!template || !template.openOnStart || !template.path || state.files.length) return;
      if (!template.exists) {
        toast("默认模板文件不存在，请在“默认模板”中重新设置", "error");
        return;
      }
      await openTemplate(template.path);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* 启动 */
  function init() {
    const params = new URLSearchParams(location.search);
    state.token = params.get("token") || "";
    if (state.token) {
      try {
        history.replaceState(null, "", location.pathname);
      } catch (err) {}
    }
    window.__sheetHasUnsavedChanges = () => state.files.some((f) => f.dirty) || hasPendingEdit();
    state.theme = loadTheme();
    applyTheme();
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => { if (state.theme.mode === "system") applyTheme(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
    bindEvents();
    el.empty.hidden = false;
    el.gridWrap.hidden = true;
    el.statusPath.textContent = "就绪";
    el.statusPath.title = "";
    el.searchInput.disabled = true;
    el.searchScope.disabled = true;
    api("/api/ping", {}).catch((err) => toast(err.message, "error"));
    loadSettings().then(() => {
      refreshHistory();
      openStartupTemplate();
    });
    setInterval(pollPendingOpens, 1200);
    window.addEventListener("focus", pollPendingOpens);
    if (params.get("dev") === "1") {
      window.__sheetDev = {
        openPaths,
        openTemplate,
        setFreezeMode,
        state,
        activate,
        saveFile,
        undo,
        redo,
        startEdit,
        insertRow,
        selectRange,
        closeFile,
        openBatchEdit,
        openDedupe,
        openFormulaFill,
        pasteBlock,
      };
    }
  }

  init();
})();
