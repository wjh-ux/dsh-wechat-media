/**
 * ilink.js — WeChat (Weixin) "iLink" bot protocol as one dependency-free
 * Node.js >= 22 ESM module (global fetch; only `node:*` imports).
 *
 * PORT / ATTRIBUTION (MIT) — THIS NOTICE MUST BE PRESERVED
 * -------------------------------------------------------
 * JavaScript rewrite of the iLink protocol implemented by the MIT-licensed
 * Tencent package `@tencent-weixin/openclaw-weixin` v2.4.10 (author "Tencent";
 * src/api/api.ts, src/api/types.ts, src/auth/login-qr.ts, src/cdn/*.ts,
 * src/messaging/send.ts, src/messaging/inbound.ts, src/media/media-download.ts,
 * src/monitor/monitor.ts) plus the text-only reference `dsh-wechat-clawbot`
 * v0.3.1 (wechat-gateway/gateway.mjs, MIT). Any copy or derived distribution
 * MUST keep this notice and the upstream MIT license text.
 * Upstream: https://github.com/Tencent/openclaw-weixin
 *
 * ENDPOINTS IMPLEMENTED
 *   POST {api}/ilink/bot/get_bot_qrcode?bot_type=3                    requestQrCode
 *   GET  {api}/ilink/bot/get_qrcode_status?qrcode=..[&verify_code=]   pollQrStatus / submitVerifyCode
 *   POST {api}/ilink/bot/msg/notifystart | msg/notifystop             startNotify / stopNotify
 *   POST {api}/ilink/bot/getupdates                                   getUpdates (long poll)
 *   POST {api}/ilink/bot/getuploadurl                                 inside send{Image,Video,File}
 *   POST {api}/ilink/bot/sendmessage                                  sendText/Image/Video/File
 *   POST {cdn}/upload?encrypted_query_param=..&filekey=..             CDN upload (or upload_full_url)
 *   GET  {cdn}/download?encrypted_query_param=..                      downloadMedia
 * Not ported (no function was requested): POST getconfig (typing_ticket) and
 * POST sendtyping (status 1 = typing, 2 = cancel).
 *
 * RETURN / ERROR CODES FOUND IN THE SOURCES
 *   ret = 0            success (a missing field also counts as success).
 *   ret/errcode -14    STALE BOT TOKEN (upstream 2.4.5 renamed "session expired"
 *                      -> "stale token"); NOT transient. Official recovery:
 *                      pause every request of that account for one hour
 *                      (src/api/session-guard.ts); the JS-only gateway instead
 *                      treats it as logged out and asks for a new QR scan.
 *                      Never keep polling without a delay after -14.
 *   ret = -2           (a) JS gateway/window.mjs: errmsg "prepare failed" =
 *                      conversation window CLOSED (sendmessage needs a fresh
 *                      context_token from a recent inbound message);
 *                      (b) community jesse/types.ts: frequency-limit code, and
 *                      -2 with errmsg exactly "unknown error" = stale session.
 *   ret = -3           community: invalid arguments — parameter validation was
 *                      reached, so the window is OPEN and the request was wrong.
 *   ret = 1            on get_qrcode_status means "still waiting" (community
 *                      biboyang/ilink.ts tolerates it); handled as waiting_qrcode.
 *   HTTP non-2xx       wrappers throw an Error with .status and a truncated
 *                      body. HTTP 200 alone is NOT success: the JSON must parse
 *                      and ret/errcode must be 0 or absent.
 *   CDN upload         200 + non-empty `x-encrypted-param` = success; 4xx aborts
 *                      immediately (`x-error-message`); other failures retry up
 *                      to 3 attempts total.
 *
 * NOT DETERMINABLE FROM THE SOURCES (also flagged inline)
 *  1. `qrcode_img_content` is a URL/text to encode as a QR code, not a PNG. No
 *     dependency-free QR encoder is bundled, so `qrImageDataUrl` stays undefined
 *     unless the caller injects `renderQrDataUrl` (upstream: qrcode-terminal).
 *  2. `chatId` in describeInbound: upstream forces the direct-chat model and
 *     never reads session_id/group_id, so that fallback chain is a guess.
 *  3. Whether the CDN upload/download endpoints need an auth header. Upstream
 *     sends none (encrypted_query_param is the credential); kept.
 *  4. Whether outbound `media.aes_key` must be base64(hex string) rather than
 *     base64(raw 16 bytes): upstream senders use base64(hex) and its decoder
 *     accepts both, so senders mirror upstream and the decoder stays lenient.
 *  5. Thumbnails: upstream always sends no_need_thumb:true, never uploads a thumb
 *     and sends no dimensions/duration; mirrored here.
 *  6. Voice: upstream transcodes SILK -> WAV with a non-portable wasm helper, so
 *     downloadMedia saves raw `.silk`; `voice_item.text` is surfaced instead.
 *  7. Exact semantics of `encrypt_type` (types: 0 = only the fileid encrypted,
 *     1 = thumbnail/mid-image info packed); upstream always sends 1.
 *  8. Valid `bot_type` values (only "3" is used upstream) and the precise
 *     server-side meaning of `binded_redirect`.
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants and protocol identity
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'; // QR-login entry point
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'; // media CDN
export const ILINK_APP_ID = 'bot'; // iLink-App-Id (package.json ilink_appid upstream)
export const CHANNEL_VERSION = '2.4.10'; // base_info.channel_version
export const DEFAULT_BOT_AGENT = 'OpenClaw'; // fallback bot_agent
export const BOT_AGENT_MAX_LEN = 256; // byte cap for the sanitized bot_agent
export const DEFAULT_BOT_TYPE = '3'; // bot_type of the official QR login
export const STALE_TOKEN_ERRCODE = -14; // bot token stale -> re-login required
/** Upstream defaults (ms): api = send/getuploadurl, config = typing/notify. */
export const DEFAULT_TIMEOUTS = { api: 15_000, config: 10_000, longPoll: 35_000, qr: 35_000 };

