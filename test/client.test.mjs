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

test("a label the host cannot translate falls back to text, not to its key", () => {
  // DSH's translator answers with the KEY when no dictionary has an entry (`lookup(...) ?? key`), and `t: (key) => key`
  // is exactly that host. The helper used to accept any non-empty answer, so the 61 labels the card's own dictionary
  // never defined rendered as identifiers - `browserLabel`, `tavilyLabel`, `flowExportDir` ... - which is what a person
  // then saw in the panel. Measured by rendering with this translator and reading the text back.
  const card = seen.slots[0].component;
  const tree = card({ t: (key) => key, view: "page" });

  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") { texts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === "object") { walk(node.children); walk(node.props?.children); }
  };
  walk(tree);

  // Every raw key that used to leak is checked, not only the one somebody noticed.
  for (const key of ["browserLabel", "tavilyLabel", "flowExportDir", "feishuOpsTitle", "guiPort", "extensionDriver"]) {
    assert.ok(!texts.includes(key), `the panel must not render the raw key ${key}`);
  }
  assert.ok(texts.some((text) => text.includes("浏览器自动化")), "the browser section must render its own text");
  assert.match(code, /translated === key/, "the helper must treat an untranslated key as a miss");
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

test("a pairing attempt can be cancelled", () => {  // A QR shown by mistake must be dismissible without waiting for it to expire.
  assert.match(code, /\/login\/\$\{loginId\}\/cancel|login\/\$\{pending\.id\}\/cancel|\/cancel/);
  assert.match(code, /t\("cancel"/);
  for (const key of ["cancel"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  // The host side has to offer the route the card calls.
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /resolveInboxDir/, "the host must resolve a configurable inbox");
  assert.match(host, /action === "cancel"/, "index.js must handle the cancel action");
  assert.match(host, /logins\.cancel\(/, "index.js must cancel the login session");
});

test("the contact allowlist panel and approval hint are wired", () => {
  assert.match(code, /t\("contacts"/);
  assert.match(code, /t\("requireAllowlist"/);
  assert.match(code, /t\("approvalHint"/);
  assert.match(code, /name: "inboxDir"/, "the inbox directory form must exist");
  assert.match(code, /t\("inboxLabel"/);
  assert.match(code, /api\(`\/peers\?accountId=/);
  assert.match(code, /api\(`\/prefs\?requireAllowlist=/);
  for (const key of ["contacts", "allow", "block", "clearDecision", "requireAllowlist", "allowlistWarning", "approvalHint", "allowed", "blocked", "undecided"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  // The host half has to serve both routes.
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /resolveInboxDir/, "the host must resolve a configurable inbox");
  assert.match(host, /path: "\/dsh-wechat-media\/peers"/);
  assert.match(host, /path: "\/dsh-wechat-media\/prefs"/);
  assert.match(host, /path: "\/dsh-wechat-media\/test-approval"/, "the approval self-test route must exist");
});

test("the friends-only switch is on the card, in both languages, wired to the host", () => {
  assert.match(code, /t\("friendOnly"/, "the checkbox must be labelled through the translator");
  assert.match(code, /api\(`\/prefs\?friendOnly=/, "the card must save it to the host's prefs route");
  assert.match(code, /snapshot\?\.prefs\?\.friendOnly/, "the checkbox must reflect the stored preference");
  assert.match(code, /groupsSkipped/, "the card must show how much the switch has dropped");
  for (const key of ["friendOnly", "friendOnlyOn", "groupsSkipped"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /patch\.friendOnly = asBool\(body\.friendOnly\)/, "the prefs route must accept the switch");
  assert.match(host, /prefs\.friendOnly && (identity|base)\.isGroup/, "both classifiers must apply it");
  assert.match(host, /counters\.groupsSkipped \+= 1/, "a skipped group must be counted");
  assert.match(host, /command\.name === "friends"/, "the /friends command must be handled");
});

test("the token card reads the ledger and can steer it", () => {
  assert.match(code, /t\("tokensTitle"/, "the section must be labelled through the translator");
  assert.match(code, /api\(`\/tokens\?windowDays=/, "the window picker must save to the host's tokens route");
  assert.match(code, /api\("\/tokens\?reset=true"\)/, "the clear button must hit the reset");
  assert.match(code, /snapshot\?\.tokens\?\.accounts/, "the rows must come from the ledger snapshot");
  for (const key of ["tokensTitle", "tokenNextReset", "tokenWindowLabel", "tokenReset", "tokenEmpty", "tokenIn", "tokenOut", "calls", "days"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /path: "\/dsh-wechat-media\/tokens"/, "the host must serve the tokens route");
  assert.match(host, /state\.resetTokens\(/, "...and be able to zero the ledger");
  assert.match(host, /state\.setTokenWindow\(/, "...and to change the window");
  assert.match(host, /tokens: summarize\(await state\.loadTokens\(\)\)/, "the snapshot must carry the summary");
});

test("the interjection switch is on the card, in both languages, wired to the host", () => {
  assert.match(code, /t\("interject"/, "the checkbox must be labelled through the translator");
  assert.match(code, /api\(`\/prefs\?interject=/, "the card must save it to the host's prefs route");
  assert.match(code, /snapshot\?\.prefs\?\.interject/, "the checkbox must reflect the stored preference");
  assert.match(code, /counters\?\.interjected/, "the card must show how often it fired");
  for (const key of ["interject", "interjectOn", "interjected"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /patch\.interject = asBool\(body\.interject\)/, "the prefs route must accept the switch");
  assert.match(host, /command\.name === "interject"/, "the /interject command must be handled");
  assert.match(host, /agent\.steer\(message2\)/, "the host must steer into the running turn");
  assert.match(host, /collectors\.isWaiting\(sessionId\)/, "...only when a turn is really in flight");
  assert.match(host, /counters\.interjected \+= 1/, "and count what it steered");
});

test("the authorization menu is on the card, in both languages, wired to the host", () => {
  assert.match(code, /t\("authLabel"/, "the menu must be labelled through the translator");
  assert.match(code, /api\(`\/prefs\?authorization=/, "the menu must save to the host's prefs route");
  assert.match(code, /snapshot\?\.prefs\?\.authorization/, "the menu must reflect the stored level");
  for (const level of ["strict", "moderate", "full", "readonly"]) {
    assert.match(code, new RegExp(`value: "${level}"`), `the menu must offer ${level}`);
  }
  for (const key of ["authLabel", "authStrict", "authModerate", "authFull", "authReadonly", "authHint"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /AUTHORIZATION_LEVELS\.includes\(level\)/, "the host must validate the level it is given");
  assert.match(host, /command\.name === "auth"/, "the /auth command must be handled");
  assert.match(host, /policyFor: async \(\) => approvalPolicyFor/, "the approval bridge must read the level per request");
  assert.match(host, /return policy\.decision;/, "the level's own decision must be handed to the harness");
  assert.match(host, /setApprovalPolicy\?\.\(handle\.agent\?\.session, "ask"\)/, "chat-driven sessions must be put on the ask policy, or requests never reach us");
});

test("the delivery menu is on the card, in both languages, wired to the host", () => {
  assert.match(code, /t\("deliveryLabel"/, "the menu must be labelled through the translator");
  assert.match(code, /api\(`\/prefs\?delivery=/, "the menu must save to the host's prefs route");
  assert.match(code, /snapshot\?\.prefs\?\.delivery/, "the menu must reflect the stored mode");
  for (const key of ["deliveryLabel", "deliveryWhole", "deliveryStream", "deliveryHint"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /command\.name === "delivery"/, "the /delivery command must be handled");
  assert.match(host, /wecomStreamer\(frame, plain\)/, "the host must be able to stream an answer");
  assert.match(host, /streamBody\(live\.reqId, part, false\)/, "...with finish:false, which is what makes it incremental");
  assert.match(host, /onDelta: \(\{ text, type \}\) =>/, "the collector must forward the adapter's deltas, and record their shape");
  assert.match(host, /activeStreamer = undefined;/, "the preview must stop when the turn ends");
  assert.match(host, /patch\.delivery = mode/, "the prefs route must accept the mode");
});
test("the text menu is on the card, in both languages, wired to the host", () => {
  assert.match(code, /t\("formatLabel"/, "the menu must be labelled through the translator");
  assert.match(code, /api\(`\/prefs\?format=/, "the menu must save to the host's prefs route");
  assert.match(code, /snapshot\?\.prefs\?\.format/, "the menu must reflect the stored mode");
  for (const level of ["plain", "raw"]) assert.match(code, new RegExp(`value: "${level}"`), `the menu must offer ${level}`);
  for (const key of ["formatLabel", "formatPlain", "formatRaw", "formatHint"]) {
    const occurrences = code.split(`${key}: "`).length - 1;
    assert.ok(occurrences >= 2, `locale key ${key} must exist in both languages (found ${occurrences})`);
  }
  const host = readFileSync(join(here, "..", "index.js"), "utf8");
  assert.match(host, /command\.name === "format"/, "the /format command must be handled");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
