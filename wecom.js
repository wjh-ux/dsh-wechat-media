/**
 * dsh-wechat-media - WeCom (企业微信) transport.
 *
 * Two ways to send, neither needing a public address:
 *
 *   1. Group robot webhook - one URL, no credentials. text / markdown / image.
 *   2. Self-built app - corpid + corpsecret + agentid. text / markdown, plus image,
 *      file, voice and video through a media upload.
 *
 * Both are outbound. Inbound WeCom lives in wecom-bot.js, over the intelligent
 * robot's long connection; what stays impossible here is the *callback API*, which
 * insists on a public HTTPS URL that the enterprise registers and a plugin running
 * on someone's own machine cannot offer. The personal-WeChat side keeps its own
 * two-way bridge.
 *
 * Dependency-free: Node >= 22, global fetch, FormData and Blob.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Where a group robot receives its messages. */
export const WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
/** Base of the application API (token, message/send, media/upload). */
export const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

/** Errors worth naming, so a failure says what to fix instead of just a number. */
const ERRORS = {
  40001: "invalid credential - check corpsecret (and that the app is enabled)",
  40014: "invalid access_token",
  41001: "missing access_token",
  42001: "access_token expired",
  45009: "API rate limit reached",
  60020: "this machine's IP is not in the app's trusted IP list",
  81013: "invalid user/department/tag in touser",
  93000: "invalid webhook url - check the key in the URL",
  301002: "the app has no permission for this call",
};

/**
 * Turn a WeCom answer into a readable error.
 * @returns {string|undefined} undefined when errcode is 0 (or absent, e.g. the
 *   webhook answers `{errcode:0,errmsg:"ok"}`).
 */
export function wecomError(result) {
  const errcode = Number(result?.errcode ?? 0);
  if (!Number.isFinite(errcode) || errcode === 0) return undefined;
  const known = ERRORS[errcode];
  const errmsg = String(result?.errmsg ?? "").trim();
  const head = `WeCom ${errcode}${known ? `: ${known}` : ""}`;
  // The platform's own wording is appended only when it adds something: for a known
  // code it is usually a substring of the hint, and repeating it reads like a bug.
  const redundant = errmsg !== "" && known && known.toLowerCase().includes(errmsg.toLowerCase());
  return redundant || errmsg === "" ? head : `${head} - ${errmsg}`;
}

/** A group robot URL, so a pasted access_token or a typo is caught early. */
export function isWebhookUrl(url) {
  const text = String(url ?? "").trim();
  if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?/i.test(text)) return false;
  return /[?&]key=[A-Za-z0-9-]+/.test(text);
}

export function textPayload(content, { mentionedList, mentionedMobileList } = {}) {
  const text = { content: String(content ?? "") };
  if (Array.isArray(mentionedList) && mentionedList.length > 0) text.mentioned_list = mentionedList;
  if (Array.isArray(mentionedMobileList) && mentionedMobileList.length > 0) text.mentioned_mobile_list = mentionedMobileList;
  return { msgtype: "text", text };
}

export function markdownPayload(content) {
  return { msgtype: "markdown", markdown: { content: String(content ?? "") } };
}

/** A group robot takes an image inline: base64 plus the md5 of the same bytes. */
export function imagePayload(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  return {
    msgtype: "image",
    image: {
      base64: buffer.toString("base64"),
      md5: createHash("md5").update(buffer).digest("hex"),
    },
  };
}

export function appTextPayload(content) {
  return { msgtype: "text", text: { content: String(content ?? "") } };
}

export function appMarkdownPayload(content) {
  return { msgtype: "markdown", markdown: { content: String(content ?? "") } };
}

export function appMediaPayload(type, mediaId) {
  const key = type === "image" ? "image" : type === "voice" ? "voice" : type === "video" ? "video" : "file";
  return { msgtype: key, [key]: { media_id: mediaId } };
}

async function postJson(url, payload, { timeoutMs = 15000, signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
    ...(timeoutMs ? { signal: signal ?? AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WeCom answered ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  return { result, status: response.status };
}

/** Send one payload to a group robot. Throws a readable Error on failure. */
export async function sendWebhook({ webhookUrl, payload, timeoutMs, signal, fetchImpl } = {}) {
  if (!isWebhookUrl(webhookUrl)) {
    throw new Error("webhookUrl must look like https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…");
  }
  const { result } = await postJson(String(webhookUrl).trim(), payload, { timeoutMs, signal, fetchImpl });
  const error = wecomError(result);
  if (error) throw new Error(error);
  return result;
}

/**
 * A cached access_token. WeCom tokens live ~2 hours and are rate limited, so they are
 * reused; `safetyMs` refreshes a little early.
 */
export function createTokenCache({ now = () => Date.now(), safetyMs = 60000 } = {}) {
  let cached;
  return {
    get() {
      if (cached && cached.expiresAt - safetyMs > now()) return cached.token;
      return undefined;
    },
    set(token, expiresInSec) {
      const seconds = Number(expiresInSec) > 0 ? Number(expiresInSec) : 7200;
      cached = { token: String(token), expiresAt: now() + seconds * 1000 };
    },
    clear() {
      cached = undefined;
    },
  };
}

/** Exchange corpid/corpsecret for an access_token. */
export async function getToken({ corpId, corpSecret, timeoutMs, signal, fetchImpl = fetch } = {}) {
  const id = String(corpId ?? "").trim();
  const secret = String(corpSecret ?? "").trim();
  if (!id || !secret) throw new Error("corpId and corpSecret are required");
  const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(id)}&corpsecret=${encodeURIComponent(secret)}`;
  const response = await fetchImpl(url, {
    signal: signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WeCom answered ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  const error = wecomError(result);
  if (error) throw new Error(error);
  if (!result.access_token) throw new Error("WeCom returned no access_token");
  return { token: result.access_token, expiresIn: result.expires_in };
}

/** Send an application message to users/departments/tags ("@all" for everyone). */
export async function sendAppMessage({ token, agentId, toUser, payload, timeoutMs, signal, fetchImpl } = {}) {
  if (!token) throw new Error("an access_token is required");
  const agent = Number(agentId);
  if (!Number.isFinite(agent)) throw new Error("agentId must be a number");
  const url = `${API_BASE}/message/send?access_token=${encodeURIComponent(token)}`;
  const body = { ...payload, agentid: agent, touser: String(toUser ?? "@all"), safe: 0 };
  const { result } = await postJson(url, body, { timeoutMs, signal, fetchImpl });
  const error = wecomError(result);
  if (error) throw new Error(error);
  return result;
}

/** Upload a local file so an application message can reference it. */
export async function uploadMedia({ token, filePath, type = "file", fileName, timeoutMs, signal, fetchImpl = fetch } = {}) {
  if (!token) throw new Error("an access_token is required");
  const bytes = await readFile(filePath);
  const name = fileName || String(filePath).split(/[\\/]/).pop() || "file";
  const form = new FormData();
  form.append("media", new Blob([bytes]), name);
  const url = `${API_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    body: form,
    signal: signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WeCom answered ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  const error = wecomError(result);
  if (error) throw new Error(error);
  if (!result.media_id) throw new Error("WeCom returned no media_id");
  return { mediaId: result.media_id, createdAt: result.created_at };
}

/** The kind of WeCom upload a local file needs, by extension. */
export function wecomUploadType(filePath) {
  const ext = String(filePath ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"].includes(ext)) return "video";
  if ([".amr", ".mp3", ".wav", ".silk"].includes(ext)) return "voice";
  return "file";
}

/** Mask a secret for logs and the card: keep the shape, hide the value. */
export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
