/**
 * dsh-wechat-media - WeCom intelligent robot (企业微信智能机器人) over the official
 * WebSocket long connection.
 *
 * Why this and not the callback API: WeCom's intelligent robot offers two API modes,
 * and the **long connection** one needs no public URL, no callback token, no
 * EncodingAESKey, no corpId and no agentId - just the BotID and its Secret. That is
 * what makes two-way WeCom possible from a plugin running on someone's own machine.
 *
 * The protocol, taken from the official `aibot-node-sdk`:
 *
 *   connect   wss://openws.work.weixin.qq.com
 *   auth      { cmd: "aibot_subscribe", headers: { req_id }, body: { secret, bot_id } }
 *   heartbeat { cmd: "ping",             headers: { req_id } }              (30 s)
 *   inbound   { cmd: "aibot_msg_callback", headers: { req_id }, body: { msgid, msgtype, aibotid, chatid?, chattype, … } }
 *   reply     { cmd: "aibot_respond_msg",  headers: { req_id }, body: { msgtype, … } }
 *   proactive { cmd: "aibot_send_msg",     headers: { req_id }, body: { chatid, msgtype, … } }
 *   answers   { headers: { req_id }, errcode, errmsg }
 *
 * Dependency-free: Node >= 22 ships a global WebSocket.
 */

/** The official long-connection endpoint. */
import { createHash } from "node:crypto";
import { MiniWebSocket } from "./ws-client.js";

export const BOT_WS_URL = "wss://openws.work.weixin.qq.com";

/** Media upload limits, as the official SDK implements them. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export const UPLOAD_MAX_CHUNKS = 100;
export const UPLOAD_CHUNK_RETRIES = 2;

/**
 * The two extra fields the official WeCom integration puts in the auth frame.
 *
 * Taken from `@wecom/wecom-openclaw-plugin`, which calls
 * `new WSClient({ botId, secret, scene: SCENE_WECOM_OPENCLAW, plug_version: PLUGIN_VERSION })`
 * - and the SDK expands those into the subscribe body. Without them the server answers
 * `853000 invalid bot_id or secret` even for a valid pair.
 */
export const SCENE_WECOM_OPENCLAW = 1;
export const DEFAULT_PLUG_VERSION = "2026.9.15";

/** Node's built-in WebSocket (undici) fails this endpoint's handshake with an opaque
 * TypeError, so the transport defaults to the small RFC 6455 client in ws-client.js. */

/** Command names, exactly as the official SDK spells them. */
export const CMDS = {
  SUBSCRIBE: "aibot_subscribe",
  HEARTBEAT: "ping",
  RESPONSE: "aibot_respond_msg",
  SEND_MSG: "aibot_send_msg",
  CALLBACK: "aibot_msg_callback",
  EVENT_CALLBACK: "aibot_event_callback",
  UPLOAD_INIT: "aibot_upload_media_init",
  UPLOAD_CHUNK: "aibot_upload_media_chunk",
  UPLOAD_FINISH: "aibot_upload_media_finish",
};

/** A request id the server echoes back so an answer can be matched to its frame. */
export function generateReqId(prefix = "dsh") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function authFrame(botId, secret, reqId = generateReqId(CMDS.SUBSCRIBE), extra = {}) {
  const body = { secret, bot_id: botId };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  return { cmd: CMDS.SUBSCRIBE, headers: { req_id: reqId }, body };
}

export function heartbeatFrame(reqId = generateReqId(CMDS.HEARTBEAT)) {
  return { cmd: CMDS.HEARTBEAT, headers: { req_id: reqId } };
}

export function textBody(content) {
  return { msgtype: "text", text: { content: String(content ?? "") } };
}

export function markdownBody(content) {
  return { msgtype: "markdown", markdown: { content: String(content ?? "") } };
}

/**
 * The body of a **passive reply**. WeCom's intelligent robot only accepts `stream`
 * here - `text` is reserved for the welcome message - and answers `40008 invalid
 * message type` otherwise. `content` may be Markdown and is capped at 20480 bytes;
 * re-sending the same `id` updates the message in place, so a fresh id starts a new
 * message.
 */
export function streamBody(streamId, content, finish = true, { msgItem } = {}) {
  const stream = { id: String(streamId), finish: Boolean(finish), content: String(content ?? "") };
  if (finish && Array.isArray(msgItem) && msgItem.length > 0) stream.msg_item = msgItem.slice(0, 10);
  return { msgtype: "stream", stream };
}

