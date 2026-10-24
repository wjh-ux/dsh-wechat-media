/**
 * Tests for the QQ bot module. No credentials and no socket: the payload shapes are the documented ones, and each is
 * asserted separately because a QQ bot fails in exactly those places (a wrong identify intent, a reply without msg_id, a
 * wrong endpoint for groups).
 */
import assert from "node:assert/strict";

const qq = await import("../qq-bot.js");

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

await test("the identify payload carries QQBot-prefixed token, the group/C2C intent and one shard", () => {
  const identify = qq.buildIdentify({ token: "abc" });
  assert.equal(identify.op, 2);
  assert.equal(identify.d.token, "QQBot abc");
  assert.equal(identify.d.intents, qq.QQ_INTENT_GROUP_C2C);
  assert.deepEqual(identify.d.shard, [0, 1]);
  assert.equal(qq.buildIdentify({ token: "QQBot abc" }).d.token, "QQBot abc", "no double scheme");
  assert.throws(() => qq.buildIdentify({}), /access token/);
});

await test("a reply quotes the inbound message; a proactive one does not pretend to", () => {
  assert.deepEqual(qq.buildReplyBody({ content: "hi", msgId: "M1", seq: 3 }), { content: "hi", msg_type: 0, msg_id: "M1", msg_seq: 3 });
  assert.deepEqual(qq.buildReplyBody({ content: "hi" }), { content: "hi", msg_type: 0 });
  assert.throws(() => qq.buildReplyBody({ content: "   " }), /空的/);
});

await test("C2C and group events go to different endpoints", () => {
  assert.deepEqual(qq.destinationFor({ t: "C2C_MESSAGE_CREATE", d: { author: { user_openid: "U1" } } }), {
    kind: "c2c",
    path: "/v2/users/U1/messages",
    target: "U1",
  });
  assert.deepEqual(qq.destinationFor({ t: "GROUP_AT_MESSAGE_CREATE", d: { group_openid: "G1" } }), {
    kind: "group",
    path: "/v2/groups/G1/messages",
    target: "G1",
  });
  assert.equal(qq.destinationFor({ t: "AT_MESSAGE_CREATE", d: {} }), null, "an unknown event has no destination");
});

await test("an inbound event flattens to the fields the bridge needs", () => {
  const message = qq.parseQQEvent({
    t: "GROUP_AT_MESSAGE_CREATE",
    d: { id: "M1", content: " 你好 ", group_openid: "G1", author: { member_openid: "MB" }, timestamp: 1700000000000 },
  });
  assert.equal(message.messageId, "M1");
  assert.equal(message.content, "你好", "the leading space QQ adds for an @ is trimmed");
  assert.equal(message.chatId, "G1");
  assert.equal(message.chatType, "group");
  assert.equal(qq.parseQQEvent({ t: "READY", d: {} }), null, "READY is not a message");
});

await test("sandbox bots talk to the sandbox host", () => {
  assert.equal(qq.qqApiBase({ sandbox: false }), "https://api.sgroup.qq.com");
  assert.equal(qq.qqApiBase({ sandbox: true }), "https://sandbox.api.sgroup.qq.com");
});

await test("the token is cached until shortly before it expires, and a refusal keeps the platform's words", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "T1", expires_in: 7200 }) };
  };
  const cache = new qq.QQTokenCache({ fetchImpl, now: () => 1_000_000 });
  assert.equal((await cache.get({ appId: "102000000", clientSecret: "s" })).token, "T1");
  assert.equal((await cache.get({ appId: "102000000", clientSecret: "s" })).cached, true);
  assert.equal(calls, 1, "a second call inside the window must not hit the endpoint");

  const failing = new qq.QQTokenCache({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: "机器人不存在" }) }),
  });
  await assert.rejects(() => failing.get({ appId: "1", clientSecret: "x" }), /机器人不存在/);
  await assert.rejects(() => cache.get({ appId: "", clientSecret: "" }), /appId 和 clientSecret/);
});

await test("sending posts to the right endpoint with the QQBot authorization header", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, ...options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "R1" }) };
  };
  const result = await qq.sendQQMessage({
    token: "T1",
    destination: { path: "/v2/users/U1/messages" },
    content: "你好",
    msgId: "M1",
    fetchImpl,
  });
  assert.equal(seen.url, "https://api.sgroup.qq.com/v2/users/U1/messages");
  assert.equal(seen.headers.authorization, "QQBot T1");
  assert.deepEqual(JSON.parse(seen.body), { content: "你好", msg_type: 0, msg_id: "M1", msg_seq: 1 });
  assert.equal(result.id, "R1");
  await assert.rejects(() => qq.sendQQMessage({ token: "T1", destination: null, content: "x", fetchImpl }), /发给谁/);
});

await test("the long connection identifies on hello and dispatches messages", async () => {
  const sent = [];
  const listeners = new Map();
  const socket = {
    send: (raw) => sent.push(JSON.parse(raw)),
    close: () => {},
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const messages = [];
  const statuses = [];
  const connection = new qq.QQLongConnection({
    appId: "102000000",
    clientSecret: "s",
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("/gateway")
          ? JSON.stringify({ url: "wss://api.sgroup.qq.com/websocket" })
          : JSON.stringify({ access_token: "T1", expires_in: 7200 }),
    }),
    webSocketFactory: () => socket,
  });
  connection.onMessage = (message) => messages.push(message);
  connection.onStatus = (status) => statuses.push(status);
  const connecting = connection.connect();
  // connect() awaits the token and the gateway URL before it creates the socket, so wait for the listener to exist.
  for (let wait = 0; wait < 200 && !listeners.get("open"); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!listeners.get("open")) throw new Error("the socket was never created");
  listeners.get("open")({});
  await connecting;
  const handle = (payload) => listeners.get("message")?.({ data: JSON.stringify(payload) });

  handle({ op: 10, d: { heartbeat_interval: 30000 } });
  assert.equal(sent[0].op, 2, "hello is answered with identify");
  assert.equal(sent[0].d.token, "QQBot T1");

  handle({ op: 0, t: "READY", s: 1, d: { session_id: "S1", user: { username: "bot" } } });
  assert.equal(statuses.at(-1).state, "ready");
  assert.equal(statuses.at(-1).sessionId, "S1");

  handle({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d: { id: "M1", content: "在吗", author: { user_openid: "U1" } } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatId, "U1");
  assert.equal(messages[0].chatType, "c2c");

  handle({ op: 11, s: 3 });
  assert.equal(connection.lastSeq, 3, "the heartbeat sequence is kept for resume");
  await connection.close();
});

await test("the module ships", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("qq-bot.js"), "qq-bot.js must be in files[] or an install cannot import it");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
