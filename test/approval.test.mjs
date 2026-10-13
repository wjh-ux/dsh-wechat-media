/**
 * Tests for the approval bridge: the code that asks a human in WeChat whether a
 * tool call may run, and that must never swallow a request it could not answer.
 *
 * The bridge takes its dependencies as arguments (no WeChat, no harness, no real
 * clock), so each decision is exercised directly.
 *
 * Run: node test/approval.test.mjs
 */
import assert from "node:assert/strict";

import { createApprovalBridge, formatApprovalPrompt } from "../index.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

/** Records every notification instead of sending it. */
function recorder() {
  const sent = [];
  const notify = async (account, chatId, text) => {
    sent.push({ account, chatId, text });
  };
  notify.sent = sent;
  return notify;
}

const account = { accountId: "acct-one", botId: "bot-one", token: "tok", baseUrl: "http://example.invalid" };
const session = { id: "wechat-abc" };
const request = (extra = {}) => ({ toolName: "pwsh", agent: { session }, ...extra });
const GUI = () => "GUI";
/** Resolve a conversation the way the running plugin does (via its route table). */
const conversations = {
  findConversation: async (sessionId) => (sessionId === "wechat-abc" ? { accountId: "acct-one", chatId: "chat-a" } : undefined),
  loadAccount: async () => account,
};

console.log("approval bridge");

console.log("-- who gets asked --");

await test("a session this bridge does not own is left to the GUI", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 30 });
  const answer = await bridge.respond(request({ agent: { session: { id: "other" } } }), GUI, conversations);
  assert.equal(answer, "GUI");
  assert.deepEqual(notify.sent, [], "nothing is sent for a foreign session");
});

await test("the bridge stays out of the way when configured to ignore approvals", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 30 });
  const answer = await bridge.respond(request(), GUI, { ...conversations, ignore: true });
  assert.equal(answer, "GUI");
  assert.deepEqual(notify.sent, []);
});

await test("an account without a token is left to the GUI", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 30 });
  const answer = await bridge.respond(request(), GUI, { ...conversations, loadAccount: async () => ({ accountId: "x" }) });
  assert.equal(answer, "GUI");
  assert.deepEqual(notify.sent, []);
});

await test("a prompt that cannot be delivered fails safe to the GUI", async () => {
  const bridge = createApprovalBridge({
    notify: async () => {
      throw new Error("window closed");
    },
    timeoutMs: 30,
  });
  const answer = await bridge.respond(request(), GUI, conversations);
  assert.equal(answer, "GUI", "an undeliverable prompt must not hang or auto-deny");
});

console.log("-- answering --");

await test("replying 1 allows the call once and 2 rejects it", async () => {
  for (const [reply, expected] of [["1", "allowed-once"], ["2", "rejected"], ["同意", "allowed-once"], ["拒绝", "rejected"]]) {
    const notify = recorder();
    const bridge = createApprovalBridge({ notify, timeoutMs: 500 });
    const waiting = bridge.ask(account, "chat-a", request());
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(notify.sent.length, 1, "the prompt is sent exactly once");
    assert.match(notify.sent[0].text, /回 1 = 批准一次/);
    assert.equal(bridge.consume("acct-one", "chat-a", reply), true, `"${reply}" answers the request`);
    assert.equal(await waiting, expected);
    assert.equal(bridge.pending.size, 0, "the pending entry is cleaned up");
  }
});

await test("an ordinary message does not answer and does not clear the request", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 40 });
  const waiting = bridge.ask(account, "chat-a", request());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(bridge.consume("acct-one", "chat-a", "顺便问一下天气"), false);
  assert.equal(bridge.consume("acct-two", "chat-a", "1"), false, "another account cannot answer");
  assert.equal(bridge.pending.size, 1);
  assert.equal(await waiting, undefined, "the request still times out");
});

await test("consume without a pending request is a no-op", async () => {
  const bridge = createApprovalBridge({ notify: recorder(), timeoutMs: 30 });
  assert.equal(bridge.consume("acct-one", "chat-a", "1"), false);
});

await test("only one question is asked per chat at a time", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 40 });
  const first = bridge.ask(account, "chat-a", request());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await bridge.ask(account, "chat-a", request());
  assert.equal(second, undefined, "the second ask delegates to the GUI at once");
  assert.equal(notify.sent.length, 1, "no second prompt is sent (1/2 would be ambiguous)");
  bridge.consume("acct-one", "chat-a", "1");
  assert.equal(await first, "allowed-once");
});

