/**
 * dsh-wechat-media - the Feishu (Lark) **long connection** client.
 *
 * Feishu pushes events either to a public HTTP URL or over a WebSocket the client opens itself. The second one is
 * what this module implements, and it exists for one reason: **the plugin should not need a public address or a
 * tunnel** to receive messages.
 *
 * The official `@larksuiteoapi/node-sdk` is not vendored - it is 28.9 MB with `protobufjs`, `ws`, `axios` and lodash,
 * and this plugin ships as a directory with no `npm install`. So the protocol is re-implemented here, with **every
 * fact read from that SDK's source** rather than recalled. Line numbers below refer to
 * `@larksuiteoapi/node-sdk@1.75.0/lib/index.js` (MIT, downloaded and verified against its registry hash):
 *
 * | Fact | Where |
 * |---|---|
 * | Handshake URL `POST {domain}/callback/ws/endpoint` | `wsConfigUrl` getter, ~L5669868 |
 * | Handshake response `{code, data: {URL, ClientConfig}, msg}`, timeout 15000 | ~L5684710 |
 * | `ClientConfig` → WS config, **seconds × 1000**, keys capitalised | ~L5685817 |
 * | Default `pingInterval: 120000`, `reconnectCount: -1`, `reconnectInterval: 120000`, `reconnectNonce: 30000` | ~L5669170 |
 * | `Frame`/`Header` protobuf descriptor (field numbers) | `Frame.encode`/`decode` ~L5652530+ |
 * | `HeaderKey` / `MessageType` / `FrameType` enums | ~L5674410 and ~L5674588 |
 * | Fragment merge semantics (and the malformed-metadata guard, issue #201) | `DataCache.mergeData`, ~L5670255 |
 * | Ping frame | `pingLoop`, ~L5696598 |
 * | Receive → ack (`{code:200}`, `biz_rt` header, same frame back) | `handleEventData`, ~L5700600+ and `sendMessage` ~L5702100 |
 *
 * Field numbers are quoted from the descriptor, not guessed:
 *
 * ```
 * Header: 1 key (string), 2 value (string)
 * Frame:  1 SeqID (uint64), 2 LogID (uint64), 3 service (int32), 4 method (int32),
 *         5 headers (repeated Header), 6 payloadEncoding (string), 7 payloadType (string),
 *         8 payload (bytes), 9 LogIDNew (string)
 * ```
 */
import { randomUUID } from "node:crypto";

/** Protobuf field numbers, straight from the SDK's descriptor. */
export const FRAME_FIELDS = Object.freeze({
  seqId: 1,
  logId: 2,
  service: 3,
  method: 4,
  headers: 5,
  payloadEncoding: 6,
  payloadType: 7,
  payload: 8,
  logIdNew: 9,
});

/** `pbbp2.Header` field numbers. */
export const HEADER_FIELDS = Object.freeze({ key: 1, value: 2 });

/** The SDK's `FrameType` enum. */
export const FRAME_TYPE = Object.freeze({ control: 0, data: 1 });

/** The SDK's `HeaderKey` enum - the names as they appear on the wire. */
export const HEADER_KEY = Object.freeze({
  type: "type",
  messageId: "message_id",
  sum: "sum",
  seq: "seq",
  traceId: "trace_id",
  bizRt: "biz_rt",
  handshakeStatus: "handshake-status",
  handshakeMsg: "handshake-msg",
  handshakeAuthErrCode: "handshake-autherrcode",
});

/** The SDK's `MessageType` enum. */
export const MESSAGE_TYPE = Object.freeze({ event: "event", card: "card", ping: "ping", pong: "pong" });

/** The SDK's defaults, in milliseconds. */
export const WS_DEFAULTS = Object.freeze({
  pingIntervalMs: 120_000,
  reconnectCount: -1,
  reconnectIntervalMs: 120_000,
  reconnectNonceMs: 30_000,
});