/**
 * `iLink-App-ClientVersion`: 0x00MMNNPP = (major<<16)|(minor<<8)|patch, sent as
 * a DECIMAL string ("2.4.10" -> 132106). The JS-only gateway sent "0x00010000",
 * which the server also tolerates, but upstream is authoritative.
 */
export function buildClientVersion(version) {
  const [a, b, c] = String(version).split('.').map((p) => Number.parseInt(p, 10));
  return (((Number.isFinite(a) ? a : 0) & 0xff) << 16)
    | (((Number.isFinite(b) ? b : 0) & 0xff) << 8)
    | ((Number.isFinite(c) ? c : 0) & 0xff);
}

/** Mutable per-process protocol identity, so a host plugin can brand itself. */
export const protocolConfig = {
  appId: ILINK_APP_ID,
  clientVersion: buildClientVersion(CHANNEL_VERSION),
  channelVersion: CHANNEL_VERSION,
  botAgent: DEFAULT_BOT_AGENT,
  routeTag: '', // optional SKRouteTag header for routed deployments
  cdnBaseUrl: CDN_BASE_URL,
};

/** Override protocol identity; `botAgent` is sanitized exactly like upstream. */
export function configureProtocol(options = {}) {
  const { appId, clientVersion, channelVersion, botAgent, routeTag, cdnBaseUrl } = options;
  if (appId !== undefined) protocolConfig.appId = String(appId);
  if (channelVersion !== undefined) protocolConfig.channelVersion = String(channelVersion);
  if (clientVersion !== undefined) protocolConfig.clientVersion = Number(clientVersion) || 0;
  else if (channelVersion !== undefined) protocolConfig.clientVersion = buildClientVersion(channelVersion);
  if (botAgent !== undefined) protocolConfig.botAgent = sanitizeBotAgent(botAgent);
  if (routeTag !== undefined) protocolConfig.routeTag = String(routeTag || '');
  if (cdnBaseUrl !== undefined) protocolConfig.cdnBaseUrl = String(cdnBaseUrl);
  return { ...protocolConfig };
}

/**
 * Sanitize a configured bot_agent into the UA-style `product *( SP product )`
 * string, `product = name "/" version [ SP "(" comment ")" ]`. Invalid tokens are
 * dropped (no partial tokens); empty/oversized input falls back to "OpenClaw".
 * Port of upstream sanitizeBotAgent.
 */
export function sanitizeBotAgent(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT;
  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;
  const tokens = String(raw).trim().split(/\s+/).filter(Boolean);
  const accepted = [];
  let pending = null;
  for (let i = 0; i < tokens.length; i += 1) {
    let tok = tokens[i];
    while (tok.startsWith('(') && !tok.endsWith(')') && i + 1 < tokens.length) {
      tok += ` ${tokens[(i += 1)]}`; // glue a multi-word comment
    }
    if (tok.startsWith('(') && tok.endsWith(')')) {
      const inner = tok.slice(1, -1);
      if (pending && commentRe.test(inner)) { // comment belongs to the pending product
        accepted.push(`${pending} (${inner})`);
        pending = null;
        continue;
      }
    } else if (productRe.test(tok)) {
      if (pending) accepted.push(pending);
      pending = tok;
      continue;
    }
    if (pending) { accepted.push(pending); pending = null; } // orphan/invalid token
  }
  if (pending) accepted.push(pending);
  if (accepted.length === 0) return DEFAULT_BOT_AGENT;
  const joined = accepted.join(' ');
  if (Buffer.byteLength(joined, 'utf8') <= BOT_AGENT_MAX_LEN) return joined;
  let len = 0;
  const kept = [];
  for (const t of accepted) {
    const add = (kept.length === 0 ? 0 : 1) + Buffer.byteLength(t, 'utf8');
    if (len + add > BOT_AGENT_MAX_LEN) break; // drop trailing tokens until under the cap
    kept.push(t);
    len += add;
  }
  return kept.length > 0 ? kept.join(' ') : DEFAULT_BOT_AGENT;
}

/** `base_info` attached to every authenticated POST body. */
export function buildBaseInfo() {
  return { channel_version: protocolConfig.channelVersion, bot_agent: protocolConfig.botAgent };
}

/** `X-WECHAT-UIN`: random uint32 -> decimal string -> base64 (anti-replay nonce). */
export function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

