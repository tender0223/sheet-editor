/* 校验“插入/删除行”后公式引用的 Excel 行号换算（表头=第 1 行，数据从第 2 行起） */
const SheetFormula = require("../../static/formula.js");

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

function deleteRowRefMap(set) {
  const inner = deleteMapFromSet(set);
  return (i) => {
    if (i === 0) return 0;
    const mapped = inner(i - 1);
    return mapped < 0 ? -1 : mapped + 1;
  };
}

function insertRowRefMap(index) {
  return (i) => (i === 0 ? 0 : i - 1 >= index ? i + 1 : i);
}

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`失败：${name}\n  实际：${actual}\n  期望：${expected}`);
  }
}

function remap(formula, rows, cols) {
  return SheetFormula.remapRefs(formula, { rows: rows || null, cols: cols || null });
}

// 在第 1 条数据（Excel 第 3 行）前插入：原 2 行不变，3 行起整体下移
check("插入行 A2 不变", remap("=A2", insertRowRefMap(1)), "=A2");
check("插入行 A3→A4", remap("=A3", insertRowRefMap(1)), "=A4");
check("插入行区域扩展", remap("=SUM(A2:A4)", insertRowRefMap(1)), "=SUM(A2:A5)");
check("插入行表头引用不变", remap("=A1", insertRowRefMap(1)), "=A1");
check("插入行 $ 保留", remap("=$A$3", insertRowRefMap(1)), "=$A$4");
check("插入行在末尾不影响", remap("=A2", insertRowRefMap(3)), "=A2");

// 删除第 1 条数据（Excel 第 3 行）：A3 变 #REF!，A4→A3，A2 不变
check("删除行 A2 不变", remap("=A2", deleteRowRefMap(new Set([1]))), "=A2");
check("删除行 A3 失效", remap("=A3", deleteRowRefMap(new Set([1]))), "=#REF!");
check("删除行 A4→A3", remap("=A4", deleteRowRefMap(new Set([1]))), "=A3");
check("删除行区域含失效端点", remap("=SUM(A3:A4)", deleteRowRefMap(new Set([1]))), "=SUM(#REF!)");
check("删除行表头不变", remap("=A1", deleteRowRefMap(new Set([1]))), "=A1");
check("删除多行 A5→A3", remap("=A5", deleteRowRefMap(new Set([1, 2]))), "=A3");

// 列操作沿用原坐标（A 列即第 1 列）
check("插入列 B→C", remap("=B2", null, (i) => (i >= 1 ? i + 1 : i)), "=C2");
check("删除列 B 失效", remap("=B2", null, (i) => (i === 1 ? -1 : i > 1 ? i - 1 : i)), "=#REF!");
check("删除列 C→B", remap("=C2", null, (i) => (i === 1 ? -1 : i > 1 ? i - 1 : i)), "=B2");

console.log(`通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);