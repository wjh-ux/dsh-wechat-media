/**
 * Drive the Feishu **inbound** path for real.
 *
 * Nothing here inspects source text. The plugin is booted with a fake Cordis scope, its long
 * connection is given a fake WebSocket, and events are pushed in as the **encoded protobuf frames**
 * Feishu would send - so frame decoding, fragment merging, the event-to-prompt mapping, the
 * one-decision rule, the turn, and the reply all run as they do in production. `fetch` is stubbed, so
 * every HTTP call is asserted rather than performed and no credential is real.
 *
 * `/state` is read back through the **actual registered route**, which is how the counters and the
 * connection status are checked rather than guessed at.
 *
 * Run: node test/feishu-inbound.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, classifyFeishuInbound, feishuEventParts, sessionIdFor } from "../index.js";
import { FRAME_TYPE, HEADER_KEY, MESSAGE_TYPE, encodeFrame } from "../feishu-ws.js";
import { WechatState, normalizeAccountId } from "../state.js";

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

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------------------------------------
// A fake socket: records what was sent, and lets the test push frames in.
// -----------------------------------------------------------------------------------------------------------

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  /** Deliver one event as the encoded frame Feishu sends, including the fragment headers. */
  deliver(event, { messageId = "om_evt", seq = 0, sum = 1 } = {}) {
    const frame = encodeFrame({
      SeqID: 1,
      LogID: 0,
      service: 1,
      method: FRAME_TYPE.data,
      headers: [
        { key: HEADER_KEY.type, value: MESSAGE_TYPE.event },
        { key: HEADER_KEY.messageId, value: messageId },
        { key: HEADER_KEY.sum, value: String(sum) },
        { key: HEADER_KEY.seq, value: String(seq) },
        { key: HEADER_KEY.traceId, value: "tr_1" },
      ],
      payload: Buffer.from(JSON.stringify(event), "utf8"),
    });
    return this.onmessage?.({ data: frame });
  }
}
FakeSocket.instances = [];

/** Replace global fetch for one boot, recording every call and answering from `respond`. */
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const entry = { url: String(url), options, body: options.body };
    calls.push(entry);
    const answer = respond(entry) ?? {};
    // A binary answer (a Buffer) is what a resource download looks like: no JSON body, a content type that is
    // not application/json, and arrayBuffer(). Everything else stays JSON, so the failure path is unchanged.
    if (Buffer.isBuffer(answer) || answer instanceof Uint8Array) {
      const bytes = Buffer.from(answer);
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/jpeg" : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        json: async () => ({}),
        text: async () => bytes.toString("latin1"),
      };
    }
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Wait until `check()` is true, or give up after `timeoutMs`. A fixed sleep is a race: this flow makes network
 *  calls (token, then the resource), so the time it takes is not a constant. */
async function waitFor(check, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** `rm` can race a still-closing handle and throw ENOTEMPTY; retry briefly rather than failing the suite. */
async function removeTree(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 5 || !/ENOTEMPTY|EBUSY|EPERM/.test(String(error?.code ?? error?.message ?? ""))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
/** The reactions the plugin makes to an established long connection, collected per boot. */
function fakeSocketFactory() {
  const original = globalThis.WebSocket;
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket;
  return { restore: () => { globalThis.WebSocket = original; } };
}

/** One `im.message.receive_v1` event, with only the fields under test varied. */
function messageEvent({
  chatId = "oc_drive",
  chatType = "p2p",
  messageId = "om_evt",
  messageType = "text",
  content = { text: "你好，帮我看看这个" },
  senderType = "user",
  openId = "ou_drive",
  mentions = undefined,
} = {}) {
  return {
    schema: "2.0",
    header: { event_type: "im.message.receive_v1", token: "vt", create_time: "1700000000000" },
    event: {
      sender: { sender_type: senderType, sender_id: { open_id: openId }, tenant_key: "tk" },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: chatType,
        message_type: messageType,
        content: JSON.stringify(content),
        create_time: "1700000000000",
        ...(mentions ? { mentions } : {}),
      },
    },
  };
}

const HANDSHAKE_OK = {
  code: 0,
  data: { URL: "wss://fake.feishu/connect", ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 } },
};

