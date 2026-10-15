/**
 * dsh-wechat-media - host half.
 *
 * Owns the whole WeChat side of the bridge:
 *
 *   * every paired account's long-poll loop over `ilink/bot/getupdates`, with its
 *     cursor and context tokens persisted so a restart resumes instead of
 *     re-scanning;
 *   * one DSH conversation per WeChat chat (contact or group), created or resumed
 *     through `ctx.agents` and remembered in state.js;
 *   * inbound text and media: files are downloaded to `$DSH_HOME/wechat-inbox/…`
 *     and handed to the model as paths, so a text-only model plus a vision plugin
 *     can actually read them;
 *   * outbound: the assistant's reply for the turn is chunked back to WeChat, and
 *     the agent can push files itself through the registered tools;
 *   * the HTTP routes the browser card reads: account status, QR image, pair and
 *     unpair.
 *
 * Nothing here imports a harness package at module scope. A `link:`-installed
 * plugin cannot resolve `@deepseek-ai/*` from its own directory (that is what
 * broke an earlier plugin of mine), so optional harness modules are pulled in at
 * runtime through the Cordis loader, and every use is guarded.
 */
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
/**
 * The Windows folder picker, run by the host on the user's own desktop. The browser
 * cannot hand over an absolute path (a directory input only exposes relative names),
 * so the dialog is opened natively - which is also what "use the system picker"
 * means to a user.
 */
export const FOLDER_PICK_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
  // Without an owner the dialog frequently never appears (or appears behind the
  // app), so it is shown against a topmost form: that is the documented fix.
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$owner.WindowState = 'Minimized'",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'Choose where dsh-wechat-media saves WeChat files'",
  "$d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");

/**
 * Normalise what the picker printed: an absolute directory, or undefined when the
 * dialog was cancelled (or printed something unusable).
 */
export function parsePickedPath(stdout) {
  const text = String(stdout ?? "").trim();
  return text && isAbsolute(text) ? text : undefined;
}

/**
 * Open the system folder picker and return the chosen directory.
 * @returns {Promise<{ path?: string, error?: string }>}
 */
export function pickFolder({ timeoutMs = 300000 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", FOLDER_PICK_SCRIPT],
      // windowsHide can leave the process without a usable window, so the dialog is
      // shown normally; the console window is suppressed by the script instead.
      { windowsHide: false, timeout: timeoutMs },
      (error, stdout) => {
        const elapsedMs = Date.now() - startedAt;
        const picked = parsePickedPath(stdout);
        if (picked) resolve({ path: picked, elapsedMs });
        else if (error) resolve({ error: error.message, elapsedMs });
        else resolve({ elapsedMs });
      },
    );
  });
}

import * as ilink from "./ilink.js";
import qrcode from "./vendor/qrcode-generator.mjs";
import { WechatLoginManager } from "./login.js";
import { describeForModel, prepareOutbound, resolveInboxDir, saveInboundMedia, inboxRoot } from "./media.js";
import { downloadWecomMedia } from "./wecom-media.js";
import { toPlainText } from "./plain-text.js";
import { silkToWav, synthesizeVoice, voiceDeliveryFor } from "./voice.js";
import { openSessionAgent } from "./session.js";
import { STOP_REASON, helpText, parseCommand, parseSwitch, parseWindowDays, statusText, unknownCommandText } from "./commands.js";
import { clampWindowDays, summarize, summaryLine, tokensReport, usageDisagreement } from "./tokens.js";
import * as wecom from "./wecom.js";
import { FeishuLongConnection } from "./feishu-ws.js";
import {
  feishuDomain,
  feishuFileType,
  feishuMediaContent,
  feishuPostContent,
  feishuReplyMessage,
  feishuSendMessage,
  feishuTenantToken,
  feishuTextContent,
  feishuUploadFile,
  feishuUploadImage,
  feishuWebhookSend,
  feishuDownloadResource,
  feishuCreateDoc,
  feishuDocRef,
  feishuReadDoc,
  feishuWikiResolve,
  feishuSheetCreate,
  feishuSheetRead,
  feishuSheetWrite,
  feishuBitableCreate,
  feishuBitableRead,
  feishuBitableTables,
  feishuBitableWrite,
  feishuAppendText,
} from "./feishu.js";
// The long-connection reply helpers come from wecom-bot.js, NOT from wecom.js: calling
// them as `streamBody(...)` (as this file did) throws
// `TypeError: wecom.streamBody is not a function` inside the reply's try/catch, so every
// WeCom answer was swallowed and the bot simply never replied. test/wiring.test.mjs now
// cross-checks every `namespace.name(...)` call against the module it came from.
import { WecomBot, describeBotMessage, generateReqId, markdownBody, splitForStream, streamBody } from "./wecom-bot.js";
import { normalizeAccountId, WechatState, defaultStateRoot } from "./state.js";

/** Long-poll budget the platform advertises; used until it tells us otherwise. */
const DEFAULT_POLL_MS = 35_000;
/** WeChat shows roughly this much text per message. */
const MAX_TEXT_CHARS = 2000;
/** Delay between chunks so the platform does not treat it as a flood. */
const CHUNK_DELAY_MS = 400;
/** How long an inbound message waits for its assistant turn to finish. */
const REPLY_TIMEOUT_MS = 300_000;
/** Backoff after a failed poll, and after three consecutive failures. */
const BACKOFF_MS = 2_000;
const BACKOFF_AFTER_FAILURES_MS = 30_000;
/** Keep this many processed message ids to drop redeliveries. */
const DEDUP_LIMIT = 500;
/**
 * Tools that put a message in front of the human themselves. When one of them
 * runs during a turn, the automatic reply relay must stand down, or the model
 * would answer twice (once through the tool, once through the relay).
 */
const DELIVERY_TOOLS = new Set(["wechat_send_text", "wechat_send_file", "wechat_send_voice", "wecom_send_text", "wecom_send_file", "wecom_send_voice", "feishu_send_text", "feishu_send_file"]);

export const name = "dsh-wechat-media";
/** `agents` drives sessions; tools and the web server are optional per profile. */
export const inject = ["agents"];

/** Lazily import a harness package through the Cordis loader (see file header). */
async function importHarnessPlugin(ctx, specifier) {
  const loader = ctx?.loader;
  if (loader?.internal && typeof loader.internal.import === "function") {
    const base = loader.baseUrl ?? ctx.baseUrl;
    if (base) return loader.internal.import(specifier, base, {});
  }
  return import(specifier);
}