/**
 * Request headers. `json:true` adds the JSON POST headers (Content-Type,
 * AuthorizationType, X-WECHAT-UIN); `json:false` sends only the application
 * headers, which is what the official QR status GET does. Bearer Authorization is
 * added whenever a token is given; the QR POST omits it (no token yet).
 */
export function buildHeaders({ token, json = true } = {}) {
  const headers = {};
  if (json) {
    headers['Content-Type'] = 'application/json';
    headers.AuthorizationType = 'ilink_bot_token';
    headers['X-WECHAT-UIN'] = randomWechatUin();
  }
  headers['iLink-App-Id'] = protocolConfig.appId;
  headers['iLink-App-ClientVersion'] = String(protocolConfig.clientVersion);
  if (protocolConfig.routeTag) headers.SKRouteTag = protocolConfig.routeTag;
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Enums (proto values used by the JSON API)
// ---------------------------------------------------------------------------

/** `MessageItem.type` — what one entry of `item_list` carries. */
export const messageItemTypes = Object.freeze({
  NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5, TOOL_CALL_START: 11, TOOL_CALL_RESULT: 12,
});
export const messageTypes = Object.freeze({ NONE: 0, USER: 1, BOT: 2 }); // message_type
export const messageStates = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 }); // message_state
export const uploadMediaTypes = Object.freeze({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }); // media_type
export const typingStatus = Object.freeze({ TYPING: 1, CANCEL: 2 }); // sendtyping.status (not ported)
/** Normalized QR statuses returned by pollQrStatus. */
export const qrStatuses = Object.freeze({
  WAITING: 'waiting_qrcode', SCANED: 'scaned', REDIRECT: 'scaned_but_redirect',
  NEED_VERIFYCODE: 'need_verifycode', VERIFY_BLOCKED: 'verify_code_blocked',
  BINDED: 'binded_redirect', EXPIRED: 'expired', CONFIRMED: 'confirmed', UNKNOWN: 'unknown',
});

/** True for IMAGE/VIDEO/FILE/VOICE items. */
export function isMediaItem(item) {
  const t = item?.type;
  return t === messageItemTypes.IMAGE || t === messageItemTypes.VIDEO
    || t === messageItemTypes.FILE || t === messageItemTypes.VOICE;
}

/** Body placeholder used when an item carries no text (upstream wording). */
export function getMediaLabel(type) {
  return type === messageItemTypes.IMAGE ? '[图片]' : type === messageItemTypes.VIDEO ? '[视频]'
    : type === messageItemTypes.FILE ? '[文件]' : type === messageItemTypes.VOICE ? '[语音]' : '';
}

// ---------------------------------------------------------------------------
// JSON + transport
// ---------------------------------------------------------------------------

/** uint64 id fields must be quoted before JSON.parse or they are rounded. */
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/**
 * Quote uint64 identifiers before parsing (upstream parseWeixinApiJson). Only
 * real object properties are rewritten, never text inside strings.
 */
export function parseWeixinJson(rawText) {
  const src = String(rawText);
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '"') { out += src[i++]; continue; }
    const start = i++;
    let esc = false;
    while (i < src.length) {
      const c = src[i++];
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') break;
    }
    const token = src.slice(start, i);
    out += token;
    let j = i;
    while (/\s/.test(src[j] ?? '')) j += 1;
    if (src[j] !== ':') continue;
    let key;
    try { key = JSON.parse(token); } catch { continue; }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;
    out += src.slice(i, j + 1);
    j += 1;
    while (/\s/.test(src[j] ?? '')) out += src[j++];
    const numStart = j;
    if (src[j] === '-') j += 1;
    while (/\d/.test(src[j] ?? '')) j += 1;
    if (j > numStart && !(j === numStart + 1 && src[numStart] === '-')) { out += `"${src.slice(numStart, j)}"`; i = j; }
    else i = numStart;
  }
  return JSON.parse(out);
}

/** Combine an internal timeout with an external abort signal. */
function linkSignals({ timeoutMs, signal } = {}) {
  let controller;
  let timer;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  }
  const onAbort = () => controller?.abort();
  if (signal && controller) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller ? controller.signal : signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (signal && controller) signal.removeEventListener('abort', onAbort);
    },
  };
}