// -----------------------------------------------------------------------------------------------------------
// Minimal protobuf: only what `pbbp2.Header` and `pbbp2.Frame` need (varint + length-delimited).
// -----------------------------------------------------------------------------------------------------------

/** Write a varint. `value` may be a Number or a BigInt (uint64 fields arrive as BigInt when large). */
function writeVarint(bytes, value) {
  let rest = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
  if (rest < 0n) throw new Error("a varint cannot be negative here");
  for (;;) {
    const chunk = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) bytes.push(chunk | 0x80);
    else {
      bytes.push(chunk);
      return;
    }
  }
}

/** Write a length-delimited field: tag, length, then the bytes. */
function writeBytesField(bytes, field, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  writeVarint(bytes, (field << 3) | 2);
  writeVarint(bytes, body.length);
  for (const byte of body) bytes.push(byte);
}

/** Write a varint field: tag, then the value. */
function writeVarintField(bytes, field, value) {
  writeVarint(bytes, field << 3);
  writeVarint(bytes, value);
}

/** Read a varint, returning `{ value, next }`. Large values come back as BigInt. */
function readVarint(buffer, at) {
  let result = 0n;
  let shift = 0n;
  let index = at;
  for (;;) {
    if (index >= buffer.length) throw new Error("truncated varint");
    const byte = buffer[index++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
    if (shift > 70n) throw new Error("varint is longer than 64 bits");
  }
  const value = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
  return { value, next: index };
}

/** Encode one `pbbp2.Header`. */
export function encodeHeader(header) {
  const bytes = [];
  if (header?.key !== undefined) writeBytesField(bytes, HEADER_FIELDS.key, Buffer.from(String(header.key), "utf8"));
  if (header?.value !== undefined) writeBytesField(bytes, HEADER_FIELDS.value, Buffer.from(String(header.value), "utf8"));
  return Buffer.from(bytes);
}

/** Decode one `pbbp2.Header` from `buffer` starting at `at`; returns `{ value, next }`. */
export function decodeHeader(buffer, at) {
  const header = { key: "", value: "" };
  let index = at;
  while (index < buffer.length) {
    const tag = readVarint(buffer, index);
    index = tag.next;
    const field = Number(tag.value) >>> 3;
    const wire = Number(tag.value) & 7;
    if (wire !== 2) {
      if (wire === 0) {
        index = readVarint(buffer, index).next;
        continue;
      }
      throw new Error(`unsupported wire type ${wire} in a Header`);
    }
    const length = readVarint(buffer, index);
    index = length.next;
    const end = index + Number(length.value);
    if (end > buffer.length) throw new Error("truncated Header field");
    const text = buffer.subarray(index, end).toString("utf8");
    index = end;
    if (field === HEADER_FIELDS.key) header.key = text;
    else if (field === HEADER_FIELDS.value) header.value = text;
  }
  return { value: header, next: index };
}

/**
 * Encode a `pbbp2.Frame`.
 *
 * @param {{ SeqID?: number | bigint, LogID?: number | bigint, service?: number, method?: number,
 *           headers?: Array<{ key: string, value: string }>, payloadEncoding?: string, payloadType?: string,
 *           payload?: Buffer | Uint8Array | string, LogIDNew?: string }} frame
 * @returns {Buffer}
 */
export function encodeFrame(frame = {}) {
  const bytes = [];
  if (frame.SeqID !== undefined) writeVarintField(bytes, FRAME_FIELDS.seqId, frame.SeqID);
  if (frame.LogID !== undefined) writeVarintField(bytes, FRAME_FIELDS.logId, frame.LogID);
  if (frame.service !== undefined) writeVarintField(bytes, FRAME_FIELDS.service, frame.service);
  if (frame.method !== undefined) writeVarintField(bytes, FRAME_FIELDS.method, frame.method);
  for (const header of frame.headers ?? []) writeBytesField(bytes, FRAME_FIELDS.headers, encodeHeader(header));
  if (frame.payloadEncoding !== undefined) writeBytesField(bytes, FRAME_FIELDS.payloadEncoding, Buffer.from(String(frame.payloadEncoding), "utf8"));
  if (frame.payloadType !== undefined) writeBytesField(bytes, FRAME_FIELDS.payloadType, Buffer.from(String(frame.payloadType), "utf8"));
  if (frame.payload !== undefined) writeBytesField(bytes, FRAME_FIELDS.payload, frame.payload);
  if (frame.LogIDNew !== undefined) writeBytesField(bytes, FRAME_FIELDS.logIdNew, Buffer.from(String(frame.LogIDNew), "utf8"));
  return Buffer.from(bytes);
}

/**
 * Decode a `pbbp2.Frame`.
 *
 * `SeqID`/`LogID` stay Numbers while they fit in a safe integer and become BigInt beyond that, so a frame can be
 * echoed back byte-for-byte without silently rounding an id.
 *
 * @param {Buffer | Uint8Array} input
 * @returns {{ SeqID: number | bigint, LogID: number | bigint, service: number, method: number,
 *             headers: Array<{ key: string, value: string }>, payloadEncoding?: string, payloadType?: string,
 *             payload?: Buffer, LogIDNew?: string }}
 */
/**
 * The bytes of an inbound WebSocket frame.
 *
 * Node's global `WebSocket` may hand binary frames over as a **Blob**, an ArrayBuffer or a view - and
 * `Buffer.from(blob)` throws ("Received an instance of Blob"), which is exactly how the first real frames were
 * lost in production while every test, feeding Buffers to a fake socket, passed. `decodeFrame` wants bytes, so
 * normalise every shape here.
 *
 * @param {any} raw
 * @returns {Promise<Buffer>}
 */
export async function frameBytes(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw && typeof raw.arrayBuffer === "function") return Buffer.from(await raw.arrayBuffer());
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  return Buffer.from(raw ?? []);
}