/** Boot the plugin and hand back everything the test needs to drive and observe it. */
async function boot({ feishu = { appId: "cli_drive", appSecret: "secret-drive", to: "oc_drive" }, prefs = {}, handshake = HANDSHAKE_OK, answer = "这是模型给出的回答。", resources = "json", } = {}) {
  const root = await mkdtemp(join(tmpdir(), "feishu-inbound-"));
  const handlers = new Map();
  const effects = [];
  const tools = new Map();
  const routes = [];
  const queued = [];
  const logs = [];
  const state = new WechatState({ root });
  if (Object.keys(prefs).length) await state.savePrefs(prefs);

  const accountId = normalizeAccountId(`feishu:${String(feishu.appId ?? "")}`);
  const chatId = "oc_drive";
  const sessionId = sessionIdFor(accountId, chatId, 0);
  /** Set by the test to change what the "model" answers. */
  const box = { answer };

  const agent = {
    session: { id: sessionId },
    async followup(message) {
      queued.push(message);
      // The harness's own path: claim the message, stream the text, end the turn.
      for (const handler of handlers.get("agent/inbox/claimed") ?? []) handler({ agent, message, turn: 1 });
      for (const handler of handlers.get("session/event") ?? []) {
        const session = { id: sessionId, header: { id: sessionId } };
        handler(session, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: box.answer }] } } });
        handler(session, { type: "turn/end", data: { turn: 1, reason: { kind: "end_turn" } } });
      }
    },
  };
  const agents = new Map([[sessionId, agent]]);

  const collect = (fn) => {
    const disposer = fn();
    if (typeof disposer === "function") effects.push(disposer);
  };
  const ctx = {
    logger: {
      info: (...args) => logs.push(["info", String(args[0])]),
      warn: (...args) => logs.push(["warn", String(args[0])]),
      error: (...args) => logs.push(["error", String(args[0])]),
      debug: () => {},
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    effect: collect,
    get: () => undefined,
    agents: { get: (id) => agents.get(id) },
    inject: (capabilities, callback) => {
      if (capabilities.includes("tools")) {
        callback({ tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } }, effect: collect });
      }
      if (capabilities.includes("webServer")) {
        callback({ webServer: { register: (route) => { routes.push(route); return () => {}; } }, effect: collect });
      }
    },
  };

  const fetchStub = stubFetch((entry) => {
    if (entry.url.includes("/callback/ws/endpoint")) return handshake;
    if (entry.url.includes("/auth/v3/tenant_access_token/internal")) return { code: 0, tenant_access_token: "t-drive", expire: 7200 };
    if (resources === "bytes" && entry.url.includes("/resources/")) return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    if (entry.url.includes("/im/v1/messages")) return { code: 0, data: { message_id: "om_sent_1", chat_id: chatId } };
    return { code: 0, data: {} };
  });
  const socketStub = fakeSocketFactory();

  try {
    apply(ctx, { dshHome: root, stateDir: root, feishu });
    await settle();
  } catch (error) {
    socketStub.restore();
    fetchStub.restore();
    throw error;
  }

  return {
    root,
    ctx,
    state,
    accountId,
    chatId,
    sessionId,
    queued,
    logs,
    handlers,
    effects,
    tools,
    routes,
    agent,
    box,
    fetchCalls: fetchStub.calls,
    socket: () => FakeSocket.instances.at(-1),
    /** Read /state through the route the plugin actually registered. */
    async readState() {
      const route = routes.find((candidate) => candidate.path === "/dsh-wechat-media/state");
      if (!route) throw new Error("the /state route was not registered");
      let body = "";
      const res = { status: 0, writeHead(status) { this.status = status; }, end(chunk) { body += String(chunk ?? ""); } };
      await route.handler({ socket: { remoteAddress: "127.0.0.1" }, method: "GET", url: "/dsh-wechat-media/state" }, res);
      return JSON.parse(body);
    },
    /** Call the /prefs route the way the Web UI panel does, and read the raw body back. */
    async callPrefs(query) {
      const route = routes.find((candidate) => candidate.path === "/dsh-wechat-media/prefs");
      if (!route) throw new Error("the /prefs route was not registered");
      let body = "";
      const res = { status: 0, writeHead(status) { this.status = status; }, end(chunk) { body += String(chunk ?? ""); } };
      await route.handler({ socket: { remoteAddress: "127.0.0.1" }, method: "GET", url: `/dsh-wechat-media/prefs?${query}` }, res);
      return { status: res.status, body, json: body ? JSON.parse(body) : {} };
    },
    async close() {
      for (const dispose of effects) {
        try {
          dispose();
        } catch {
          /* a disposer that throws must not hide the others */
        }
      }
      socketStub.restore();
      fetchStub.restore();
      await removeTree(root);
    },
  };
}

