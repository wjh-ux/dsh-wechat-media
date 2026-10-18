/**
 * Office tools: discovery, spec validation, and the argument building around two external programs.
 *
 * The live half only runs where the bundled Python is present (it is not on Linux CI); it says "skipped"
 * out loud rather than pretending to have run.
 *
 * Run: node test/office.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
let skipped = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

const office = await import("../office.js");

test("the extension decides the kind, and nothing else does", () => {
  assert.equal(office.kindOf("a.DOCX"), "docx");
  assert.equal(office.kindOf("b.xlsx"), "xlsx");
  assert.equal(office.kindOf("c.pptx"), "pptx");
  assert.equal(office.kindOf("d.pdf"), undefined);
  assert.equal(office.kindOf(""), undefined);
  assert.equal(office.kindOf(undefined), undefined);
});

test("a write spec is refused before any process starts", () => {
  assert.throws(() => office.parseWriteSpec("a.pdf", "{}"), /docx \/ \.xlsx \/ \.pptx/);
  assert.throws(() => office.parseWriteSpec("a.docx", "{not json"), /不是合法 JSON/);
  assert.throws(() => office.parseWriteSpec("a.docx", "[]"), /必须是一个 JSON 对象/);
  assert.throws(() => office.parseWriteSpec("a.docx", '{"title":"x"}'), /需要 blocks/);
  assert.throws(() => office.parseWriteSpec("a.xlsx", '{"sheets":[]}'), /需要 sheets/);
  assert.throws(() => office.parseWriteSpec("a.xlsx", '{"sheets":[{"name":"s"}]}'), /缺少 rows/);
  assert.throws(() => office.parseWriteSpec("a.pptx", '{"slides":[]}'), /需要 slides/);
  const okDocx = office.parseWriteSpec("a.docx", '{"blocks":[{"type":"paragraph","text":"hi"}]}');
  assert.equal(okDocx.kind, "docx");
  assert.equal(okDocx.spec.blocks.length, 1, "a valid spec comes back parsed");
});

test("relative paths land in officeDir when it is set, and say so when it is not", () => {
  const fallback = "C:\\bridge\\cwd";
  const unset = office.resolveBaseDir({ prefs: {}, env: {}, fallback });
  assert.equal(unset.configured, false);
  assert.equal(unset.dir, office.absolutePath(fallback), "the fallback is the bridge's own cwd");
  const set = office.resolveBaseDir({ prefs: { officeDir: "C:\\Users\\me\\Desktop\\报表" }, env: {}, fallback });
  assert.equal(set.configured, true);
  assert.equal(set.dir, office.absolutePath("C:\\Users\\me\\Desktop\\报表"));
  // A relative setting is relative to the bridge's cwd, not to itself.
  const relative = office.resolveBaseDir({ prefs: { officeDir: "out" }, env: {}, fallback });
  assert.equal(relative.dir, office.absolutePath("out", office.absolutePath(fallback)));
  // The environment is the second way in, for a deployment that cannot set prefs.
  const fromEnv = office.resolveBaseDir({ prefs: {}, env: { DSH_OFFICE_DIR: "C:\\env\\dir" }, fallback });
  assert.equal(fromEnv.dir, office.absolutePath("C:\\env\\dir"));
  // An explicit pref wins over the environment.
  const both = office.resolveBaseDir({ prefs: { officeDir: "C:\\pref" }, env: { DSH_OFFICE_DIR: "C:\\env" }, fallback });
  assert.equal(both.dir, office.absolutePath("C:\\pref"));
  // An absolute path argument ignores the base entirely.
  assert.equal(office.absolutePath("C:\\elsewhere\\a.docx", "C:\\base"), office.absolutePath("C:\\elsewhere\\a.docx"));
});

test("a relative path is resolved, an empty one refused", () => {
  assert.match(office.absolutePath("out/a.docx", "C:\\\\work"), /[\\\\/]out[\\\\/]a\.docx$/);
  assert.throws(() => office.absolutePath("  "), /需要 path/);
});

test("the toolchain reports what it found instead of assuming", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-tool-"));
  const fakePython = join(dir, "python.exe");
  writeFileSync(fakePython, "x");
  const found = office.resolveToolchain({ prefs: { officePython: fakePython, officeKit: "" }, env: {} });
  assert.equal(found.ready, true);
  assert.equal(found.python, fakePython);
  assert.equal(found.canConvert, false, "no kit means no conversion, and it says so");
  // With nothing configured, discovery still finds the runtime's own Python - that is the point of
  // discovery. What must never happen is claiming a program that is not there.
  const discovered = office.resolveToolchain({ prefs: {}, env: {} });
  if (discovered.python) {
    assert.equal(discovered.ready, true, "a discovered interpreter counts");
    assert.ok(existsSync(discovered.python));
  } else {
    assert.equal(discovered.ready, false, "and nothing found means not ready");
  }
  const missing = office.resolveToolchain({ prefs: { officePython: "C:\\nope\\python.exe" }, env: {} });
  assert.equal(missing.python, "C:\\nope\\python.exe", "an explicit setting wins over discovery");
  assert.equal(missing.ready, false, "but it still has to exist");
});

test("convert builds the kit command, and refuses a non-PDF target", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    return "";
  };
  await office.convertOffice({ kit: "C:\\\\kit\\\\cli.js", node: "node.exe", input: "C:\\\\a.docx", output: "C:\\\\a.pdf", exec });
  assert.deepEqual(calls[0].args, ["C:\\\\kit\\\\cli.js", "convert", "--input", "C:\\\\a.docx", "--output", "C:\\\\a.pdf"]);
  await assert.rejects(
    () => office.convertOffice({ kit: "k", node: "n", input: "a.docx", output: "a.docx", exec }),
    /只支持转成 PDF/,
  );
  await assert.rejects(() => office.convertOffice({ kit: "", node: "n", input: "a", output: "a.pdf", exec }), /找不到 LibreOffice Kit/);
});

test("render passes only the selectors it was given", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(args);
    return '{"pages":[1]}';
  };
  await office.renderOffice({ kit: "k", node: "n", input: "a.pptx", outputDir: "o", pages: "1,3", exec });
  assert.deepEqual(calls[0], ["k", "render", "--input", "a.pptx", "--output-dir", "o", "--pages", "1,3"]);
  await office.renderOffice({ kit: "k", node: "n", input: "b.xlsx", outputDir: "o2", sheet: "报表", range: "A1:C9", exec });
  assert.deepEqual(calls[1], ["k", "render", "--input", "b.xlsx", "--output-dir", "o2", "--sheet", "报表", "--range", "A1:C9"]);
});

test("runOffice reads the last JSON line, and turns a refusal into an error", async () => {
  const ok = await office.runOffice({
    python: "py",
    exec: async () => 'noise\n{"ok":true,"kind":"docx","bytes":12}\n',
    payload: { action: "read", path: "a.docx" },
  });
  assert.equal(ok.bytes, 12);
  await assert.rejects(
    () => office.runOffice({ python: "py", exec: async () => '{"ok":false,"error":"文件不存在"}', payload: {} }),
    /文件不存在/,
  );
  await assert.rejects(() => office.runOffice({ python: "py", exec: async () => "", payload: {} }), /没有返回任何内容/);
  await assert.rejects(() => office.runOffice({ python: "", exec: async () => "", payload: {} }), /找不到 Python/);
});

test("the payload reaches Python as base64 on argv, never through a shell", async () => {
  let seen;
  await office.runOffice({
    python: "py",
    exec: async (command, args) => {
      seen = { command, args };
      return '{"ok":true}';
    },
    payload: { action: "write", path: "中文 路径.docx", spec: { blocks: [] } },
  });
  assert.equal(seen.command, "py");
  assert.equal(seen.args[0], "-c");
  const decoded = JSON.parse(Buffer.from(seen.args[2], "base64").toString("utf8"));
  assert.equal(decoded.path, "中文 路径.docx", "Unicode survives the command line");
  assert.match(office.OFFICE_PY, /base64\.b64decode\(sys\.argv\[1\]\)/, "and Python expects exactly that");
});

// ── live: only where the bundled interpreter is present ─────────────────────
// The kit lives inside the harness install, which a plain `node` run cannot locate on its own: tests take
// the path from the environment and skip the conversion when it is absent (Linux CI has neither).
const tool = office.resolveToolchain({ env: process.env, resourcesPath: process.env.DSH_RESOURCES });
if (!tool.ready) {
  skipped += 1;
  console.log("  skip live round trip (no bundled Python in this environment)");
} else {
  const { execFile } = await import("node:child_process");
  const exec = (command, args, options) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: options?.timeoutMs ?? 120000, windowsHide: true, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
        } else resolve(stdout);
      });
    });

  await test("live: a docx written from a spec reads back with its text, bullets and table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-live-"));
    const file = join(dir, "t.docx");
    await office.runOffice({
      python: tool.python,
      exec,
      payload: {
        action: "write",
        path: file,
        spec: {
          title: "标题",
          blocks: [
            { type: "heading", level: 1, text: "第一节" },
            { type: "paragraph", text: "中文正文。" },
            { type: "bullets", items: ["甲", "乙"] },
            { type: "table", rows: [["项目", "值"], ["收入", "120"]] },
          ],
        },
      },
    });
    assert.ok(statSync(file).size > 1000, "the file has content");
    const back = await office.runOffice({ python: tool.python, exec, payload: { action: "read", path: file } });
    assert.equal(back.kind, "docx");
    assert.equal(back.tables.length, 1);
    assert.equal(back.tables[0][1][0], "收入", "the Chinese cell came back intact");
    assert.ok(back.blocks.some((b) => b.text === "中文正文。"));
  });

  await test("live: xlsx and pptx round trip, and a missing file is a sentence not a stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-live-"));
    const sheet = join(dir, "t.xlsx");
    await office.runOffice({
      python: tool.python,
      exec,
      payload: { action: "write", path: sheet, spec: { sheets: [{ name: "报表", rows: [["月份", "收入"], ["1月", 120]] }] } },
    });
    const book = await office.runOffice({ python: tool.python, exec, payload: { action: "read", path: sheet } });
    assert.equal(book.sheets[0].name, "报表");
    assert.deepEqual(book.sheets[0].rows[1], ["1月", "120"]);

    const deck = join(dir, "t.pptx");
    await office.runOffice({
      python: tool.python,
      exec,
      payload: { action: "write", path: deck, spec: { slides: [{ title: "第一页", bullets: ["要点"] }] } },
    });
    const slides = await office.runOffice({ python: tool.python, exec, payload: { action: "read", path: deck } });
    assert.equal(slides.slides.length, 1);
    assert.match(slides.slides[0].texts.join(""), /第一页/);

    await assert.rejects(
      () => office.runOffice({ python: tool.python, exec, payload: { action: "read", path: join(dir, "nope.docx") } }),
      /文件不存在/,
    );
  });

  if (!tool.kit) {
    skipped += 1;
    console.log("  skip live PDF conversion (no LibreOffice Kit here)");
  } else {
    await test("live: converting to PDF keeps the source and writes a real PDF", async () => {
      const dir = mkdtempSync(join(tmpdir(), "office-live-"));
      const source = join(dir, "src.docx");
      await office.runOffice({
        python: tool.python,
        exec,
        payload: { action: "write", path: source, spec: { title: "转换", blocks: [{ type: "paragraph", text: "转成 PDF。" }] } },
      });
      const before = statSync(source).size;
      const pdf = join(dir, "src.pdf");
      await office.convertOffice({ kit: tool.kit, node: process.execPath, input: source, output: pdf, exec });
      assert.ok(statSync(pdf).size > 1000, "the PDF has content");
      assert.equal(statSync(source).size, before, "the source file is untouched");
      const { readFileSync } = await import("node:fs");
      assert.equal(readFileSync(pdf).subarray(0, 5).toString("latin1"), "%PDF-");
    });
  }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