export function decodeFrame(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  const frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] };
  let index = 0;
  while (index < buffer.length) {
    const tag = readVarint(buffer, index);
    index = tag.next;
    const field = Number(tag.value) >>> 3;
    const wire = Number(tag.value) & 7;
    if (wire === 0) {
      const read = readVarint(buffer, index);
      index = read.next;
      if (field === FRAME_FIELDS.seqId) frame.SeqID = read.value;
      else if (field === FRAME_FIELDS.logId) frame.LogID = read.value;
      else if (field === FRAME_FIELDS.service) frame.service = Number(read.value);
      else if (field === FRAME_FIELDS.method) frame.method = Number(read.value);
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buffer, index);
      index = length.next;
      const end = index + Number(length.value);
      if (end > buffer.length) throw new Error(`truncated Frame field ${field}`);
      const slice = buffer.subarray(index, end);
      index = end;
      if (field === FRAME_FIELDS.headers) frame.headers.push(decodeHeader(slice, 0).value);
      else if (field === FRAME_FIELDS.payloadEncoding) frame.payloadEncoding = slice.toString("utf8");
      else if (field === FRAME_FIELDS.payloadType) frame.payloadType = slice.toString("utf8");
      else if (field === FRAME_FIELDS.payload) frame.payload = Buffer.from(slice);
      else if (field === FRAME_FIELDS.logIdNew) frame.LogIDNew = slice.toString("utf8");
      continue;
    }
    throw new Error(`unsupported wire type ${wire} in a Frame`);
  }
  return frame;
}

/** Turn a frame's headers into a plain object, exactly as the SDK's `handleEventData` does. */
export function headersToObject(headers = []) {
  const out = {};
  for (const header of headers) out[String(header?.key ?? "")] = String(header?.value ?? "");
  return out;
}

// -----------------------------------------------------------------------------------------------------------
// Fragment merging - the SDK's semantics, including its guard against malformed metadata.
// -----------------------------------------------------------------------------------------------------------

