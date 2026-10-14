/**
 * Tests for the token ledger: the window arithmetic, the accumulation, the wording, and the
 * on-disk round trip.
 *
 * The clock is always injected, so a "7 天后清零" rule is tested by arithmetic instead of by
 * waiting a week.
 *
 * Run: node test/tokens.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  accumulate,
  accountTotals,
  clampWindowDays,
  due,
  emptyLedger,
  formatRemaining,
  formatTokens,
  isDue,
  normaliseUsage,
  reset,
  setWindow,
  summarize,
  summaryLine,
  tokensReport,
  usageDisagreement,
  windowEndsAt,
} from "../tokens.js";
import { WechatState } from "../state.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const usage = (input, output, extra = {}) => ({ inputTokens: input, outputTokens: output, ...extra });

console.log("token ledger");

console.log("-- the window --");

await test("the window is clamped to 1..30 days, whatever it is given", () => {
  assert.equal(clampWindowDays(7), 7);
  assert.equal(clampWindowDays("14"), 14);
  assert.equal(clampWindowDays(0), DEFAULT_WINDOW_DAYS, "0 is not a window, fall back");
  assert.equal(clampWindowDays(-5), DEFAULT_WINDOW_DAYS);
  assert.equal(clampWindowDays(1), MIN_WINDOW_DAYS);
  assert.equal(clampWindowDays(30), MAX_WINDOW_DAYS);
  assert.equal(clampWindowDays(99), MAX_WINDOW_DAYS, "a month is the promise");
  assert.equal(clampWindowDays(undefined), DEFAULT_WINDOW_DAYS);
  assert.equal(clampWindowDays("nonsense"), DEFAULT_WINDOW_DAYS);
  assert.equal(clampWindowDays(7.4), 7, "fractions round to whole days");
});

await test("a fresh ledger starts now and lasts exactly its window", () => {
  const ledger = emptyLedger({ windowDays: 3, now: T0 });
  assert.equal(ledger.windowDays, 3);
  assert.equal(ledger.windowStartedAt, new Date(T0).toISOString());
  assert.equal(ledger.lastResetAt, null, "an empty ledger has nothing to have reset");
  assert.equal(ledger.resets, 0);
  assert.equal(windowEndsAt(ledger), T0 + 3 * DAY);
  assert.equal(isDue(ledger, T0 + 3 * DAY - 1), false);
  assert.equal(isDue(ledger, T0 + 3 * DAY), true, "the boundary is inclusive");
});

await test("an unreadable window start counts as due, never as 'never'", () => {
  assert.equal(isDue({ windowDays: 7, windowStartedAt: "not a date" }, T0), true);
  assert.equal(isDue({ windowDays: 7 }, T0), true);
  assert.equal(isDue(undefined, T0), true);
});

await test("an elapsed window zeroes the counters and says it did", () => {
  const ledger = accumulate(emptyLedger({ windowDays: 1, now: T0 }), { accountId: "a", chatId: "c", usage: usage(100, 20), now: T0 });
  const later = T0 + 2 * DAY;
  const after = due(ledger, later);
  assert.equal(after.accounts.a.inputTokens, 0, "the number is gone");
  assert.deepEqual(after.accounts.a.chats, {}, "and so is the per-chat detail");
  assert.equal(after.resets, 1, "one automatic reset happened");
  assert.equal(after.lastResetAt, new Date(later).toISOString());
  assert.equal(after.windowStartedAt, new Date(later).toISOString(), "the next window starts when it was noticed");
  assert.equal(Object.keys(after.accounts).length, 1, "the account stays listed, like after a manual reset");

  // ...but an empty ledger must not claim it zeroed something.
  const empty = due(emptyLedger({ windowDays: 1, now: T0 }), later);
  assert.equal(empty.resets, 0);
  assert.equal(empty.lastResetAt, null);
});

console.log("-- accumulation --");

await test("usage is added per account and per chat, one entry per model call", () => {
  let ledger = emptyLedger({ windowDays: 30, now: T0 });
  ledger = accumulate(ledger, { accountId: "acct-a", chatId: "chat-1", usage: usage(1000, 200), now: T0 });
  ledger = accumulate(ledger, { accountId: "acct-a", chatId: "chat-1", usage: usage(300, 100), now: T0 + 1 });
  ledger = accumulate(ledger, { accountId: "acct-a", chatId: "chat-2", usage: usage(50, 10), now: T0 + 2 });
  ledger = accumulate(ledger, { accountId: "acct-b", chatId: "chat-3", usage: usage(7, 3), now: T0 + 3 });

  assert.equal(ledger.accounts["acct-a"].inputTokens, 1350);
  assert.equal(ledger.accounts["acct-a"].outputTokens, 310);
  assert.equal(ledger.accounts["acct-a"].calls, 3, "every call counts, not every turn");
  // Per-chat rows store the counters; totals are derived, never duplicated on disk.
  assert.equal(ledger.accounts["acct-a"].chats["chat-1"].inputTokens, 1300);
  assert.equal(ledger.accounts["acct-a"].chats["chat-1"].outputTokens, 300);
  assert.equal(accountTotals(ledger.accounts["acct-a"].chats["chat-1"]).totalTokens, 1600, "chat-1: 1000+200+300+100");
  assert.equal(ledger.accounts["acct-b"].inputTokens, 7);
  assert.equal(ledger.accounts["acct-a"].lastAt, new Date(T0 + 2).toISOString());
});

await test("usage is normalised, and a call with nothing in it is not recorded", () => {
  assert.deepEqual(
    { ...normaliseUsage({ inputTokens: 10, outputTokens: 4 }), reportedTotal: "ignored" },
    { inputTokens: 10, outputTokens: 4, cachedTokens: 0, reasoningTokens: 0, totalTokens: 14, reportedTotal: "ignored" },
  );
  assert.equal(
    normaliseUsage({ inputTokens: 10, outputTokens: 4, totalTokens: 99 }).totalTokens,
    14,
    "the total is derived from the parts, never taken from the adapter",
  );
  assert.equal(normaliseUsage({ inputTokens: 10, outputTokens: 4, totalTokens: 99 }).reportedTotal, 99, "the adapter's own number is kept for the disagreement check");
  assert.match(usageDisagreement({ inputTokens: 10, outputTokens: 4, totalTokens: 99 }) ?? "", /total 99 != input 10 \+ output 4 \+ cache 0 = 14/);
  assert.equal(usageDisagreement({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }), undefined, "the harness's own formula agrees, so there is nothing to report");
  assert.equal(usageDisagreement({ inputTokens: 10, outputTokens: 4 }), undefined, "an adapter that reports no total is fine");
  assert.equal(normaliseUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 5 }).cachedTokens, 105, "cache reads and writes are one number");
  // The measured live case: cached prompt tokens are *not* inside inputTokens, so a total of
  // input+output would claim 2193 for a turn that really cost 8465.
  const live = normaliseUsage({ inputTokens: 2191, outputTokens: 2, cacheReadTokens: 6272 });
  assert.equal(live.totalTokens, 8465, "the total must include the cache");
  assert.equal(live.inputTokens + live.outputTokens + live.cachedTokens, live.totalTokens, "and the parts must add up to it");
  assert.equal(normaliseUsage({ inputTokens: -5, outputTokens: "x" }).totalTokens, 0, "junk becomes zero, never NaN");

  const ledger = emptyLedger({ now: T0 });
  assert.deepEqual(accumulate(ledger, { accountId: "a", chatId: "c", usage: {}, now: T0 }).accounts, {});
  assert.deepEqual(accumulate(ledger, { usage: usage(1, 1), now: T0 }).accounts, {}, "an event without an account is skipped, not guessed");
});

await test("a row written by an older version keeps its parts and gains no stale total", () => {
  // The second live bug, reproduced: v0.9.0 wrote parts with no total, v0.9.1 added its own
  // total to the same row, so the stored total covered only the newer call while the parts
  // covered both - 8548 stored against 17013 of parts.
  const legacy = {
    windowDays: 30,
    windowStartedAt: new Date(T0).toISOString(),
    lastResetAt: null,
    resets: 0,
    accounts: {
      a: {
        inputTokens: 2191,
        outputTokens: 2,
        cachedTokens: 6272,
        reasoningTokens: 0,
        calls: 1,
        chats: { c: { inputTokens: 2191, outputTokens: 2, cachedTokens: 6272, reasoningTokens: 0, calls: 1, totalTokens: 8548 } },
      },
    },
  };
  const after = accumulate(legacy, { accountId: "a", chatId: "c", usage: { inputTokens: 184, outputTokens: 44, cacheReadTokens: 8320 }, now: T0 });
  const summary = summarize(after, { now: T0 });
  assert.equal(summary.total.inputTokens, 2375);
  assert.equal(summary.total.outputTokens, 46);
  assert.equal(summary.total.cachedTokens, 14592);
  assert.equal(summary.total.totalTokens, 17013, "both calls, cache included");
  assert.equal(
    summary.total.inputTokens + summary.total.outputTokens + summary.total.cachedTokens,
    summary.total.totalTokens,
    "the invariant the stored total broke",
  );
  assert.equal(after.accounts.a.totalTokens, undefined, "the stale stored total must be dropped");
  assert.equal(after.accounts.a.chats.c.totalTokens, undefined, "and so must the per-chat one");
  assert.match(summaryLine(summary), /共 1\.7 万/, "the line prints the derived total");
});

await test("summarize totals everything and sorts by usage", () => {
  let ledger = emptyLedger({ windowDays: 7, now: T0 });
  ledger = accumulate(ledger, { accountId: "small", chatId: "c1", usage: usage(10, 5), now: T0 });
  ledger = accumulate(ledger, { accountId: "big", chatId: "c2", usage: usage(5000, 1000), now: T0 + 1 });
  ledger = accumulate(ledger, { accountId: "big", chatId: "c3", usage: usage(2000, 500), now: T0 + 2 });
  const summary = summarize(ledger, { now: T0 + 3 * DAY });

  assert.deepEqual(summary.accounts.map((row) => row.accountId), ["big", "small"], "the busiest account first");
  assert.deepEqual(summary.accounts[0].chats.map((row) => row.chatId), ["c2", "c3"], "and inside it, the busiest chat first");
  assert.equal(summary.total.totalTokens, 8515);
  assert.equal(summary.total.inputTokens, 7010);
  assert.equal(summary.total.outputTokens, 1505);
  assert.equal(summary.windowDays, 7);
  assert.equal(summary.msUntilReset, 4 * DAY, "3 days in, 4 left");
  assert.equal(summary.nextResetAt, new Date(T0 + 7 * DAY).toISOString());
});

console.log("-- resetting --");

await test("a manual reset keeps the accounts listed but empties them", () => {
  let ledger = accumulate(emptyLedger({ windowDays: 30, now: T0 }), { accountId: "a", chatId: "c", usage: usage(100, 20), now: T0 });
  const after = reset(ledger, { now: T0 + DAY });
  assert.equal(after.accounts.a.inputTokens, 0);
  assert.deepEqual(after.accounts.a.chats, {}, "the per-chat rows go too");
  assert.equal(after.accounts.a.lastAt, null, "a zeroed row must not keep a stale timestamp");
  assert.equal(after.resets, 1);
  assert.equal(after.lastResetAt, new Date(T0 + DAY).toISOString());
  assert.equal(after.windowStartedAt, new Date(T0 + DAY).toISOString(), "the window restarts from the reset");
  assert.equal(due(after, T0 + DAY + DAY).resets >= 1, true);
});

await test("changing the window re-anchors it and clamps the request", () => {
  const ledger = accumulate(emptyLedger({ windowDays: 30, now: T0 }), { accountId: "a", chatId: "c", usage: usage(10, 1), now: T0 });
  const week = setWindow(ledger, 7, { now: T0 + 2 * DAY });
  assert.equal(week.windowDays, 7);
  assert.equal(week.windowStartedAt, new Date(T0 + 2 * DAY).toISOString(), "the new length starts now, not retroactively");
  assert.equal(week.accounts.a.inputTokens, 10, "changing the window does not lose the numbers");
  assert.equal(setWindow(ledger, 99, { now: T0 }).windowDays, MAX_WINDOW_DAYS);
  assert.equal(setWindow(ledger, 0, { now: T0 }).windowDays, 30, "an unusable value keeps the current window");
});

console.log("-- wording --");

await test("token counts are readable in both languages", () => {
  assert.equal(formatTokens(999, "en"), "999");
  assert.equal(formatTokens(1500, "en"), "1.5k");
  assert.equal(formatTokens(2_500_000, "en"), "2.50M");
  assert.equal(formatTokens(1500, "zh"), "1,500");
  assert.equal(formatTokens(15_000, "zh"), "1.5 万");
  assert.equal(formatTokens(250_000_000, "zh"), "2.50 亿");
  assert.equal(formatTokens(-1, "zh"), "0", "never print a negative");
});

await test("the remaining time reads like a sentence", () => {
  assert.equal(formatRemaining(30 * 60 * 1000, "zh"), "不到 1 小时");
  assert.equal(formatRemaining(5 * 60 * 60 * 1000, "zh"), "5 小时后");
  assert.equal(formatRemaining(3 * DAY, "zh"), "3 天后");
  assert.equal(formatRemaining(5 * 60 * 60 * 1000, "en"), "in 5h");
  assert.equal(formatRemaining(3 * DAY, "en"), "in 3 days");
});

await test("the one-line summary is honest when nothing was used yet", () => {
  const empty = summaryLine(summarize(emptyLedger({ windowDays: 7, now: T0 }), { now: T0 }));
  assert.match(empty, /7 天窗口/);
  assert.match(empty, /还没有用量/);
  assert.match(empty, /清零/);

  let ledger = accumulate(emptyLedger({ windowDays: 30, now: T0 }), { accountId: "a", chatId: "c", usage: usage(120_000, 30_000, { cacheReadTokens: 50_000 }), now: T0 });
  const line = summaryLine(summarize(ledger, { now: T0 + DAY }), "zh");
  assert.match(line, /30 天窗口/);
  assert.match(line, /共 20\.0 万/, "120k in + 30k out + 50k cache: the parts add up to the total");
  assert.match(line, /输入 12\.0 万/);
  assert.match(line, /输出 3\.0 万/);
  assert.match(line, /缓存命中 5\.0 万/);
  assert.match(line, /1 次调用/);
});

await test("the /tokens report names accounts, shows the busiest chats and its own usage", () => {
  let ledger = emptyLedger({ windowDays: 7, now: T0 });
  for (const chat of ["c1", "c2", "c3", "c4"]) {
    ledger = accumulate(ledger, { accountId: "acct", chatId: chat, usage: usage(1000, 100), now: T0 });
  }
  const report = tokensReport(summarize(ledger, { now: T0 }), { accountNames: { acct: "acct（企业微信 张三）" }, chatsPerAccount: 2 });
  assert.match(report, /Token 统计/);
  assert.match(report, /acct（企业微信 张三）/);
  assert.match(report, /· c1：/);
  assert.match(report, /另有 2 个会话/, "the chats it did not print are still accounted for");
  assert.match(report, /\/tokens reset/);
  assert.match(report, /1–30 天/);
});

console.log("-- on disk --");

await test("the ledger survives a restart, and the state layer applies the window", async () => {
  const root = await mkdtemp(join(tmpdir(), "wx-tokens-test-"));
  try {
    const state = new WechatState({ root });
    await state.init();

    const fresh = await state.loadTokens(T0);
    assert.equal(fresh.windowDays, DEFAULT_WINDOW_DAYS);
    assert.deepEqual(fresh.accounts, {});

    await state.addTokens({ accountId: "acct-a", chatId: "chat-1", usage: usage(1000, 250), now: T0 });
    await state.addTokens({ accountId: "acct-a", chatId: "chat-1", usage: usage(100, 25), now: T0 + 1000 });

    // A different instance, as after a restart: the numbers are on disk, not in memory.
    const reopened = await new WechatState({ root }).loadTokens(T0 + 2000);
    assert.equal(reopened.accounts["acct-a"].inputTokens, 1100);
    assert.equal(reopened.accounts["acct-a"].calls, 2);

    const widened = await state.setTokenWindow(1, { now: T0 + 3000 });
    assert.equal(widened.windowDays, 1);
    assert.equal(widened.accounts["acct-a"].inputTokens, 1100, "changing the window keeps the usage");

    // One day later the window is over: reading the ledger is what zeroes it.
    const afterWindow = await state.loadTokens(T0 + 3000 + DAY);
    assert.equal(afterWindow.accounts["acct-a"].inputTokens, 0);
    assert.equal(afterWindow.resets, 1);

    await state.addTokens({ accountId: "acct-a", chatId: "chat-1", usage: usage(5, 5), now: T0 + 3000 + DAY + 1 });
    const zeroed = await state.resetTokens({ now: T0 + 3000 + DAY + 2 });
    assert.equal(zeroed.accounts["acct-a"].inputTokens, 0);
    assert.equal(zeroed.resets, 2);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test("concurrent accounting cannot lose a call", async () => {
  // The measured live bug: six calls in the transcript, five in the ledger - one turn's 8651
  // tokens erased by an interleaved read-modify-write. Fire-and-forget writes are exactly how
  // that happens, so this fires twenty of them at once and insists on all twenty.
  const root = await mkdtemp(join(tmpdir(), "wx-tokens-race-"));
  try {
    const state = new WechatState({ root });
    await state.init();
    const calls = 20;
    const pair = usage(100, 20, { cacheReadTokens: 1000 });
    await Promise.all(
      Array.from({ length: calls }, (_, index) => state.addTokens({ accountId: "acct", chatId: `chat-${index % 4}`, usage: pair, now: T0 + index })),
    );
    const ledger = await state.loadTokens(T0 + calls);
    assert.equal(ledger.accounts.acct.calls, calls, `every one of the ${calls} concurrent writes must survive`);
    assert.equal(ledger.accounts.acct.inputTokens, 100 * calls);
    assert.equal(ledger.accounts.acct.cachedTokens, 1000 * calls);
    const chats = Object.values(ledger.accounts.acct.chats);
    assert.equal(chats.reduce((sum, row) => sum + row.calls, 0), calls, "and the per-chat rows must add up to the same total");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
