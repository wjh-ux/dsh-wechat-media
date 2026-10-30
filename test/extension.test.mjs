// The extension bridge's contract: the polling handshake, the token, timeouts, and the CDP-shaped session the existing
// browser tools expect. A real HTTP server is started on an ephemeral port, because the handshake *is* HTTP - mocking
// fetch client-side would test the mock, not the bridge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionBridge, bridgeToken, extensionSession, packExtension, openExtensionsPage } from "../extension.js";

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

/** A bridge on a port nobody else uses, so the running plugin (9339) cannot collide with a test. */
async function startBridge(options = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = new ExtensionBridge({ port, token: "t0ken", ...options });
  await bridge.start();
  // Pretend the worker has already been told which transport and cursor setting to use: otherwise the first poll of
  // every test would be that handshake instead of the command under test. The handshake tests clear these deliberately.
  bridge.driverSent = bridge.driver;
  bridge.cursorSent = bridge.cursor;
  return bridge;
}

const call = async (bridge, path, { method = "GET", body, token = "t0ken" } = {}) => {
  const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method,
    headers: { "x-dsh-token": token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

await test("a token is required, so a local process cannot drive the browser", async () => {
  const bridge = await startBridge();
  try {
    const denied = await call(bridge, "/status", { token: "wrong" });
    assert.equal(denied.status, 401);
    const allowed = await call(bridge, "/status");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.running, true);
  } finally { await bridge.stop(); }
});

await test("a command waits for the extension, which polls it and posts the answer", async () => {
  const bridge = await startBridge();
  try {
    const pending = bridge.call("Runtime.evaluate", { expression: "1+1" });
    const polled = await call(bridge, "/poll?tabs=3&name=Test");
    assert.equal(polled.status, 200);
    assert.equal(polled.body.command.method, "Runtime.evaluate");
    assert.deepEqual(polled.body.command.params, { expression: "1+1" });
    assert.equal(bridge.status().connected, true, "polling marks the client alive");
    assert.equal(bridge.status().tabs, 3);

    await call(bridge, "/result", { method: "POST", body: { id: polled.body.command.id, ok: true, result: 2 } });
    assert.equal(await pending, 2);
  } finally { await bridge.stop(); }
});

await test("a failing command rejects with the extension's reason, and an unknown id is ignored", async () => {
  const bridge = await startBridge();
  try {
    const pending = bridge.call("Page.navigate", { url: "https://x" });
    const polled = await call(bridge, "/poll");
    await call(bridge, "/result", { method: "POST", body: { id: polled.body.command.id, ok: false, error: "没有可操作的标签页" } });
    await assert.rejects(() => pending, /没有可操作的标签页/);

    const stray = await call(bridge, "/result", { method: "POST", body: { id: 999, ok: true } });
    assert.equal(stray.body.accepted, false);
  } finally { await bridge.stop(); }
});

await test("a command handed to a poll that died is re-delivered once instead of being lost", async () => {
  // Measured live: the service worker was suspended mid-poll, the command went into a response nobody read, and the
  // caller timed out 30 s later with no clue. One re-queue is enough - the restarted worker's next poll takes it.
  const bridge = await startBridge();
  try {
    const pending = bridge.call("Runtime.evaluate", { expression: "1" }, { timeoutMs: 120 });
    await new Promise((resolve) => setTimeout(resolve, 180)); // the first deadline passes with nobody polling
    const polled = await call(bridge, "/poll");
    assert.equal(polled.status, 200, "the command comes back on the next poll");
    await call(bridge, "/result", { method: "POST", body: { id: polled.body.command.id, ok: true, result: 1 } });
    assert.equal(await pending, 1);
  } finally { await bridge.stop(); }
});

await test("a silent extension times out instead of hanging the tool", async () => {
  const bridge = await startBridge();
  try {
    await assert.rejects(() => bridge.call("Runtime.evaluate", {}, { timeoutMs: 150 }), /没有回应 Runtime\.evaluate/);
    assert.equal(bridge.status().pending, 0, "the pending entry is cleaned up");
  } finally { await bridge.stop(); }
});

await test("the session adapter speaks the CDP shape the browser tools use, and answers nothing for events", async () => {
  const bridge = await startBridge();
  try {
    const session = extensionSession(bridge, { tabId: 7 });
    const pending = session.send("Runtime.evaluate", { expression: "location.href" });
    const polled = await call(bridge, "/poll");
    assert.equal(polled.body.command.params.__tabId, 7, "the tab rides along for the extension");
    await call(bridge, "/result", { method: "POST", body: { id: polled.body.command.id, ok: true, result: "https://x" } });
    assert.equal(await pending, "https://x");
    // `browserOpen` waits on Page.loadEventFired; rejecting at once is what turns that wait into zero.
    await assert.rejects(() => session.once("Page.loadEventFired"), /没有协议事件/);
  } finally { await bridge.stop(); }
});

await test("the transport switch rides the next poll, before any command", async () => {
  // Chrome's "已开始调试此浏览器" banner is drawn by the browser whenever `chrome.debugger` attaches; no extension can
  // hide it. The way to have no banner is to not attach - so the worker is told which transport to use, first.
  const bridge = await startBridge();
  try {
    bridge.driverSent = "";
    assert.equal(bridge.status().driver, "debugger", "the capable transport is the default");
    const first = await call(bridge, "/poll");
    assert.equal(first.body.command.method, "__driver");
    assert.equal(first.body.command.params.mode, "debugger");

    await bridge.setDriver("script");
    const second = await call(bridge, "/poll");
    assert.equal(second.body.command.method, "__driver", "the switch comes before work");
    assert.equal(second.body.command.params.mode, "script");
    assert.equal(bridge.status().driver, "script");

    // Once delivered, it is not repeated on every poll.
    const pending = bridge.call("Runtime.evaluate", {}, { timeoutMs: 800 });
    const third = await call(bridge, "/poll");
    assert.equal(third.body.command.method, "Runtime.evaluate");
    await call(bridge, "/result", { method: "POST", body: { id: third.body.command.id, ok: true, result: 1 } });
    assert.equal(await pending, 1);

    // Hybrid is the third choice: script first, the debugger only for what scripting cannot do.
    await bridge.setDriver("hybrid");
    const fourth = await call(bridge, "/poll");
    assert.equal(fourth.body.command.params.mode, "hybrid");
    assert.equal(bridge.status().driver, "hybrid");
    // Anything unrecognised falls back to the capable transport rather than inventing a fourth state.
    await bridge.setDriver("nonsense");
    assert.equal(bridge.status().driver, "debugger");
  } finally { await bridge.stop(); }
});

await test("the cursor setting rides the poll too, and is off unless asked for", async () => {
  // Chrome has no cursor API, so the pointer is a page overlay the worker paints. Like the driver, the setting must
  // reach the worker before it can act on it - and it must never be on by surprise.
  const bridge = await startBridge();
  try {
    assert.equal(bridge.status().cursor, false, "off by default");
    bridge.cursorSent = "";
    assert.equal(bridge.setCursor(true).cursor, true);
    const polled = await call(bridge, "/poll");
    assert.equal(polled.body.command.method, "__cursor");
    assert.equal(polled.body.command.params.on, true);
    assert.equal(bridge.status().cursor, true);

    bridge.setCursor(false);
    const off = await call(bridge, "/poll");
    assert.equal(off.body.command.params.on, false);
  } finally { await bridge.stop(); }
});

await test("the cursor flag rides the click command, so it cannot be one click stale", async () => {
  // The first version stored the setting and delivered it on a poll; the dot then appeared one click late (or after the
  // next poll, up to 25 s). A flag on the command itself has no such window.
  const bridge = await startBridge();
  try {
    bridge.cursor = true;
    bridge.cursorSent = true; // the handshake already happened; only the per-command flag is under test
    const session = extensionSession(bridge);
    const pending = session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 12, y: 34 });
    const polled = await call(bridge, "/poll");
    assert.equal(polled.body.command.method, "Input.dispatchMouseEvent");
    assert.equal(polled.body.command.params.__cursor, true, "the click carries the flag");
    await call(bridge, "/result", { method: "POST", body: { id: polled.body.command.id, ok: true, result: {} } });
    await pending;

    bridge.cursor = false;
    bridge.cursorSent = false;
    const second = session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 });
    const polled2 = await call(bridge, "/poll");
    assert.equal(polled2.body.command.params.__cursor, false, "and it says so when off");

    // Non-click commands do not carry it at all, so stripping it stays a click-path concern.
    const third = session.send("Runtime.evaluate", { expression: "1" });
    const polled3 = await call(bridge, "/poll");
    assert.equal("__cursor" in polled3.body.command.params, false);
    for (const [pendingCall, id] of [[second, polled2], [third, polled3]]) {
      await call(bridge, "/result", { method: "POST", body: { id: id.body.command.id, ok: true, result: 1 } });
      await pendingCall;
    }
  } finally { await bridge.stop(); }
});

