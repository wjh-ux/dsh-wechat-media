/**
 * dsh-wechat-media - the Feishu (Lark) bot half.
 *
 * Two kinds of Feishu bot exist, and they solve different problems:
 *
 *  - a **custom webhook bot** (`https://open.feishu.cn/open-apis/bot/v2/hook/<token>`) can only *send*; it needs no
 *    credentials beyond the URL, and it is what most deployments have;
 *  - an **app bot** (`app_id` + `app_secret`) can send *and* receive: messages go out through
 *    `im/v1/messages`, media through `im/v1/images` and `im/v1/files`, and inbound events are pushed to an HTTP
 *    endpoint that Feishu calls.
 *
 * Every endpoint, field and algorithm below was read from the official `@larksuiteoapi/node-sdk` 1.75.0 (MIT)
 * source - the AES layout and the signature composition in particular are quoted from it rather than recalled:
 *
 * ```js
 * // AESCipher (lib/index.js)
 * const hash = crypto.createHash("sha256"); hash.update(key); this.key = hash.digest();
 * const encryptBuffer = Buffer.from(encrypt, "base64");
 * const decipher = crypto.createDecipheriv("aes-256-cbc", this.key, encryptBuffer.slice(0, 16));
 * let decrypted = decipher.update(encryptBuffer.slice(16).toString("hex"), "hex", "utf8");
 *
 * // checkIsEventValidated (lib/index.js)
 * const content = timestamp + nonce + this.encryptKey + JSON.stringify(data);
 * const computedSignature = crypto.createHash("sha256").update(content).digest("hex");
 * ```
 *
 * This module is dependency-free: Node's own `fetch`, `crypto` and `Buffer` do the work.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

/** The two platforms. `lark` is the international one; the API shape is identical. */
export const FEISHU_DOMAINS = Object.freeze({
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
});

/**
 * Resolve a domain name (or an explicit URL) to a base URL.
 *
 * @param {string} [value]
 * @returns {string}
 */