// -----------------------------------------------------------------------------------------------------------
// Pure helpers, checked directly.
// -----------------------------------------------------------------------------------------------------------

await test("an event is read into the parts the plugin needs", () => {
  const parts = feishuEventParts(messageEvent());
  assert.equal(parts.chatId, "oc_drive");
  assert.equal(parts.isGroup, false);
  assert.equal(parts.messageId, "om_evt");
  assert.equal(parts.messageType, "text");
  assert.equal(parts.senderType, "user");
  assert.equal(parts.senderOpenId, "ou_drive");
  assert.equal(parts.text, "你好，帮我看看这个");
  assert.deepEqual(parts.attachments, []);
  assert.equal(parts.unsupported, "");
});

await test("mentions are replaced by the speaker's name, as the SDK does", () => {
  const parts = feishuEventParts(messageEvent({
    content: { text: "@_user_1 请看看" },
    mentions: [{ key: "@_user_1", name: "张三", id: { open_id: "ou_1" } }],
  }));
  assert.equal(parts.text, "@张三 请看看");
  assert.deepEqual(parts.mentionNames, ["张三"]);
});

await test("every message type the SDK converts is read, and an unknown one is named", () => {
  const rich = feishuEventParts(messageEvent({
    messageType: "post",
    content: { zh_cn: { title: "标题", content: [[{ tag: "text", text: "正文" }, { tag: "a", text: "链接", href: "https://x" }], [{ tag: "img", image_key: "img_1" }]] } },
  }));
  assert.match(rich.text, /标题/);
  assert.match(rich.text, /正文/);
  assert.match(rich.text, /链接 \(https:\/\/x\)/);
  assert.deepEqual(rich.attachments, [{ type: "image", key: "img_1" }]);

  const image = feishuEventParts(messageEvent({ messageType: "image", content: { image_key: "img_2" } }));
  assert.equal(image.text, "[图片]");
  assert.deepEqual(image.attachments, [{ type: "image", key: "img_2" }]);

  const file = feishuEventParts(messageEvent({ messageType: "file", content: { file_key: "file_1", file_name: "报告.pdf" } }));
  assert.match(file.text, /报告\.pdf/);
  assert.deepEqual(file.attachments, [{ type: "file", key: "file_1", name: "报告.pdf" }]);

  const audio = feishuEventParts(messageEvent({ messageType: "audio", content: { file_key: "file_2", duration: 3200 } }));
  assert.equal(audio.text, "[语音]");
  assert.equal(audio.attachments[0].type, "audio");
  assert.equal(audio.attachments[0].durationMs, 3200);

  const video = feishuEventParts(messageEvent({ messageType: "media", content: { file_key: "file_3", file_name: "a.mp4", duration: 5000, image_key: "img_3" } }));
  assert.match(video.text, /a\.mp4/);
  assert.equal(video.attachments[0].type, "video");
  assert.equal(video.attachments[0].coverKey, "img_3");

  const unknown = feishuEventParts(messageEvent({ messageType: "hongbao", content: { text: "恭喜发财" } }));
  assert.equal(unknown.unsupported, "hongbao", "an unconverted type must be named, not silently dropped");
});

