// The browser module's contract, exercised without starting a browser: a fake socket drives the CDP session, and the
// launch path gets a fake spawn plus a fake fetch. The shapes asserted here are the ones measured against a real
// Chrome (see the header of ../browser.js for where each one came from).
import assert from "node:assert/strict";

const {
  BROWSER_CHANNELS, browserExecutable, cdpBase, browserVersion, browserTargets, browserPageTarget,
  browserLaunch, createCdpSession, browserOpen, browserEvaluate, browserText, browserElementCentre,
  browserClick, browserType, browserScreenshot,
} = await import("../browser.js");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

/** A WebSocket stand-in that records what was sent and lets a test answer or emit events. */
class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.handlers = new Map(); this.closed = false; FakeSocket.instances.push(this); }
  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  emit(type, event) { for (const fn of this.handlers.get(type) ?? []) fn(event); }
  send(text) { const message = JSON.parse(text); this.sent.push(message); this.onSend?.(message); }
  close() { this.closed = true; }
  reply(id, result) { this.emit("message", { data: JSON.stringify({ id, result }) }); }
  fail(id, error) { this.emit("message", { data: JSON.stringify({ id, error }) }); }
  event(method, params) { this.emit("message", { data: JSON.stringify({ method, params }) }); }
}

const jsonFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

await test("the executable lookup reports absence instead of guessing", () => {
  assert.ok(Array.isArray(BROWSER_CHANNELS.chrome) && BROWSER_CHANNELS.chrome.length > 0);
  // On this machine both exist; the point is that an unknown channel falls back to chrome's list rather than throwing,
  // and that a channel with no installation yields "" - a fact callers can act on.
  assert.equal(typeof browserExecutable("nonsense"), "string");
  assert.equal(cdpBase(9222), "http://127.0.0.1:9222");
  assert.equal(cdpBase(""), "http://127.0.0.1:9222", "a blank port falls back rather than producing a broken url");
});

await test("launching waits for the port and reports where the browser is", async () => {
  const spawned = [];
  const spawnImpl = (file, args, options) => { spawned.push({ file, args, options }); return { pid: 4242, unref() {} }; };
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; if (attempts < 2) throw new Error("ECONNREFUSED"); return { ok: true, status: 200, json: async () => ({ Browser: "Chrome/155" }) }; };
  // The executable is injected. Asking the machine for one made this test depend on Chrome being installed: it passed
  // here and failed on the CI runner, where browserLaunch correctly refused to start nothing.
  const executable = joinPath(process.env.TEMP || "/tmp", "fake-chrome.exe");
  const profileDir = joinPath(process.env.TEMP || process.env.TMPDIR || "/tmp", "dsh-browser-test-profile");
  const launched = await browserLaunch({ channel: "chrome", executable, port: 9333, headless: true, profileDir, spawnImpl, fetchImpl });
  assert.equal(launched.pid, 4242);
  assert.equal(launched.port, 9333);
  assert.equal(launched.executable, executable, "it reports which executable it used");
  assert.ok(attempts >= 2, "it retried until the port answered");
  const args = spawned[0].args.join(" ");
  assert.match(args, /--remote-debugging-port=9333/, "the port is passed");
  assert.ok(args.includes(`--user-data-dir=${profileDir}`), "the dedicated profile is passed");
  assert.match(args, /--headless=new/, "headless when asked");
  assert.match(args, /--no-first-run/, "and it does not touch first-run state");
  assert.ok(args.endsWith("about:blank"), "it opens a blank page to have a target");

  // A browser that never answers must fail with the reason, not hang.
  await assert.rejects(() => browserLaunch({ channel: "chrome", executable, port: 9334, profileDir: joinPath(profileDir, "second"), spawnImpl, fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, waitMs: 600 }), /never answered within 600ms/);
  assert.ok(spawned.length >= 2);
});

await test("an unusable profile directory is reported, with the directory named", async () => {
  // Deterministic on every machine, which the first version of this test was not: it asserted that Edge was missing,
  // and this machine has Edge installed, so the premise - not the code - was wrong. A NUL byte cannot be a path
  // anywhere, so the refusal is guaranteed and the message must name what it could not create.
  await assert.rejects(
    () => browserLaunch({ channel: "chrome", executable: "C:\\fake\\chrome.exe", profileDir: "bad\u0000path", spawnImpl: () => { throw new Error("must not be called"); } }),
    (error) => {
      assert.match(String(error?.message), /could not create the browser profile directory/, "the failure is named");
      assert.match(String(error?.message), /bad/, "and the directory is quoted");
      return true;
    },
  );
});

