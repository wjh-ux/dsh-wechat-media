/**
 * dsh-wechat-media - token ledger.
 *
 * Each WeChat/WeCom account gets its own token counters, and the whole ledger zeroes itself
 * on a configurable window (1 to 30 days). Everything here is pure: the window arithmetic,
 * the accumulation and the wording, so the rules can be tested without a harness, a clock or
 * a network. `state.js` persists what this produces and `index.js` feeds it.
 *
 * Where the numbers come from: DSH's agent loop appends an `assistant/message` session event
 * carrying `usage` (`{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?,
 * cacheWriteTokens?, reasoningTokens? }`), which is what the model adapter reported. The
 * plugin already subscribes to those events, so no harness API is invented here - and a turn
 * with several model calls contributes one entry per call, which is the honest total.
 */

/** The window is a number of days, clamped to what the feature promises. */
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 30;
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clamp anything a user (or a config file) can produce into 1..30 full days. */
export function clampWindowDays(value, fallback = DEFAULT_WINDOW_DAYS) {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, days));
}

const zero = () => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, calls: 0 });

/** A fresh, empty ledger. `now` is injected so tests do not depend on the clock. */
export function emptyLedger({ windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  return {
    windowDays: clampWindowDays(windowDays),
    windowStartedAt: new Date(now).toISOString(),
    lastResetAt: null,
    resets: 0,
    accounts: {},
  };
}

/** Tokens the adapter charged for one call, normalised. */
export function normaliseUsage(usage) {
  const input = Math.max(0, Math.round(Number(usage?.inputTokens) || 0));
  const output = Math.max(0, Math.round(Number(usage?.outputTokens) || 0));
  const cached = Math.max(0, Math.round(Number(usage?.cacheReadTokens) || 0) + Math.round(Number(usage?.cacheWriteTokens) || 0));
  const reasoning = Math.max(0, Math.round(Number(usage?.reasoningTokens) || 0));
  const reported = Math.max(0, Math.round(Number(usage?.totalTokens) || 0));
  // Cached tokens are **not** part of `inputTokens` for these adapters: the harness computes
  // `totalTokens = input + output + cacheRead + cacheWrite` itself (dsh-llm-deepseek,
  // `lib/index.js`). Measured live: one first turn reported input 2191, output 2, cache 6272,
  // so a total of input+output would understate the spend four times over. An adapter that
  // reports its own `totalTokens` wins - it knows its provider's convention better than this
  // module does.
  return { inputTokens: input, outputTokens: output, cachedTokens: cached, reasoningTokens: reasoning, totalTokens: reported || input + output + cached };
}

/** Add one call's usage to one account (and one chat inside it). Returns a new ledger. */
export function accumulate(ledger, { accountId, chatId, usage, now = Date.now() } = {}) {
  const base = due(ledger, now);
  const id = String(accountId ?? "");
  if (!id) return base;
  const used = normaliseUsage(usage);
  if (used.totalTokens === 0 && used.cachedTokens === 0 && used.reasoningTokens === 0) return base;

  const accounts = { ...base.accounts };
  // `zero()` first so a row written by an older version still has every counter, then the
  // stored row on top: the numbers must survive, only the shape is repaired.
  const account = { ...zero(), ...(accounts[id] ?? {}) };
  accounts[id] = account;
  for (const key of ["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens", "totalTokens"]) account[key] += used[key];
  account.calls += 1;

  const chat = String(chatId ?? "");
  if (chat) {
    account.chats = { ...(account.chats ?? {}) };
    // The `zero()` here also upgrades a per-chat row written before totals were stored.
    const row = { ...zero(), ...(account.chats[chat] ?? {}) };
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens", "totalTokens"]) row[key] += used[key];
    row.calls += 1;
    row.lastAt = new Date(now).toISOString();
    account.chats[chat] = row;
  }
  account.lastAt = new Date(now).toISOString();
  return { ...base, accounts };
}

/** When the current window ends. */
export function windowEndsAt(ledger) {
  const started = Date.parse(String(ledger?.windowStartedAt ?? "")) || Date.now();
  return started + clampWindowDays(ledger?.windowDays) * DAY_MS;
}

/** Has the window elapsed? A missing or unparsable start counts as "due", never as "never". */
export function isDue(ledger, now = Date.now()) {
  if (!ledger) return true;
  const started = Date.parse(String(ledger.windowStartedAt ?? ""));
  if (!Number.isFinite(started)) return true;
  return now - started >= clampWindowDays(ledger.windowDays) * DAY_MS;
}

/** Does any account carry a non-zero counter (or a call) in this ledger? */
export function hasUsage(ledger) {
  for (const account of Object.values(ledger?.accounts ?? {})) {
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens", "calls"]) {
      if (Number(account?.[key]) > 0) return true;
    }
  }
  return false;
}