/** One HTTP call returning raw text; throws an Error (with .status) on non-2xx. */
async function fetchText({ url, method, headers, body, timeoutMs, signal, label }) {
  const link = linkSignals({ timeoutMs, signal });
  try {
    const res = await fetch(url, {
      method, headers,
      ...(body !== undefined ? { body } : {}),
      ...(link.signal ? { signal: link.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return text;
  } finally {
    link.cleanup();
  }
}

const toBase = (baseUrl) => (baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
const resolveUrl = (baseUrl, endpoint) => new URL(endpoint, toBase(baseUrl)).toString();

/** JSON POST; callers add base_info themselves where the protocol needs it. */
function apiPost({ baseUrl, endpoint, body, token, timeoutMs, signal, label }) {
  return fetchText({
    url: resolveUrl(baseUrl, endpoint), method: 'POST',
    headers: buildHeaders({ token, json: true }),
    body: JSON.stringify(body), timeoutMs, signal, label,
  });
}

/** Application-header-only GET (QR status polling). */
function apiGet({ baseUrl, endpoint, timeoutMs, signal, label }) {
  return fetchText({
    url: resolveUrl(baseUrl, endpoint), method: 'GET',
    headers: buildHeaders({ json: false }), timeoutMs, signal, label,
  });
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

const QR_STATUS_MAP = {
  wait: qrStatuses.WAITING,
  waiting_qrcode: qrStatuses.WAITING, // the JS-only gateway's local phase name
  scaned: qrStatuses.SCANED,
  scaned_but_redirect: qrStatuses.REDIRECT,
  need_verifycode: qrStatuses.NEED_VERIFYCODE,
  verify_code_blocked: qrStatuses.VERIFY_BLOCKED,
  binded_redirect: qrStatuses.BINDED,
  expired: qrStatuses.EXPIRED,
  confirmed: qrStatuses.CONFIRMED,
};

/**
 * POST ilink/bot/get_bot_qrcode?bot_type=<botType>
 * Body `{ local_token_list }` = up to 10 locally stored bot tokens so the server
 * can recognise an already-bound client; no Authorization, no base_info.
 * Returns `{ qrcode, qrImageDataUrl?, qrContent?, redirectHost?, raw }`; `qrcode`
 * is the opaque key to poll with and `qrContent` (qrcode_img_content) is the
 * URL/text to render as an image (unknown #1: inject `renderQrDataUrl` for that).
 */
export async function requestQrCode({
  baseUrl = DEFAULT_BASE_URL, botType = DEFAULT_BOT_TYPE, localTokenList = [],
  renderQrDataUrl, timeoutMs = DEFAULT_TIMEOUTS.api, signal,
} = {}) {
  const text = await apiPost({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: Array.isArray(localTokenList) ? localTokenList.slice(0, 10) : [] },
    timeoutMs, signal, label: 'requestQrCode',
  });
  const raw = JSON.parse(text);
  const qrContent = raw.qrcode_img_content;
  let qrImageDataUrl;
  if (typeof renderQrDataUrl === 'function' && qrContent) {
    try { qrImageDataUrl = await renderQrDataUrl(qrContent); } catch { qrImageDataUrl = undefined; }
  }
  return { qrcode: raw.qrcode, qrImageDataUrl, qrContent, redirectHost: raw.redirect_host ?? undefined, raw };
}

/**
 * GET ilink/bot/get_qrcode_status?qrcode=<qrcode>[&verify_code=<code>] — long
 * poll (~35 s). Server statuses: wait | scaned | confirmed | expired |
 * need_verifycode | verify_code_blocked | scaned_but_redirect | binded_redirect.
 * `wait` and a bare `ret:1` become `waiting_qrcode`; `serverStatus` keeps the raw
 * string. Timeouts/network errors degrade to "still waiting" (upstream), so the
 * caller polls again. scaned_but_redirect -> keep polling `https://<redirectHost>`;
 * confirmed -> use the returned `baseUrl` for all later calls; expired or
 * verify_code_blocked -> get a fresh QR (3 tries upstream); binded_redirect means
 * already bound and is not a failure.
 */
export async function pollQrStatus({ baseUrl = DEFAULT_BASE_URL, qrcode, verifyCode, timeoutMs = DEFAULT_TIMEOUTS.qr, signal } = {}) {
  if (!qrcode) throw new Error('pollQrStatus: qrcode is required');
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  // The verify code is NOT a separate CGI: it rides this same status poll, and
  // upstream keeps sending the pending code until the server answers "scaned".
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;

  let raw;
  try {
    raw = JSON.parse(await apiGet({ baseUrl, endpoint, timeoutMs, signal, label: 'pollQrStatus' }));
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: qrStatuses.WAITING, serverStatus: 'wait', ret: undefined, raw: null, error: String(err) };
  }
  const serverStatus = typeof raw.status === 'string' ? raw.status : '';
  let status = QR_STATUS_MAP[serverStatus] ?? qrStatuses.UNKNOWN;
  if (!serverStatus && raw.ret === 1) status = qrStatuses.WAITING;
  return {
    status,
    serverStatus,
    token: raw.bot_token ?? undefined,            // only with `confirmed`
    botId: raw.ilink_bot_id ?? undefined,         // only with `confirmed`
    wxid: raw.ilink_user_id ?? undefined,         // the user who scanned
    baseUrl: raw.baseurl ?? undefined,            // API host for all later calls
    redirectHost: raw.redirect_host ?? undefined, // scaned_but_redirect target
    ret: raw.ret,
    retcode: raw.errcode,
    errmsg: raw.errmsg,
    raw,
  };
}

/**
 * Submit the numeric verification code WeChat shows after scanning. The login
 * flow DOES have a verification-code step, but it has no CGI of its own: the
 * server answers `need_verifycode` from the status poll and the code goes back as
 * the `verify_code` query parameter of that same request (upstream keeps it in
 * `pendingVerifyCode` and re-sends it on every following poll). Callers that
 * track a pending code can just pass it to pollQrStatus.
 */
export function submitVerifyCode({ baseUrl = DEFAULT_BASE_URL, qrcode, verifyCode, timeoutMs = DEFAULT_TIMEOUTS.qr, signal } = {}) {
  if (!verifyCode) throw new Error('submitVerifyCode: verifyCode is required');
  return pollQrStatus({ baseUrl, qrcode, verifyCode, timeoutMs, signal });
}

// ---------------------------------------------------------------------------
// Lifecycle notifications
// ---------------------------------------------------------------------------

/** notifystart / notifystop share one body: base_info only. */
async function notify(endpoint, label, { baseUrl, token, timeoutMs = DEFAULT_TIMEOUTS.config, signal } = {}) {
  const raw = JSON.parse(await apiPost({ baseUrl, endpoint, body: { base_info: buildBaseInfo() }, token, timeoutMs, signal, label }));
  // Upstream only warns on a non-zero ret (best effort); the code is returned so
  // the caller can log it without blocking start/stop.
  return { ret: raw?.ret ?? 0, errmsg: raw?.errmsg, raw };
}

/** POST ilink/bot/msg/notifystart — the client is coming online. */
export function startNotify(options = {}) {
  return notify('ilink/bot/msg/notifystart', 'startNotify', options);
}

/**
 * POST ilink/bot/msg/notifystop — the client is going away. Use its own short
 * timeout and do NOT pass the monitor's abort signal, so it still runs after the
 * long poll was cancelled.
 */
export function stopNotify(options = {}) {
  return notify('ilink/bot/msg/notifystop', 'stopNotify', options);
}

// ---------------------------------------------------------------------------
// Long-poll receive
// ---------------------------------------------------------------------------

/**
 * POST ilink/bot/getupdates — long poll for inbound messages. `cursor` is the
 * previous response's `get_updates_buf` ("" on the first call or after a reset);
 * the server may hold the request until `timeoutMs` (default 35 s) and can
 * suggest the next value via `longpolling_timeout_ms`. Returns
 * `{ cursor, messages, ret, errcode, errmsg }`; a client timeout or an aborted
 * poll is normal control flow and yields `{ ret: 0, messages: [] }` so the caller
 * can poll again. -14 in `ret`/`errcode` = stale token: stop and re-login
 * (upstream pauses the account for an hour instead of retrying). Other non-zero
 * codes: retry with backoff (upstream 2 s, then 30 s after 3 failures).
 */
export async function getUpdates({ baseUrl, token, cursor = '', timeoutMs = DEFAULT_TIMEOUTS.longPoll, signal } = {}) {
  let raw;
  try {
    const text = await apiPost({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: { get_updates_buf: cursor ?? '', base_info: buildBaseInfo() },
      token, timeoutMs, signal, label: 'getUpdates',
    });
    raw = parseWeixinJson(text);
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted || /timeout/i.test(String(err?.message ?? ''))) {
      return { cursor: cursor ?? '', messages: [], ret: 0, errcode: 0, errmsg: '', timedOut: true };
    }
    throw err;
  }
  return {
    cursor: raw.get_updates_buf ?? cursor ?? '',
    messages: Array.isArray(raw.msgs) ? raw.msgs : [],
    ret: raw.ret,
    errcode: raw.errcode,
    errmsg: raw.errmsg,
    longPollingTimeoutMs: raw.longpolling_timeout_ms,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Media crypto + CDN URLs
// ---------------------------------------------------------------------------

/** Ciphertext size of AES-128-ECB/PKCS#7: ceil((n+1)/16)*16. */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * `CDNMedia.aes_key` travels base64-encoded in two shapes seen in the wild:
 * base64(raw 16 bytes) and base64(32-char hex string of the same key). Both must
 * be accepted (upstream parseAesKey); anything else is an error.
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`unexpected aes_key (${decoded.length} decoded bytes)`);
}

/** `{cdn}/upload?...` fallback used only when getuploadurl omits upload_full_url. */
export function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/** `{cdn}/download?...` fallback used only when a media ref omits full_url. */
export function buildCdnDownloadUrl(cdnBaseUrl, encryptedQueryParam) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

// ---------------------------------------------------------------------------
// Outbound: upload + send
// ---------------------------------------------------------------------------

/** Client-generated message id, usable as the local message id. */
export function generateClientId(prefix = 'dsh-wechat') {
  return `${prefix}:${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * POST ilink/bot/sendmessage. A non-zero `ret` throws an Error carrying `.ret`,
 * `.errcode` and `.errmsg`: HTTP 200 alone does not prove delivery.
 */
async function sendMessageRequest({ baseUrl, token, msg, timeoutMs = DEFAULT_TIMEOUTS.api, signal }) {
  const raw = parseWeixinJson(await apiPost({
    baseUrl, endpoint: 'ilink/bot/sendmessage',
    body: { msg, base_info: buildBaseInfo() },
    token, timeoutMs, signal, label: 'sendMessage',
  }));
  if (raw?.ret !== undefined && raw.ret !== 0) {
    const err = new Error(`sendMessage ret=${raw.ret} errmsg=${raw.errmsg ?? '(none)'}`);
    err.ret = raw.ret;
    err.errcode = raw.errcode;
    err.errmsg = raw.errmsg;
    throw err;
  }
  return raw;
}

/**
 * Envelope of every outbound send: empty `from_user_id` (bot send),
 * `message_type: 2` = BOT, `message_state: 2` = FINISH, one item per request.
 * `context_token` comes from an inbound message and is required in practice:
 * without a fresh token the platform answers ret=-2 "prepare failed" because the
 * conversation window is closed.
 */
function buildEnvelope({ toWxid, items, contextToken, runId, clientId }) {
  const msg = {
    from_user_id: '',
    to_user_id: toWxid,
    client_id: clientId ?? generateClientId(),
    message_type: messageTypes.BOT,
    message_state: messageStates.FINISH,
    item_list: items,
  };
  if (contextToken) msg.context_token = contextToken;
  if (runId) msg.run_id = runId;
  return msg;
}

/** Send one plain text message. Returns `{ messageId, serverMessageId?, ret, raw }`. */
export async function sendText({
  baseUrl, token, toWxid, text, contextToken, runId,
  timeoutMs = DEFAULT_TIMEOUTS.api, signal,
} = {}) {
  const clientId = generateClientId();
  const items = text ? [{ type: messageItemTypes.TEXT, text_item: { text } }] : [];
  const raw = await sendMessageRequest({
    baseUrl, token, timeoutMs, signal,
    msg: buildEnvelope({ toWxid, items, contextToken, runId, clientId }),
  });
  return { messageId: clientId, serverMessageId: raw?.message_id, ret: raw?.ret ?? 0, raw };
}

/**
 * Full media upload pipeline (upstream cdn/upload.ts + cdn/cdn-upload.ts):
 * read the file and its plaintext MD5 -> filesize = AES-128-ECB/PKCS#7 size,
 * random 16-byte filekey + aeskey -> POST getuploadurl (no_need_thumb:true, the
 * official code never uploads a thumbnail) -> AES-128-ECB encrypt -> POST the
 * ciphertext to `upload_full_url` (preferred) or the constructed CDN upload URL
 * with Content-Type: application/octet-stream -> read `x-encrypted-param` from
 * the response headers = the download credential. 4xx aborts immediately; any
 * other failure is retried up to 3 attempts.
 */
export async function uploadMedia({
  baseUrl, token, toWxid, filePath, mediaType,
  cdnBaseUrl = protocolConfig.cdnBaseUrl, timeoutMs = DEFAULT_TIMEOUTS.api, signal,
} = {}) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);
  const aeskeyHex = aeskey.toString('hex');

  const uploadUrlText = await apiPost({
    baseUrl, endpoint: 'ilink/bot/getuploadurl', token, timeoutMs, signal, label: 'getUploadUrl',
    body: {
      filekey, media_type: mediaType, to_user_id: toWxid,
      rawsize, rawfilemd5, filesize,
      no_need_thumb: true, // thumb_* fields stay omitted
      aeskey: aeskeyHex,   // hex in the request, base64 in the message item
      base_info: buildBaseInfo(),
    },
  });
  const uploadResp = JSON.parse(uploadUrlText);
  const uploadFullUrl = typeof uploadResp.upload_full_url === 'string' ? uploadResp.upload_full_url.trim() : '';
  if (!uploadFullUrl && !uploadResp.upload_param) {
    throw new Error(`getUploadUrl returned no upload URL (need upload_full_url or upload_param): ${uploadUrlText.slice(0, 200)}`);
  }
  const cdnUrl = uploadFullUrl || buildCdnUploadUrl(cdnBaseUrl, uploadResp.upload_param, filekey);

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  let encryptQueryParam;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const link = linkSignals({ signal });
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        ...(link.signal ? { signal: link.signal } : {}),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN upload client error ${res.status}: ${res.headers.get('x-error-message') ?? (await res.text().catch(() => ''))}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN upload server error ${res.status}: ${res.headers.get('x-error-message') ?? ''}`);
      }
      encryptQueryParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!encryptQueryParam) throw new Error('CDN upload response missing x-encrypted-param header');
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (/client error/.test(String(err?.message ?? ''))) break; // 4xx: never retry
    } finally {
      link.cleanup();
    }
  }
  if (lastError) throw lastError;

  return {
    filekey, aeskeyHex, rawsize, ciphertextSize: filesize, rawfilemd5, encryptQueryParam,
    // Wire value for CDNMedia.aes_key: upstream base64-encodes the HEX string.
    aesKeyBase64: Buffer.from(aeskeyHex, 'utf8').toString('base64'),
  };
}