await test("the decision rule keeps the same order as the other transports", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-classify-"));
  try {
    const state = new WechatState({ root });
    const accountId = "feishu-acct";
    const message = { chatId: "oc_1", isGroup: false };

    let verdict = await classifyFeishuInbound({ accountId, message, text: "hi", state });
    assert.equal(verdict.action, "forward");
    assert.equal(verdict.reason, "ok");

    await state.savePrefs({ requireAllowlist: true });
    verdict = await classifyFeishuInbound({ accountId, message, text: "hi", state });
    assert.equal(verdict.action, "ignore", "the allowlist comes first");
    assert.equal(verdict.reason, "not-listed");

    await state.setPeer(accountId, "oc_1", { name: "x", kind: "direct", allowed: true });
    let consumed = false;
    verdict = await classifyFeishuInbound({ accountId, message, text: "1", state, consumeApproval: () => { consumed = true; return true; } });
    assert.equal(verdict.action, "answer", "an approval answer must not become a turn");
    assert.equal(consumed, true);

    await state.savePrefs({ requireAllowlist: false, friendOnly: true });
    verdict = await classifyFeishuInbound({ accountId, message: { chatId: "oc_1", isGroup: true }, text: "hi", state });
    assert.equal(verdict.action, "ignore");
    assert.equal(verdict.reason, "group-skipped", "only-friends beats the allowlist, as elsewhere");
  } finally {
    await removeTree(root);
  }
});

// -----------------------------------------------------------------------------------------------------------
// The long connection, driven end to end.
// -----------------------------------------------------------------------------------------------------------