/**
 * Zero the counters when the window has elapsed. Called on every write and on every read of
 * the snapshot, so a host that was off for a week still resets on its next breath instead of
 * reporting a stale window - no timers, nothing to miss while the process is down.
 *
 * The account rows are kept (zeroed, like a manual reset) so the card shows the same list
 * before and after; `resets` only moves when there was something to zero, because claiming a
 * reset over an empty ledger would be a lie.
 */
export function due(ledger, now = Date.now()) {
  const existing = ledger && typeof ledger === "object" ? ledger : emptyLedger({ now });
  if (!isDue(existing, now)) return existing;
  const changed = hasUsage(existing);
  const zeroed = reset(existing, { now, countReset: changed });
  return changed ? zeroed : { ...zeroed, lastResetAt: existing.lastResetAt ?? null, resets: Number(existing.resets) || 0 };
}

/**
 * Zero the counters now.
 *
 * @param {object} ledger
 * @param {{ now?: number, windowDays?: number, countReset?: boolean }} [options]
 *   `countReset: false` zeroes without claiming a reset happened (used by `due` for a ledger
 *   that was already empty).
 */
export function reset(ledger, { now = Date.now(), windowDays, countReset = true } = {}) {
  const previous = ledger && typeof ledger === "object" ? ledger : emptyLedger({ now });
  const accounts = {};
  for (const [accountId] of Object.entries(previous.accounts ?? {})) {
    // The account stays listed (so the card does not jump around) with an empty window:
    // keeping a stale `lastAt` next to zeroed counters would just be confusing.
    accounts[accountId] = { ...zero(), chats: {}, lastAt: null };
  }
  return {
    windowDays: clampWindowDays(windowDays ?? previous.windowDays),
    windowStartedAt: new Date(now).toISOString(),
    lastResetAt: countReset ? new Date(now).toISOString() : previous.lastResetAt ?? null,
    resets: countReset ? (Number(previous.resets) || 0) + 1 : Number(previous.resets) || 0,
    accounts,
  };
}

/** Change the window, re-anchoring it so the new length takes effect immediately. */
export function setWindow(ledger, windowDays, { now = Date.now() } = {}) {
  const days = clampWindowDays(windowDays, ledger?.windowDays);
  const previous = due(ledger, now);
  return { ...previous, windowDays: days, windowStartedAt: new Date(now).toISOString() };
}

/** Totals for one account row (or a chat row). */
export function accountTotals(account) {
  const input = Number(account?.inputTokens) || 0;
  const output = Number(account?.outputTokens) || 0;
  const cached = Number(account?.cachedTokens) || 0;
  const stored = Number(account?.totalTokens) || 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: Number(account?.reasoningTokens) || 0,
    calls: Number(account?.calls) || 0,
    // Prefer what was actually recorded (the adapter's own total when it reported one), and
    // fall back to the parts - which include the cache, per the harness's definition.
    totalTokens: stored || input + output + cached,
  };
}

/**
 * A compact number for a human: `1.2k` / `3.4M` in English, `1.2 万` / `3.4 亿` in Chinese.
 * Token counts are big enough that the raw digits stop being readable.
 */