/**
 * Reassembles the fragments of one event.
 *
 * The official implementation rejects a bad `sum`/`seq` **before** allocating (`new Array(sum)` would throw a
 * RangeError, and a `seq` outside the range would leave a hole that JSON.parse then trips over). It also refuses a
 * later fragment that disagrees with the first about `sum`, because its `seq` was only validated against its own.
 * Both are reproduced here, and raised as errors the caller can report rather than swallow.
 */
export class FragmentMerger {
  /** @param {{ ttlMs?: number, now?: () => number }} [options] */
  constructor({ ttlMs = 60_000, now = () => Date.now() } = {}) {
    this.pending = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * @param {{ messageId?: string, sum?: unknown, seq?: unknown, traceId?: string, data?: Buffer }} fragment
   * @returns {any | undefined} the parsed event once every fragment has arrived, otherwise undefined
   */
  merge({ messageId = "", sum = undefined, seq = undefined, traceId = "", data = undefined } = {}) {
    const total = Number(sum);
    const index = Number(seq);
    if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(index) || index < 0 || index >= total) {
      throw new Error(`invalid event fragment metadata (sum: ${String(sum)}, seq: ${String(seq)})`);
    }
    this.#expire();
    const id = String(messageId);
    let entry = this.pending.get(id);
    if (!entry) {
      entry = { buffer: new Array(total).fill(undefined), traceId, at: this.now() };
      this.pending.set(id, entry);
    } else if (entry.buffer.length !== total) {
      throw new Error(`invalid event fragment metadata (sum: ${total} differs from first fragment's ${entry.buffer.length}, seq: ${index})`);
    }
    entry.buffer[index] = Buffer.from(data ?? []);
    if (!entry.buffer.every((item) => item)) return undefined;
    this.pending.delete(id);
    const merged = Buffer.concat(entry.buffer);
    return JSON.parse(merged.toString("utf8"));
  }

  /** Drop fragments that never completed, so a lost piece cannot leak memory forever. */
  #expire() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.pending) if (entry.at < cutoff) this.pending.delete(id);
  }

  get size() {
    return this.pending.size;
  }
}

// -----------------------------------------------------------------------------------------------------------
// Handshake
// -----------------------------------------------------------------------------------------------------------

/**
 * Ask Feishu where to connect, and how.
 *
 * `POST {domain}/callback/ws/endpoint` with `{AppID, AppSecret}` answers `{code, data: {URL, ClientConfig}, msg}`.
 * `ClientConfig` uses capitalised keys and **seconds**; they are converted to the milliseconds the rest of this
 * module speaks.
 *
 * @param {{ appId?: string, appSecret?: string, domain?: string, fetchImpl?: Function, timeoutMs?: number }} input
 * @returns {Promise<{ url: string, pingIntervalMs: number, reconnectCount: number, reconnectIntervalMs: number,
 *           reconnectNonceMs: number, clientConfig: any }>}
 */