/** Send one uploaded item, optionally preceded by a text caption. */
async function sendUploadedMedia({ baseUrl, token, toWxid, item, caption, contextToken, runId, timeoutMs, signal, uploaded }) {
  // Upstream puts a caption in its own request, because every request carries
  // exactly one item in `item_list`.
  const captionResult = caption
    ? await sendText({ baseUrl, token, toWxid, text: caption, contextToken, runId, timeoutMs, signal })
    : undefined;
  const clientId = generateClientId();
  const raw = await sendMessageRequest({
    baseUrl, token, timeoutMs, signal,
    msg: buildEnvelope({ toWxid, items: [item], contextToken, runId, clientId }),
  });
  return {
    messageId: clientId, serverMessageId: raw?.message_id, ret: raw?.ret ?? 0,
    captionMessageId: captionResult?.messageId, uploaded, raw,
  };
}

/**
 * Shared CDNMedia block for image/video/file items. `encrypt_type: 1` = thumbnail
 * /mid-image info packed in (0 would encrypt only the fileid). `aes_key` is
 * base64 of the hex key, as upstream senders do (unknown #4).
 */
function cdnMedia(uploaded) {
  return { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 };
}

/**
 * Send a local image file. ImageItem = media + `mid_size` = CIPHERTEXT size
 * (upstream sets mid_size, not hd_size). The required
 * `{ baseUrl, token, toWxid, filePath, signal }` shape is extended with optional
 * text (caption)/contextToken/runId/cdnBaseUrl/timeoutMs.
 */
