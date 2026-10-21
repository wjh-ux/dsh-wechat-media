// The extension bridge's contract: the polling handshake, the token, timeouts, and the CDP-shaped session the existing
// browser tools expect. A real HTTP server is started on an ephemeral port, because the handshake *is* HTTP - mocking
// fetch client-side would test the mock, not the bridge.
import assert from "node:assert/strict";
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
  // Pretend the worker has already been told which transport to use: otherwise the first poll of every test would be the
  // `__driver` handshake instead of the command under test. The driver test clears this deliberately.
  bridge.driverSent = bridge.driver;
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

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
