/**
 * Scheduled tasks: the parser, the next-run maths and the due list - all pure.
 *
 * No timer, no clock, no file: every case passes its own `now`, which is the only way to test
 * "next Monday at 09:00" without waiting until Monday.
 *
 * Run: node test/tasks.test.mjs
 */
import assert from "node:assert/strict";

import {
  MIN_EVERY_MS,
  WEEKDAYS,
  createTask,
  describeSchedule,
  describeTask,
  dueTasks,
  formatWhen,
  newestRouteTarget,
  nextRunAt,
  nextRunFor,
  rearmOnce,
  transportOf,
  parseInterval,
  parseMoment,
  parseSchedule,
  parseTimeOfDay,
  REARM_STEPS,
} from "../tasks.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

console.log("tasks");

// A fixed Friday, 2026-10-16 10:00 local, so every expectation below is a fact rather than a hope.
const FRI = new Date(2026, 9, 16, 10, 0, 0, 0).getTime();

test("a time of day is parsed and a bad one is refused by name", () => {
  assert.deepEqual(parseTimeOfDay("08:30"), { hours: 8, minutes: 30 });
  assert.deepEqual(parseTimeOfDay("8：05"), { hours: 8, minutes: 5 }, "full-width colon and one-digit hour");
  assert.throws(() => parseTimeOfDay("25:00"), /小时超出范围/);
  assert.throws(() => parseTimeOfDay("08:70"), /分钟超出范围/);
  assert.throws(() => parseTimeOfDay("八点半"), /HH:MM/);
});

test("an interval needs a unit, and may not be under a minute", () => {
  assert.equal(parseInterval("30m"), 30 * 60_000);
  assert.equal(parseInterval("2h"), 2 * 3_600_000);
  assert.equal(parseInterval("90 分钟"), 90 * 60_000);
  assert.equal(parseInterval("45分"), 45 * 60_000);
  assert.throws(() => parseInterval("30"), /单位|30m/);
  assert.throws(() => parseInterval("20s"), /最小 1 分钟/);
  assert.equal(MIN_EVERY_MS, 60_000);
});

test("the four triggers parse from English and Chinese alike", () => {
  assert.deepEqual(parseSchedule("daily 08:30"), { kind: "daily", hours: 8, minutes: 30 });
  assert.deepEqual(parseSchedule("每天 08:30"), { kind: "daily", hours: 8, minutes: 30 });
  assert.deepEqual(parseSchedule("weekly mon 09:00"), { kind: "weekly", weekday: 1, hours: 9, minutes: 0 });
  assert.deepEqual(parseSchedule("每周一 09:00"), { kind: "weekly", weekday: 1, hours: 9, minutes: 0 });
  assert.deepEqual(parseSchedule("每周日 21:00"), { kind: "weekly", weekday: 7, hours: 21, minutes: 0 });
  assert.equal(parseSchedule("every 2h").everyMs, 2 * 3_600_000);
  assert.equal(parseSchedule("每 30 分钟").everyMs, 30 * 60_000);
  assert.equal(parseSchedule("once 2026-10-20 09:00").kind, "once");
  assert.equal(parseSchedule("一次 2026-10-20 09:00").kind, "once");
  assert.equal(WEEKDAYS["周日"], 7);
  assert.equal(WEEKDAYS.mon, 1);
});

test("an unparseable schedule says so instead of guessing", () => {
  assert.throws(() => parseSchedule(""), /需要一个时间/);
  assert.throws(() => parseSchedule("每天"), /需要一个时间|看不懂/);
  assert.throws(() => parseSchedule("weekly funday 09:00"), /不认识星期几/);
  assert.throws(() => parseSchedule("sometimes 09:00"), /看不懂这个时间/);
  assert.throws(() => parseMoment("2026-02-30 09:00"), /这一天不存在/);
});