await test("a text message becomes a turn and its answer goes back as a reply", async () => {
  const app = await boot();
  try {
    const socket = app.socket();
    assert.ok(socket, "the long connection opened a socket");
    assert.equal(socket.url, "wss://fake.feishu/connect", "it connected where the handshake said");
    const handshakeCall = app.fetchCalls.find((call) => call.url.includes("/callback/ws/endpoint"));
    assert.ok(handshakeCall, "the handshake was requested");
    assert.match(handshakeCall.url, /\/callback\/ws\/endpoint$/);
    assert.equal(JSON.parse(String(handshakeCall.body)).AppID, "cli_drive");

    socket.deliver(messageEvent({ content: { text: "帮我总结一下" } }));
    await settle();

    assert.equal(app.queued.length, 1, "exactly one turn was queued");
    const prompt = app.queued[0].content[0].text;
    assert.match(prompt, /^\[飞书 /, "the prompt names the transport and the peer");
    assert.match(prompt, /帮我总结一下/, "and carries what was said");

    const reply = app.fetchCalls.find((call) => call.url.includes("/reply"));
    assert.ok(reply, "the answer was sent as a reply to the question");
    assert.match(reply.url, /\/open-apis\/im\/v1\/messages\/om_evt\/reply$/);
    assert.equal(JSON.parse(String(reply.body)).content, JSON.stringify({ text: "这是模型给出的回答。" }));
    assert.equal(reply.options.headers.authorization, "Bearer t-drive");

    const state = await app.readState();
    assert.equal(state.feishu.counters.events, 1);
    assert.equal(state.feishu.counters.answered, 1);
    assert.equal(state.counters.forwarded, 1);
    assert.equal(state.feishu.connection.state, "connected");
    assert.equal(state.feishu.appId, "cli_drive");
    assert.equal(state.feishu.secretSet, true, "the secret is reported as set");
    assert.doesNotMatch(JSON.stringify(state), /secret-drive/, "and never echoed");
    assert.equal(state.feishu.longConnectionWanted, true);
  } finally {
    await app.close();
  }
});

await test("a message the bot sent itself is ignored, so it cannot answer itself", async () => {
  const app = await boot();
  try {
    app.socket().deliver(messageEvent({ senderType: "app", senderId: { open_id: "ou_bot" }, content: { text: "我是机器人自己" } }));
    await settle();
    assert.equal(app.queued.length, 0, "no turn for the bot's own message");
    assert.equal(app.fetchCalls.filter((call) => call.url.includes("/reply")).length, 0, "and nothing is sent back");
    const state = await app.readState();
    assert.equal(state.feishu.counters.events, 1, "it is still counted as an event");
    assert.equal(state.feishu.counters.ignored, 1, "and counted as ignored, not silently dropped");
  } finally {
    await app.close();
  }
});

await test("the same message delivered twice becomes one turn", async () => {
  const app = await boot();
  try {
    app.socket().deliver(messageEvent({ messageId: "om_dup" }));
    await settle();
    app.socket().deliver(messageEvent({ messageId: "om_dup" }));
    await settle();
    assert.equal(app.queued.length, 1, "a redelivered event must not be answered twice");
  } finally {
    await app.close();
  }
});

await test("a group is skipped when only friends are answered, as on the other transports", async () => {
  const app = await boot({ prefs: { friendOnly: true } });
  try {
    app.socket().deliver(messageEvent({ chatId: "oc_group", chatType: "group" }));
    await settle();
    assert.equal(app.queued.length, 0, "a group message is not forwarded");
    const state = await app.readState();
    assert.equal(state.counters.groupsSkipped, 1, "and the skip is counted where /status can show it");
    assert.equal(state.counters.blocked, 1);
  } finally {
    await app.close();
  }
});

await test("an attachment that cannot be fetched is still described", async () => {
  const app = await boot();
  try {
    app.socket().deliver(messageEvent({ messageType: "image", content: { image_key: "img_v2_drive" } }));
    await settle();
    // This path fetches a token and then the resource, so how long it takes is not a constant. Wait for the
    // condition instead of sleeping a fixed amount - otherwise the test fails at random (it did, about 1 in 3).
    const produced = await waitFor(() => app.queued.length > 0);
    assert.ok(produced, "the attachment event produced something to answer");
    assert.equal(app.queued.length, 1);
    const prompt = app.queued[0].content[0].text;
    // Attachments are fetched now. This harness answers a resource request with JSON, so the download cannot
    // succeed here - and that is the behaviour worth pinning: the attachment is still described, and the
    // failure is stated. The success path is covered by feishu.test.mjs (whose stub returns real bytes) and
    // by the live run against the real API.
    assert.match(prompt, /img_v2_drive/, "the model is told what arrived");
    assert.match(prompt, /飞书图片/, "including what kind of attachment it is");
    assert.ok(/未保存|未能下载/.test(prompt), "and that it could not be fetched, rather than being left to guess");
  } finally {
    await app.close();
  }
});

await test("a message type that was not converted is reported, not swallowed", async () => {
  const app = await boot();
  try {
    app.socket().deliver(messageEvent({ messageType: "hongbao", content: { text: "恭喜发财" } }));
    await settle();
    assert.equal(app.queued.length, 1, "an unreadable type still produces something to answer");
    assert.match(app.queued[0].content[0].text, /暂不支持/, "and says so in the prompt");
  } finally {
    await app.close();
  }
});

await test("a failed handshake is reported and does not take the plugin down", async () => {
  const app = await boot({ handshake: { code: 99991663, msg: "app not found" } });
  try {
    const state = await app.readState();
    assert.equal(state.feishu.connection.state, "failed", "the failure is visible in /state");
    assert.match(state.feishu.connection.lastError, /99991663|app not found/, "with the platform's own reason");
    assert.equal(state.feishu.longConnection, false, "and it does not claim to be connected");
    assert.ok(state.prefs, "the rest of the plugin is alive and serving /state");

    // The bridge must still work: a socket can arrive later (the handshake is retried by hand).
    assert.equal(app.socket(), undefined, "no socket was opened");
  } finally {
    await app.close();
  }
});

await test("a turn that fails is reported to the chat instead of leaving it waiting", async () => {
  const app = await boot();
  try {
    const agent = app.agent;
    agent.followup = async (message) => {
      app.queued.push(message);
      for (const handler of app.handlers.get("agent/inbox/claimed") ?? []) handler({ agent, message, turn: 1 });
      // A failed turn reaches the collector as an agent/error event carrying the error itself; a
      // turn/end only carries a reason, so the collector would settle with no error at all.
      for (const handler of app.handlers.get("agent/error") ?? []) {
        handler({ agent, turn: 1, error: new Error("DeepSeek Messages transport failed") });
      }
    };
    app.socket().deliver(messageEvent({ messageId: "om_fail" }));
    await settle(120);
    const replies = app.fetchCalls.filter((call) => call.url.includes("/im/v1/messages"));
    assert.ok(replies.length >= 1, "the chat is told something");
    const texts = replies.map((call) => JSON.parse(String(call.body)).content).join("\n");
    assert.match(texts, /出错|失败/, "the failure is named");
    const state = await app.readState();
    assert.equal(state.feishu.counters.errors >= 1, true, "and counted");
  } finally {
    await app.close();
  }
});

await test("disposing the plugin closes the long connection", async () => {
  const app = await boot();
  const socket = app.socket();
  try {
    assert.equal(socket.closed, false);
    for (const dispose of app.effects) {
      try {
        dispose();
      } catch {
        /* the other disposers still have to run */
      }
    }
    await settle();
    assert.equal(socket.closed, true, "stop() reached the socket");
  } finally {
    await app.close();
  }
});

await test("Feishu is configured from the panel and works without a restart", async () => {
  // v0.23.0 exists because the only ways in were the config file and environment variables - a `setx`
  // plus a DSH restart just to try a bot. This drives the route the panel writes to.
  const app = await boot({ feishu: {}, prefs: {} });
  try {
    assert.equal((await app.readState()).feishu.configured, false, "nothing is configured to begin with");

    const saved = await app.callPrefs("feishuAppId=cli_panel&feishuAppSecret=panel-secret&feishuTo=oc_panel");
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    // The secret goes in and never comes back - not in the response, not in /state.
    assert.doesNotMatch(saved.body, /panel-secret/, "the saved secret must not be echoed");
    assert.equal(saved.json.feishu.secretSet, true);
    assert.equal(saved.json.feishu.configured, true);
    assert.deepEqual([...saved.json.feishu.savedFields].sort(), ["appId", "appSecret", "to"]);
    assert.deepEqual([...saved.json.feishuChanged].sort(), ["feishuAppId", "feishuAppSecret", "feishuTo"]);

    const after = await app.readState();
    assert.equal(after.feishu.app, true, "the app channel is now usable");
    assert.equal(after.feishu.appId, "cli_panel");
    assert.equal(after.feishu.sources.appSecret, "saved", "and the panel is where it came from");
    assert.doesNotMatch(JSON.stringify(after), /panel-secret/);
    // Saving reconnects: the fake socket accepts the handshake, so it must actually be connected.
    assert.equal(after.feishu.connection.state, "connected", "saving restarts the long connection");

    // Clearing is deliberate (an empty value), and it must drop the connection rather than leave it
    // running against credentials the user just removed.
    const cleared = await app.callPrefs("feishuAppSecret=");
    assert.equal(cleared.json.feishu.secretSet, false);
    assert.equal((await app.readState()).feishu.configured, false);

    // A domain that is neither feishu, lark nor a URL is refused instead of stored.
    const refused = await app.callPrefs("feishuDomain=nonsense");
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /feishuDomain must be/);
  } finally {
    await app.close();
  }
});

await test("a blank field never clears a saved secret", async () => {
  // The panel's Save button sends only what was typed, and the route treats an empty *string* as a
  // clear - so the two must not be confused. This pins the rule the UI depends on.
  const app = await boot({ feishu: {}, prefs: {} });
  try {
    await app.callPrefs("feishuAppSecret=first-secret");
    assert.equal((await app.readState()).feishu.secretSet, true);
    // Saving something else entirely leaves the secret alone.
    await app.callPrefs("feishuTo=oc_other");
    const state = await app.readState();
    assert.equal(state.feishu.secretSet, true, "an unrelated save must not drop the secret");
    assert.deepEqual([...state.feishu.savedFields].sort(), ["appSecret", "to"]);
  } finally {
    await app.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