/** WeCom's own limit for one stream body. */
export const STREAM_CONTENT_LIMIT = 20480;

/** Split a long answer into stream-sized pieces (utf8 bytes, never cutting a code point). */
export function splitForStream(text, limit = STREAM_CONTENT_LIMIT) {
  const parts = [];
  let current = "";
  for (const char of String(text ?? "")) {
    if (Buffer.byteLength(current + char, "utf8") > limit) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current !== "" || parts.length === 0) parts.push(current);
  return parts;
}

export function mediaBody(type, mediaId, videoOptions) {
  const key = type === "image" ? "image" : type === "voice" ? "voice" : type === "video" ? "video" : "file";
  const payload = { media_id: String(mediaId) };
  if (key === "video" && videoOptions) {
    if (videoOptions.title) payload.title = String(videoOptions.title);
    if (videoOptions.description) payload.description = String(videoOptions.description);
  }
  return { msgtype: key, [key]: payload };
}

/**
 * Reply to one received frame (passive: no chatid is needed).
 *
 * The `req_id` is passed **through from the inbound frame** - that is how the server
 * correlates an answer with the message it belongs to. Inventing a fresh id here is
 * answered with `846605 invalid req_id`.
 */
export function replyFrame(frame, body) {
  const reqId = String(frame?.headers?.req_id ?? "");
  return { cmd: CMDS.RESPONSE, headers: { req_id: reqId }, body };
}

/** Push into a chat without an inbound frame (proactive). */
export function sendFrame(chatId, body, reqId = generateReqId(CMDS.SEND_MSG)) {
  return { cmd: CMDS.SEND_MSG, headers: { req_id: reqId }, body: { chatid: String(chatId), ...body } };
}

/** Push the media of one payload entry (`image` / `file` / `video`) onto `into`. */
function collectMedia(payload, into) {
  if (payload?.image?.url) into.push({ type: "image", url: payload.image.url, aesKey: payload.image.aeskey });
  if (payload?.file?.url) into.push({ type: "file", url: payload.file.url, aesKey: payload.file.aeskey, fileName: payload.file.filename });
  // WeCom's voice payload carries only the transcription (`content`), no url - there is
  // nothing to download, so a `voice.url` is only honoured if the platform ever adds one.
  if (payload?.voice?.url) into.push({ type: "voice", url: payload.voice.url, aesKey: payload.voice.aeskey });
  if (payload?.video?.url) into.push({ type: "video", url: payload.video.url, aesKey: payload.video.aeskey });
}

/**
 * Normalise a callback into the little shape the rest of the plugin uses.
 *
 * Every media-bearing shape the protocol defines is collected, not just the top-level
 * one: an **image in a text message** arrives as `mixed.msg_item`, and an image the user
 * *quoted* arrives under `quote`. Both used to be dropped silently - a mixed message
 * carried no text either, so it was counted as unusable and never reached the model.
 *
 * @returns {undefined|{ msgId, botId, chatId, chatType, msgType, text, media: object[] }}
 */
export function describeBotMessage(frame) {
  if (!frame || frame.cmd !== CMDS.CALLBACK) return undefined;
  const body = frame.body ?? {};
  const chatType = body.chattype ?? (body.chatid ? "group" : "single");
  const chatId = String(body.chatid ?? body.from?.userid ?? body.userid ?? "");
  const media = [];
  collectMedia(body, media);
  // 图文混排: text parts join the message text, image parts join the media.
  const mixedText = [];
  for (const part of Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : []) {
    if (part?.msgtype === "text" && part.text?.content) mixedText.push(String(part.text.content));
    if (part?.msgtype === "image" && part.image?.url) media.push({ type: "image", url: part.image.url, aesKey: part.image.aeskey });
  }
  // Quoted media only: quoted *text* stays out of the prompt, as on the WeChat side.
  collectMedia(body.quote, media);
  const text = body.text?.content ?? body.markdown?.content ?? body.voice?.content ?? mixedText.join("\n");
  return {
    msgId: String(body.msgid ?? ""),
    botId: String(body.aibotid ?? ""),
    chatId,
    chatType: chatType === "group" ? "group" : "single",
    msgType: String(body.msgtype ?? "unknown"),
    text: String(text ?? ""),
    media,
  };
}