/** Split a reply into platform-sized chunks, preferring paragraph boundaries. */export function chunkText(text, limit = MAX_TEXT_CHARS) {
  const source = String(text ?? "").trim();
  if (source.length <= limit) return source ? [source] : [];
  const chunks = [];
  let rest = source;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * Decide whether an inbound chat may reach the agent.
 *
 * `requireAllowlist: false` keeps the bridge open to anyone who writes to the bot
 * (the default, because a freshly paired account would otherwise look broken);
 * turning it on restricts traffic to chats the user marked as allowed.
 *
 * @returns {{ accepted: boolean, reason: "open" | "allowlisted" | "blocked" | "not-listed" }}
 */
export function allowDecision({ peer, prefs } = {}) {
  if (!prefs?.requireAllowlist) return { accepted: true, reason: "open" };
  if (peer?.allowed === true) return { accepted: true, reason: "allowlisted" };
  if (peer?.allowed === false) return { accepted: false, reason: "blocked" };
  return { accepted: false, reason: "not-listed" };
}

/**
 * Identify the chat an inbound message belongs to.
 *
 * Which envelope field addresses a chat matters for *sending* back: a direct
 * message carries the sender in `from_user_id`, while a group message may carry
 * the group in `group_id` or in `session_id`. The live diagnostic line in
 * `handleInbound` prints all of them so the platform can settle the question.
 *
 * @returns {{ chatId: string, groupId?: string, sessionChat?: string, isGroup: boolean, peerName: string }}
 */
export function describeEnvelope(message = {}) {
  const groupId = message?.group_id ? String(message.group_id) : undefined;
  const sessionChat = message?.session_id ? String(message.session_id) : undefined;
  const fromUserId = message?.from_user_id ? String(message.from_user_id) : undefined;
  const chatId = groupId || sessionChat || fromUserId || "";
  return {
    chatId,
    groupId,
    sessionChat,
    fromUserId,
    isGroup: Boolean(groupId) || /@chatroom$/.test(chatId),
    peerName: String(message?.from_user_name ?? message?.from_user_id ?? chatId),
  };
}

/**
 * The four authorization levels the card offers, and what each one means for the **approval
 * channel this plugin owns**.
 *
 * Honest scope: DSH's own session policy (the file sandbox: read-only / workspace-write /
 * danger-full-access, and whether approvals are asked at all) belongs to the DSH client and is
 * not a plugin setting. What a plugin *can* decide is what it does with an approval request it
 * receives: ask in the chat (and what "no answer" means), leave it to the GUI, or decline it.
 * `readonly` therefore fails closed for everything that *does* ask - it cannot stop an action
 * the session policy never asked about, and the card says so.
 */
export const AUTHORIZATION_LEVELS = ["strict", "moderate", "full", "readonly"];

export const AUTHORIZATION_LABELS = {
  strict: "严格",
  moderate: "适中",
  full: "完全权限",
  readonly: "仅查看",
};

/**
 * @param {string} level one of AUTHORIZATION_LEVELS (anything else means "moderate")
 * @returns {{ level: string, ask: boolean, onTimeout: "gui" | "decline", decline: boolean, label: string }}
 *   `ask` - put the question in the chat; `onTimeout` - what silence means when asking;
 *   `decline` - refuse requests outright without asking.
 */
export function approvalPolicyFor(level) {
  const wanted = AUTHORIZATION_LEVELS.includes(String(level)) ? String(level) : "moderate";
  switch (wanted) {
    case "strict":
      // Every approval is asked in the chat, and silence is a no.
      return { level: wanted, ask: true, onTimeout: "decline", decision: undefined, label: AUTHORIZATION_LABELS.strict };
    case "full":
      // 完全权限, decided by the answerer this plugin already is: approve on the spot, without
      // asking. The session is put on the `ask` policy so requests reach us at all (ensureAgent);
      // DSH's own `never` policy would reject them before any answerer was consulted.
      return { level: wanted, ask: false, onTimeout: "gui", decision: "allowed-once", label: AUTHORIZATION_LABELS.full };
    case "readonly":
      // Fail closed: anything that needs an approval is refused without asking.
      return { level: wanted, ask: false, onTimeout: "gui", decision: "rejected", label: AUTHORIZATION_LABELS.readonly };
    case "moderate":
    default:
      // Today's behaviour: ask in the chat, and let the GUI take over if nobody answers.
      return { level: "moderate", ask: true, onTimeout: "gui", decision: undefined, label: AUTHORIZATION_LABELS.moderate };
  }
}

/**
 * Should this message be **steered into the turn that is already running**, or queued as its
 * own turn?
 *
 * `steer` is the harness's own word for interjecting: `agent.steer(input)` puts the message in
 * the running turn's `next-step` inbox, so the model sees it at its next step, while
 * `followup` queues a separate turn. The switch is off by default, and it only applies when
 * there really is a turn in flight for this chat and a live agent to steer - otherwise
 * "interject" would mean dropping the message on the floor.
 *
 * @param {{ enabled?: boolean, turnInFlight?: boolean, agentAvailable?: boolean }} [input]
 * @returns {"steer" | "queue"}
 */
/**
 * Is a failed turn worth one more attempt?
 *
 * Exactly one retry, and only for a cause that looks transient - the transport, a socket, a timeout, a rate
 * limit, a 5xx. A deterministic failure (a rejected request, a bad model id) would fail again, and spending a
 * second call on it helps nobody. Pure, so the policy can be asserted rather than hoped for.
 *
 * @param {{ error?: unknown, attempt?: number, enabled?: boolean }} [input]
 * @returns {boolean}
 */
export function shouldRetryTurn({ error = "", attempt = 1, enabled = true } = {}) {
  if (!enabled) return false;
  if (attempt >= 2) return false;
  const text = String(error ?? "");
  return /TRANSPORT|transport|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|timed ?out|429|rate.?limit|50[234]|overloaded/i.test(text);
}

export function interjectDecision({ enabled = false, turnInFlight = false, agentAvailable = false } = {}) {
  if (!enabled || !turnInFlight || !agentAvailable) return "queue";
  return "steer";
}

/**
 * Why an interjection decision went the way it did, in terms a reader can check later.
 *
 * The counters are in-memory and reset with the process, so "it never moved" proves nothing after a restart -
 * which is exactly the confusion this answers. Every decision is appended to a JSONL file (survives restarts)
 * and kept in a small ring for `GET /state`.
 *
 * @param {{ enabled?: boolean, turnInFlight?: boolean, agentAvailable?: boolean, decision?: string }} input
 * @returns {string}
 */
export function interjectReason({ enabled = false, turnInFlight = false, agentAvailable = false, decision = "queue" } = {}) {
  if (decision === "steer") return "steered into the running turn";
  if (!enabled) return "interjection is off";
  if (!agentAvailable) return "this harness exposes no agent.steer";
  if (!turnInFlight) return "no turn was running for this chat at that moment";
  return "queued";

}

/**
 * Is this the platform saying "that reply id is gone"?
 *
 * `846605` means `invalid req_id`: the id a passive reply is correlated by has expired or belonged to
 * a socket session that has ended. Retrying is pointless - the answer has to go out the **proactive**
 * way (`aibot_send_msg`), which needs no req_id at all. Distinguishing it from `6000` ("more than one
 * caller at the same time", a transient race worth retrying) is what keeps the fallback quick instead
 * of burning three attempts on a dead id.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
export function isStaleReplyError(message) {
  return /846605|invalid req_id/i.test(String(message ?? ""));
}

/**
 * The live text a stream frame carries, whatever shape it arrives in - or "" for a frame that has
 * none (including every reasoning frame, which must never reach a chat).
 *
 * The adapter emits bare `{ type: "text-delta", text }` frames, but the same stream is *batched*
 * for the session record as `{ type: "chunk", chunk: { type: "text-delta", text } }` and
 * `{ type: "text-chunks", texts: [...] }`. Accepting only the bare shape silently discarded every
 * frame, which looked exactly like "the harness never sends any": the counter sat *after* the
 * filter, so the drop was invisible. Both the shapes and the counting order are fixed here.
 *
 * @param {unknown} frame
 * @returns {string} the text to show, or "" to show nothing
 */
export function liveTextOf(frame) {
  const type = String((frame && typeof frame === "object" && frame.type) || "");
  if (!type || /reason/i.test(type)) return "";
  const text = frame.text;
  if (type === "text-delta") return typeof text === "string" ? text : "";
  if (type === "chunk") {
    const chunk = frame.chunk;
    if (chunk && String(chunk.type) === "text-delta" && typeof chunk.text === "string") return chunk.text;
    return "";
  }
  if (type === "text-chunks" && Array.isArray(frame.texts)) {
    return frame.texts.filter((part) => typeof part === "string").join("");
  }
  return "";
}

/**
 * Should a streaming update be flushed to the chat now?
 *
 * A delta can arrive per token, and a chat window does not want a message per token: flush once
 * enough text accumulated, or once enough time passed since the last flush - whichever first.
 * Pure so the rule can be tested without a socket or a clock.
 *
 * @param {{ accumulated?: number, sent?: number, now?: number, lastAt?: number, chars?: number, ms?: number }} [input]
 * @returns {boolean}
 */
export function shouldFlush({ accumulated = 0, sent = 0, now = Date.now(), lastAt = 0, chars = 24, ms = 600 } = {}) {
  if (accumulated <= sent) return false;
  if (accumulated - sent >= chars) return true;
  return now - lastAt >= ms;
}

/**
 * Decide what an inbound message means, before anything is downloaded or
 * forwarded. Dependencies are injected so the whole decision is testable without
 * a network, a WeChat account or a harness:
 *
 * @param {object} options
 * @param {string} options.accountId
 * @param {object} options.message    the raw envelope
 * @param {string} options.text       the message's text, already extracted
 * @param {import('./state.js').WechatState} options.state
 * @param {(accountId: string, chatId: string, text: string) => boolean} [options.consumeApproval]
 * @returns {Promise<{ action: "ignore" | "answer" | "forward", reason: string } & ReturnType<typeof describeEnvelope> & { text: string }>}
 */
export async function classifyInbound({ accountId, message, text, state, consumeApproval }) {
  const identity = describeEnvelope(message);
  const base = { ...identity, text };
  if (!identity.chatId) return { ...base, action: "ignore", reason: "no-chat-id" };

  const prefs = await state.loadPrefs();
  // "Only answer friends" first: the user asked for the bot to serve 1:1 chats only, so a
  // group is skipped whatever the allowlist says about it (an allowlisted group included).
  if (prefs.friendOnly && identity.isGroup) return { ...base, action: "ignore", reason: "group-skipped" };

  const decided = allowDecision({ peer: await state.getPeer(accountId, identity.chatId), prefs });
  if (!decided.accepted) return { ...base, action: "ignore", reason: decided.reason };

  // "1"/"2" answers a pending approval; it must not become a turn of its own.
  if (text && typeof consumeApproval === "function" && consumeApproval(accountId, identity.chatId, text)) {
    return { ...base, action: "answer", reason: "approval-answer" };
  }
  // Keep the acceptance reason: "open" is the everyday case, "allowlisted" tells
  // a reader of the log that the allowlist let this chat through.
  return { ...base, action: "forward", reason: decided.reason === "open" ? "ok" : decided.reason };
}

/**
 * The same one-decision rule for a message that arrived over the WeCom long
 * connection, whose envelope is not the personal-WeChat one (see wecom-bot.js).
 *
 * It exists as its own function because the two paths must agree on the *order*:
 * allowlist first, then "is this a 1/2 answer to a pending approval?", then a turn.
 * The WeCom path originally skipped the middle step, so answering an approval in a
 * WeCom chat started a turn instead of answering it.
 *
 * @returns {Promise<{ action: "ignore" | "answer" | "forward", reason: string, chatId: string, isGroup: boolean, text: string }>}
 */
export async function classifyWecomInbound({ accountId, message, text, state, consumeApproval }) {
  const chatId = String(message?.chatId ?? "");
  const body = String(text ?? "");
  const base = { chatId, isGroup: message?.chatType === "group", text: body };
  if (!chatId) return { ...base, action: "ignore", reason: "no-chat-id" };

  const prefs = await state.loadPrefs();
  // Same rule and the same position as the personal-WeChat path - see classifyInbound.
  if (prefs.friendOnly && base.isGroup) return { ...base, action: "ignore", reason: "group-skipped" };

  const decided = allowDecision({ peer: await state.getPeer(accountId, chatId), prefs });
  if (!decided.accepted) return { ...base, action: "ignore", reason: decided.reason };

  if (body && typeof consumeApproval === "function" && consumeApproval(accountId, chatId, body)) {
    return { ...base, action: "answer", reason: "approval-answer" };
  }
  return { ...base, action: "forward", reason: decided.reason === "open" ? "ok" : decided.reason };
}
/** Locale keys Feishu uses inside a `post` body, in the order the official SDK tries them. */
const FEISHU_LOCALE_PRIORITY = ["zh_cn", "en_us", "ja_jp"];

/** `JSON.parse` that answers `undefined` instead of throwing: inbound content is not ours to trust. */
function feishuSafeParse(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A `post` body is either `{title, content}` or keyed by locale; the SDK prefers zh_cn, en_us, ja_jp, then the first key. */
function feishuUnwrapLocale(parsed) {
  if (!parsed || typeof parsed !== "object") return undefined;
  if ("title" in parsed || "content" in parsed) return parsed;
  for (const locale of FEISHU_LOCALE_PRIORITY) {
    const hit = parsed[locale];
    if (hit && typeof hit === "object") return hit;
  }
  const first = Object.values(parsed)[0];
  return first && typeof first === "object" ? first : undefined;
}

/**
 * Render one `post` element, collecting any media it refers to.
 *
 * The tags handled here are the ones read from the official SDK's own `renderElement` (`text`, `a`,
 * `at`, `img`, `media`, `code_block`, `hr`). Anything else is named rather than dropped, so an
 * unsupported element is visible in the prompt instead of silently vanishing.
 */
function feishuRenderPostElement(element, attachments) {
  const tag = String(element?.tag ?? "");
  switch (tag) {
    case "text":
      return String(element.text ?? "");
    case "a":
      return `${element.text ?? ""}${element.href ? ` (${element.href})` : ""}`;
    case "at":
      return element.user_id === "all" || element.user_id === "all_members" ? "@all" : `@${element.user_name ?? element.user_id ?? ""}`;
    case "img":
      if (element.image_key) {
        attachments.push({ type: "image", key: String(element.image_key) });
        return "![image]";
      }
      return "";
    case "media":
      if (element.file_key) {
        attachments.push({ type: "file", key: String(element.file_key) });
        return `<file key="${element.file_key}"/>`;
      }
      return "";
    case "code_block":
      return `\`\`\`${element.language ?? ""}\n${element.text ?? ""}\n\`\`\``;
    case "hr":
      return "---";
    default:
      return `[${tag || "?"}]`;
  }
}

/**
 * Read the parts this plugin needs out of an `im.message.receive_v1` event.
 *
 * The `message_type` → text/attachment mapping is the official SDK's converter table, not a guess:
 * `text` → `.text`; `post` → locale-unwrapped `{title, content}`; `image` → `.image_key`;
 * `file` → `.file_key`/`.file_name`; `audio` → `.file_key`/`.duration`; `media` →
 * `.file_key`/`.file_name`/`.duration`/`.image_key`; `sticker` → `.file_key`.
 *
 * Mentions arrive in the text as `@_user_N` placeholders and are replaced with the speaker's name
 * from `message.mentions`, which is also how the SDK does it.
 *
 * @param {any} event the parsed event body
 * @returns {{ chatId: string, chatType: string, isGroup: boolean, messageId: string, messageType: string,
 *            senderType: string, senderOpenId: string, senderUserId: string, tenantKey: string, createTime: string,
 *            rootId: string, threadId: string, text: string, attachments: Array<object>, unsupported: string,
 *            mentionNames: string[] }}
 */
export function feishuEventParts(event = {}) {
  const message = event?.event?.message ?? {};
  const sender = event?.event?.sender ?? {};
  const chatId = String(message.chat_id ?? "");
  const chatType = String(message.chat_type ?? "");
  const messageType = String(message.message_type ?? "");
  const parsed = feishuSafeParse(message.content);
  const attachments = [];
  let text = "";
  let unsupported = "";

  switch (messageType) {
    case "text":
      text = String(parsed?.text ?? "");
      break;
    case "post": {
      const body = feishuUnwrapLocale(parsed);
      const lines = [];
      if (body?.title) lines.push(`**${body.title}**`, "");
      for (const paragraph of body?.content ?? []) {
        if (!Array.isArray(paragraph)) continue;
        lines.push(paragraph.map((element) => feishuRenderPostElement(element, attachments)).join(""));
      }
      text = lines.join("\n").trim();
      break;
    }
    case "image":
      if (parsed?.image_key) {
        attachments.push({ type: "image", key: String(parsed.image_key) });
        text = "[图片]";
      }
      break;
    case "file":
      if (parsed?.file_key) {
        attachments.push({ type: "file", key: String(parsed.file_key), name: String(parsed.file_name ?? "") });
        text = `[文件${parsed.file_name ? ` ${parsed.file_name}` : ""}]`;
      }
      break;
    case "audio":
      if (parsed?.file_key) {
        attachments.push({ type: "audio", key: String(parsed.file_key), durationMs: Number(parsed.duration) || 0 });
        text = "[语音]";
      }
      break;
    case "media":
      if (parsed?.file_key) {
        attachments.push({
          type: "video",
          key: String(parsed.file_key),
          name: String(parsed.file_name ?? ""),
          durationMs: Number(parsed.duration) || 0,
          coverKey: String(parsed.image_key ?? ""),
        });
        text = `[视频${parsed.file_name ? ` ${parsed.file_name}` : ""}]`;
      }
      break;
    case "sticker":
      if (parsed?.file_key) {
        attachments.push({ type: "sticker", key: String(parsed.file_key) });
        text = "[表情]";
      }
      break;
    default:
      // Reported, never silently dropped: a new message type must be visible.
      unsupported = messageType || "(none)";
      break;
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const mentionNames = [];
  for (const mention of mentions) {
    const key = String(mention?.key ?? "");
    const name = String(mention?.name ?? "");
    if (name) mentionNames.push(name);
    if (!key) continue;
    text = text.split(key).join(name ? `@${name}` : key);
  }

  return {
    chatId,
    chatType,
    isGroup: chatType === "group",
    messageId: String(message.message_id ?? ""),
    messageType,
    senderType: String(sender.sender_type ?? ""),
    senderOpenId: String(sender.sender_id?.open_id ?? ""),
    senderUserId: String(sender.sender_id?.user_id ?? ""),
    tenantKey: String(sender.tenant_key ?? ""),
    createTime: String(message.create_time ?? ""),
    rootId: String(message.root_id ?? ""),
    threadId: String(message.thread_id ?? ""),
    text,
    attachments,
    unsupported,
    mentionNames,
  };
}

/**
 * The one-decision rule for a Feishu event, the same rule and order as the other two transports:
 * allowlist first, then "is this a 1/2 answer to a pending approval?", then a turn.
 *
 * @returns {Promise<{ action: "ignore" | "answer" | "forward", reason: string, chatId: string, isGroup: boolean, text: string }>}
 */
export async function classifyFeishuInbound({ accountId, message, text, state, consumeApproval }) {
  const chatId = String(message?.chatId ?? "");
  const body = String(text ?? "");
  const base = { chatId, isGroup: message?.isGroup === true, text: body };
  if (!chatId) return { ...base, action: "ignore", reason: "no-chat-id" };

  const prefs = await state.loadPrefs();
  if (prefs.friendOnly && base.isGroup) return { ...base, action: "ignore", reason: "group-skipped" };

  const decided = allowDecision({ peer: await state.getPeer(accountId, chatId), prefs });
  if (!decided.accepted) return { ...base, action: "ignore", reason: decided.reason };

  if (body && typeof consumeApproval === "function" && consumeApproval(accountId, chatId, body)) {
    return { ...base, action: "answer", reason: "approval-answer" };
  }
  return { ...base, action: "forward", reason: decided.reason === "open" ? "ok" : decided.reason };
}

/**
 * Render an approval request as the WeChat prompt. The arguments matter as much
 * as the tool name: "工具：pwsh" alone does not tell anyone what they are about
 * to allow.
 *
 * @param {{toolName?: string, reason?: string, displayReason?: string, arguments?: unknown}} request
 * @returns {string} the message body sent to WeChat
 */
export function formatApprovalPrompt(request = {}, { maxArgumentChars = 400 } = {}) {
  const lines = ["⚠️ 需要你批准一次操作（远程审批）", `工具：${request?.toolName ?? "?"}`];
  const reason = request?.displayReason || request?.reason;
  if (reason) lines.push(`原因：${reason}`);
  const preview = formatArguments(request?.arguments, maxArgumentChars);
  if (preview) lines.push("参数：", preview);
  lines.push("", "回 1 = 批准一次 · 回 2 = 拒绝");
  return lines.join("\n");
}

/**
 * Count a message the allowlist dropped. Silently ignoring a chat is the right
 * behaviour and a terrible experience: the count makes the silence visible in the
 * card ("已拦截 N 条") instead of leaving the user wondering why the bot went quiet.
 *
 * @returns {{ blockedCount: number, blockedAt: string }}
 */
/**
 * Build an inbound envelope of the same shape the platform sends, so the receive
 * path can be exercised without a phone. Used by the loopback-only debug route.
 */
export function syntheticInbound({ chatId, text, fromUserId, messageId, now = Date.now() } = {}) {
  const from = fromUserId || chatId;
  const envelope = {
    message_id: messageId || `debug-${Math.random().toString(36).slice(2, 10)}`,
    message_type: 1,
    from_user_id: from,
    session_id: chatId,
    create_time_ms: now,
    item_list: [{ type: 1, text_item: { text: String(text ?? "debug inbound") } }],
  };
  if (/@chatroom$/.test(String(chatId ?? ""))) envelope.group_id = chatId;
  return envelope;
}
export function noteBlocked(peer, now = new Date().toISOString()) {
  return { blockedCount: (Number(peer?.blockedCount) || 0) + 1, blockedAt: now };
}

/**
 * Which record an approval for this conversation must be asked through.
 *
 * A personal-WeChat chat needs an account that holds a token (without one nothing
 * can be sent, so the GUI keeps the request). A WeCom chat has no account file at
 * all: the long connection is the channel, and it is answerable only while it is
 * authenticated. Skipping this distinction is why approvals inside a WeCom chat
 * never reached the user - the bridge demanded a WeChat token for a pseudo account
 * (`wecom-…`) that can never have one, and quietly handed every request to the GUI.
 *
 * @returns {object|undefined} the record to pass to `notify`, or undefined to fall
 *   back to the GUI.
 */
export function approvalTarget({ conversation, account, wecomReady } = {}) {
  const accountId = String(conversation?.accountId ?? "");
  if (accountId.startsWith("wecom-")) {
    return wecomReady ? { accountId, via: "wecom" } : undefined;
  }
  return account?.token ? account : undefined;
}

/**
 * The approval bridge: ask the human in WeChat, wait for a 1/2 answer, and never
 * swallow a request that could not be answered.
 *
 * It lives outside `apply` with its dependencies injected so every decision is
 * testable without WeChat, a harness or a real clock: `notify` sends the prompt,
 * `consume` feeds a reply in, and `respond` is the `approval/request` handler.
 */
export function createApprovalBridge({ notify, timeoutMs = 120000, logger, policyFor } = {}) {
  /** `accountId|chatId -> { resolve, timer }`; one question per chat at a time. */
  const pending = new Map();
  const keyOf = (accountId, chatId) => `${accountId}|${chatId}`;

  /** Most recent outcome, so a UI can show the result without blocking. */
  let lastResult;
  const bridge = {
    pending,

    /** What is waiting right now: shown in the card and used for diagnostics. */
    list() {
      return [...pending.entries()].map(([key, waiting]) => ({
        key,
        accountId: waiting.accountId,
        chatId: waiting.chatId,
        toolName: waiting.toolName,
        requestedAt: new Date(waiting.requestedAt).toISOString(),
        waitedMs: Date.now() - waiting.requestedAt,
      }));
    },

    /**
     * Give up on a pending question (a mis-clicked approval should not have to wait
     * for the timeout). Undefined means "ask someone else", so the GUI takes over.
     */
    cancel(accountId, chatId) {
      const key = keyOf(accountId, chatId);
      const waiting = pending.get(key);
      if (!waiting) return false;
      clearTimeout(waiting.timer);
      pending.delete(key);
      waiting.resolve(undefined);
      lastResult = { outcome: "cancelled", chatId, toolName: waiting.toolName, at: new Date().toISOString() };
      Promise.resolve()
        .then(() => notify?.(waiting.account, chatId, "🚫 已在 DSH 里取消这次审批，转由 GUI 处理。"))
        .catch(() => {});
      return true;
    },

    /** The most recent outcome ("allowed-once" / "rejected" / "cancelled" / "timeout"). */
    last() {
      return lastResult ? { ...lastResult } : undefined;
    },

    /** Record an outcome that happened without asking (`仅查看` refuses on its own). */
    record(entry) {
      lastResult = { at: new Date().toISOString(), ...entry };
      return lastResult;
    },

    /**
     * Feed an inbound message to the bridge.
     * @returns {boolean} true when it answered a pending request, so the caller
     *   must not also forward it to the agent as an ordinary turn.
     */
    consume(accountId, chatId, text) {
      const key = keyOf(accountId, chatId);
      const waiting = pending.get(key);
      if (!waiting) return false;
      const outcome = parseApprovalReply(text);
      if (!outcome) return false;
      clearTimeout(waiting.timer);
      pending.delete(key);
      waiting.resolve(outcome);
      lastResult = { outcome, chatId, toolName: waiting.toolName, at: new Date().toISOString() };
      // Confirm in the chat. Reported from real use: answering and then hearing
      // nothing back is indistinguishable from being ignored.
      const confirmation = outcome === "allowed-once" ? "✅ 已批准，本次操作继续。" : "🚫 已拒绝，本次操作已取消。";
      Promise.resolve()
        .then(() => notify?.(waiting.account, chatId, confirmation))
        .catch(() => {});
      return true;
    },

    /**
     * Ask and wait.
     * @returns {Promise<"allowed-once" | "rejected" | undefined>} undefined means
     *   "no answer" - the caller must delegate so the GUI still gets its prompt.
     */
    async ask(account, chatId, request, { timeoutMs: limit = timeoutMs, accountId, onSent, onTimeout = "gui" } = {}) {
      if (typeof notify !== "function") {
        onSent?.(false, new Error("no notifier configured"));
        return undefined;
      }
      // Key by the id the *inbound* path uses (the monitor's account id), never by
      // whatever the account record happens to call itself: a botId/accountId
      // mismatch left a "1"/"2" reply unmatched, so it reached the agent as an
      // ordinary message instead of answering the approval. Found live, not by test.
      const key = keyOf(accountId ?? account?.accountId ?? account?.botId, chatId);
      // One question per chat at a time: a second one makes "1"/"2" ambiguous.
      if (pending.has(key)) return undefined;
      try {
        await notify(account, chatId, formatApprovalPrompt(request));
        // Tell the caller the prompt really went out: "nothing happened" and
        // "sent, waiting for you" must be distinguishable.
        onSent?.(true);
      } catch (error) {
        // No outbound path (window closed): let the GUI handle the request.
        logger?.warn?.("[dsh-wechat-media] approval prompt could not be sent: %s", error?.message ?? error);
        onSent?.(false, error);
        return undefined;
      }
      // Only a real timeout gets the "no answer" notice: a cancel from DSH and an
      // aborted turn have their own (or no) message, and two notices contradict.
      let timedOut = false;
      const declaredOnTimeout = onTimeout === "decline";
      const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          lastResult = { outcome: declaredOnTimeout ? "rejected" : "timeout", chatId, toolName: request?.toolName, at: new Date().toISOString() };
          pending.delete(key);
          // Strict mode fails closed: no answer in the chat means "no", instead of handing the
          // request to the GUI, where it could still be approved outside the chat.
          resolve(declaredOnTimeout ? "rejected" : undefined);
        }, Math.max(1, Number(limit) || timeoutMs));
        // The account is kept so the answer can be confirmed in the same chat.
        pending.set(key, { resolve, timer, requestedAt: Date.now(), account, accountId: accountId ?? account?.accountId ?? account?.botId, chatId, toolName: request?.toolName });
        // The requester may cancel while we wait (turn aborted, session closed).
        request?.signal?.addEventListener?.("abort", () => {
          clearTimeout(timer);
          pending.delete(key);
          resolve(undefined);
        }, { once: true });
      });
      if (!answer && timedOut) {
        // Say so in the chat: the GUI prompt appearing out of nowhere would
        // otherwise look like the bridge ignored the answer.
        try {
          await notify(account, chatId, "⌛ 微信里没等到批复，这次转由 GUI 处理。");
        } catch {
          // The window may have closed in the meantime; the GUI still has it.
        }
      }
      return answer;
    },

    /** The `approval/request` listener body. */
    async respond(request, next, { ignore = false, findConversation, loadAccount } = {}) {
      try {
        // The level can change at any moment (`/auth`, the card), so it is read per request.
        const policy = await (policyFor?.() ?? approvalPolicyFor("moderate"));
        if (ignore) return next();
        // 完全权限 and 仅查看 are decided here, without asking anyone: this plugin is itself an
        // answerer, so an approval can be granted or refused on the spot.
        if (policy.decision) {
          lastResult = { outcome: policy.decision, chatId: "", toolName: request?.toolName, at: new Date().toISOString(), reason: `authorization-level-${policy.level}` };
          logger?.info?.("[dsh-wechat-media] %s %s without asking (authorization level: %s)", policy.decision === "allowed-once" ? "approved" : "declined", request?.toolName ?? "?", policy.level);
          return policy.decision;
        }
        if (!policy.ask) return next();
        const conversation = await findConversation?.(String(request?.agent?.session?.id ?? ""));
        if (!conversation) return next(); // not a WeChat-driven session
        // Whoever the caller can actually reach. `loadAccount` owns that judgement
        // (a WeChat account needs a token; a WeCom chat needs a live long connection).
        const account = await loadAccount?.(conversation.accountId, conversation);
        if (!account) return next();
        // Undefined means "ask someone else": the GUI's own prompt stays intact.
        return (await bridge.ask(account, conversation.chatId, request, { accountId: conversation.accountId, onTimeout: policy.onTimeout })) ?? next();
      } catch (error) {
        logger?.warn?.("[dsh-wechat-media] approval bridge failed: %s", error?.message ?? error);
        return next();
      }
    },
  };

  return bridge;
}
/** One short, readable block of the tool arguments (object, string or nothing). */
function formatArguments(args, maxChars) {
  if (args === undefined || args === null) return "";
  let text;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
  if (!text || text === "{}" || text === '""') return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…（已截断）` : text;
}
/**
 * Read a WeChat reply as an approval answer: the numbered shortcut the prompt
 * advertises, plus the words people actually type, in both languages. Anything
 * else is an ordinary message.
 *
 * @returns {"allowed-once" | "rejected" | undefined}
 */
export function parseApprovalReply(text) {
  const normalized = String(text ?? "").trim().toLowerCase().replace(/^\//, "").trim();
  if (!normalized) return undefined;
  // English is matched exactly: "yes please do it" is a sentence, not an answer.
  if (["1", "y", "yeah", "yep", "yes", "ok", "okay", "sure", "allow", "allowed", "approve", "approved", "go ahead"].includes(normalized)) {
    return "allowed-once";
  }
  if (["2", "n", "nah", "nope", "no", "no thanks", "deny", "reject", "rejected", "cancel", "dont", "don't"].includes(normalized)) {
    return "rejected";
  }
  // Chinese reads naturally as a prefix: 同意/批准一次/拒绝掉 all work.
  if (/^(同意|批准|允许|可以|好的|行)/.test(normalized)) return "allowed-once";
  if (/^(拒绝|不同意|不可以|不行|否)/.test(normalized)) return "rejected";
  return undefined;
}

/** Render a scannable QR code as SVG. Vendored encoder (MIT, Kazuhiko Arase). */
export function renderQrSvg(payload, { cellSize = 4, margin = 2 } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(String(payload));
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

/** The text of one assistant message event, ignoring non-text blocks. */
export function assistantText(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Collects assistant replies and correlates them with the turn this plugin
 * started. Settling on *our* `turn/end` (never on whole-agent idle) matters: a
 * session the human is also using never goes idle, which is the classic way a
 * bridge ends up with replies that never leave the queue.
 */
export class ReplyCollector {
  constructor(scope, { onUsage, onDelta } = {}) {
    this.scope = scope;
    this.onUsage = onUsage;
    this.onDelta = onDelta;
    // Event types this collector does not handle. A bounded ring, reported by /state: if live text
    // arrives under a name nobody told us about, it shows up here instead of vanishing.
    this.unknownEvents = [];
    /**
     * One queue of waiters per session, not one waiter.
     *
     * A second message arriving while the first is still being answered used to *replace* the
     * pending record, so the first reply could never be relayed and the replacement was
     * resolved by the wrong turn. Interjection makes that path normal (the second message is
     * steered into the running turn) and queueing keeps it correct (the second message waits
     * for its own turn).
     */
    this.pending = new Map(); // sessionId -> record[]
    scope.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      const sessionId = String(agent?.session?.id ?? agent?.id ?? "");
      const queue = this.pending.get(sessionId);
      if (!queue?.length) return;
      // Prefer the record that asked for exactly this message; otherwise the oldest, which is
      // the one whose turn this claim represents.
      const record = queue.find((candidate) => !candidate.turn && candidate.messageId && message?.id && candidate.messageId === message.id)
        ?? queue.find((candidate) => !candidate.turn);
      if (record) record.turn = turn;
    });
    scope.on("agent/assistant-stream", ({ frame } = {}) => {
      // Every frame is reported, in whatever shape it arrives, and with whatever text it carries
      // (possibly none). Deciding "is this text worth showing" here would hide the difference
      // between "no frames arrive" and "frames arrive in a shape we do not know".
      try {
        this.onDelta?.({ text: liveTextOf(frame), type: String(frame?.type ?? "?") });
      } catch {
        /* never let a preview take the answer down */
      }
    });
    scope.on("session/event", (session, event) => {
      const sessionId = String(session?.header?.id ?? session?.id ?? "");
      // Token usage is reported per model call, not per turn, and it is interesting even for
      // a session no chat is waiting on (a GUI turn of the same conversation, say), so it is
      // accounted before the `pending` bookkeeping and independently of it.
      if (event.type === "assistant/message" && event.data?.usage) {
        try {
          this.onUsage?.({ sessionId, usage: event.data.usage, step: event.data?.step });
        } catch {
          // Counting must never be the reason a reply is lost.
        }
      }
      // Live text may also travel as a session event (non-durable, so it never reaches the
      // transcript). Accept a delta-shaped one, never a reasoning one, and record what came.
      if (/delta/i.test(String(event.type)) && !/reason|think/i.test(String(event.type))) {
        const chunk = event.data?.text ?? event.data?.delta ?? event.data?.content;
        if (typeof chunk === "string" && chunk) {
          this.unknownEvents.push(`${event.type}:text`);
          if (this.unknownEvents.length > 12) this.unknownEvents.shift();
          try {
            this.onDelta?.({ text: chunk, type: `${event.type} (session)` });
          } catch {
            /* a preview must never break the reply */
          }
        }
      } else if (!["tool/call", "assistant/message", "turn/end", "turn/start", "step/start", "step/end", "user/message", "request/header"].includes(String(event.type))) {
        this.unknownEvents.push(String(event.type));
        if (this.unknownEvents.length > 12) this.unknownEvents.shift();
      }
      const queue = this.pending.get(sessionId);
      if (!queue?.length) return;
      // The text of a turn belongs to the record that turn was claimed for.
      const forTurn = queue.filter((record) => record.turn !== undefined && record.turn === event?.data?.turn);
      if (event.type === "tool/call") {
        // A delivery tool already answered this turn: remember it so the relay
        // does not send the same answer a second time.
        if (DELIVERY_TOOLS.has(String(event.data?.name ?? ""))) for (const record of forTurn) record.deliveredByTool = true;
        return;
      }
      if (event.type === "assistant/message") {
        const text = assistantText(event);
        if (text) for (const record of forTurn) record.parts.push(text);
        return;
      }
      if (event.type === "turn/end") {
        for (const record of forTurn) {
          this.#settle(record, { text: record.parts.join("").trim(), stopReason: event.data?.reason?.kind ?? "end_turn" });
        }
      }
    });
    scope.on("agent/error", ({ agent, turn, error }) => {
      const sessionId = String(agent?.session?.id ?? agent?.id ?? "");
      const queue = this.pending.get(sessionId);
      if (!queue?.length) return;
      for (const record of queue.filter((candidate) => candidate.turn !== undefined && candidate.turn === turn)) {
        this.#settle(record, { text: record.parts.join("").trim(), error: String(error?.message ?? error), stopReason: "error" });
      }
    });
  }

  /** Is a reply for this session still being awaited? (`/interject` asks exactly this.) */
  isWaiting(sessionId) {
    return (this.pending.get(String(sessionId)) ?? []).length > 0;
  }

  #settle(record, outcome) {
    if (record.settled) return;
    record.settled = true;
    clearTimeout(record.timer);
    clearTimeout(record.claimTimer);
    const queue = this.pending.get(record.sessionId) ?? [];
    const remaining = queue.filter((candidate) => candidate !== record);
    if (remaining.length > 0) this.pending.set(record.sessionId, remaining);
    else this.pending.delete(record.sessionId);
    record.resolve({ ...outcome, deliveredByTool: Boolean(record.deliveredByTool) });
  }

  /**
   * Wait for the reply to one message.
   * @param {string} sessionId
   * @param {string|undefined} messageId id of the message we queued, when known
   * @returns {Promise<{ text: string, stopReason: string, error?: string }>}
   */
  wait(sessionId, messageId, timeoutMs = REPLY_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const record = {
        sessionId,
        messageId,
        turn: undefined,
        parts: [],
        settled: false,
        resolve,
        timer: setTimeout(() => this.#settle(record, { text: record.parts.join("").trim(), stopReason: "timeout" }), timeoutMs),
      };
      const queue = this.pending.get(sessionId) ?? [];
      queue.push(record);
      this.pending.set(sessionId, queue);
      // If the inbox never claims it (admission gate), do not wait forever.
      record.claimTimer = setTimeout(() => {
        if (!record.settled && record.turn === undefined) {
          this.#settle(record, { text: record.parts.join("").trim(), stopReason: "not-claimed" });
        }
      }, 15_000);
    });
  }
}

/**
 * A stable, restart-safe session id for one chat.
 *
 * It must cover the **whole** identity. The first version kept the first 40 base64url
 * characters of `${accountId}\0${chatId}` - about 30 bytes - and a WeCom pseudo account
 * id alone is 41 characters, so the chat id never reached the digest: *every* chat of a
 * WeCom bot resolved to the same session (verified live: four different chat ids, one
 * id). A direct message, a group and a debug chat then shared one conversation and one
 * context. The same truncation could merge two personal-WeChat chats whose ids share a
 * prefix. SHA-256 over the full identity removes the truncation; 32 base64url characters
 * of it are 192 bits, which is both collision-free in practice and a safe file name.
 *
 * `generation` is what `/new` bumps: a restarted conversation needs a *different* id, or
 * resuming would bring the old history straight back. Generation 0 hashes exactly what
 * earlier releases hashed, so existing conversations keep working.
 *
 * @returns {string} `wechat-` + 32 url-safe characters.
 */
export function sessionIdFor(accountId, chatId, generation = 0) {
  const round = Number(generation) || 0;
  const identity = round > 0 ? `${accountId}\u0000${chatId}\u0000${round}` : `${accountId}\u0000${chatId}`;
  const digest = createHash("sha256")
    .update(identity)
    .digest("base64url")
    .replace(/[^A-Za-z0-9]/g, "");
  return `wechat-${digest.slice(0, 32)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function apply(ctx, config = {}) {
  const dshHome = config.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh");
  const stateRoot = config.stateDir || defaultStateRoot(dshHome);
  const state = new WechatState({ root: stateRoot });
  const baseUrl = config.baseUrl || "https://ilinkai.weixin.qq.com";
  const botType = String(config.botType ?? "3");
  const maxMediaBytes = (config.maxMediaMiB ?? 100) * 1024 * 1024;
  const logins = new WechatLoginManager({ state, ilink, baseUrl, botType });

  /** accountId -> { stopped, failures, record, lastPollAt, lastError, connectedAt } */
  const monitors = new Map();
  /** sessionId -> { accountId, chatId, peerName } */
  const conversations = new Map();
  /** accountId -> Set of processed message ids (bounded). */
  const seen = new Map();
  /** `${accountId}|${peer}` -> { ticket, at } */
  const typingTickets = new Map();
  /** `${accountId}|${peer}` -> { accountId, chatId, peerName, at } last inbound */
  const lastInbound = new Map();
  /**
   * How the last conversation had to be opened when resuming did not just work:
   * `{ at, requested, resume, create, retryResume, freshId }`. Reported by /state and
   * on the WeCom page, because a chat that silently started a fresh history (or a
   * different session id) is otherwise indistinguishable from one that lost its mind.
   */
  let lastSessionIssue = null;
  /**
   * The last failure to write the token ledger.
   *
   * Accounting is fire-and-forget so a slow disk cannot delay a reply, which means a failure
   * would otherwise be invisible - which is how one turn went missing from the ledger while the
   * session transcript still had it. `/state` now reports it beside `inboundError`.
   */
  let tokenAccountingError = null;
  const collectors = new ReplyCollector(ctx, {
    /**
     * Attribute one model call to the account and chat it belongs to.
     *
     * The session event carries only the session id, so it is resolved through the
     * conversation table the inbound paths maintain; a session nobody is bridging (a GUI
     * turn of the same conversation, say) has no account to charge and is skipped rather
     * than guessed at.
     */
    onDelta: ({ text, type }) => {
      // Every frame is counted, and its shape recorded, before any decision to show it: a preview
      // that never appears must be distinguishable from frames that never arrive.
      counters.streamDeltas += 1;
      lastStreamFrame = { type: type ?? "?", chars: text ? text.length : 0, at: new Date().toISOString() };
      if (text) activeStreamer?.push(text);
    },
    onUsage: ({ sessionId, usage }) => {
      const conversation = conversations.get(sessionId);
      if (!conversation?.accountId) return;
      // Totals are derived from the parts; if a provider ever reports a total that disagrees,
      // say so rather than quietly changing what the numbers mean.
      const disagreement = usageDisagreement(usage);
      if (disagreement) ctx.logger?.warn?.("[dsh-wechat-media] token %s", disagreement);
      // Fire and forget - a slow disk must not delay the reply - but a failure is logged
      // rather than swallowed, so the ledger can never quietly stop counting.
      state.addTokens({ accountId: conversation.accountId, chatId: conversation.chatId, usage })
        .then(() => {
          tokenAccountingError = null;
        })
        .catch((error) => {
          tokenAccountingError = { at: new Date().toISOString(), accountId: conversation.accountId, chatId: conversation.chatId, message: String(error?.message ?? error) };
          ctx.logger?.warn?.("[dsh-wechat-media] token accounting failed: %s", error?.message ?? error);
        });
    },
  });
  /** Injected factories resolved lazily through the loader. */
  const harness = { createUserMessage: undefined, defineTool: undefined };

  ctx.effect(() => () => {
    for (const monitor of monitors.values()) monitor.stopped = true;
  }, "dsh-wechat-media: stop monitors");

  // ── helpers ────────────────────────────────────────────────────────────────

  const rememberSeen = (accountId, messageId) => {
    let bucket = seen.get(accountId);
    if (!bucket) {
      bucket = new Set();
      seen.set(accountId, bucket);
    }
    bucket.add(String(messageId));
    while (bucket.size > DEDUP_LIMIT) bucket.delete(bucket.values().next().value);
  };

  /** Build the durable user message the agent receives. */
  async function userMessage(text) {
    if (!harness.createUserMessage) {
      try {
        const llm = await importHarnessPlugin(ctx, "@deepseek-ai/dsh-llm");
        harness.createUserMessage = llm?.createUserMessage;
      } catch {
        // fall through to the documented literal shape below
      }
    }
    if (harness.createUserMessage) {
      return harness.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    }
    return { content: [{ type: "text", text }], source: { kind: "user" } };
  }

  /**
   * How many times this chat has been restarted with `/new`. Kept in the route table so
   * it survives a restart: the id a chat resolves to must stay the same for a given
   * generation, or every message would open yet another conversation.
   */
  async function generationOf(accountId, chatId) {
    const route = await state.getRoute(accountId, chatId);
    const generation = Number(route?.generation ?? 0);
    return Number.isFinite(generation) && generation > 0 ? Math.floor(generation) : 0;
  }

  /** A live agent handle per session id, so `/stop` and `/new` can act on it. */
  const conversationHandles = new Map();

  /** Ensure a live agent for one conversation, resuming its history when possible. */
  async function ensureAgent(accountId, chatId, peerName) {
    const generation = await generationOf(accountId, chatId);
    const sessionId = sessionIdFor(accountId, chatId, generation);
    const existing = ctx.agents.get(sessionId);
    if (existing) {
      conversations.set(sessionId, { accountId, chatId, peerName, generation });
      return { agent: existing, sessionId, accountId, chatId, peerName, generation, handle: conversationHandles.get(sessionId) };
    }

    const presets = ctx.get("agentPresets");
    const mountId = config.agentPreset || presets?.defaultId;
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    const agentOptions = selection?.provider && selection?.model
      ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      : undefined;
    const workspaceRoot = await resolvedInbox();
    const meta = { cwd: config.cwd || workspaceRoot, ...(mountId ? { agentPreset: mountId } : {}) };
    const setup = async (agentCtx) => {
      // Without mounting the preset the agent publishes against the empty global
      // layer: no tools, no prompt, nothing it could act with.
      if (presets && mountId) {
        try {
          await presets.mount(agentCtx, mountId);
        } catch (error) {
          ctx.logger?.warn?.("[dsh-wechat-media] preset mount failed: %s", error?.message ?? error);
        }
      }
    };

    // Opening the conversation is its own ladder of attempts (resume, create, resume
    // again, fresh id) because a chat whose stored session cannot be resumed must not
    // stay silent forever - see session.js, and /state.wecom.sessionIssue for the
    // outcome of the last one.
    const opened = await openSessionAgent({
      agents: ctx.agents,
      sessionId,
      meta,
      agentOptions,
      setup,
      logger: ctx.logger,
    });
    const handle = opened.handle;
    const resolvedId = opened.sessionId;
    if (opened.issue) {
      lastSessionIssue = { at: new Date().toISOString(), ...opened.issue };
      ctx.logger?.warn?.(
        "[dsh-wechat-media] session %s needed recovery: %s",
        resolvedId,
        opened.issue.freshId ? `a fresh session was started (${opened.issue.freshId})` : "the stored session was reopened",
      );
    }
    ctx.effect(() => handle.dispose, `dsh-wechat-media: agent ${resolvedId}`);
    conversationHandles.set(resolvedId, handle);
    conversations.set(resolvedId, { accountId, chatId, peerName, generation });
    // Keep the generation: `/new` must not be undone by this write.
    await state.setRoute(accountId, chatId, {
      sessionId: resolvedId,
      peerName,
      kind: String(chatId).includes("@chatroom") ? "group" : "direct",
      generation,
    });
    // Put the session on the `ask` approval policy. With DSH's `never` policy a request is
    // rejected before any answerer is consulted, so the authorization level could never decide;
    // `ask` hands the decision to this plugin, and with no answerer reachable it still fails
    // closed. Applied once per session, because the policy is recorded in the session itself.
    try {
      const approvalPlugin = await importHarnessPlugin(ctx, "@deepseek-ai/dsh-user-approval");
      approvalPlugin?.setApprovalPolicy?.(handle.agent?.session, "ask");
    } catch (error) {
      ctx.logger?.warn?.("[dsh-wechat-media] could not set the session approval policy: %s", error?.message ?? error);
    }
    return { agent: handle.agent, sessionId: resolvedId, accountId, chatId, peerName, generation, handle };
  }

  /** The `/delivery` listing. */
  function deliveryReport(current) {
    return [
      `⌨️ 发送方式：${current === "stream" ? "逐字（流式）" : "整段"}（${current}）`,
      "",
      "· 整段 whole：答案写完一次发出来（默认，也是旧版本行为）",
      "· 逐字 stream：企业微信里**边写边出现**（用长连接的 stream 消息增量推送，最后一条带完整答案收尾）",
      "  —— 个人微信没有编辑已发消息的接口，所以那边无论选哪个都是一次发完整答案。",
      "",
      "用法：/delivery whole | stream（也接受 整段 / 逐字）",
    ].join("\n");
  }

  /**
   * The answer as a chat should see it. WeChat and WeCom render no markdown - `**bold**` arrives with
   * the asterisks - so the default strips it; `/format raw` sends the model's text untouched.
   */
  async function chatBody(text) {
    const raw = String(text ?? "");
    if (!raw) return raw;
    return (await state.loadPrefs()).format === "raw" ? raw : toPlainText(raw);
  }

  /** The one-line format summary `/status` prints. */
  async function formatStatusLine() {
    return `文本处理：${(await state.loadPrefs()).format === "raw" ? "原样（保留 markdown）" : "清洗（去掉微信不渲染的标记）"}`;
  }

  /** The `/format` listing. */
  async function formatReport() {
    const current = (await state.loadPrefs()).format === "raw" ? "raw" : "plain";
    return [
      `🧹 文本处理：${current === "raw" ? "原样" : "清洗"}（${current}）`,
      "",
      "· 清洗 plain：去掉微信/企微**不渲染**的标记——`**加粗**`、`## 标题`、`` `代码` ``、```围栏```、`> 引用`、",
      "  表格分隔行、`$$公式$$`、`<think>` 与 HTML 标签；链接变成「文字（网址）」，图片直接去掉。",
      "  普通句子**逐字不变**（有专门的测试盯着这条）。",
      "· 原样 raw：把模型写的东西原封不动发出去（旧的默认行为）。",
      "",
      "用法：/format plain | raw（也接受 清洗 / 原样）",
    ].join("\n");
  }

  /** The one-line delivery summary `/status` prints. */
  async function deliveryStatusLine() {
    const mode = (await state.loadPrefs()).delivery === "stream" ? "stream" : "whole";
    return `发送方式：${mode === "stream" ? "逐字（仅企微生效）" : "整段"}`;
  }

  /** One line per level, shared by `/auth` and its "unknown level" answer. */
  function authExplain(level) {
    switch (approvalPolicyFor(level).level) {
      case "strict":
        return "每一次需要授权的操作都会在聊天里问你；**超时或没回就当拒绝**（不会偷偷转给 GUI）。";
      case "full":
        return "完全不在聊天里问：需要授权的操作交给 DSH 自己的策略处理（你现在的会话策略是不询问 → 等于放行）。";
      case "readonly":
        return "不问、直接拒绝**所有**需要授权的操作（fail closed）。注意：会话策略若根本不询问，插件就拦不到它——真正的只读要在 DSH 会话策略里设。";
      default:
        return "在聊天里问；超时没人回答就转给 GUI 处理（旧版本的行为）。";
    }
  }

  /** The `/auth` listing: every level, the current one marked. */
  function authReport(current) {
    const lines = [`🔐 授权档位：${approvalPolicyFor(current).label}（${current}）`, ""];
    for (const level of AUTHORIZATION_LEVELS) {
      const policy = approvalPolicyFor(level);
      lines.push(`${policy.level === policy.level && level === policy.level ? (level === current ? "▶ " : "· ") : "· "}${policy.label}（${level}）：${authExplain(level)}`);
    }
    lines.push("", "用法：/auth <严格|适中|完全权限|仅查看>（也接受 strict/moderate/full/readonly）");
    return lines.join("\n");
  }

  /** The one-line authorization summary `/status` prints. */
  async function authStatusLine() {
    const level = (await state.loadPrefs()).authorization ?? "moderate";
    const policy = approvalPolicyFor(level);
    return `授权档位：${policy.label}（${level}）· ${policy.ask ? "会在聊天里问" : policy.decline ? "直接拒绝" : "不问，交给 GUI"}`;
  }

  /** The `/tokens` answer: the ledger, with each account labelled the way its chats name it. */
  async function tokenReport() {
    const summary = summarize(await state.loadTokens());
    const peers = await state.loadPeers();
    const accountNames = {};
    for (const row of summary.accounts) {
      const named = Object.values(peers?.[row.accountId] ?? {}).find((peer) => peer?.name);
      if (named?.name) accountNames[row.accountId] = `${row.accountId}（${named.name}）`;
    }
    return tokensReport(summary, { accountNames });
  }

  /** The one-line token summary `/status` prints. */
  async function tokenStatusLine() {
    return summaryLine(summarize(await state.loadTokens()));
  }

  /**
   * Answer a message that is addressed to the bridge rather than to the agent.
   *
   * Both transports call this after their allowlist decision and before the approval
   * step, so a blocked chat cannot run commands either and a command never becomes a
   * turn. `/new` bumps the chat's generation (a *new* session id, so the old history is
   * not resumed) and `/stop` cancels the turn that is running in this chat's session.
   *
   * @returns {Promise<boolean>} true when the message was a command and has been answered.
   */
  async function runChatCommand({ transport, accountId, chatId, peerName, text, reply }) {
    const command = parseCommand(text);
    if (!command) return false;
    counters.commands += 1;
    ctx.logger?.info?.("[dsh-wechat-media] command /%s from %s (%s)", command.name, chatId, transport);
    noteRoute("/command", { command: command.name, chatId, transport });

    if (!command.known) {
      await reply(unknownCommandText(command.name));
      return true;
    }

    if (command.name === "help") {
      await reply(helpText());
      return true;
    }

    if (command.name === "status") {
      const generation = await generationOf(accountId, chatId);
      await reply(statusText({
        transport,
        accountId,
        chatId,
        sessionId: sessionIdFor(accountId, chatId, generation),
        generation,
        counters,
        lastInterjection: interjections.at(-1) ?? null,
        // Reported for both transports: "is the other side down?" is exactly what this
        // command is for, and the bot's state is one of the few visible failure signals.
        bot: wecomBotStatus,
        pendingApprovals: approvals.list().filter((waiting) => waiting.accountId === accountId && waiting.chatId === chatId).length,
        friendOnly: (await state.loadPrefs()).friendOnly === true,
        interject: (await state.loadPrefs()).interject === true,
        retry: (await state.loadPrefs()).retry !== false,
        feishuLine: feishuStatusLine(),
        authLine: await authStatusLine(),
        deliveryLine: await deliveryStatusLine(),
        formatLine: await formatStatusLine(),
        tokenLine: await tokenStatusLine(),
        lastInboundAt: new Date(lastInbound.get(accountId)?.at ?? Date.now()).toISOString(),
        inbox: await resolvedInbox(),
      }));
      return true;
    }

    if (command.name === "new") {
      const previous = await generationOf(accountId, chatId);
      const previousId = sessionIdFor(accountId, chatId, previous);
      const generation = previous + 1;
      await state.setRoute(accountId, chatId, {
        generation,
        sessionId: sessionIdFor(accountId, chatId, generation),
        peerName,
      });
      conversations.delete(previousId);
      const handle = conversationHandles.get(previousId);
      conversationHandles.delete(previousId);
      try {
        await handle?.dispose?.();
      } catch (error) {
        ctx.logger?.warn?.("[dsh-wechat-media] disposing the old session failed: %s", error?.message ?? error);
      }
      counters.commandsNew = (counters.commandsNew ?? 0) + 1;
      await reply(`🆕 已开始新会话（第 ${generation + 1} 段）。上一条会话的记录仍保留在磁盘上，但不会被带进新对话。`);
      return true;
    }

    if (command.name === "tokens") {
      const args = command.args.trim().toLowerCase();
      if (args === "reset" || args === "清零") {
        await state.resetTokens();
        await reply(`🧮 Token 统计已清零（窗口长度不变，仍是 ${(await state.loadTokens()).windowDays} 天）。`);
        return true;
      }
      const days = parseWindowDays(args);
      if (days !== undefined) {
        const clamped = clampWindowDays(days);
        const ledger = await state.setTokenWindow(clamped);
        await reply(
          clamped === days
            ? `🧮 Token 清零窗口已改为 ${clamped} 天，并从现在开始重新计时。`
            : `🧮 只支持 1–30 天，已按最接近的 ${clamped} 天设置（你给的是 ${days}）。`,
        );
        ctx.logger?.info?.("[dsh-wechat-media] token window -> %d days", ledger.windowDays);
        return true;
      }
      if (args && args !== "") {
        // Something that is neither a number nor "reset": answer with the usage rather than
        // silently doing nothing.
        await reply(`不认识的参数「${command.args}」。用法：/tokens · /tokens reset · /tokens 7（1–30 天）\n\n${await tokenReport()}`);
        return true;
      }
      await reply(await tokenReport());
      return true;
    }

    if (command.name === "format") {
      const wanted = command.args.trim().toLowerCase();
      const alias = { 清洗: "plain", 纯文本: "plain", 原样: "raw", 原始: "raw", markdown: "raw" };
      const next = ["plain", "raw"].includes(wanted) ? wanted : alias[command.args.trim()];
      if (next) {
        await state.savePrefs({ format: next });
        await reply(next === "plain"
          ? "🧹 文本处理 → **清洗**：`**加粗**`、`## 标题`、代码围栏、表格分隔行、`$$公式$$` 这些微信不渲染的标记会被去掉；普通句子逐字不变。"
          : "🧹 文本处理 → **原样**：模型写什么就发什么（markdown 标记会按字面出现）。");
        noteRoute("/command", { command: "format", value: next, chatId });
        return true;
      }
      await reply(wanted ? `不认识的选项「${command.args}」。\n\n${await formatReport()}` : await formatReport());
      return true;
    }

    if (command.name === "delivery") {
      const wanted = command.args.trim().toLowerCase();
      const current = (await state.loadPrefs()).delivery === "stream" ? "stream" : "whole";
      const alias = { 逐字: "stream", 流式: "stream", 一字一字: "stream", 打字: "stream", 整段: "whole", 一次: "whole", 完整: "whole" };
      const next = ["stream", "whole"].includes(wanted) ? wanted : alias[command.args.trim()];
      if (next) {
        await state.savePrefs({ delivery: next });
        await reply(next === "stream"
          ? "⌨️ 发送方式 → **逐字（流式）**：企业微信里答案会边写边出现（微信没有编辑已发消息的接口，那边仍是一次发完整答案）。"
          : "⌨️ 发送方式 → **整段**：答案写完一次发出来。");
        noteRoute("/command", { command: "delivery", value: next, chatId });
        return true;
      }
      await reply(wanted
        ? `不认识的发送方式「${command.args}」。\n\n${deliveryReport(current)}`
        : deliveryReport(current));
      return true;
    }

    if (command.name === "auth") {
      const wanted = command.args.trim().toLowerCase();
      const current = (await state.loadPrefs()).authorization ?? "moderate";
      if (!wanted) {
        await reply(authReport(current));
        return true;
      }
      const alias = { 严格: "strict", 适中: "moderate", 完全权限: "full", 仅查看: "readonly", readonly: "readonly", view: "readonly" };
      const level = AUTHORIZATION_LEVELS.includes(wanted) ? wanted : alias[command.args.trim()] ?? alias[wanted];
      if (!level) {
        await reply(`不认识的档位「${command.args}」。\n\n${authReport(current)}`);
        return true;
      }
      await state.savePrefs({ authorization: level });
      const policy = approvalPolicyFor(level);
      await reply(`🔐 授权档位 → ${policy.label}（${level}）\n${authExplain(level)}`);
      noteRoute("/command", { command: "auth", level, chatId });
      return true;
    }

    if (command.name === "interject") {
      const wanted = parseSwitch(command.args);
      const current = (await state.loadPrefs()).interject === true;
      const next = wanted ?? !current;
      await state.savePrefs({ interject: next });
      await reply(next
        ? "💬 插话功能 → 开。agent 还在回复时你发的消息会**立即插进当前回合**（它下一步就能看到），而不是排队等下一轮。关掉就在私聊里发 /interject off 或取消卡片上的勾选。"
        : "💬 插话功能 → 关。正在回复时发来的消息会**排队成下一轮**，等这轮说完再处理。");
      noteRoute("/command", { command: "interject", value: next, chatId });
      return true;
    }

    if (command.name === "retry") {
      const wanted = parseSwitch(command.args);
      const current = (await state.loadPrefs()).retry !== false;
      const next = wanted ?? !current;
      await state.savePrefs({ retry: next });
      await reply(next
        ? "🔁 失败自动重试 → 开。回合因为**传输类错误**（超时、连接被重置、限流、5xx）失败时，会自动重试**一次**，并在聊天里说明；确定性错误（请求被拒、模型不可用）不会重试，避免白花 token。"
        : "🔁 失败自动重试 → 关。回合失败时直接告诉你错误，不再自动重试。");
      noteRoute("/command", { command: "retry", value: next, chatId });
      return true;
    }
    if (command.name === "feishu") {
      const argsText = String(command.args ?? "").trim();
      if (/^test\b/i.test(argsText)) {
        const rest = argsText.replace(/^test\b/i, "").trim();
        const [receiveId = "", toType = ""] = rest.split(/\s+/);
        try {
          const sent = await feishuSendText({ text: `dsh-wechat-media 飞书自测 · ${new Date().toISOString()}`, to: receiveId, toType });
          noteRoute("/feishu", { action: "test", via: sent.via, to: sent.to });
          if (sent.via === "app") {
            await reply(`✅ 飞书自测已通过**应用机器人**发出（发往 ${sent.to}，message_id ${sent.messageId}）。`);
          } else if (sent.via === "webhook") {
            await reply("✅ 飞书自测已通过**自定义 webhook 机器人**发出。");
          } else {
            await reply(sent.reason);
          }
        } catch (error) {
          noteRoute("/feishu", { action: "test", error: String(error?.message ?? error) });
          await reply(`❌ 飞书自测失败：${error?.message ?? error}`);
        }
        return true;
      }
      const settings = feishuConfig();
      const channels = feishuChannels(settings);
      await reply([
        feishuStatusLine(),
        `应用机器人：${channels.app ? "已配置" : "未配置"}${channels.partial ? "（⚠️ app_id 与 app_secret 只填了一个）" : ""}`,
        `自定义 webhook：${channels.webhook ? "已配置" : "未配置"}`,
        // The long connection is the receive half: whether it is up, how often it reconnected, and
        // the last reason it failed - never a secret.
        feishuWsWanted() && !channels.app
          ? "长连接接收：不可用（需要应用机器人）"
          : feishuWsEnabled()
            ? `长连接接收：已连接${feishuWsStatus.reconnectAttempts ? `（重连 ${feishuWsStatus.reconnectAttempts} 次）` : ""}`
            : `长连接接收：${feishuWsReason()}`,
        feishuWsStatus.lastError ? `长连接最后错误：${feishuWsStatus.lastError}` : "",
        // A `stream` preference cannot be honoured here yet: a Feishu message can be edited in place,
        // but this half does not implement a live preview, so the answer goes whole. Saying so beats
        // letting the preference look broken.
        (await state.loadPrefs()).delivery === "stream"
          ? "发送方式：整段（飞书暂未实现逐字预览；/delivery whole 可去掉这条提示）"
          : "",
        `发送目标（feishu.to）：${settings.to || "（未设置）"}`,
        "",
        "用法：/feishu test [接收方 id] [chat_id|open_id|user_id|email] 发一条自测消息；id 类型省略时按前缀猜（oc_ / ou_ / 含 @）。",
        "发文件/图片用 feishu_send_file 工具（需要应用机器人；自定义 webhook 只能发文本）。",
        "密钥只显示「已设置/未设置」，不会回显；配置改动后需要重启 DSH。",
      ].join("\n"));
      noteRoute("/command", { command: "feishu", chatId });
      return true;
    }

    if (command.name === "friends") {
      const wanted = parseSwitch(command.args);
      const current = (await state.loadPrefs()).friendOnly === true;
      const next = wanted ?? !current;
      await state.savePrefs({ friendOnly: next });
      const handle = await state.getPeer(accountId, chatId);
      if (handle?.kind === "group" && next) {
        // The user just switched the rule on from a group; say so before the chat goes
        // quiet, or the silence would look like a bug.
        await reply(`👥 只处理好友私聊 → 开。这条群聊（以及其它群）之后只会被静默忽略，需要关掉就在私聊里发 /friends off，或在插件卡片上取消勾选。`);
        return true;
      }
      await reply(next
        ? "👥 只处理好友私聊 → 开。群消息会被静默忽略（只计数），单聊照常；关掉就在私聊里发 /friends off 或在插件卡片取消勾选。"
        : "👥 只处理好友私聊 → 关。群消息和单聊都会照常处理。");
      return true;
    }

    if (command.name === "stop") {
      const generation = await generationOf(accountId, chatId);
      const sessionId = sessionIdFor(accountId, chatId, generation);
      const agent = ctx.agents.get(sessionId);
      if (!agent) {
        await reply("现在没有这个会话的活着的 agent（还没聊过，或已经结束了）。");
        return true;
      }
      if (agent.status !== "running") {
        await reply("现在没有正在跑的回合。");
        return true;
      }
      try {
        agent.cancel?.(new Error(STOP_REASON));
        counters.commandsStopped = (counters.commandsStopped ?? 0) + 1;
        await reply(`⏹ ${STOP_REASON}`);
      } catch (error) {
        await reply(`打断失败：${error?.message ?? error}`);
      }
      return true;
    }

    // Unreachable while every entry of COMMANDS has a branch above; kept so a newly added
    // command cannot turn into a silent no-op if its branch is forgotten.
    await reply(unknownCommandText(command.name));
    return true;
  }

  /**
   * Answer an inbound WeCom frame, in as many stream messages as the text needs.
   *
   * One stream body holds 20480 **bytes** (and Chinese costs three each), so this loops
   * over every part. It used to take only the first part of `splitForStream(text)` in
   * three places, which truncated any longer answer - silently, which is the one thing
   * this plugin is not allowed to do. `tag` only makes the req_id traceable in a log.
   *
   * Deliberately synchronous: `false` from the socket (reconnecting or closed) has to
   * reach the caller's own error handling instead of becoming an unhandled rejection.
   */
  async function replyWecomInParts(frame, text, tag = "stream", firstReqId, chatId) {
    const parts = splitForStream(text);
    // The live streamer owns one req_id for the whole answer, and this send is what closes it. A
    // *different* id here is not a cosmetic detail: the platform then sees two messages - the
    // preview that never finishes, and the final answer - which is exactly the duplicate that
    // shipped in v0.13.4. Consuming the entry also means every reply path (answer, error, empty)
    // closes the stream, so no half-finished preview can be left behind.
    const live = liveFrames.get(frame);
    if (live) liveFrames.delete(frame);
    const head = firstReqId ?? live?.reqId;
    for (let index = 0; index < parts.length; index += 1) {
      const reqId = index === 0 && head ? head : generateReqId(`${tag}-${index}`);
      const closed = await closeWecomStream(frame, reqId, parts[index]);
      if (!closed) {
      // The platform would not keep the closing frame, and leaving it at that shows an unfinished
      // fragment. v0.16.0 "fell back" to the same passive reply path that had just been refused, which
      // could not work; the answer now goes out as an ordinary **proactive** message, which needs no
      // reply id at all. Counted, never hidden.
      counters.streamFallback += 1;
      const sent = chatId
        ? wecomBot?.sendMessage(chatId, textBody(parts[index]))
        : wecomBot?.reply(frame, markdownBody(parts[index]));
      if (sent === false) throw new Error("the WeCom long connection is not writable right now");      }
    }
  }

  /**
   * Close a stream, and do not mistake the platform's silence for success.
   *
   * The closing frame is what makes WeCom keep the message; sent immediately after a preview it can be
   * refused with errcode 6000 ("more than one caller at the same time"). So: let the queue settle,
   * read the answer, and back off before trying again. Only when every attempt fails does the caller
   * fall back to a plain message.
   *
   * @returns {Promise<boolean>} true when the platform acknowledged the closing frame
   */
  async function closeWecomStream(frame, reqId, content, { graceMs = 250, attempts = 3 } = {}) {
    if (!wecomBot) return false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, graceMs * (attempt + 1)));
      try {
        await wecomBot.replyAndWait(frame, streamBody(reqId, content, true), { timeoutMs: 8000 });
        counters.streamFinalized += 1;
        lastStreamFinalizeError = null;
        return true;
      } catch (error) {
        lastStreamFinalizeError = String(error?.message ?? error);
        counters.streamFinalizeFailed += 1;
        streamFinalizeErrors.push(lastStreamFinalizeError);
        if (streamFinalizeErrors.length > 6) streamFinalizeErrors.shift();
        ctx.logger?.warn?.("[dsh-wechat-media] closing the stream failed (attempt %d/%d): %s", attempt + 1, attempts, lastStreamFinalizeError);
        // A dead reply id cannot come back: stop retrying and let the caller send the answer the
        // proactive way.
        if (isStaleReplyError(lastStreamFinalizeError)) break;
      }
    }
    return false;
  }

  /**
   * The streamer that is currently allowed to show a live preview.
   *
   * One at a time on purpose: `agent/assistant-stream` carries no session id, so the plugin binds
   * the preview to the turn it started. A second chat answering at the same time simply does not
   * get a live preview (its final answer is unaffected).
   */
  let activeStreamer;

  /** The last live frame the adapter sent, for `/state` (see counters.streamDeltas). */
  let lastStreamFrame = null;

  /** Why the last closing frame was not accepted, for `/state`. */
  let lastStreamFinalizeError = null;
  /** The last few closing-frame failures, in order: the *sequence* says more than the last one. */
  const streamFinalizeErrors = [];

  /**
   * The live preview stream of each inbound frame, while it is open: `frame -> { reqId, text }`.
   * Weak so an abandoned frame cannot hold anything alive. The final send looks its req_id up here,
   * which is what keeps the preview and the answer on one stream instead of two messages.
   */
  const liveFrames = new WeakMap();

  /**
   * Close a preview whose turn ended without a text reply (a tool answered, or the turn produced
   * nothing). Without this the platform keeps an unfinished stream, which shows up as a message
   * that never settles.
   */
  function closeLiveStream(frame, text) {
    const live = liveFrames.get(frame);
    if (!live) return false;
    liveFrames.delete(frame);
    try {
      // Same acknowledged close as the normal answer: a refused close here would leave the same
      // unfinished fragment, just on a path where no text reply follows to cover it.
      return closeWecomStream(frame, live.reqId, text ?? live.text ?? "");
    } catch (error) {
      ctx.logger?.warn?.("[dsh-wechat-media] could not close the live stream: %s", error?.message ?? error);
      return false;
    }
  }

  /**
   * Show a WeCom answer while it is being written.
   *
   * The platform's `stream` message is incremental: the same req_id may be sent repeatedly with
   * `finish: false`, and the final send (which already carries the whole answer) closes it with
   * `finish: true`. Personal WeChat gets none of this - there is no way to edit a sent message -
   * so a WeChat chat keeps receiving whole answers, which `/delivery` says out loud.
   */
  function wecomStreamer(frame, plain = true) {
    // `at: 0` on purpose: the clock starts at the first delta, not when the streamer is created.
    // Measuring from creation made the *first* flush fire at once (the model takes longer than the
    // 600 ms window to produce its first token), which opened the bubble with two characters.
    const live = { text: "", sent: 0, at: 0, reqId: generateReqId("stream-live"), chunks: 0 };
    // One req_id per answer, shared with the final send (see replyWecomInParts).
    liveFrames.set(frame, live);
    return {
      push(delta) {
        live.text += delta;
        if (live.at === 0) live.at = Date.now();
        // The first preview waits for a real sentence: a two-character bubble that grows is worse
        // than no preview at all for the first moment.
        if (live.sent === 0 && live.text.length < 16) return;
        if (!shouldFlush({ accumulated: live.text.length, sent: live.sent, now: Date.now(), lastAt: live.at })) return;
        // The preview is the accumulated text, so cleaning it here is consistent with the final
        // send: a marker split across two frames cannot leak, because each flush is cleaned whole.
        const parts = splitForStream(plain ? toPlainText(live.text) : live.text);
        // A preview that no longer fits one stream body is skipped rather than truncated: the
        // final send carries the whole answer, and a cut-off preview would look like data loss.
        if (parts.length > 1) {
          counters.streamRefused += 1;
          return;
        }
        const part = parts[0] ?? "";
        if (!part) {
          counters.streamRefused += 1;
          return;
        }
        if (wecomBot?.reply(frame, streamBody(live.reqId, part, false)) === false) {
          counters.streamRefused += 1;
          return;
        }
        live.sent = live.text.length;
        live.at = Date.now();
        live.chunks += 1;
        counters.streamChunks += 1;
      },
      chunks() {
        return live.chunks;
      },
      reqId() {
        return live.reqId;
      },
    };
  }

  /** Send one text message, with a lazily-fetched typing ticket. */
    /**
     * The context token iLink needs in order to deliver a message.
     *
     * The protocol requires the token that arrived with a recent inbound message: **without it the platform
     * accepts the send and then drops it**, which is exactly how a whole round of testing looked like "the
     * API said success but nothing was received". The token was already being stored on every inbound message
     * (state.saveContextToken) - it was simply never read back.
     */
    async function contextTokenFor(account, chatId) {
      const accountId = account?.accountId ?? account?.botId;
      if (!accountId || !chatId) return undefined;
      try {
        const tokens = await state.loadContextTokens(accountId);
        const token = tokens?.[chatId] ?? tokens?.[String(chatId)];
        return typeof token === "string" && token ? token : undefined;
      } catch (error) {
        ctx.logger?.warn?.("[dsh-wechat-media] could not read the stored context token: %s", error?.message ?? error);
        return undefined;
      }
    }

    async function sendText(account, chatId, text, { typing = true } = {}) {
    const accountId = account.accountId ?? account.botId;
    // Typing indicators need `getconfig`'s ticket; both calls are optional, so a
    // protocol client without them simply skips the indicator.
    const canType = typing && typeof ilink.getConfig === "function" && typeof ilink.sendTyping === "function";
    if (canType) {
      try {
        const key = `${accountId}|${chatId}`;
        let cached = typingTickets.get(key);
        if (!cached || Date.now() - cached.at > 20 * 60 * 60 * 1000) {
          const fetched = await ilink.getConfig({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: account.userId });
          cached = { ticket: fetched?.typingTicket, at: Date.now() };
          typingTickets.set(key, cached);
        }
        if (cached?.ticket) {
          await ilink.sendTyping({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: account.userId, typingTicket: cached.ticket, status: 1 });
        }
      } catch {
        // typing is cosmetic; never let it break a reply
      }
    }
    let result;
    try {
      result = await ilink.sendText({ baseUrl: account.baseUrl, token: account.token, toWxid: chatId, text, contextToken: await contextTokenFor(account, chatId) });
    } finally {
      if (canType) {
        try {
          const cached = typingTickets.get(`${accountId}|${chatId}`);
          if (cached?.ticket) {
            await ilink.sendTyping({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: account.userId, typingTicket: cached.ticket, status: 2 });
          }
        } catch {
          // ignore
        }
      }
    }
    if (result && result.ret !== undefined && result.ret !== 0) {
      throw new Error(`sendmessage ret=${result.ret} ${result.errmsg ?? ""}`.trim());
    }
    ctx.logger?.info?.("[dsh-wechat-media] text sent to %s (%d chars)", chatId, String(text).length);
    return result;
  }

  // ── approvals asked over WeChat ───────────────────────────────────────────

  /**
   * Visible counters. Silently dropping a message, or answering it, must be
   * observable from GET /state - otherwise "did it work?" means log archaeology.
   */
  const counters = { received: 0, forwarded: 0, blocked: 0, answered: 0, unusable: 0, mediaDownloaded: 0, mediaFailed: 0, mediaBytes: 0, commands: 0, groupsSkipped: 0, interjected: 0, streamChunks: 0, streamDeltas: 0, streamRefused: 0, streamFinalized: 0, streamFinalizeFailed: 0, streamFallback: 0, voiceDecoded: 0, interjectFailed: 0, retried: 0, retryFailed: 0, feishuEvents: 0, feishuAnswered: 0, feishuIgnored: 0, feishuErrors: 0 };

