// The browser module's contract, exercised without starting a browser: a fake socket drives the CDP session, and the
// launch path gets a fake spawn plus a fake fetch. The shapes asserted here are the ones measured against a real
// Chrome (see the header of ../browser.js for where each one came from).
import assert from "node:assert/strict";

const {
  BROWSER_CHANNELS, browserExecutable, cdpBase, browserVersion, browserTargets, browserPageTarget,
  browserLaunch, createCdpSession, browserOpen, browserEvaluate, browserText, browserElementCentre,
  browserClick, browserType, browserScreenshot,
  BROWSER_MODES, BROWSER_MODE_NAMES, browserModeSettings,
  browserCloseBrowser, parseProxyAddress, proxyListening, browserArgsMatch,
  normalizeProxyPattern, normalizeProxyPatterns, hostMatchesPattern, buildPacScript,
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

await test("a timed-out navigation leaves no unhandled rejection (it used to kill the app)", async () => {
  // Measured in production: `browser_open` timed out, and 20 seconds later the load waiter rejected with nobody
  // listening - DSH treats an unhandled rejection as a fatal load failure and closed the GUI. The order matters:
  // navigate rejects *first*, so a catch attached after that await never runs.
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(String(error?.message ?? error));
  process.on("unhandledRejection", onUnhandled);
  try {
    const session = {
      once: (event, ms) => new Promise((_, reject) => setTimeout(() => reject(new Error(`waiting for ${event} timed out`)), ms)),
      send: async () => { throw new Error("CDP Page.navigate timed out after 15ms"); },
      close: () => {},
    };
    await assert.rejects(() => browserOpen(session, "https://example.com", { waitMs: 40 }), /Page\.navigate timed out/);
    // Wait past the waiter's own deadline so its rejection has had every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(unhandled, [], "the waiter's rejection must be consumed at creation");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

await test("the launch enables automation, without which Chrome refuses to report its own command line", () => {
  // Measured: `Browser.getBrowserCommandLine` answers `-32000 Command line not returned because
  // --enable-automation not set`. Without the flag the stale-browser check could never run, so it fell back to
  // attaching to a window started with older settings - the bug that made a configured host list look broken.
  // By URL: this case runs before `pluginDir` is initialised further down the file.
  const src = readFileSync(new URL("../browser.js", import.meta.url), "utf8");
  assert.match(src, /--enable-automation/, "the flag is passed to every launch");
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

await test("the automation bar can be turned off, because nothing needs getBrowserCommandLine any more", async () => {
  const spawned = [];
  const spawnImpl = (file, args) => { spawned.push(args); return { pid: 1, unref() {} }; };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ Browser: "Chrome/155" }) });
  const executable = joinPath(process.env.TEMP || "/tmp", "fake-chrome.exe");
  const profileDir = joinPath(process.env.TEMP || "/tmp", "dsh-browser-test-bar");

  await browserLaunch({ executable, port: 9335, profileDir, spawnImpl, fetchImpl, automation: false });
  assert.ok(!spawned[0].join(" ").includes("--enable-automation"), "no flag, so no infobar");

  await browserLaunch({ executable, port: 9336, profileDir: joinPath(profileDir, "on"), spawnImpl, fetchImpl });
  assert.match(spawned[1].join(" "), /--enable-automation/, "still the default, so the capability is not lost by accident");
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

const browserSource = readFileSync(joinPath(pluginDir, "browser.js"), "utf8");
await test("the browser settings reach the panel, the route and the environment", () => {
  assert.match(host, /browser: browserState\(\{ exportDir: flowExportDir\(/, "/state reports the browser settings, including the export folder");
  assert.match(host, /browserPatch = browserPrefsPatch\(browserArgs\)/, "/prefs accepts them");
  assert.match(host, /\.\.\.BROWSER_PREF_MODES \}\)/, "/prefs forwards the mode too");
  assert.match(host, /browser: applied\.browser, browserChanged: applied\.changed/, "and reports what changed");
  assert.match(host, /DSH_BROWSER_PROFILE/, "the environment is honoured");
  // The default moved into the pure mode table in browser.js when `erp` needed its own profile.
  assert.match(browserSource, /join\(dshHome, "browser-profile"\)/, "the default profile is the plugin's own, not the user's browser");
  assert.match(browserSource, /join\(dshHome, "browser-profile-erp"\)/, "and the ERP mode keeps its own");
  assert.match(host, /import \{[^}]*BROWSER_MODE_NAMES[^}]*browserModeSettings[^}]*\} from "\.\/browser\.js"/, "the host imports the mode helpers");
  assert.match(panel, /const \[browserDraft, setBrowserDraft\]/, "the panel keeps its own draft");
  assert.match(panel, /browserDraft\.browserMode/, "the mode select is a real string");
  assert.match(panel, /snapshot\?\.browser\?\.channel/, "and the saved channel comes back after a reload");
});

await test("the three browser modes differ where it matters", () => {
  const home = "C:\\dsh";
  const headless = browserModeSettings({ mode: "headless", dshHome: home });
  const headed = browserModeSettings({ mode: "headed", dshHome: home });
  const erp = browserModeSettings({ mode: "erp", dshHome: home });
  assert.equal(headless.headless, true);
  assert.equal(headless.visible, false);
  assert.equal(headed.visible, true, "headed means a human can see it");
  assert.deepEqual([erp.width, erp.height], [1600, 1000], "erp gets the bigger viewport");
  // The profile is the whole point of `erp`: the login to the system under work must survive a restart.
  assert.match(erp.profileDir, /browser-profile-erp$/, "erp has its own profile");
  assert.equal(headed.profileDir, headless.profileDir, "the other two share the scratch profile");
  assert.equal(erp.keepOpen, true);
  assert.equal(headless.keepOpen, false);
  assert.equal(browserModeSettings({ mode: "", savedHeadless: false, dshHome: home }).mode, "headed", "a legacy boolean still means a window");
  assert.equal(browserModeSettings({ mode: "nonsense", dshHome: home }).mode, "headless", "an unknown mode falls back, never throws");
  assert.equal(browserModeSettings({ mode: "erp", profileDir: "C:\\mine", dshHome: home }).profileDir, "C:\\mine");
  assert.deepEqual([...BROWSER_MODE_NAMES], ["headless", "headed", "erp"]);
  assert.deepEqual(Object.keys(BROWSER_MODES), [...BROWSER_MODE_NAMES]);
});

await test("closing the browser goes through CDP, because the pid is not a reliable handle", async () => {
  // A fake browser that answers /json/version once, accepts one connection, records the commands, and then
  // stops answering - which is what a browser that really closed looks like.
  const sent = [];
  let answers = 2;
  const fetchImpl = async (url) => {
    if (!String(url).includes("/json/version")) throw new Error("unexpected url " + url);
    if (answers <= 0) throw new Error("port closed");
    answers -= 1;
    return {
      ok: true,
      json: async () => ({ Browser: "Chrome/120", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }),
    };
  };
  const webSocketImpl = function FakeSocket(url) {
    this.url = url;
    this.ready = Promise.resolve();
    this.send = (payload) => { sent.push(JSON.parse(payload)); return Promise.resolve({}); };
    // `createCdpSession` waits for the "open" event; a no-op listener hangs the whole test.
    this.addEventListener = (type, handler) => { if (type === "open") setTimeout(() => handler({}), 0); };
    this.removeEventListener = () => {};
    this.close = () => {};
    this.on = () => {};
    this.onmessage = null;
    this.onerror = null;
  };
  const answer = await browserCloseBrowser({ port: 9222, fetchImpl, webSocketImpl, timeoutMs: 1 });
  assert.equal(answer.closed, true);
  assert.equal(sent[0].method, "Browser.close", "the browser is asked to close, not killed by pid");
  assert.equal(sent[0].id, 1);

  // A browser that ignores the request must not be reported as closed.
  const stubborn = async () => ({
    ok: true,
    json: async () => ({ Browser: "Chrome/120", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }),
  });
  await assert.rejects(
    () => browserCloseBrowser({ port: 9222, fetchImpl: stubborn, webSocketImpl, timeoutMs: 1 }),
    /still answering/,
    "a close that did not happen is an error, not a success message",
  );
});

await test("a proxy address is accepted the way people write it, and refused when it is unusable", () => {
  assert.equal(parseProxyAddress("127.0.0.1:7897").proxy, "127.0.0.1:7897", "scheme-less http is the common case");
  assert.equal(parseProxyAddress("http://127.0.0.1:7897").proxy, "127.0.0.1:7897", "the http scheme is dropped, as Chrome wants");
  assert.equal(parseProxyAddress("socks5://127.0.0.1:7897").proxy, "socks5://127.0.0.1:7897", "socks keeps its scheme");
  assert.equal(parseProxyAddress("").proxy, "", "empty is off, not an error");
  assert.equal(parseProxyAddress("off").proxy, "", "and so is the word off");
  assert.throws(() => parseProxyAddress("127.0.0.1"), /要带端口/);
  assert.throws(() => parseProxyAddress("127.0.0.1:99999"), /看不懂|要带端口/, "an impossible port is refused either way");
  assert.throws(() => parseProxyAddress("ftp://127.0.0.1:21"), /协议只能是/);
  assert.throws(() => parseProxyAddress("nonsense"), /看不懂|要带端口/);
});

await test("the proxy port is probed, and a closed one says why", async () => {
  // A fake socket: `connectImpl` returns an EventEmitter-shaped object, so no real connection is attempted.
  const { EventEmitter } = await import("node:events");
  const make = (outcome, detail) => () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    setTimeout(() => socket.emit(outcome, detail), 0);
    return socket;
  };
  assert.equal((await proxyListening({ host: "127.0.0.1", port: 7897, connectImpl: make("connect") })).listening, true);
  const refused = await proxyListening({ host: "127.0.0.1", port: 7897, connectImpl: make("error", { code: "ECONNREFUSED" }) });
  assert.equal(refused.listening, false);
  assert.match(refused.reason, /ECONNREFUSED/);
  assert.equal((await proxyListening({ host: "", port: 0 })).listening, false, "nothing to probe is not a crash");
  // Clash listens on 127.0.0.1 only, while `localhost` can resolve to ::1 and be refused. Probing one address
  // reported "❌ ECONNREFUSED" for a proxy that works, which is the most misleading answer available.
  const perHost = (host) => () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    setTimeout(() => {
      // The real shape: `localhost` refuses (Clash is IPv4-only), 127.0.0.1 answers.
      if (host === "127.0.0.1") socket.emit("connect");
      else socket.emit("error", { code: "ECONNREFUSED" });
    }, 0);
    return socket;
  };
  const fallback = await proxyListening({ host: "localhost", port: 7897, connectImpl: (options) => perHost(options.host)() });
  assert.equal(fallback.listening, true, "another address answering is still a working proxy");
  assert.equal(fallback.host, "127.0.0.1", "and the answer names the address that answered");
  const dead = await proxyListening({ host: "127.0.0.1", port: 7897, connectImpl: () => perHost("other")() });
  assert.equal(dead.listening, false, "nothing anywhere means not listening");
  assert.equal(dead.attempts.length >= 2, true, "and every address was tried");
});

