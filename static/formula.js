/* 表格编辑器公式引擎：A1 引用、区域、运算符与常用 WPS/Excel 函数。 */
(function (root) {
  "use strict";

  const ERR = {
    DIV0: "#DIV/0!",
    VALUE: "#VALUE!",
    NAME: "#NAME?",
    REF: "#REF!",
    NUM: "#NUM!",
    NA: "#N/A",
    CIRC: "#CIRC!",
  };

  class FormulaError {
    constructor(code) {
      this.code = code;
    }
    toString() {
      return this.code;
    }
  }

  const error = (code) => new FormulaError(code);
  const isError = (v) => v instanceof FormulaError;

  const REF_RE = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/;
  const MAX_CELLS = 200000;

  function colLetter(index) {
    let n = Number(index);
    if (!Number.isInteger(n) || n < 0) return "";
    let s = "";
    n += 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function colIndex(letters) {
    const s = String(letters || "").toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(s)) return -1;
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function refOfToken(tk) {
    if (!tk || tk.t !== "ident") return null;
    const m = REF_RE.exec(tk.raw);
    if (!m) return null;
    const col = colIndex(m[1]);
    const row = parseInt(m[2], 10) - 1;
    if (col < 0 || row < 0) return null;
    return { row, col };
  }

  function fmtNumber(v) {
    if (!isFinite(v)) return String(v);
    if (Object.is(v, -0)) v = 0;
    if (Number.isInteger(v)) return String(v);
    const s = parseFloat(v.toPrecision(12)).toString();
    return s;
  }

  function toText(v) {
    if (isError(v)) return v;
    if (v === true) return "TRUE";
    if (v === false) return "FALSE";
    if (v == null) return "";
    if (typeof v === "number") return fmtNumber(v);
    return String(v);
  }

  function toNumber(v) {
    if (isError(v)) return v;
    if (typeof v === "number") return v;
    if (v === true) return 1;
    if (v === false) return 0;
    if (v == null) return 0;
    const s = String(v).trim();
    if (!s) return 0;
    const n = Number(s);
    return isFinite(n) ? n : error(ERR.VALUE);
  }

  function numOf(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v === true) return 1;
    if (v === false) return 0;
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function truthy(v) {
    if (isError(v)) return v;
    if (v === true) return true;
    if (v === false) return false;
    if (v == null) return false;
    if (typeof v === "number") return v !== 0;
    const s = String(v).trim().toUpperCase();
    if (!s) return false;
    if (s === "TRUE") return true;
    if (s === "FALSE") return false;
    const n = Number(s);
    if (isFinite(n)) return n !== 0;
    return error(ERR.VALUE);
  }

  function compareValues(a, b) {
    if (isError(a)) return a;
    if (isError(b)) return b;
    const an = numOf(a);
    const bn = numOf(b);
    if (an != null && bn != null) return an === bn ? 0 : (an < bn ? -1 : 1);
    const as = String(toText(a)).toLowerCase();
    const bs = String(toText(b)).toLowerCase();
    return as === bs ? 0 : (as < bs ? -1 : 1);
  }

  function tokenize(src, strict = true) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let val = "";
        while (j < n) {
          if (src[j] === '"') {
            if (src[j + 1] === '"') {
              val += '"';
              j += 2;
              continue;
            }
            break;
          }
          val += src[j++];
        }
        if (j >= n) throw error(ERR.VALUE);
        tokens.push({ t: "str", v: val, raw: src.slice(i, j + 1), pos: i });
        i = j + 1;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
        const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        tokens.push({ t: "num", v: Number(m[0]), raw: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
        tokens.push({ t: "ident", v: m[0], raw: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      if (ch === "(") {
        tokens.push({ t: "lp", raw: ch, pos: i });
        i++;
        continue;
      }
      if (ch === ")") {
        tokens.push({ t: "rp", raw: ch, pos: i });
        i++;
        continue;
      }
      if (ch === "," || ch === ";") {
        tokens.push({ t: "comma", raw: ch, pos: i });
        i++;
        continue;
      }
      if (ch === ":") {
        tokens.push({ t: "colon", raw: ch, pos: i });
        i++;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>") {
        tokens.push({ t: "op", v: two, raw: two, pos: i });
        i += 2;
        continue;
      }
      if ("+-*/^%&=<>".includes(ch)) {
        tokens.push({ t: "op", v: ch, raw: ch, pos: i });
        i++;
        continue;
      }
      if (strict) throw error(ERR.VALUE);
      tokens.push({ t: "raw", raw: ch, pos: i });
      i++;
    }
    return tokens;
  }

  /* 解析公式里的全部单元格引用（供界面高亮）：
     返回 [{ text, start, end, r1, c1, r2, c2, range }]，行列是公式空间（第 0 行为表头）。 */
  function parseRefs(src) {
    let tokens;
    try {
      tokens = tokenize(String(src == null ? "" : src), false);
    } catch (exc) {
      return [];
    }
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const ref = refOfToken(tk);
      if (!ref) continue;
      const next = tokens[i + 1];
      const next2 = tokens[i + 2];
      if (next && next.t === "lp") continue; /* SUM( 之类的函数名 */
      if (next && next.t === "colon" && next2 && refOfToken(next2)) {
        const b = refOfToken(next2);
        out.push({
          text: src.slice(tk.pos, next2.pos + next2.raw.length),
          start: tk.pos,
          end: next2.pos + next2.raw.length,
          r1: Math.min(ref.row, b.row),
          c1: Math.min(ref.col, b.col),
          r2: Math.max(ref.row, b.row),
          c2: Math.max(ref.col, b.col),
          range: true,
        });
        i += 2;
        continue;
      }
      out.push({
        text: tk.raw,
        start: tk.pos,
        end: tk.pos + tk.raw.length,
        r1: ref.row,
        c1: ref.col,
        r2: ref.row,
        c2: ref.col,
        range: false,
      });
    }
    return out;
  }

  const PARSE_CACHE = new Map();
  const PARSE_CACHE_LIMIT = 1000;

  function parse(src) {
    const cached = PARSE_CACHE.get(src);
    if (cached) return cached;
    const tokens = tokenize(src);
    let pos = 0;
    const peek = (k) => tokens[pos + (k || 0)];
    const take = () => tokens[pos++];

    function parseCompare() {
      let node = parseConcat();
      while (peek() && peek().t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v)) {
        const op = take().v;
        node = { t: "bin", op, l: node, r: parseConcat() };
      }
      return node;
    }

    function parseConcat() {
      let node = parseAdd();
      while (peek() && peek().t === "op" && peek().v === "&") {
        take();
        node = { t: "bin", op: "&", l: node, r: parseAdd() };
      }
      return node;
    }

    function parseAdd() {
      let node = parseMul();
      while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
        const op = take().v;
        node = { t: "bin", op, l: node, r: parseMul() };
      }
      return node;
    }

    function parseMul() {
      let node = parsePow();
      while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
        const op = take().v;
        node = { t: "bin", op, l: node, r: parsePow() };
      }
      return node;
    }

    function parsePow() {
      let node = parseUnary();
      while (peek() && peek().t === "op" && peek().v === "^") {
        take();
        node = { t: "bin", op: "^", l: node, r: parseUnary() };
      }
      return node;
    }

    function parseUnary() {
      const tk = peek();
      if (tk && tk.t === "op" && (tk.v === "-" || tk.v === "+")) {
        take();
        return { t: "un", op: tk.v, x: parseUnary() };
      }
      return parsePostfix();
    }

    function parsePostfix() {
      let node = parsePrimary();
      while (peek() && peek().t === "op" && peek().v === "%") {
        take();
        node = { t: "un", op: "%", x: node };
      }
      return node;
    }

    function parseArgs() {
      const args = [];
      if (peek() && peek().t === "rp") {
        take();
        return args;
      }
      while (true) {
        if (!peek() || peek().t === "rp" || peek().t === "comma") args.push({ t: "empty" });
        else args.push(parseCompare());
        if (!peek()) throw error(ERR.VALUE);
        if (peek().t === "rp") {
          take();
          return args;
        }
        if (peek().t !== "comma") throw error(ERR.VALUE);
        take();
      }
    }

    function parsePrimary() {
      const tk = take();
      if (!tk) throw error(ERR.VALUE);
      if (tk.t === "num") return { t: "num", v: tk.v };
      if (tk.t === "str") return { t: "str", v: tk.v };
      if (tk.t === "lp") {
        const node = parseCompare();
        if (!peek() || peek().t !== "rp") throw error(ERR.VALUE);
        take();
        return node;
      }
      if (tk.t === "ident") {
        const upper = tk.v.toUpperCase();
        if (upper === "TRUE") return { t: "bool", v: true };
        if (upper === "FALSE") return { t: "bool", v: false };
        if (peek() && peek().t === "lp") {
          take();
          return { t: "func", name: upper, args: parseArgs() };
        }
        const a = refOfToken(tk);
        if (!a) return { t: "name", v: tk.v };
        if (peek() && peek().t === "colon") {
          const btk = peek(1);
          const b = refOfToken(btk);
          if (!b) throw error(ERR.VALUE);
          take();
          take();
          return {
            t: "range",
            r1: Math.min(a.row, b.row),
            c1: Math.min(a.col, b.col),
            r2: Math.max(a.row, b.row),
            c2: Math.max(a.col, b.col),
          };
        }
        return { t: "ref", row: a.row, col: a.col };
      }
      throw error(ERR.VALUE);
    }

    const ast = parseCompare();
    if (pos !== tokens.length) throw error(ERR.VALUE);
    if (PARSE_CACHE.size >= PARSE_CACHE_LIMIT) {
      const oldest = PARSE_CACHE.keys().next().value;
      if (oldest !== undefined) PARSE_CACHE.delete(oldest);
    }
    PARSE_CACHE.set(src, ast);
    return ast;
  }

  class RangeValue {
    constructor(r1, c1, r2, c2) {
      this.r1 = r1;
      this.c1 = c1;
      this.r2 = r2;
      this.c2 = c2;
    }
  }

  function rangeSize(range) {
    return (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
  }

  function rangeValues(range, ctx) {
    if (rangeSize(range) > MAX_CELLS) return error(ERR.NUM);
    const out = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) out.push(ctx.get(r, c));
    }
    return out;
  }

  function evalNode(node, ctx) {
    switch (node.t) {
      case "empty":
        return "";
      case "num":
        return node.v;
      case "str":
        return node.v;
      case "bool":
        return node.v;
      case "name":
        return error(ERR.NAME);
      case "ref":
        return ctx.get(node.row, node.col);
      case "range":
        return new RangeValue(node.r1, node.c1, node.r2, node.c2);
      case "un": {
        const v = evalNode(node.x, ctx);
        if (isError(v)) return v;
        if (node.op === "%") {
          const n = toNumber(v);
          return isError(n) ? n : n / 100;
        }
        const n = toNumber(v);
        if (isError(n)) return n;
        return node.op === "-" ? -n : n;
      }
      case "bin":
        return evalBinary(node, ctx);
      case "func": {
        if (node.name === "IF") return fnIf(node.args, ctx);
        if (node.name === "IFERROR") return fnIfError(node.args, ctx);
        if (node.name === "AND") return fnAndOr(node.args, ctx, true);
        if (node.name === "OR") return fnAndOr(node.args, ctx, false);
        const fn = FUNCS[node.name];
        if (!fn) return error(ERR.NAME);
        return fn(node.args, ctx);
      }
      default:
        return error(ERR.VALUE);
    }
  }

  function evalBinary(node, ctx) {
    const a = evalNode(node.l, ctx);
    if (isError(a)) return a;
    const b = evalNode(node.r, ctx);
    if (isError(b)) return b;
    switch (node.op) {
      case "+":
      case "-":
      case "*":
      case "/":
      case "^": {
        const x = toNumber(a);
        if (isError(x)) return x;
        const y = toNumber(b);
        if (isError(y)) return y;
        if (node.op === "+") return x + y;
        if (node.op === "-") return x - y;
        if (node.op === "*") return x * y;
        if (node.op === "/") return y === 0 ? error(ERR.DIV0) : x / y;
        const p = Math.pow(x, y);
        return isFinite(p) ? p : error(ERR.NUM);
      }
      case "&":
        return String(toText(a)) + String(toText(b));
      case "=":
        return compareValues(a, b) === 0;
      case "<>":
        return compareValues(a, b) !== 0;
      case "<":
        return compareValues(a, b) < 0;
      case ">":
        return compareValues(a, b) > 0;
      case "<=":
        return compareValues(a, b) <= 0;
      case ">=":
        return compareValues(a, b) >= 0;
      default:
        return error(ERR.VALUE);
    }
  }

  function flatten(args, ctx) {
    const list = [];
    for (const arg of args) {
      const v = evalNode(arg, ctx);
      if (v instanceof RangeValue) {
        const cells = rangeValues(v, ctx);
        if (isError(cells)) return { err: cells };
        for (const cell of cells) list.push(cell);
      } else {
        list.push(v);
      }
    }
    return { list };
  }

  function numbersOf(args, ctx) {
    const flat = flatten(args, ctx);
    if (flat.err) return { err: flat.err };
    const nums = [];
    for (const v of flat.list) {
      if (isError(v)) return { err: v };
      if (v instanceof RangeValue) continue;
      const n = numOf(v);
      if (n != null) nums.push(n);
    }
    return { nums };
  }

  function oneNumber(args, ctx, index) {
    const node = args[index];
    if (!node) return 0;
    const v = evalNode(node, ctx);
    if (v instanceof RangeValue) return error(ERR.VALUE);
    return toNumber(v);
  }

  function oneText(args, ctx, index) {
    const node = args[index];
    if (!node) return "";
    const v = evalNode(node, ctx);
    if (v instanceof RangeValue) return error(ERR.VALUE);
    if (isError(v)) return v;
    return String(toText(v));
  }

  function roundTo(v, digits, mode) {
    const d = Math.trunc(digits);
    const f = Math.pow(10, d);
    if (!isFinite(f)) return v;
    const x = Math.abs(v) * f;
    let r;
    if (mode === "up") r = Math.ceil(x - 1e-9);
    else if (mode === "down") r = Math.floor(x + 1e-9);
    else r = Math.floor(x + 0.5 + 1e-9);
    return (v < 0 ? -r : r) / f;
  }

  function fnIf(args, ctx) {
    if (!args.length) return error(ERR.VALUE);
    const cond = truthy(evalNode(args[0], ctx));
    if (isError(cond)) return cond;
    if (cond) return args[1] ? evalNode(args[1], ctx) : true;
    return args[2] ? evalNode(args[2], ctx) : false;
  }

  function fnIfError(args, ctx) {
    if (args.length < 2) return error(ERR.VALUE);
    const v = evalNode(args[0], ctx);
    return isError(v) ? evalNode(args[1], ctx) : v;
  }

  function fnAndOr(args, ctx, isAnd) {
    const flat = flatten(args, ctx);
    if (flat.err) return flat.err;
    let has = false;
    for (const v of flat.list) {
      if (isError(v)) return v;
      if (v === "" || v == null) continue;
      const b = truthy(v);
      if (isError(b)) return b;
      has = true;
      if (isAnd && !b) return false;
      if (!isAnd && b) return true;
    }
    return has ? isAnd : !isAnd;
  }

  function matchCriteria(crit) {
    if (isError(crit)) return () => false;
    if (typeof crit === "number") return (v) => compareValues(v, crit) === 0;
    let s = String(crit == null ? "" : crit).trim();
    let op = "=";
    const m = /^(<=|>=|<>|=|<|>)([\s\S]*)$/.exec(s);
    if (m) {
      op = m[1];
      s = m[2].trim();
    }
    if ((op === "=" || op === "<>") && /[*?]/.test(s)) {
      const escaped = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      const re = new RegExp("^" + escaped + "$", "i");
      return (v) => {
        if (isError(v)) return false;
        const ok = re.test(String(toText(v)));
        return op === "=" ? ok : !ok;
      };
    }
    const target = s === "" ? "" : s;
    const targetNum = target === "" ? null : numOf(target);
    return (v) => {
      if (isError(v)) return false;
      if (targetNum != null) {
        const n = numOf(v);
        if (n == null) return op === "<>";
        return compareNumbers(n, targetNum, op);
      }
      const a = String(toText(v)).toLowerCase();
      const b = target.toLowerCase();
      return compareTexts(a, b, op);
    };
  }

  function compareNumbers(a, b, op) {
    if (op === "=") return a === b;
    if (op === "<>") return a !== b;
    if (op === "<") return a < b;
    if (op === ">") return a > b;
    if (op === "<=") return a <= b;
    return a >= b;
  }

  function compareTexts(a, b, op) {
    if (op === "=") return a === b;
    if (op === "<>") return a !== b;
    if (op === "<") return a < b;
    if (op === ">") return a > b;
    if (op === "<=") return a <= b;
    return a >= b;
  }

  const FUNCS = {
    SUM(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      return r.nums.reduce((a, b) => a + b, 0);
    },
    AVERAGE(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      if (!r.nums.length) return error(ERR.DIV0);
      return r.nums.reduce((a, b) => a + b, 0) / r.nums.length;
    },
    COUNT(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      return r.nums.length;
    },
    COUNTA(args, ctx) {
      const flat = flatten(args, ctx);
      if (flat.err) return flat.err;
      let n = 0;
      for (const v of flat.list) {
        if (v === "" || v == null) continue;
        n++;
      }
      return n;
    },
    COUNTBLANK(args, ctx) {
      const flat = flatten(args, ctx);
      if (flat.err) return flat.err;
      let n = 0;
      for (const v of flat.list) {
        if (v === "" || v == null) n++;
      }
      return n;
    },
    MAX(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      let result = -Infinity;
      for (const n of r.nums) if (n > result) result = n;
      return result === -Infinity ? 0 : result;
    },
    MIN(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      let result = Infinity;
      for (const n of r.nums) if (n < result) result = n;
      return result === Infinity ? 0 : result;
    },
    MEDIAN(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      const arr = r.nums.slice().sort((a, b) => a - b);
      if (!arr.length) return error(ERR.NUM);
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    },
    PRODUCT(args, ctx) {
      const r = numbersOf(args, ctx);
      if (r.err) return r.err;
      if (!r.nums.length) return 0;
      return r.nums.reduce((a, b) => a * b, 1);
    },
    ABS(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      return isError(n) ? n : Math.abs(n);
    },
    INT(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      return isError(n) ? n : Math.floor(n);
    },
    SIGN(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      return isError(n) ? n : Math.sign(n);
    },
    MOD(args, ctx) {
      const a = oneNumber(args, ctx, 0);
      if (isError(a)) return a;
      const b = oneNumber(args, ctx, 1);
      if (isError(b)) return b;
      if (b === 0) return error(ERR.DIV0);
      return a - b * Math.floor(a / b);
    },
    POWER(args, ctx) {
      const a = oneNumber(args, ctx, 0);
      if (isError(a)) return a;
      const b = oneNumber(args, ctx, 1);
      if (isError(b)) return b;
      const v = Math.pow(a, b);
      return isFinite(v) ? v : error(ERR.NUM);
    },
    SQRT(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      if (isError(n)) return n;
      return n < 0 ? error(ERR.NUM) : Math.sqrt(n);
    },
    ROUND(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      if (isError(n)) return n;
      const d = oneNumber(args, ctx, 1);
      return isError(d) ? d : roundTo(n, d, "half");
    },
    ROUNDUP(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      if (isError(n)) return n;
      const d = oneNumber(args, ctx, 1);
      return isError(d) ? d : roundTo(n, d, "up");
    },
    ROUNDDOWN(args, ctx) {
      const n = oneNumber(args, ctx, 0);
      if (isError(n)) return n;
      const d = oneNumber(args, ctx, 1);
      return isError(d) ? d : roundTo(n, d, "down");
    },
    CONCAT(args, ctx) {
      const flat = flatten(args, ctx);
      if (flat.err) return flat.err;
      let out = "";
      for (const v of flat.list) {
        if (isError(v)) return v;
        out += String(toText(v));
      }
      return out;
    },
    LEN(args, ctx) {
      const s = oneText(args, ctx, 0);
      return isError(s) ? s : s.length;
    },
    LEFT(args, ctx) {
      const s = oneText(args, ctx, 0);
      if (isError(s)) return s;
      const n = args[1] ? oneNumber(args, ctx, 1) : 1;
      if (isError(n)) return n;
      return s.slice(0, Math.max(0, Math.trunc(n)));
    },
    RIGHT(args, ctx) {
      const s = oneText(args, ctx, 0);
      if (isError(s)) return s;
      const n = args[1] ? oneNumber(args, ctx, 1) : 1;
      if (isError(n)) return n;
      const k = Math.max(0, Math.trunc(n));
      return k ? s.slice(-k) : "";
    },
    MID(args, ctx) {
      const s = oneText(args, ctx, 0);
      if (isError(s)) return s;
      const start = oneNumber(args, ctx, 1);
      if (isError(start)) return start;
      const len = oneNumber(args, ctx, 2);
      if (isError(len)) return len;
      if (start < 1 || len < 0) return error(ERR.VALUE);
      return s.substr(Math.trunc(start) - 1, Math.trunc(len));
    },
    TRIM(args, ctx) {
      const s = oneText(args, ctx, 0);
      return isError(s) ? s : s.trim().replace(/\s+/g, " ");
    },
    UPPER(args, ctx) {
      const s = oneText(args, ctx, 0);
      return isError(s) ? s : s.toUpperCase();
    },
    LOWER(args, ctx) {
      const s = oneText(args, ctx, 0);
      return isError(s) ? s : s.toLowerCase();
    },
    FIND(args, ctx) {
      const needle = oneText(args, ctx, 0);
      if (isError(needle)) return needle;
      const hay = oneText(args, ctx, 1);
      if (isError(hay)) return hay;
      const start = args[2] ? oneNumber(args, ctx, 2) : 1;
      if (isError(start)) return start;
      const idx = hay.indexOf(needle, Math.max(0, Math.trunc(start) - 1));
      return idx < 0 ? error(ERR.VALUE) : idx + 1;
    },
    SUBSTITUTE(args, ctx) {
      const s = oneText(args, ctx, 0);
      if (isError(s)) return s;
      const oldText = oneText(args, ctx, 1);
      if (isError(oldText)) return oldText;
      const newText = oneText(args, ctx, 2);
      if (isError(newText)) return newText;
      if (!oldText) return s;
      if (!args[3]) return s.split(oldText).join(newText);
      const which = oneNumber(args, ctx, 3);
      if (isError(which)) return which;
      let count = 0;
      let pos = 0;
      let out = "";
      while (true) {
        const idx = s.indexOf(oldText, pos);
        if (idx < 0) return out + s.slice(pos);
        count++;
        if (count === Math.trunc(which)) return out + s.slice(pos, idx) + newText + s.slice(idx + oldText.length);
        out += s.slice(pos, idx) + oldText;
        pos = idx + oldText.length;
      }
    },
    COUNTIF(args, ctx) {
      if (args.length < 2) return error(ERR.VALUE);
      const range = evalNode(args[0], ctx);
      if (!(range instanceof RangeValue)) return error(ERR.VALUE);
      const crit = evalNode(args[1], ctx);
      if (isError(crit)) return crit;
      const cells = rangeValues(range, ctx);
      if (isError(cells)) return cells;
      const match = matchCriteria(crit);
      let n = 0;
      for (const v of cells) if (match(v)) n++;
      return n;
    },
    SUMIF(args, ctx) {
      if (args.length < 2) return error(ERR.VALUE);
      const range = evalNode(args[0], ctx);
      if (!(range instanceof RangeValue)) return error(ERR.VALUE);
      const crit = evalNode(args[1], ctx);
      if (isError(crit)) return crit;
      const cells = rangeValues(range, ctx);
      if (isError(cells)) return cells;
      const sumRange = args[2] ? evalNode(args[2], ctx) : range;
      if (!(sumRange instanceof RangeValue)) return error(ERR.VALUE);
      const sums = rangeValues(sumRange, ctx);
      if (isError(sums)) return sums;
      if (sums.length !== cells.length) return error(ERR.VALUE);
      const match = matchCriteria(crit);
      let total = 0;
      for (let i = 0; i < cells.length; i++) {
        if (!match(cells[i])) continue;
        const n = numOf(sums[i]);
        if (n != null) total += n;
      }
      return total;
    },
    AVERAGEIF(args, ctx) {
      if (args.length < 2) return error(ERR.VALUE);
      const range = evalNode(args[0], ctx);
      if (!(range instanceof RangeValue)) return error(ERR.VALUE);
      const crit = evalNode(args[1], ctx);
      if (isError(crit)) return crit;
      const cells = rangeValues(range, ctx);
      if (isError(cells)) return cells;
      const avgRange = args[2] ? evalNode(args[2], ctx) : range;
      if (!(avgRange instanceof RangeValue)) return error(ERR.VALUE);
      const values = rangeValues(avgRange, ctx);
      if (isError(values)) return values;
      if (values.length !== cells.length) return error(ERR.VALUE);
      const match = matchCriteria(crit);
      let total = 0;
      let count = 0;
      for (let i = 0; i < cells.length; i++) {
        if (!match(cells[i])) continue;
        const n = numOf(values[i]);
        if (n != null) {
          total += n;
          count++;
        }
      }
      return count ? total / count : error(ERR.DIV0);
    },
    VLOOKUP(args, ctx) {
      if (args.length < 3) return error(ERR.VALUE);
      const target = evalNode(args[0], ctx);
      if (isError(target)) return target;
      const range = evalNode(args[1], ctx);
      if (!(range instanceof RangeValue)) return error(ERR.VALUE);
      const index = oneNumber(args, ctx, 2);
      if (isError(index)) return index;
      const cols = range.c2 - range.c1 + 1;
      const col = Math.trunc(index);
      if (col < 1 || col > cols) return error(ERR.REF);
      const approx = args[3] ? truthy(evalNode(args[3], ctx)) : true;
      if (isError(approx)) return approx;
      const rows = range.r2 - range.r1 + 1;
      let best = null;
      for (let i = 0; i < rows; i++) {
        const key = ctx.get(range.r1 + i, range.c1);
        if (isError(key)) return key;
        const cmp = compareValues(key, target);
        if (cmp === 0) return ctx.get(range.r1 + i, range.c1 + col - 1);
        if (approx && cmp < 0) best = i;
        if (!approx && cmp > 0) break;
      }
      if (approx && best != null) return ctx.get(range.r1 + best, range.c1 + col - 1);
      return error(ERR.NA);
    },
    IFERROR(args, ctx) {
      return fnIfError(args, ctx);
    },
    AND(args, ctx) {
      return fnAndOr(args, ctx, true);
    },
    OR(args, ctx) {
      return fnAndOr(args, ctx, false);
    },
    NOT(args, ctx) {
      const b = truthy(evalNode(args[0] || { t: "empty" }, ctx));
      return isError(b) ? b : !b;
    },
    TEXT(args, ctx) {
      const value = evalNode(args[0] || { t: "empty" }, ctx);
      if (isError(value)) return value;
      const fmt = oneText(args, ctx, 1);
      if (isError(fmt)) return fmt;
      if (typeof value !== "number") return String(toText(value));
      const decimals = /0\.(0+)/.exec(fmt);
      const digits = decimals ? decimals[1].length : 0;
      let out = value.toFixed(digits);
      if (fmt.indexOf("#,##0") >= 0) {
        const parts = out.split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        out = parts.join(".");
      }
      if (fmt.indexOf("%") >= 0) out = (value * 100).toFixed(digits) + "%";
      return out;
    },
    TODAY() {
      const d = new Date();
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    },
    NOW() {
      const d = new Date();
      const date = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
      const time = [String(d.getHours()).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"), String(d.getSeconds()).padStart(2, "0")].join(":");
      return date + " " + time;
    },
    RAND() {
      return Math.random();
    },
    RANDBETWEEN(args, ctx) {
      const lo = Math.ceil(oneNumber(args, ctx, 0));
      if (isError(lo)) return lo;
      const hi = Math.floor(oneNumber(args, ctx, 1));
      if (isError(hi)) return hi;
      if (lo > hi) return error(ERR.NUM);
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    },
  };

  // CONCATENATE 与 CONCAT 等价
  FUNCS.CONCATENATE = FUNCS.CONCAT;

  /* 函数签名与说明（自动补全提示用） */
  const SIGNATURES = {
    SUM: "SUM(数值1, [数值2], …) 计算所有数值的总和",
    AVERAGE: "AVERAGE(数值1, [数值2], …) 计算算术平均值",
    MAX: "MAX(数值1, [数值2], …) 返回最大值",
    MIN: "MIN(数值1, [数值2], …) 返回最小值",
    IF: "IF(条件, 条件成立时的值, [不成立时的值]) 条件判断",
    IFERROR: "IFERROR(值, 出错时的值) 捕获公式错误",
    AND: "AND(条件1, [条件2], …) 所有条件为真返回 TRUE",
    OR: "OR(条件1, [条件2], …) 任一条件为真返回 TRUE",
    NOT: "NOT(条件) 对逻辑值取反",
    COUNT: "COUNT(区域) 统计数值个数",
    COUNTA: "COUNTA(区域) 统计非空单元格个数",
    COUNTBLANK: "COUNTBLANK(区域) 统计空单元格个数",
    COUNTIF: "COUNTIF(区域, 条件) 按条件统计个数",
    SUMIF: "SUMIF(区域, 条件, [求和区域]) 按条件求和",
    AVERAGEIF: "AVERAGEIF(区域, 条件, [求平均区域]) 按条件求平均",
    VLOOKUP: "VLOOKUP(查找值, 区域, 返回列号, [精确匹配FALSE]) 纵向查找",
    MEDIAN: "MEDIAN(数值1, …) 返回中位数",
    PRODUCT: "PRODUCT(数值1, …) 计算所有数值的乘积",
    ABS: "ABS(数值) 返回绝对值",
    INT: "INT(数值) 向下取整",
    SIGN: "SIGN(数值) 返回 1、0 或 -1",
    MOD: "MOD(被除数, 除数) 返回两数相除的余数",
    POWER: "POWER(底数, 指数) 计算乘幂",
    SQRT: "SQRT(数值) 返回正平方根",
    ROUND: "ROUND(数值, 小数位数) 四舍五入",
    ROUNDUP: "ROUNDUP(数值, 小数位数) 向上舍入",
    ROUNDDOWN: "ROUNDDOWN(数值, 小数位数) 向下舍入",
    CONCAT: "CONCAT(文本1, …) 连接多个文本",
    CONCATENATE: "CONCATENATE(文本1, …) 连接多个文本",
    LEN: "LEN(文本) 返回文本字符数",
    LEFT: "LEFT(文本, [字符数]) 从左侧截取文本",
    RIGHT: "RIGHT(文本, [字符数]) 从右侧截取文本",
    MID: "MID(文本, 起始位置, 字符数) 截取中间文本",
    TRIM: "TRIM(文本) 去除首尾及多余空格",
    UPPER: "UPPER(文本) 转为大写",
    LOWER: "LOWER(文本) 转为小写",
    FIND: "FIND(查找文本, 文本, [起始位置]) 查找位置（区分大小写）",
    SUBSTITUTE: "SUBSTITUTE(文本, 旧文本, 新文本, [替换序号]) 替换文本",
    TEXT: "TEXT(数值, 格式) 按格式转为文本",
    TODAY: "TODAY() 返回当前日期",
    NOW: "NOW() 返回当前日期和时间",
    RAND: "RAND() 返回 0 到 1 之间的随机数",
    RANDBETWEEN: "RANDBETWEEN(最小值, 最大值) 返回区间内随机整数",
  };

  function normalizeSource(formula) {
    return String(formula == null ? "" : formula)
      .trim()
      .replace(/^[=＝]/, "")
      .replace(/[×✖]/g, "*")
      .replace(/÷/g, "/")
      .replace(/[−–—]/g, "-")
      .replace(/（/g, "(")
      .replace(/）/g, ")");
  }

  function evaluate(formula, refs) {
    const src = normalizeSource(formula);
    if (!src.trim()) return "";
    if (src.length > 8192) return error(ERR.VALUE);
    try {
      const ast = parse(src);
      const ctx = {
        get(row, col) {
          if (!refs || typeof refs.get !== "function") return "";
          return refs.get(row, col);
        },
      };
      const value = evalNode(ast, ctx);
      return value instanceof RangeValue ? error(ERR.VALUE) : value;
    } catch (exc) {
      return isError(exc) ? exc : error(ERR.VALUE);
    }
  }

  function quickEvaluate(input) {
    const raw = String(input == null ? "" : input).trim();
    if (!raw.endsWith("=") || raw.length > 500) return { ok: false };
    const src = normalizeSource(raw.slice(0, -1));
    if (!src || !/\d/.test(src) || !/^[0-9+\-*/%^().\s]+$/.test(src)) return { ok: false };
    const value = evaluate("=" + src);
    if (isError(value) || typeof value !== "number" || !isFinite(value)) {
      return { ok: false, error: isError(value) ? value.code : "算式无效" };
    }
    return { ok: true, value, text: toText(value) };
  }

  function display(value) {
    if (isError(value)) return { text: value.code, error: true };
    return { text: String(toText(value)), error: false };
  }

  function shiftRefs(formula, rowDelta, colDelta, absoluteRows) {
    const src = String(formula == null ? "" : formula);
    const dr = Number(rowDelta) || 0;
    const dc = Number(colDelta) || 0;
    if (src.charAt(0) !== "=" || (!dr && !dc && typeof absoluteRows !== "function")) return src;
    let tokens;
    try {
      tokens = tokenize(src.slice(1), false);
    } catch (exc) {
      return src;
    }
    const mapRef = (tk) => {
      const m = REF_RE.exec(tk.raw);
      if (!m) return null;
      const raw = tk.raw;
      const dollarCol = raw.charAt(0) === "$";
      const dollarRow = raw.slice(dollarCol ? 1 : 0).indexOf("$") >= 0;
      let row = parseInt(m[2], 10) - 1;
      let col = colIndex(m[1]);
      if (dollarRow && typeof absoluteRows === "function") {
        row = absoluteRows(row);
        if (row < 0) return null;
      } else if (!dollarRow) {
        row += dr;
      }
      if (!dollarCol) col += dc;
      if (row < 0 || col < 0) return null;
      return (dollarCol ? "$" : "") + colLetter(col) + (dollarRow ? "$" : "") + (row + 1);
    };
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const ref = refOfToken(tk);
      if (!ref) {
        out.push(tk.raw);
        continue;
      }
      const next = tokens[i + 1];
      const next2 = tokens[i + 2];
      if (next && next.t === "lp") {
        out.push(tk.raw);
        continue;
      }
      if (next && next.t === "colon" && refOfToken(next2)) {
        const a = mapRef(tk);
        const b = mapRef(next2);
        out.push(a && b ? a + ":" + b : "#REF!");
        i += 2;
        continue;
      }
      out.push(mapRef(tk) || "#REF!");
    }
    return "=" + out.join("");
  }

  function remapRefs(formula, maps) {
    const src = String(formula == null ? "" : formula);
    if (src.charAt(0) !== "=") return src;
    let tokens;
    try {
      tokens = tokenize(src.slice(1), false);
    } catch (exc) {
      return src;
    }
    const rows = maps && maps.rows;
    const cols = maps && maps.cols;
    const mapRef = (tk) => {
      const m = REF_RE.exec(tk.raw);
      if (!m) return null;
      let row = parseInt(m[2], 10) - 1;
      let col = colIndex(m[1]);
      if (rows) {
        row = rows(row);
        if (row < 0) return null;
      }
      if (cols) {
        col = cols(col);
        if (col < 0) return null;
      }
      const raw = tk.raw;
      const dollarCol = raw.charAt(0) === "$";
      const dollarRow = raw.slice(dollarCol ? 1 : 0).indexOf("$") >= 0;
      return (dollarCol ? "$" : "") + colLetter(col) + (dollarRow ? "$" : "") + (row + 1);
    };
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const ref = refOfToken(tk);
      if (!ref) {
        out.push(tk.raw);
        continue;
      }
      const next = tokens[i + 1];
      const next2 = tokens[i + 2];
      if (next && next.t === "lp") {
        out.push(tk.raw);
        continue;
      }
      if (next && next.t === "colon" && refOfToken(next2)) {
        const a = mapRef(tk);
        const b = mapRef(next2);
        out.push(a && b ? a + ":" + b : "#REF!");
        i += 2;
        continue;
      }
      const mapped = mapRef(tk);
      out.push(mapped || "#REF!");
    }
    return "=" + out.join("");
  }

  const api = {
    evaluate,
    quickEvaluate,
    display,
    isError,
    error,
    remapRefs,
    shiftRefs,
    parseRefs,
    colLetter,
    colIndex,
    FormulaError,
    ERR,
    functions: Object.keys(FUNCS).sort(),
    signatures: SIGNATURES,
  };

  root.SheetFormula = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);