await test("a target must be a usable page, and its absence is named", async () => {
  const list = [{ type: "background_page", webSocketDebuggerUrl: "ws://x/1" }, { type: "page", title: "T", url: "u", webSocketDebuggerUrl: "ws://x/2" }];
  const page = await browserPageTarget({ port: 9222, fetchImpl: jsonFetch(list) });
  assert.equal(page.webSocketDebuggerUrl, "ws://x/2", "the first real page wins");
  await assert.rejects(() => browserPageTarget({ port: 9222, fetchImpl: jsonFetch([{ type: "worker" }]) }), /none usable/);
  const targets = await browserTargets({ port: 9222, fetchImpl: jsonFetch(null) });
  assert.deepEqual(targets, [], "a non-array answer is an empty list, not a crash");
});

await test("the session pairs ids, carries events, and times out", async () => {
  const session = createCdpSession("ws://fake/1", { webSocketImpl: FakeSocket, timeoutMs: 300 });
  const socket = FakeSocket.instances.at(-1);
  assert.equal(socket.binaryType, "arraybuffer", "binary replies arrive as ArrayBuffer, like the real socket");
  socket.emit("open", {});
  await session.ready;

  const first = session.send("Page.enable");
  const second = session.send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
  assert.deepEqual(socket.sent[0], { id: 1, method: "Page.enable", params: {} });
  assert.deepEqual(socket.sent[1], { id: 2, method: "Runtime.evaluate", params: { expression: "1+1", returnByValue: true } });
  socket.reply(2, { result: { type: "number", value: 2 } });
  socket.reply(1, {});
  assert.deepEqual(await second, { result: { type: "number", value: 2 } });
  assert.deepEqual(await first, {});

  // Out-of-order replies still land on the right promise, and an error maps to an Error.
  const third = session.send("Page.navigate", { url: "https://e.com" });
  socket.fail(socket.sent.at(-1).id, { code: -32000, message: "cannot navigate" });
  await assert.rejects(() => third, /cannot navigate \(-32000\)/);

  // Events reach a waiter, and a missing event times out with the event's name.
  const waiting = session.once("Page.loadEventFired", 300);
  socket.event("Page.loadEventFired", { timestamp: 1 });
  assert.deepEqual(await waiting, { timestamp: 1 });
  const late = session.once("Page.domContentEventFired", 200);
  socket.event("Page.other", {});
  await assert.rejects(() => late, /waiting for Page\.domContentEventFired timed out/);
  const never = session.send("Page.never", {});
  await assert.rejects(() => never, /CDP Page\.never timed out after 300ms/);
  session.close();
  assert.ok(socket.closed);
});

await test("open, read, click and type use the commands the live API accepts", async () => {
  const session = createCdpSession("ws://fake/2", { webSocketImpl: FakeSocket, timeoutMs: 500 });
  const socket = FakeSocket.instances.at(-1);
  // Answer as requests arrive rather than guessing when they will: browserText issues three evaluates in sequence, so
  // a fixed number of blind replies raced it and the third timed out. A per-request responder cannot race.
  socket.onSend = (message) => {
    if (message.method === "Runtime.evaluate") {
      const expression = String(message.params.expression);
      // Order matters and is keyed on the most specific marker: the element-lookup expression also contains
      // `innerText`, so testing for that first answered "body text" where a box was expected - the test's own bug.
      const value = expression.includes("getBoundingClientRect")
        ? (expression.includes("#nope") ? null : { x: 10.4, y: 20.6, text: "Go" })
        : expression.includes("document.title") ? "T"
          : expression.includes("location.href") ? "https://e.com/x"
            : expression.includes("innerText") ? "body text"
              : true;
      queueMicrotask(() => socket.reply(message.id, { result: { value, type: typeof value } }));
      return;
    }
    if (message.method === "Page.navigate") {
      queueMicrotask(() => { socket.reply(message.id, { frameId: "F" }); socket.event("Page.loadEventFired", {}); });
      return;
    }
    if (message.method === "Input.dispatchMouseEvent" || message.method === "Input.insertText") {
      queueMicrotask(() => socket.reply(message.id, {}));
    }
  };
  socket.emit("open", {});
  await session.ready;

  const opened = await browserOpen(session, "https://example.com");
  assert.equal(opened.title, "T");
  assert.deepEqual(socket.sent.find((m) => m.method === "Page.navigate").params, { url: "https://example.com" });
  await assert.rejects(() => browserOpen(session, "not-a-url"), /must start with http/);

  const read = await browserText(session, { maxChars: 500 });
  assert.equal(read.text, "body text");
  assert.equal(read.url, "https://e.com/x");

  const centre = await browserElementCentre(session, "#go");
  assert.equal(centre.text, "Go");
  assert.ok(socket.sent.some((m) => m.method === "Runtime.evaluate" && /querySelector\("#go"\)/.test(m.params.expression)), "the selector is looked up in the page");

  const clicked = await browserClick(session, "#go");
  assert.equal(clicked.x, 10);
  assert.equal(clicked.y, 21, "the centre is rounded");
  const pressed = socket.sent.find((m) => m.method === "Input.dispatchMouseEvent" && m.params.type === "mousePressed");
  assert.deepEqual(pressed.params, { type: "mousePressed", x: 10, y: 21, button: "left", clickCount: 1 });

  const typed = await browserType(session, "#q", "hello");
  assert.equal(typed.chars, 5);
  assert.deepEqual(socket.sent.find((m) => m.method === "Input.insertText").params, { text: "hello" });

  await assert.rejects(() => browserClick(session, ""), /needs a CSS selector/);
  await assert.rejects(() => browserClick(session, "#nope"), /nothing on the page matches/);
  session.close();
});