test("daily fires today if the time is still ahead, tomorrow if it has passed", () => {
  const daily = parseSchedule("daily 12:00");
  const sameDay = nextRunAt(daily, FRI);
  assert.equal(sameDay, new Date(2026, 9, 16, 12, 0).getTime(), "later today");
  const tomorrow = nextRunAt(daily, new Date(2026, 9, 16, 13, 0).getTime());
  assert.equal(tomorrow, new Date(2026, 9, 17, 12, 0).getTime(), "already past, so tomorrow");
  // Exactly at the fire time counts as passed, so a 20-second tick cannot run it twice.
  assert.equal(nextRunAt(daily, new Date(2026, 9, 16, 12, 0).getTime()), new Date(2026, 9, 17, 12, 0).getTime());
});

test("weekly lands on the asked-for weekday, including the same day later", () => {
  const monday = parseSchedule("weekly mon 09:00");
  assert.equal(nextRunAt(monday, FRI), new Date(2026, 9, 19, 9, 0).getTime(), "next Monday");
  const fridayLate = parseSchedule("weekly fri 18:00");
  assert.equal(nextRunAt(fridayLate, FRI), new Date(2026, 9, 16, 18, 0).getTime(), "this Friday, still ahead");
  const fridayEarly = parseSchedule("weekly fri 09:00");
  assert.equal(nextRunAt(fridayEarly, FRI), new Date(2026, 9, 23, 9, 0).getTime(), "this Friday already passed");
  // Sunday is 7 in our scheme and 0 in JS's - the one place a shift can hide.
  const sunday = parseSchedule("weekly sun 10:00");
  assert.equal(nextRunAt(sunday, FRI), new Date(2026, 9, 18, 10, 0).getTime());
});

test("every and once are arithmetic, not calendar work", () => {
  assert.equal(nextRunAt(parseSchedule("every 30m"), FRI), FRI + 30 * 60_000);
  const once = parseSchedule("once 2026-10-20 09:00");
  assert.equal(nextRunAt(once, FRI), new Date(2026, 9, 20, 9, 0).getTime());
  assert.equal(nextRunAt(once, new Date(2027, 0, 1).getTime()), new Date(2026, 9, 20, 9, 0).getTime(), "a once-off stays put");
});

test("a schedule describes itself the way a person would say it", () => {
  assert.equal(describeSchedule(parseSchedule("daily 08:30")), "每天 08:30");
  assert.equal(describeSchedule(parseSchedule("weekly mon 09:00")), "每周一 09:00");
  assert.equal(describeSchedule(parseSchedule("every 30m")), "每 30 分钟");
  assert.equal(describeSchedule(parseSchedule("every 2h")), "每 2 小时");
  assert.equal(describeSchedule(parseSchedule("once 2026-10-20 09:00")), "2026-10-20 09:00 一次");
  assert.match(formatWhen(FRI), /^2026-10-16 10:00$/);
});

test("due is derived from the task's own clock, not from a stored next-run", () => {
  const task = createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "message", payload: "喝水", schedule: "daily 12:00", now: FRI, id: "t1" });
  assert.equal(dueTasks([task], FRI).length, 0, "not yet");
  assert.equal(dueTasks([task], new Date(2026, 9, 16, 12, 0).getTime()).length, 1, "due at the minute itself");
  assert.equal(dueTasks([task], new Date(2026, 9, 16, 12, 0).getTime()).length, 1, "and still due a second later");
  const afterFirstRun = [{ ...task, lastRunAt: new Date(2026, 9, 16, 12, 0).getTime() }];
  assert.equal(dueTasks(afterFirstRun, new Date(2026, 9, 16, 12, 0, 30).getTime()).length, 0, "a 20-second tick must not re-run it");
});

