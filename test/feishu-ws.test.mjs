/**
 * Offline tests for the Feishu long connection.
 *
 * Everything external is faked - the fetch, the WebSocket, the timers and the clock - so connect, ping, receive,
 * fragment merging, ack and reconnect are all exercised deterministically without touching the network.
 *
 * The protocol facts asserted here (field numbers, enum values, defaults) are copied from
 * `@larksuiteoapi/node-sdk@1.75.0/lib/index.js`; the test that pins them exists so that a later edit cannot quietly
 * change a field number and still round-trip with itself.
 *
 * Run: node test/feishu-ws.test.mjs
 */
import assert from "node:assert/strict";

import {
  CONNECTION_STATE,
  FRAME_FIELDS,
  FRAME_TYPE,
  FeishuLongConnection,
  FragmentMerger,
  HEADER_FIELDS,
  HEADER_KEY,
  MESSAGE_TYPE,
  WS_DEFAULTS,
  decodeFrame,
  decodeHeader,
  encodeFrame,
  encodeHeader,
  headersToObject,
  postHandshake,
  startFeishuLongConnection,
} from "../feishu-ws.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

// -----------------------------------------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------------------------------------

/** A fake WebSocket that records what was sent and lets the test drive its lifecycle. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
  }

  send(bytes) {
    this.sent.push(Buffer.from(bytes));
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(frame) {
    this.onmessage?.({ data: frame });
  }

  fail(message = "boom") {
    this.onerror?.({ message });
  }

  /** Every frame the client sent, decoded. */
  frames() {
    return this.sent.map((bytes) => decodeFrame(bytes));
  }
}

/** A fake timer pair with manual firing, so ping and reconnect are deterministic. */
function fakeTimers() {
  const pending = [];
  let next = 1;
  return {
    pending,
    setTimeoutImpl: (fn, delay) => {
      const id = next++;
      pending.push({ id, fn, delay });
      return id;
    },
    clearTimeoutImpl: (id) => {
      const index = pending.findIndex((entry) => entry.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    /** Fire the first pending timer with the given delay (or any delay when omitted). */
    fire(delay = undefined) {
      const index = delay === undefined ? 0 : pending.findIndex((entry) => entry.delay === delay);
      assert.ok(index >= 0, `no pending timer${delay === undefined ? "" : ` with delay ${delay}`}`);
      const [entry] = pending.splice(index, 1);
      entry.fn();
      return entry;
    },
    delays() {
      return pending.map((entry) => entry.delay);
    },
  };
}

const HANDSHAKE = {
  code: 0,
  data: { URL: "wss://open.feishu.cn/connect/v1/ws", ClientConfig: { PingInterval: 2, ReconnectCount: 3, ReconnectInterval: 4, ReconnectNonce: 5 } },
  msg: "ok",
};

function fakeFetch(reply = HANDSHAKE, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { status, json: async () => reply };
  };
  impl.calls = calls;
  return impl;
}

/** A connection wired to fakes, already connected, with the socket in hand. */
async function connected({ reply = HANDSHAKE, options = {} } = {}) {
  const timers = fakeTimers();
  const fetchImpl = fakeFetch(reply);
  const socketRef = { current: null };
  const connection = new FeishuLongConnection({
    appId: "cli_test",
    appSecret: "secret-value",
    fetchImpl,
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url);
      socketRef.current = socket;
      queueMicrotask(() => socket.open());
      return socket;
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...options,
  });
  await connection.start();
  return { connection, socket: socketRef.current, timers, fetchImpl, socketRef };
}

/** Build one single-fragment event frame. */
function eventFrame({ seqId = 11, messageId = "m1", payload = '{"schema":"2.0","header":{"event_type":"im.message.receive_v1"}}', extraHeaders = [] } = {}) {
  return encodeFrame({
    SeqID: seqId,
    LogID: seqId + 1,
    service: 1,
    method: 1,
    headers: [
      { key: HEADER_KEY.type, value: MESSAGE_TYPE.event },
      { key: HEADER_KEY.messageId, value: messageId },
      { key: HEADER_KEY.sum, value: "1" },
      { key: HEADER_KEY.seq, value: "0" },
      { key: HEADER_KEY.traceId, value: "t1" },
      ...extraHeaders,
    ],
    payload: Buffer.from(payload, "utf8"),
  });
}

