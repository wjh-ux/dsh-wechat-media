/**
 * dsh-wechat-media - QQ bot (QQ 开放平台 / QQ Bot API v2) over the official WebSocket gateway.
 *
 * Why the official bot and not a personal-account hook: the QQ client protocol has no supported way to receive
 * messages, and the unofficial shims (NapCat, Lagrange, OneBot) are a second piece of software to install and keep
 * alive. The open platform gives a documented bot API with an outbound-only WebSocket, so it works from a plugin on
 * someone's own machine with no public URL - the same property the WeCom and Feishu long connections have.
 *
 * The protocol, as published by the open platform:
 *
 *   token    POST https://bots.qq.com/app/getAppAccessToken   { appId, clientSecret } -> { access_token, expires_in }
 *   gateway  GET  https://api.sgroup.qq.com/gateway           Authorization: QQBot <token> -> { url }
 *   connect  wss://api.sgroup.qq.com/websocket
 *   hello    { op: 10, d: { heartbeat_interval } }
 *   identify { op: 2, d: { token: "QQBot <token>", intents, shard: [0, 1], properties: {} } }
 *   resume   { op: 6, d: { token, session_id, seq } }
 *   ready    { op: 0, t: "READY", s, d: { session_id, user } }
 *   heartbeat{ op: 1, d: lastSeq }                             (heartbeat_interval, ack is op 11)
 *   inbound  { op: 0, t: "C2C_MESSAGE_CREATE" | "GROUP_AT_MESSAGE_CREATE", d: { id, content, author, group_openid? } }
 *   reply    POST /v2/users/{openid}/messages | /v2/groups/{group_openid}/messages
 *            { content, msg_type: 0, msg_id, msg_seq }  Authorization: QQBot <token>
 *
 * The reply must carry the inbound message's `id` as `msg_id`: the open platform treats an unmatched message as a
 * proactive one, which is a different permission and usually a rejection. That is why `sendMessage` takes it.
 *
 * Dependency-free: the WebSocket framing comes from ./ws-client.js, and `fetch` is the platform's own.
 */
import { MiniWebSocket } from "./ws-client.js";

export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_API_BASE = "https://api.sgroup.qq.com";
export const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";

/**
 * Intents: the open platform gates event families behind bit flags. Group and C2C messages share `1 << 25`
 * (33554432); the guild families are the low bits. A bot that only answers private and group chats needs the one flag,
 * and asking for more than the bot was granted is what makes an identify fail with 4014.
 */
export const QQ_INTENT_GROUP_C2C = 1 << 25;
export const QQ_INTENTS_DEFAULT = QQ_INTENT_GROUP_C2C;

/** Which API host a bot talks to. Sandbox bots use the sandbox host and their own credentials. */
export function qqApiBase({ sandbox = false } = {}) {
  return sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;
}

/**
 * The app access token. Cached until shortly before it expires: the endpoint is rate-limited and a bot that asks per
 * message will be throttled.
 */
export class QQTokenCache {
  constructor({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.token = "";
    this.expiresAt = 0;
    this.appId = "";
  }

  /** `{ appId, clientSecret }` -> `{ token, expiresAt }`, or throws with the platform's own error text. */
  async get({ appId, clientSecret, force = false } = {}) {
    const id = String(appId ?? "").trim();
    const secret = String(clientSecret ?? "").trim();
    if (!id || !secret) throw new Error("QQ 机器人需要 appId 和 clientSecret（QQ 开放平台 → 开发设置）");
    if (!force && this.token && this.appId === id && this.now() < this.expiresAt - 60_000) {
      return { token: this.token, expiresAt: this.expiresAt, cached: true };
    }
    const response = await this.fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: id, clientSecret: secret }),
    });
    const text = await response.text();
    let answer = {};
    try {
      answer = text ? JSON.parse(text) : {};
    } catch {
      answer = { error: text };
    }
    if (!response.ok || !answer?.access_token) {
      throw new Error(`QQ 取 token 失败（${response.status}）：${answer?.message ?? answer?.error ?? text.slice(0, 200)}`);
    }
    this.token = String(answer.access_token);
    this.appId = id;
    this.expiresAt = this.now() + (Number(answer.expires_in) || 7200) * 1000;
    return { token: this.token, expiresAt: this.expiresAt, cached: false };
  }
}

