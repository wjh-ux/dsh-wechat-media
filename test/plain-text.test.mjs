/**
 * Tests for the outbound sanitiser.
 *
 * WeChat and WeCom render no markdown, so everything that leaves for a chat goes through
 * `toPlainText`. The property that matters most is the negative one: an ordinary sentence must come
 * out byte-for-byte identical. A sanitiser that quietly rewrites prose is worse than none.
 *
 * Run: node test/plain-text.test.mjs
 */
import assert from "node:assert/strict";

import { mathToText, toPlainText } from "../plain-text.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

console.log("plain text");

await test("ordinary prose is untouched", () => {
  const prose = [
    "平方差公式是 (a+b)(a-b) = a² - b²。",
    "It works in both directions, and it is simple.",
    "第 1 步：把 x² − 49 拆成两个因式。",
    "a * b 是乘法，不是强调。",
    "文件名叫 my_file_name.txt，别动它。",
  ];
  for (const line of prose) assert.equal(toPlainText(line), line, `"${line}" must survive unchanged`);
});

await test("bold and italic lose their markers, not their words", () => {
  assert.equal(toPlainText("这是 **重点** 内容"), "这是 重点 内容");
  assert.equal(toPlainText("__重点__"), "重点");
  assert.equal(toPlainText("a *soft* word"), "a soft word");
  assert.equal(toPlainText("**整句都是重点。**"), "整句都是重点。");
  assert.equal(toPlainText("混合 **粗** 和 *斜* 一起"), "混合 粗 和 斜 一起");
});

await test("headings, quotes and rules become plain lines", () => {
  assert.equal(toPlainText("## 三个例子"), "三个例子");
  assert.equal(toPlainText("# Title\n\ntext"), "Title\n\ntext");
  assert.equal(toPlainText("> quoted line"), "quoted line");
  assert.equal(toPlainText("上面\n\n---\n\n下面"), "上面\n\n下面");
  assert.equal(toPlainText("标题\n====="), "标题");
});