/** Parse one WebSocket payload; undefined when it is not JSON. */
export function parseFrame(data) {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Human-readable auth/frame errors, so a failure says what to fix. */
export function botError(frame) {
  const errcode = Number(frame?.errcode ?? 0);
  if (!Number.isFinite(errcode) || errcode === 0) return undefined;
  const known = {
    40001: "authentication failed - check the robot's BotID and Secret",
    853000: "invalid BotID or Secret - copy both again from the robot's API page",
    40014: "the long connection is not authorised (was the robot switched to callback mode?)",
    41001: "missing credentials",
    42001: "the connection expired - it will be re-established",
    45009: "rate limit reached",
    60020: "this machine's IP is not allowed for the app",
  };
  const hint = known[errcode];
  const errmsg = String(frame?.errmsg ?? "").trim();
  const head = `WeCom bot ${errcode}${hint ? `: ${hint}` : ""}`;
  const redundant = errmsg !== "" && hint && hint.toLowerCase().includes(errmsg.toLowerCase());
  return redundant || errmsg === "" ? head : `${head} - ${errmsg}`;
}

/**
 * A long-connection client for one intelligent robot.
 *
 * `WebSocketImpl` is injectable so tests never open a socket, and `now`/timers are
 * the runtime's own.
 */
export class WecomBot {
  constructor({
    botId,
    secret,
    url = BOT_WS_URL,
    WebSocketImpl = MiniWebSocket,
    logger,
    heartbeatMs = 30000,
    reconnectBaseMs = 1000,
    maxReconnectAttempts = 10,
    onMessage,
    onEvent,
    onStatus,
    scene = SCENE_WECOM_OPENCLAW,
    plugVersion = DEFAULT_PLUG_VERSION,
  } = {}) {
    this.botId = String(botId ?? "");
    this.secret = String(secret ?? "");
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.heartbeatMs = heartbeatMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.onMessage = onMessage;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.scene = scene;
    this.plugVersion = plugVersion;
    this.socket = undefined;
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
    this.attempts = 0;
    this.authenticated = false;
    this.closed = false;
    this.pending = new Map();
  }

  status() {
    return {
      connected: this.authenticated === true,
      authenticated: this.authenticated,
      attempts: this.attempts,
      url: this.url,
      botId: this.botId ? `${this.botId.slice(0, 6)}…` : null,
    };
  }

  connect() {
    if (!this.WebSocketImpl) throw new Error("no WebSocket implementation available (Node >= 22 provides one)");
    if (!this.botId || !this.secret) throw new Error("botId and secret are required");
    this.closed = false;
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.addEventListener?.("open", () => this.#onOpen());
    socket.addEventListener?.("message", (event) => this.#onMessage(event?.data));
    socket.addEventListener?.("error", (event) => this.logger?.warn?.("[dsh-wechat-media] wecom bot socket error: %s", event?.message ?? event?.type ?? "error"));
    socket.addEventListener?.("close", () => this.#onClose());
    this.onStatus?.({ ...this.status(), connecting: true });
    return this;
  }

  #onOpen() {
    this.attempts = 0;
    const frame = authFrame(this.botId, this.secret, generateReqId("auth"), {
      scene: this.scene,
      plug_version: this.plugVersion,
    });
    this.#send(frame);
  }

  #onMessage(raw) {
    const frame = parseFrame(raw);
    if (!frame) return;
    // An answer to something *we* asked for (upload init/chunk/finish, an acknowledged
    // reply) is matched by req_id - the same correlation the official SDK uses. This comes
    // first because a failed answer carries an errcode and must reject its waiter instead
    // of just being logged.
    const reqId = String(frame.headers?.req_id ?? "");
    const waiting = reqId ? this.pending.get(reqId) : undefined;
    if (waiting) {
      this.pending.delete(reqId);
      waiting(frame);
      return;
    }
    const error = botError(frame);
    if (frame.cmd === undefined && !error) {
      // An answer to auth or a heartbeat.
      this.authenticated = true;
      this.#startHeartbeat();
      this.onStatus?.(this.status());
      return;
    }
    if (error) {
      this.logger?.warn?.("[dsh-wechat-media] wecom bot: %s", error);
      if (!this.authenticated) this.onStatus?.({ ...this.status(), error });
      return;
    }
    if (frame.cmd === CMDS.CALLBACK) {
      const message = describeBotMessage(frame);
      if (message) this.onMessage?.(message, frame);
      return;
    }
    if (frame.cmd === CMDS.EVENT_CALLBACK) {
      this.onEvent?.(frame);
      return;
    }
    // A `reply_to` correlation is kept as a fallback: some answers name the frame they
    // belong to instead of echoing a req_id we invented.
    const waitingByReplyTo = frame.headers?.reply_to ? this.pending.get(frame.headers.reply_to) : undefined;
    if (waitingByReplyTo) {
      this.pending.delete(frame.headers.reply_to);
      waitingByReplyTo(frame);
    }
  }

  #onClose() {
    this.socket = undefined;
    this.authenticated = false;
    this.#stopHeartbeat();
    this.onStatus?.(this.status());
    if (this.closed) return;
    if (this.attempts >= this.maxReconnectAttempts) {
      this.logger?.warn?.("[dsh-wechat-media] wecom bot: giving up after %d attempts", this.attempts);
      return;
    }
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempts, 30000);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    // Report after scheduling, so a caller can see that a retry is on its way.
    this.onStatus?.(this.status());
  }

  #startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.#send(heartbeatFrame()), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  #send(frame) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  /** Reply to one received frame (text or markdown). */
  reply(frame, body) {
    return this.#send(replyFrame(frame, body));
  }

  /**
   * Reply and wait for the server's answer.
   *
   * Intermediate stream frames are fire-and-forget on purpose: the platform does not answer each one,
   * and waiting would stall the stream behind network round-trips. The **closing** frame is different
   * - it is the one that makes the platform keep the message - so its answer is read: errcode 6000
   * ("more than one caller at the same time") arrives when it races the frame before it, and without
   * reading this the rejection is invisible (the chat then keeps an unfinished fragment).
   */
  replyAndWait(frame, body, { timeoutMs = 8000 } = {}) {
    const wire = replyFrame(frame, body);
    return this.request(wire.cmd, wire.body, { timeoutMs, reqId: wire.headers?.req_id });
  }

  /** Push a message into a chat without an inbound frame. */
  sendMessage(chatId, body) {
    return this.#send(sendFrame(chatId, body));
  }

  /**
   * Send one command frame and resolve with the server's answer for it.
   *
   * The answer is matched by the `req_id` we invent, which is how the official SDK does it
   * (`WsConnectionManager.sendReply`): a frame carrying our req_id resolves the waiter, an
   * `errcode` rejects it, and silence rejects it after `timeoutMs`. This is what makes the
   * media upload possible at all - it needs the server's `upload_id` and `media_id`.
   *
   * @returns {Promise<object>} the answer frame
   */
  request(cmd, body, { timeoutMs = 30000, reqId = generateReqId(cmd) } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#send({ cmd, headers: { req_id: reqId }, body })) {
        reject(new Error(`${cmd} could not be sent: the long connection is not writable`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`no answer to ${cmd} within ${timeoutMs} ms`));
      }, timeoutMs);
      // Deliberately NOT unref'd: the caller is awaiting this promise, and an unref'd timer
      // is not guaranteed to fire (nothing else would keep the event loop alive).
      this.pending.set(reqId, (frame) => {
        clearTimeout(timer);
        const failure = botError(frame);
        if (failure) {
          reject(new Error(failure));
          return;
        }
        resolve(frame);
      });
    });
  }

  /**
   * Upload one file as a temporary WeCom media asset and return its `media_id`.
   *
   * Three steps over the long connection, exactly as the official SDK implements them:
   * `aibot_upload_media_init` (type, filename, total_size, total_chunks, md5) -> one
   * `aibot_upload_media_chunk` per 512 KiB slice (base64) -> `aibot_upload_media_finish`.
   * Chunks are limited to 100 (~50 MB) and sent with bounded concurrency, because the
   * platform answers `system error` to a burst of chunks (the SDK caps it at 2-3 for larger
   * files). Each chunk is retried twice; a failure surfaces rather than half-uploading.
   *
   * @param {Buffer} buffer file contents (already read; this does no filesystem work)
   * @param {{type?: string, filename?: string, timeoutMs?: number, onProgress?: Function}} [options]
   * @returns {Promise<{mediaId: string, uploadId: string, chunks: number, bytes: number, type: string}>}
   */
  async uploadMedia(buffer, { type = "file", filename = "file.bin", timeoutMs = 60000, retryDelayMs = 500, onProgress } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("uploadMedia: there is nothing to upload");
    }
    const totalChunks = Math.ceil(buffer.length / UPLOAD_CHUNK_BYTES);
    if (totalChunks > UPLOAD_MAX_CHUNKS) {
      throw new Error(
        `uploadMedia: ${buffer.length} bytes needs ${totalChunks} chunks, over the ${UPLOAD_MAX_CHUNKS} limit (~50 MB)`,
      );
    }
    const md5 = createHash("md5").update(buffer).digest("hex");

    const init = await this.request(
      CMDS.UPLOAD_INIT,
      { type, filename: String(filename), total_size: buffer.length, total_chunks: totalChunks, md5 },
      { timeoutMs },
    );
    const uploadId = init?.body?.upload_id;
    if (!uploadId) throw new Error(`uploadMedia: the server sent no upload_id (${JSON.stringify(init?.body ?? {})})`);

    const sendChunk = async (index) => {
      const slice = buffer.subarray(index * UPLOAD_CHUNK_BYTES, Math.min((index + 1) * UPLOAD_CHUNK_BYTES, buffer.length));
      let lastError;
      for (let attempt = 0; attempt <= UPLOAD_CHUNK_RETRIES; attempt += 1) {
        try {
          await this.request(
            CMDS.UPLOAD_CHUNK,
            { upload_id: uploadId, chunk_index: index, base64_data: slice.toString("base64") },
            { timeoutMs },
          );
          onProgress?.({ sent: index + 1, total: totalChunks, bytes: slice.length });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < UPLOAD_CHUNK_RETRIES) {
            // Not unref'd: a scheduled retry must actually happen.
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
          }
        }
      }
      throw new Error(`uploadMedia: chunk ${index + 1}/${totalChunks} failed - ${lastError?.message ?? lastError}`);
    };

    // Bounded concurrency, as in the SDK: 1-4 chunks can all go at once, 5-10 at three,
    // anything larger at two.
    const concurrency = totalChunks <= 4 ? Math.max(1, totalChunks) : totalChunks <= 10 ? 3 : 2;
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, totalChunks) }, async () => {
      while (next < totalChunks) {
        const index = next;
        next += 1;
        await sendChunk(index);
      }
    });
    await Promise.all(workers);

    const finish = await this.request(CMDS.UPLOAD_FINISH, { upload_id: uploadId }, { timeoutMs });
    const mediaId = finish?.body?.media_id;
    if (!mediaId) throw new Error(`uploadMedia: the server sent no media_id (${JSON.stringify(finish?.body ?? {})})`);
    return { mediaId, uploadId, chunks: totalChunks, bytes: buffer.length, type: finish?.body?.type ?? type };
  }

  /**
   * Answer an inbound frame with a media message (the passive path). Waits for the ack, so
   * a refusal is reported instead of being lost.
   */
  replyMedia(frame, mediaType, mediaId, videoOptions, { timeoutMs = 20000 } = {}) {
    const reqId = String(frame?.headers?.req_id ?? "");
    if (!reqId) return Promise.reject(new Error("replyMedia: the inbound frame carries no req_id"));
    return this.request(CMDS.RESPONSE, mediaBody(mediaType, mediaId, videoOptions), { reqId, timeoutMs });
  }

  /**
   * Push a media message into a chat without an inbound frame (the active path, which is
   * what the `wecom_send_file` tool uses).
   */
  sendMediaMessage(chatId, mediaType, mediaId, videoOptions, { timeoutMs = 20000 } = {}) {
    const chat = String(chatId ?? "").trim();
    if (!chat) return Promise.reject(new Error("sendMediaMessage: a chat id is required"));
    return this.request(CMDS.SEND_MSG, { chatid: chat, ...mediaBody(mediaType, mediaId, videoOptions) }, { timeoutMs });
  }

  close() {
    this.closed = true;
    this.#stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.socket?.close?.();
    } catch {
      // already gone
    }
    this.socket = undefined;
    this.authenticated = false;
    this.onStatus?.(this.status());
  }
}