await test("a running browser is compared with the settings before it is reused", () => {
  const running = ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\me\\.dsh\\browser-profile", "--proxy-server=127.0.0.1:7897", "--window-size=1600,1000"];
  // Same settings, different separators and case: still a match, because Windows paths are like that.
  const same = browserArgsMatch(running, { headless: false, profileDir: "c:/users/me/.dsh/browser-profile", proxy: "127.0.0.1:7897" });
  assert.equal(same.match, true);
  // A headless leftover must not be reused when the person asked for a window.
  assert.equal(browserArgsMatch(["--headless=new", "--user-data-dir=C:\\p"], { headless: false, profileDir: "C:\\p", proxy: "" }).match, false);
  // A different profile or a missing proxy is a mismatch too.
  assert.equal(browserArgsMatch(running, { headless: false, profileDir: "C:\\other", proxy: "127.0.0.1:7897" }).match, false);
  assert.equal(browserArgsMatch(running, { headless: false, profileDir: "C:\\Users\\me\\.dsh\\browser-profile", proxy: "" }).match, false);
  // The verdict names what it saw, so a log line can explain the restart.
  const verdict = browserArgsMatch(running, { headless: true, profileDir: "", proxy: "" });
  assert.equal(verdict.running.headless, false);
  assert.equal(verdict.wanted.headless, true);
  // A PAC and a fixed proxy answer the same question: comparing a PAC against `--proxy-server` made every open look
  // stale once a host list existed, which restarted the browser on every single open.
  const pac = "file:///C:/x/proxy.pac";
  assert.equal(browserArgsMatch([`--proxy-pac-url=${pac}`], { headless: false, proxy: "127.0.0.1:7897", pacUrl: pac }).match, true, "the same PAC is a match");
  assert.equal(browserArgsMatch(["--proxy-server=127.0.0.1:7897"], { headless: false, proxy: "127.0.0.1:7897", pacUrl: pac }).match, false, "a fixed proxy is not the PAC");
  assert.equal(browserArgsMatch([`--proxy-pac-url=${pac}`], { headless: false, proxy: "127.0.0.1:7897", pacUrl: "" }).match, false, "and a PAC is not the fixed proxy");
});

