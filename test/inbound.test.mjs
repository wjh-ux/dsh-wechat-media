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

import { classifyInbound, classifyWecomInbound, describeEnvelope, interjectDecision, shouldFlush } from "../index.js";
import { WechatState } from "../state.js";

const ACCOUNT = "acct-one";
/** The pseudo account id a WeCom bot writes under (`wecom:<botId>` normalised). */
const WECOM = "wecom-example0BotId0NotReal0000000000000";

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
    // Windows occasionally holds the directory for a moment (indexer, antivirus);
    // a flaky cleanup would report a passing suite as failed.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

console.log("-- delivery --");

await test("a streaming preview flushes on size or on time, never per token", () => {
  // Per-token flushes would be a message per token; too few and the preview stalls.
  assert.equal(shouldFlush({ accumulated: 10, sent: 0, now: 1000, lastAt: 999 }), false, "a short delta right after a flush waits");
  assert.equal(shouldFlush({ accumulated: 24, sent: 0, now: 1000, lastAt: 999 }), true, "enough text flushes at once");
  assert.equal(shouldFlush({ accumulated: 5, sent: 0, now: 2000, lastAt: 1000 }), true, "a stalled stream still flushes on time");
  assert.equal(shouldFlush({ accumulated: 5, sent: 5, now: 9000, lastAt: 0 }), false, "nothing new, nothing to send");
  assert.equal(shouldFlush({ accumulated: 1, sent: 0, now: 0, lastAt: 0 }), false, "the first delta alone is not a chunk");
});

await test("the delivery preference defaults to whole answers", async (state) => {
  assert.equal((await state.loadPrefs()).delivery, "whole", "streaming is opt-in");
});
console.log("-- interjection --");

await test("a message is only steered into a running turn when it can be", () => {
  // `steer` puts the message into the turn that is already running; anything else must queue,
  // because steering with no turn in flight (or no live agent) would drop the message.
  assert.equal(interjectDecision({ enabled: true, turnInFlight: true, agentAvailable: true }), "steer");
  assert.equal(interjectDecision({ enabled: false, turnInFlight: true, agentAvailable: true }), "queue", "off by default");
  assert.equal(interjectDecision({ enabled: true, turnInFlight: false, agentAvailable: true }), "queue", "nothing to interject into");
  assert.equal(interjectDecision({ enabled: true, turnInFlight: true, agentAvailable: false }), "queue", "no agent to steer");
  assert.equal(interjectDecision(), "queue", "no options at all");
  assert.equal(interjectDecision({ enabled: true, turnInFlight: true }), "queue", "agentAvailable must be explicit");
});

await test("interjection is off in a fresh profile", async (state) => {
  assert.equal((await state.loadPrefs()).interject, false);
});

console.log("-- friends only --");

await test("off by default: groups are still forwarded", async (state) => {
  const prefs = await state.loadPrefs();
  assert.equal(prefs.friendOnly, false, "an upgrade must not change who the bot answers");
  const verdict = await classifyInbound({ accountId: ACCOUNT, message: group("大家好"), text: "大家好", state });
  assert.equal(verdict.action, "forward");
});

await test("on: a group is skipped, a 1:1 chat still goes through", async (state) => {
  await state.savePrefs({ friendOnly: true });
  const inGroup = await classifyInbound({ accountId: ACCOUNT, message: group("大家好"), text: "大家好", state });
  assert.equal(inGroup.action, "ignore");
  assert.equal(inGroup.reason, "group-skipped");
  assert.equal(inGroup.isGroup, true, "the verdict still says where it came from");

  const direct_ = await classifyInbound({ accountId: ACCOUNT, message: direct("你好"), text: "你好", state });
  assert.equal(direct_.action, "forward");
});

await test("on: it wins over an allowlisted group, and over an approval answer", async (state) => {
  // The user asked for 1:1 only, so "Allow" on a group must not re-enable it - otherwise
  // the switch would look broken in exactly the panel it is configured from.
  await state.savePrefs({ friendOnly: true, requireAllowlist: true });
  await state.setPeer(ACCOUNT, "12345678@chatroom", { allowed: true });
  const inGroup = await classifyInbound({ accountId: ACCOUNT, message: group("1"), text: "1", state, consumeApproval: () => true });
  assert.equal(inGroup.action, "ignore");
  assert.equal(inGroup.reason, "group-skipped", "a group is skipped before an approval answer is even considered");
});