/**
 * Every interjection decision, kept for later inspection.
 *
 * The counters live in memory and reset with the process, so "interjected stayed 0" proves nothing after a
 * restart - which is exactly the argument this answers. Each decision is appended to a JSONL file (durable)
 * and the last few are also returned by `GET /state` as `interjections`.
 */
const interjections = [];
async function recordInterjection({ chatId, platform, decision, reason, error }) {
  const entry = { at: Date.now(), chatId, platform, decision, reason, ...(error ? { error: String(error) } : {}) };
  interjections.push(entry);
  while (interjections.length > 25) interjections.shift();
  ctx.logger?.info?.("[dsh-wechat-media] interjection: %s (%s) for %s", decision, reason, chatId);
  try {
    const dir = join(stateRoot, "log");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "interjections.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error2) {
    ctx.logger?.warn?.("[dsh-wechat-media] could not write the interjection log: %s", error2?.message ?? error2);
  }
}
  /**
   * Where inbound media goes right now: the runtime preference (card / control
   * panel) beats the plugin config, which beats `$DSH_HOME/wechat-inbox`. Resolved
   * per use so changing it takes effect without a restart.
   */
  const resolvedInbox = async () => resolveInboxDir({ prefs: await state.loadPrefs(), config, dshHome });

  // ── WeCom (企业微信) ───────────────────────────────────────────────────────
  //
  // Outbound has two paths that need no public address: a group robot webhook (one
  // URL) and a self-built app (corpid/corpsecret/agentid). Inbound is the intelligent
  // robot's long connection (BotID + Secret over `wss://openws.work.weixin.qq.com`),
  // which needs no callback URL either - see wecom-bot.js. What WeCom *cannot* do
  // here is the callback API, which insists on a public HTTPS endpoint this machine
  // cannot offer.

  /** Every WeCom call gets a bounded wait so a stuck request cannot hang a turn. */
  const wecomTimeoutMs = 20000;
  /**
   * Media downloads get a longer budget than an API call: a file can be tens of
   * megabytes, and the url stays valid for five minutes.
   */
  const wecomMediaTimeoutMs = 60000;
  /**
   * The WeCom counterpart of `ilink.downloadMedia`, shaped for `media.saveInboundMedia`
   * (inbox layout, size cap, extension sniffing): fetch the url, decrypt the payload
   * with its own `aeskey` (AES-256-CBC, see wecom-media.js), write it into the inbox.
   */
  const wecomDownload = (options) => downloadWecomMedia({
    ...options,
    maxBytes: maxMediaBytes,
    timeoutMs: wecomMediaTimeoutMs,
  });
  const wecomTokenCache = wecom.createTokenCache();
  async function wecomToken(config) {
    const cached = wecomTokenCache.get();
    if (cached) return cached;
    const { token, expiresIn } = await wecom.getToken({
      corpId: config.corpId,
      corpSecret: config.corpSecret,
      timeoutMs: wecomTimeoutMs,
    });
    wecomTokenCache.set(token, expiresIn);
    return token;
  }

  // ── WeCom intelligent robot over the long connection ───────────────────────
  //
  // Two-way, with no public URL: the robot's BotID + Secret open a WebSocket to
  // openws.work.weixin.qq.com. Messages are routed through exactly the same session
  // machinery as personal WeChat by using a pseudo account id (`wecom:<botId>`), so
  // peers, routes, the allowlist, approvals and the reply collector all apply
  // unchanged.

  /**
   * The pseudo account id for a WeCom bot.
   *
   * It goes through the state layer's own `normalizeAccountId`, which turns ":" into
   * "-": a peer written under `wecom:<botId>` would otherwise be invisible to the
   * lookup that reads `wecom-<botId>`, and the first WeCom message was blocked exactly
   * that way. Runtime keys and persisted keys must be the same string.
   */
  function wecomAccountId(botId) {
    return normalizeAccountId(`wecom:${String(botId ?? "").trim()}`);
  }

  let wecomBot;
  let wecomBotStatus = { connected: false, authenticated: false, attempts: 0, botId: null };
  /** The last failure while handling a WeCom message, surfaced in /state: the
   * long-connection callback has nowhere else to report it. */
  let wecomInboundError = null;

  /**
   * The WeCom projection both `/state` and `/debug/inbound` report. One function, so
   * the two can never drift apart, and "is WeCom configured?" counts every path that
   * can actually send something - including the intelligent-robot long connection,
   * which the first version of this report forgot.
   */
  async function wecomState() {
    const cfg = await state.loadWecom();
    const botReady = Boolean(cfg.botId && cfg.botSecret);
    return {
      configured: Boolean(cfg.webhookUrl || botReady || (cfg.corpSecret && cfg.agentId)),
      via: cfg.webhookUrl
        ? "group-robot webhook"
        : botReady
          ? "intelligent-robot long connection"
          : cfg.corpSecret && cfg.agentId
            ? "self-built app"
            : null,
      webhook: cfg.webhookUrl ? `${cfg.webhookUrl.slice(0, 48)}…` : null,
      corpId: cfg.corpId || null,
      agentId: cfg.agentId || null,
      toUser: cfg.toUser || null,
      secretSet: Boolean(cfg.corpSecret),
      // The BotID is an identifier, not a secret, so it is reported in full -
      // we need to be able to see whether the stored value is complete.
      botIdFull: cfg.botId || null,
      botIdLength: cfg.botId ? String(cfg.botId).length : 0,
      secretLength: cfg.botSecret ? String(cfg.botSecret).length : 0,
      botConfigured: botReady,
      botEnabled: Boolean(cfg.botEnabled),
      bot: wecomBotStatus,
      inboundError: wecomInboundError,
      // How the last conversation had to be opened when a plain resume did not work.
      sessionIssue: lastSessionIssue,
    };
  }

  function stopWecomBot() {
    if (!wecomBot) return;
    try {
      wecomBot.close();
    } catch {
      // already gone
    }
    wecomBot = undefined;
    wecomBotStatus = { connected: false, authenticated: false, attempts: 0, botId: null };
  }

  /** Connect (or reconnect after a configuration change). */
  async function startWecomBot({ force = false } = {}) {
    if (wecomBot && !force) return wecomBot;
    stopWecomBot();
    const cfg = await state.loadWecom();
    if (!cfg.botEnabled || !cfg.botId || !cfg.botSecret) return undefined;
    const accountId = wecomAccountId(cfg.botId);
    const bot = new WecomBot({
      botId: cfg.botId,
      secret: cfg.botSecret,
      logger: ctx.logger,
      onStatus: (status) => {
        wecomBotStatus = status;
      },
      onMessage: (message, frame) => {
        void handleWecomInbound(accountId, message, frame).catch((error) => {
          ctx.logger?.warn?.("[dsh-wechat-media] wecom inbound failed: %s", error?.message ?? error);
        });
      },
    });
    try {
      bot.connect();
      wecomBot = bot;
      ctx.logger?.info?.("[dsh-wechat-media] wecom bot connecting as %s", cfg.botId);
    } catch (error) {
      ctx.logger?.warn?.("[dsh-wechat-media] wecom bot did not start: %s", error?.message ?? error);
      return undefined;
    }
    return bot;
  }

  /** The long connection's counterpart of handleInbound. */
  async function handleWecomInbound(accountId, message, frame) {
    try {
      await handleWecomInboundInner(accountId, message, frame);
      wecomInboundError = null;
    } catch (error) {
      wecomInboundError = { at: new Date().toISOString(), message: String(error?.message ?? error), stack: String(error?.stack ?? "").slice(0, 400) };
      ctx.logger?.warn?.("[dsh-wechat-media] wecom inbound failed: %s", wecomInboundError.message);
      try {
        wecomBot?.reply(frame, streamBody(generateReqId("stream-fail"), `❌ 处理这条企业微信消息时出错：${wecomInboundError.message}`, true));
      } catch {
        // the socket may already be gone
      }
    }
  }

  async function handleWecomInboundInner(accountId, message, frame) {
    if (!message) return;
    if (message.msgId) {
      const bucket = seen.get(accountId);
      if (bucket?.has(message.msgId)) return;
      rememberSeen(accountId, message.msgId);
    }
    const chatId = String(message.chatId ?? "");
    if (!chatId) return;
    const isGroup = message.chatType === "group";
    const peerName = isGroup ? `企业微信群 ${chatId}` : `企业微信 ${chatId}`;
    counters.received += 1;
    lastInbound.set(accountId, { accountId, chatId, peerName, isGroup, at: Date.now() });
    await state.setPeer(accountId, chatId, {
      name: peerName,
      kind: isGroup ? "group" : "direct",
      seenAt: new Date().toISOString(),
    });

    // One decision for the whole message: allowlist, "1"/"2" approval answer, or a turn -
    // the same rule and the same order as the personal-WeChat path (classifyInbound).
    const verdict = await classifyWecomInbound({
      accountId,
      message,
      text: message.text,
      state,
      consumeApproval: consumeApprovalReply,
    });
    if (verdict.action === "ignore") {
      counters.blocked += 1;
      // A group skipped by "only answer friends" is still a dropped message (so the card
      // keeps counting it), but it gets its own number: the user turned the rule on, and
      // /status has to be able to say how much it is dropping.
      if (verdict.reason === "group-skipped") counters.groupsSkipped += 1;
      await state.setPeer(accountId, chatId, noteBlocked(await state.getPeer(accountId, chatId)));
      ctx.logger?.info?.("[dsh-wechat-media] ignored wecom message from %s (%s)", chatId, verdict.reason);
      return;
    }
    if (verdict.action === "answer") {
      counters.answered += 1;
      ctx.logger?.info?.("[dsh-wechat-media] wecom approval answer consumed for %s", chatId);
      return;
    }

    // A "/command" is addressed to the bridge, never to the agent.
    if (verdict.text) {
      const handled = await runChatCommand({
        transport: "wecom",
        accountId,
        chatId,
        peerName,
        text: verdict.text,
        reply: (answer) => replyWecomInParts(frame, answer, "stream-cmd", undefined, chatId).catch((error) => {
        ctx.logger?.warn?.("[dsh-wechat-media] could not send the command reply: %s", error?.message ?? error);
      }),
      });
      if (handled) return;
    }

    const lines = [];
    if (message.text) lines.push(message.text);
    // Images, files and videos are downloaded and decrypted into the same inbox the
    // personal-WeChat side uses, then handed to the model as paths. A failure says so
    // instead of pretending there was no attachment.
    for (const item of message.media ?? []) {
      const label = item.type === "image" ? "图片" : item.type === "file" ? "文件" : item.type === "voice" ? "语音" : item.type === "video" ? "视频" : item.type;
      try {
        const saved = await saveInboundMedia({
          download: wecomDownload,
          kind: item.type,
          chatId,
          item,
          dshHome,
          maxBytes: maxMediaBytes,
          inboxPath: await resolvedInbox(),
        });
        counters.mediaDownloaded += 1;
        counters.mediaBytes += Number(saved.bytes) || 0;
        lines.push(describeForModel(saved, "企业微信"));
        ctx.logger?.info?.("[dsh-wechat-media] wecom %s saved to %s (%d bytes)", item.type, saved.path, saved.bytes);
      } catch (error) {
        counters.mediaFailed += 1;
        lines.push(`[企业微信${label}未保存] ${error?.message ?? error}`);
        ctx.logger?.warn?.("[dsh-wechat-media] wecom %s download failed: %s", item.type, error?.message ?? error);
      }
    }
    if (lines.length === 0) {
      counters.unusable += 1;
      return;
    }

    counters.forwarded += 1;
    const { agent, sessionId } = await ensureAgent(accountId, chatId, peerName);
    // Exactly the personal-WeChat path: the harness's own `createUserMessage` assigns
    // the message id and metadata the model request needs. Handing `followup` a bare
    // literal (and correlating on the WeCom msgid instead of that id) produced
    // `DeepSeek Messages transport failed` on every turn.
    const prompt = `[${peerName}]\n${lines.join("\n\n")}`;
    const message2 = await userMessage(prompt);
    // Interjection: if a turn is already running for this chat and the switch is on, hand this
    // message to *that* turn (`steer`) instead of queueing a second one. The running handler
    // relays the turn's reply, so no waiter is registered here - which is what keeps the two
    // from fighting over one session.
    const interjectInput = {
      enabled: (await state.loadPrefs()).interject === true,
      turnInFlight: collectors.isWaiting(sessionId),
      agentAvailable: typeof agent.steer === "function",
    };
    const interject = interjectDecision(interjectInput);
    await recordInterjection({ chatId, platform: "wecom", decision: interject, reason: interjectReason({ ...interjectInput, decision: interject }) });
    if (interject === "steer") {
      try {
        await agent.steer(message2);
        counters.interjected += 1;
        ctx.logger?.info?.("[dsh-wechat-media] steered a wecom message into the running turn for %s", chatId);
        return;
      } catch (error) {
        // Steering loses a race with the end of a turn sooner or later. Falling through to the queue is
        // what keeps "interject" from ever meaning "dropped on the floor".
        counters.interjectFailed += 1;
        await recordInterjection({ chatId, platform: "wecom", decision: "steer", reason: "steering failed, queued instead", error: error?.message ?? error });
        ctx.logger?.warn?.("[dsh-wechat-media] steering failed, queueing instead: %s", error?.message ?? error);
      }
    }
    // Delivery mode: "stream" shows the answer as it is written (WeCom only), "whole" waits and
    // sends it once - which is what every earlier release did.
    const prefsForTurn = await state.loadPrefs();
    const delivery = prefsForTurn.delivery === "stream" ? "stream" : "whole";
    const plain = prefsForTurn.format !== "raw";
    const streamer = delivery === "stream" ? wecomStreamer(frame, plain) : undefined;
    activeStreamer = streamer;
    let outcome = await (async () => {
      const waiting = collectors.wait(sessionId, message2?.id);
      await agent.followup(message2);
      return waiting;
    })();
    // A turn that dies in the transport leaves the person with nothing at all. One retry fixes the common
    // case; shouldRetryTurn keeps it to one, and only for a cause that looks transient.
    if (outcome.error && shouldRetryTurn({ error: outcome.error, attempt: 1, enabled: prefsForTurn.retry !== false })) {
      counters.retried += 1;
      ctx.logger?.warn?.("[dsh-wechat-media] turn failed (%s); retrying once", outcome.error);
      await replyWecomInParts(frame, `⚠️ 上一轮失败：${outcome.error}\n正在重试一次…`, "stream-retry", undefined, chatId);
      // A fresh user message: handing the same object back could be taken as already seen.
      const retryMessage = await userMessage(prompt);
      const retryWaiting = collectors.wait(sessionId, retryMessage?.id);
      await agent.followup(retryMessage);
      outcome = await retryWaiting;
      if (outcome.error) counters.retryFailed += 1;
    }
    activeStreamer = undefined;
    if (streamer) ctx.logger?.info?.("[dsh-wechat-media] streamed %d chunk(s) to %s before the final answer", streamer.chunks(), chatId);
    // Never leave the chat without an answer: mirror what the personal-WeChat path
    // does when a turn errors or produces no text.
    if (outcome.error) {
      await replyWecomInParts(frame, `❌ agent 出错：${outcome.error}`, "stream-error", undefined, chatId);
      return;
    }
    if (!outcome.text) {
      if (outcome.deliveredByTool) { closeLiveStream(frame); return; }
      await replyWecomInParts(frame, `（本轮没有文本回复：${outcome.stopReason}）`, "stream-empty", undefined, chatId);
      return;
    }
    // A WeCom intelligent robot only accepts `stream` for a passive reply, and one stream
    // body holds 20480 bytes; a longer answer becomes several messages.
    await replyWecomInParts(frame, await chatBody(outcome.text), "stream", undefined, chatId);
  }
  // Lifecycle-managed when the scope offers `effect`; otherwise started eagerly, so a
  // harness without it still gets the long connection instead of losing the feature.
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      void startWecomBot();
      return () => stopWecomBot();
    }, "dsh-wechat-media: wecom bot");
  } else {
    void startWecomBot();
  }

  // ── Feishu (飞书 / Lark) ─────────────────────────────────────────────────────
  //
  // Two kinds of bot, one sender. A **custom webhook bot** needs nothing but its URL and can only
  // carry text / rich text; an **app bot** (app_id + app_secret) can also send files and is the half
  // that will receive events. Configuration comes from `config.feishu` with environment fallbacks,
  // and no secret is ever logged or echoed back - only whether it is set.

  /**
   * The Feishu settings saved from the Web UI panel or a card, kept in a module-level cache.
   *
   * `feishuConfig()` is synchronous and called from many places (tools, `/state`, the long
   * connection), while prefs are loaded asynchronously - so the saved half is mirrored here and
   * refreshed whenever it changes. Before this, the only ways in were the plugin config file and
   * environment variables, which meant `setx` and a DSH restart just to try a bot.
   */
  let feishuSavedPrefs = {};

  /** Re-read the saved Feishu settings. Called at apply time and after every save. */
  async function refreshFeishuSavedPrefs() {
    try {
      const prefs = await state.loadPrefs();
      feishuSavedPrefs = prefs?.feishu && typeof prefs.feishu === "object" ? prefs.feishu : {};
    } catch (error) {
      ctx.logger?.warn?.("[dsh-wechat-media] could not read the saved Feishu settings: %s", error?.message ?? error);
      feishuSavedPrefs = {};
    }
    return feishuSavedPrefs;
  }

  /** The Feishu settings saved in prefs (empty string means "cleared", so it falls through). */
  function feishuSaved() {
    return feishuSavedPrefs ?? {};
  }

  /** Where the value in force came from - the panel should be able to say so. */
  function feishuSourceFor(key) {
    const saved = String(feishuSaved()[key] ?? "").trim();
    if (saved) return "saved";
    if (String((config.feishu ?? {})[key] ?? "").trim()) return "config";
    return "env";
  }

  /**
   * The Feishu configuration in force: what the panel saved first, then `config.feishu`, then the
   * environment. An empty saved value counts as "not set", so clearing a field in the panel falls
   * back to config and the environment rather than pinning an empty string.
   */
  function feishuConfig() {
    const given = config.feishu ?? {};
    const saved = feishuSaved();
    const env = process.env;
    const pick = (...values) => {
      for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) return text;
      }
      return "";
    };
    // `longConnection` is a boolean, so it cannot ride on `pick`: saved wins, then config, then env.
    const savedLong = saved.longConnection;
    const longConnection = savedLong === true || savedLong === false
      ? savedLong
      : !(given.longConnection === false || String(env.FEISHU_LONG_CONNECTION ?? "").toLowerCase() === "false");
    return {
      webhookUrl: pick(saved.webhookUrl, given.webhookUrl, env.FEISHU_WEBHOOK_URL),
      secret: pick(saved.secret, given.secret, env.FEISHU_WEBHOOK_SECRET),
      appId: pick(saved.appId, given.appId, env.FEISHU_APP_ID),
      appSecret: pick(saved.appSecret, given.appSecret, env.FEISHU_APP_SECRET),
      tenantHost: pick(saved.tenantHost, given.tenantHost, env.FEISHU_TENANT_HOST),
      domain: pick(saved.domain, given.domain, env.FEISHU_DOMAIN) || "feishu",
      to: pick(saved.to, given.to, env.FEISHU_TO),
      // The long connection is what lets an app bot receive without a public address. It is on
      // whenever credentials exist and can be switched off explicitly, in the panel, config or env.
      longConnection,
      verificationToken: pick(saved.verificationToken, given.verificationToken, env.FEISHU_VERIFICATION_TOKEN),
      encryptKey: pick(saved.encryptKey, given.encryptKey, env.FEISHU_ENCRYPT_KEY),
      // For diagnosis only: which half is in force, per field.
      sources: {
        appId: feishuSourceFor("appId"),
        appSecret: feishuSourceFor("appSecret"),
        webhookUrl: feishuSourceFor("webhookUrl"),
        domain: feishuSourceFor("domain"),
        to: feishuSourceFor("to"),
      },
    };
  }

  /**
   * A prefs snapshot safe to hand back over the loopback API.
   *
   * The Feishu secrets are the only values in prefs that must never be echoed - `/prefs` used to return
   * the whole object, so saving a secret sent it straight back in the response (a test caught it). The
   * field is replaced rather than deleted, so a reader can still see that something is saved.
   */
  function publicPrefs(prefs = {}) {
    const feishu = prefs?.feishu && typeof prefs.feishu === "object" ? prefs.feishu : undefined;
    if (!feishu) return prefs;
    const safe = { ...feishu };
    for (const key of ["appSecret", "secret", "verificationToken", "encryptKey"]) {
      if (key in safe) safe[key] = safe[key] ? "***" : "";
    }
    return { ...prefs, feishu: safe };
  }

  /** The Feishu fields a route may set, with the prefs key each one maps to. */
  const FEISHU_PREF_FIELDS = Object.freeze({
    feishuAppId: "appId",
    feishuAppSecret: "appSecret",
    feishuWebhookUrl: "webhookUrl",
    feishuWebhookSecret: "secret",
    feishuDomain: "domain",
    feishuTenantHost: "tenantHost",
    feishuTo: "to",
    feishuVerificationToken: "verificationToken",
    feishuEncryptKey: "encryptKey",
  });

  /** The Feishu fields a route may set that are booleans rather than strings. */
  const FEISHU_PREF_SWITCHES = Object.freeze({ feishuLongConnection: "longConnection" });

  /**
   * Merge Feishu fields from route arguments into the saved settings.
   *
   * An empty string **clears** a field (that is how the panel's "clear" works), anything else sets
   * it. Returns the patch and what changed, so the caller can decide whether a reconnect is worth
   * it - and a validation error for a domain that is neither `feishu`, `lark` nor an explicit URL.
   */
  function feishuPrefsPatch(args = {}) {
    const patch = { ...(feishuSaved() ?? {}) };
    const changed = [];
    for (const [field, key] of Object.entries(FEISHU_PREF_FIELDS)) {
      if (args[field] === undefined) continue;
      const value = String(args[field] ?? "").trim();
      if (key === "domain" && value && !/^https?:\/\//i.test(value) && !["feishu", "lark"].includes(value)) {
        return { error: `feishuDomain must be "feishu", "lark" or an https URL, got "${value}"` };
      }
      if (value) patch[key] = value;
      else delete patch[key];
      changed.push(field);
    }
    for (const [field, key] of Object.entries(FEISHU_PREF_SWITCHES)) {
      if (args[field] === undefined) continue;
      const wanted = parseSwitch(args[field]);
      if (wanted === undefined) return { error: `${field} must be "true" or "false"` };
      patch[key] = wanted;
      changed.push(field);
    }
    return { patch, changed };
  }

  /**
   * Apply a Feishu patch and make it take effect **without a restart**: the saved cache is
   * refreshed, then the long connection is restarted with the new settings.
   */
  async function applyFeishuPrefs(args = {}) {
    const result = feishuPrefsPatch(args);
    if (result.error) return { error: result.error };
    if (!result.changed.length) return { changed: [], feishu: await feishuState() };
    await state.savePrefs({ feishu: result.patch });
    await refreshFeishuSavedPrefs();
    // Restarting is the point: a new app id/secret must connect now, and clearing one must drop the
    // old connection rather than leave it running against credentials the user just removed.
    await startFeishuLongConnection({ force: true });
    return { changed: result.changed, feishu: await feishuState() };
  }

  /** Which Feishu channels this machine can actually use, and which one is missing. */
  function feishuChannels(settings = feishuConfig()) {
    const app = Boolean(settings.appId && settings.appSecret);
    const webhook = Boolean(settings.webhookUrl);
    return {
      app,
      webhook,
      // Half-configured credentials are the most confusing state, so they are named rather than
      // folded into "not configured".
      partial: Boolean(settings.appId) !== Boolean(settings.appSecret),
    };
  }

  /** What to do when nothing is configured - actionable, never an exception. */
  function feishuSetupHint() {
    return "飞书还没有配置。二选一：\n" +
      "① 自定义机器人（只能发文本/富文本）：飞书群里「设置 → 群机器人 → 添加机器人 → 自定义机器人」，把 webhook 地址填到插件配置 feishu.webhookUrl（或环境变量 FEISHU_WEBHOOK_URL）；有签名校验时再填 feishu.secret。\n" +
      "② 应用机器人（能发文件、将来能收消息）：飞书开放平台建自建应用，开通 im:message 权限并发布版本，把 app_id/app_secret 填到 feishu.appId / feishu.appSecret（或 FEISHU_APP_ID / FEISHU_APP_SECRET）；发送目标填 feishu.to（chat_id / open_id / user_id / email）。\n" +
      "配置改完需要重启 DSH 生效。";
  }

  /**
   * The `tenant_access_token`, reused until shortly before it expires.
   *
   * Feishu hands one out per app and it lasts ~2 hours, so fetching it per message would be both slow
   * and rate-limited. The cache is keyed by the credentials, so changing them cannot reuse a stale token.
   */
  let feishuTokenCache = { key: "", token: "", expiresAt: 0 };
  async function feishuToken(settings = feishuConfig()) {
    // The secret is hashed into the key rather than stored in it: a rotated secret must not keep reusing
    // the old token, and the cache has no business holding the secret in plain sight either.
    const key = `${settings.appId}|${settings.domain}|${createHash("sha256").update(String(settings.appSecret)).digest("hex").slice(0, 16)}`;
    const now = Date.now();
    if (feishuTokenCache.token && feishuTokenCache.key === key && feishuTokenCache.expiresAt - 60_000 > now) {
      return feishuTokenCache.token;
    }
    const fresh = await feishuTenantToken({ appId: settings.appId, appSecret: settings.appSecret, domain: settings.domain });
    feishuTokenCache = { key, token: fresh.token, expiresAt: fresh.expiresAt };
    return fresh.token;
  }

  /**
   * Send text through whichever Feishu channel is configured.
   *
   * The app path wins when it exists: it can do everything a webhook can, it reports a `message_id`,
   * and it is the same credentials the receive half will use. A webhook is the fallback for a machine
   * that only has a group robot.
   */
  async function feishuSendText({ text, markdown = false, webhookUrl, to, toType } = {}) {
    const settings = feishuConfig();
    const channels = feishuChannels(settings);
    const body = String(text ?? "");
    const msgType = markdown ? "post" : "text";
    if (channels.app) {
      const receiveId = String(to ?? settings.to ?? "").trim();
      if (!receiveId) {
        throw new Error("the Feishu app bot needs a receive id - pass `to` (chat_id / open_id / user_id / email) or set feishu.to");
      }
      const token = await feishuToken(settings);
      const sent = await feishuSendMessage({
        token,
        receiveId,
        receiveIdType: String(toType ?? "").trim() || feishuReceiveIdType(receiveId),
        msgType,
        content: markdown ? feishuPostContent(body) : feishuTextContent(body),
        domain: settings.domain,
      });
      return { via: "app", kind: msgType, to: receiveId, messageId: sent.messageId };
    }
    const url = String(webhookUrl ?? settings.webhookUrl ?? "").trim();
    if (url) {
      // The webhook takes `content` as an object while the message API takes it as a JSON string, so the
      // shape is parsed back out of the same builder rather than written a second time here.
      await feishuWebhookSend({
        webhookUrl: url,
        secret: settings.secret,
        msgType,
        content: JSON.parse(markdown ? feishuPostContent(body) : feishuTextContent(body)),
      });
      return { via: "webhook", kind: msgType };
    }
    return { via: "none", reason: feishuSetupHint() };
  }

  /**
   * Guess the `receive_id_type` from the id itself, so `to` alone is usually enough.
   *
   * Feishu ids are self-describing: `oc_` is a chat, `ou_`/`on_` a user in an app's own namespace.
   * Anything unrecognised goes as `chat_id`, which is what a bot is normally given.
   */
  function feishuReceiveIdType(receiveId = "") {
    const text = String(receiveId);
    if (text.startsWith("ou_") || text.startsWith("on_")) return "open_id";
    if (text.includes("@")) return "email";
    return "chat_id";
  }

  /**
   * Send a local file through Feishu.
   *
   * Images are uploaded as images so they render inline; everything else travels as an uploaded file
   * with the `file_type` Feishu expects (audio and video are message types of their own, but they are
   * uploaded the same way). A custom webhook bot cannot carry a file at all - that is a platform limit,
   * and the only honest answer is to say so and name the fix.
   */
  async function feishuSendFile({ filePath, to, toType, kind, filename } = {}) {
    const settings = feishuConfig();
    const channels = feishuChannels(settings);
    if (!channels.app) {
      if (channels.webhook) {
        return {
          via: "webhook",
          refused: true,
          reason: "自定义机器人（webhook）发不了文件——这是飞书平台的限制：webhook 只能发文本/富文本。要发文件请在插件配置里填 feishu.appId / feishu.appSecret（应用机器人）后重启。",
        };
      }
      return { via: "none", reason: feishuSetupHint() };
    }
    const prepared = await prepareOutbound(String(filePath ?? "").trim(), { maxBytes: maxMediaBytes });
    const receiveId = String(to ?? settings.to ?? "").trim();
    if (!receiveId) {
      throw new Error("the Feishu app bot needs a receive id - pass `to` (chat_id / open_id / user_id / email) or set feishu.to");
    }
    const receiveIdType = String(toType ?? "").trim() || feishuReceiveIdType(receiveId);
    const name = String(filename ?? "").trim() || prepared.name;
    const wanted = String(kind ?? "").trim().toLowerCase() || (prepared.kind === "image" ? "image" : "file");
    const bytes = await readFile(prepared.path);
    const token = await feishuToken(settings);
    if (wanted === "image") {
      const uploaded = await feishuUploadImage({ token, bytes, filename: name, domain: settings.domain });
      const sent = await feishuSendMessage({
        token,
        receiveId,
        receiveIdType,
        msgType: "image",
        content: feishuMediaContent("image", uploaded.imageKey),
        domain: settings.domain,
      });
      return { via: "app", kind: "image", to: receiveId, messageId: sent.messageId, bytes: prepared.bytes };
    }
    const fileType = feishuFileType(name, { kind: wanted });
    const uploaded = await feishuUploadFile({ token, bytes, filename: name, fileType, domain: settings.domain });
    // `audio` and `media` (video) are their own message types; all three carry a `file_key`.
    const msgType = wanted === "audio" ? "audio" : wanted === "video" ? "media" : "file";
    const sent = await feishuSendMessage({
      token,
      receiveId,
      receiveIdType,
      msgType,
      content: feishuMediaContent("file", uploaded.fileKey),
      domain: settings.domain,
    });
    return { via: "app", kind: msgType, to: receiveId, messageId: sent.messageId, bytes: prepared.bytes, fileType };
  }

  /** One line for `/status`: which Feishu channels are configured - never a secret, only whether it is set. */
  function feishuStatusLine() {
    const settings = feishuConfig();
    const channels = feishuChannels(settings);
    const which = channels.app && channels.webhook
      ? "应用机器人 + 自定义 webhook"
      : channels.app
        ? "应用机器人（可发文件；已启用长连接接收）"
        : channels.webhook
          ? "自定义 webhook（只能发文本/富文本）"
          : "未配置（/feishu 看怎么配）";
    const flags = [
      `${new URL(feishuDomain(settings.domain)).host}`,
      `签名 ${settings.secret ? "已设置" : "未设置"}`,
      `校验令牌 ${settings.verificationToken ? "已设置" : "未设置"}`,
      `加密密钥 ${settings.encryptKey ? "已设置" : "未设置"}`,
    ];
    if (channels.partial) flags.push("⚠️ app_id/app_secret 只填了一个");
    return `飞书：${which} · ${flags.join(" · ")}`;
  }

  // ── Feishu inbound: the app bot's long connection ────────────────────────────
  //
  // A custom webhook bot cannot receive anything at all - that is a platform limit, not a gap here.
  // An app bot subscribes to events over a WebSocket instead, which needs no public address and no
  // tunnel: the same trade the WeCom side makes with its long connection. The socket, ping and
  // reconnect behaviour live in feishu-ws.js; this section is what happens to an event.

  /** The account a Feishu app bot's chats live under, namespaced like the WeCom one. */
  function feishuAccountId(appId) {
    return normalizeAccountId(`feishu:${String(appId ?? "").trim()}`);
  }

  let feishuWs;
  let feishuWsStatus = { state: "idle", connected: false, lastError: "", reconnectAttempts: 0, appId: null, stats: null };
  /** The last failure while handling a Feishu event: a long-connection callback has nowhere else to report it. */
  let feishuInboundError = null;
  let feishuLastEventAt = null;

  /** Whether this configuration wants a long connection: app credentials present, and not switched off. */
  function feishuWsWanted(settings = feishuConfig()) {
    if (settings.longConnection === false) return false;
    return Boolean(settings.appId && settings.appSecret);
  }

  /** Why the long connection is not up, in one phrase, for `/feishu`. */
  function feishuWsReason() {
    const settings = feishuConfig();
    if (!feishuChannels(settings).app) return "未配置应用机器人（需要 app_id/app_secret）";
    if (settings.longConnection === false) return "已按配置关闭（feishu.longConnection=false 或 FEISHU_LONG_CONNECTION=false）";
    const state_ = feishuWsStatus.state;
    if (state_ === "connecting") return "连接中…";
    if (state_ === "reconnecting") return `重连中（第 ${feishuWsStatus.reconnectAttempts} 次）`;
    if (state_ === "failed") return `未建立：${feishuWsStatus.lastError || "原因未知"}`;
    if (state_ === "closed") return "已关闭";
    return "未启动";
  }

  /** The Feishu half of `/state`: configuration, the connection, and the last failure. Never a secret. */
  async function feishuState() {
    const settings = feishuConfig();
    const channels = feishuChannels(settings);
    // Only the *counters* go stale between events; the connection state is written by the lifecycle paths, and
    // copying a live snapshot wholesale would overwrite a recorded "failed" with a stale "connecting" - hiding
    // exactly the failure this state exists to report. So the counters are refreshed, nothing else.
    if (feishuWs && typeof feishuWs.status === "function") {
      const liveStatus = feishuWs.status();
      feishuWsStatus = { ...feishuWsStatus, stats: liveStatus?.stats ?? feishuWsStatus.stats };
    }
    return {
      configured: channels.app || channels.webhook,
      app: channels.app,
      webhook: channels.webhook,
      partial: channels.partial,
      domain: feishuDomain(settings.domain),
      tenantHost: settings.tenantHost || null,
      // Identifiers, not secrets: the app_id is needed to tell two apps apart, and the secret is
      // reported only as "set", never echoed.
      appId: settings.appId || null,
      secretSet: Boolean(settings.appSecret),
      webhookSecretSet: Boolean(settings.secret),
      to: settings.to ?? null,
      webhookUrlPrefix: settings.webhookUrl ? `${settings.webhookUrl.slice(0, 48)}…` : null,
      verificationTokenSet: Boolean(settings.verificationToken),
      encryptKeySet: Boolean(settings.encryptKey),
      longConnection: feishuWsEnabled(),
      longConnectionWanted: feishuWsWanted(settings),
      // What the panel saved (field **names** only - a value never leaves the host) and where each
      // setting in force came from, so the UI can say "saved here" rather than guess.
      savedFields: Object.keys(feishuSaved()).sort(),
      sources: settings.sources,
      connection: feishuWsStatus,
      lastEventAt: feishuLastEventAt,
      inboundError: feishuInboundError,
      counters: {
        events: counters.feishuEvents,
        answered: counters.feishuAnswered,
        ignored: counters.feishuIgnored,
        errors: counters.feishuErrors,
      },
    };
  }

  /**
   * Is the long connection actually up?
   *
   * The answer must come from the connection state, not from whether a handle exists: a handshake
   * that was refused still leaves an object behind, and reporting that as connected is exactly the
   * kind of unmeasured success this project keeps having to remove.
   */
  function feishuWsEnabled() {
    return feishuWsStatus.state === "connected";
  }

  function stopFeishuLongConnection() {
    if (!feishuWs) return;
    try {
      feishuWs.stop();
    } catch {
      // already gone
    }
    feishuWs = undefined;
    feishuWsStatus = { ...feishuWsStatus, state: "closed", connected: false };
  }

  /**
   * Open (or reopen) the Feishu long connection.
   *
   * A failure here must not take the plugin down: the app credentials may simply be wrong, and the
   * rest of the bridge is unaffected. The reason is kept in `feishuWsStatus` so `/feishu` and
   * `/state` can say "the long connection is not up, and this is why".
   */
  async function startFeishuLongConnection({ force = false } = {}) {
    if (feishuWs && !force) return feishuWs;
    stopFeishuLongConnection();
    const settings = feishuConfig();
    if (!feishuWsWanted(settings)) {
      feishuWsStatus = {
        ...feishuWsStatus,
        state: feishuChannels(settings).app ? "disabled" : "unconfigured",
        connected: false,
        appId: settings.appId || null,
        lastError: "",
      };
      return undefined;
    }
    const appId = settings.appId;
    const connection = new FeishuLongConnection({
      appId,
      appSecret: settings.appSecret,
      domain: settings.domain,
      logger: ctx.logger,
    });
    connection.onEvent((event) => {
      // The socket's handler must never reject: a thrown error here would be reported as a failed ack
      // and the event would be lost, so the work is wrapped and reported instead.
      return handleFeishuEvent(appId, event);
    });
    connection.onError((error) => {
      counters.feishuErrors += 1;
      feishuInboundError = { at: new Date().toISOString(), message: String(error?.message ?? error) };
      ctx.logger?.warn?.("[dsh-wechat-media] feishu long connection: %s", feishuInboundError.message);
    });
    feishuWs = connection;
    try {
      await connection.start();
      feishuWsStatus = { ...connection.status(), appId };
      ctx.logger?.info?.("[dsh-wechat-media] feishu long connection established");
    } catch (error) {
      feishuWsStatus = {
        ...(typeof connection.status === "function" ? connection.status() : {}),
        state: "failed",
        connected: false,
        appId,
        lastError: String(error?.message ?? error),
      };
      ctx.logger?.warn?.("[dsh-wechat-media] feishu long connection did not start: %s", feishuWsStatus.lastError);
      return undefined;
    }
    return connection;
  }

  /**
   * Send an answer back into a Feishu chat.
   *
   * The first part is a **reply** to the question when the triggering `message_id` is known, so the
   * answer stays attached to what asked it; a reply that fails falls back to a plain send rather than
   * losing the answer. Long answers are chunked with the same helper the other transports use.
   */
  async function replyFeishuInParts({ chatId, messageId, text }) {
    const settings = feishuConfig();
    if (!feishuChannels(settings).app) throw new Error("replying needs the Feishu app bot (app_id/app_secret)");
    const raw = String(text ?? "");
    if (!raw) return [];
    const plain = (await state.loadPrefs()).format !== "raw";
    const body = plain ? await chatBody(raw) : raw;
    const token = await feishuToken(settings);
    const parts = chunkText(body, MAX_TEXT_CHARS);
    const sent = [];
    for (const [index, part] of parts.entries()) {
      const msgType = plain ? "text" : "post";
      const content = plain ? feishuTextContent(part) : feishuPostContent(part);
      let result;
      if (messageId && index === 0) {
        try {
          result = await feishuReplyMessage({ token, messageId, msgType, content, domain: settings.domain });
        } catch (error) {
          ctx.logger?.warn?.("[dsh-wechat-media] feishu reply failed, sending instead: %s", error?.message ?? error);
        }
      }
      if (!result) {
        result = await feishuSendMessage({
          token,
          receiveId: chatId,
          receiveIdType: "chat_id",
          msgType,
          content,
          domain: settings.domain,
        });
      }
      sent.push(result.messageId);
    }
    return sent;
  }

  /**
   * One line per attachment, for the model.
   *
   * **Attachments are downloaded into the inbox.** The official resource endpoint is
   * `GET /open-apis/im/v1/messages/:message_id/resources/:file_key` (read from the SDK), but the query
   * parameter that selects the resource type was not readable from the SDK source, and guessing a
   * platform parameter is exactly what this project has learned not to do. So the model is told
   * precisely what arrived and where to look it up, instead of the bridge pretending it fetched it.
   */
  /**
   * Fetch one inbound attachment into `destDir/fileName` - the contract `saveInboundMedia` expects.
   *
   * The token comes from the same cache the send path uses, so a burst of attachments does not
   * re-authenticate per file. `currentFeishuMessageId` is the message being handled.
   */
  async function feishuDownload({ item, destDir, fileName }) {
    const settings = feishuConfig();
    const token = await feishuToken();   // feishuToken() returns the token string itself, not an object
    const got = await feishuDownloadResource({
      token,
      messageId: item.messageId ?? currentFeishuMessageId,
      fileKey: item.key,
      kind: item.type,
      domain: settings.domain,
    });
    const target = join(destDir, fileName);
    await writeFile(target, got.bytes);
    return target;
  }

  /** The message whose attachments are being handled right now. */
  let currentFeishuMessageId = "";
  function feishuAttachmentNote(item, messageId) {
    const label = item.type === "image"
      ? "图片"
      : item.type === "audio"
        ? "语音"
        : item.type === "video"
          ? "视频"
          : item.type === "sticker"
            ? "表情"
            : "文件";
    const extra = [
      item.name ? `文件名 ${item.name}` : "",
      item.durationMs ? `时长 ${Math.round(item.durationMs / 1000)} 秒` : "",
    ].filter(Boolean).join("，");
    return `[飞书${label}] key=${item.key}${extra ? `（${extra}）` : ""} · 消息 ${messageId} · 未能下载`;
  }

  /** The long connection's counterpart of handleWecomInbound: report, never swallow. */
  async function handleFeishuEvent(appId, event) {
    try {
      await handleFeishuEventInner(appId, event);
      feishuInboundError = null;
    } catch (error) {
      counters.feishuErrors += 1;
      feishuInboundError = { at: new Date().toISOString(), message: String(error?.message ?? error), stack: String(error?.stack ?? "").slice(0, 400) };
      ctx.logger?.warn?.("[dsh-wechat-media] feishu inbound failed: %s", feishuInboundError.message);
      // The event is still acknowledged (the socket handler returns), but the chat is told, because
      // otherwise the person is left waiting for an answer that will never come.
      const parts = feishuEventParts(event);
      if (parts.chatId) {
        await replyFeishuInParts({ chatId: parts.chatId, messageId: parts.messageId, text: `❌ 处理这条飞书消息时出错：${feishuInboundError.message}` })
          .catch((replyError) => ctx.logger?.warn?.("[dsh-wechat-media] could not deliver the feishu error notice: %s", replyError?.message ?? replyError));
      }
    }
  }

  async function handleFeishuEventInner(appId, event) {
    const eventType = String(event?.header?.event_type ?? "");
    // Only messages become turns. Everything else (card interactions, contact changes, …) is
    // acknowledged and counted rather than answered, so the socket never looks dead.
    if (eventType && eventType !== "im.message.receive_v1") {
      counters.feishuIgnored += 1;
      ctx.logger?.debug?.("[dsh-wechat-media] feishu ignored an event of type %s", eventType);
      return;
    }
    const parts = feishuEventParts(event);
    counters.feishuEvents += 1;
    feishuLastEventAt = new Date().toISOString();

    // A message the bot itself sent must never wake it: without this the bridge answers its own
    // answers forever.
    if (parts.senderType === "app") {
      counters.feishuIgnored += 1;
      return;
    }
    const chatId = parts.chatId;
    if (!chatId) {
      counters.feishuIgnored += 1;
      return;
    }
    const accountId = feishuAccountId(appId);
    if (parts.messageId) {
      const bucket = seen.get(accountId);
      if (bucket?.has(parts.messageId)) return;
      rememberSeen(accountId, parts.messageId);
    }
    const peerName = parts.isGroup ? `飞书群 ${chatId}` : `飞书 ${parts.senderOpenId || chatId}`;
    counters.received += 1;
    lastInbound.set(accountId, { accountId, chatId, peerName, isGroup: parts.isGroup, at: Date.now() });
    await state.setPeer(accountId, chatId, {
      name: peerName,
      kind: parts.isGroup ? "group" : "direct",
      seenAt: new Date().toISOString(),
    });

    const verdict = await classifyFeishuInbound({
      accountId,
      message: parts,
      text: parts.text,
      state,
      consumeApproval: consumeApprovalReply,
    });
    if (verdict.action === "ignore") {
      counters.blocked += 1;
      if (verdict.reason === "group-skipped") counters.groupsSkipped += 1;
      await state.setPeer(accountId, chatId, noteBlocked(await state.getPeer(accountId, chatId)));
      ctx.logger?.info?.("[dsh-wechat-media] ignored feishu message from %s (%s)", chatId, verdict.reason);
      return;
    }
    if (verdict.action === "answer") {
      counters.answered += 1;
      ctx.logger?.info?.("[dsh-wechat-media] feishu approval answer consumed for %s", chatId);
      return;
    }

    if (verdict.text) {
      const handled = await runChatCommand({
        transport: "feishu",
        accountId,
        chatId,
        peerName,
        text: verdict.text,
        reply: (answer) => replyFeishuInParts({ chatId, messageId: parts.messageId, text: answer }).then(() => undefined).catch((error) => {
          ctx.logger?.warn?.("[dsh-wechat-media] could not send the feishu command reply: %s", error?.message ?? error);
        }),
      });
      if (handled) return;
    }

    const lines = [];
    if (parts.text) lines.push(parts.text);
    if (parts.unsupported) lines.push(`[飞书消息类型 ${parts.unsupported} 暂不支持，内容未解析]`);
    currentFeishuMessageId = parts.messageId ?? "";
    for (const item of parts.attachments) {
      // Attachments are downloaded into the same inbox the WeChat and WeCom paths use, so the model gets a
      // path it can open. A failure says so: the attachment is still described, never silently dropped.
      try {
        const saved = await saveInboundMedia({
          download: feishuDownload,
          kind: item.type,
          chatId,
          item,
          dshHome,
          maxBytes: maxMediaBytes,
          inboxPath: await resolvedInbox(),
            // Feishu sends no file name for an image/audio/video, and an absent one produced "undefined.jpg".
            fileName: item.name || `${item.type}-${String(item.key ?? "").replace(/[^A-Za-z0-9]+/g, "").slice(-12)}`,
        });
        counters.mediaDownloaded += 1;
        counters.mediaBytes += Number(saved.bytes) || 0;
        lines.push(describeForModel(saved, "飞书"));
        ctx.logger?.info?.("[dsh-wechat-media] feishu %s saved to %s (%d bytes)", item.type, saved.path, saved.bytes);
      } catch (error) {
        counters.mediaFailed += 1;
        lines.push(feishuAttachmentNote(item, parts.messageId));
        lines.push(`[飞书${item.type}未保存] ${error?.message ?? error}`);
        ctx.logger?.warn?.("[dsh-wechat-media] feishu %s download failed: %s", item.type, error?.message ?? error);
      }
    }
    currentFeishuMessageId = "";
    if (lines.length === 0) {
      counters.unusable += 1;
      return;
    }

    counters.forwarded += 1;
    const { agent, sessionId } = await ensureAgent(accountId, chatId, peerName);
    const prompt = `[${peerName}]\n${lines.join("\n\n")}`;
    const message2 = await userMessage(prompt);
    const interjectInput = {
      enabled: (await state.loadPrefs()).interject === true,
      turnInFlight: collectors.isWaiting(sessionId),
      agentAvailable: typeof agent.steer === "function",
    };
    const interject = interjectDecision(interjectInput);
    await recordInterjection({ chatId, platform: "feishu", decision: interject, reason: interjectReason({ ...interjectInput, decision: interject }) });
    if (interject === "steer") {
      try {
        await agent.steer(message2);
        counters.interjected += 1;
        ctx.logger?.info?.("[dsh-wechat-media] steered a feishu message into the running turn for %s", chatId);
        return;
      } catch (error) {
        // Steering loses a race with the end of a turn sooner or later. Falling through to the queue is
        // what keeps "interject" from ever meaning "dropped on the floor".
        counters.interjectFailed += 1;
        await recordInterjection({ chatId, platform: "feishu", decision: "steer", reason: "steering failed, queued instead", error: error?.message ?? error });
        ctx.logger?.warn?.("[dsh-wechat-media] steering failed, queueing instead: %s", error?.message ?? error);
      }
    }

    // Feishu messages can be edited in place, but this half does not implement a live preview: a
    // `stream` preference is answered whole here, and `/feishu` says so rather than looking broken.
    const prefsForTurn = await state.loadPrefs();
    let outcome = await (async () => {
      const waiting = collectors.wait(sessionId, message2?.id);
      await agent.followup(message2);
      return waiting;
    })();
    if (outcome.error && shouldRetryTurn({ error: outcome.error, attempt: 1, enabled: prefsForTurn.retry !== false })) {
      counters.retried += 1;
      ctx.logger?.warn?.("[dsh-wechat-media] turn failed (%s); retrying once", outcome.error);
      await replyFeishuInParts({ chatId, messageId: parts.messageId, text: `⚠️ 上一轮失败：${outcome.error}\n正在重试一次…` });
      const retryMessage = await userMessage(prompt);
      const retryWaiting = collectors.wait(sessionId, retryMessage?.id);
      await agent.followup(retryMessage);
      outcome = await retryWaiting;
      if (outcome.error) counters.retryFailed += 1;
    }
    if (outcome.error) {
      counters.feishuErrors += 1;
      await replyFeishuInParts({ chatId, messageId: parts.messageId, text: `❌ agent 出错：${outcome.error}` });
      return;
    }
    if (!outcome.text) {
      if (outcome.deliveredByTool) return;
      await replyFeishuInParts({ chatId, messageId: parts.messageId, text: `（本轮没有文本回复：${outcome.stopReason}）` });
      return;
    }
    await replyFeishuInParts({ chatId, messageId: parts.messageId, text: outcome.text });
    counters.feishuAnswered += 1;
  }


  // Lifecycle-managed when the scope offers `effect`; otherwise started eagerly, so a harness without
  // it still gets the long connection instead of losing the feature.
  // The saved settings must be in the cache before anything asks `feishuConfig()` for them - the tools,
  // `/state` and the long connection all read it synchronously - so the connection is started *after*
  // the cache is warm, never in parallel with it. `apply` itself is synchronous, hence the chain.
  const startFeishuAfterPrefs = () => {
    void refreshFeishuSavedPrefs()
      .then(() => startFeishuLongConnection())
      .catch((error) => ctx.logger?.warn?.("[dsh-wechat-media] could not start the feishu long connection: %s", error?.message ?? error));
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      startFeishuAfterPrefs();
      return () => stopFeishuLongConnection();
    }, "dsh-wechat-media: feishu long connection");
  } else {
    startFeishuAfterPrefs();
  }

  /** Send one message through whichever WeCom path is configured. */
  async function wecomSendText({ text, markdown = false, webhookUrl, to } = {}) {
    const config = await state.loadWecom();
    const url = String(webhookUrl ?? config.webhookUrl ?? "").trim();
    if (url) {
      const payload = markdown ? wecom.markdownPayload(text) : wecom.textPayload(text);
      await wecom.sendWebhook({ webhookUrl: url, payload, timeoutMs: wecomTimeoutMs });
      return { via: "webhook", kind: payload.msgtype };
    }
    const accountId = wecomAccountId(config.botId);
    const botChat = String(to ?? "").trim() || lastInbound.get(accountId)?.chatId || "";
    if (wecomBot && wecomBotStatus.authenticated && botChat) {
      // A proactive send has no inbound frame, and WeCom accepts markdown / template
      // card / media here - not plain text, so everything goes out as markdown.
      if (wecomBot.sendMessage(botChat, markdownBody(text)) === false) {
        // The socket is reconnecting or gone. Reporting success here would be a lie the
        // caller cannot detect, so say what happened and let the sender retry.
        throw new Error("the WeCom long connection is not writable right now (reconnecting?); try again in a moment");
      }
      return { via: "long-connection", kind: "markdown", to: botChat };
    }
    const token = await wecomToken(config);
    const payload = markdown ? wecom.appMarkdownPayload(text) : wecom.appTextPayload(text);
    await wecom.sendAppMessage({ token, agentId: config.agentId, toUser: to ?? config.toUser, payload, timeoutMs: wecomTimeoutMs });
    return { via: "app", kind: payload.msgtype, to: to ?? config.toUser };
  }

  /**
   * Send into a WeCom chat without an inbound frame - an approval prompt, a
   * confirmation, a timeout notice. Only markdown is accepted on this path, and a
   * closed or reconnecting socket must raise rather than report success.
   */
  async function sendWecomProactive(chatId, text) {
    if (!wecomBot || !wecomBotStatus.authenticated) {
      throw new Error("the WeCom long connection is not authenticated");
    }
    if (wecomBot.sendMessage(chatId, markdownBody(text)) === false) {
      throw new Error("the WeCom long connection is not writable right now");
    }
    return { via: "long-connection", kind: "markdown", to: chatId };
  }

  /**
   * Send a local file through whichever WeCom path is configured.
   *
   * Order: the intelligent-robot long connection (upload as a temporary asset, then send
   * it - no app credentials needed), then the self-built app (media/upload), then the
   * group-robot webhook (images only). The long connection is what makes the tool work on
   * a bot-only setup, which is how this machine is configured.
   */
  async function wecomSendMedia({ filePath, to, text } = {}) {
    const prepared = await prepareOutbound(String(filePath ?? "").trim(), { maxBytes: maxMediaBytes });
    const config = await state.loadWecom();
    const type = wecom.wecomUploadType(prepared.path);

    const hasApp = Boolean(config.corpSecret && config.agentId);
    const accountId = wecomAccountId(config.botId);
    const botChat = String(to ?? "").trim() || lastInbound.get(accountId)?.chatId || "";

    if (!hasApp && wecomBot && wecomBotStatus.authenticated && botChat) {
      if (text) await sendWecomProactive(botChat, text);
      const uploaded = await wecomBot.uploadMedia(await readFile(prepared.path), {
        type,
        filename: prepared.name,
        timeoutMs: 120000,
      });
      await wecomBot.sendMediaMessage(botChat, type, uploaded.mediaId, { title: prepared.name });
      return { via: "long-connection", kind: type, to: botChat, bytes: prepared.bytes, chunks: uploaded.chunks };
    }

    if (hasApp) {
      const token = await wecomToken(config);
      const recipients = to ?? config.toUser;
      if (text) {
        await wecom.sendAppMessage({ token, agentId: config.agentId, toUser: recipients, payload: wecom.appTextPayload(String(text)), timeoutMs: wecomTimeoutMs });
      }
      const { mediaId } = await wecom.uploadMedia({ token, filePath: prepared.path, type, timeoutMs: wecomTimeoutMs });
      await wecom.sendAppMessage({
        token,
        agentId: config.agentId,
        toUser: recipients,
        payload: wecom.appMediaPayload(type, mediaId),
        timeoutMs: wecomTimeoutMs,
      });
      return { via: "app", kind: type, to: recipients, bytes: prepared.bytes };
    }

    const webhookUrl = String(config.webhookUrl ?? "").trim();
    if (!webhookUrl) {
      throw new Error(
        wecomBot && wecomBotStatus.authenticated
          ? "no WeCom chat to send to yet: write to the robot once, or pass `to`"
          : "WeCom is not configured: set a group-robot webhook, corpid/corpsecret/agentid, or the intelligent-robot long connection",
      );
    }
    if (type !== "image") {
      throw new Error(`a group-robot webhook can only send images; ${prepared.name} looks like ${type}`);
    }
    await wecom.sendWebhook({ webhookUrl, payload: wecom.imagePayload(await readFile(prepared.path)), timeoutMs: wecomTimeoutMs });
    return { via: "webhook", kind: "image", to: "group-robot webhook", bytes: prepared.bytes };
  }
  /**
   * The last few control-route calls, so "I clicked and nothing happened" can be
   * answered from the server side: did the request arrive, and what did it do?
   */
  const routeLog = [];
  function noteRoute(path, info = {}) {
    routeLog.push({ path, at: new Date().toISOString(), ...info });
    if (routeLog.length > 20) routeLog.shift();
  }
  const approvals = createApprovalBridge({
    // Two channels, one question: a WeChat chat is answered by the ilink sender, a
    // WeCom chat by a proactive long-connection message (there is no inbound frame
    // to reply to when *we* start the conversation).
    notify: (account, chatId, text) => (account?.via === "wecom"
      ? sendWecomProactive(chatId, text)
      : sendText(account, chatId, text, { typing: false })),
    timeoutMs: Math.max(15, Number(config.approvalTimeoutSec ?? 120)) * 1000,
    logger: ctx.logger,
    // The authorization level decides whether the chat is asked at all, what silence means and
    // whether requests are refused outright. Read per request, so `/auth` applies immediately.
    policyFor: async () => approvalPolicyFor((await state.loadPrefs()).authorization),
  });
  /** The inbound pipeline's name for "did this message answer a pending request?". */
  const consumeApprovalReply = approvals.consume;

  /**
   * Which WeChat chat (if any) owns a DSH session: the in-memory map first, then
   * the persisted routing table, so an approval that arrives after a restart is
   * still bridged.
   */
  async function findConversation(sessionId) {
    const known = conversations.get(sessionId);
    if (known) return known;
    const routes = await state.loadRoutes();
    for (const [accountId, chats] of Object.entries(routes)) {
      for (const [chatId, route] of Object.entries(chats ?? {})) {
        if (route?.sessionId === sessionId) {
          const conversation = { accountId, chatId, peerName: route.peerName };
          conversations.set(sessionId, conversation);
          return conversation;
        }
      }
    }
    return undefined;
  }

  ctx.inject(["approval"], (approvalCtx) => {
    approvalCtx.on("approval/request", (request, next) => approvals.respond(request, next, {
      ignore: config.approval === "ignore",
      findConversation,
      loadAccount: async (accountId, conversation) => approvalTarget({
        conversation,
        account: await state.loadAccount(accountId),
        wecomReady: Boolean(wecomBot && wecomBotStatus.authenticated),
      }),
    }));
  });

  // ── inbound ───────────────────────────────────────────────────────────────

  /** Turn one inbound message into a prompt, download its media, and feed the agent. */
  async function handleInbound(accountId, message) {
    const account = await state.loadAccount(accountId);
    if (!account?.token) return;

    const messageId = String(message?.message_id ?? "");
    if (messageId) {
      const bucket = seen.get(accountId);
      if (bucket?.has(messageId)) return;
      rememberSeen(accountId, messageId);
    }
    // Our own outbound messages echo back through the same stream.
    if (message?.message_type === 2) return;
    counters.received += 1;

    const identity = describeEnvelope(message);
    if (!identity.chatId) return;
    const { chatId, isGroup, peerName } = identity;
    // Diagnostic: print the envelope's identifying fields, so the field that
    // actually addresses a group can be confirmed against the platform instead of
    // guessed (the protocol port flagged this as an unknown).
    ctx.logger?.info?.(
      "[dsh-wechat-media] inbound %s chat=%s session_id=%s group_id=%s room=%s from=%s type=%s",
      isGroup ? "group" : "direct",
      chatId,
      message?.session_id ?? "-",
      message?.group_id ?? "-",
      message?.room_id ?? message?.chat_room_id ?? "-",
      message?.from_user_id ?? "-",
      message?.message_type ?? "-",
    );
    if (message?.context_token) await state.saveContextToken(accountId, chatId, message.context_token);
    lastInbound.set(accountId, { accountId, chatId, peerName, isGroup, groupId: identity.groupId, sessionChat: identity.sessionChat, fromUserId: identity.fromUserId, at: Date.now() });

    // Remember every chat so the allowlist panel can list it. `allowed` is the
    // user's decision and is never overwritten here.
    await state.setPeer(accountId, chatId, {
      name: peerName,
      kind: isGroup ? "group" : "direct",
      // Both candidate ids are kept: which one addresses the chat when *sending*
      // is settled by the platform, and the panel exposes them so the answer can
      // be read from /state instead of from a log file.
      groupId: identity.groupId ?? null,
      sessionChat: identity.sessionChat ?? null,
      fromUserId: identity.fromUserId ?? null,
      seenAt: new Date().toISOString(),
    });

    const normalized = ilink.describeInbound ? ilink.describeInbound(message) : { kind: "text", items: [] };
    const text = String(normalized?.text ?? "").trim();
    const media = Array.isArray(normalized?.media) ? normalized.media : [];

    // One decision for the whole message: allowlist, approval answer, or a turn.
    const verdict = await classifyInbound({ accountId, message, text, state, consumeApproval: consumeApprovalReply });
    if (verdict.action === "ignore") {
      ctx.logger?.info?.("[dsh-wechat-media] ignored message from %s (%s)", chatId, verdict.reason);
      counters.blocked += 1;
      if (verdict.reason === "group-skipped") counters.groupsSkipped += 1;
      // Keep the drop countable so the card can show it.
      await state.setPeer(accountId, chatId, noteBlocked(await state.getPeer(accountId, chatId)));
      return;
    }
    if (verdict.action === "answer") {
      counters.answered += 1;
      return; // already handed to the waiting requester
    }

    const lines = [];
    if (text) {
      // A "/command" is addressed to the bridge, never to the agent.
      const handled = await runChatCommand({
        transport: "wechat",
        accountId,
        chatId,
        peerName,
        text,
        reply: (answer) => sendText(account, chatId, answer, { typing: false }),
      });
      if (handled) return;
      lines.push(text);
    }
    for (const item of media) {
      try {
        const saved = await saveInboundMedia({
          inboxPath: await resolvedInbox(),
          ilink,
          chatId,
          item: item.item ?? item,
          dshHome,
          maxBytes: maxMediaBytes,
        });
        counters.mediaDownloaded += 1;
        counters.mediaBytes += Number(saved.bytes) || 0;
        // A voice message arrives as SILK, which nothing on a normal machine can play. The vendored codec
        // turns it into WAV - the same use Tencent's own WeChat channel makes of the same module - and a
        // failure leaves the raw SILK in place rather than losing it.
        let usable = saved;
        if (saved?.kind === "voice" || /\.silk$/i.test(String(saved?.path ?? ""))) {
          try {
            const decoded = await silkToWav(await readFile(saved.path));
            const wavPath = String(saved.path).replace(/\.silk$/i, "") + ".wav";
            await writeFile(wavPath, decoded.wav);
            usable = { ...saved, path: wavPath, bytes: decoded.wav.length, seconds: decoded.seconds };
            counters.voiceDecoded += 1;
            ctx.logger?.info?.("[dsh-wechat-media] inbound voice decoded to WAV: %s (%s s)", wavPath, decoded.seconds);
          } catch (error) {
            ctx.logger?.warn?.("[dsh-wechat-media] inbound voice kept as SILK: %s", error?.message ?? error);
          }
        }
        lines.push(describeForModel(usable));
      } catch (error) {
        counters.mediaFailed += 1;
        lines.push(`[微信媒体下载失败] ${item?.type ?? "media"}: ${error?.message ?? error}`);
        ctx.logger?.warn?.("[dsh-wechat-media] inbound %s download failed: %s", item?.type ?? "media", error?.message ?? error);
      }
    }
    if (lines.length === 0) {
      // An item that is neither text nor downloadable media (a sticker, or a type
      // this port does not know). Count it and log its item types: dropping it
      // silently is indistinguishable from a broken bridge.
      counters.unusable += 1;
      ctx.logger?.info?.(
        "[dsh-wechat-media] inbound %s from %s carried nothing usable (item types: %s)",
        isGroup ? "group" : "direct",
        chatId,
        (Array.isArray(message?.item_list) ? message.item_list : []).map((item) => item?.type ?? "?").join(",") || "none",
      );
      return;
    }

    counters.forwarded += 1;
    const { agent, sessionId } = await ensureAgent(accountId, chatId, peerName);
    const prompt = `[微信 ${peerName} ${chatId}]\n${lines.join("\n\n")}`;
    const message2 = await userMessage(prompt);
    // Same rule as the WeCom path: interject into the running turn, or queue your own.
    const interjectInput2 = {
      enabled: (await state.loadPrefs()).interject === true,
      turnInFlight: collectors.isWaiting(sessionId),
      agentAvailable: typeof agent.steer === "function",
    };
    const interject = interjectDecision(interjectInput2);
    await recordInterjection({ chatId, platform: "wechat", decision: interject, reason: interjectReason({ ...interjectInput2, decision: interject }) });
    if (interject === "steer") {
      try {
        await agent.steer(message2);
        counters.interjected += 1;
        ctx.logger?.info?.("[dsh-wechat-media] steered a message into the running turn for %s", chatId);
        return;
      } catch (error) {
        // Steering loses a race with the end of a turn sooner or later. Falling through to the queue is
        // what keeps "interject" from ever meaning "dropped on the floor".
        counters.interjectFailed += 1;
        await recordInterjection({ chatId, platform: "wechat", decision: "steer", reason: "steering failed, queued instead", error: error?.message ?? error });
        ctx.logger?.warn?.("[dsh-wechat-media] steering failed, queueing instead: %s", error?.message ?? error);
      }
    }
    let outcome = await (async () => {
      const waiting = collectors.wait(sessionId, message2?.id);
      agent.followup(message2);
      return waiting;
    })();
    // Same rule as the WeCom path: one retry, transient causes only, and never a silent second failure.
    if (outcome.error && shouldRetryTurn({ error: outcome.error, attempt: 1, enabled: (await state.loadPrefs()).retry !== false })) {
      counters.retried += 1;
      ctx.logger?.warn?.("[dsh-wechat-media] turn failed (%s); retrying once", outcome.error);
      for (const chunk of chunkText(`⚠️ 上一轮失败：${outcome.error}\n正在重试一次…`)) await sendText(account, chatId, chunk);
      const retryMessage = await userMessage(prompt);
      const retryWaiting = collectors.wait(sessionId, retryMessage?.id);
      agent.followup(retryMessage);
      outcome = await retryWaiting;
      if (outcome.error) counters.retryFailed += 1;
    }

    if (outcome.error) {
      // Chunked and logged rather than sliced-and-swallowed: a long error is still an
      // answer, and a failure to deliver it must not vanish.
      for (const chunk of chunkText(`❌ agent 出错：${outcome.error}`)) {
        await sendText(account, chatId, chunk).catch((error) => {
          ctx.logger?.warn?.("[dsh-wechat-media] could not deliver the error notice: %s", error?.message ?? error);
        });
      }
      return;
    }
    if (!outcome.text) {
      if (outcome.deliveredByTool) return; // the tool carried the answer (WeChat has no live stream to close)
      await sendText(account, chatId, `（本轮没有文本回复：${outcome.stopReason}）`).catch((error) => {
        ctx.logger?.warn?.("[dsh-wechat-media] could not deliver the empty-turn notice: %s", error?.message ?? error);
      });
      return;
    }
    if (outcome.deliveredByTool) {
      // The model sent its answer through a delivery tool; relaying it again
      // would duplicate the message in WeChat.
      ctx.logger?.info?.("[dsh-wechat-media] reply for %s already delivered by tool", chatId);
      return;
    }
    for (const chunk of chunkText(await chatBody(outcome.text))) {
      await sendText(account, chatId, chunk).catch((error) => {
        ctx.logger?.warn?.("[dsh-wechat-media] send failed: %s", error?.message ?? error);
      });
      await sleep(CHUNK_DELAY_MS);
    }
  }

  // ── one long-poll loop per account ────────────────────────────────────────

  async function monitorAccount(accountId) {
    const existing = monitors.get(accountId);
    if (existing && !existing.stopped) return existing;
    const account = await state.loadAccount(accountId);
    if (!account?.token) throw new Error(`account ${accountId} has no stored token`);
    const control = { stopped: false, failures: 0, lastPollAt: 0, lastError: undefined, connectedAt: undefined, accountId };
    monitors.set(accountId, control);

    void (async () => {
      try {
        await ilink.startNotify({ baseUrl: account.baseUrl, token: account.token });
        control.connectedAt = Date.now();
      } catch (error) {
        ctx.logger?.warn?.("[dsh-wechat-media] notifystart failed: %s", error?.message ?? error);
      }
      let cursor = await state.loadCursor(accountId);
      let pollMs = DEFAULT_POLL_MS;
      while (!control.stopped) {
        try {
          const response = await ilink.getUpdates({
            baseUrl: account.baseUrl,
            token: account.token,
            cursor,
            timeoutMs: pollMs + 5_000,
          });
          control.lastPollAt = Date.now();
          const ret = Number(response?.ret ?? 0);
          const errcode = Number(response?.errcode ?? 0);
          if (ret === -14 || errcode === -14) {
            // Stale token: the platform answered for a pairing that is gone.
            control.lastError = "token-expired";
            control.stopped = true;
            ctx.logger?.warn?.("[dsh-wechat-media] account %s token expired; re-pair to resume", accountId);
            break;
          }
          if (ret !== 0) {
            control.failures += 1;
            control.lastError = `ret=${ret} ${response?.errmsg ?? ""}`.trim();
          } else {
            control.failures = 0;
            control.lastError = undefined;
            if (typeof response?.longPollingTimeoutMs === "number" && response.longPollingTimeoutMs > 0) {
              pollMs = response.longPollingTimeoutMs;
            }
            // The client only ever hands back a usable cursor; an empty one means
            // "nothing new", so the stored cursor stays as it is.
            if (response?.cursor) {
              cursor = response.cursor;
              await state.saveCursor(accountId, cursor);
            }
            for (const message of response?.messages ?? []) {
              try {
                await handleInbound(accountId, message);
              } catch (error) {
                ctx.logger?.warn?.("[dsh-wechat-media] inbound failed: %s", error?.message ?? error);
              }
            }
          }
        } catch (error) {
          // A client-side timeout of the long poll is normal control flow: the
          // server simply held the request for its full window. Only real
          // failures back off.
          const message = String(error?.message ?? error);
          if (!/abort|timeout/i.test(message)) {
            control.failures += 1;
            control.lastError = message;
          }
        }
        if (control.stopped) break;
        if (control.failures >= 3) await sleep(BACKOFF_AFTER_FAILURES_MS);
        else if (control.failures > 0) await sleep(BACKOFF_MS);
      }
      monitors.delete(accountId);
    })();

    return control;
  }

  /** Start every stored account (a restart resumes without re-scanning). */
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      await state.init();
      const accounts = await state.loadAccounts();
      for (const account of accounts) {
        if (cancelled || !account.token) continue;
        try {
          await monitorAccount(account.accountId);
        } catch (error) {
          ctx.logger?.warn?.("[dsh-wechat-media] could not start %s: %s", account.accountId, error?.message ?? error);
        }
      }
      if (accounts.length > 0) {
        ctx.logger?.info?.("[dsh-wechat-media] resumed %d account(s)", accounts.length);
      }
    })();
    return () => {
      cancelled = true;
      for (const control of monitors.values()) control.stopped = true;
    };
  }, "dsh-wechat-media: account monitors");

  // ── outbound tools ────────────────────────────────────────────────────────

  /** Resolve the peer a tool should send to: explicit `to`, else the last inbound. */
  async function resolvePeer(explicit) {
    if (explicit) {
      for (const account of await state.loadAccounts()) {
        const route = await state.getRoute(account.accountId, explicit);
        if (route) return { account, chatId: explicit, peerName: route.peerName };
        const peers = await state.loadPeers();
        if (peers[account.accountId]?.[explicit]) return { account, chatId: explicit, peerName: undefined };
      }
      const accounts = await state.loadAccounts();
      if (accounts.length === 1) return { account: accounts[0], chatId: explicit, peerName: undefined };
      throw new Error(`unknown WeChat recipient ${explicit}`);
    }
    const candidates = [...lastInbound.values()].sort((a, b) => b.at - a.at);
    const recent = candidates[0];
    if (!recent) throw new Error("no WeChat conversation has been seen yet; pass an explicit recipient");
    const account = await state.loadAccount(recent.accountId);
    if (!account) throw new Error(`account ${recent.accountId} is gone`);
    return { account, chatId: recent.chatId, peerName: recent.peerName };
  }

  ctx.inject(["tools"], (toolCtx) => {
    void (async () => {
      try {
        const mod = await importHarnessPlugin(ctx, "@deepseek-ai/dsh-tools");
        harness.defineTool = mod?.defineTool;
      } catch {
        // fall back to a plain definition object
      }
      const define = typeof harness.defineTool === "function" ? harness.defineTool : (definition) => definition;
        // ── WeCom (企业微信) tools ───────────────────────────────────────────
        // They call the helpers defined next to the inbox resolver above.


        const wecomText = define({
          name: "wecom_send_text",
          description:
            "Send a text or markdown message through WeCom (企业微信). Uses the configured group-robot webhook, or an explicit webhookUrl, or the intelligent-robot long connection (botId/botSecret, proactive send), or the configured self-built app (corpid/corpsecret/agentid). Incoming WeCom messages also arrive over the long connection and are answered in the same chat.",
          parameters: {
            text: { type: "string", required: true, description: "Message text (<= 4096 bytes for a robot, 2048 for the app)." },
            markdown: { type: "boolean", description: "Send it as markdown instead of plain text." },
            webhookUrl: { type: "string", description: "Override the configured group-robot webhook for this call." },
            to: { type: "string", description: "The chat id for a long-connection proactive send, or the WeCom recipients (userid list, department, or @all) for the app path." },
          },
          output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
          timeoutMs: 30000,
          async execute(args) {
            const text = String(args?.text ?? "");
            if (!text.trim()) return "nothing to send: `text` is empty";
            const sent = await wecomSendText({ text, markdown: Boolean(args?.markdown), webhookUrl: args?.webhookUrl, to: args?.to });
            noteRoute("/wecom", sent);
            if (sent.via === "webhook") return `sent a ${sent.kind} message to the WeCom group robot`;
            if (sent.via === "long-connection") return `sent a ${sent.kind} message over the WeCom long connection to ${sent.to}`;
            return `sent a ${sent.kind} message to ${sent.to} through the WeCom app`;
          },
        });

        const wecomFile = define({
          name: "wecom_send_file",
          description:
            "Send a local file through WeCom (企业微信). Over the intelligent-robot long connection (or with a self-built app) it is uploaded and sent as image/file/video/voice; with only a group-robot webhook, images are supported and other types are refused with an explanation.",
          parameters: {
            path: { type: "string", required: true, description: "Absolute path of the local file." },
            to: { type: "string", description: "The chat id for a long-connection send, or the WeCom recipients (userid list, department, @all) for the app path." },
            text: { type: "string", description: "Optional text message sent before the file." },
          },
          output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
          timeoutMs: 300000,
          async execute(args) {
            const filePath = String(args?.path ?? args?.filePath ?? "");
            if (!filePath) return "nothing to send: `path` is empty";
            try {
              const sent = await wecomSendMedia({ filePath, to: args?.to, text: args?.text });
              noteRoute("/wecom", sent);
              if (sent.via === "long-connection") return `sent ${filePath} as ${sent.kind} over the WeCom long connection to ${sent.to}`;
              if (sent.via === "app") return `sent ${filePath} as ${sent.kind} through the WeCom app to ${sent.to}`;
              return `sent ${filePath} as an image to the WeCom group robot`;
            } catch (error) {
              noteRoute("/wecom", { action: "send-file", error: String(error?.message ?? error) });
              return `could not send ${filePath}: ${error?.message ?? error}`;
            }
          },
        });

      /**
       * Speak, on this machine.
       *
       * Both platforms take a voice file and neither offers text-to-speech, so `text` is synthesized
       * locally (see voice.js: the system speech engine plus ffmpeg, no cloud service and no key) and
       * `path` sends an audio file that already exists. The temporary audio is removed either way.
       */
      const wecomVoice = define({
        name: "wecom_send_voice",
        description:
          "Send a voice message through WeCom (企业微信). Give `text` and it is spoken on this machine - the system speech engine, then ffmpeg to a chat format; nothing is sent to a cloud service - or give `path` for an existing audio file (.amr/.mp3/.wav). Over the intelligent-robot long connection it is uploaded as a voice message; with only a group-robot webhook, voice is refused with an explanation.",
        parameters: {
          text: { type: "string", description: "What to say. Spoken locally, no cloud service involved." },
          path: { type: "string", description: "Absolute path of an existing audio file, used when `text` is not given." },
          to: { type: "string", description: "The chat id for a long-connection send, or the WeCom recipients for the app path." },
          format: { type: "string", description: "amr (what WeCom specifies for voice), mp3 or wav." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 300000,
        async execute(args) {
          const spoken = String(args?.text ?? "").trim();
          const given = String(args?.path ?? "").trim();
          if (!spoken && !given) return "nothing to send: give `text` to speak, or `path` to an audio file";
          let audio;
          if (spoken) {
            try {
              audio = await synthesizeVoice({ text: spoken, format: String(args?.format ?? "").trim() || "amr" });
            } catch (error) {
              return `could not make the voice: ${error?.message ?? error}`;
            }
          }
          try {
            const sent = await wecomSendMedia({ filePath: audio?.path ?? given, to: args?.to });
            noteRoute("/wecom", sent);
            const what = audio ? `a spoken ${audio.format} (${audio.bytes} bytes)` : given;
            if (sent.via === "long-connection") return `sent ${what} as ${sent.kind} over the WeCom long connection to ${sent.to}`;
            if (sent.via === "app") return `sent ${what} as ${sent.kind} through the WeCom app to ${sent.to}`;
            return `sent ${what} as an image to the WeCom group robot`;
          } catch (error) {
            noteRoute("/wecom", { action: "send-voice", error: String(error?.message ?? error) });
            return `could not send the voice: ${error?.message ?? error}`;
          } finally {
            await audio?.cleanup?.();
          }
        },
      });

      // ── Feishu (飞书 / Lark) tools ────────────────────────────────────────

      const feishuText = define({
        name: "feishu_send_text",
        description:
          "Send a text or markdown message through Feishu (飞书 / Lark). Uses the configured app bot (feishu.appId/appSecret - needs a receive id), or a custom webhook bot (feishu.webhookUrl), or an explicit webhookUrl for this call. A custom webhook bot can only carry text/rich text; Feishu renders markdown natively on both paths.",
        parameters: {
          text: { type: "string", required: true, description: "Message text." },
          markdown: { type: "boolean", description: "Send it as rich text (Feishu draws markdown itself) instead of plain text." },
          webhookUrl: { type: "string", description: "Override the configured custom-webhook URL for this call." },
          to: { type: "string", description: "The app bot's receive id: chat_id, open_id, user_id or email. Required on the app path unless feishu.to is set; a webhook ignores it." },
          toType: { type: "string", description: "Which kind of id `to` is. Guessed from the id when omitted (oc_ → chat_id, ou_/on_ → open_id, @ → email)." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 30000,
        async execute(args) {
          const text = String(args?.text ?? "");
          if (!text.trim()) return "nothing to send: `text` is empty";
          try {
            const sent = await feishuSendText({ text, markdown: Boolean(args?.markdown), webhookUrl: args?.webhookUrl, to: args?.to, toType: args?.toType });
            noteRoute("/feishu", sent);
            if (sent.via === "app") return `sent a ${sent.kind} message through the Feishu app bot to ${sent.to}（message_id ${sent.messageId}）`;
            if (sent.via === "webhook") return `sent a ${sent.kind} message to the Feishu custom webhook bot`;
            return sent.reason;
          } catch (error) {
            noteRoute("/feishu", { action: "send-text", error: String(error?.message ?? error) });
            return `could not send to Feishu: ${error?.message ?? error}`;
          }
        },
      });

      const feishuFile = define({
        name: "feishu_send_file",
        description:
          "Send a local file, image, audio or video through Feishu (飞书 / Lark). Needs the app bot (feishu.appId/appSecret) plus a receive id: a custom webhook bot cannot carry files at all, and this tool says so instead of reporting a success that never arrived.",
        parameters: {
          path: { type: "string", required: true, description: "Absolute path of the local file." },
          to: { type: "string", description: "The receive id: chat_id, open_id, user_id or email. Falls back to feishu.to." },
          toType: { type: "string", description: "Which kind of id `to` is; guessed from the id when omitted." },
          kind: { type: "string", description: "file (default), image, audio or video - decides the upload type and the message type." },
          filename: { type: "string", description: "Name to send it under; defaults to the file's own name." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 300000,
        async execute(args) {
          const filePath = String(args?.path ?? args?.filePath ?? "");
          if (!filePath) return "nothing to send: `path` is empty";
          try {
            const sent = await feishuSendFile({ filePath, to: args?.to, toType: args?.toType, kind: args?.kind, filename: args?.filename });
            noteRoute("/feishu", sent);
            if (sent.refused) return sent.reason;
            if (sent.via === "app") return `sent ${filePath} as ${sent.kind} through the Feishu app bot to ${sent.to}（message_id ${sent.messageId}）`;
            return sent.reason;
          } catch (error) {
            noteRoute("/feishu", { action: "send-file", error: String(error?.message ?? error) });
            return `could not send ${filePath} to Feishu: ${error?.message ?? error}`;
          }
        },
      });

      const feishuDocCreate = define({
        name: "feishu_doc_create",
        description:
          "Create a Feishu (飞书 / Lark) document from text and return its link. Needs the app bot (feishu.appId/appSecret). The body is written as plain paragraphs; the caller gets the document URL to share.",
        parameters: {
          title: { type: "string", required: true, description: "Document title." },
          text: { type: "string", description: "Body text. Written once the append capability lands (next); it is accepted and reported, never silently dropped." },
          folderToken: { type: "string", description: "Optional folder token; omitted means the app's own space." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const title = String(args?.title ?? "").trim();
          const text = String(args?.text ?? "");
          if (!title) return "nothing to create: `title` is empty";
          try {
            const created = await feishuCreateDoc({ token: await feishuToken(), title, folderToken: args?.folderToken, tenantHost: feishuConfig().tenantHost });
            // The body is written through the append endpoint, whose shape was settled against the live API
            // (block_type 2 + text_run, parent block = the document id) and proven by reading the document back.
            const written = await feishuAppendText({ token: await feishuToken(), documentId: created.documentId, text });
            noteRoute("/feishu-doc", { action: "create", documentId: created.documentId, blocks: written.blocks });
            if (!created.url) {
              noteRoute("/feishu-doc", { action: "create", documentId: created.documentId, url: "missing tenant host" });
              return `已创建「${created.title}」（id ${created.documentId}）✓ 写入 ${written.blocks} 段 ✓ —— 但**没有配置租户域名，所以不给链接** ✗（用 API 主机拼出来的链接会打不开 ✓）。请填 tenantHost（形如 ccnje3t5tkro.feishu.cn，取自你任意一篇飞书文档的 URL ✓），或用 DSH 环境变量 FEISHU_TENANT_HOST ✓。`;
            }
            return `已创建「${created.title}」→ ${created.url}（写入 ${written.blocks} 段 ✓）`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "create", error: String(error?.message ?? error) });
            return `could not create the Feishu document: ${error?.message ?? error}`;
          }
        },
      });

      const feishuDocRead = define({
        name: "feishu_doc_read",
        description:
          "Read a Feishu (飞书 / Lark) document's plain text from a link or id and hand it to the model. Accepts /docx/<id> links, bare ids and /wiki/<id> links; a wiki link carries a node token, so it is reported as such rather than guessed at.",
        parameters: {
          link: { type: "string", required: true, description: "The document link, a /docx/<id> or /wiki/<id> URL, or a bare document id." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const ref = feishuDocRef(args?.link);
          if (!ref.kind) return `没有识别出文档：请给出 /docx/<id> 链接、/wiki/<id> 链接或文档 id（收到的是「${String(args?.link ?? "").slice(0, 60)}」）`;
          let documentId = ref.id;
          if (ref.kind === "wiki") {
            // Resolved for real now: the parameter is `token` (the live API answered 131005 "not found" for it and a
            // validation error without it) and the node carries obj_token + obj_type (official type definitions).
            try {
              const node = await feishuWikiResolve({ token: await feishuToken(), nodeToken: ref.id });
              if (node.objType && node.objType !== "docx" && node.objType !== "doc") {
                noteRoute("/feishu-doc", { action: "read", kind: "wiki", objType: node.objType });
                return `这是知识库(wiki)里的一篇 **${node.objType}**（obj_token ${node.objToken}）✓，不是文档 ✓ —— 请用对应的工具读取（表格用 feishu_sheet_read ✓ 多维表格用 feishu_bitable_read ✓）。`;
              }
              documentId = node.objToken;
              noteRoute("/feishu-doc", { action: "read", kind: "wiki", objType: node.objType, objToken: node.objToken });
            } catch (error) {
              noteRoute("/feishu-doc", { action: "read", kind: "wiki", error: String(error?.message ?? error) });
              return `解析知识库(wiki)节点失败：${error?.message ?? error}`;
            }
          }
          try {
            const got = await feishuReadDoc({ token: await feishuToken(), documentId });
            noteRoute("/feishu-doc", { action: "read", documentId: got.documentId, chars: got.content.length });
            return `文档 ${got.documentId}（${got.content.length} 字符）：\n\n${got.content}`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "read", error: String(error?.message ?? error) });
            return `读取飞书文档失败：${error?.message ?? error}`;
          }
        },
      });

      const feishuDocAppend = define({
        name: "feishu_doc_append",
        description:
          "Append text to an existing Feishu (飞书 / Lark) document. Each line becomes a paragraph; the document id is taken from a link or given directly.",
        parameters: {
          link: { type: "string", required: true, description: "The document link or its document_id." },
          text: { type: "string", required: true, description: "Text to append. Each non-empty line becomes a paragraph." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const ref = feishuDocRef(args?.link);
          const text = String(args?.text ?? "");
          let targetId = ref.kind === "docx" ? ref.id : "";
          if (ref.kind === "wiki") {
            try {
              const node = await feishuWikiResolve({ token: await feishuToken(), nodeToken: ref.id });
              if (node.objType === "docx" || node.objType === "doc") targetId = node.objToken;
              else return `wiki 节点 ${ref.id} 是 ${node.objType} ✓，不能当文档追加 ✓（表格/多维表格请用对应工具 ✓）`;
            } catch (error) {
              return `解析知识库(wiki)节点失败：${error?.message ?? error}`;
            }
          }
          if (!targetId) return `只能追加到文档：请给出 /docx/<id> 链接、/wiki/<id> 链接或文档 id ✗`;
          if (!text.trim()) return "nothing to append: `text` is empty";
          try {
            const written = await feishuAppendText({ token: await feishuToken(), documentId: targetId, text });
            noteRoute("/feishu-doc", { action: "append", documentId: ref.id, blocks: written.blocks });
            return `已向 ${ref.id} 追加 ${written.blocks} 段 ✓（revision ${written.revisionId ?? "?"}）`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "append", error: String(error?.message ?? error) });
            return `追加失败：${error?.message ?? error}`;
          }
        },
      });
      /** Pull the spreadsheet token out of a `/sheets/<token>` link, or accept a bare token. */
      function feishuSheetTokenFrom(input) {
        const raw = String(input ?? "").trim();
        const hit = raw.match(/\/sheets\/([A-Za-z0-9]+)/);
        if (hit) return hit[1];
        return /^[A-Za-z0-9]{10,}$/.test(raw) ? raw : "";
      }
      const feishuSheetNew = define({
        name: "feishu_sheet_create",
        nameZh: "飞书表格_创建",
        description:
          "Create a Feishu (飞书 / Lark) spreadsheet and return the link the API itself reports. Needs the app bot credentials.",
        parameters: { title: { type: "string", required: true, description: "Spreadsheet title." } },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const title = String(args?.title ?? "").trim();
          if (!title) return "nothing to create: `title` is empty";
          try {
            const made = await feishuSheetCreate({ token: await feishuToken(), title });
            noteRoute("/feishu-doc", { action: "sheet-create", spreadsheetToken: made.spreadsheetToken });
            return made.url ? `已创建表格「${made.title}」→ ${made.url}` : `已创建表格「${made.title}」（token ${made.spreadsheetToken}）✓，但 API 未返回链接`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "sheet-create", error: String(error?.message ?? error) });
            return `创建表格失败：${error?.message ?? error}`;
          }
        },
      });

      const feishuSheetReadTool = define({
        name: "feishu_sheet_read",
        description:
          "Read a range from a Feishu spreadsheet (飞书表格). Accepts a /sheets/<token> link or a bare token, plus a range like A1:C5 or a full <sheetId>!A1:C5.",
        parameters: {
          link: { type: "string", required: true, description: "Spreadsheet link (/sheets/<token>) or its token." },
          range: { type: "string", required: true, description: "Range such as A1:C5, or <sheetId>!A1:C5." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const token_ = feishuSheetTokenFrom(args?.link);
          if (!token_) return `没有识别出表格：请给出 /sheets/<token> 链接或表格 token（收到「${String(args?.link ?? "").slice(0, 60)}」）`;
          const range = String(args?.range ?? "").trim();
          if (!range) return "nothing to read: `range` is empty";
          try {
            const got = await feishuSheetRead({ token: await feishuToken(), spreadsheetToken: token_, range });
            noteRoute("/feishu-doc", { action: "sheet-read", spreadsheetToken: token_, range: got.range, rows: got.values.length });
            return `表格 ${token_} 的 ${got.range}：\n${JSON.stringify(got.values)}`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "sheet-read", error: String(error?.message ?? error) });
            return `读取表格失败：${error?.message ?? error}`;
          }
        },
      });

      const feishuSheetWriteTool = define({
        name: "feishu_sheet_write",
        description:
          "Write rows into a Feishu spreadsheet range. `values` is an array of rows, e.g. [[\"a\",\"b\"],[\"c\",\"d\"]].",
        parameters: {
          link: { type: "string", required: true, description: "Spreadsheet link (/sheets/<token>) or its token." },
          range: { type: "string", required: true, description: "Range such as A1:B2, or <sheetId>!A1:B2." },
          values: { type: "string", required: true, description: "Rows as JSON, e.g. [[\"a\",\"b\"]]." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const token_ = feishuSheetTokenFrom(args?.link);
          if (!token_) return `没有识别出表格：请给出 /sheets/<token> 链接或表格 token`;
          const range = String(args?.range ?? "").trim();
          if (!range) return "nothing to write: `range` is empty";
          let rows;
          try { rows = JSON.parse(String(args?.values ?? "")); } catch { return `values 不是合法 JSON：请给出行数组，例如 [[\"a\",\"b\"]]`; }
          if (!Array.isArray(rows) || !rows.length) return "values 必须是非空的行数组";
          try {
            const wrote = await feishuSheetWrite({ token: await feishuToken(), spreadsheetToken: token_, range, values: rows });
            noteRoute("/feishu-doc", { action: "sheet-write", spreadsheetToken: token_, range: wrote.range, updatedCells: wrote.updatedCells });
            return `已写入 ${token_} 的 ${wrote.range}：${wrote.updatedCells} 个单元格 ✓（revision ${wrote.revision ?? "?"}）`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "sheet-write", error: String(error?.message ?? error) });
            return `写入表格失败：${error?.message ?? error}`;
          }
        },
      });
      /** Pull the bitable app_token out of a `/base/<token>` link, or accept a bare token. */
      function feishuBitableTokenFrom(input) {
        const raw = String(input ?? "").trim();
        const hit = raw.match(/\/(?:base|bitable)\/([A-Za-z0-9]+)/);
        if (hit) return hit[1];
        return /^[A-Za-z0-9]{10,}$/.test(raw) ? raw : "";
      }

      const feishuBitableNew = define({
        name: "feishu_bitable_create",
        nameZh: "飞书多维表格_创建",
        description: "Create a Feishu (飞书 / Lark) bitable app (多维表格) and return the link the API reports.",
        parameters: { name: { type: "string", required: true, description: "App name." } },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const name = String(args?.name ?? "").trim();
          if (!name) return "nothing to create: `name` is empty";
          try {
            const made = await feishuBitableCreate({ token: await feishuToken(), name });
            noteRoute("/feishu-doc", { action: "bitable-create", appToken: made.appToken });
            return made.url ? `已创建多维表格「${made.name}」→ ${made.url}` : `已创建多维表格「${made.name}」（app_token ${made.appToken}）✓ 但 API 未返回链接，请用该 token ✓`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "bitable-create", error: String(error?.message ?? error) });
            return `创建多维表格失败：${error?.message ?? error}`;
          }
        },
      });

      const feishuBitableWriteTool = define({
        name: "feishu_bitable_write",
        description: "Write one record into a Feishu bitable table. `fields` is a JSON object keyed by field name, e.g. {\"文本\":\"hello\"}.",
        parameters: {
          link: { type: "string", required: true, description: "Bitable link (/base/<token>) or app_token." },
          tableId: { type: "string", description: "Table id; the first table is used when omitted." },
          fields: { type: "string", required: true, description: "Record fields as JSON, e.g. {\"文本\":\"hello\"}." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const app = feishuBitableTokenFrom(args?.link);
          if (!app) return `没有识别出多维表格：请给出 /base/<token> 链接或 app_token`;
          let fields;
          try { fields = JSON.parse(String(args?.fields ?? "")); } catch { return `fields 不是合法 JSON：例如 {"文本":"hello"}`; }
          if (!fields || typeof fields !== "object" || !Object.keys(fields).length) return "fields 必须是非空对象";
          try {
            const tableId = String(args?.tableId ?? "").trim() || (await feishuBitableTables({ token: await feishuToken(), appToken: app })).tableId;
            if (!tableId) return `多维表格 ${app} 没有可用的数据表 ✗`;
            const wrote = await feishuBitableWrite({ token: await feishuToken(), appToken: app, tableId, fields });
            noteRoute("/feishu-doc", { action: "bitable-write", appToken: app, tableId, recordId: wrote.recordId });
            return `已写入 ${app}/${tableId} ✓ record_id=${wrote.recordId} ✓（回显 ${JSON.stringify(wrote.fields)}）`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "bitable-write", error: String(error?.message ?? error) });
            return `写入多维表格失败：${error?.message ?? error}`;
          }
        },
      });

      const feishuBitableReadTool = define({
        name: "feishu_bitable_read",
        description: "Read records from a Feishu bitable table. Pass recordId to read exactly one record, which is the only reliable way to confirm a write.",
        parameters: {
          link: { type: "string", required: true, description: "Bitable link (/base/<token>) or app_token." },
          tableId: { type: "string", description: "Table id; the first table is used when omitted." },
          recordId: { type: "string", description: "Read just this record - the reliable way to verify a write." },
          pageSize: { type: "number", description: "How many records to list (default 20, max 500)." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 120000,
        async execute(args) {
          const app = feishuBitableTokenFrom(args?.link);
          if (!app) return `没有识别出多维表格：请给出 /base/<token> 链接或 app_token`;
          try {
            const tableId = String(args?.tableId ?? "").trim() || (await feishuBitableTables({ token: await feishuToken(), appToken: app })).tableId;
            if (!tableId) return `多维表格 ${app} 没有可用的数据表 ✗`;
            const got = await feishuBitableRead({ token: await feishuToken(), appToken: app, tableId, recordId: args?.recordId, pageSize: args?.pageSize });
            noteRoute("/feishu-doc", { action: "bitable-read", appToken: app, tableId, records: got.items.length });
            return `多维表格 ${app}/${tableId} 的 ${got.items.length} 条记录：\n${JSON.stringify(got.items).slice(0, 4000)}`;
          } catch (error) {
            noteRoute("/feishu-doc", { action: "bitable-read", error: String(error?.message ?? error) });
            return `读取多维表格失败：${error?.message ?? error}`;
          }
        },
      });
      const sendVoiceTool = define({
        name: "wechat_send_voice",
        description:
          "Send a voice message to a WeChat contact or group. Give `text` and it is spoken on this machine (system speech engine, then ffmpeg - nothing is sent to a cloud service), or give `path` for an existing audio file (.mp3/.amr/.wav/.silk). Use this whenever the user asks for a voice reply.",
        parameters: {
          text: { type: "string", description: "What to say. Spoken locally, no cloud service involved." },
          path: { type: "string", description: "Absolute path of an existing audio file, used when `text` is not given." },
          to: { type: "string", description: "WeChat wxid or group id; omit to use the most recent conversation." },
            format: { type: "string", description: "mp3 (default), amr or wav. The audio is delivered as a playable file: WeChat voice bubbles are not deliverable through this API." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 300000,
        execute: async (args) => {
          const spoken = String(args?.text ?? "").trim();
          const given = String(args?.path ?? "").trim();
          if (!spoken && !given) return "nothing to send: give `text` to speak, or `path` to an audio file";
          const { account, chatId } = await resolvePeer(args.to ? String(args.to).trim() : undefined);
          let audio;
          if (spoken) {
            // mp3 by default: a WeChat voice *bubble* is not deliverable through this API (see
            // voiceDeliveryFor), so the audio goes as a file that really does arrive and play.
            const wanted = String(args?.format ?? "").trim() || "mp3";
            try {
              audio = await synthesizeVoice({ text: spoken, format: wanted });
            } catch (error) {
              return `could not make the voice: ${error?.message ?? error}`;
            }
          }
          const contextToken = await contextTokenFor(account, chatId);
          const extension = String(audio?.format ?? given).split(".").pop() ?? "";
          const delivery = voiceDeliveryFor({ platform: "wechat", extension });
          try {
            if (delivery === "bubble") {
              await ilink.sendVoice({ baseUrl: account.baseUrl, token: account.token, toWxid: chatId, filePath: audio?.path ?? given, playtime: audio?.seconds, contextToken });
              ctx.logger?.info?.("[dsh-wechat-media] voice bubble sent to %s (%s)", chatId, audio ? `${audio.format}, ${audio.bytes} bytes` : given);
              return audio
                ? `✅ 已发送语音气泡到 ${chatId}（${audio.format}，${audio.bytes} 字节，${audio.seconds ?? "?"} 秒）`
                : `✅ 已发送语音气泡到 ${chatId}`;
            }
            // WeChat only renders a voice bubble for SILK. Anything else sent as a voice item is accepted and
            // then dropped (measured: the text arrived, the voice never did), so it goes as an audio file -
            // which does arrive, does play, and is what this reply says.
            await ilink.sendFile({ baseUrl: account.baseUrl, token: account.token, toWxid: chatId, filePath: audio?.path ?? given, contextToken });
            ctx.logger?.info?.("[dsh-wechat-media] audio sent as a file to %s (%s)", chatId, audio ? `${audio.format}, ${audio.bytes} bytes` : given);
            return `✅ 已作为**音频文件**发送到 ${chatId}（${audio ? `${audio.format}，${audio.bytes} 字节` : given}）。个人微信不接受语音类型的消息（Tencent 自己的微信渠道也不发它），所以音频以文件形式送达：能收到、能播放。**注意**：iLink 只在"对方最近说过话"的会话窗口内投递，窗口外的发送会被平台接受后丢弃（不报错）——若没收到，请对方先给机器人发一条消息再试。语音气泡在企微那边是可用的。`;
          } catch (error) {
            ctx.logger?.warn?.("[dsh-wechat-media] voice send failed: %s", error?.message ?? error);
            return `could not send the voice: ${error?.message ?? error}`;
          } finally {
            await audio?.cleanup?.();
          }
        },
      });
      const sendFileTool = define({
        name: "wechat_send_file",
        description:
          "Send a local file to a WeChat contact or group through the bridge. Use this whenever the user asks you to send, forward or deliver a file. Images (.jpg/.png/.webp/.gif) go as pictures, videos (.mp4/.mov) as videos, everything else (pdf, docx, xlsx, zip, 7z, ...) as a file attachment. Pass the wxid from the [微信 …] header of the incoming message as `to` when the reply targets a specific chat (a group id looks like `12345678@chatroom`), or omit it to answer the chat that most recently wrote to you.",
        parameters: {
          path: { type: "string", required: true, description: "Absolute path of the local file to send." },
          to: { type: "string", description: "WeChat wxid or group id; omit to use the most recent conversation." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 180_000,
        execute: async (args) => {
          const prepared = await prepareOutbound(String(args.path).trim(), { maxBytes: maxMediaBytes });
          const { account, chatId } = await resolvePeer(args.to ? String(args.to).trim() : undefined);
          const common = { baseUrl: account.baseUrl, token: account.token, toWxid: chatId, filePath: prepared.path, contextToken: await contextTokenFor(account, chatId) };
          if (prepared.kind === "image") await ilink.sendImage(common);
          else if (prepared.kind === "video") await ilink.sendVideo(common);
          else await ilink.sendFile(common);
          ctx.logger?.info?.("[dsh-wechat-media] %s sent to %s: %s (%d bytes)", prepared.kind, chatId, prepared.name, prepared.bytes);
          return `✅ 已发送 ${prepared.kind} 到 ${chatId}：${prepared.name}（${prepared.bytes} 字节）`;
        },
      });

      const sendTextTool = define({
        name: "wechat_send_text",
        description:
          "Send an extra text message to WeChat. Your final answer is already delivered to the same chat automatically, so use this only for something the answer does not cover: an early progress note, or a message to a different chat via `to`. Do not repeat your final answer with it.",
        parameters: {
          text: { type: "string", required: true, description: "Message text (<= 2000 characters)." },
          to: { type: "string", description: "WeChat wxid or group id (e.g. 12345678@chatroom); omit for the most recent conversation." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        timeoutMs: 60_000,
        execute: async (args) => {
          const { account, chatId } = await resolvePeer(args.to ? String(args.to).trim() : undefined);
          await sendText(account, chatId, String(args.text).slice(0, MAX_TEXT_CHARS), { typing: false });
          return `✅ 已发送文字到 ${chatId}`;
        },
      });

      const statusTool = define({
        name: "wechat_status",
        description: "Report which WeChat accounts are paired and which conversations have been active.",
        parameters: {},
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        execute: async () => {
          const accounts = await state.loadAccounts();
          if (accounts.length === 0) return "没有已配对的微信账号（在插件页用二维码配对）。";
          const routes = await state.loadRoutes();
          const lines = accounts.map((account) => {
            const control = monitors.get(account.accountId);
            const state1 = control ? (control.lastError ? `异常：${control.lastError}` : "在线") : "未运行";
            const chats = Object.keys(routes[account.accountId] ?? {});
            return `- ${account.accountId}（${account.userId ?? "?"}）：${state1}，${chats.length} 个会话`;
          });
          return lines.join("\n");
        },
      });

      const disposers = [];
      for (const definition of [sendFileTool, sendTextTool, sendVoiceTool, statusTool, wecomText, wecomFile, wecomVoice, feishuText, feishuFile, feishuDocCreate, feishuDocRead, feishuDocAppend, feishuSheetNew, feishuSheetReadTool, feishuSheetWriteTool, feishuBitableNew, feishuBitableWriteTool, feishuBitableReadTool]) {
        try {
          const dispose = toolCtx.tools.register(definition);
          if (typeof dispose === "function") disposers.push(dispose);
        } catch (error) {
          // A registry that rejects the plain-object fallback must not take the
          // bridge down with it: the reply relay still works without the tools.
          ctx.logger?.warn?.("[dsh-wechat-media] tool %s not registered: %s", definition?.name, error?.message ?? error);
        }
      }
      toolCtx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            // already gone
          }
        }
      }, "dsh-wechat-media: tools");
    })();
  });

  // ── HTTP surface for the browser card ─────────────────────────────────────

  /**
   * Read a boolean from either a JSON body or a query string.
   *
   * The routes are reachable by plain GET links (the card and the no-JS panel rely on
   * that), so `"true"` has to mean true: comparing with `=== true` alone silently
   * turned every allow/deny link into "undecided".
   */
  const asBool = (value) => {
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
    return null;
  };

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(payload);
  };

  const readBody = async (req) => {
    const chunks = [];
    let total = 0;
    // A body that never arrives must not hold a route open forever: a stuck read
    // here is what makes a card button sit on "处理中…" with nothing on the server.
    const reading = (async () => {
      for await (const chunk of req) {
        chunks.push(chunk);
        total += chunk.length;
        if (total > 64 * 1024) throw new Error("body too large");
      }
    })();
    reading.catch(() => {});
    await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 2000))]);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  };

  /**
   * Arguments for a control route: the query string, merged with the JSON body for
   * POSTs. GET is supported on purpose - in one reporter's browser every POST from
   * the card was swallowed before reaching the plugin (nothing in recentRoutes)
   * while GETs worked, so every card action must be expressible as a GET.
   */
  const readArgs = async (req) => {
    const query = Object.fromEntries(new URL(req.url, "http://127.0.0.1").searchParams);
    if (req.method === "POST") return { ...query, ...(await readBody(req)) };
    return query;
  };

  const isLoopback = (req) => {
    const address = req.socket?.remoteAddress ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  };

  ctx.inject(["webServer"], (webCtx) => {
    const routes = [
      {
        // One route for the Web UI's Feishu document actions. The panel has no token of its own - the host holds the
        // credentials - so every action the panel offers is executed here through the same helpers the tools use.
        kind: "exact",
        path: "/dsh-wechat-media/feishu-doc",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          const action = String(body.action ?? "").trim();
          const link = String(body.link ?? "").trim();
          const text = String(body.text ?? "");
          noteRoute("/feishu-doc", { action: `panel-${action}` });
          try {
            if (action === "create") {
              const settings = feishuConfig();
              const title = String(body.title ?? "").trim() || "未命名文档";
              const created = await feishuCreateDoc({ token: await feishuToken(), title, tenantHost: settings.tenantHost });
              const written = text.trim() ? await feishuAppendText({ token: await feishuToken(), documentId: created.documentId, text }) : { blocks: 0 };
              return json(res, 200, {
                ok: true,
                action,
                documentId: created.documentId,
                title: created.title,
                url: created.url || null,
                blocks: written.blocks,
                // Say why there is no link instead of handing over a link built from the API host, which opens a
                // generic page rather than the document.
                note: created.url ? "" : "没有配置 tenantHost，因此不返回链接（用 API 主机拼出来的链接打不开）",
              });
            }
            if (action === "read") {
              const ref = feishuDocRef(link);
              if (!ref.kind) return json(res, 200, { ok: false, error: "没有识别出文档：请给 /docx/<id>、/wiki/<id> 链接或文档 id" });
              let documentId = ref.id;
              if (ref.kind === "wiki") documentId = (await feishuWikiResolve({ token: await feishuToken(), nodeToken: ref.id })).objToken;
              const got = await feishuReadDoc({ token: await feishuToken(), documentId });
              return json(res, 200, { ok: true, action, documentId: got.documentId, chars: got.content.length, content: got.content });
            }
            if (action === "append") {
              const ref = feishuDocRef(link);
              if (!ref.kind) return json(res, 200, { ok: false, error: "没有识别出文档 id" });
              let documentId = ref.id;
              if (ref.kind === "wiki") documentId = (await feishuWikiResolve({ token: await feishuToken(), nodeToken: ref.id })).objToken;
              const written = await feishuAppendText({ token: await feishuToken(), documentId, text });
              return json(res, 200, { ok: true, action, documentId, blocks: written.blocks, revision: written.revisionId });
            }
            if (action === "sheet-read" || action === "sheet-write") {
              const spreadsheetToken = feishuSheetTokenFrom(link);
              if (!spreadsheetToken) return json(res, 200, { ok: false, error: "没有识别出表格 token" });
              const range = String(body.range ?? "").trim();
              if (!range) return json(res, 200, { ok: false, error: "需要范围，例如 A1:C5" });
              if (action === "sheet-read") {
                const got = await feishuSheetRead({ token: await feishuToken(), spreadsheetToken, range });
                return json(res, 200, { ok: true, action, range: got.range, rows: got.values.length, values: got.values });
              }
              let rows;
              try { rows = JSON.parse(text); } catch { return json(res, 200, { ok: false, error: "内容不是合法 JSON 行数组，例如 [[\"a\",\"b\"]]" }); }
              if (!Array.isArray(rows) || !rows.length) return json(res, 200, { ok: false, error: "内容必须是非空行数组" });
              const wrote = await feishuSheetWrite({ token: await feishuToken(), spreadsheetToken, range, values: rows });
              return json(res, 200, { ok: true, action, range: wrote.range, updatedCells: wrote.updatedCells, revision: wrote.revision });
            }
            if (action === "bitable-read" || action === "bitable-write") {
              const appToken = feishuBitableTokenFrom(link);
              if (!appToken) return json(res, 200, { ok: false, error: "没有识别出多维表格 app_token" });
              const tableId = String(body.tableId ?? "").trim() || (await feishuBitableTables({ token: await feishuToken(), appToken })).tableId;
              if (!tableId) return json(res, 200, { ok: false, error: "该多维表格没有可用的数据表" });
              if (action === "bitable-read") {
                const got = await feishuBitableRead({ token: await feishuToken(), appToken, tableId, recordId: body.recordId, pageSize: body.pageSize });
                return json(res, 200, { ok: true, action, tableId, records: got.items.length, items: got.items });
              }
              let fields;
              try { fields = JSON.parse(text); } catch { return json(res, 200, { ok: false, error: "字段不是合法 JSON 对象，例如 {\"文本\":\"hello\"}" }); }
              if (!fields || typeof fields !== "object" || !Object.keys(fields).length) return json(res, 200, { ok: false, error: "字段必须是非空对象" });
              const wrote = await feishuBitableWrite({ token: await feishuToken(), appToken, tableId, fields });
              return json(res, 200, { ok: true, action, tableId, recordId: wrote.recordId, fields: wrote.fields });
            }
            return json(res, 200, { ok: false, error: `未知 action：${action || "(空)"}` });
          } catch (error) {
            return json(res, 200, { ok: false, error: String(error?.message ?? error) });
          }
        },
      },
      {
        kind: "exact",
        path: "/dsh-wechat-media/state",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          const accounts = await state.loadAccounts();
          const prefs = await state.loadPrefs();
          const routes = await state.loadRoutes();
          json(res, 200, {
            ok: true,
            stateRoot,
            inboxRoot: await resolvedInbox(),
            inboxRootDefault: inboxRoot(dshHome),
            inboxRootConfig: typeof config.inboxDir === "string" ? config.inboxDir : null,
            // Public view: the Feishu secrets live in prefs now, and `/state` is readable over loopback.
            prefs: publicPrefs(prefs),
            tokens: summarize(await state.loadTokens()),
            // Why a live preview did or did not appear: deltas seen, previews sent, previews the
            // streamer refused, and the shape of the last frame.
            stream: {
              deltas: counters.streamDeltas,
              chunks: counters.streamChunks,
              refused: counters.streamRefused,
              finalized: counters.streamFinalized,
              finalizeFailed: counters.streamFinalizeFailed,
              fallback: counters.streamFallback,
              lastFinalizeError: lastStreamFinalizeError,
              finalizeErrors: [...streamFinalizeErrors],
              lastFrame: lastStreamFrame,
              unknownEvents: [...new Set(collectors.unknownEvents)],
              delivery: prefs.delivery ?? "whole",
            },
            // A counter that stopped counting must be visible, not inferred from the numbers.
            tokenAccountingError,
            peers: await state.loadPeers(),
            counters: { ...counters },
            interjections: interjections.slice(-10),
            feishu: await feishuState(),
            approvals: approvals.list(),
            lastApproval: approvals.last() ?? null,
            wecom: await wecomState(),
            recentRoutes: [...routeLog],
            lastInbound: Object.fromEntries(lastInbound.entries()),
            accounts: accounts.map((account) => {
              const control = monitors.get(account.accountId);
              return {
                accountId: account.accountId,
                userId: account.userId,
                botId: account.botId,
                baseUrl: account.baseUrl,
                savedAt: account.savedAt,
                running: Boolean(control && !control.stopped),
                connectedAt: control?.connectedAt,
                lastPollAt: control?.lastPollAt,
                lastError: control?.lastError,
                chats: Object.keys(routes[account.accountId] ?? {}),
              };
            }),
            logins: logins.list().map((session) => publicLogin(session)),
          });
        },
      },
      {
        kind: "exact",
        path: "/dsh-wechat-media/login",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          try {
            const session = await logins.start();
            void logins.run(session).then(async (finished) => {
              if (finished.status === "confirmed" && finished.accountId) {
                try {
                  await monitorAccount(finished.accountId);
                } catch (error) {
                  ctx.logger?.warn?.("[dsh-wechat-media] monitor after pairing failed: %s", error?.message ?? error);
                }
              }
            });
            json(res, 200, { ok: true, login: publicLogin(session) });
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      },
      {
        // A prefix route must be registered WITHOUT a trailing slash: the
        // matcher tests `pathname.startsWith(prefix + "/")`, so a trailing slash
        // here would look for a double slash and never match.
        kind: "prefix",
        path: "/dsh-wechat-media/login",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          const rest = req.url.slice("/dsh-wechat-media/login/".length).split("?")[0];
          const [loginId, action] = rest.split("/");
          const session = logins.get(loginId);
          if (!session) return json(res, 404, { error: "unknown login session" });
          if (action === "verify" && (req.method === "POST" || req.method === "GET")) {
            const body = await readArgs(req);
            logins.submitVerifyCode(session, body.code);
            return json(res, 200, { ok: true, login: publicLogin(session) });
          }
          if (action === "cancel" && (req.method === "POST" || req.method === "GET")) {
            logins.cancel(session);
            return json(res, 200, { ok: true, login: publicLogin(session) });
          }
          return json(res, 200, { ok: true, login: publicLogin(session) });
        },
      },
      {
        kind: "prefix",
        path: "/dsh-wechat-media/qr",
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            res.statusCode = 403;
            return res.end();
          }
          const loginId = req.url.slice("/dsh-wechat-media/qr/".length).split("?")[0];
          const session = logins.get(loginId);
          const payload = session?.qrPayload;
          if (!payload) {
            res.statusCode = 404;
            return res.end();
          }
          try {
            const text = String(payload);
            if (text.startsWith("data:")) {
              // A caller-supplied renderer already produced the image.
              const comma = text.indexOf(",");
              const meta = text.slice(5, comma);
              const body = text.slice(comma + 1);
              const bytes = /base64/i.test(meta) ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body));
              res.writeHead(200, { "content-type": meta.split(";")[0] || "image/png", "cache-control": "no-store" });
              return res.end(bytes);
            }
            // The platform's `qrcode_img_content` is a landing-page URL, not a
            // bitmap, so the code is rendered here from that URL - which is what
            // the official client encodes too.
            const svg = renderQrSvg(text);
            res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
            res.end(svg);
          } catch (error) {
            res.statusCode = 500;
            res.end(String(error?.message ?? error));
          }
        },
      },
      {
        kind: "exact",
        path: "/dsh-wechat-media/logout",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          const accountId = String(body.accountId ?? "");
          const control = monitors.get(accountId);
          if (control) control.stopped = true;
          if (accountId) await state.removeAccount(accountId);
          json(res, 200, { ok: true });
        },
      },
      {
        kind: "exact",
        path: "/dsh-wechat-media/peers",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          const accountId = String(body.accountId ?? "");
          const chatId = String(body.chatId ?? "");
          if (!accountId || !chatId) return json(res, 400, { error: "accountId and chatId are required" });
          // true = allowed, false = blocked, anything else = undecided (unlisted).
          const allowed = asBool(body.allowed);
          const peer = await state.setPeer(accountId, chatId, { allowed });
          json(res, 200, { ok: true, peer, peers: await state.loadPeers() });
        },
      },
      {
        kind: "exact",
        path: "/dsh-wechat-media/prefs",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          // Field **names** only, never values: this is what makes "did the panel's Save reach the plugin at
          // all?" answerable from /state. Without it the browser side and the host side can both look fine
          // while the write simply never happens.
          noteRoute("/prefs", { fields: Object.keys(body ?? {}).slice(0, 12) });
          const patch = {};
          if (asBool(body.requireAllowlist) !== null) patch.requireAllowlist = asBool(body.requireAllowlist);
          if (asBool(body.friendOnly) !== null) patch.friendOnly = asBool(body.friendOnly);
          if (asBool(body.interject) !== null) patch.interject = asBool(body.interject);
          if (asBool(body.retry) !== null) patch.retry = asBool(body.retry);
          // The Feishu block of the Web UI panel writes here. It is handled before the reply because a
          // changed app id/secret has to reconnect the long connection, and the response then carries
          // the fresh state so the panel can show "connected" or the reason it is not.
          const feishuPatch = feishuPrefsPatch(Object.fromEntries(
            Object.keys({ ...FEISHU_PREF_FIELDS, ...FEISHU_PREF_SWITCHES }).map((field) => [field, body[field]]),
          ));
          if (feishuPatch.error) return json(res, 400, { error: feishuPatch.error });
          if (feishuPatch.changed.length) {
            const applied = await applyFeishuPrefs(Object.fromEntries(
              Object.keys({ ...FEISHU_PREF_FIELDS, ...FEISHU_PREF_SWITCHES }).map((field) => [field, body[field]]),
            ));
            if (applied.error) return json(res, 400, { error: applied.error });
            const prefsAfter = await state.savePrefs({});
            return json(res, 200, { ok: true, prefs: publicPrefs(prefsAfter), feishu: applied.feishu, feishuChanged: applied.changed });
          }
          if (body.format !== undefined && body.format !== "") {
            const mode = String(body.format).trim().toLowerCase();
            if (!["plain", "raw"].includes(mode)) return json(res, 400, { error: `format must be "plain" or "raw", got "${body.format}"` });
            patch.format = mode;
          }
          if (body.delivery !== undefined && body.delivery !== "") {
            const mode = String(body.delivery).trim().toLowerCase();
            if (!["whole", "stream"].includes(mode)) return json(res, 400, { error: `delivery must be "whole" or "stream", got "${body.delivery}"` });
            patch.delivery = mode;
          }
          if (body.authorization !== undefined && body.authorization !== "") {
            const level = String(body.authorization).trim().toLowerCase();
            if (!AUTHORIZATION_LEVELS.includes(level)) {
              return json(res, 400, { error: `authorization must be one of ${AUTHORIZATION_LEVELS.join(", ")}, got "${body.authorization}"` });
            }
            patch.authorization = level;
          }
          if (asBool(body.autoReply) !== null) patch.autoReply = asBool(body.autoReply);
          if (typeof body.maxMediaMiB === "number" && body.maxMediaMiB > 0) patch.maxMediaMiB = body.maxMediaMiB;
          if (body.inboxDir !== undefined) {
            const value = String(body.inboxDir).trim();
            // Empty clears the preference (back to the config or the default); a
            // relative path is refused instead of landing somewhere surprising.
            if (value === "") patch.inboxDir = null;
            else if (!isAbsolute(value)) return json(res, 400, { error: `inboxDir must be an absolute path, got "${value}"` });
            else patch.inboxDir = value;
          }
          const prefs = await state.savePrefs(patch);
          json(res, 200, { ok: true, prefs: publicPrefs(prefs) });
        },
      },
      {
        // The token ledger: read it, zero it, or change how long a window lasts (1..30 days).
        // The card and `/tokens` both go through here, so they cannot disagree.
        kind: "exact",
        path: "/dsh-wechat-media/tokens",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          if (asBool(body.reset) === true) {
            await state.resetTokens();
            noteRoute("/tokens", { action: "reset" });
          }
          if (body.windowDays !== undefined && body.windowDays !== "") {
            const requested = Number(body.windowDays);
            if (!Number.isFinite(requested)) return json(res, 400, { error: `windowDays must be a number, got "${body.windowDays}"` });
            await state.setTokenWindow(requested);
            noteRoute("/tokens", { action: "window", requested, applied: clampWindowDays(requested) });
          }
          json(res, 200, { ok: true, tokens: summarize(await state.loadTokens()) });
        },
      },
      {
        // Self-test for the WeChat round trip of an approval: it sends exactly the
        // prompt a real request sends and waits for the 1/2 answer. It does not go
        // through the harness, so it verifies the channel, not the hook.
        kind: "exact",
        path: "/dsh-wechat-media/test-approval",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          const routes = await state.loadRoutes();
          // Whichever channel can actually reach a chat: a WeChat account with a usable token, or
          // the WeCom long connection - the only channel on a bot-only setup, where the WeChat
          // account has no token and every send fails with ret=-3 (measured live).
          const wecomCfg = await state.loadWecom();
          const wecomId = wecomCfg.botId ? wecomAccountId(wecomCfg.botId) : "";
          const requested = String(body.chatId ?? "");
          const wecomChat = requested || lastInbound.get(wecomId)?.chatId || Object.keys(routes[wecomId] ?? {})[0];
          const listed = String(body.accountId ?? "") || (await state.listAccounts())[0];
          const listedAccount = listed ? await state.loadAccount(listed) : undefined;
          const wantWecom = Boolean(wecomId) && wecomBotStatus.authenticated && Boolean(wecomChat)
            && (!listedAccount?.token || !requested || requested === wecomChat || Object.keys(routes[wecomId] ?? {}).includes(requested));
          const accountId = wantWecom ? wecomId : listed;
          const account = wantWecom ? { accountId: wecomId, via: "wecom" } : listedAccount;
          const chatId = wantWecom ? wecomChat : (requested || lastInbound.get(accountId)?.chatId || Object.keys(routes[accountId] ?? {})[0]);
          if (!account || !chatId) {
            return json(res, 400, { error: "no channel to ask through", note: "pair a WeChat account, or connect the WeCom bot and write to it once" });
          }
          if (approvals.pending.has(`${accountId}|${chatId}`)) {
            // Answer 200 with a reason instead of an HTTP error: the card can then
            // explain "one is already waiting" rather than showing a raw failure.
            return json(res, 200, {
              ok: false,
              reason: "pending",
              sent: false,
              error: "an approval is already waiting in this chat",
              waiting: approvals.list(),
            });
          }
          const timeoutMs = Math.max(15, Number(body.timeoutSec ?? config.approvalTimeoutSec ?? 120)) * 1000;
          // The self-test must obey the authorization level, or it contradicts the setting it
          // sits next to: with 仅查看 it is refused without a prompt, with 完全权限 it is skipped
          // (this plugin would not ask either), and only 严格/适中 actually send the prompt.
          const policy = approvalPolicyFor((await state.loadPrefs()).authorization);
          if (!policy.ask) {
            const skipped = policy.decision === "allowed-once"
              ? `当前档位「${policy.label}」：不在聊天里问，需要授权的操作会被**自动批准**，所以自检不发提示。`
              : policy.decision === "rejected"
                ? `当前档位「${policy.label}」：需要授权的操作会被直接拒绝，所以自检不发提示。`
                : `当前档位「${policy.label}」：不在聊天里问，所以自检不发提示。`;
            if (policy.decision) approvals.record?.({ outcome: policy.decision, chatId, toolName: "self-test", reason: `authorization-level-${policy.level}` });
            noteRoute("/test-approval", { chatId, skipped: policy.level });
            return json(res, 200, { ok: false, accountId, chatId, sent: false, skipped: policy.level, note: skipped, waiting: approvals.list() });
          }
          // Wait only for the send, never for the answer: blocking the HTTP request
          // for up to two minutes made the card's button look dead, and returning
          // "sent" before the prompt left made a failed send look like nothing
          // happened. The wait continues in the background; the card polls /state
          // (approvals while waiting, lastApproval once answered).
          const send = await new Promise((resolve) => {
            let settled = false;
            const done = (value) => { if (!settled) { settled = true; resolve(value); } };
            approvals.ask(account, chatId, {
              toolName: body.toolName ?? "dsh-wechat-media self-test",
              reason: body.reason ?? "test approval: verifies the 1/2 round trip; nothing is executed",
            }, {
              timeoutMs,
              accountId,
              onSent: (ok, error) => done({ sent: ok, error: error?.message }),
            }).then(
              (outcome) => done({ sent: true, outcome: outcome ?? null }),
              (error) => done({ sent: false, error: String(error?.message ?? error) }),
            );
          });
          noteRoute("/test-approval", { chatId, sent: send.sent === true, error: send.error ?? null, level: policy.level });
          json(res, 200, {
            ok: send.sent === true,
            accountId,
            chatId,
            sent: send.sent === true,
            level: policy.level,
            error: send.error ?? null,
            outcome: send.outcome ?? null,
            waiting: approvals.list(),
          });
        },
      },
      {
        // Verification helper: feed the receive path an envelope shaped like the
        // platform's, so the inbound pipeline (allowlist -> agent -> reply) can be
        // exercised and read back through peers.json, the route table and the
        // counters without a phone. Loopback only, like every other route here.
        kind: "exact",
        path: "/dsh-wechat-media/debug/inbound",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          const accountId = String(body.accountId ?? "") || (await state.listAccounts())[0];
          const account = accountId ? await state.loadAccount(accountId) : undefined;
          if (!account?.token) return json(res, 400, { error: "no paired account" });
          const routes = await state.loadRoutes();
          const chatId = String(body.chatId ?? "")
            || lastInbound.get(accountId)?.chatId
            || Object.keys(routes[accountId] ?? {})[0];
          if (!chatId) return json(res, 400, { error: "no chat yet: write to the bot once or pass chatId" });
          const envelope = syntheticInbound({ chatId, text: body.text, fromUserId: body.fromUserId });
          noteRoute("/debug/inbound", { chatId, text: String(body.text ?? "").slice(0, 40) });
          await handleInbound(accountId, envelope);
          const after = await state.loadRoutes();
          json(res, 200, {
            ok: true,
            accountId,
            chatId,
            messageId: envelope.message_id,
            isGroup: /@chatroom$/.test(chatId),
            route: after[accountId]?.[chatId] ?? null,
            peer: (await state.loadPeers())[accountId]?.[chatId] ?? null,
            counters: { ...counters },
            approvals: approvals.list(),
            lastApproval: approvals.last() ?? null,
            wecom: await wecomState(),
            recentRoutes: [...routeLog],
          });
        },
      },
      {
        // Cancel a question that is waiting in WeChat (a mis-click should not have to
        // wait for the timeout); the requester then falls back to the GUI prompt.
        kind: "exact",
        path: "/dsh-wechat-media/approvals/cancel",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
          const body = await readArgs(req);
          const accountId = String(body.accountId ?? "") || (await state.listAccounts())[0];
          const chatId = String(body.chatId ?? "") || approvals.list()[0]?.chatId || "";
          if (!chatId) return json(res, 400, { error: "no approval is pending" });
          const cancelled = approvals.cancel(accountId, chatId);
          noteRoute("/approvals/cancel", { chatId, cancelled });
          json(res, 200, { ok: true, cancelled, approvals: approvals.list() });
        },
      },
      {
        // Plain-URL fallback for the same self-test: paste
        // /dsh-wechat-media/send-test-approval into the browser and the prompt goes
        // out without any card JavaScript. GET and POST both accepted; the reply is
        // a tiny HTML page. Loopback only, like the rest of this surface.
        kind: "exact",
        path: "/dsh-wechat-media/send-test-approval",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "GET or POST only" });
          const query = Object.fromEntries(new URL(req.url, "http://127.0.0.1").searchParams);
          const body = req.method === "POST" ? { ...query, ...(await readBody(req)) } : query;
          const accountId = String(body.accountId ?? "") || (await state.listAccounts())[0];
          const account = accountId ? await state.loadAccount(accountId) : undefined;
          const routes = await state.loadRoutes();
          const chatId = String(body.chatId ?? "")
            || lastInbound.get(accountId)?.chatId
            || Object.keys(routes[accountId] ?? {})[0];
          let result;
          if (!account?.token) result = { sent: false, error: "no paired account" };
          else if (!chatId) result = { sent: false, error: "no chat yet: write to the bot once" };
          else if (approvals.pending.has(`${accountId}|${chatId}`)) result = { sent: false, reason: "pending", error: "an approval is already waiting in this chat" };
          else {
            const timeoutMs = Math.max(15, Number(body.timeoutSec ?? config.approvalTimeoutSec ?? 120)) * 1000;
            result = await new Promise((resolve) => {
              let settled = false;
              const done = (value) => { if (!settled) { settled = true; resolve(value); } };
              approvals.ask(account, chatId, {
                toolName: body.toolName ?? "dsh-wechat-media self-test",
                reason: body.reason ?? "test approval via URL: verifies the 1/2 round trip; nothing is executed",
              }, { timeoutMs, accountId, onSent: (ok, error) => done({ sent: ok, error: error?.message }) })
                .then((outcome) => done({ sent: true, outcome: outcome ?? null }), (error) => done({ sent: false, error: String(error?.message ?? error) }));
            });
          }
          noteRoute("/send-test-approval", { method: req.method, chatId, sent: result.sent === true, error: result.error ?? null });
          const title = result.sent ? "✅ 审批提示已发送到微信" : "❌ 审批提示没有发出去";
          const detail = result.sent
            ? `chatId: ${chatId}<br>请在微信里回 <b>1</b>（批准一次）或 <b>2</b>（拒绝）。`
            : `原因：${String(result.error ?? "?")}${result.reason === "pending" ? "<br>（已有一条在等待：去微信回 1/2，或在卡片上点「取消等待」）" : ""}`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html><meta charset="utf-8"><title>dsh-wechat-media</title><body style="font:16px/1.7 system-ui;padding:28px;max-width:640px"><h3>${title}</h3><p>${detail}</p><p style="color:#666">这是 dsh-wechat-media 的自检页面（仅本机可访问）。</p><p style="margin-top:22px"><button onclick="history.back()" style="font:15px system-ui;padding:6px 14px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer">← 返回 DSH</button> <span style="color:#888;font-size:13px">（或按浏览器的返回键）</span></p></body>`);
        },
      },
      {
        // A no-JavaScript control panel. In the reporter's browser every fetch from
        // the card was swallowed before reaching the plugin, while plain navigation
        // worked - so everything the card can do is also available here as links.
        kind: "exact",
        path: "/dsh-wechat-media/panel",
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            return res.end("loopback only");
          }
          const args = Object.fromEntries(new URL(req.url, "http://127.0.0.1").searchParams);
          const accountId = String(args.accountId ?? "") || (await state.listAccounts())[0];
          const account = accountId ? await state.loadAccount(accountId) : undefined;
          const routes = await state.loadRoutes();
          const chatFallback = () => String(args.chatId ?? "") || lastInbound.get(accountId)?.chatId || Object.keys(routes[accountId] ?? {})[0] || "";
          let note = "";
          if (args.set) {
            const [acct, chat, decision] = String(args.set).split("|");
            const allowed = decision === "allowed" ? true : decision === "blocked" ? false : null;
            await state.setPeer(acct, chat, { allowed });
            note = `已把 ${chat} 设为 ${decision === "allowed" ? "允许" : decision === "blocked" ? "忽略" : "未决定"}`;
            noteRoute("/panel", { action: "set", chatId: chat, decision });
          } else if (args.inboxDir !== undefined) {
            const value = String(args.inboxDir).trim();
            if (value === "") {
              await state.savePrefs({ inboxDir: null });
              note = "收件目录已恢复默认（$DSH_HOME/wechat-inbox）";
            } else if (!isAbsolute(value)) {
              note = `❌ 必须是绝对路径，收到的是「${value}」`;
            } else {
              await state.savePrefs({ inboxDir: value });
              note = `收件目录已改为 ${value}`;
            }
            noteRoute("/panel", { action: "inboxDir", value, ok: note.startsWith("收件目录") });
          } else if (args.allowlist) {
            await state.savePrefs({ requireAllowlist: args.allowlist === "true" });
            note = `白名单开关 → ${args.allowlist === "true" ? "开" : "关"}`;
            noteRoute("/panel", { action: "allowlist", value: args.allowlist });
          } else if (args.friendOnly) {
            await state.savePrefs({ friendOnly: args.friendOnly === "true" });
            note = `只处理好友私聊 → ${args.friendOnly === "true" ? "开（群消息静默忽略）" : "关（群消息照常处理）"}`;
            noteRoute("/panel", { action: "friendOnly", value: args.friendOnly });
          } else if (args.interject) {
            await state.savePrefs({ interject: args.interject === "true" });
            note = `插话功能 → ${args.interject === "true" ? "开（正在回复时新消息插进当前回合）" : "关（新消息排队成下一轮）"}`;
            noteRoute("/panel", { action: "interject", value: args.interject });
          } else if (args.retry) {
            await state.savePrefs({ retry: args.retry === "true" });
            note = `失败自动重试 → ${args.retry === "true" ? "开（传输类错误重试一次）" : "关"}`;
            noteRoute("/panel", { action: "retry", value: args.retry });
          } else if (Object.keys({ ...FEISHU_PREF_FIELDS, ...FEISHU_PREF_SWITCHES }).some((field) => args[field] !== undefined)) {
            const applied = await applyFeishuPrefs(args);
            if (applied.error) {
              note = `飞书配置未保存：${applied.error}`;
            } else {
              note = `飞书配置已更新（${applied.changed.length} 项）→ ${applied.feishu.configured ? (applied.feishu.connection?.state === "connected" ? "长连接已连接" : `长连接：${applied.feishu.connection?.state ?? "未连接"}`) : "尚未配置完整"}`;
              noteRoute("/panel", { action: "feishu", changed: applied.changed });
            }
          } else if (args.cancel) {
            const chatId = chatFallback();
            const cancelled = chatId ? approvals.cancel(accountId, chatId) : false;
            note = cancelled ? "已取消等待中的审批（转由 GUI 处理）" : "当前没有待批的审批";
            noteRoute("/panel", { action: "cancel", chatId, cancelled });
          } else if (args.test) {
            const chatId = chatFallback();
            if (!account?.token) note = "❌ 没有已配对的账号";
            else if (!chatId) note = "❌ 还没有对话：先在微信里给 bot 发一条消息";
            else if (approvals.pending.has(`${accountId}|${chatId}`)) note = "ℹ️ 这条对话已有一条审批在等待（在微信回 1/2，或点下面的取消）";
            else {
              const sent = await new Promise((resolve) => {
                let settled = false;
                const done = (value) => { if (!settled) { settled = true; resolve(value); } };
                approvals.ask(account, chatId, {
                  toolName: "dsh-wechat-media self-test",
                  reason: "来自控制面板的自检：验证微信里回 1/2 的链路，不会真的执行任何操作",
                }, { timeoutMs: 120000, accountId, onSent: (ok, error) => done(ok ? true : `❌ 发送失败：${error?.message ?? error}`) })
                  .then(() => done(true), (error) => done(`❌ ${error?.message ?? error}`));
              });
              note = sent === true ? `✅ 审批提示已发送到微信（chatId: ${chatId}），请在微信回 1 或 2` : String(sent);
              noteRoute("/panel", { action: "test", sent: sent === true });
            }
          }
          const prefs = await state.loadPrefs();
          const peers = (await state.loadPeers())[accountId] ?? {};
          const pending = approvals.list();
          const rows = Object.entries(peers).map(([chatId, peer]) => {
            const stateText = peer.allowed === true ? "允许" : peer.allowed === false ? "忽略" : "未决定";
            const link = (decision, label) => `<a class="b" href="?set=${encodeURIComponent(`${accountId}|${chatId}|${decision}`)}">${label}</a>`;
            const blocked = Number(peer.blockedCount) > 0 ? ` · 已拦截 ${peer.blockedCount} 条` : "";
            return `<tr><td>${chatId}<div class="m">${peer.kind === "group" ? "群" : "私聊"} · 当前：${stateText}${blocked}</div></td>`
              + `<td>${link("allowed", "允许")} ${link("blocked", "忽略")} ${link("clear", "清除")}</td></tr>`;
          }).join("");
          const html = `<!doctype html><meta charset="utf-8"><title>dsh-wechat-media 控制面板</title>
