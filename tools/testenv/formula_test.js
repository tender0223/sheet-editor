const F = require("../../static/formula.js");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = F.isError(actual) ? actual.code : actual;
  if (Object.is(a, expected)) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(a)}`);
  }
}

function sheet(matrix) {
  return {
    get(r, c) {
      if (!matrix[r]) return "";
      const v = matrix[r][c];
      return v == null ? "" : v;
    },
  };
}

const refs = sheet([
  [1, 10],
  [2, 20],
  [3, 30],
  ["b", 40],
]);

check("加法优先", F.evaluate("=1+2*3", refs), 7);
check("括号", F.evaluate("=(1+2)*3", refs), 9);
check("乘方左结合", F.evaluate("=2^3^2", refs), 64);
check("负号优先于乘方", F.evaluate("=-2^2", refs), 4);
check("百分比", F.evaluate("=50%", refs), 0.5);
check("引用", F.evaluate("=A1+1", refs), 2);
check("跨列引用", F.evaluate("=B3-A2", refs), 28);
check("SUM 区域", F.evaluate("=SUM(A1:A3)", refs), 6);
check("SUM 混合", F.evaluate("=SUM(A1,B1,10)", refs), 21);
check("AVERAGE", F.evaluate("=AVERAGE(A1:A3)", refs), 2);
check("COUNT 数字", F.evaluate("=COUNT(A1:A4)", refs), 3);
check("COUNTA", F.evaluate("=COUNTA(A1:A4)", refs), 4);
check("COUNTBLANK", F.evaluate("=COUNTBLANK(A1:C1)", refs), 1);
check("MAX", F.evaluate("=MAX(B1:B3)", refs), 30);
check("MIN", F.evaluate("=MIN(B1:B3)", refs), 10);
const largeColumn = { get(r) { return r + 1; } };
check("MAX 大区域不展开函数参数", F.evaluate("=MAX(A1:A130000)", largeColumn), 130000);
check("MIN 大区域不展开函数参数", F.evaluate("=MIN(A1:A130000)", largeColumn), 1);
check("MEDIAN", F.evaluate("=MEDIAN(A1:A3)", refs), 2);
check("PRODUCT", F.evaluate("=PRODUCT(A1:A3)", refs), 6);
check("IF 真", F.evaluate('=IF(B1>5,"大","小")', refs), "大");
check("IF 假", F.evaluate('=IF(B1<5,"大","小")', refs), "小");
check("IFERROR", F.evaluate('=IFERROR(1/0,"出错")', refs), "出错");
check("IFERROR 正常", F.evaluate("=IFERROR(8/2,0)", refs), 4);
check("AND", F.evaluate("=AND(TRUE,1>0)", refs), true);
check("OR", F.evaluate("=OR(FALSE,1<0)", refs), false);
check("NOT", F.evaluate("=NOT(FALSE)", refs), true);
check("ROUND 正数", F.evaluate("=ROUND(1.235,2)", refs), 1.24);
check("ROUND 负数", F.evaluate("=ROUND(-1.235,2)", refs), -1.24);
check("ROUNDUP", F.evaluate("=ROUNDUP(1.231,2)", refs), 1.24);
check("ROUNDDOWN", F.evaluate("=ROUNDDOWN(1.239,2)", refs), 1.23);
check("MOD 负数", F.evaluate("=MOD(-3,2)", refs), 1);
check("ABS", F.evaluate("=ABS(-7)", refs), 7);
check("INT", F.evaluate("=INT(-1.2)", refs), -2);
check("POWER", F.evaluate("=POWER(2,10)", refs), 1024);
check("SQRT", F.evaluate("=SQRT(16)", refs), 4);
check("CONCAT", F.evaluate('=CONCAT(A1,"-",B1)', refs), "1-10");
check("CONCATENATE", F.evaluate('=CONCATENATE("a","b")', refs), "ab");
check("& 连接", F.evaluate('="a"&"b"', refs), "ab");
check("LEN", F.evaluate('=LEN("abcd")', refs), 4);
check("LEFT", F.evaluate('=LEFT("abcd",2)', refs), "ab");
check("RIGHT", F.evaluate('=RIGHT("abcd",2)', refs), "cd");
check("MID", F.evaluate('=MID("abcdef",2,3)', refs), "bcd");
check("TRIM", F.evaluate('=TRIM("  a   b  ")', refs), "a b");
check("UPPER", F.evaluate('=UPPER("abc")', refs), "ABC");
check("FIND", F.evaluate('=FIND("c","abcd")', refs), 3);
check("SUBSTITUTE", F.evaluate('=SUBSTITUTE("a-b-c","-","+")', refs), "a+b+c");
check("COUNTIF 数值条件", F.evaluate('=COUNTIF(A1:A4,">2")', refs), 1);
check("COUNTIF 文本", F.evaluate('=COUNTIF(A1:A4,"b")', refs), 1);
check("SUMIF", F.evaluate('=SUMIF(A1:A4,">2",B1:B4)', refs), 30);
check("AVERAGEIF", F.evaluate('=AVERAGEIF(A1:A4,">1",B1:B4)', refs), 25);
check("VLOOKUP 精确", F.evaluate('=VLOOKUP("b",A1:B4,2,FALSE)', refs), 40);
check("VLOOKUP 近似", F.evaluate("=VLOOKUP(2.5,A1:B3,2)", refs), 20);
check("VLOOKUP 未命中", F.evaluate('=VLOOKUP("z",A1:B4,2,FALSE)', refs), "#N/A");
check("TEXT 千分位", F.evaluate('=TEXT(1234.5,"#,##0.00")', refs), "1,234.50");
check("TEXT 百分比", F.evaluate('=TEXT(0.25,"0.0%")', refs), "25.0%");
check("比较文本", F.evaluate('=IF("A"="a","相同","不同")', refs), "相同");
check("除零", F.evaluate("=1/0", refs), "#DIV/0!");
check("未知函数", F.evaluate("=FOO(1)", refs), "#NAME?");
check("语法错误", F.evaluate("=1+", refs), "#VALUE!");
check("独立区域", F.evaluate("=A1:B2", refs), "#VALUE!");
check("绝对值符号不影响", F.evaluate("=$A$1+A2", refs), 3);
check("空单元格当 0", F.evaluate("=C1+1", refs), 1);
check("空公式", F.evaluate("=", refs), "");
check("快速乘法", F.quickEvaluate("1×2=").text, "2");
check("快速除法", F.quickEvaluate("10÷4=").text, "2.5");
check("快速全角括号", F.quickEvaluate("=（1+2）×3=").text, "9");
check("快速浮点精度", F.quickEvaluate("0.1+0.2=").text, "0.3");
check("快速除零", F.quickEvaluate("1/0=").ok, false);
check("快速算式不接收函数", F.quickEvaluate("SUM(1,2)=").ok, false);
check("公式乘号", F.evaluate("=1×2", refs), 2);
check("公式全角括号", F.evaluate("=（1+2）×3", refs), 9);
check("多函数引用解析", F.parseRefs("SUM(A1:A2)+AVERAGE(B3)+MAX(C4:D5)").length, 3);

check("引用插入行", F.remapRefs("=SUM(A1:B2)", { rows: (i) => (i >= 0 ? i + 1 : i) }), "=SUM(A2:B3)");
check("引用插入行不涉及", F.remapRefs("=SUM(A1:B2)", { rows: (i) => (i >= 5 ? i + 1 : i) }), "=SUM(A1:B2)");
check("引用删除行", F.remapRefs("=A1+A2", { rows: (i) => (i === 1 ? -1 : i > 1 ? i - 1 : i) }), "=A1+#REF!");
check("引用删除行后移", F.remapRefs("=A1+A3", { rows: (i) => (i === 1 ? -1 : i > 1 ? i - 1 : i) }), "=A1+A2");
check("引用删除列", F.remapRefs("=B1+C1", { cols: (i) => (i === 1 ? -1 : i > 1 ? i - 1 : i) }), "=#REF!+B1");
check("绝对引用保留", F.remapRefs("=$A$1+A1", { rows: (i) => i + 2 }), "=$A$3+A3");
check("文本里的 A1 不改", F.remapRefs('="A1"&A1', { rows: (i) => i + 1 }), '="A1"&A2');
check("函数名不误改", F.remapRefs("=LOG10(A1)", { rows: (i) => i + 1 }), "=LOG10(A2)");
check("两处引用", F.remapRefs("=A1*B1", { rows: (i) => i + 1, cols: (i) => i + 1 }), "=B2*C2");

check("填充公式相对引用随行平移", F.shiftRefs("=SUM(C2:E2)", 3, 0), "=SUM(C5:E5)");
check("填充公式保留绝对引用", F.shiftRefs("=A1+B$2+$C3+$D$4", 2, 1), "=B3+C$2+$C5+$D$4");
check("填充公式区域平移", F.shiftRefs("=SUM(A1:B2)", 2, 1), "=SUM(B3:C4)");
check("填充公式不改文本和函数名", F.shiftRefs('=CONCAT("A1",LOG10(B2))', 1, 0), '=CONCAT("A1",LOG10(B3))');
check("填充公式向上越界", F.shiftRefs("=A1", -1, 0), "=#REF!");
check("填充公式跳过坏引用继续平移", F.shiftRefs("=A1+#REF!", 1, 0), "=A2+#REF!");
check("重映射跳过坏引用继续平移", F.remapRefs("=A1+#REF!", { rows: (i) => i + 1 }), "=A2+#REF!");
check("基准行删除时绝对引用按结构重映射", F.shiftRefs("=A3+$A$3", -1, 0, (i) => i === 2 ? -1 : i), "=A2+#REF!");

const today = F.evaluate("=TODAY()", refs);
check("TODAY 格式", /^\d{4}-\d{2}-\d{2}$/.test(today), true);
check("RANDBETWEEN", Number.isInteger(F.evaluate("=RANDBETWEEN(1,3)", refs)), true);

console.log(`通过 ${passed}，失败 ${failed}`);
if (failures.length) {
  for (const line of failures) console.log("  " + line);
  process.exit(1);
}