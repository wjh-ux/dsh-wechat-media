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
  nextRunAt,
  nextRunFor,
  parseInterval,
  parseMoment,
  parseSchedule,
  parseTimeOfDay,
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
  const done = { ...createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "message", payload: "x", schedule: "once 2026-10-16 11:00", now: FRI, id: "o" }), lastRunAt: 1 };
  assert.equal(nextRunFor(done, FRI), undefined);
});

test("describeTask says why a task failed last time", () => {
  const task = { ...createTask({ transport: "wecom", accountId: "a", chatId: "c", action: "prompt", payload: "总结一下今天", schedule: "daily 09:00", now: FRI, id: "p" }), lastRunAt: FRI, lastResult: "agent 超时", runs: 3 };
  const line = describeTask(task, FRI);
  assert.match(line, /p · 每天 09:00 · prompt/);
  assert.match(line, /已运行 3 次/);
  assert.match(line, /上次 2026-10-16 10:00 失败：agent 超时/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