export async function sendImage({ baseUrl, token, toWxid, filePath, text, contextToken, runId, cdnBaseUrl, timeoutMs, signal } = {}) {
  const uploaded = await uploadMedia({ baseUrl, token, toWxid, filePath, mediaType: uploadMediaTypes.IMAGE, cdnBaseUrl, timeoutMs, signal });
  const item = { type: messageItemTypes.IMAGE, image_item: { media: cdnMedia(uploaded), mid_size: uploaded.ciphertextSize } };
  return sendUploadedMedia({ baseUrl, token, toWxid, item, caption: text, contextToken, runId, timeoutMs, signal, uploaded });
}

/** Send a local video file. VideoItem = media + `video_size` = CIPHERTEXT size. */
export async function sendVideo({ baseUrl, token, toWxid, filePath, text, contextToken, runId, cdnBaseUrl, timeoutMs, signal } = {}) {
  const uploaded = await uploadMedia({ baseUrl, token, toWxid, filePath, mediaType: uploadMediaTypes.VIDEO, cdnBaseUrl, timeoutMs, signal });
  const item = { type: messageItemTypes.VIDEO, video_item: { media: cdnMedia(uploaded), video_size: uploaded.ciphertextSize } };
  return sendUploadedMedia({ baseUrl, token, toWxid, item, caption: text, contextToken, runId, timeoutMs, signal, uploaded });
}

