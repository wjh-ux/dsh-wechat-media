// The flow runner's contract: what a flow may say, what the page-side extraction asks the page for, and what a run
// reports. The session is a fake that answers Runtime.evaluate from a table, so the runner is exercised without a
// browser - the shapes it sends are the same ones browser.js sends (see its header for the measured originals).
import assert from "node:assert/strict";

const { normalizeFlow, extractExpression, runFlow, formatFlowResult, startRecording, stopRecording, FLOW_STEP_TYPES } = await import("../flow.js");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

/** A session whose page answers Runtime.evaluate from a function, and records every CDP call. */
function fakeSession(answer) {
  const sent = [];
  return {
    sent,
    async send(method, params) {
      sent.push({ method, params });
      if (method !== "Runtime.evaluate") return {};
      const value = await answer(String(params?.expression ?? ""));
      if (value instanceof Error) return { exceptionDetails: { text: value.message } };
      return { result: { value } };
    },
    async once() { return {}; },
    close() {},
  };
}

await test("a bare step array is a flow, and a url becomes the first goto", () => {
  const flow = normalizeFlow([{ type: "click", selector: "#go" }]);
  assert.equal(flow.name, "未命名流程");
  assert.equal(flow.steps.length, 1);

  const withUrl = normalizeFlow({ name: "地图", url: "https://www.google.com/maps", steps: [{ type: "wait", ms: 300 }] });
  assert.equal(withUrl.name, "地图");
  assert.equal(withUrl.steps[0].type, "goto");
  assert.equal(withUrl.steps[0].url, "https://www.google.com/maps");
  assert.equal(withUrl.steps[1].ms, 300);
});

await test("a step the runner cannot execute is refused by name, with its number", () => {
  assert.throws(() => normalizeFlow([{ type: "teleport" }]), /第 1 步.*teleport/);
  assert.throws(() => normalizeFlow([{ type: "click" }]), /第 1 步（click）缺少 selector/);
  assert.throws(() => normalizeFlow([]), /一步都没有/);
  assert.throws(() => normalizeFlow({ steps: [{ type: "goto", url: "" }] }), /缺少 url/);
  // Every advertised type is runnable, so the table cannot drift from the switch.
  assert.deepEqual(Object.keys(FLOW_STEP_TYPES).sort(), ["assert", "click", "each", "eval", "extract", "goto", "press", "scroll", "type", "wait", "waitFor"].sort());
});

await test("numbers are defaulted rather than passed through as NaN", () => {
  const flow = normalizeFlow([{ type: "waitFor", selector: "#a" }, { type: "wait" }, { type: "each", selector: ".r", fields: { a: ".t" } }, { type: "scroll" }]);
  assert.equal(flow.steps[0].ms, 15000);
  assert.equal(flow.steps[1].ms, 500);
  assert.equal(flow.steps[2].limit, 50);
  assert.equal(flow.steps[3].times, 1);
  assert.equal(flow.steps[3].to, "bottom");
});

await test("the page-side reader takes text, @attr and @text, and blanks a missing column instead of dropping it", () => {
  const expression = extractExpression({ fields: { name: ".title", link: "a@href", own: "@text" }, selector: ".card" });
  assert.match(expression, /document\.querySelectorAll\(".card"\)/);
  for (const needle of ["getAttribute(attr)", "innerText ?? target.textContent", 'attr !== "text"']) {
    assert.ok(expression.includes(needle), `${needle} is in the reader`);
  }
  // A single-element extraction picks one node, not a list.
  assert.match(extractExpression({ fields: { a: ".t" }, selector: "#only", single: true }), /querySelector\("#only"\)/);
  assert.throws(() => extractExpression({ fields: {} }), /至少需要一个字段/);
});