/** The identify payload. Exported so the shape can be asserted without a socket. */
export function buildIdentify({ token, intents = QQ_INTENTS_DEFAULT, shard = [0, 1] } = {}) {
  if (!token) throw new Error("identify 需要 access token");
  return {
    op: 2,
    d: {
      token: /^QQBot\s+/i.test(token) ? token : `QQBot ${token}`,
      intents,
      shard,
      properties: { $os: "Windows", $browser: "dsh-wechat-media", $device: "dsh-wechat-media" },
    },
  };
}

/** The reply body. `msg_id` is mandatory for a passive reply; `msg_seq` disambiguates several replies to one message. */
export function buildReplyBody({ content, msgId = "", seq = 1 } = {}) {
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("回复内容是空的");
  const body = { content: text, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  if (msgId && seq) body.msg_seq = seq;
  return body;
}

/** Which endpoint answers this event: a C2C chat, a group, or neither. */
export function destinationFor(event = {}) {
  const type = String(event?.t ?? event?.type ?? "");
  const data = event?.d ?? event ?? {};
  if (type === "C2C_MESSAGE_CREATE" || data.author?.user_openid) {
    const openid = data.author?.user_openid ?? data.user_openid ?? "";
    return openid ? { kind: "c2c", path: `/v2/users/${openid}/messages`, target: openid } : null;
  }
  if (type === "GROUP_AT_MESSAGE_CREATE" || data.group_openid) {
    const openid = data.group_openid ?? "";
    return openid ? { kind: "group", path: `/v2/groups/${openid}/messages`, target: openid } : null;
  }
  return null;
}

/** One inbound message, flattened to what the bridge needs. */
export function parseQQEvent(event = {}) {
  const type = String(event?.t ?? "");
  const data = event?.d ?? {};
  if (!/MESSAGE_CREATE$/.test(type) && !data.content) return null;
  const destination = destinationFor(event);
  if (!destination) return null;
  const author = data.author ?? {};
  return {
    eventType: type,
    messageId: String(data.id ?? ""),
    content: String(data.content ?? "").trim(),
    chatId: destination.target,
    chatType: destination.kind,
    peerName: String(author.username ?? author.nickname ?? author.user_openid ?? author.member_openid ?? destination.target),
    timestamp: Number(data.timestamp) || Date.now(),
    raw: event,
  };
}

/** POST one reply, with the platform's error text when it refuses. */
export async function sendQQMessage({
  token,
  destination,
  content,
  msgId = "",
  seq = 1,
  sandbox = false,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  if (!token) throw new Error("发送需要 access token");
  if (!destination?.path) throw new Error("不知道发给谁：C2C 需要 author.user_openid，群聊需要 group_openid");
  const body = buildReplyBody({ content, msgId, seq });
  const response = await fetchImpl(`${qqApiBase({ sandbox })}${destination.path}`, {
    method: "POST",
    headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let answer = {};
  try {
    answer = text ? JSON.parse(text) : {};
  } catch {
    answer = { error: text };
  }
  if (!response.ok) {
    throw new Error(`QQ 发送失败（${response.status}）：${answer?.message ?? answer?.error ?? text.slice(0, 200)}`);
  }
  return { ok: true, id: String(answer.id ?? ""), timestamp: answer.timestamp ?? "" };
}

/**
 * The long connection: one socket, heartbeats, and a callback per inbound message.
 *
 * Every failure is surfaced through `onStatus` rather than thrown into the void: a QQ bot's usual problems are a wrong
 * secret, an intent the bot was not granted, or a network that drops idle sockets - and each of those needs to be
 * visible in the panel, not silent.
 */
export class QQLongConnection {
  constructor({
    appId = "",
    clientSecret = "",
    intents = QQ_INTENTS_DEFAULT,
    sandbox = false,
    fetchImpl = (...args) => fetch(...args),
    webSocketFactory = (url) => new MiniWebSocket(url),
    tokens = null,
    heartbeatGraceMs = 5_000,
  } = {}) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.intents = intents;
    this.sandbox = sandbox;
    this.fetch = fetchImpl;
    this.webSocketFactory = webSocketFactory;
    this.tokens = tokens ?? new QQTokenCache({ fetchImpl });
    this.heartbeatGraceMs = heartbeatGraceMs;
    this.socket = null;
    this.token = "";
    this.sessionId = "";
    this.lastSeq = 0;
    this.heartbeatTimer = null;
    this.closed = false;
    this.onMessage = () => {};
    this.onStatus = () => {};
  }

  /** Fetch the gateway URL. Exported behaviour so a wrong credential fails here, with the platform's words. */
  async gatewayUrl() {
    const response = await this.fetch(`${qqApiBase({ sandbox: this.sandbox })}/gateway`, {
      headers: { authorization: `QQBot ${this.token}` },
    });
    const text = await response.text();
    let answer = {};
    try {
      answer = text ? JSON.parse(text) : {};
    } catch {
      answer = {};
    }
    if (!response.ok || !answer?.url) {
      throw new Error(`QQ 取网关地址失败（${response.status}）：${answer?.message ?? text.slice(0, 200)}`);
    }
    return String(answer.url);
  }

  async connect() {
    this.closed = false;
    const { token } = await this.tokens.get({ appId: this.appId, clientSecret: this.clientSecret, force: true });
    this.token = token;
    const url = await this.gatewayUrl();
    const socket = this.webSocketFactory(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.#handle(event?.data ?? ""));
    socket.addEventListener("close", () => {
      this.#stopHeartbeat();
      if (!this.closed) this.onStatus({ state: "closed", reason: "socket closed" });
    });
    socket.addEventListener("error", (error) => this.onStatus({ state: "error", reason: String(error?.message ?? error) }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("QQ 网关握手超时（15s）")), 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`QQ 网关连接失败：${String(error?.message ?? error)}`));
      });
    });
    return true;
  }

  #handle(raw) {
    let event;
    try {
      event = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }
    if (event?.s) this.lastSeq = event.s;
    switch (event?.op) {
      case 10: {
        // hello: start heartbeating, then identify.
        const interval = Number(event?.d?.heartbeat_interval) || 30_000;
        this.#startHeartbeat(interval);
        this.socket?.send?.(JSON.stringify(buildIdentify({ token: this.token, intents: this.intents })));
        return;
      }
      case 11:
        return; // heartbeat acknowledged
      case 7: {
        this.onStatus({ state: "reconnect", reason: "the gateway asked to reconnect" });
        return;
      }
      case 9: {
        this.onStatus({ state: "invalid-session", reason: "the gateway invalidated the session (a full identify follows)" });
        this.socket?.send?.(JSON.stringify(buildIdentify({ token: this.token, intents: this.intents })));
        return;
      }
      case 0: {
        if (event.t === "READY") {
          this.sessionId = String(event?.d?.session_id ?? "");
          this.onStatus({ state: "ready", sessionId: this.sessionId, user: event?.d?.user?.username ?? "" });
          return;
        }
        const message = parseQQEvent(event);
        if (message) this.onMessage(message, event);
        return;
      }
      default:
        return;
    }
  }

  #startHeartbeat(interval) {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.socket?.send?.(JSON.stringify({ op: 1, d: this.lastSeq || null }));
    }, Math.max(5_000, interval));
    if (typeof this.heartbeatTimer?.unref === "function") this.heartbeatTimer.unref();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async close() {
    this.closed = true;
    this.#stopHeartbeat();
    try {
      this.socket?.close?.();
    } catch {
      /* a socket that is already gone is fine */
    }
    this.socket = null;
  }
}
