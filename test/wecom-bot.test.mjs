/**
 * Tests for the WeCom intelligent-robot long connection: frame shapes, message
 * normalisation, error mapping, the RFC 6455 codec, and the client lifecycle with a
 * fake socket (no network).
 *
 * Run: node test/wecom-bot.test.mjs
 */
import assert from "node:assert/strict";

import { CMDS, WecomBot, authFrame, botError, describeBotMessage, heartbeatFrame, markdownBody, mediaBody, parseFrame, replyFrame, sendFrame, splitForStream, streamBody, textBody } from "../wecom-bot.js";
import { acceptKey, decodeFrames, encodeFrame } from "../ws-client.js";

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

console.log("wecom bot (long connection)");

console.log("-- frames --");

await test("the documented frame shapes are produced", () => {
  assert.deepEqual(authFrame("bot1", "sec", "r1"), { cmd: "aibot_subscribe", headers: { req_id: "r1" }, body: { secret: "sec", bot_id: "bot1" } });
  assert.deepEqual(heartbeatFrame("r2"), { cmd: "ping", headers: { req_id: "r2" } });
  assert.deepEqual(textBody("hi"), { msgtype: "text", text: { content: "hi" } });
  assert.deepEqual(markdownBody("**b**"), { msgtype: "markdown", markdown: { content: "**b**" } });
  assert.deepEqual(mediaBody("image", "M1"), { msgtype: "image", image: { media_id: "M1" } });
  assert.deepEqual(streamBody("s1", "hi"), { msgtype: "stream", stream: { id: "s1", finish: true, content: "hi" } });
  assert.deepEqual(streamBody("s1", "hi", false), { msgtype: "stream", stream: { id: "s1", finish: false, content: "hi" } });
  assert.deepEqual(mediaBody("video", "M2", { title: "t", description: "d" }), { msgtype: "video", video: { media_id: "M2", title: "t", description: "d" } });
  const reply = replyFrame({ cmd: CMDS.CALLBACK, headers: { req_id: "in-1" }, body: { msgid: "m1" } }, textBody("ok"));
  assert.equal(reply.cmd, "aibot_respond_msg");
  assert.equal(reply.headers.req_id, "in-1", "the inbound req_id is passed through");
  assert.equal(reply.headers.reply_to, undefined, "no invented correlation field");
  assert.deepEqual(sendFrame("chat1", textBody("hi"), "r4"), { cmd: "aibot_send_msg", headers: { req_id: "r4" }, body: { chatid: "chat1", msgtype: "text", text: { content: "hi" } } });
});

await test("a long answer is split on utf8 byte boundaries", () => {
  const parts = splitForStream("你好".repeat(4000)); // 24000 bytes
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(Buffer.byteLength(part, "utf8") <= 20480);
  assert.equal(parts.join(""), "你好".repeat(4000), "nothing is lost or duplicated");
  assert.deepEqual(splitForStream(""), [""]);
});

await test("a callback is normalised for the rest of the plugin", () => {
  const single = describeBotMessage({ cmd: CMDS.CALLBACK, headers: {}, body: { msgid: "m1", aibotid: "b1", msgtype: "text", chattype: "single", from: { userid: "u1" }, text: { content: "你好" } } });
  assert.deepEqual(single, { msgId: "m1", botId: "b1", chatId: "u1", chatType: "single", msgType: "text", text: "你好", media: [] });
  const group = describeBotMessage({ cmd: CMDS.CALLBACK, headers: {}, body: { msgid: "m2", chatid: "c1", msgtype: "image", image: { url: "https://x/1", aeskey: "k" } } });
  assert.equal(group.chatType, "group");
  assert.equal(group.chatId, "c1");
  assert.deepEqual(group.media[0], { type: "image", url: "https://x/1", aesKey: "k" });
  assert.equal(describeBotMessage({ cmd: "ping" }), undefined);
  assert.equal(describeBotMessage(undefined), undefined);
});

await test("every media-bearing shape is collected, not just the top-level one", () => {
  // 图文混排 (mixed): text parts are the message text, image parts are media. It used
  // to produce neither, so such a message was counted as unusable and dropped.
  const mixed = describeBotMessage({
    cmd: CMDS.CALLBACK,
    headers: {},
    body: {
      msgid: "m3",
      aibotid: "b1",
      msgtype: "mixed",
      chatid: "c1",
      mixed: { msg_item: [
        { msgtype: "text", text: { content: "看这张图" } },
        { msgtype: "image", image: { url: "https://x/mixed", aeskey: "km" } },
      ] },
    },
  });
  assert.equal(mixed.text, "看这张图");
  assert.deepEqual(mixed.media, [{ type: "image", url: "https://x/mixed", aesKey: "km" }]);

  // A quoted file/image (引用): the attachment is what the user is pointing at.
  const quoted = describeBotMessage({
    cmd: CMDS.CALLBACK,
    headers: {},
    body: {
      msgid: "m4",
      aibotid: "b1",
      msgtype: "text",
      chatid: "c1",
      text: { content: "这个改一下" },
      quote: { msgtype: "file", file: { url: "https://x/quoted", aeskey: "kq" }, text: { content: "被引用的文本" } },
    },
  });
  assert.equal(quoted.text, "这个改一下", "quoted text must not replace the message text");
  assert.deepEqual(quoted.media, [{ type: "file", url: "https://x/quoted", aesKey: "kq", fileName: undefined }]);

  // A voice message is a transcription, with no url to download.
  const voice = describeBotMessage({ cmd: CMDS.CALLBACK, headers: {}, body: { msgid: "m5", aibotid: "b1", msgtype: "voice", chattype: "single", from: { userid: "u1" }, voice: { content: "语音转出来的字" } } });
  assert.equal(voice.text, "语音转出来的字");
  assert.deepEqual(voice.media, []);
});