await test("turning it off again restores groups", async (state) => {
  await state.savePrefs({ friendOnly: true });
  assert.equal((await classifyInbound({ accountId: ACCOUNT, message: group("hi"), text: "hi", state })).action, "ignore");
  await state.savePrefs({ friendOnly: false });
  assert.equal((await classifyInbound({ accountId: ACCOUNT, message: group("hi"), text: "hi", state })).action, "forward");
});

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

console.log("-- the WeCom long connection --");

/** A WeCom intelligent-robot callback body, as wecom-bot.js normalises it. */
const wecom = (text, chatId = "chat-wecom-1", chatType = "single") => ({
  msgId: `w-${Math.random().toString(36).slice(2, 8)}`,
  botId: "example0BotId0NotReal0000000000000",
  chatId,
  chatType,
  msgType: "text",
  text,
  media: [],
});

await test("a WeCom message reaches the agent when nothing blocks it", async (state) => {
  const verdict = await classifyWecomInbound({ accountId: WECOM, message: wecom("你好"), text: "你好", state });
  assert.equal(verdict.action, "forward");
  assert.equal(verdict.chatId, "chat-wecom-1");
  assert.equal(verdict.isGroup, false);
});

await test("a WeCom group is skipped when only friends are answered", async (state) => {
  await state.savePrefs({ friendOnly: true });
  const inGroup = await classifyWecomInbound({ accountId: WECOM, message: wecom("hi", "chat-wecom-group", "group"), text: "hi", state });
  assert.equal(inGroup.action, "ignore");
  assert.equal(inGroup.reason, "group-skipped");
  const inDirect = await classifyWecomInbound({ accountId: WECOM, message: wecom("hi"), text: "hi", state });
  assert.equal(inDirect.action, "forward", "a 1:1 WeCom chat must still work");
});

await test("the allowlist applies to a WeCom chat exactly as it does to a contact", async (state) => {
  await state.savePrefs({ requireAllowlist: true });  const undecided = await classifyWecomInbound({ accountId: WECOM, message: wecom("hi"), text: "hi", state });
  assert.equal(undecided.action, "ignore");
  assert.equal(undecided.reason, "not-listed");

  await state.setPeer(WECOM, "chat-wecom-1", { allowed: true });
  const allowed = await classifyWecomInbound({ accountId: WECOM, message: wecom("hi"), text: "hi", state });
  assert.equal(allowed.action, "forward");

  await state.setPeer(WECOM, "chat-wecom-2", { allowed: false });
  const blocked = await classifyWecomInbound({ accountId: WECOM, message: wecom("hi", "chat-wecom-2"), text: "hi", state });
  assert.equal(blocked.action, "ignore");
  assert.equal(blocked.reason, "blocked");
});

await test("a 1/2 answer in a WeCom chat is consumed, not turned into a turn", async (state) => {
  // The gap this covers: the long connection skipped the approval step entirely, so
  // answering a prompt started a new turn and the approval waited until it timed out.
  const calls = [];
  const consumeApproval = (accountId, chatId, text) => {
    calls.push([accountId, chatId, text]);
    return text === "1";
  };
  const answer = await classifyWecomInbound({ accountId: WECOM, message: wecom("1"), text: "1", state, consumeApproval });
  assert.equal(answer.action, "answer");
  assert.equal(answer.reason, "approval-answer");
  assert.deepEqual(calls[0], [WECOM, "chat-wecom-1", "1"]);

  const ordinary = await classifyWecomInbound({ accountId: WECOM, message: wecom("2"), text: "2", state, consumeApproval });
  assert.equal(ordinary.action, "forward", "the consumer decides; a stray 2 is still a message");
});

await test("a blocked WeCom chat cannot answer approvals either", async (state) => {
  await state.savePrefs({ requireAllowlist: true });
  await state.setPeer(WECOM, "chat-wecom-1", { allowed: false });
  let asked = false;
  const consumeApproval = () => {
    asked = true;
    return true;
  };
  const verdict = await classifyWecomInbound({ accountId: WECOM, message: wecom("1"), text: "1", state, consumeApproval });
  assert.equal(verdict.action, "ignore");
  assert.equal(asked, false);
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
