// The extension bridge's contract: the polling handshake, the token, timeouts, and the CDP-shaped session the existing
// browser tools expect. A real HTTP server is started on an ephemeral port, because the handshake *is* HTTP - mocking
// fetch client-side would test the mock, not the bridge.
import assert from "node:assert/strict";
import { ExtensionBridge, bridgeToken, extensionSession } from "../extension.js";

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

await test("a token is 32 hex characters, so it can be pasted and not guessed", () => {
  assert.match(bridgeToken(), /^[0-9a-f]{32}$/);
  assert.notEqual(bridgeToken(), bridgeToken());
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