/**
 * Send a local file attachment. FileItem = media + `file_name` (display name) +
 * `len` = PLAINTEXT byte count as a decimal STRING (not a number).
 */
export async function sendFile({ baseUrl, token, toWxid, filePath, fileName, text, contextToken, runId, cdnBaseUrl, timeoutMs, signal } = {}) {
  const uploaded = await uploadMedia({ baseUrl, token, toWxid, filePath, mediaType: uploadMediaTypes.FILE, cdnBaseUrl, timeoutMs, signal });
  const item = {
    type: messageItemTypes.FILE,
    file_item: { media: cdnMedia(uploaded), file_name: fileName || path.basename(filePath), len: String(uploaded.rawsize) },
  };
  return sendUploadedMedia({ baseUrl, token, toWxid, item, caption: text, contextToken, runId, timeoutMs, signal, uploaded });
}

// ---------------------------------------------------------------------------
// Inbound media download
// ---------------------------------------------------------------------------

/** Content-Type -> extension, used to name downloaded images/videos. */
const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/silk': '.silk', 'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt',
};

/**
 * Extract the CDN reference + AES key of an inbound media item. For images the
 * raw hex key in `image_item.aeskey` wins over the base64 `media.aes_key`
 * (upstream behaviour). Returns null when the item has no media.
 */
export function pickMediaRef(item) {
  const holder = item?.type === messageItemTypes.IMAGE ? item.image_item
    : item?.type === messageItemTypes.VOICE ? item.voice_item
      : item?.type === messageItemTypes.FILE ? item.file_item
        : item?.type === messageItemTypes.VIDEO ? item.video_item : undefined;
  const media = holder?.media;
  if (!media) return null;
  const rawKey = item.type === messageItemTypes.IMAGE ? item.image_item?.aeskey : undefined;
  return {
    media,
    aesKeyBase64: rawKey ? Buffer.from(String(rawKey), 'hex').toString('base64') : (media.aes_key || undefined),
    fullUrl: typeof media.full_url === 'string' && media.full_url ? media.full_url : undefined,
    encryptedQueryParam: media.encrypt_query_param || undefined,
    fileName: item.file_item?.file_name,
  };
}

/**
 * Download (and, when a key exists, decrypt) the media of one inbound
 * MessageItem into `destDir`; returns the ABSOLUTE local path. Upstream flow:
 * prefer `media.full_url`, else build `{cdn}/download?encrypted_query_param=..`;
 * GET the bytes; decrypt AES-128-ECB/PKCS#7 with the parsed key. Upstream skips
 * VOICE/FILE/VIDEO items without `media.aes_key`; here those throw instead of
 * saving ciphertext, while a keyless image is still saved as-is (upstream also
 * allows a plain image download). VOICE is saved raw as `.silk` (unknown #6).
 * `baseUrl`/`token` are accepted for call-site symmetry but unused: the CDN needs
 * no auth header in the reference implementations (unknown #3).
 */