console.log("-- timeouts --");

await test("no answer within the window means 'ask someone else'", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 25 });
  const outcome = await bridge.ask(account, "chat-a", request(), { timeoutMs: 25 });
  assert.equal(outcome, undefined);
  assert.equal(bridge.pending.size, 0);
  assert.equal(notify.sent.length, 2, "the chat is told the request moved to the GUI");
  assert.match(notify.sent[1].text, /GUI/);
});

await test("an aborted turn stops waiting immediately", async () => {
  const notify = recorder();
  const controller = new AbortController();
  const bridge = createApprovalBridge({ notify, timeoutMs: 5000 });
  const waiting = bridge.ask(account, "chat-a", request({ signal: controller.signal }), { timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.equal(await waiting, undefined);
  assert.equal(bridge.pending.size, 0);
});

await test("an expired request cannot be answered afterwards", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 20 });
  await bridge.ask(account, "chat-a", request(), { timeoutMs: 20 });
  assert.equal(bridge.consume("acct-one", "chat-a", "1"), false, "the stale 1/2 must not resolve anything");
});

console.log("-- prompt contents --");

await test("the asked prompt shows what will run", () => {
  const prompt = formatApprovalPrompt({ toolName: "wechat_send_file", arguments: { path: "C:\\tmp\\a.zip" } });
  assert.match(prompt, /wechat_send_file/);
  assert.match(prompt, /a\.zip/);
});

await test("a reply is matched even when the account record names itself differently", async () => {
  // Regression: the pending key used `account.accountId ?? account.botId` while the
  // inbound path used the monitor's account id. Real accounts carry botId, so the
  // two differed and a "1" reached the agent as a normal message.
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 500 });
  const record = { botId: "b775a478733a@im.bot", token: "tok" }; // note: no accountId
  const waiting = bridge.ask(record, "chat-a", request(), { accountId: "b775a478733a-im-bot" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(bridge.consume("b775a478733a-im-bot", "chat-a", "1"), true, "the monitor's id must match the pending key");
  assert.equal(await waiting, "allowed-once");
});
await test("an answer is confirmed in the chat", async () => {
  for (const [reply, expected] of [["1", /批准/], ["2", /拒绝/]]) {
    const notify = recorder();
    const bridge = createApprovalBridge({ notify, timeoutMs: 500 });
    const waiting = bridge.ask(account, "chat-a", request(), { accountId: "acct-one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(bridge.consume("acct-one", "chat-a", reply), true);
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(notify.sent.length, 2, `"${reply}" must be confirmed`);
    assert.match(notify.sent[1].text, expected);
    assert.equal(notify.sent[1].chatId, "chat-a", "the confirmation goes to the asking chat");
  }
});
await test("pending questions are listed and can be cancelled from DSH", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 5000 });
  const waiting = bridge.ask(account, "chat-a", request(), { accountId: "acct-one" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const list = bridge.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].chatId, "chat-a");
  assert.equal(list[0].accountId, "acct-one");
  assert.equal(list[0].toolName, "pwsh");
  assert.ok(list[0].waitedMs >= 0);
  assert.equal(bridge.cancel("acct-one", "chat-a"), true);
  assert.equal(await waiting, undefined, "cancelling means 'ask someone else', so the GUI takes over");
  assert.equal(bridge.pending.size, 0);
  assert.equal(bridge.cancel("acct-one", "chat-a"), false, "cancelling twice is a no-op");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(notify.sent.length, 2, "the chat is told the approval was cancelled in DSH");
});
await test("the last outcome is reported without blocking", async () => {
  const notify = recorder();
  const bridge = createApprovalBridge({ notify, timeoutMs: 5000 });
  assert.equal(bridge.last(), undefined, "nothing has happened yet");
  const waiting = bridge.ask(account, "chat-a", request(), { accountId: "acct-one" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  bridge.consume("acct-one", "chat-a", "2");
  await waiting;
  assert.equal(bridge.last().outcome, "rejected");
  assert.equal(bridge.last().chatId, "chat-a");
  assert.equal(bridge.last().toolName, "pwsh");

  const second = bridge.ask(account, "chat-a", request(), { accountId: "acct-one" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  bridge.cancel("acct-one", "chat-a");
  await second;
  assert.equal(bridge.last().outcome, "cancelled");

  await bridge.ask(account, "chat-a", request(), { accountId: "acct-one" }, { timeoutMs: 20 });
  assert.equal(bridge.last().outcome, "timeout");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