// -----------------------------------------------------------------------------------------------------------
// Protocol constants - pinned to the official descriptor so a field number cannot drift unnoticed.
// -----------------------------------------------------------------------------------------------------------

await test("the protobuf field numbers are the official ones", () => {
  // From `Frame.encode` / `Header.encode` in the SDK's descriptor.
  assert.deepEqual(FRAME_FIELDS, { seqId: 1, logId: 2, service: 3, method: 4, headers: 5, payloadEncoding: 6, payloadType: 7, payload: 8, logIdNew: 9 });
  assert.deepEqual(HEADER_FIELDS, { key: 1, value: 2 });
});

await test("the enums are the official ones", () => {
  assert.deepEqual(FRAME_TYPE, { control: 0, data: 1 });
  assert.deepEqual(MESSAGE_TYPE, { event: "event", card: "card", ping: "ping", pong: "pong" });
  assert.equal(HEADER_KEY.type, "type");
  assert.equal(HEADER_KEY.messageId, "message_id");
  assert.equal(HEADER_KEY.sum, "sum");
  assert.equal(HEADER_KEY.seq, "seq");
  assert.equal(HEADER_KEY.traceId, "trace_id");
  assert.equal(HEADER_KEY.bizRt, "biz_rt");
});

await test("the defaults are the official ones", () => {
  assert.deepEqual(WS_DEFAULTS, { pingIntervalMs: 120_000, reconnectCount: -1, reconnectIntervalMs: 120_000, reconnectNonceMs: 30_000 });
});

await test("a hand-built byte sequence decodes to the documented fields", () => {
  // Field 1 (SeqID, varint) = 7 → tag 0x08, value 0x07.
  // Field 3 (service, varint) = 1 → tag 0x18, value 0x01.
  // Field 5 (headers) = one Header{key:"type", value:"ping"}.
  const header = encodeHeader({ key: "type", value: "ping" });
  const frame = encodeFrame({ SeqID: 7, service: 1, headers: [{ key: "type", value: "ping" }] });
  assert.equal(frame.subarray(0, 2).toString("hex"), "0807", "SeqID is field 1 as a varint");
  assert.ok(frame.includes(Buffer.from([0x18, 0x01])), "service is field 3 as a varint");
  assert.ok(frame.includes(header), "the Header is embedded under field 5");
  const raw = Buffer.concat([Buffer.from([0x08, 0x07, 0x18, 0x01]), Buffer.from([0x2a, header.length]), header]);
  const decoded = decodeFrame(raw);
  assert.equal(decoded.SeqID, 7);
  assert.equal(decoded.service, 1);
  assert.deepEqual(decoded.headers, [{ key: "type", value: "ping" }]);
});

// -----------------------------------------------------------------------------------------------------------
// Frame codec
// -----------------------------------------------------------------------------------------------------------

await test("a frame survives a round trip, including absence", () => {
  const full = {
    SeqID: 42,
    LogID: 43,
    service: 1,
    method: 1,
    headers: [{ key: "type", value: "event" }, { key: "sum", value: "3" }],
    payloadEncoding: "json",
    payloadType: "event",
    payload: Buffer.from('{"a":"世界"}', "utf8"),
    LogIDNew: "abc",
  };
  const back = decodeFrame(encodeFrame(full));
  assert.equal(back.SeqID, 42);
  assert.equal(back.LogID, 43);
  assert.equal(back.service, 1);
  assert.equal(back.method, 1);
  assert.deepEqual(back.headers, full.headers);
  assert.equal(back.payloadEncoding, "json");
  assert.equal(back.payloadType, "event");
  assert.equal(back.LogIDNew, "abc");
  assert.equal(back.payload.toString("utf8"), '{"a":"世界"}', "UTF-8 survives");

  const bare = decodeFrame(encodeFrame({}));
  assert.deepEqual(bare, { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] });
  assert.equal(bare.payload, undefined, "an absent payload stays absent rather than becoming empty");
});

await test("a large payload and a large id survive", () => {
  const big = Buffer.alloc(200_000, 0x41);
  const back = decodeFrame(encodeFrame({ SeqID: 1, payload: big }));
  assert.equal(back.payload.length, 200_000);
  assert.ok(back.payload.equals(big));

  // uint64 beyond Number.MAX_SAFE_INTEGER arrives as a BigInt so an id is never silently rounded.
  const huge = BigInt("18446744073709551615");
  const decoded = decodeFrame(encodeFrame({ SeqID: huge }));
  assert.equal(decoded.SeqID, huge);
  assert.equal(typeof decoded.SeqID, "bigint");
});