export function feishuDomain(value = "feishu") {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  if (!text) return FEISHU_DOMAINS.feishu;
  if (FEISHU_DOMAINS[text]) return FEISHU_DOMAINS[text];
  if (/^https?:\/\//i.test(text)) return text;
  return FEISHU_DOMAINS.feishu;
}

/** The message types this plugin sends. */
export const FEISHU_MSG_TYPES = Object.freeze(["text", "post", "image", "file", "audio", "media"]);

/**
 * Build the `content` string for a text message.
 *
 * Feishu takes `content` as a **JSON string**, not an object - the most common mistake with this API.
 *
 * @param {string} text
 * @returns {string}
 */
export function feishuTextContent(text) {
  return JSON.stringify({ text: String(text ?? "") });
}

/**
 * Build the `content` string for a rich-text (`post`) message.
 *
 * The official SDK renders markdown through a single `{tag: "md"}` element, which Feishu draws natively
 * (bold, italics, code, links, lists, quotes, fences) - so cleaned markdown maps onto it directly.
 *
 * @param {string} markdown
 * @param {{ title?: string, locale?: string }} [options]
 * @returns {string}
 */
export function feishuPostContent(markdown, { title = "", locale = "zh_cn" } = {}) {
  return JSON.stringify({ [locale]: { title: String(title ?? ""), content: [[{ tag: "md", text: String(markdown ?? "") }]] } });
}

/**
 * Build the `content` string for an uploaded image or file.
 *
 * @param {"image" | "file" | "audio" | "media"} kind
 * @param {string} key `image_key` or `file_key` from the upload
 * @returns {string}
 */
export function feishuMediaContent(kind, key) {
  const field = kind === "image" ? "image_key" : "file_key";
  return JSON.stringify({ [field]: String(key ?? "") });
}

/**
 * Read the `tenant_access_token`, which every app-bot call needs.
 *
 * @param {{ appId?: string, appSecret?: string, domain?: string, fetchImpl?: Function }} input
 * @returns {Promise<{ token: string, expiresAt: number, expiresInSec: number }>}
 */
export async function feishuTenantToken({ appId = "", appSecret = "", domain = "feishu", fetchImpl = fetch } = {}) {
  const id = String(appId ?? "").trim();
  const secret = String(appSecret ?? "").trim();
  if (!id || !secret) throw new Error("a Feishu app bot needs both app_id and app_secret");
  const response = await fetchImpl(`${feishuDomain(domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  });
  const payload = await response.json().catch(() => ({}));
  const token = String(payload?.tenant_access_token ?? "");
  if (!token) throw new Error(`could not get a Feishu tenant token: ${feishuExplain(payload)}`);
  const expiresInSec = Number(payload?.expire) || 7200;
  return { token, expiresAt: Date.now() + expiresInSec * 1000, expiresInSec };
}

/**
 * Turn a Feishu error payload into something a person can act on.
 *
 * @param {any} payload
 * @returns {string}
 */
export function feishuExplain(payload) {
  const code = Number(payload?.code ?? 0);
  const msg = String(payload?.msg ?? payload?.message ?? "").trim();
  const known = {
    99991663: "the app credentials are wrong, or the app was disabled",
    99991664: "the app has no permission for this API - add the scope in the developer console and publish a version",
    99991668: "the app is not installed in this tenant",
    99991672: "this chat cannot be reached by the app - is the bot a member of it?",
    230001: "the request body is not valid JSON for this message type",
    230002: "the bot is not in this chat",
    230013: "the bot is not allowed to send to this user",
    230020: "the message was rate limited - slow down",
    230098: "the file is too large for this message type",
  };
  const hint = known[code];
  if (!code && !msg) return "no error detail was returned";
  return `code ${code}${msg ? ` (${msg})` : ""}${hint ? ` - ${hint}` : ""}`;
}

/**
 * Send a message to a chat, a user or an email address.
 *
 * @param {{ token?: string, receiveId?: string, receiveIdType?: string, msgType?: string, content?: string,
 *           domain?: string, uuid?: string, fetchImpl?: Function }} input
 * @returns {Promise<{ messageId: string, chatId: string, createTime: string, raw: any }>}
 */
export async function feishuSendMessage({
  token = "",
  receiveId = "",
  receiveIdType = "chat_id",
  msgType = "text",
  content = "",
  domain = "feishu",
  uuid = "",
  fetchImpl = fetch,
} = {}) {
  if (!String(token ?? "").trim()) throw new Error("sending needs a tenant_access_token");
  if (!String(receiveId ?? "").trim()) throw new Error("sending needs a receive_id (chat_id, open_id, user_id or email)");
  const url = new URL(`${feishuDomain(domain)}/open-apis/im/v1/messages`);
  url.searchParams.set("receive_id_type", String(receiveIdType));
  if (uuid) url.searchParams.set("uuid", String(uuid));
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ receive_id: String(receiveId), msg_type: String(msgType), content: String(content) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code ?? -1) !== 0) throw new Error(`Feishu refused the message: ${feishuExplain(payload)}`);
  const data = payload?.data ?? {};
  return { messageId: String(data.message_id ?? ""), chatId: String(data.chat_id ?? ""), createTime: String(data.create_time ?? ""), raw: payload };
}

/**
 * Reply in the thread of an existing message.
 *
 * Being a reply is not cosmetic: it keeps the answer attached to the question in Feishu's own UI.
 *
 * @param {{ token?: string, messageId?: string, msgType?: string, content?: string, domain?: string,
 *           replyInThread?: boolean, fetchImpl?: Function }} input
 * @returns {Promise<{ messageId: string, raw: any }>}
 */
export async function feishuReplyMessage({
  token = "",
  messageId = "",
  msgType = "text",
  content = "",
  domain = "feishu",
  replyInThread = false,
  fetchImpl = fetch,
} = {}) {
  if (!String(token ?? "").trim()) throw new Error("replying needs a tenant_access_token");
  if (!String(messageId ?? "").trim()) throw new Error("replying needs the message_id being answered");
  const url = new URL(`${feishuDomain(domain)}/open-apis/im/v1/messages/${encodeURIComponent(String(messageId))}/reply`);
  if (replyInThread) url.searchParams.set("reply_in_thread", "true");
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ msg_type: String(msgType), content: String(content) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code ?? -1) !== 0) throw new Error(`Feishu refused the reply: ${feishuExplain(payload)}`);
  return { messageId: String(payload?.data?.message_id ?? ""), raw: payload };
}

/**
 * Build a `multipart/form-data` body. Node has no built-in form encoder, and this keeps the plugin
 * dependency-free.
 *
 * @param {Array<{ name: string, value: string }>} fields
 * @param {{ name: string, filename: string, contentType: string, bytes: Buffer }} [file]
 * @returns {{ body: Buffer, boundary: string }}
 */
export function feishuMultipart(fields = [], file = undefined) {
  const boundary = `----dshfeishu${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const parts = [];
  for (const field of fields) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`, "utf8"));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `content-type: ${file.contentType}\r\n\r\n`, "utf8"));
    parts.push(Buffer.from(file.bytes));
    parts.push(Buffer.from("\r\n", "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), boundary };
}

/**
 * Upload an image, which returns the `image_key` a message then refers to.
 *
 * @param {{ token?: string, bytes?: Buffer | Uint8Array, filename?: string, imageType?: string, domain?: string,
 *           fetchImpl?: Function }} input
 * @returns {Promise<{ imageKey: string, raw: any }>}
 */
export async function feishuUploadImage({
  token = "",
  bytes = undefined,
  filename = "image.png",
  imageType = "message",
  domain = "feishu",
  fetchImpl = fetch,
} = {}) {
  const data = Buffer.from(bytes ?? []);
  if (!data.length) throw new Error("uploading an image needs bytes");
  const { body, boundary } = feishuMultipart([{ name: "image_type", value: String(imageType) }], {
    name: "image",
    filename: String(filename),
    contentType: guessImageType(filename),
    bytes: data,
  });
  const response = await fetchImpl(`${feishuDomain(domain)}/open-apis/im/v1/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code ?? -1) !== 0) throw new Error(`Feishu refused the image: ${feishuExplain(payload)}`);
  return { imageKey: String(payload?.data?.image_key ?? ""), raw: payload };
}

/**
 * Upload a file (also used for audio and video, which travel as files with a `file_type`).
 *
 * @param {{ token?: string, bytes?: Buffer | Uint8Array, filename?: string, fileType?: string,
 *           durationMs?: number, domain?: string, fetchImpl?: Function }} input
 * @returns {Promise<{ fileKey: string, raw: any }>}
 */
export async function feishuUploadFile({
  token = "",
  bytes = undefined,
  filename = "file.bin",
  fileType = "stream",
  durationMs = undefined,
  domain = "feishu",
  fetchImpl = fetch,
} = {}) {
  const data = Buffer.from(bytes ?? []);
  if (!data.length) throw new Error("uploading a file needs bytes");
  const fields = [
    { name: "file_type", value: String(fileType) },
    { name: "file_name", value: String(filename) },
  ];
  if (Number.isFinite(durationMs) && Number(durationMs) > 0) fields.push({ name: "duration", value: String(Math.round(Number(durationMs))) });
  const { body, boundary } = feishuMultipart(fields, {
    name: "file",
    filename: String(filename),
    contentType: "application/octet-stream",
    bytes: data,
  });
  const response = await fetchImpl(`${feishuDomain(domain)}/open-apis/im/v1/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code ?? -1) !== 0) throw new Error(`Feishu refused the file: ${feishuExplain(payload)}`);
  return { fileKey: String(payload?.data?.file_key ?? ""), raw: payload };
}

/** A content type good enough for the upload's own header. */
function guessImageType(filename) {
  const name = String(filename ?? "").toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

/**
 * Which `file_type` an upload should declare.
 *
 * Feishu only accepts a fixed set; anything it does not know must be sent as `stream`.
 *
 * @param {string} filename
 * @param {{ kind?: string }} [options]
 * @returns {string}
 */
export function feishuFileType(filename, { kind = "" } = {}) {
  if (kind === "audio") return "opus";
  if (kind === "video") return "mp4";
  const name = String(filename ?? "").toLowerCase();
  if (name.endsWith(".mp4")) return "mp4";
  if (name.endsWith(".opus")) return "opus";
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".doc") || name.endsWith(".docx")) return "doc";
  if (name.endsWith(".xls") || name.endsWith(".xlsx")) return "xls";
  if (name.endsWith(".ppt") || name.endsWith(".pptx")) return "ppt";
  return "stream";
}

/**
 * The AES key Feishu's encrypted events use: the SHA-256 of the encrypt key.
 *
 * @param {string} encryptKey
 * @returns {Buffer}
 */
export function feishuAesKey(encryptKey) {
  return createHash("sha256").update(String(encryptKey ?? ""), "utf8").digest();
}

/**
 * Decrypt an `encrypt` field from a Feishu event.
 *
 * The layout is the official one: base64-decode, use the **first 16 bytes as the IV**, and decrypt the rest with
 * `aes-256-cbc` under `sha256(encryptKey)`.
 *
 * @param {{ encrypt?: string, encryptKey?: string }} input
 * @returns {string} the decrypted JSON text
 */
export function feishuDecryptEvent({ encrypt = "", encryptKey = "" } = {}) {
  const key = String(encryptKey ?? "");
  if (!key) throw new Error("decrypting an event needs the encrypt key");
  const buffer = Buffer.from(String(encrypt ?? ""), "base64");
  if (buffer.length <= 16) throw new Error("the encrypted event is too short to contain an IV");
  const decipher = createDecipheriv("aes-256-cbc", feishuAesKey(key), buffer.subarray(0, 16));
  const decrypted = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString("utf8");
  return decrypted;
}

/**
 * Encrypt a payload the way Feishu would, so the decryption above can be tested against a real ciphertext.
 *
 * @param {{ payload?: any, encryptKey?: string }} input
 * @returns {string} base64 of `iv || ciphertext`
 */
export function feishuEncryptEventForTest({ payload = {}, encryptKey = "" } = {}) {
  const key = String(encryptKey ?? "");
  if (!key) throw new Error("encrypting needs the encrypt key");
  const iv = Buffer.from(String(Date.now()).padEnd(16, "0").slice(0, 16), "utf8");
  const cipher = createCipheriv("aes-256-cbc", feishuAesKey(key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body]).toString("base64");
}

/**
 * The signature Feishu puts in `X-Lark-Signature`.
 *
 * With an encrypt key present the digest is `sha256(timestamp + nonce + encryptKey + body)` in hex; without one
 * it is `sha1(timestamp + nonce + verificationToken + body)`, also hex. Both were read from the official SDK.
 *
 * @param {{ timestamp?: string, nonce?: string, body?: string, encryptKey?: string, verificationToken?: string }} input
 * @returns {string}
 */
export function feishuEventSignature({
  timestamp = "",
  nonce = "",
  body = "",
  encryptKey = "",
  verificationToken = "",
} = {}) {
  const text = String(timestamp) + String(nonce);
  if (String(encryptKey ?? "")) {
    return createHash("sha256").update(`${text}${encryptKey}${body}`, "utf8").digest("hex");
  }
  return createHash("sha1").update(`${text}${verificationToken}${body}`, "utf8").digest("hex");
}

/**
 * Verify an inbound event: the signature, and the verification token inside the body.
 *
 * `rawBody` must be the **bytes as received** - re-serialising the parsed object can reorder keys and change the
 * digest. The comparison is length-safe and case-insensitive on hex.
 *
 * @param {{ headers?: Record<string, string>, rawBody?: string, parsed?: any, encryptKey?: string,
 *           verificationToken?: string }} input
 * @returns {{ ok: boolean, reason: string, event?: any }}
 */
export function feishuVerifyEvent({ headers = {}, rawBody = "", parsed = undefined, encryptKey = "", verificationToken = "" } = {}) {
  const lower = {};
  for (const [name, value] of Object.entries(headers ?? {})) lower[String(name).toLowerCase()] = value;
  const timestamp = String(lower["x-lark-request-timestamp"] ?? "");
  const nonce = String(lower["x-lark-request-nonce"] ?? "");
  const signature = String(lower["x-lark-signature"] ?? "");
  const body = String(rawBody ?? "");
  const hasEncryptKey = Boolean(String(encryptKey ?? ""));

  if (hasEncryptKey || verificationToken) {
    if (!timestamp || !nonce || !signature) return { ok: false, reason: "the event has no X-Lark-Request-Timestamp/Nonce/Signature headers" };
    const expected = feishuEventSignature({ timestamp, nonce, body, encryptKey, verificationToken });
    if (!timingSafeEqualHex(expected, signature)) return { ok: false, reason: "the event signature does not match - wrong encrypt/verification key, or the body was re-serialised" };
  }

  let event = parsed;
  if (event && typeof event === "object" && typeof event.encrypt === "string") {
    if (!hasEncryptKey) return { ok: false, reason: "the event is encrypted but no encrypt key is configured" };
    try {
      event = JSON.parse(feishuDecryptEvent({ encrypt: event.encrypt, encryptKey }));
    } catch (error) {
      return { ok: false, reason: `the encrypted event could not be decrypted: ${error?.message ?? error}` };
    }
  }
  return { ok: true, reason: "verified", event };
}

/**
 * The URL-verification handshake: Feishu sends `{challenge}` and expects it echoed back.
 *
 * @param {any} event
 * @returns {string | undefined} the challenge, when this is the handshake
 */
export function feishuChallenge(event) {
  const value = event?.challenge;
  return typeof value === "string" && value ? value : undefined;
}

/** Constant-time-ish comparison for hex digests of equal length. */
function timingSafeEqualHex(a, b) {
  const left = String(a ?? "").toLowerCase();
  const right = String(b ?? "").toLowerCase();
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * The custom-webhook signature.
 *
 * Feishu signs the *empty string* with `HMAC-SHA256(key = timestamp + "\n" + secret)` and base64-encodes the
 * result - the key is the concatenation, not the message, which is the trap in this API.
 *
 * @param {{ timestamp?: string | number, secret?: string }} input
 * @returns {string}
 */
export function feishuWebhookSign({ timestamp = "", secret = "" } = {}) {
  const key = `${timestamp}\n${secret}`;
  return createHmac("sha256", key).update("", "utf8").digest("base64");
}

/**
 * Send through a custom webhook bot (no credentials, send-only).
 *
 * @param {{ webhookUrl?: string, secret?: string, msgType?: string, content?: any, timestamp?: number,
 *           fetchImpl?: Function }} input
 * @returns {Promise<{ ok: boolean, raw: any }>}
 */
export async function feishuWebhookSend({
  webhookUrl = "",
  secret = "",
  msgType = "text",
  content = undefined,
  timestamp = undefined,
  fetchImpl = fetch,
} = {}) {
  const url = String(webhookUrl ?? "").trim();
  if (!/^https:\/\//i.test(url)) throw new Error("a Feishu webhook bot needs its https://…/open-apis/bot/v2/hook/… URL");
  // An interactive card travels under `card`, everything else under `content`. An independent implementation
  // (lark-webhook-notify, Apache-2.0) builds exactly this shape.
  const body = String(msgType) === "interactive"
    ? { msg_type: "interactive", card: content }
    : { msg_type: String(msgType), content };
  if (String(secret ?? "")) {
    const stamp = timestamp ?? Math.floor(Date.now() / 1000);
    body.timestamp = String(stamp);
    body.sign = feishuWebhookSign({ timestamp: stamp, secret: String(secret) });
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  // A webhook answers `{code: 0}` (older bots answer `{StatusCode: 0}`): both mean accepted.
  const code = Number(payload?.code ?? payload?.StatusCode ?? -1);
  if (code !== 0) throw new Error(`the Feishu webhook refused the message: ${feishuExplain({ code, msg: payload?.msg ?? payload?.StatusMessage })}`);
  return { ok: true, raw: payload };
}
