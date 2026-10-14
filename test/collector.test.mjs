/**
 * Tests for the reply collector's queue.
 *
 * This covers a bug that interjection made routine: a second message arriving while the first
 * was still being answered used to *replace* the pending record, so the first reply could never
 * be relayed and the replacement was settled by the wrong turn. The collector now keeps a queue
 * per session and settles the record whose turn actually ended.
 *
 * Run: node test/collector.test.mjs
 */
import assert from "node:assert/strict";

import { ReplyCollector } from "../index.js";

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

/** The smallest event scope the collector needs: `on` plus a way to fire. */
function fakeScope() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    fire(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

const SESSION = "wechat-session-1";
const session = { header: { id: SESSION } };
const claimed = (messageId, turn) => ({ agent: { session: { id: SESSION } }, message: { id: messageId }, turn });
const assistant = (turn, text) => ({ type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } });
const turnEnd = (turn) => ({ type: "turn/end", data: { turn, reason: { kind: "end_turn" } } });

console.log("reply collector");

await test("two messages waiting at once are settled by their own turns", async () => {
  const scope = fakeScope();
  const collector = new ReplyCollector(scope);

  const first = collector.wait(SESSION, "m1");
  const second = collector.wait(SESSION, "m2");
  assert.equal(collector.isWaiting(SESSION), true, "both are waiting");

  // Turn 1 belongs to the first message only.
  scope.fire("agent/inbox/claimed", claimed("m1", 1));
  scope.fire("session/event", session, assistant(1, "answer one"));
  scope.fire("session/event", session, turnEnd(1));
  assert.deepEqual(await first, { text: "answer one", stopReason: "end_turn", deliveredByTool: false });
  assert.equal(collector.isWaiting(SESSION), true, "the second message is still waiting, not clobbered");

  // Turn 2 belongs to the second.
  scope.fire("agent/inbox/claimed", claimed("m2", 2));
  scope.fire("session/event", session, assistant(2, "answer two"));
  scope.fire("session/event", session, turnEnd(2));
  assert.deepEqual(await second, { text: "answer two", stopReason: "end_turn", deliveredByTool: false });
  assert.equal(collector.isWaiting(SESSION), false, "nothing is left waiting");
});

await test("a turn that nobody asked for does not consume a waiter", async () => {
  const scope = fakeScope();
  const collector = new ReplyCollector(scope);
  const only = collector.wait(SESSION, "m1");

  // A GUI turn in the same session, ending before ours is claimed.
  scope.fire("session/event", session, assistant(7, "someone else's answer"));
  scope.fire("session/event", session, turnEnd(7));
  assert.equal(collector.isWaiting(SESSION), true, "the waiter must survive an unrelated turn");

  scope.fire("agent/inbox/claimed", claimed("m1", 8));
  scope.fire("session/event", session, assistant(8, "mine"));
  scope.fire("session/event", session, turnEnd(8));
  assert.equal((await only).text, "mine");
});

await test("a delivery tool marks every waiter of that turn", async () => {
  const scope = fakeScope();
  const collector = new ReplyCollector(scope);
  const first = collector.wait(SESSION, "m1");
  const second = collector.wait(SESSION, "m2");
  scope.fire("agent/inbox/claimed", claimed("m1", 3));
  scope.fire("agent/inbox/claimed", claimed("m2", 3));
  scope.fire("session/event", session, { type: "tool/call", data: { turn: 3, name: "wechat_send_file" } });
  scope.fire("session/event", session, turnEnd(3));
  assert.equal((await first).deliveredByTool, true);
  assert.equal((await second).deliveredByTool, true, "both waiters of the turn learn the tool answered");
});

await test("the usage callback sees every model call, waiting or not", async () => {
  const scope = fakeScope();
  const seen = [];
  const collector = new ReplyCollector(scope, { onUsage: (input) => seen.push(input) });
  scope.fire("session/event", session, { type: "assistant/message", data: { turn: 9, usage: { inputTokens: 10, outputTokens: 2 } } });
  assert.equal(seen.length, 1, "usage is accounted even with no waiter");
  assert.equal(seen[0].sessionId, SESSION);
  assert.equal(seen[0].usage.inputTokens, 10);
});

await test("a throwing usage callback cannot take the reply down with it", async () => {
  const scope = fakeScope();
  const collector = new ReplyCollector(scope, { onUsage: () => { throw new Error("disk on fire"); } });
  const answer = collector.wait(SESSION, "m1");
  scope.fire("agent/inbox/claimed", claimed("m1", 4));
  scope.fire("session/event", session, { type: "assistant/message", data: { turn: 4, usage: { inputTokens: 1 } } });
  scope.fire("session/event", session, assistant(4, "still here"));
  scope.fire("session/event", session, turnEnd(4));
  assert.equal((await answer).text, "still here");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