export function formatTokens(value, locale = "zh") {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (locale === "zh") {
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
    return n.toLocaleString("zh-CN");
  }
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** "3 天后" / "3 days" - coarse on purpose; a token window does not need minutes. */
export function formatRemaining(ms, locale = "zh") {
  const left = Math.max(0, Number(ms) || 0);
  const hours = Math.ceil(left / (60 * 60 * 1000));
  if (hours <= 1) return locale === "zh" ? "不到 1 小时" : "under an hour";
  if (hours < 48) return locale === "zh" ? `${hours} 小时后` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return locale === "zh" ? `${days} 天后` : `in ${days} days`;
}

/**
 * The whole ledger as data the card and `/tokens` can print: totals, one row per account
 * (busiest chat first), and the window's end.
 */
export function summarize(ledger, { now = Date.now(), locale = "zh" } = {}) {
  const current = due(ledger, now);
  const accounts = Object.entries(current.accounts ?? {}).map(([accountId, account]) => {
    const totals = accountTotals(account);
    const chats = Object.entries(account?.chats ?? {})
      .map(([chatId, row]) => ({ chatId, ...accountTotals(row), lastAt: row?.lastAt ?? null }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return { accountId, ...totals, chats };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  const total = accounts.reduce(
    (sum, account) => ({
      inputTokens: sum.inputTokens + account.inputTokens,
      outputTokens: sum.outputTokens + account.outputTokens,
      totalTokens: sum.totalTokens + account.totalTokens,
      cachedTokens: sum.cachedTokens + account.cachedTokens,
      reasoningTokens: sum.reasoningTokens + account.reasoningTokens,
      calls: sum.calls + account.calls,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, calls: 0 },
  );

  return {
    windowDays: clampWindowDays(current.windowDays),
    windowStartedAt: current.windowStartedAt,
    lastResetAt: current.lastResetAt,
    resets: Number(current.resets) || 0,
    nextResetAt: new Date(windowEndsAt(current)).toISOString(),
    msUntilReset: Math.max(0, windowEndsAt(current) - now),
    total,
    accounts,
    locale,
  };
}

/** One line for `/status` and the card header. */
export function summaryLine(summary, locale = "zh") {
  const { total } = summary;
  if (total.totalTokens === 0) {
    return locale === "zh"
      ? `Token 统计（${summary.windowDays} 天窗口）：还没有用量，窗口 ${formatRemaining(summary.msUntilReset, locale)}清零`
      : `Tokens (${summary.windowDays}-day window): nothing yet, resets ${formatRemaining(summary.msUntilReset, "en")}`;
  }
  // The parts add up to the total, which is what the harness means by a total: cached tokens
  // are billed prompt tokens and are *not* inside `inputTokens` for these adapters.
  const parts = locale === "zh"
    ? `输入 ${formatTokens(total.inputTokens, locale)} / 输出 ${formatTokens(total.outputTokens, locale)}`
    : `in ${formatTokens(total.inputTokens, locale)} / out ${formatTokens(total.outputTokens, locale)}`;
  const cached = total.cachedTokens > 0
    ? (locale === "zh" ? ` / 缓存命中 ${formatTokens(total.cachedTokens, locale)}` : ` / cache ${formatTokens(total.cachedTokens, locale)}`)
    : "";
  const reasoning = total.reasoningTokens > 0
    ? (locale === "zh" ? ` / 推理 ${formatTokens(total.reasoningTokens, locale)}` : ` / reasoning ${formatTokens(total.reasoningTokens, locale)}`)
    : "";
  return locale === "zh"
    ? `Token 统计（${summary.windowDays} 天窗口）：共 ${formatTokens(total.totalTokens, locale)}（${parts}${cached}${reasoning}）· ${total.calls} 次调用 · ${formatRemaining(summary.msUntilReset, locale)}清零`
    : `Tokens (${summary.windowDays}-day window): ${formatTokens(total.totalTokens, locale)} (${parts}${cached}${reasoning}) · ${total.calls} call(s) · resets ${formatRemaining(summary.msUntilReset, "en")}`;
}

/** The `/tokens` answer: totals, per account, and each account's busiest chats. */
export function tokensReport(summary, { accountNames = {}, chatsPerAccount = 3, locale = "zh" } = {}) {
  const zh = locale === "zh";
  const lines = [zh ? "dsh-wechat-media Token 统计" : "dsh-wechat-media token usage"];
  lines.push(summaryLine(summary, locale));
  lines.push(zh ? `窗口开始：${summary.windowStartedAt}` : `Window started: ${summary.windowStartedAt}`);
  if (summary.lastResetAt) {
    lines.push(zh ? `上次清零：${summary.lastResetAt}（累计清零 ${summary.resets} 次）` : `Last reset: ${summary.lastResetAt} (${summary.resets} total)`);
  }
  if (summary.accounts.length === 0) {
    lines.push("", zh ? "还没有任何账号产生用量。" : "No account has used any tokens yet.");
    return lines.join("\n");
  }
  for (const account of summary.accounts) {
    const name = accountNames[account.accountId] ?? account.accountId;
    lines.push(
      "",
      zh
        ? `【${name}】共 ${formatTokens(account.totalTokens, locale)} · 输入 ${formatTokens(account.inputTokens, locale)} / 输出 ${formatTokens(account.outputTokens, locale)} · ${account.calls} 次调用`
        : `[${name}] ${formatTokens(account.totalTokens, locale)} total · in ${formatTokens(account.inputTokens, locale)} / out ${formatTokens(account.outputTokens, locale)} · ${account.calls} call(s)`,
    );
    for (const chat of account.chats.slice(0, chatsPerAccount)) {
      lines.push(
        zh
          ? `  · ${chat.chatId}：${formatTokens(chat.totalTokens, locale)}（${chat.calls} 次）`
          : `  · ${chat.chatId}: ${formatTokens(chat.totalTokens, locale)} (${chat.calls})`,
      );
    }
    if (account.chats.length > chatsPerAccount) {
      lines.push(zh ? `  · …另有 ${account.chats.length - chatsPerAccount} 个会话` : `  · …and ${account.chats.length - chatsPerAccount} more chat(s)`);
    }
  }
  lines.push("", zh ? "用法：/tokens · /tokens reset · /tokens 7（把窗口改成 1–30 天）" : "Usage: /tokens · /tokens reset · /tokens 7 (window 1-30 days)");
  return lines.join("\n");
}