await test("code keeps its content and loses its fence", () => {
  assert.equal(toPlainText("`npm run test`"), "npm run test");
  assert.equal(toPlainText("```js\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(toPlainText("```\nplain\n```"), "plain");
  // An unterminated fence (a turn cut off mid-answer) must still not show backticks.
  assert.equal(toPlainText("```js\nconst a = 1;"), "const a = 1;");
});

await test("links read like a chat, images disappear", () => {
  assert.equal(toPlainText("[文档](https://example.com/a)"), "文档（https://example.com/a）");
  assert.equal(toPlainText("[https://example.com](https://example.com)"), "https://example.com");
  assert.equal(toPlainText("![图](https://example.com/a.png)"), "");
  assert.equal(toPlainText("看图 ![图](x.png) 就懂"), "看图  就懂");
});

await test("math delimiters keep the formula", () => {
  assert.equal(toPlainText("$$x^2 - y^2$$"), "x² - y²"); // exponents become real superscripts
  assert.equal(toPlainText("公式 $a+b$ 成立"), "公式 a+b 成立");
  assert.equal(toPlainText("\\[x^2\\]"), "x²");
  assert.equal(toPlainText("\\(a-b\\)"), "a-b");
});

await test("reasoning and HTML never reach a chat", () => {
  assert.equal(toPlainText("<thinking>internal</thinking>答案"), "答案");
  assert.equal(toPlainText("<think>hmm</think>答案"), "答案");
  assert.equal(toPlainText("a <b>bold</b> c"), "a bold c");
  assert.equal(toPlainText("<!-- 注释 -->正文"), "正文");
});

await test("table rules go, cells stay readable", () => {
  // A two-column table reads as labelled lines: "· key：value" is far easier to scan in a chat than
// two words with whitespace between them.
  assert.equal(toPlainText("| a | b |\n| --- | --- |\n| 1 | 2 |"), "· a：b\n· 1：2");
  assert.equal(toPlainText("| 条件 | 说明 |\n| --- | --- |\n| 两项相同 | 符号相反 |"), "· 条件：说明\n· 两项相同：符号相反");
  // Three or more columns keep their spacing, still marked as a row.
  assert.equal(toPlainText("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |"), "· a  b  c\n· 1  2  3");
});

await test("bullet markers become a middot, numbered lists keep their numbers", () => {
  assert.equal(toPlainText("- 第一点\n- 第二点"), "· 第一点\n· 第二点");
  assert.equal(toPlainText("* 第一点"), "· 第一点");
  assert.equal(toPlainText("1. 第一步\n2. 第二步"), "1. 第一步\n2. 第二步");
});

await test("a formula becomes text a person can read", () => {
  assert.equal(mathToText("\\frac{a}{b}"), "a/b");
  assert.equal(mathToText("\\frac{x+1}{y-2}"), "(x+1)/(y-2)");
  assert.equal(mathToText("\\frac{\\frac{a}{b}}{c}"), "(a/b)/c");
  assert.equal(mathToText("\\sqrt{x}"), "√x");
  assert.equal(mathToText("\\sqrt{x^2+y^2}"), "√(x²+y²)");
  assert.equal(mathToText("x^2 + a_1"), "x² + a₁");
  assert.equal(mathToText("a^{n+1}"), "aⁿ⁺¹"); // every character here has a superscript form
  assert.equal(mathToText("e^{i\\pi}"), "e^(iπ)"); // not every character does, so the bracket form is used
  assert.equal(mathToText("\\alpha + \\beta \\times \\gamma"), "α + β × γ");
  assert.equal(mathToText("x \\le y \\ne z"), "x ≤ y ≠ z");
  assert.equal(mathToText("\\text{cm}^2"), "cm²");
  assert.equal(mathToText("90^\\circ"), "90°");
  assert.equal(mathToText("\\sum_{i=1}^{n} i"), "Σᵢ₌₁ⁿ i"); // every character has a subscript form, so no brackets
  assert.equal(mathToText("\\int_0^1 x\\,dx"), "∫₀¹ x dx");
  assert.equal(mathToText("\\left(\\frac{a}{2}\\right)"), "(a/2)");
});

await test("the delimiters go and the formula stays", () => {
  assert.equal(toPlainText("$$\\frac{a}{b}$$"), "a/b");
  assert.equal(toPlainText("公式 $x^2$ 成立"), "公式 x² 成立");
  assert.equal(toPlainText("\\[\\sqrt{2}\\]"), "√2");
  assert.equal(toPlainText("\\(\\alpha\\)"), "α");
});

await test("a Windows path is never treated as LaTeX", () => {
  // The one way this feature could do real damage: mangling paths and file names.
  for (const line of [
    "日志在 C:\\Users\\Administrator\\.dsh\\plugins 下面",
    "改 my_file_name.txt 就行",
    "正则 \\d+ 匹配数字",
    "裸的 \\frac{a}{b} 不在数学定界符里，所以不动它",
  ]) {
    assert.equal(toPlainText(line), line, `"${line}" must survive unchanged`);
  }
});
await test("leftover markers from a half-streamed span are dropped", () => {
  // The streamer cleans the accumulated text, so this only happens if the turn itself was cut off.
  assert.equal(toPlainText("重点 **"), "重点"); // trailing space is tidied away
  assert.equal(toPlainText("a ** b"), "a  b");
});

await test("blank space is tidied, never invented", () => {
  assert.equal(toPlainText("\n\n正文\n\n\n\n下一段\n\n"), "正文\n\n下一段");
  assert.equal(toPlainText("   "), "");
  assert.equal(toPlainText(""), "");
  assert.equal(toPlainText(undefined), "");
  assert.equal(toPlainText(null), "");
});

await test("a realistic answer comes out as a chat message", () => {
  const answer = [
    "## 平方差公式",
    "",
    "**核心**是 `(a+b)(a-b) = a² - b²`。",
    "",
    "三个例子：",
    "",
    "1. (x + 5)(x − 5) = x² − 25",
    "- 103 × 97 = (100+3)(100−3) = **9991**",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    "| 条件 | 两项相同、符号相反 |",
    "",
    "详见 [说明](https://example.com/sq)。",
  ].join("\n");
  const plain = toPlainText(answer);
  for (const marker of ["##", "**", "`", "|---", "| 项目 |", "]("]) {
    assert.ok(!plain.includes(marker), `"${marker}" must not survive:\n${plain}`);
  }
  assert.ok(plain.includes("平方差公式"));
  assert.ok(plain.includes("(a+b)(a-b) = a² - b²"));
  assert.ok(plain.includes("· 103 × 97"));
  assert.ok(plain.includes("说明（https://example.com/sq）"));
  assert.ok(!/\n{3,}/.test(plain), "no run of blank lines");
});

test("chunking never splits a surrogate pair or a code fence", async () => {
  // Measured: "aaaaaaaaa\ud83d" - a chunk ending in half an emoji - and a chunk holding an opening fence with no closing one.
  const { chunkText } = await import("../index.js");
  const lone = (value) => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return index;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        const previous = value.charCodeAt(index - 1);
        if (!(previous >= 0xd800 && previous <= 0xdbff)) return index;
      }
    }
    return -1;
  };
  for (const limit of [4, 8, 10, 16]) {
    for (const chunk of chunkText("😀".repeat(limit) + "a".repeat(limit), limit)) {
      assert.equal(lone(chunk), -1, `a chunk contains half a surrogate: ${JSON.stringify(chunk)}`);
    }
  }
  const fenced = "说明文字。\n\n".repeat(3) + "```js\nconst a = 1;\n```\n\n" + "说明文字。\n\n".repeat(3);
  for (const chunk of chunkText(fenced, 40)) {
    assert.equal((chunk.match(/```/g) ?? []).length % 2, 0, `a chunk shows an unclosed fence: ${JSON.stringify(chunk)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