await test("errors name what to fix, including the code the server really sends", () => {
  assert.equal(botError({ errcode: 0 }), undefined);
  assert.equal(botError({}), undefined);
  assert.match(botError({ errcode: 853000, errmsg: "invalid bot_id or secret" }), /853000: invalid BotID or Secret/);
  assert.match(botError({ errcode: 40001, errmsg: "invalid credential" }), /BotID and Secret/);
  assert.match(botError({ errcode: 99999, errmsg: "odd" }), /WeCom bot 99999 - odd/);
});

await test("frames parse only when they are JSON", () => {
  assert.deepEqual(parseFrame('{"a":1}'), { a: 1 });
  assert.equal(parseFrame("not json"), undefined);
  assert.equal(parseFrame(""), undefined);
});

console.log("-- rfc 6455 codec --");

await test("the handshake accept value matches the RFC example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

await test("frames survive an encode/decode round trip, including lengths", () => {
  for (const payload of ["", "hi", "x".repeat(200), "y".repeat(70000)]) {
    const encoded = encodeFrame(0x1, payload);
    assert.equal(encoded[1] & 0x80, 0x80, "client frames must be masked");
    const { frames, rest } = decodeFrames(encoded);
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, 0x1);
    assert.equal(frames[0].payload.toString("utf8"), payload);
  }
});

await test("a partial frame is left in the buffer instead of corrupting the stream", () => {
  const encoded = encodeFrame(0x1, "hello world");
  const first = decodeFrames(encoded.subarray(0, 6));
  assert.equal(first.frames.length, 0);
  const second = decodeFrames(Buffer.concat([first.rest, encoded.subarray(6)]));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].payload.toString("utf8"), "hello world");
});

console.log("-- client lifecycle --");

/** A stand-in for MiniWebSocket that records what the client sends. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.handlers = {};
    FakeSocket.last = this;
  }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.handlers.close?.({ code: 1000 }); }
  emit(type, event) { this.handlers[type]?.(event); }
}

await test("connecting authenticates, heartbeats and reports status honestly", async () => {
  const statuses = [];
  const bot = new WecomBot({ botId: "bot1", secret: "sec", WebSocketImpl: FakeSocket, heartbeatMs: 15, logger: { warn() {} }, onStatus: (s) => statuses.push(s) });
  bot.connect();
  const socket = FakeSocket.last;
  assert.equal(statuses[0].connected, false, "constructing a socket is not being connected");
  socket.emit("open");
  assert.equal(socket.sent[0].cmd, "aibot_subscribe");
  assert.equal(socket.sent[0].body.bot_id, "bot1");
  assert.equal(bot.status().authenticated, false);
  socket.emit("message", { data: JSON.stringify({ headers: { req_id: socket.sent[0].headers.req_id }, errcode: 0, errmsg: "ok" }) });
  assert.equal(bot.status().authenticated, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(socket.sent.some((frame) => frame.cmd === "ping"), "a heartbeat is sent");
  bot.close();
  assert.equal(bot.status().connected, false);
});

await test("an inbound callback reaches onMessage and can be answered", () => {
  const seen = [];
  const bot = new WecomBot({ botId: "b", secret: "s", WebSocketImpl: FakeSocket, logger: { warn() {} }, onMessage: (message, frame) => seen.push({ message, frame }) });
  bot.connect();
  const socket = FakeSocket.last;
  socket.emit("open");
  const inbound = { cmd: "aibot_msg_callback", headers: { req_id: "in-9" }, body: { msgid: "m9", chatid: "c9", chattype: "group", msgtype: "text", text: { content: "在吗" } } };
  socket.emit("message", { data: JSON.stringify(inbound) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message.text, "在吗");
  bot.reply(seen[0].frame, streamBody("s-1", "在"));
  const replySent = socket.sent.at(-1);
  assert.equal(replySent.cmd, "aibot_respond_msg");
  assert.equal(replySent.headers.req_id, "in-9", "the reply reuses the inbound req_id");
  assert.equal(replySent.body.msgtype, "stream", "a passive reply must be a stream body");
  assert.equal(replySent.body.stream.content, "在");
  bot.sendMessage("c9", markdownBody("**hi**"));
  const sendSent = socket.sent.at(-1);
  assert.equal(sendSent.cmd, "aibot_send_msg");
  assert.equal(sendSent.body.chatid, "c9");
  bot.close();
});

await test("a server error is surfaced and the client reconnects", async () => {
  const warnings = [];
  const statuses = [];
  const bot = new WecomBot({ botId: "b", secret: "s", WebSocketImpl: FakeSocket, reconnectBaseMs: 5, maxReconnectAttempts: 2, logger: { warn: (...a) => warnings.push(a.map(String).join(" ")) }, onStatus: (s) => statuses.push(s) });
  bot.connect();
  const socket = FakeSocket.last;
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ headers: { req_id: "x" }, errcode: 853000, errmsg: "invalid bot_id or secret" }) });
  assert.match(warnings.join("\n"), /853000/);
  socket.emit("close", { code: 1006 });
  assert.ok(statuses.some((s) => s.attempts === 1), "a reconnect is scheduled");
  bot.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);