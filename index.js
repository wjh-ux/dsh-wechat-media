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
import { readFile } from "node:fs/promises";
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
import { openSessionAgent } from "./session.js";
import { STOP_REASON, helpText, parseCommand, parseSwitch, parseWindowDays, statusText, unknownCommandText } from "./commands.js";
import { clampWindowDays, summarize, summaryLine, tokensReport, usageDisagreement } from "./tokens.js";
import * as wecom from "./wecom.js";
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
const DELIVERY_TOOLS = new Set(["wechat_send_text", "wechat_send_file"]);

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
export function createApprovalBridge({ notify, timeoutMs = 120000, logger } = {}) {
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
    async ask(account, chatId, request, { timeoutMs: limit = timeoutMs, accountId, onSent } = {}) {
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
      const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          lastResult = { outcome: "timeout", chatId, toolName: request?.toolName, at: new Date().toISOString() };
          pending.delete(key);
          resolve(undefined);
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
        if (ignore) return next();
        const conversation = await findConversation?.(String(request?.agent?.session?.id ?? ""));
        if (!conversation) return next(); // not a WeChat-driven session
        // Whoever the caller can actually reach. `loadAccount` owns that judgement
        // (a WeChat account needs a token; a WeCom chat needs a live long connection).
        const account = await loadAccount?.(conversation.accountId, conversation);
        if (!account) return next();
        // Undefined means "ask someone else": the GUI's own prompt stays intact.
        return (await bridge.ask(account, conversation.chatId, request, { accountId: conversation.accountId })) ?? next();
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
class ReplyCollector {
  constructor(scope, { onUsage } = {}) {
    this.scope = scope;
    this.onUsage = onUsage;
    this.pending = new Map(); // sessionId -> record
    scope.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      const sessionId = String(agent?.session?.id ?? agent?.id ?? "");
      const record = this.pending.get(sessionId);
      if (!record) return;
      if (record.messageId && message?.id && message.id !== record.messageId) return;
      record.turn = turn;
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
      const record = this.pending.get(sessionId);
      if (!record || record.turn === undefined) return;
      if (event?.data?.turn !== record.turn) return;
      if (event.type === "tool/call") {
        // A delivery tool already answered this turn: remember it so the relay
        // does not send the same answer a second time.
        if (DELIVERY_TOOLS.has(String(event.data?.name ?? ""))) record.deliveredByTool = true;
        return;
      }
      if (event.type === "assistant/message") {
        const text = assistantText(event);
        if (text) record.parts.push(text);
        return;
      }
      if (event.type === "turn/end") {
        this.#settle(record, { text: record.parts.join("").trim(), stopReason: event.data?.reason?.kind ?? "end_turn" });
      }
    });
    scope.on("agent/error", ({ agent, turn, error }) => {
      const sessionId = String(agent?.session?.id ?? agent?.id ?? "");
      const record = this.pending.get(sessionId);
      if (!record || record.turn === undefined || turn !== record.turn) return;
      this.#settle(record, { text: record.parts.join("").trim(), error: String(error?.message ?? error), stopReason: "error" });
    });
  }

  #settle(record, outcome) {
    if (record.settled) return;
    record.settled = true;
    clearTimeout(record.timer);
    this.pending.delete(record.sessionId);
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
      this.pending.set(sessionId, record);
      // If the inbox never claims it (admission gate), do not wait forever.
      setTimeout(() => {
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
  const collectors = new ReplyCollector(ctx, {
    /**
     * Attribute one model call to the account and chat it belongs to.
     *
     * The session event carries only the session id, so it is resolved through the
     * conversation table the inbound paths maintain; a session nobody is bridging (a GUI
     * turn of the same conversation, say) has no account to charge and is skipped rather
     * than guessed at.
     */
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
        .catch((error) => ctx.logger?.warn?.("[dsh-wechat-media] token accounting failed: %s", error?.message ?? error));
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
    return { agent: handle.agent, sessionId: resolvedId, accountId, chatId, peerName, generation, handle };
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
        // Reported for both transports: "is the other side down?" is exactly what this
        // command is for, and the bot's state is one of the few visible failure signals.
        bot: wecomBotStatus,
        pendingApprovals: approvals.list().filter((waiting) => waiting.accountId === accountId && waiting.chatId === chatId).length,
        friendOnly: (await state.loadPrefs()).friendOnly === true,
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
  function replyWecomInParts(frame, text, tag = "stream") {
    const parts = splitForStream(text);
    for (let index = 0; index < parts.length; index += 1) {
      if (wecomBot?.reply(frame, streamBody(generateReqId(`${tag}-${index}`), parts[index], true)) === false) {
        throw new Error("the WeCom long connection is not writable right now");
      }
    }
  }

  /** Send one text message, with a lazily-fetched typing ticket. */
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
      result = await ilink.sendText({ baseUrl: account.baseUrl, token: account.token, toWxid: chatId, text });
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
  const counters = { received: 0, forwarded: 0, blocked: 0, answered: 0, unusable: 0, mediaDownloaded: 0, mediaFailed: 0, mediaBytes: 0, commands: 0, groupsSkipped: 0 };
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
        reply: (answer) => replyWecomInParts(frame, answer, "stream-cmd"),
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
    const waiting = collectors.wait(sessionId, message2?.id);
    await agent.followup(message2);
    const outcome = await waiting;
    // Never leave the chat without an answer: mirror what the personal-WeChat path
    // does when a turn errors or produces no text.
    if (outcome.error) {
      replyWecomInParts(frame, `❌ agent 出错：${outcome.error}`, "stream-error");
      return;
    }
    if (!outcome.text) {
      if (outcome.deliveredByTool) return;
      replyWecomInParts(frame, `（本轮没有文本回复：${outcome.stopReason}）`, "stream-empty");
      return;
    }
    // A WeCom intelligent robot only accepts `stream` for a passive reply, and one stream
    // body holds 20480 bytes; a longer answer becomes several messages.
    replyWecomInParts(frame, outcome.text, "stream");
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
        lines.push(describeForModel(saved));
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
    const waiting = collectors.wait(sessionId, message2?.id);
    agent.followup(message2);
    const outcome = await waiting;

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
      if (outcome.deliveredByTool) return; // the tool carried the answer
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
    for (const chunk of chunkText(outcome.text)) {
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
          const common = { baseUrl: account.baseUrl, token: account.token, toWxid: chatId, filePath: prepared.path };
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
      for (const definition of [sendFileTool, sendTextTool, statusTool, wecomText, wecomFile]) {
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
            prefs,
            tokens: summarize(await state.loadTokens()),
            peers: await state.loadPeers(),
            counters: { ...counters },
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
          const patch = {};
          if (asBool(body.requireAllowlist) !== null) patch.requireAllowlist = asBool(body.requireAllowlist);
          if (asBool(body.friendOnly) !== null) patch.friendOnly = asBool(body.friendOnly);
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
          json(res, 200, { ok: true, prefs });
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
          const accountId = String(body.accountId ?? "") || (await state.listAccounts())[0];
          const account = accountId ? await state.loadAccount(accountId) : undefined;
          if (!account?.token) return json(res, 400, { error: "no paired account" });
          const routes = await state.loadRoutes();
          const chatId = String(body.chatId ?? "")
            || lastInbound.get(accountId)?.chatId
            || Object.keys(routes[accountId] ?? {})[0];
          if (!chatId) return json(res, 400, { error: "no chat to ask: write to the bot first" });
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
          noteRoute("/test-approval", { chatId, sent: send.sent === true, error: send.error ?? null });
          json(res, 200, {
            ok: send.sent === true,
            accountId,
            chatId,
            sent: send.sent === true,
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
          json(res, 200, { ok: true, chatId, chatType, sessionId: sessionIdFor(accountId, chatId), ms: Date.now() - started, inboundError: wecomInboundError });
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