export async function downloadMedia({
  baseUrl: _baseUrl, token: _token, item, destDir,
  cdnBaseUrl = protocolConfig.cdnBaseUrl, fileName, timeoutMs = DEFAULT_TIMEOUTS.api, signal,
} = {}) {
  if (!destDir) throw new Error('downloadMedia: destDir is required');
  const ref = pickMediaRef(item);
  if (!ref) throw new Error(`downloadMedia: item type ${item?.type} has no media reference`);
  const url = ref.fullUrl
    || (ref.encryptedQueryParam ? buildCdnDownloadUrl(cdnBaseUrl, ref.encryptedQueryParam) : undefined);
  if (!url) throw new Error('downloadMedia: media has neither full_url nor encrypt_query_param');
  if (!ref.aesKeyBase64 && item.type !== messageItemTypes.IMAGE) {
    throw new Error(`downloadMedia: item type ${item.type} has no aes_key; refusing to save ciphertext`);
  }

  const link = linkSignals({ timeoutMs, signal });
  let bytes;
  let contentType = '';
  try {
    const res = await fetch(url, { method: 'GET', ...(link.signal ? { signal: link.signal } : {}) });
    if (!res.ok) throw new Error(`downloadMedia: CDN HTTP ${res.status} ${res.statusText}`);
    contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    bytes = Buffer.from(await res.arrayBuffer());
  } finally {
    link.cleanup();
  }
  if (ref.aesKeyBase64) bytes = decryptAesEcb(bytes, parseAesKey(ref.aesKeyBase64));

  const original = fileName || ref.fileName;
  const safeName = original ? path.basename(String(original)).replace(/[\\/:*?"<>|]+/g, '_') : '';
  const ext = path.extname(safeName)
    || (item.type === messageItemTypes.VIDEO ? '.mp4'
      : item.type === messageItemTypes.VOICE ? '.silk'
        : (MIME_TO_EXT[contentType] ?? '.bin'));
  const kindName = item.type === messageItemTypes.IMAGE ? 'image'
    : item.type === messageItemTypes.VIDEO ? 'video'
      : item.type === messageItemTypes.VOICE ? 'voice' : 'file';
  const name = item.type === messageItemTypes.FILE && safeName
    ? safeName
    : `weixin-${kindName}-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;

  await fs.mkdir(destDir, { recursive: true });
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, bytes);
  return path.resolve(filePath);
}

// ---------------------------------------------------------------------------
// Inbound normalization
// ---------------------------------------------------------------------------

/** Provider id: top-level `message_id`, else the first item `msg_id`. */
export function getMessageId(message) {
  if (message?.message_id !== undefined && String(message.message_id).trim()) return String(message.message_id).trim();
  for (const item of message?.item_list ?? []) {
    if (item?.msg_id !== undefined && String(item.msg_id).trim()) return String(item.msg_id).trim();
  }
  return undefined;
}

/**
 * Normalize an inbound WeixinMessage into `{ kind, fromWxid, chatId, messageId,
 * text, media, contextToken, createTimeMs, raw }`. `text` follows upstream
 * bodyFromItemList: first TEXT item wins, else a VOICE item's speech-to-text
 * `text`, else the media placeholder label. `kind` (text|image|video|file|voice|
 * tool_call|unknown) is the primary content, and `media` lists every media item
 * as `{ type, item }`, ready for downloadMedia. `chatId` is a guess (unknown #2):
 * upstream treats every chat as `direct` (To = from_user_id) and never reads
 * session_id/group_id, so the peer id comes first and rooms are only fallbacks.
 */
export function describeInbound(message = {}) {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const fromWxid = message.from_user_id ?? '';
  const chatId = message.session_id || message.room_id || message.chat_room_id || message.group_id || fromWxid;
  const media = items.filter(isMediaItem).map((i) => ({ type: i.type, item: i }));
  const textItem = items.find((i) => i?.type === messageItemTypes.TEXT && i.text_item?.text != null);
  const voiceText = items.find((i) => i?.type === messageItemTypes.VOICE && i.voice_item?.text);
  const toolCall = items.find((i) => i?.type === messageItemTypes.TOOL_CALL_START || i?.type === messageItemTypes.TOOL_CALL_RESULT);

  let kind = 'unknown';
  let text = '';
  if (textItem) {
    kind = 'text';
    text = String(textItem.text_item.text);
  } else if (voiceText) {
    kind = 'voice'; // transcript of a voice message
    text = String(voiceText.voice_item.text);
  } else if (media.length) {
    // Upstream priority when several media types coexist: image > video > file > voice.
    const order = [messageItemTypes.IMAGE, messageItemTypes.VIDEO, messageItemTypes.FILE, messageItemTypes.VOICE];
    const primary = order.map((t) => media.find((m) => m.type === t)).find(Boolean) ?? media[0];
    kind = primary.type === messageItemTypes.IMAGE ? 'image'
      : primary.type === messageItemTypes.VIDEO ? 'video'
        : primary.type === messageItemTypes.FILE ? 'file' : 'voice';
    text = getMediaLabel(primary.type);
  } else if (toolCall) {
    kind = 'tool_call';
  }

  return {
    kind, fromWxid, chatId,
    messageId: getMessageId(message),
    text, media,
    contextToken: message.context_token,
    createTimeMs: message.create_time_ms,
    messageType: message.message_type,
    raw: message,
  };
}