await test("a run reports every step, in order, with timing", async () => {
  const session = fakeSession((expression) => {
    if (expression === "document.title") return "首页";
    if (expression.startsWith("Boolean(")) return true;
    if (expression.includes(".map(read)")) return [{ title: "A" }, { title: "B" }];
    if (expression.trim() === "1+1") return 2;
    return "";
  });
  const result = await runFlow({
    session,
    spec: {
      name: "demo",
      steps: [
        { type: "goto", url: "https://example.com" },
        { type: "waitFor", selector: "#ready" },
        { type: "extract", fields: { title: ".title" } },
        { type: "eval", expression: "1+1", into: "answer" },
      ],
    },
  });
  assert.equal(result.steps.length, 4);
  assert.deepEqual(result.steps.map((step) => step.type), ["goto", "waitFor", "extract", "eval"]);
  assert.ok(result.steps.every((step) => step.ok), "no step failed");
  assert.deepEqual(result.rows, [{ title: "A" }, { title: "B" }]);
  assert.equal(result.values.answer, 2);
  assert.match(formatFlowResult(result), /共 2 条/);
  assert.match(formatFlowResult(result), /answer=2/);
});

await test("each walks the rows by index and collects one row per match", async () => {
  const session = fakeSession((expression) => {
    if (expression.includes(".length")) return 3;
    if (expression.includes("[read(el)]")) return [{ name: "row" }];
    return "";
  });
  const result = await runFlow({ session, spec: [{ type: "each", selector: ".item", fields: { name: ".t" }, limit: 2 }] });
  assert.deepEqual(result.rows, [{ name: "row" }, { name: "row" }]);
  // The limit is honoured: three matched, two walked.
  const evaluated = session.sent.filter((call) => call.method === "Runtime.evaluate");
  assert.equal(evaluated.filter((call) => String(call.params.expression).includes("[read(el)]")).length, 2);
});

await test("a failing step names itself and keeps the rows already collected", async () => {
  const session = fakeSession((expression) => {
    if (expression.startsWith("Boolean(")) return false;
    if (expression.includes(".map(read)")) return [{ id: "1" }];
    return "";
  });
  await assert.rejects(
    () => runFlow({ session, spec: [{ type: "extract", fields: { id: "@data-id" } }, { type: "waitFor", selector: "#never", ms: 30 }] }),
    (error) => {
      assert.match(error.message, /第 2 步（waitFor）失败/);
      assert.deepEqual(error.result.rows, [{ id: "1" }], "the rows before the failure are attached to the error");
      return true;
    },
  );
});

await test("recording is started in the page and read back from sessionStorage", async () => {
  const session = fakeSession((expression) => {
    if (expression.includes("sessionStorage.setItem(\"__dshRecording\", \"0\")")) return [{ type: "click", selector: "#a" }, { type: "press", key: "Enter" }];
    return true;
  });
  await startRecording(session);
  assert.ok(session.sent.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument"), "the recorder survives navigation");
  const flow = await stopRecording(session);
  assert.equal(flow.steps.length, 2);
  assert.equal(flow.steps[0].selector, "#a");
  // The recorded flow is runnable without editing: normalization accepts it as it is.
  assert.equal(normalizeFlow(flow).steps.length, 2);
});

// The plugin's own wiring: three new tools, one shared session, and the runner packaged with the plugin.
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = joinPath(dirname(fileURLToPath(import.meta.url)), "..");

await test("the flow tools are registered against the shared browser session", () => {
  const host = readFileSync(joinPath(pluginDir, "index.js"), "utf8");
  for (const name of ["browser_eval", "browser_flow", "browser_record"]) {
    assert.match(host, new RegExp(`"${name}"`), `${name} is defined`);
  }
  assert.match(host, /browserCloseTool, browserEvalTool, browserFlowTool, browserRecordTool,/, "registered in the same loop as the other browser tools");
  assert.match(host, /const \{ live \} = await browserEnsure\(\);\s*\n\s*const flowMod = await import\("\.\/flow\.js"\)/, "the flow tools act on the shared page");
});

await test("flow.js is shipped with the package", () => {
  const pkg = JSON.parse(readFileSync(joinPath(pluginDir, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("flow.js"), "flow.js is in the published files");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