await test("a header with a long UTF-8 value and many headers round-trip", () => {
  const headers = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, value: `值-${i}-${"x".repeat(50)}` }));
  const back = decodeFrame(encodeFrame({ headers }));
  assert.deepEqual(back.headers, headers);
  const single = decodeHeader(encodeHeader({ key: "trace_id", value: "中文 trace" }), 0);
  assert.deepEqual(single.value, { key: "trace_id", value: "中文 trace" });
});

await test("a truncated frame is refused instead of guessed", () => {
  const frame = encodeFrame({ SeqID: 1, payload: Buffer.alloc(100, 1) });
  assert.throws(() => decodeFrame(frame.subarray(0, frame.length - 50)), /truncated/);
  assert.throws(() => decodeFrame(Buffer.from([0x08])), /truncated varint/);
});

await test("headers become a plain object the way the SDK maps them", () => {
  assert.deepEqual(headersToObject([{ key: "type", value: "event" }, { key: "sum", value: "1" }]), { type: "event", sum: "1" });
  assert.deepEqual(headersToObject([]), {});
});

// -----------------------------------------------------------------------------------------------------------
// Fragment merging
// -----------------------------------------------------------------------------------------------------------

await test("fragments merge in order and out of order", () => {
  const merger = new FragmentMerger();
  assert.equal(merger.merge({ messageId: "a", sum: 3, seq: 0, data: Buffer.from('{"x":') }), undefined);
  assert.equal(merger.merge({ messageId: "a", sum: 3, seq: 2, data: Buffer.from('"y":2}') }), undefined);
  assert.equal(merger.size, 1, "still waiting for one piece");
  assert.deepEqual(merger.merge({ messageId: "a", sum: 3, seq: 1, data: Buffer.from('"a",') }), { x: "a", y: 2 });
});

await test("a completed event is parsed as JSON and its fragments forgotten", () => {
  const merger = new FragmentMerger();
  merger.merge({ messageId: "b", sum: 2, seq: 0, data: Buffer.from('{"schema":"2.0",') });
  const done = merger.merge({ messageId: "b", sum: 2, seq: 1, data: Buffer.from('"event":"x"}') });
  assert.deepEqual(done, { schema: "2.0", event: "x" });
  assert.equal(merger.size, 0, "the cache entry is dropped once merged");

  // A second, identical fragment must not resurrect the old buffer.
  assert.equal(merger.merge({ messageId: "b", sum: 2, seq: 0, data: Buffer.from("{}") }), undefined);
});

await test("malformed fragment metadata is refused, not turned into a sparse array", () => {
  const merger = new FragmentMerger();
  const bad = [
    { sum: 0, seq: 0 },
    { sum: -1, seq: 0 },
    { sum: 2, seq: -1 },
    { sum: 2, seq: 2 },
    { sum: 2.5, seq: 0 },
    { sum: 2, seq: 1.5 },
    { sum: "x", seq: 0 },
    { sum: 2, seq: undefined },
    { sum: undefined, seq: 0 },
  ];
  for (const entry of bad) {
    assert.throws(
      () => merger.merge({ messageId: `bad-${JSON.stringify(entry)}`, data: Buffer.from("{}"), ...entry }),
      /invalid event fragment metadata/,
      JSON.stringify(entry),
    );
  }
  assert.equal(merger.size, 0, "nothing was cached for a rejected fragment");
});

