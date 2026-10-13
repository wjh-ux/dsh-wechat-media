/**
 * Offline shape-check for client.js (the browser card).
 *
 * Evaluates the file the way dsh's browser module table does - a plain script
 * that self-registers with window.__ModuleLoader__ - then runs apply(ctx) against
 * a stubbed cordis context and renders the card in both views. It catches syntax
 * errors, a missing wrapper, a wrong inject list and crashes while rendering.
 *
 * Run: node test/client.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, "..", "client.js"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useEffect: (fn) => { try { fn(); } catch (error) { console.log("   ! effect threw:", error.message); } },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

function shimRequire(name) {
  if (name === "react") return reactStub;
  if (name === "react/jsx-runtime") return { jsx: () => ({}), jsxs: () => ({}), Fragment: "Fragment" };
  return {};
}

const captured = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => captured.push(definition) } };
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, accounts: [], logins: [] }) });
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

test("the module self-registers under its package name", () => {
  new Function(code)();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].id, "dsh-wechat-media");
  assert.equal(typeof captured[0].factory, "function");
});

const api = captured[0]?.factory(shimRequire);
const seen = { effects: [], locale: [], slots: [] };
const ctx = {
  effect: (fn, label) => {
    seen.effects.push(label);
    try { fn(); } catch (error) { console.log("   ! effect threw:", label, error.message); }
  },
  locale: { register: (ns, table) => { seen.locale.push(`${ns}:${Object.keys(table).join("/")}`); } },
  slots: {
    inject: (name, cb) => { cb(); },
    register: (definition, component) => { seen.slots.push({ definition, component }); return () => {}; },
  },
};

test("exports apply and the client service names", () => {
  assert.equal(typeof api.apply, "function");
  // Service names only: the packages that must load first live in package.json.
  assert.deepEqual(api.inject, ["slots", "locale"]);
  assert.ok(!api.inject.some((name) => name.startsWith("@deepseek-ai/")));
});

test("apply registers both plugin-panel slots without throwing", () => {
  api.apply(ctx);
  assert.equal(seen.slots.length, 2);
  assert.deepEqual(seen.slots.map((slot) => slot.definition.name), ["plugins.bundle.config", "plugins.row.config"]);
  assert.deepEqual(seen.slots.map((slot) => slot.definition.key), ["dsh-wechat-media", "dsh-wechat-media#wechat-media"]);
  assert.ok(seen.locale.some((entry) => entry.startsWith("dsh-wechat-media:")));
});

test("the card renders in both views", () => {
  const card = seen.slots[0].component;
  const page = card({ t: (key) => key, view: "page" });
  const summary = card({ t: (key) => key, view: "summary" });
  assert.equal(page?.type, "div");
  assert.ok(Array.isArray(page.children));
  assert.equal(summary?.type, "span");
});

test("adding another account is always offered", () => {
  // Regression guard: the add button used to switch to a "pair again" label once
  // an account existed, which hid the fact that a second account can be added.
  assert.match(code, /t\("addAccount"/);
  assert.match(code, /t\("rescanAccount"/);
  assert.ok(!/t\("rescan"/.test(code), "the old ambiguous label must be gone");
  assert.ok(
    !/pairedCount === 0\s*\?\s*t\("addAccount"/.test(code),
    "the add button must not be conditional on having no accounts yet",
  );
  assert.match(code, /t\("logout"/);
  for (const key of ["addAccount", "rescanAccount", "pairingNow"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
});

test("a pairing attempt can be cancelled", () => {
  // A QR shown by mistake must be dismissible without waiting for it to expire.
  assert.match(code, /\/login\/\$\{loginId\}\/cancel|login\/\$\{pending\.id\}\/cancel|\/cancel/);
  assert.match(code, /t\("cancel"/);
  for (const key of ["cancel"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  // The host side has to offer the route the card calls.
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /action === "cancel"/, "index.js must handle the cancel action");
  assert.match(host, /logins\.cancel\(/, "index.js must cancel the login session");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