export async function postHandshake({
  appId = "",
  appSecret = "",
  domain = "feishu",
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const id = String(appId ?? "").trim();
  const secret = String(appSecret ?? "").trim();
  if (!id || !secret) throw new Error("the Feishu long connection needs app_id and app_secret");
  const base = domainToUrl(domain);
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  let payload;
  try {
    const response = await fetchImpl(`${base}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ AppID: id, AppSecret: secret }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    payload = await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
  const code = Number(payload?.code ?? -1);
  if (code !== 0) {
    throw new Error(`the Feishu handshake was refused: code ${code}${payload?.msg ? ` (${payload.msg})` : ""}`);
  }
  const url = String(payload?.data?.URL ?? "");
  if (!url) throw new Error("the Feishu handshake returned no WebSocket URL");
  const clientConfig = payload?.data?.ClientConfig ?? {};
  const seconds = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number * 1000 : fallback;
  };
  return {
    url,
    pingIntervalMs: seconds(clientConfig.PingInterval, WS_DEFAULTS.pingIntervalMs),
    reconnectCount: Number.isFinite(Number(clientConfig.ReconnectCount)) ? Number(clientConfig.ReconnectCount) : WS_DEFAULTS.reconnectCount,
    reconnectIntervalMs: seconds(clientConfig.ReconnectInterval, WS_DEFAULTS.reconnectIntervalMs),
    reconnectNonceMs: seconds(clientConfig.ReconnectNonce, WS_DEFAULTS.reconnectNonceMs),
    clientConfig,
  };
}

/** `feishu` / `lark` / an explicit URL → a base URL. Shared with `feishu.js` by value, not by import, to keep this module standalone. */
function domainToUrl(domain) {
  const text = String(domain ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(text)) return text;
  return text === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

// -----------------------------------------------------------------------------------------------------------
// The connection
// -----------------------------------------------------------------------------------------------------------

export const CONNECTION_STATE = Object.freeze({
  idle: "idle",
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
  closed: "closed",
  failed: "failed",
});

/**
 * A Feishu event subscription over a WebSocket, with no public address involved.
 *
 * Everything external is injectable - `fetchImpl`, `webSocketFactory`, the timer pair and the clock - so the whole
 * lifecycle (connect, ping, receive, ack, drop, reconnect) can be tested offline against a fake socket.
 *
 * Events are handed to the handler as the parsed JSON Feishu sent. The handler's return value, if any, is sent back
 * as the ack's `data` (base64), which is how this protocol acknowledges an event.
 */
export class FeishuLongConnection {
  /**
   * @param {{ appId?: string, appSecret?: string, domain?: string, fetchImpl?: Function,
   *           webSocketFactory?: (url: string) => any, setTimeoutImpl?: Function, clearTimeoutImpl?: Function,
   *           now?: () => number, logger?: { info?: Function, warn?: Function, error?: Function, debug?: Function },
   *           autoReconnect?: boolean }} [options]
   */
  constructor({
    appId = "",
    appSecret = "",
    domain = "feishu",
    fetchImpl = fetch,
    webSocketFactory = undefined,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = () => Date.now(),
    logger = undefined,
    autoReconnect = true,
  } = {}) {
    this.appId = appId;
    this.#secret = appSecret;
    this.domain = domain;
    this.fetchImpl = fetchImpl;
    this.webSocketFactory = webSocketFactory ?? ((url) => new globalThis.WebSocket(url));
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.logger = logger;
    this.autoReconnect = autoReconnect;

    this.socket = null;
    this.config = { ...WS_DEFAULTS, url: "" };
    this.state = CONNECTION_STATE.idle;
    this.handlers = new Set();
    this.errorHandlers = new Set();
    this.merger = new FragmentMerger({ now });
    this.pingTimer = undefined;
    this.reconnectTimer = undefined;
    this.reconnectAttempts = 0;
    this.stats = { received: 0, events: 0, acks: 0, pings: 0, pongs: 0, ignored: 0, fragments: 0, errors: 0, reconnects: 0 };
    this.lastError = "";
    this.stopped = false;
    this.#secret = String(appSecret ?? "");
  }

  #secret = "";

  /** The current state, without ever including the secret. */
  status() {
    return {
      state: this.state,
      connected: this.state === CONNECTION_STATE.connected,
      url: this.config.url,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      handlers: this.handlers.size,
      stats: { ...this.stats },
    };
  }

  /** Register an event handler. Returns a function that removes it again. */
  onEvent(handler) {
    if (typeof handler !== "function") throw new Error("onEvent needs a function");
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Register an error handler - failures are reported, never swallowed. */
  onError(handler) {
    if (typeof handler !== "function") throw new Error("onError needs a function");
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  #report(error) {
    const message = error?.message ?? String(error);
    this.lastError = message;
    this.stats.errors += 1;
    this.logger?.warn?.("[dsh-wechat-media] feishu ws: %s", message);
    for (const handler of this.errorHandlers) {
      try {
        handler(error instanceof Error ? error : new Error(message));
      } catch {
        /* a broken error handler must not take the connection down */
      }
    }
  }

  /** Connect (and keep the connection alive until `stop`). Resolves once the socket is open. */
  async start() {
    this.stopped = false;
    this.state = CONNECTION_STATE.connecting;
    const handshake = await postHandshake({
      appId: this.appId,
      appSecret: this.#secret,
      domain: this.domain,
      fetchImpl: this.fetchImpl,
    });
    this.config = {
      url: handshake.url,
      pingIntervalMs: handshake.pingIntervalMs,
      reconnectCount: handshake.reconnectCount,
      reconnectIntervalMs: handshake.reconnectIntervalMs,
      reconnectNonceMs: handshake.reconnectNonceMs,
    };
    return this.#open(handshake.url);
  }

  /** Close the connection and stop reconnecting. */
  stop() {
    this.stopped = true;
    this.state = CONNECTION_STATE.closed;
    if (this.pingTimer !== undefined) this.clearTimeoutImpl(this.pingTimer);
    if (this.reconnectTimer !== undefined) this.clearTimeoutImpl(this.reconnectTimer);
    this.pingTimer = undefined;
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close?.();
    } catch (error) {
      this.#report(error);
    }
  }

  /** Open one socket; resolves when it is open, rejects when it cannot be. */
  #open(url) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = this.webSocketFactory(url);
        // Ask for ArrayBuffer rather than Blob: the frame decoder wants bytes, and Blob copies cost.
        try { socket.binaryType = "arraybuffer"; } catch { /* not supported everywhere; frameBytes copes */ }
      } catch (error) {
        this.state = CONNECTION_STATE.failed;
        this.#report(error);
        reject(error);
        return;
      }
      this.socket = socket;
      let settled = false;
      socket.onopen = () => {
        settled = true;
        this.state = CONNECTION_STATE.connected;
        this.reconnectAttempts = 0;
        this.lastError = "";
        this.#armPing();
        this.logger?.info?.("[dsh-wechat-media] feishu ws connected");
        resolve();
      };
      socket.onmessage = (event) => {
        void this.#onMessage(event?.data);
      };
      socket.onerror = (event) => {
        const error = new Error(`the Feishu WebSocket reported an error${event?.message ? `: ${event.message}` : ""}`);
        this.#report(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.onclose = (event) => {
        if (this.pingTimer !== undefined) this.clearTimeoutImpl(this.pingTimer);
        this.pingTimer = undefined;
        if (this.socket === socket) this.socket = null;
        if (this.stopped) {
          this.state = CONNECTION_STATE.closed;
          return;
        }
        this.#scheduleReconnect(`the socket closed (code ${event?.code ?? "?"})`);
        if (!settled) {
          settled = true;
          reject(new Error(`the Feishu WebSocket closed before it opened (code ${event?.code ?? "?"})`));
        }
      };
    });
  }

  /** Ping on the interval the handshake asked for. */
  #armPing() {
    if (this.pingTimer !== undefined) this.clearTimeoutImpl(this.pingTimer);
    this.pingTimer = this.setTimeoutImpl(() => {
      this.pingTimer = undefined;
      if (this.state !== CONNECTION_STATE.connected) return;
      try {
        this.#send({
          SeqID: 0,
          LogID: 0,
          service: Number(this.config.serviceId ?? 0),
          method: FRAME_TYPE.control,
          headers: [{ key: HEADER_KEY.type, value: MESSAGE_TYPE.ping }],
        });
        this.stats.pings += 1;
      } catch (error) {
        this.#report(error);
      }
      this.#armPing();
    }, this.config.pingIntervalMs ?? WS_DEFAULTS.pingIntervalMs);
  }

  #scheduleReconnect(reason) {
    this.state = CONNECTION_STATE.reconnecting;
    this.stats.reconnects += 1;
    this.reconnectAttempts += 1;
    const limit = Number(this.config.reconnectCount ?? WS_DEFAULTS.reconnectCount);
    if (!this.autoReconnect || (limit >= 0 && this.reconnectAttempts > limit)) {
      this.state = CONNECTION_STATE.failed;
      this.#report(new Error(`not reconnecting: ${reason}`));
      return;
    }
    const delay = this.config.reconnectIntervalMs ?? WS_DEFAULTS.reconnectIntervalMs;
    this.logger?.warn?.("[dsh-wechat-media] feishu ws reconnecting in %d ms: %s", delay, reason);
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.#open(this.config.url).catch((error) => this.#report(error));
    }, delay);
  }

  /** Send one frame. Throws when there is no open socket, so a caller knows nothing went out. */
  #send(frame) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) throw new Error("cannot send: the Feishu WebSocket is not open");
    socket.send(encodeFrame(frame));
  }

  /** Handle one inbound frame: decode, route by `type`, merge fragments, invoke handlers, acknowledge. */
  async #onMessage(raw) {
    this.stats.received += 1;
    let frame;
    try {
      frame = decodeFrame(await frameBytes(raw));
    } catch (error) {
      // Unparseable data is reported; silently dropping it would hide a protocol change.
      this.#report(new Error(`could not decode an inbound frame: ${error?.message ?? error}`));
      return;
    }
    const headers = headersToObject(frame.headers);
    const type = headers[HEADER_KEY.type];
    if (type === MESSAGE_TYPE.pong) {
      this.stats.pongs += 1;
      return;
    }
    if (type === MESSAGE_TYPE.ping) {
      // Answer a ping with a pong, as the protocol expects.
      try {
        this.#send({ ...frame, headers: [...frame.headers, { key: HEADER_KEY.type, value: MESSAGE_TYPE.pong }] });
      } catch (error) {
        this.#report(error);
      }
      return;
    }
    if (type !== MESSAGE_TYPE.event && type !== MESSAGE_TYPE.card) {
      this.stats.ignored += 1;
      this.logger?.debug?.("[dsh-wechat-media] feishu ws ignored a frame of type %s", type ?? "(none)");
      return;
    }

    let event;
    try {
      event = this.merger.merge({
        messageId: headers[HEADER_KEY.messageId],
        sum: headers[HEADER_KEY.sum],
        seq: headers[HEADER_KEY.seq],
        traceId: headers[HEADER_KEY.traceId],
        data: frame.payload,
      });
    } catch (error) {
      // The official client logs the metadata here rather than dropping it silently (its issue #201).
      this.#report(new Error(`could not merge event fragments (message_id: ${headers[HEADER_KEY.messageId] ?? "?"}, trace_id: ${headers[HEADER_KEY.traceId] ?? "?"}): ${error?.message ?? error}`));
      return;
    }
    if (!event) {
      this.stats.fragments += 1;
      return;
    }

    const startedAt = this.now();
    const reply = { code: 200 };
    try {
      for (const handler of this.handlers) {
        const result = await handler(event);
        if (result !== undefined) reply.data = Buffer.from(JSON.stringify(result), "utf8").toString("base64");
      }
      this.stats.events += 1;
    } catch (error) {
      reply.code = 500;
      this.#report(error);
    }
    try {
      this.#send({
        ...frame,
        headers: [...frame.headers, { key: HEADER_KEY.bizRt, value: String(startedAt - this.now()) }],
        payload: Buffer.from(JSON.stringify(reply), "utf8"),
      });
      this.stats.acks += 1;
    } catch (error) {
      this.#report(error);
    }
  }
}

/** A convenience factory, so callers do not have to `new` anything. */
export function startFeishuLongConnection(options) {
  const connection = new FeishuLongConnection(options);
  return connection;
}