await test("with two browsers open, the target decides who runs the command", async () => {
  // The reason this exists: Chrome and Edge both poll the same queue, so without a target the answer comes from
  // whichever happened to poll first - and the command runs in a window the person was not talking about.
  const bridge = new ExtensionBridge({ port: 20000 + Math.floor(Math.random() * 20000), token: "t0ken", holdMs: 60, standbyMs: 20 });
  await bridge.start();
  try {
    bridge.driverSent = bridge.driver;
    bridge.cursorSent = bridge.cursor;

    const [chromeFirst, edgeFirst] = await Promise.all([
      call(bridge, "/poll?browser=chrome&id=c1"),
      call(bridge, "/poll?browser=edge&id=e1"),
    ]);
    assert.equal(chromeFirst.status, 204, "nobody had work to hand out");
    assert.equal(edgeFirst.status, 204);

    const status = bridge.status();
    assert.equal(status.clients.length, 2, "both browsers are known");
    assert.deepEqual(status.clients.map((client) => client.browser).sort(), ["chrome", "edge"]);

    // `auto` follows the channel setting; an explicit target overrides it.
    bridge.preferredBrowser = "edge";
    assert.equal(bridge.effectiveTarget(), "edge");
    bridge.setTarget("chrome");
    assert.equal(bridge.effectiveTarget(), "chrome");
    bridge.setTarget("auto");
    assert.equal(bridge.effectiveTarget(), "edge");

    // A command goes to the target only: the other browser's poll is told "nothing", never handed the work.
    bridge.target = "edge";
    const pending = bridge.call("Runtime.evaluate", { expression: "1" }, { timeoutMs: 1500 });
    const edgePoll = await call(bridge, "/poll?browser=edge&id=e1");
    assert.equal(edgePoll.status, 200, "the target receives the command");
    assert.equal(edgePoll.body.command.method, "Runtime.evaluate");
    const chromePoll = await call(bridge, "/poll?browser=chrome&id=c1");
    assert.equal(chromePoll.status, 204, "the non-target browser stays idle");

    await call(bridge, "/result", { method: "POST", body: { id: edgePoll.body.command.id, ok: true, result: 1 } });
    assert.equal(await pending, 1);
  } finally { await bridge.stop(); }
});