await test("a later fragment that disagrees about sum is refused", () => {
  const merger = new FragmentMerger();
  merger.merge({ messageId: "c", sum: 2, seq: 0, data: Buffer.from("{}") });
  assert.throws(() => merger.merge({ messageId: "c", sum: 3, seq: 1, data: Buffer.from("{}") }), /differs from first fragment's 2/);
});

await test("fragments that never complete expire instead of leaking", () => {
  let now = 1_000;
  const merger = new FragmentMerger({ ttlMs: 100, now: () => now });
  merger.merge({ messageId: "d", sum: 2, seq: 0, data: Buffer.from("{}") });
  assert.equal(merger.size, 1);
  now += 101;
  merger.merge({ messageId: "e", sum: 2, seq: 0, data: Buffer.from("{}") });
  assert.equal(merger.size, 1, "the stale entry was dropped");
});

await test("an unparseable merge raises rather than silently dropping the event", () => {
  const merger = new FragmentMerger();
  merger.merge({ messageId: "f", sum: 2, seq: 0, data: Buffer.from("not json") });
  assert.throws(() => merger.merge({ messageId: "f", sum: 2, seq: 1, data: Buffer.from("at all") }), SyntaxError);
});

// -----------------------------------------------------------------------------------------------------------
// Handshake
// -----------------------------------------------------------------------------------------------------------

await test("the handshake posts the app credentials to the ws endpoint", async () => {
  const impl = fakeFetch();
  const result = await postHandshake({ appId: "cli_x", appSecret: "sekret", fetchImpl: impl });
  assert.match(impl.calls[0].url, /^https:\/\/open\.feishu\.cn\/callback\/ws\/endpoint$/);
  assert.equal(impl.calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(impl.calls[0].options.body), { AppID: "cli_x", AppSecret: "sekret" });
  assert.equal(result.url, "wss://open.feishu.cn/connect/v1/ws");
});

await test("ClientConfig is converted from seconds to milliseconds", async () => {
  const result = await postHandshake({ appId: "a", appSecret: "s", fetchImpl: fakeFetch() });
  assert.equal(result.pingIntervalMs, 2000);
  assert.equal(result.reconnectIntervalMs, 4000);
  assert.equal(result.reconnectNonceMs, 5000);
  assert.equal(result.reconnectCount, 3);
  assert.deepEqual(result.clientConfig, HANDSHAKE.data.ClientConfig);
});

await test("a handshake without ClientConfig falls back to the documented defaults", async () => {
  const reply = { code: 0, data: { URL: "wss://x/y" }, msg: "ok" };
  const result = await postHandshake({ appId: "a", appSecret: "s", fetchImpl: fakeFetch(reply) });
  assert.equal(result.pingIntervalMs, WS_DEFAULTS.pingIntervalMs);
  assert.equal(result.reconnectIntervalMs, WS_DEFAULTS.reconnectIntervalMs);
  assert.equal(result.reconnectNonceMs, WS_DEFAULTS.reconnectNonceMs);
  assert.equal(result.reconnectCount, WS_DEFAULTS.reconnectCount);
});

await test("a refused handshake reports the platform's own reason and never the secret", async () => {
  const refused = fakeFetch({ code: 10003, msg: "invalid app_secret" });
  await assert.rejects(() => postHandshake({ appId: "cli_x", appSecret: "sekret", fetchImpl: refused }), (error) => {
    assert.match(error.message, /code 10003/);
    assert.match(error.message, /invalid app_secret/);
    assert.doesNotMatch(error.message, /sekret/, "the secret must not appear in the error");
    return true;
  });

  const noUrl = fakeFetch({ code: 0, data: {}, msg: "ok" });
  await assert.rejects(() => postHandshake({ appId: "a", appSecret: "s", fetchImpl: noUrl }), /no WebSocket URL/);
  await assert.rejects(() => postHandshake({ appId: "", appSecret: "s" }), /app_id and app_secret/);
});

await test("the lark domain and an explicit URL both work", async () => {
  const lark = fakeFetch();
  await postHandshake({ appId: "a", appSecret: "s", domain: "lark", fetchImpl: lark });
  assert.match(lark.calls[0].url, /^https:\/\/open\.larksuite\.com\//);
  const custom = fakeFetch();
  await postHandshake({ appId: "a", appSecret: "s", domain: "https://feishu.internal/", fetchImpl: custom });
  assert.match(custom.calls[0].url, /^https:\/\/feishu\.internal\/callback\/ws\/endpoint$/);
});

// -----------------------------------------------------------------------------------------------------------
// Lifecycle: connect, ping, receive, ack, reconnect, stop
// -----------------------------------------------------------------------------------------------------------

await test("start connects and stop closes, and neither leaks the secret", async () => {
  const { connection, socket } = await connected();
  assert.equal(connection.status().state, CONNECTION_STATE.connected);
  assert.equal(socket.url, HANDSHAKE.data.URL);
  assert.equal(JSON.stringify(connection.status()).includes("secret-value"), false, "status must not carry the secret");
  connection.stop();
  assert.equal(connection.status().state, CONNECTION_STATE.closed);
});

await test("stop is safe before start and twice in a row", () => {
  const connection = startFeishuLongConnection({ appId: "a", appSecret: "s", fetchImpl: fakeFetch() });
  connection.stop();
  connection.stop();
  assert.equal(connection.status().state, CONNECTION_STATE.closed);
});

await test("a ping frame goes out on the handshake's interval", async () => {
  const { connection, socket, timers } = await connected();
  assert.deepEqual(timers.delays(), [2000], "one ping timer, on the interval the server asked for");
  timers.fire(2000);
  const ping = socket.frames().find((frame) => headersToObject(frame.headers).type === MESSAGE_TYPE.ping);
  assert.ok(ping, "a ping frame was sent");
  assert.equal(ping.method, FRAME_TYPE.control, "ping is a control frame");
  assert.equal(ping.SeqID, 0);
  assert.equal(connection.status().stats.pings, 1);
  assert.deepEqual(timers.delays(), [2000], "and the next ping is armed");
  connection.stop();
});

await test("an event reaches the handler and is acknowledged the way the protocol expects", async () => {
  const { connection, socket } = await connected();
  let seen = null;
  connection.onEvent((event) => {
    seen = event;
    return { handled: true };
  });
  socket.deliver(eventFrame());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen?.header?.event_type, "im.message.receive_v1");

  const ack = socket.frames().find((frame) => frame.payload && headersToObject(frame.headers).type === MESSAGE_TYPE.event);
  assert.ok(ack, "an ack frame was sent");
  assert.equal(ack.SeqID, 11, "the ack echoes the received frame's id");
  assert.equal(ack.LogID, 12);
  assert.equal(ack.service, 1);
  const headers = headersToObject(ack.headers);
  assert.equal(headers.biz_rt !== undefined, true, "biz_rt is appended");
  assert.deepEqual(JSON.parse(ack.payload.toString("utf8")), { code: 200, data: Buffer.from(JSON.stringify({ handled: true })).toString("base64") });
  assert.equal(connection.status().stats.acks, 1);
  connection.stop();
});

await test("an ack is still sent when the handler throws, with code 500", async () => {
  const { connection, socket } = await connected();
  const errors = [];
  connection.onError((error) => errors.push(error));
  connection.onEvent(() => {
    throw new Error("handler exploded");
  });
  socket.deliver(eventFrame({ seqId: 21 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ack = socket.frames().find((frame) => frame.payload && frame.SeqID === 21);
  assert.equal(JSON.parse(ack.payload.toString("utf8")).code, 500);
  assert.equal(errors.length, 1, "the failure is reported");
  assert.match(errors[0].message, /handler exploded/);
  connection.stop();
});

await test("a fragmented event is not acknowledged until every piece has arrived", async () => {
  const { connection, socket } = await connected();
  const events = [];
  connection.onEvent((event) => events.push(event));
  const part = (seq, text) => encodeFrame({
    SeqID: 31,
    service: 1,
    method: 1,
    headers: [
      { key: HEADER_KEY.type, value: MESSAGE_TYPE.event },
      { key: HEADER_KEY.messageId, value: "frag-1" },
      { key: HEADER_KEY.sum, value: "2" },
      { key: HEADER_KEY.seq, value: String(seq) },
    ],
    payload: Buffer.from(text, "utf8"),
  });
  socket.deliver(part(0, '{"schema":"2.0",'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 0, "nothing is emitted for a partial event");
  assert.equal(socket.frames().filter((frame) => frame.payload && frame.SeqID === 31).length, 0, "and nothing is acked yet");
  assert.equal(connection.status().stats.fragments, 1);

  socket.deliver(part(1, '"event":"done"}'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, [{ schema: "2.0", event: "done" }]);
  assert.equal(socket.frames().filter((frame) => frame.payload && frame.SeqID === 31).length, 1, "now it is acked once");
  connection.stop();
});

await test("a malformed fragment is reported, and the connection stays usable", async () => {
  const { connection, socket } = await connected();
  const errors = [];
  connection.onError((error) => errors.push(error));
  const broken = encodeFrame({
    SeqID: 41,
    headers: [
      { key: HEADER_KEY.type, value: MESSAGE_TYPE.event },
      { key: HEADER_KEY.messageId, value: "bad-1" },
      { key: HEADER_KEY.sum, value: "0" },
      { key: HEADER_KEY.seq, value: "0" },
    ],
    payload: Buffer.from("{}", "utf8"),
  });
  socket.deliver(broken);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /invalid event fragment metadata/);
  assert.match(errors[0].message, /bad-1/, "the metadata is logged for reconciliation");

  let seen = false;
  connection.onEvent(() => {
    seen = true;
  });
  socket.deliver(eventFrame({ seqId: 51 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen, true, "a later, valid event still works");
  connection.stop();
});

await test("junk on the wire is reported rather than swallowed", async () => {
  const { connection, socket } = await connected();
  const errors = [];
  connection.onError((error) => errors.push(error));
  socket.deliver(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /could not decode an inbound frame/);
  connection.stop();
});

await test("pong is accepted quietly and an unknown type is counted, not crashed on", async () => {
  const { connection, socket } = await connected();
  socket.deliver(encodeFrame({ headers: [{ key: HEADER_KEY.type, value: MESSAGE_TYPE.pong }] }));
  socket.deliver(encodeFrame({ headers: [{ key: HEADER_KEY.type, value: "something-new" }] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.status().stats.pongs, 1);
  assert.equal(connection.status().stats.ignored, 1);
  connection.stop();
});

await test("a ping from the server is answered with a pong", async () => {
  const { connection, socket } = await connected();
  socket.deliver(encodeFrame({ SeqID: 61, service: 1, method: FRAME_TYPE.control, headers: [{ key: HEADER_KEY.type, value: MESSAGE_TYPE.ping }] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pong = socket.frames().find((frame) => headersToObject(frame.headers).type === MESSAGE_TYPE.pong);
  assert.ok(pong, "a pong went back");
  assert.equal(pong.SeqID, 61, "echoing the ping's id");
  connection.stop();
});

await test("a dropped connection reconnects on the server's interval", async () => {
  const { connection, socket, timers, socketRef } = await connected();
  socket.onclose?.({ code: 1006 });
  assert.equal(connection.status().state, CONNECTION_STATE.reconnecting);
  assert.equal(connection.status().stats.reconnects, 1);
  assert.deepEqual(timers.delays(), [4000], "the reconnect uses ReconnectInterval");
  timers.fire(4000);
  assert.notEqual(socketRef.current, socket, "a new socket was opened");
  assert.equal(connection.status().reconnectAttempts, 1);
  connection.stop();
});

await test("reconnecting stops when autoReconnect is off or the count is exhausted", async () => {
  const { connection, socket } = await connected({ options: { autoReconnect: false } });
  const errors = [];
  connection.onError((error) => errors.push(error));
  socket.onclose?.({ code: 1006 });
  assert.equal(connection.status().state, CONNECTION_STATE.failed);
  assert.ok(errors.length >= 1, "giving up is reported");
  connection.stop();

  const limited = await connected({ reply: { code: 0, data: { URL: "wss://x/y", ClientConfig: { ReconnectCount: 1, ReconnectInterval: 1 } } } });
  limited.socket.onclose?.({ code: 1006 });
  limited.timers.fire(1000);
  const second = limited.socketRef.current;
  second.onclose?.({ code: 1006 });
  assert.equal(limited.connection.status().state, CONNECTION_STATE.failed, "the second failure exhausts ReconnectCount=1");
  limited.connection.stop();
});

await test("a socket that fails before opening rejects start", async () => {
  const timers = fakeTimers();
  const connection = new FeishuLongConnection({
    appId: "a",
    appSecret: "s",
    fetchImpl: fakeFetch(),
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url);
      queueMicrotask(() => {
        socket.readyState = 3;
        socket.onclose?.({ code: 1006 });
      });
      return socket;
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    autoReconnect: false,
  });
  await assert.rejects(() => connection.start(), /closed before it opened/);
  connection.stop();
});

await test("a factory that throws is reported, and start rejects", async () => {
  const connection = new FeishuLongConnection({
    appId: "a",
    appSecret: "s",
    fetchImpl: fakeFetch(),
    webSocketFactory: () => {
      throw new Error("no websocket here");
    },
  });
  const errors = [];
  connection.onError((error) => errors.push(error));
  await assert.rejects(() => connection.start(), /no websocket here/);
  assert.equal(errors.length, 1);
  connection.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