test("a paused task never fires, and a finished once-off stops", () => {
  const once = createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "message", payload: "x", schedule: "once 2026-10-16 11:00", now: FRI, id: "t2" });
  assert.equal(dueTasks([once], new Date(2026, 9, 16, 11, 0).getTime()).length, 1);
  assert.equal(dueTasks([{ ...once, lastRunAt: Date.now() }], new Date(2026, 9, 17).getTime()).length, 0, "already ran, so done");
  assert.equal(dueTasks([{ ...once, enabled: false }], new Date(2026, 9, 17).getTime()).length, 0, "paused");
});

test("a task with an unreadable schedule cannot take the scheduler down", () => {
  const broken = [{ id: "x", enabled: true, schedule: { kind: "nonsense" }, createdAt: 1 }];
  assert.deepEqual(dueTasks(broken, Date.now()), [], "skipped, not thrown");
  assert.equal(nextRunFor({ schedule: { kind: "nonsense" } }), undefined);
});

test("a task record refuses what a scheduler could not honour", () => {
  const base = { transport: "wecom", accountId: "a", chatId: "c", schedule: "daily 08:00" };
  assert.throws(() => createTask({ ...base, action: "nope", payload: "x" }), /action 只能是/);
  assert.throws(() => createTask({ ...base, action: "prompt", payload: "  " }), /prompt 任务需要一句话/);
  assert.throws(() => createTask({ ...base, action: "message", payload: "" }), /message 任务需要/);
  assert.throws(() => createTask({ ...base, action: "command", payload: "" }), /command 任务需要/);
  assert.throws(() => createTask({ ...base, action: "message", payload: "x".repeat(4001) }), /内容太长/);
  assert.throws(() => createTask({ ...base, accountId: "", action: "message", payload: "x" }), /必须指定会话/);
  assert.throws(() => createTask({ ...base, action: "message", payload: "x", schedule: "whenever" }), /看不懂/);
  const ok = createTask({ ...base, action: "message", payload: "喝水", now: FRI });
  assert.equal(ok.id.length, 7, "a short id someone can type in a chat");
  assert.equal(ok.enabled, true);
  assert.equal(ok.runs, 0);
  assert.equal(ok.createdAt, FRI);
  assert.match(describeTask(ok, FRI), /每天 08:00 · message · 下次 2026-10-17 08:00/);
});

test("nextRunFor answers for each kind, and stays silent for a finished once-off", () => {
  const daily = createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "message", payload: "x", schedule: "daily 12:00", now: FRI, id: "d" });
  assert.equal(nextRunFor(daily, FRI), new Date(2026, 9, 16, 12, 0).getTime());
  const paused = { ...daily, enabled: false };
  assert.equal(nextRunFor(paused, FRI), undefined);
  // "Finished" means it ran *this* occurrence: a re-armed one-off keeps an older lastRunAt and a future atMs.
  const fired = new Date(2026, 9, 16, 11, 0, 5).getTime();
  const done = { ...createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "message", payload: "x", schedule: "once 2026-10-16 11:00", now: FRI, id: "o" }), lastRunAt: fired };
  assert.equal(nextRunFor(done, FRI), undefined);
  const rearmed = { ...done, schedule: { kind: "once", atMs: new Date(2026, 9, 17, 11, 0).getTime() } };
  assert.equal(nextRunFor(rearmed, FRI), new Date(2026, 9, 17, 11, 0).getTime(), "a re-armed one-off has a next run again");
});

test("run again: the same clock time, pushed a day at a time into the future", () => {
  const at = new Date(2026, 9, 16, 9, 0).getTime();
  const later = new Date(2026, 9, 16, 10, 0).getTime();
  const next = rearmOnce({ kind: "once", atMs: at }, later);
  assert.equal(next.atMs, new Date(2026, 9, 17, 9, 0).getTime(), "not +24h from now - the clock time is kept");
  assert.equal(new Date(next.atMs).getHours(), 9);
  // A far-past one-off lands on the first future occurrence, not ten years of days one at a time.
  const ancient = rearmOnce({ kind: "once", atMs: new Date(2020, 0, 1, 7, 30).getTime() }, later);
  assert.ok(ancient.atMs > later, "always in the future");
  assert.equal(new Date(ancient.atMs).getHours(), 7, "same time of day");
  assert.throws(() => rearmOnce({ kind: "daily", hours: 8, minutes: 0 }, later), /只有一次性任务/);
  assert.throws(() => rearmOnce({ kind: "once", atMs: "nope" }, later), /没有可用的时间/);
});