<style>body{font:15px/1.7 system-ui;padding:26px;max-width:860px;color:#222}
h3{margin:0 0 6px}h4{margin:22px 0 6px}a.b{display:inline-block;padding:3px 10px;border:1px solid #bbb;border-radius:6px;text-decoration:none;color:#036;margin:0 4px 4px 0}
.m{color:#666;font-size:13px}table{border-collapse:collapse;width:100%}td{padding:6px 4px;border-bottom:1px solid #eee;vertical-align:top}
.note{background:#f3f7ff;border:1px solid #cfe0ff;padding:8px 12px;border-radius:8px;margin:14px 0}</style>
<body><p style="margin:0 0 10px"><button onclick="history.back()" style="font:15px system-ui;padding:6px 14px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer">← 返回 DSH</button></p><h3>dsh-wechat-media 控制面板（纯链接，不需要 JavaScript）</h3>
<div class="m">账号：${accountId ?? "（无）"} · 白名单：${prefs.requireAllowlist ? "开" : "关"} · 待批审批：${pending.length}</div>
${note ? `<div class="note">${note}</div>` : ""}
<h4>审批</h4>
<a class="b" href="?test=1">发送一条测试审批到微信</a>
${pending.length ? `<a class="b" href="?cancel=1">取消等待中的审批</a><div class="m">等待中：${pending.map((item) => `${item.toolName ?? "?"}（${Math.round(item.waitedMs / 1000)} 秒）`).join("、")}</div>` : ""}
<h4>企业微信（WeCom）</h4>
<div class="m">当前：${(await state.loadWecom()).webhookUrl ? "群机器人 webhook 已配置" : (await state.loadWecom()).corpSecret ? "自建应用已配置" : "未配置"} · 长连接：${wecomBotStatus.authenticated ? "已认证" : ((await state.loadWecom()).botId ? "未连接/连接中" : "未配置")}</div>
<p><a class="b" href="/dsh-wechat-media/wecom">配置企业微信 / 发送测试消息</a></p>
<h4>收件目录</h4>
<div class="m">微信收到的文件保存在：<code>${await resolvedInbox()}</code></div>
<p><a class="b" href="/dsh-wechat-media/pick-folder">用系统文件夹选择器选择…</a></p>
<form method="get" style="margin:8px 0">
  <input name="inboxDir" placeholder="绝对路径，例如 D:\\wechat-files" value="" style="font:14px system-ui;padding:6px 8px;width:420px">
  <button type="submit" style="font:14px system-ui;padding:6px 12px">保存</button>
  <button type="submit" name="inboxDir" value="" style="font:14px system-ui;padding:6px 12px">恢复默认</button>
</form>
<h4>联系人白名单</h4>
<a class="b" href="?allowlist=${prefs.requireAllowlist ? "false" : "true"}">${prefs.requireAllowlist ? "关闭" : "开启"}「只接收白名单内的联系人与群」</a>
<table>${rows || `<tr><td class="m">还没有联系人给它发过消息</td></tr>`}</table>
<p class="m" style="margin-top:22px">本页仅本机可访问；所有操作都通过普通链接完成。</p><p style="margin-top:22px"><button onclick="history.back()" style="font:15px system-ui;padding:6px 14px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer">← 返回 DSH</button> <span style="color:#888;font-size:13px">（或按浏览器的返回键）</span></p></body>`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(html);
        },
      },
      {
        // Opens the operating system's folder picker on the user's desktop and saves
        // the choice as the inbox directory. Reachable as a plain link, because the
        // browser cannot supply an absolute path itself.
        kind: "exact",
        path: "/dsh-wechat-media/pick-folder",
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            return res.end("loopback only");
          }
          const picked = await pickFolder();
          if (picked.path) await state.savePrefs({ inboxDir: picked.path });
          noteRoute("/pick-folder", { picked: picked.path ?? null, error: picked.error ?? null, elapsedMs: picked.elapsedMs ?? null });
          const neverShown = !picked.path && !picked.error && (picked.elapsedMs ?? 0) < 3000;
          const title = picked.path ? "✅ 收件目录已设为系统选择器里选的目录" : "ℹ️ 没有选择目录";
          const detail = picked.path
            ? `<code>${picked.path}</code><br>微信收到的文件会保存在 <code>${picked.path}/&lt;日期&gt;/&lt;会话&gt;/</code>`
            : picked.error
              ? `弹窗失败：${picked.error}<br>（可以直接在输入框里手输绝对路径）`
              : neverShown
                ? `系统没有把文件夹对话框显示出来（宿主进程可能无法弹窗，用时 ${picked.elapsedMs} ms）。<br>请直接在卡片或控制面板的输入框里填入绝对路径，例如 <code>D:\\wechat-files</code>。`
                : "对话框被取消，目录未改变。";
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html><meta charset="utf-8"><title>dsh-wechat-media</title><body style="font:16px/1.7 system-ui;padding:28px;max-width:680px"><h3>${title}</h3><p>${detail}</p><p style="margin-top:22px"><button onclick="history.back()" style="font:15px system-ui;padding:6px 14px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer">← 返回 DSH</button></p></body>`);
        },
      },
      {
        // Reproduce the long-connection inbound path locally, without waiting for a
        // real WeCom message: the same synthetic frame the server would push.
        kind: "exact",
        path: "/dsh-wechat-media/wecom/inbound-test",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: "loopback only" });
          const args = Object.fromEntries(new URL(req.url, "http://127.0.0.1").searchParams);
          const cfg = await state.loadWecom();
          if (!cfg.botId) return json(res, 400, { error: "no WeCom bot configured" });
          const accountId = wecomAccountId(cfg.botId);
          const chatId = String(args.chatId ?? "debug-wecom-chat");
          // `chatType=group` makes the synthesised callback a group message, which is the
          // only way to exercise group-only rules ("only answer friends", the group part of
          // the allowlist) without a second person in a real group. Anything else is a 1:1.
          const chatType = String(args.chatType ?? args.chattype ?? "").toLowerCase() === "group" ? "group" : "single";
          const stamp = Date.now();
          const frame = {
            cmd: "aibot_msg_callback",
            headers: { req_id: `debug-${stamp}` },
            body: {
              msgid: `debug-${stamp}`,
              aibotid: cfg.botId,
              chatid: chatId,
              chattype: chatType,
              msgtype: "text",
              text: { content: String(args.text ?? "(debug) inbound from the debug route") },
            },
          };
          const message = describeBotMessage(frame);
          const started = Date.now();
          await handleWecomInbound(accountId, message, frame);
          // The router resolves a chat's session from its `/new` generation, so the echo has to
          // do the same: it used to print the generation-0 id, which sent a reader chasing a
          // session the chat had left behind (it did, for a good hour).
          const generation = await generationOf(accountId, chatId);
          json(res, 200, {
            ok: true,
            chatId,
            chatType,
            generation,
            sessionId: sessionIdFor(accountId, chatId, generation),
            ms: Date.now() - started,
            inboundError: wecomInboundError,
          });
        },
      },
      {
        // WeCom setup and self-test as a plain page: a browser that cannot fetch from
        // the card still navigates fine, and the corpsecret never has to pass through
        // the card's own JavaScript.
        kind: "exact",
        path: "/dsh-wechat-media/wecom",
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            return res.end("loopback only");
          }
          const args = Object.fromEntries(new URL(req.url, "http://127.0.0.1").searchParams);
          let note = "";
          const patch = {};
          for (const key of ["webhookUrl", "corpId", "corpSecret", "agentId", "toUser", "botId", "botSecret"]) {
            if (args[key] !== undefined) patch[key] = String(args[key]).trim();
          }
          if (Object.keys(patch).length > 0) {
            if (patch.webhookUrl && !wecom.isWebhookUrl(patch.webhookUrl)) {
              note = "❌ webhook 地址不像企业微信群机器人地址（应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）";
            } else {
              await state.saveWecom(patch);
              wecomTokenCache.clear();
              // A changed BotID/Secret means the long connection has to be rebuilt.
              if (patch.botId !== undefined || patch.botSecret !== undefined) {
                await state.saveWecom({ botEnabled: Boolean((await state.loadWecom()).botId && (await state.loadWecom()).botSecret) });
                await startWecomBot({ force: true });
              }
              note = `✅ 已保存${patch.corpSecret || patch.botSecret ? "（密钥已更新）" : ""}`;
              noteRoute("/wecom", { action: "save", fields: Object.keys(patch) });
            }
          }
          if (args.bot === "stop") {
            stopWecomBot();
            note = "已断开企业微信长连接";
            noteRoute("/wecom", { action: "bot-stop" });
          } else if (args.bot === "start") {
            await startWecomBot({ force: true });
            await new Promise((resolve) => setTimeout(resolve, 1200));
            note = wecomBotStatus.authenticated
              ? "✅ 长连接已认证成功"
              : `⏳ 已发起连接：${wecomBotStatus.error ?? "等待认证应答（若一直失败请核对 BotID/Secret，以及机器人是否为「API 模式 + 长连接」）"}`;
            noteRoute("/wecom", { action: "bot-start", authenticated: wecomBotStatus.authenticated === true, error: wecomBotStatus.error ?? null });
          }
          if (args.test) {
            try {
              const stamp = new Date().toLocaleString("zh-CN");
              const sent = await wecomSendText({ text: `dsh-wechat-media 测试消息 · ${stamp}`, to: args.to });
              const label = { webhook: "群机器人", "long-connection": "智能机器人长连接", app: "自建应用" }[sent.via] ?? sent.via;
              note = `✅ 测试消息已发出（${label} · ${sent.kind}${sent.to ? ` → ${sent.to}` : ""}）`;
              noteRoute("/wecom", { action: "test", via: sent.via, kind: sent.kind });
            } catch (error) {
              note = `❌ 发送失败：${error?.message ?? error}`;
              noteRoute("/wecom", { action: "test", error: String(error?.message ?? error) });
            }
          }
          const cfg = await state.loadWecom();
          const botState = wecomBotStatus.authenticated
            ? "✅ 长连接已认证（可双向收发）"
            : wecomBotStatus.connecting || wecomBotStatus.attempts > 0
              ? `⏳ 连接中/重连中（尝试 ${wecomBotStatus.attempts ?? 0} 次${wecomBotStatus.error ? "：" + wecomBotStatus.error : ""}）`
              : cfg.botId && cfg.botSecret
                ? "未连接（点下面的「连接」）"
                : "未配置";
          const status = cfg.webhookUrl
            ? `群机器人 webhook（key ${cfg.webhookUrl.slice(-6)}）`
            : cfg.corpSecret && cfg.agentId
              ? `自建应用 corpid ${cfg.corpId || "?"} · agentid ${cfg.agentId} · 默认接收人 ${cfg.toUser}`
              : "未配置";
          const field = (name, label, value, placeholder) =>
            `<p style="margin:6px 0"><label style="display:inline-block;width:150px">${label}</label>`
            + `<input name="${name}" value="${String(value ?? "").replace(/"/g, "&quot;")}" placeholder="${placeholder}" style="font:14px system-ui;padding:5px 8px;width:460px"></p>`;
          // Failures belong on this page: it is where someone comes to ask "why does the
          // bot not answer?", and /state is not a page anyone reads by hand.
          const problems = [];
          if (wecomInboundError) problems.push(`上次处理入站消息时出错（${wecomInboundError.at}）：${wecomInboundError.message}`);
          if (lastSessionIssue) {
            problems.push(lastSessionIssue.freshId
              ? `上次这条会话无法恢复，已改用新会话 ${lastSessionIssue.freshId}（历史为空）：resume ${lastSessionIssue.resume}；create ${lastSessionIssue.create}`
              : `上次这条会话先 resume 失败后重建成功：${lastSessionIssue.resume}`);
          }
          const problemBox = problems.length > 0
            ? `<div class="bad">${problems.map((line) => `<div>⚠️ ${line}</div>`).join("")}</div>`
            : "";
          const html = `<!doctype html><meta charset="utf-8"><title>dsh-wechat-media · 企业微信</title>
<style>body{font:15px/1.7 system-ui;padding:26px;max-width:820px;color:#222}
.note{background:#f3f7ff;border:1px solid #cfe0ff;padding:8px 12px;border-radius:8px;margin:14px 0}
.bad{background:#fff7f5;border:1px solid #ffd0c4;padding:8px 12px;border-radius:8px;margin:14px 0;color:#8a3b25;font-size:13px}
.m{color:#666;font-size:13px}button{font:14px system-ui;padding:6px 12px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer}</style>
<body>
<p><button onclick="history.back()">← 返回 DSH</button></p>
<h3>企业微信（WeCom）</h3>
<div class="m">当前状态：${status}</div>
<div class="m">长连接：${botState}</div>
${note ? `<div class="note">${note}</div>` : ""}
${problemBox}
<h4>群机器人（最省事：只需一个 webhook 地址，支持文字 / markdown / 图片）</h4>
<form method="get">
${field("webhookUrl", "群机器人 webhook", cfg.webhookUrl, "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…")}
<button type="submit">保存</button>
</form>
<h4>自建应用（可发文件 / 语音 / 视频，需要 corpid + corpsecret + agentid）</h4>
<form method="get">
${field("corpId", "corpid", cfg.corpId, "ww1234567890abcdef")}
${field("corpSecret", "corpsecret", "", cfg.corpSecret ? "已保存（留空表示不修改）" : "应用的 Secret")}
${field("agentId", "agentid", cfg.agentId, "1000002")}
${field("toUser", "默认接收人", cfg.toUser, "@all 或 userid1|userid2")}
<button type="submit">保存</button>
</form>
<h4>智能机器人长连接（双向，推荐；无需公网地址）</h4>
<form method="get">
${field("botId", "BotID", cfg.botId, "在企业微信后台：智能机器人 → API 模式 → 长连接")}
${field("botSecret", "Secret", "", cfg.botSecret ? "已保存（留空表示不修改）" : "长连接专用 Secret")}
<input type="hidden" name="botEnabled" value="true">
<button type="submit">保存并连接</button>
</form>
<p><a class="b" href="?bot=start">连接 / 重连</a> <a class="b" href="?bot=stop">断开</a></p>
<h4>测试</h4>
<p><a href="?test=1"><button type="button">发送一条测试消息</button></a></p>
<div class="m">企业微信的两条出站链路都可用；<b>接收</b>走「智能机器人 → API 模式 → 长连接」（只需 BotID + Secret，不需要公网地址）。真正做不到的是回调 API：它要求把回调注册到一个公网 HTTPS 地址，本机插件给不了入口。个人微信那条链路仍是双向的。</div>
</body>`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(html);
        },
      },
    ];
    for (const route of routes) {
      webCtx.effect(() => webCtx.webServer.register(route), `dsh-wechat-media: ${route.path}`);
    }
  });

  /** The card-safe projection of a login session (never the token). */
  function publicLogin(session) {
    return {
      id: session.id,
      status: session.status,
      phase: session.phase,
      message: session.message,
      error: session.error,
      accountId: session.accountId,
      userId: session.userId,
      verifyCodeNeeded: session.verifyCodeNeeded,
      hasQr: Boolean(session.qrPayload),
      refreshes: session.refreshes,
      startedAt: session.startedAt,
    };
  }
}
