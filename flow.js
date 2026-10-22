/**
 * Flow automation: a recorded or hand-written list of steps the browser replays by itself.
 *
 * This is the part of the plugin that does what 影刀 (YingDao RPA) does for a person who does not want to click
 * through the same twenty pages every morning:
 *
 *   record   walk the task once; every click, every typed value and every Enter becomes a step
 *   run      replay the steps over CDP, collect what `extract`/`each` steps read, and report per-step timing
 *   save     the flow is plain JSON, so it can be kept in a file, edited, or handed to somebody else
 *
 * Three shapes are deliberately **not** here. No screenshots inside a flow (the caller saves those), no waits longer
 * than a minute by default (a flow that hangs should fail and say where), and no hidden state between steps other than
 * `flow.vars` - a step that needs data from a previous one asks for it by name, so a flow stays readable in a diff.
 *
 * The step vocabulary is small on purpose. Every type below is something a real page needed while this was written
 * against Google Maps' result list: click a button, type into a box, press Enter, wait for the marker that a page
 * changed, scroll the feed, read a row, loop over the rows, and jump out to raw JavaScript when a site is too clever
 * for selectors. The last one is the escape hatch, not the way through.
 */

import { stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { browserEvaluate, browserClick, browserOpen, browserType } from "./browser.js";

/** Every step type a flow may contain, with the one field it cannot do without. */
export const FLOW_STEP_TYPES = Object.freeze({
  goto: "url",
  click: "selector",
  type: "selector",
  press: "key",
  wait: "",
  waitFor: "selector",
  scroll: "",
  extract: "fields",
  each: "selector",
  eval: "expression",
  assert: "selector",
  waitIdle: "",
});

/** Default ceiling for `waitFor`; long enough for a slow list, short enough to fail rather than hang. */
const DEFAULT_WAIT_MS = 15000;

/** Key names a person writes, mapped to what CDP's `Input.dispatchKeyEvent` needs. */
const KEY_CODES = Object.freeze({
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
});

/**
 * Read a flow definition into the shape the runner uses, refusing what it cannot run.
 *
 * Two spellings are accepted because both occur in practice: a bare array of steps (`[{type:"goto",…}]`), which is
 * what a recording produces, and an object with `name`/`url`/`steps`, which is what a saved file looks like. The
 * `url` is optional shorthand: when present it becomes the first `goto`, so a one-page scrape needs no step at all.
 */
export function normalizeFlow(spec) {
  const raw = typeof spec === "string" ? JSON.parse(spec) : spec;
  const object = Array.isArray(raw) ? { steps: raw } : (raw && typeof raw === "object" ? raw : null);
  if (!object) throw new Error("流程必须是步骤数组，或带 steps 的对象");
  const steps = Array.isArray(object.steps) ? object.steps : [];
  const start = String(object.url ?? "").trim();
  const list = start ? [{ type: "goto", url: start }, ...steps] : steps;
  if (list.length === 0) throw new Error("流程里一步都没有");
  const name = String(object.name ?? "").trim() || "未命名流程";
  const normalized = list.map((step, index) => normalizeStep(step, index));
  return { name, url: start, steps: normalized, vars: { ...(object.vars ?? {}) } };
}

/** One step, with its required field checked and its numbers defaulted. */
function normalizeStep(step, index) {
  const at = `第 ${index + 1} 步`;
  if (!step || typeof step !== "object") throw new Error(`${at} 不是一个对象`);
  const type = String(step.type ?? "").trim();
  // Own-property rather than truthiness: `wait` and `scroll` have no required field, and an empty string is falsy.
  if (!Object.prototype.hasOwnProperty.call(FLOW_STEP_TYPES, type)) {
    throw new Error(`${at} 的类型 "${type || "（空）"}" 不认识，可用：${Object.keys(FLOW_STEP_TYPES).join(" / ")}`);
  }
  const required = FLOW_STEP_TYPES[type];
  if (required && String(step[required] ?? "").trim() === "") {
    throw new Error(`${at}（${type}）缺少 ${required}`);
  }
  const copy = { ...step, type };
  if (type === "waitFor") copy.ms = positive(copy.ms, DEFAULT_WAIT_MS);
  if (type === "wait") copy.ms = positive(copy.ms, 500);
  if (type === "each") copy.limit = positive(copy.limit, 50);
  if (type === "scroll") {
    copy.times = positive(copy.times, 1);
    copy.to = copy.to === "top" ? "top" : "bottom";
  }
  if (type === "type") copy.clear = copy.clear !== false;
  return copy;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * The page-side code that reads one element's fields, as a function body.
 *
 * `fields` maps an output column to a CSS selector, optionally with `@attribute` (`"a.name@href"`) or `@text` for the
 * element's own text. A field whose selector does not match becomes an empty string rather than a missing key: a row
 * with one blank column is data, a row with a different shape is a bug that shows up three steps later.
 */
export function extractExpression({ fields, selector = "", single = false, limit = 0 } = {}) {
  const columns = columnPayload(fields);
  const read = readerSnippet(columns);
  if (single) {
    const pick = selector ? `document.querySelector(${JSON.stringify(String(selector))})` : "document.body";
    return `(() => { ${read}; const el = ${pick}; return el ? read(el) : []; })()`;
  }
  const all = `Array.from(document.querySelectorAll(${JSON.stringify(String(selector || "body"))}))`;
  const slice = limit > 0 ? `.slice(0, ${Number(limit)})` : "";
  return `(() => { ${read}; return ${all}${slice}.map(read); })()`;
}

/** The `read(el)` function and its column table, shared by every extraction shape. */
function readerSnippet(columns) {
  return `const columns = ${JSON.stringify(columns)};
    const read = (el) => {
      const row = {};
      for (const [name, spec] of columns) {
        const at = spec.indexOf("@");
        const sel = at >= 0 ? spec.slice(0, at) : spec;
        const attr = at >= 0 ? spec.slice(at + 1) : "";
        let target = el;
        if (sel) { try { target = el.querySelector(sel); } catch { target = null; } }
        if (!target) { row[name] = ""; continue; }
        row[name] = attr && attr !== "text"
          ? String(target.getAttribute(attr) ?? "").trim()
          : String(target.innerText ?? target.textContent ?? "").trim();
      }
      return row;
    };`;
}

/** Validate the `fields` map and turn it into the pairs the page-side reader expects. */
function columnPayload(fields) {
  const columns = Object.entries(fields ?? {}).map(([name, spec]) => [String(name), String(spec ?? "")]);
  if (columns.length === 0) throw new Error("extract 至少需要一个字段");
  return columns;
}

/**
 * Replay a flow against a live CDP session.
 *
 * `session` is the shared page session the plugin already holds. Steps run in order; a failing step aborts the run
 * with the step number *and* whatever rows earlier steps collected, because "it broke after 12 rows" is the useful
 * report - an empty error is not.
 */
export async function runFlow({ session, spec, onStep } = {}) {
  const flow = normalizeFlow(spec);
  const result = { name: flow.name, rows: [], values: {}, steps: [], startedAt: Date.now() };
  for (let index = 0; index < flow.steps.length; index += 1) {
    const step = flow.steps[index];
    const began = Date.now();
    try {
      const detail = await runStep(session, step, flow, result);
      const record = { index, type: step.type, ok: true, ms: Date.now() - began, detail: String(detail ?? "") };
      result.steps.push(record);
      onStep?.(record);
    } catch (error) {
      const reason = String(error?.message ?? error);
      result.steps.push({ index, type: step.type, ok: false, ms: Date.now() - began, detail: reason });
      const failure = new Error(`第 ${index + 1} 步（${step.type}）失败：${reason}`);
      failure.result = result;
      throw failure;
    }
  }
  result.ms = Date.now() - result.startedAt;
  return result;
}

/** Dispatch one step. Returns a one-line description for the run report. */
async function runStep(session, step, flow, result) {
  switch (step.type) {
    case "goto": {
      const opened = await browserOpen(session, step.url, { waitMs: positive(step.ms, 20000) });
      return `打开 ${opened.url}（${opened.title || "无标题"}）`;
    }
    case "click": {
      const clicked = await browserClick(session, step.selector);
      return `点击 ${step.selector}${clicked.text ? `（${clicked.text}）` : ""}`;
    }
    case "type": {
      if (step.clear === false) {
        const focused = await browserEvaluate(session, `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (!el) return false; el.focus(); return true; })()`);
        if (!focused) throw new Error(`没有匹配 ${step.selector} 的元素`);
        await session.send("Input.insertText", { text: String(step.text ?? "") });
        return `向 ${step.selector} 追加 ${String(step.text ?? "").length} 个字符`;
      }
      const typed = await browserType(session, step.selector, step.text);
      return `向 ${step.selector} 输入 ${typed.chars} 个字符`;
    }
    case "press": {
      const key = KEY_CODES[String(step.key)];
      const plain = String(step.key ?? "");
      const base = key ?? { key: plain.slice(0, 1), code: `Key${plain.slice(0, 1).toUpperCase()}`, text: plain };
      await session.send("Input.dispatchKeyEvent", { type: base.text ? "keyDown" : "rawKeyDown", ...base });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode });
      return `按下 ${plain}`;
    }
    case "wait": {
      await sleep(step.ms);
      return `等待 ${step.ms}ms`;
    }
    case "waitFor": {
      const found = await waitForSelector(session, step.selector, step.ms);
      if (!found) throw new Error(`等了 ${step.ms}ms 也没出现 ${step.selector}`);
      return `${step.selector} 出现了`;
    }
    case "scroll": {
      for (let round = 0; round < step.times; round += 1) {
        await browserEvaluate(session, scrollExpression(step));
        await sleep(positive(step.pauseMs, 350));
      }
      return `滚动 ${step.times} 次（${step.to}）`;
    }
    case "extract": {
      const rows = await browserEvaluate(session, extractExpression({ fields: step.fields, selector: step.selector, single: Boolean(step.selector) && step.mode !== "list" }));
      const list = Array.isArray(rows) ? rows : [rows];
      if (step.into) result.values[String(step.into)] = list;
      result.rows.push(...list);
      return `读到 ${list.length} 条（字段：${Object.keys(step.fields).join("/")}）`;
    }
    case "each": {
      const columns = columnPayload(step.fields);
      const count = Number(await browserEvaluate(session, `document.querySelectorAll(${JSON.stringify(step.selector)}).length`)) || 0;
      const pages = Math.min(count, step.limit);
      let read = 0;
      for (let index = 0; index < pages; index += 1) {
        // The row is reached by index, and scrolled into view first: a lazy list often renders its text only once the
        // row is on screen, and the counter above was taken a moment ago.
        const expression = `(() => {
          ${readerSnippet(columns)}
          const el = Array.from(document.querySelectorAll(${JSON.stringify(step.selector)}))[${index}];
          if (!el) return [];
          el.scrollIntoView({ block: "center" });
          return [read(el)];
        })()`;
        const rows = await browserEvaluate(session, expression);
        if (Array.isArray(rows) && rows.length) { result.rows.push(...rows); read += 1; }
        if (step.pauseMs) await sleep(step.pauseMs);
      }
      return `遍历 ${pages} 行，读到 ${read} 条`;
    }
    case "eval": {
      const value = await browserEvaluate(session, step.expression);
      if (step.into) result.values[String(step.into)] = value;
      return `执行 JS，结果 ${summarize(value)}`;
    }
    case "waitIdle": {
      // The network layer's "is the page still working?": no request in flight, and nothing new for `idleMs`. Needs
      // `browser_capture action=start` first, because the extension only sees traffic while the Network domain is on.
      const outcome = await session.send("__waitIdle", {
        idleMs: positive(step.idleMs, 500),
        timeoutMs: positive(step.timeoutMs, 15000),
      });
      if (!outcome?.idle) {
        throw new Error(`等了 ${outcome?.waitedMs ?? "?"}ms 网络还没空闲（还有 ${outcome?.inflight ?? "?"} 个请求在飞）`);
      }
      return `网络空闲（${outcome.waitedMs}ms 内没有新请求）`;
    }
    case "assert": {
      const found = await waitForSelector(session, step.selector, positive(step.ms, DEFAULT_WAIT_MS));
      if (!found) throw new Error(`断言失败：页面上没有 ${step.selector}`);
      if (step.text) {
        const text = String(await browserEvaluate(session, `document.querySelector(${JSON.stringify(step.selector)})?.innerText ?? ""`)) ?? "";
        if (!text.includes(String(step.text))) throw new Error(`断言失败：${step.selector} 的文字里没有“${step.text}”`);
      }
      return `断言通过 ${step.selector}`;
    }
    default:
      throw new Error(`不认识的步骤 ${step.type}`);
  }
}

