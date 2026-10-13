/**
 * Integration tests for the inbound pipeline: envelope identification, allowlist
 * enforcement and approval-answer consumption.
 *
 * These run the real `classifyInbound` against a real `WechatState` in a temp
 * directory; only the transport and the approval consumer are injected, so the
 * decisions are exercised exactly as they are in the running plugin.
 *
 * Run: node test/inbound.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyInbound, describeEnvelope } from "../index.js";
import { WechatState } from "../state.js";

const ACCOUNT = "acct-one";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const root = await mkdtemp(join(tmpdir(), "wx-inbound-test-"));
  const state = new WechatState({ root });
  await state.init();
  try {
    await fn(state);
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const direct = (text, from = "wxid_alice") => ({
  message_id: `m-${Math.random().toString(36).slice(2, 8)}`,
  message_type: 1,
  from_user_id: from,
  session_id: from,
  item_list: [{ type: 1, text_item: { text } }],
});

const group = (text, groupId = "12345678@chatroom", from = "wxid_bob") => ({
  message_id: `m-${Math.random().toString(36).slice(2, 8)}`,
  message_type: 1,
  from_user_id: from,
  group_id: groupId,
  session_id: groupId,
  item_list: [{ type: 1, text_item: { text } }],
});

console.log("inbound pipeline");

console.log("-- envelope --");

await test("a direct message is addressed by its sender", async () => {
  const identity = describeEnvelope(direct("hi"));
  assert.equal(identity.chatId, "wxid_alice");
  assert.equal(identity.isGroup, false);
  assert.equal(identity.peerName, "wxid_alice");
  assert.equal(identity.fromUserId, "wxid_alice");
  assert.equal(identity.groupId, undefined);
});

await test("a group message is addressed by its group", async () => {
  const identity = describeEnvelope(group("hi"));
  assert.equal(identity.chatId, "12345678@chatroom");
  assert.equal(identity.isGroup, true);
  assert.equal(identity.groupId, "12345678@chatroom");
  assert.equal(identity.sessionChat, "12345678@chatroom");
  assert.equal(identity.fromUserId, "wxid_bob", "the sender is kept as a third candidate");
});

await test("a chatroom session id alone still marks a group", async () => {
  const identity = describeEnvelope({ from_user_id: "wxid_bob", session_id: "999@chatroom" });
  assert.equal(identity.chatId, "999@chatroom");
  assert.equal(identity.isGroup, true);
});

await test("an envelope without any id is unusable", async () => {
  assert.equal(describeEnvelope({}).chatId, "");
  assert.equal(describeEnvelope({ item_list: [] }).chatId, "");
});

console.log("-- allowlist --");

await test("an open bridge forwards everything", async (state) => {
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: direct("你好"), text: "你好", state });
  assert.equal(verdict.action, "forward");
  assert.equal(verdict.reason, "ok");
  assert.equal(verdict.chatId, "wxid_alice");
});

await test("with the allowlist on, an undecided chat is ignored", async (state) => {
  await state.savePrefs({ requireAllowlist: true });
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: direct("你好"), text: "你好", state });
  assert.equal(verdict.action, "ignore");
  assert.equal(verdict.reason, "not-listed");
});

await test("with the allowlist on, an allowed chat passes and a blocked one does not", async (state) => {
  await state.savePrefs({ requireAllowlist: true });
  await state.setPeer(ACCOUNT, "wxid_alice", { allowed: true });
  await state.setPeer(ACCOUNT, "wxid_mallory", { allowed: false });

  const allowed = await classifyInbound({ accountId: ACCOUNT, message: direct("hi"), text: "hi", state });
  assert.equal(allowed.action, "forward");
  assert.equal(allowed.reason, "allowlisted");

  const blocked = await classifyInbound({ accountId: ACCOUNT, message: direct("hi", "wxid_mallory"), text: "hi", state });
  assert.equal(blocked.action, "ignore");
  assert.equal(blocked.reason, "blocked");
});

await test("a group is allowlisted exactly like a contact", async (state) => {
  await state.savePrefs({ requireAllowlist: true });
  await state.setPeer(ACCOUNT, "12345678@chatroom", { allowed: true });
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: group("大家好"), text: "大家好", state });
  assert.equal(verdict.action, "forward");
  assert.equal(verdict.isGroup, true);
});

console.log("-- approval answers --");

await test("a 1/2 reply is consumed instead of becoming a turn", async (state) => {
  const calls = [];
  const consumeApproval = (accountId, chatId, text) => {
    calls.push([accountId, chatId, text]);
    return text === "1";
  };
  const yes = await classifyInbound({ accountId: ACCOUNT, message: direct("1"), text: "1", state, consumeApproval });
  assert.equal(yes.action, "answer");
  assert.equal(yes.reason, "approval-answer");
  assert.deepEqual(calls[0], [ACCOUNT, "wxid_alice", "1"]);

  // The same consumer says "2" is not an answer here (no approval pending).
  const other = await classifyInbound({ accountId: ACCOUNT, message: direct("2"), text: "2", state, consumeApproval });
  assert.equal(other.action, "forward");
});

await test("an ordinary message is never mistaken for an answer", async (state) => {
  const consumeApproval = () => false;
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: direct("帮我写个脚本"), text: "帮我写个脚本", state, consumeApproval });
  assert.equal(verdict.action, "forward");
});

await test("an empty message is not offered to the approval consumer", async (state) => {
  const seen = [];
  const consumeApproval = (...args) => {
    seen.push(args);
    return true;
  };
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: group(""), text: "", state, consumeApproval });
  assert.equal(verdict.action, "forward");
  assert.deepEqual(seen, []);
});

await test("a blocked chat cannot answer approvals", async (state) => {
  await state.savePrefs({ requireAllowlist: true });
  await state.setPeer(ACCOUNT, "wxid_mallory", { allowed: false });
  let asked = false;
  const consumeApproval = () => {
    asked = true;
    return true;
  };
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: direct("1", "wxid_mallory"), text: "1", state, consumeApproval });
  assert.equal(verdict.action, "ignore");
  assert.equal(verdict.reason, "blocked");
  assert.equal(asked, false, "the allowlist must decide before approvals are consulted");
});

console.log("-- recorded identities --");

await test("both candidate ids survive a state round trip", async (state) => {
  const identity = describeEnvelope(group("hi"));
  await state.setPeer(ACCOUNT, identity.chatId, {
    name: identity.peerName,
    kind: identity.isGroup ? "group" : "direct",
    groupId: identity.groupId ?? null,
    sessionChat: identity.sessionChat ?? null,
  });
  const stored = await state.getPeer(ACCOUNT, identity.chatId);
  assert.equal(stored.kind, "group");
  assert.equal(stored.groupId, "12345678@chatroom");
  assert.equal(stored.sessionChat, "12345678@chatroom");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