test("a re-armed one-off fires again, and the old occurrence does not re-fire", () => {
  const at = new Date(2026, 9, 16, 11, 0).getTime();
  const base = { id: "r", enabled: true, action: "message", schedule: { kind: "once", atMs: at }, createdAt: FRI };
  const afterRun = { ...base, lastRunAt: at + 4000 };
  assert.equal(dueTasks([afterRun], at + 30_000).length, 0, "already ran this occurrence");
  const rearmed = { ...afterRun, schedule: { kind: "once", atMs: new Date(2026, 9, 17, 11, 0).getTime() } };
  assert.equal(dueTasks([rearmed], at + 30_000).length, 0, "not due until tomorrow");
  assert.equal(dueTasks([rearmed], new Date(2026, 9, 17, 11, 0).getTime()).length, 1, "due again tomorrow at the same time");
});

test("describeTask says why a task failed last time", () => {
  const task = { ...createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "prompt", payload: "总结一下今天", schedule: "daily 09:00", now: FRI, id: "p" }), lastRunAt: FRI, lastResult: "agent 超时", runs: 3 };
  const line = describeTask(task, FRI);
  assert.match(line, /p · 每天 09:00 · prompt/);
  assert.match(line, /已运行 3 次/);
  assert.match(line, /上次 2026-10-16 10:00 失败：agent 超时/);
});

test("the most recent route survives a restart, so a task can still name its target", () => {
  // routes.json is written on every inbound; lastInbound is memory only. v0.26.1 refused to create a task
  // after a restart until somebody sent a message first - a step a scheduled task cannot depend on.
  const routes = {
    "b775a478733a-im-bot": {
      "o9cq804@im.wechat": { sessionId: "s1", peerName: "wc", updatedAt: "2026-10-16T09:18:47.102Z" },
    },
    "wecom-aibo3S7u": {
      "woIHRN": { sessionId: "s2", peerName: "企业微信 woIHRN", updatedAt: "2026-10-17T11:51:51.149Z" },
    },
    "feishu-cli_x": {
      "oc_99aa": { sessionId: "s3", peerName: "飞书", updatedAt: "2026-10-16T12:17:31.969Z" },
    },
  };
  const newest = newestRouteTarget(routes);
  assert.equal(newest.accountId, "wecom-aibo3S7u", "the newest updatedAt wins");
  assert.equal(newest.chatId, "woIHRN");
  assert.equal(newest.peerName, "企业微信 woIHRN");
  assert.equal(newestRouteTarget({}), undefined, "an empty map answers undefined rather than throwing");
  assert.equal(newestRouteTarget(null), undefined, "and so does a missing file");
  // A hand-edited route without a timestamp still names a chat: any known target beats refusing to create
  // a task at all, which is the failure this fallback exists for.
  assert.equal(newestRouteTarget({ a: { b: {} } }).chatId, "b", "a timestamp-less route is a last-resort candidate");
  assert.equal(newestRouteTarget({ a: { b: {} } }).at, 0, "and sorts last");
});

