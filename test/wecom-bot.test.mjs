/**
 * Tests for the WeCom intelligent-robot long connection: frame shapes, message
 * normalisation, error mapping, the RFC 6455 codec, and the client lifecycle with a
 * fake socket (no network).
 *
 * Run: node test/wecom-bot.test.mjs
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

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

console.log("-- media upload (outbound) --");

/**
 * Drive a bot whose server side answers each upload step, so the whole handshake is
 * exercised: the fake socket replies to whatever cmd it receives for our req_id.
 */
function connectedBot(handlers = {}) {
  const bot = new WecomBot({ botId: "b", secret: "s", WebSocketImpl: FakeSocket, logger: { warn() {} }, ...handlers });
  bot.connect();
  const socket = FakeSocket.last;
  socket.emit("open");
  return { bot, socket, answer: (frame) => socket.emit("message", { data: JSON.stringify(frame) }) };
}

/**
 * Answer every frame the client sends until `isDone()` says the handshake ended (or the
 * deadline passes). Keeps the tests independent of how many frames a handshake needs and
 * of how the chunks are interleaved by the bounded concurrency.
 */
async function serve(socket, answer, onFrame, { isDone = () => false, timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const handled = new Set();
  while (Date.now() < deadline) {
    for (const frame of socket.sent) {
      const id = frame.headers?.req_id;
      if (!id || handled.has(id)) continue;
      handled.add(id);
      onFrame(frame);
    }
    if (isDone()) return true;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  return isDone();
}

const ok = (frame, body = {}) => ({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: "ok", body });
const fail = (frame, errcode, errmsg) => ({ headers: { req_id: frame.headers.req_id }, errcode, errmsg });

await test("uploadMedia runs init -> chunks -> finish and returns the media_id", async () => {
  const { bot, socket, answer } = connectedBot();
  const bytes = randomBytes(1200 * 1024); // 3 chunks at 512 KiB
  const progress = [];
  const seen = [];
  let finished = false;
  const promise = bot.uploadMedia(bytes, { type: "file", filename: "报告.zip", retryDelayMs: 5, onProgress: (p) => progress.push(p) });
  await serve(socket, answer, (frame) => {
    seen.push(frame);
    if (frame.cmd === CMDS.UPLOAD_INIT) answer(ok(frame, { upload_id: "up-1" }));
    else if (frame.cmd === CMDS.UPLOAD_FINISH) {
      finished = true;
      answer(ok(frame, { type: "file", media_id: "media-9", created_at: "now" }));
    } else answer(ok(frame));
  }, { isDone: () => finished });

  const result = await promise;
  assert.deepEqual(result, { mediaId: "media-9", uploadId: "up-1", chunks: 3, bytes: bytes.length, type: "file" });

  const init = seen.find((f) => f.cmd === CMDS.UPLOAD_INIT);
  assert.equal(init.body.type, "file");
  assert.equal(init.body.filename, "报告.zip");
  assert.equal(init.body.total_size, bytes.length);
  assert.equal(init.body.total_chunks, 3);
  assert.equal(init.body.md5, createHash("md5").update(bytes).digest("hex"), "the md5 the platform checks");

  const chunks = seen.filter((f) => f.cmd === CMDS.UPLOAD_CHUNK).sort((a, b) => a.body.chunk_index - b.body.chunk_index);
  assert.deepEqual(chunks.map((c) => c.body.chunk_index), [0, 1, 2]);
  for (const chunk of chunks) {
    assert.equal(chunk.body.upload_id, "up-1");
    assert.ok(chunk.body.base64_data.length > 0);
  }
  assert.deepEqual(
    Buffer.concat(chunks.map((c) => Buffer.from(c.body.base64_data, "base64"))),
    bytes,
    "the chunks reassemble to the file, byte for byte",
  );
  assert.equal(seen.filter((f) => f.cmd === CMDS.UPLOAD_FINISH).length, 1);
  assert.equal(progress.length, 3);
  bot.close();
});

await test("uploadMedia refuses an empty file and anything over 100 chunks", async () => {
  const { bot } = connectedBot();
  await assert.rejects(() => bot.uploadMedia(Buffer.alloc(0)), /nothing to upload/);
  await assert.rejects(() => bot.uploadMedia(Buffer.alloc(100 * 512 * 1024 + 1)), /over the 100 limit/);
  bot.close();
});

await test("uploadMedia retries a refused chunk instead of failing the upload", async () => {
  const { bot, socket, answer } = connectedBot();
  const bytes = Buffer.alloc(700, 1); // one chunk
  let chunkAttempts = 0;
  let refused = 0;
  let finished = false;
  const promise = bot.uploadMedia(bytes, { type: "image", filename: "a.png", retryDelayMs: 5 });
  await serve(socket, answer, (frame) => {
    if (frame.cmd === CMDS.UPLOAD_INIT) answer(ok(frame, { upload_id: "up-2" }));
    else if (frame.cmd === CMDS.UPLOAD_CHUNK) {
      chunkAttempts += 1;
      // refuse the very first attempt once, as the platform does under load
      if (refused === 0) {
        refused += 1;
        answer(fail(frame, 45009, "rate limit"));
      } else answer(ok(frame));
    } else if (frame.cmd === CMDS.UPLOAD_FINISH) {
      finished = true;
      answer(ok(frame, { type: "image", media_id: "m-img" }));
    }
  }, { isDone: () => finished });

  const result = await promise;
  assert.equal(result.mediaId, "m-img");
  assert.equal(chunkAttempts, 2, "the refused chunk was retried rather than failing the whole upload");
  bot.close();
});

await test("a chunk that keeps failing fails the whole upload with a readable message", async () => {
  const { bot, socket, answer } = connectedBot();
  // 600 KiB -> two chunks, so the message names the chunk it gave up on
  const promise = bot.uploadMedia(Buffer.alloc(600 * 1024, 2), { type: "file", filename: "x.bin", retryDelayMs: 5 });
  promise.catch(() => {}); // the rejection is asserted below, after the fake server has replied
  await serve(socket, answer, (frame) => {
    if (frame.cmd === CMDS.UPLOAD_INIT) answer(ok(frame, { upload_id: "up-3" }));
    else if (frame.cmd === CMDS.UPLOAD_CHUNK) answer(fail(frame, 40001, "nope"));
  }, { timeoutMs: 800 });
  await assert.rejects(() => promise, /chunk \d+\/2 failed/);
  bot.close();
});

await test("media replies and sends carry the right command and body", async () => {
  const { bot, socket, answer } = connectedBot();
  const inbound = { cmd: "aibot_msg_callback", headers: { req_id: "in-77" }, body: { msgid: "m1", chatid: "c1", chattype: "group", msgtype: "text", text: { content: "hi" } } };
  socket.emit("message", { data: JSON.stringify(inbound) });
  const reply = bot.replyMedia({ headers: { req_id: "in-77" } }, "image", "media-1");
  const sentReply = socket.sent.at(-1);
  assert.equal(sentReply.cmd, "aibot_respond_msg");
  assert.equal(sentReply.headers.req_id, "in-77");
  assert.deepEqual(sentReply.body, { msgtype: "image", image: { media_id: "media-1" } });
  answer({ headers: { req_id: "in-77" }, errcode: 0, body: {} });
  await reply;

  const active = bot.sendMediaMessage("c1", "file", "media-2");
  const sentActive = socket.sent.at(-1);
  assert.equal(sentActive.cmd, "aibot_send_msg");
  assert.deepEqual(sentActive.body, { chatid: "c1", msgtype: "file", file: { media_id: "media-2" } });
  answer({ headers: { req_id: sentActive.headers.req_id }, errcode: 0, body: {} });
  await active;

  // video carries title/description; a rejection is surfaced, not swallowed
  const video = bot.sendMediaMessage("c1", "video", "media-3", { title: "t", description: "d" });
  const sentVideo = socket.sent.at(-1);
  assert.deepEqual(sentVideo.body.video, { media_id: "media-3", title: "t", description: "d" });
  answer({ headers: { req_id: sentVideo.headers.req_id }, errcode: 45009, errmsg: "rate limit" });
  await assert.rejects(() => video, /45009|rate limit/);
  bot.close();
});

await test("a request that is never answered fails instead of hanging", async () => {
  const { bot } = connectedBot();
  await assert.rejects(() => bot.request("aibot_upload_media_init", {}, { timeoutMs: 25 }), /no answer to aibot_upload_media_init within 25 ms/);
  bot.close();
  const closed = connectedBot();
  closed.bot.close();
  await assert.rejects(() => closed.bot.request("ping", {}, { timeoutMs: 25 }), /not writable/);
});

await test("the closing stream frame is acknowledged, and errcode 6000 is surfaced", async () => {
  // Intermediate frames are fire-and-forget, but the closing one is what makes the platform keep the
  // message - so its answer is read. Without this, a rejected close left an unfinished fragment in
  // the chat and nothing anywhere said why.
  const bot = new WecomBot({ botId: "bot1", secret: "sec", WebSocketImpl: FakeSocket, heartbeatMs: 100000, logger: { warn() {} } });
  bot.connect();
  const socket = FakeSocket.last;
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ headers: { req_id: socket.sent[0].headers.req_id }, errcode: 0, errmsg: "ok" }) });
  const inbound = { cmd: CMDS.CALLBACK, headers: { req_id: "in-1" }, body: { msgid: "m1", chatid: "c1", msgtype: "text", text: { content: "hi" } } };

  const waiting = bot.replyAndWait(inbound, streamBody("s1", "the whole answer", true), { timeoutMs: 2000 });
  const sent = socket.sent.at(-1);
  assert.equal(sent.cmd, "aibot_respond_msg");
  assert.equal(sent.headers.req_id, "in-1", "the answer must be matched to the inbound request");
  assert.equal(sent.body.stream.finish, true, "the closing frame is the one that finishes the stream");
  assert.equal(sent.body.stream.id, "s1");
  socket.emit("message", { data: JSON.stringify({ headers: { req_id: "in-1" }, errcode: 0, errmsg: "ok" }) });
  await waiting; // resolves only because the platform answered

  const refused = bot.replyAndWait(inbound, streamBody("s1", "the whole answer", true), { timeoutMs: 2000 });
  socket.emit("message", { data: JSON.stringify({ headers: { req_id: "in-1" }, errcode: 6000, errmsg: "data version conflict" }) });
  await assert.rejects(refused, /6000|data version conflict/, "a refused close must not look like success");
  bot.close();
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);