/** The page-side expression for a scroll step: the window, or one scrolling container. */
function scrollExpression(step) {
  const target = step.selector
    ? `document.querySelector(${JSON.stringify(String(step.selector))})`
    : "document.scrollingElement || document.documentElement";
  return `(() => { const el = ${target}; if (!el) return 0; if (${JSON.stringify(step.to)} === "top") { el.scrollTop = 0; return el.scrollTop; } el.scrollTop = el.scrollHeight; return el.scrollTop; })()`;
}

/** Poll for a selector until it appears or the deadline passes. Polling, because a MutationObserver inside a page that
 *  is navigating away never fires and the wait would hang. */
async function waitForSelector(session, selector, ms) {
  const until = Date.now() + positive(ms, DEFAULT_WAIT_MS);
  for (;;) {
    const found = await browserEvaluate(session, `Boolean(document.querySelector(${JSON.stringify(String(selector))}))`);
    if (found) return true;
    if (Date.now() > until) return false;
    await sleep(200);
  }
}

function summarize(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : (flat || "（空）");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start recording: every click, typed value and Enter in the page becomes a step.
 *
 * The recorder is installed as a **new-document** script as well as on the page in front of us, so the steps survive
 * the navigation a search button usually causes; the collected array lives on `window` and is read back by
 * `stopRecording`. Selection is captured with a selector that a person can edit afterwards: `#id` first, then
 * `[data-*]`, then a short `tag:nth-of-type` path - never a generated class name, which is the one thing that
 * changes between two loads of the same app.
 */
export async function startRecording(session) {
  const source = recorderSource();
  try { await session.send("Page.addScriptToEvaluateOnNewDocument", { source }); } catch { /* page protocol may be off */ }
  await browserEvaluate(session, source);
  await browserEvaluate(session, `(() => { sessionStorage.setItem("__dshRecording", "1"); sessionStorage.setItem("__dshFlowSteps", "[]"); window.__dshRecording = true; return true; })()`);
  return { ok: true };
}

/** Stop recording and return the steps as a runnable flow array. */
export async function stopRecording(session, { name = "录制的流程" } = {}) {
  const steps = await browserEvaluate(session, `(() => { sessionStorage.setItem("__dshRecording", "0"); window.__dshRecording = false; try { return JSON.parse(sessionStorage.getItem("__dshFlowSteps") || "[]"); } catch { return []; } })()`);
  const list = Array.isArray(steps) ? steps : [];
  return { name, url: "", steps: list };
}

/** The in-page recorder, as a string of JavaScript. Kept here (not as a file) so a packaged install has one import. */
function recorderSource() {
  return `(() => {
    if (window.__dshRecorderInstalled) return true;
    window.__dshRecorderInstalled = true;
    const KEY = "__dshFlowSteps";
    // The list lives in sessionStorage, not a plain variable: a search button navigates, and steps recorded on the
    // previous page must survive that navigation to be replayed later.
    const list = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch { return []; } };
    const enabled = () => { try { return sessionStorage.getItem("__dshRecording") === "1"; } catch { return Boolean(window.__dshRecording); } };
    const push = (step) => {
      if (!enabled()) return;
      const steps = list();
      const last = steps[steps.length - 1];
      if (last && JSON.stringify(last) === JSON.stringify(step)) return;
      steps.push(step);
      try { sessionStorage.setItem(KEY, JSON.stringify(steps)); } catch { /* quota: the run still has its page */ }
    };
    const selectorOf = (el) => {
      if (!el || el.nodeType !== 1) return "";
      if (el.id) return "#" + CSS.escape(el.id);
      for (const attr of Array.from(el.attributes || [])) {
        if (attr.name.startsWith("data-") && attr.value && attr.value.length < 60) {
          return el.tagName.toLowerCase() + "[" + attr.name + "=" + JSON.stringify(attr.value) + "]";
        }
      }
      const parts = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth += 1) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
        if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
        node = parent;
      }
      return parts.join(" > ");
    };
    document.addEventListener("click", (event) => {
      const el = event.target && event.target.closest ? event.target.closest("a,button,input,select,textarea,[role=button],[role=option]") || event.target : event.target;
      push({ type: "click", selector: selectorOf(el) });
    }, true);
    document.addEventListener("change", (event) => {
      const el = event.target;
      if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName || "")) return;
      push({ type: "type", selector: selectorOf(el), text: String(el.value ?? "") });
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter") push({ type: "press", key: "Enter" });
    }, true);
    // Scroll fires dozens of times per gesture, and a flow with forty "scroll" steps is unreadable. One step per
    // pause is what a person means by "scroll down and wait for the next page".
    let scrolling = false;
    document.addEventListener("scroll", () => {
      if (scrolling) return;
      scrolling = true;
      setTimeout(() => { scrolling = false; }, 1500);
      push({ type: "scroll", to: "bottom", times: 1 });
    }, true);
    return true;
  })()`;
}

/** A run report a chat can read: the flow name, the timing, per-step lines and the collected rows as a table. */
export function formatFlowResult(result, { maxRows = 20 } = {}) {
  const lines = [`流程「${result.name}」完成 ${result.steps.length} 步，用时 ${(result.ms ?? 0) / 1000}s`];
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? "✓" : "✗"} ${step.index + 1}. ${step.type} · ${step.ms}ms${step.detail ? ` · ${step.detail}` : ""}`);
  }
  if (result.rows.length) {
    const columns = Object.keys(result.rows[0]);
    lines.push("", `共 ${result.rows.length} 条：`);
    lines.push(`  ${columns.join(" | ")}`);
    for (const row of result.rows.slice(0, maxRows)) lines.push(`  ${columns.map((column) => String(row[column] ?? "")).join(" | ")}`);
    if (result.rows.length > maxRows) lines.push(`  …（还有 ${result.rows.length - maxRows} 条）`);
  }
  const values = Object.entries(result.values ?? {});
  if (values.length) lines.push("", `变量：${values.map(([name, value]) => `${name}=${summarize(value)}`).join("，")}`);
  return lines.join("\n");
}

/**
 * `~`, `~/x` and `~\x` as the current user's home. Everything else comes back unchanged, so a Windows path or a
 * Chinese path is passed through untouched.
 */
export function expandHome(value, home = homedir()) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(home, text.slice(2));
  return text;
}

/** A file name from a flow name and a time: `maps-coffee-2026-10-21T05-12-33.csv`, with the illegal bits removed. */
export function exportFileName(name, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = String(name ?? "flow")
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "flow";
  return `${slug}-${stamp}.csv`;
}

/**
 * Work out the file a `save` argument means.
 *
 * Three shapes are accepted, because three are what people type: a full path to a file (`D:\导出\门店.csv`), a folder
 * - existing, trailing separator, or with no extension (`D:\导出`) - where the flow name and a timestamp name the
 * file, and a bare name (`out.csv`) which lands in `base`. The result is always absolute, so the report can show
 * exactly where the file went; `resolveExportPath` also creates the parent directory, because a save that fails on a
 * missing folder is a save that never happened.
 */
export async function resolveExportPath(raw, { base = "", name = "flow", home, statImpl = stat, mkdirImpl = mkdir, now = new Date() } = {}) {
  const wanted = expandHome(raw, home);
  if (!wanted) throw new Error("save 是空的：给文件名（out.csv）、目录（D:\\导出）或完整路径");
  let path = isAbsolute(wanted) ? wanted : join(base || process.cwd(), wanted);
  const trailing = /[\\/]$/.test(wanted);
  const hasExtension = /\.[a-z0-9]{1,8}$/i.test(wanted);
  let isDirectory = trailing || !hasExtension;
  if (!isDirectory) {
    // A folder spelled without a trailing slash is still a folder, and writing "…/导出" as a file would be wrong.
    try {
      const info = await statImpl(path);
      if (info.isDirectory()) isDirectory = true;
    } catch { /* it does not exist yet: the extension decides */ }
  }
  if (isDirectory) path = join(path, exportFileName(name, now));
  await mkdirImpl(dirname(path), { recursive: true });
  return path;
}

/**
 * Walk a dotted path into a parsed JSON value: `data.list[0]`, `items.0.name`.
 *
 * Written down because "the array is at some path" is the one thing a captured payload always needs and nobody wants
 * to hand-write a `reduce` for. A missing step returns `undefined` rather than throwing: the caller is looking for a
 * shape in a payload it has not seen, and "not here" is a normal answer.
 */
export function pickPath(value, path) {
  const text = String(path ?? "").trim();
  if (!text) return value;
  let current = value;
  for (const raw of text.split(".")) {
    if (current === null || current === undefined) return undefined;
    const key = raw.trim();
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(key);
    const head = match ? match[1] : key;
    if (head) current = current[head];
    const indexes = match ? match[2] : "";
    for (const hit of indexes.matchAll(/\[(\d+)\]/g)) {
      current = Array.isArray(current) ? current[Number(hit[1])] : undefined;
    }
  }
  return current;
}

/**
 * Turn one JSON array into rows with named columns.
 *
 * `fields` maps a column to a dotted path inside each item (`{"名称": "name", "评分": "rating.value"}`). Without it the
 * item is used as-is, which is right for already-tabular payloads and wrong for nothing.
 */
export function flattenRows(items, fields) {
  const list = Array.isArray(items) ? items : [];
  if (!fields || Object.keys(fields).length === 0) return list.map((item) => ({ ...item }));
  const spec = Object.entries(fields);
  return list.map((item) => {
    const row = {};
    for (const [column, path] of spec) {
      const value = pickPath(item, path);
      row[column] = value === null || value === undefined
        ? ""
        : (typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return row;
  });
}

/** The biggest array of objects inside a payload, at `path` when given. Used when the shape is not known yet. */
export function biggestObjectArray(payload, path = "") {
  const target = pickPath(payload, path);
  if (Array.isArray(target) && target.length && typeof target[0] === "object") return target;
  if (path) return null;
  let best = null;
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object" && (!best || node.length > best.length)) best = node;
      for (const item of node.slice(0, 5)) walk(item, depth + 1);
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return best;
}