test("transport is read from both prefix spellings, not just the colon one", () => {
  // v0.26.2 matched `wecom:` only, but `normalizeAccountId` stores account ids with a hyphen - so every
  // WeCom task was labelled WeChat, sent down the personal-WeChat path, and failed with "account is gone".
  assert.equal(transportOf("wecom:aibo3S7u"), "wecom", "the built form");
  assert.equal(transportOf("wecom-aibo3S7uP619HxNeS5X1hXSt3zztf6z9gCD"), "wecom", "the stored form");
  assert.equal(transportOf("feishu:cli_a93c"), "feishu", "the built form");
  assert.equal(transportOf("feishu-cli_a93c8f6a6f389bb5"), "feishu", "the stored form");
  assert.equal(transportOf("b775a478733a-im-bot"), "wechat", "a WeChat account carries no prefix");
  assert.equal(transportOf(""), "wechat", "an empty id falls back to WeChat");
  assert.equal(transportOf(undefined), "wechat", "and so does a missing one");
});

test("monthly fires on the asked-for day, clamping to short months", () => {
  const monthly = parseSchedule("monthly 15 09:00");
  assert.deepEqual(monthly, { kind: "monthly", day: 15, hours: 9, minutes: 0 });
  assert.deepEqual(parseSchedule("每月 1 日 09:00"), { kind: "monthly", day: 1, hours: 9, minutes: 0 });
  assert.deepEqual(parseSchedule("每月15号 08:30"), { kind: "monthly", day: 15, hours: 8, minutes: 30 });
  assert.throws(() => parseSchedule("monthly 32 09:00"), /1-31/);
  assert.equal(describeSchedule(monthly), "每月 15 日 09:00");

  // From Friday 2026-10-16 10:00, the 15th has passed, so the next one is November.
  assert.equal(nextRunAt(monthly, FRI), new Date(2026, 10, 15, 9, 0).getTime());
  // The 20th is still ahead in October.
  assert.equal(nextRunAt(parseSchedule("monthly 20 09:00"), FRI), new Date(2026, 9, 20, 9, 0).getTime());
  // 31 号 in a 30-day month: October 31 exists, November 30 does not - it clamps.
  const last = parseSchedule("monthly 31 09:00");
  const fromNov = new Date(2026, 10, 1, 10, 0).getTime();
  assert.equal(nextRunAt(last, fromNov), new Date(2026, 10, 30, 9, 0).getTime(), "November clamps to the 30th");
  // February 2027 has 28 days.
  const fromFeb = new Date(2027, 1, 1, 10, 0).getTime();
  assert.equal(nextRunAt(last, fromFeb), new Date(2027, 1, 28, 9, 0).getTime(), "February clamps to the 28th");
});

test("re-arm steps: a day keeps the time, a week the weekday, a month the day", () => {
  const at = new Date(2026, 9, 16, 9, 0).getTime(); // Friday
  const later = new Date(2026, 9, 16, 10, 0).getTime();
  const day = rearmOnce({ kind: "once", atMs: at }, later, "day");
  assert.equal(day.atMs, new Date(2026, 9, 17, 9, 0).getTime());
  assert.equal(new Date(day.atMs).getDay(), 6, "a day later is Saturday");

  const week = rearmOnce({ kind: "once", atMs: at }, later, "week");
  assert.equal(week.atMs, new Date(2026, 9, 23, 9, 0).getTime());
  assert.equal(new Date(week.atMs).getDay(), 5, "a week later is still Friday");

  const month = rearmOnce({ kind: "once", atMs: at }, later, "month");
  assert.equal(month.atMs, new Date(2026, 10, 16, 9, 0).getTime(), "same day next month");
  const rounded = rearmOnce({ kind: "once", atMs: new Date(2026, 0, 31, 9, 0).getTime() }, new Date(2026, 1, 1).getTime(), "month");
  assert.equal(new Date(rounded.atMs).getMonth(), 1, "31 Jan + 1 month stays in February");
  assert.equal(new Date(rounded.atMs).getDate(), 28, "and clamps to the 28th rather than rolling into March");
  assert.equal(Object.keys(REARM_STEPS).join(","), "day,week,month");
  assert.throws(() => rearmOnce({ kind: "once", atMs: at }, later, "year"), /重排步长只能是/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