await test("the answer says which transport ran the command, so a flash is explainable afterwards", async () => {
  const bridge = await startBridge();
  try {
    const pending = bridge.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" }, { timeoutMs: 800 });
    const polled = await call(bridge, "/poll");
    await call(bridge, "/result", {
      method: "POST",
      body: { id: polled.body.command.id, ok: true, result: {}, driver: "debugger" },
    });
    await pending;
    assert.equal(bridge.status().lastDriver, "debugger");
    assert.equal(bridge.status().debuggerUses, 1, "the counter counts debugger runs only");

    const second = bridge.call("Runtime.evaluate", {}, { timeoutMs: 800 });
    const polled2 = await call(bridge, "/poll");
    await call(bridge, "/result", {
      method: "POST",
      body: { id: polled2.body.command.id, ok: true, result: 1, driver: "script" },
    });
    await second;
    assert.equal(bridge.status().lastDriver, "script");
    assert.equal(bridge.status().debuggerUses, 1, "a script run does not increment it");
  } finally { await bridge.stop(); }
});

await test("the network layer is wired on both sides", () => {
  // The data behind a page is the point: capture the JSON the page fetched, read the cookies that keep it logged in,
  // download a file, and know when the page has settled. Without it a list is only what happened to be rendered.
  const host = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const flow = readFileSync(new URL("../flow.js", import.meta.url), "utf8");
  for (const name of ["browser_capture", "browser_json", "browser_cookies", "browser_download", "browser_tabs"]) {
    assert.match(host, new RegExp(`"${name}"`), `${name} is registered`);
  }
  for (const command of ["__netStart", "__netStop", "__cookies", "__download", "__tabs"]) {
    assert.ok(host.includes(command), `${command} is sent by the plugin`);
  }
  // "Wait until the page settles" lives in the flow runner, where a step can ask for it.
  assert.match(flow, /__waitIdle/, "waitIdle is available as a flow step");
  assert.match(host, /这个功能走浏览器扩展/, "and says so when the transport cannot do it");

  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.permissions.includes("cookies"), "cookies permission");
  assert.ok(manifest.permissions.includes("downloads"), "downloads permission");

  const worker = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(worker, /Network\.enable/, "capture turns the Network domain on");
  assert.match(worker, /Network\.getResponseBody/, "and reads response bodies while attached");
  assert.match(worker, /chrome\.downloads\.download/, "downloads go through the browser, so its cookies apply");
});