await test("proxy patterns are what a person types, and matching is what the PAC will do", () => {
  assert.equal(normalizeProxyPattern("https://x.com/home"), "x.com", "a pasted URL becomes its host");
  assert.equal(normalizeProxyPattern("WWW.Google.com."), "www.google.com", "case and the DNS root dot are noise");
  assert.equal(normalizeProxyPattern("*.GitHub.com"), "*.github.com");
  assert.equal(normalizeProxyPattern("  "), "", "blank is not an error");
  assert.throws(() => normalizeProxyPattern("not a host"), /不是有效的域名/);
  assert.throws(() => normalizeProxyPattern("http://"), /不是有效的域名/);
  assert.deepEqual(normalizeProxyPatterns(["x.com", "X.com", "https://x.com/a", "*.y.com"]), ["x.com", "*.y.com"], "duplicates collapse");
  // A bare host covers its subdomains - `api.x.com` is still x.com for a proxy decision.
  assert.equal(hostMatchesPattern("x.com", "x.com"), true);
  assert.equal(hostMatchesPattern("api.x.com", "x.com"), true);
  assert.equal(hostMatchesPattern("notx.com", "x.com"), false, "a suffix is not a match");
  assert.equal(hostMatchesPattern("a.b.github.com", "*.github.com"), true);
  assert.equal(hostMatchesPattern("github.com", "*.github.com"), false, "*. means subdomains only");
});

await test("the PAC script routes the listed hosts and leaves the rest direct", () => {
  const pac = buildPacScript({ patterns: ["x.com", "*.google.com"], proxy: "127.0.0.1:7897" });
  assert.match(pac, /function FindProxyForURL\(url, host\)/);
  assert.match(pac, /var patterns = \["x\.com","\*\.google\.com"\]/);
  assert.match(pac, /return "PROXY 127\.0\.0\.1:7897"/);
  assert.match(pac, /return 'DIRECT'/);
  assert.doesNotMatch(pac, /dnsResolve/, "no name resolution in PAC: it blocks page loads on a slow resolver");
  // socks keeps its scheme, and the directive is the one Chrome understands.
  assert.match(buildPacScript({ patterns: ["a.com"], proxy: "socks5://127.0.0.1:1080" }), /SOCKS5 127\.0\.0\.1:1080/);
  assert.throws(() => buildPacScript({ patterns: ["a.com"], proxy: "" }), /需要一个代理地址/);
  // An empty list is a valid (if pointless) PAC: everything direct.
  assert.match(buildPacScript({ patterns: [], proxy: "127.0.0.1:7897" }), /var patterns = \[\]/);
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