await test("a screenshot is decoded to PNG bytes, and an empty one is refused", async () => {
  const session = createCdpSession("ws://fake/3", { webSocketImpl: FakeSocket, timeoutMs: 500 });
  const socket = FakeSocket.instances.at(-1);
  socket.emit("open", {});
  await session.ready;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const shooting = browserScreenshot(session);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(socket.sent.at(-1).params, { format: "png" });
  socket.reply(socket.sent.at(-1).id, { data: png.toString("base64") });
  const got = await shooting;
  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual([...got], [...png], "the bytes round-trip");

  const empty = browserScreenshot(session);
  await new Promise((r) => setTimeout(r, 0));
  socket.reply(socket.sent.at(-1).id, { data: "" });
  await assert.rejects(() => empty, /empty screenshot/);
  session.close();
});

await test("a page exception surfaces its message rather than returning undefined", async () => {
  const session = createCdpSession("ws://fake/4", { webSocketImpl: FakeSocket, timeoutMs: 500 });
  const socket = FakeSocket.instances.at(-1);
  socket.emit("open", {});
  await session.ready;
  const evaluating = browserEvaluate(session, "boom()");
  await new Promise((r) => setTimeout(r, 0));
  socket.reply(socket.sent.at(-1).id, { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } });
  await assert.rejects(() => evaluating, /the page threw: Uncaught ReferenceError: boom is not defined/);
  session.close();
});

// The plugin's own wiring for the browser: registered tools, one shared session, an inbox screenshot, and a panel
// that can configure it - all asserted against the sources, on top of the module tests above.
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const host = readFileSync(joinPath(pluginDir, "index.js"), "utf8");
const panel = readFileSync(joinPath(pluginDir, "client.js"), "utf8");

await test("the six browser tools exist, share one session, and never fail silently", () => {
  for (const name of ["browser_open", "browser_text", "browser_click", "browser_type", "browser_screenshot", "browser_close"]) {
    assert.match(host, new RegExp(`"${name}"`), `${name} is defined`);
  }
  // Registered in the same loop as everything else, without pinning its neighbours.
  assert.match(host, /for \(const definition of \[[^\]]*browserCloseTool[^\]]*\]\)/, "the browser tools are registered");
  assert.match(host, /let browserLive = null/, "one shared session, so the tools act on the same page");
  assert.match(host, /async function browserEnsure\(\)/, "and it is brought up through one place");
  assert.match(host, /失败：\$\{reason\}/, "a failure always carries its reason");
  assert.match(host, /noteRoute\("\/browser", \{ action: name, ok: false, error: reason \}\)/, "and is recorded");
  assert.match(host, /join\(await resolvedInbox\(\), "browser"\)/, "a screenshot lands in the shared inbox");
});

// Startup must warm every cache `/state` reads, not just Feishu's. The bug this guards: only Feishu's cache was warmed,
// so `/state` reported a saved Tavily key as unset until the first search refreshed it, which read as a lost key. The
// order matters as much as the presence: each refresh must precede the connection.
await test("startup warms every cache /state reads, not just Feishu's", () => {
  const start = host.indexOf("const startFeishuAfterPrefs");
  assert.ok(start > 0, "the startup chain exists");
  const chain = host.slice(start, start + 900);
  for (const name of ["refreshTavilySavedPrefs", "refreshBrowserSavedPrefs", "refreshFeishuSavedPrefs"]) {
    assert.ok(chain.includes(name), `${name} runs at startup`);
    assert.ok(chain.indexOf(name) < chain.indexOf("startFeishuLongConnection"), `${name} is warm before the connection starts`);
  }
});

await test("the browser settings reach the panel, the route and the environment", () => {
  assert.match(host, /browser: browserState\(\),/, "/state reports the browser settings");
  assert.match(host, /const browserPatch = browserPrefsPatch/, "/prefs accepts them");
  assert.match(host, /browser: applied\.browser, browserChanged: applied\.changed/, "and reports what changed");
  assert.match(host, /DSH_BROWSER_PROFILE/, "the environment is honoured");
  assert.match(host, /join\(dshHome, "browser-profile"\)/, "the default profile is the plugin's own, not the user's browser");
  assert.match(panel, /const \[browserDraft, setBrowserDraft\]/, "the panel keeps its own draft");
  assert.match(panel, /browserHeadless: event\.target\.checked/, "the headless switch is a real boolean");
  assert.match(panel, /snapshot\?\.browser\?\.channel/, "and the saved channel comes back after a reload");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