await test("a token is 32 hex characters, so it can be pasted and not guessed", () => {
  assert.match(bridgeToken(), /^[0-9a-f]{32}$/);
  assert.notEqual(bridgeToken(), bridgeToken());
});

await test("the install helper packs the folder and opens the extensions page", async () => {
  // Chrome cannot be told to install silently - that is a security rule, not a missing feature - so the panel does the
  // three things a page can: package the folder, open chrome://extensions, put the token on the clipboard.
  const calls = [];
  const execFileImpl = (file, args, options, done) => { calls.push({ file, args, options }); done?.(null, ""); };
  const packed = await packExtension({ dir: "C:\\plugins\\dsh-wechat-media\\extension", zipPath: "C:\\out\\ext.zip", execFileImpl });
  assert.equal(packed.zip, "C:\\out\\ext.zip");
  assert.equal(calls[0].file, "powershell.exe");
  assert.match(calls[0].args.join(" "), /Compress-Archive/);
  assert.match(calls[0].args.join(" "), /'C:\\plugins\\dsh-wechat-media\\extension\\\*'/);

  const opened = await openExtensionsPage({ execFileImpl });
  assert.equal(opened.opened, true);
  assert.equal(opened.page, "chrome://extensions");
  assert.match(calls[1].args.join(" "), /chrome:\/\/extensions/);

  // Edge is Chromium with the same extension API; only its settings page has another name.
  const edge = await openExtensionsPage({ execFileImpl, channel: "edge" });
  assert.equal(edge.page, "edge://extensions");
  assert.match(calls[2].args.join(" "), /edge:\/\/extensions/);

  const quoted = await packExtension({ dir: "C:\\it's here\\extension", zipPath: "C:\\out\\x.zip", execFileImpl });
  assert.equal(quoted.zip, "C:\\out\\x.zip");
  assert.match(calls[3].args.join(" "), /'C:\\it''s here\\extension\\\*'/, "an apostrophe in a path is doubled, not dropped");
});

await test("packing creates the destination directory instead of failing on it", async () => {
  // Compress-Archive does not create the destination folder, and a fresh $DSH_HOME has no exports directory - the
  // one-click install then failed with "cannot find path …\\.dsh\\exports" on a machine where nothing was wrong.
  const base = await mkdtemp(join(tmpdir(), "wx-pack-"));
  const nested = join(base, "one", "two", "ext.zip");
  const calls = [];
  const execFileImpl = (cmd, args, options, callback) => {
    calls.push({ cmd, args });
    callback(null, "", "");
  };
  try {
    const packed = await packExtension({ dir: "C:\\plugins\\x\\extension", zipPath: nested, execFileImpl });
    assert.equal(packed.zip, nested);
    assert.equal(calls.length, 1, "the archive command still runs");
    const made = await stat(join(base, "one", "two")).then((s) => s.isDirectory()).catch(() => false);
    assert.ok(made, "the destination directory exists afterwards");
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
