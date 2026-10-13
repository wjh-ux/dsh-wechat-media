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
import { execFile } from "node:child_process";
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
import { WechatState, defaultStateRoot } from "./state.js";

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
        const account = await loadAccount?.(conversation.accountId);
        if (!account?.token) return next();
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
  constructor(scope) {
    this.scope = scope;
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

/** A stable, restart-safe session id for one WeChat chat. */
function sessionIdFor(accountId, chatId) {
  const digest = Buffer.from(`${accountId}\u0000${chatId}`).toString("base64url").replace(/[^A-Za-z0-9]/g, "");
  return `wechat-${digest.slice(0, 40)}`;
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
  const collectors = new ReplyCollector(ctx);
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

  /** Ensure a live agent for one conversation, resuming its history when possible. */
  async function ensureAgent(accountId, chatId, peerName) {
    const sessionId = sessionIdFor(accountId, chatId);
    const existing = ctx.agents.get(sessionId);
    if (existing) {
      conversations.set(sessionId, { accountId, chatId, peerName });
      return { agent: existing, sessionId, accountId, chatId, peerName };
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

    let handle;
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, meta, ...(agentOptions ? { agentOptions } : {}), setup });
    } catch {
      handle = await ctx.agents.create({ sessionId, meta, ...(agentOptions ? { agentOptions } : {}), setup });
    }
    ctx.effect(() => handle.dispose, `dsh-wechat-media: agent ${sessionId}`);
    conversations.set(sessionId, { accountId, chatId, peerName });
    await state.setRoute(accountId, chatId, { sessionId, peerName, kind: String(chatId).includes("@chatroom") ? "group" : "direct" });
    return { agent: handle.agent, sessionId, accountId, chatId, peerName };
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
  const counters = { received: 0, forwarded: 0, blocked: 0, answered: 0, unusable: 0 };
  /**
   * Where inbound media goes right now: the runtime preference (card / control
   * panel) beats the plugin config, which beats `$DSH_HOME/wechat-inbox`. Resolved
   * per use so changing it takes effect without a restart.
   */
  const resolvedInbox = async () => resolveInboxDir({ prefs: await state.loadPrefs(), config, dshHome });
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
    notify: (account, chatId, text) => sendText(account, chatId, text, { typing: false }),
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
      loadAccount: (accountId) => state.loadAccount(accountId),
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
      // Keep the drop countable so the card can show it.
      await state.setPeer(accountId, chatId, noteBlocked(await state.getPeer(accountId, chatId)));
      return;
    }
    if (verdict.action === "answer") {
      counters.answered += 1;
      return; // already handed to the waiting requester
    }

    const lines = [];
    if (text) lines.push(text);
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
        lines.push(describeForModel(saved));
      } catch (error) {
        lines.push(`[微信媒体下载失败] ${item?.type ?? "media"}: ${error?.message ?? error}`);
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
      await sendText(account, chatId, `❌ agent 出错：${outcome.error}`.slice(0, MAX_TEXT_CHARS)).catch(() => {});
      return;
    }
    if (!outcome.text) {
      if (outcome.deliveredByTool) return; // the tool carried the answer
      await sendText(account, chatId, `（本轮没有文本回复：${outcome.stopReason}）`).catch(() => {});
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
      for (const definition of [sendFileTool, sendTextTool, statusTool]) {
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
            peers: await state.loadPeers(),
            counters: { ...counters },
            approvals: approvals.list(),
            lastApproval: approvals.last() ?? null,
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
          const allowed = body.allowed === true ? true : body.allowed === false ? false : null;
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
          if (typeof body.requireAllowlist === "boolean") patch.requireAllowlist = body.requireAllowlist;
          if (typeof body.autoReply === "boolean") patch.autoReply = body.autoReply;
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
