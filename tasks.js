/**
 * Scheduled tasks: a schedule parser, the next-run maths, and the decision of what is due.
 *
 * Everything here is pure - no timers, no clock, no files - so the whole feature can be tested by
 * passing a `now`. The host owns the interval, the storage and the delivery; this module owns the two
 * things that are actually easy to get wrong: parsing "每天 8:30" and deciding when it next happens.
 *
 * Four triggers, one shape each:
 *
 *   daily 08:30           每天 08:30
 *   weekly mon 09:00      每周一 09:00       (mon/周一/1 … sun/周日/7)
 *   every 30m             每 30 分钟          (every 2h / 每2小时 / 每 90 秒 不支持：最小 1 分钟)
 *   once 2026-10-20 09:00 一次性
 *
 * Times are **local**: the person who wrote "早上 8 点" meant their own clock, and this plugin already
 * renders timestamps in local time for the same reason.
 */

/** Weekday names, English and Chinese, 1 = Monday … 7 = Sunday (ISO). */
export const WEEKDAYS = Object.freeze({
  mon: 1, monday: 1, "周一": 1, "星期一": 1, "1": 1,
  tue: 2, tuesday: 2, "周二": 2, "星期二": 2, "2": 2,
  wed: 3, wednesday: 3, "周三": 3, "星期三": 3, "3": 3,
  thu: 4, thursday: 4, "周四": 4, "星期四": 4, "4": 4,
  fri: 5, friday: 5, "周五": 5, "星期五": 5, "5": 5,
  sat: 6, saturday: 6, "周六": 6, "星期六": 6, "6": 6,
  sun: 7, sunday: 7, "周日": 7, "周天": 7, "星期日": 7, "星期天": 7, "7": 7,
});

/** The smallest interval a task may ask for; below a minute it would just burn tokens. */
export const MIN_EVERY_MS = 60_000;

const HHMM = /^(\d{1,2})\s*[:：]\s*(\d{2})$/;

/** "8:30" → { hours: 8, minutes: 30 }, refusing anything that is not a real time of day. */
export function parseTimeOfDay(text) {
  const match = HHMM.exec(String(text ?? "").trim());
  if (!match) throw new Error(`时间要写成 HH:MM，收到 ${JSON.stringify(text)}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23) throw new Error(`小时超出范围：${hours}（0-23）`);
  if (minutes > 59) throw new Error(`分钟超出范围：${minutes}（0-59）`);
  return { hours, minutes };
}

/** "30m" / "2h" / "90 分钟" → milliseconds. */
export function parseInterval(text) {
  const raw = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const match = /^(\d+(?:\.\d+)?)(s|sec|秒|m|min|分钟|分|h|hr|小时|时)$/.exec(raw);
  if (!match) throw new Error(`间隔要写成 30m / 2h / 每 30 分钟，收到 ${JSON.stringify(text)}`);
  const value = Number(match[1]);
  const unit = match[2];
  const ms = /^(s|sec|秒)$/.test(unit) ? value * 1000
    : /^(m|min|分钟|分)$/.test(unit) ? value * 60_000
      : value * 3_600_000;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`间隔必须大于 0，收到 ${JSON.stringify(text)}`);
  if (ms < MIN_EVERY_MS) throw new Error(`间隔最小 1 分钟（收到 ${Math.round(ms / 1000)} 秒）`);
  return Math.round(ms);
}

/** One `YYYY-MM-DD HH:MM` (local), or a full ISO string. */
export function parseMoment(text) {
  const raw = String(text ?? "").trim();
  const dateTime = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})\s*[:：]\s*(\d{2})$/.exec(raw);
  if (dateTime) {
    const [, y, mo, d, h, mi] = dateTime;
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
    if (Number.isNaN(at.getTime())) throw new Error(`日期时间不合法：${JSON.stringify(text)}`);
    if (at.getMonth() !== Number(mo) - 1 || at.getDate() !== Number(d)) throw new Error(`这一天不存在：${JSON.stringify(text)}`);
    return at.getTime();
  }
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  throw new Error(`时间要写成 2026-10-20 09:00，收到 ${JSON.stringify(text)}`);
}

/** A weekday token in any of the accepted forms: mon / 周一 / 星期一 / 一 / 1. */
export function parseWeekday(text) {
  const token = String(text ?? "").trim().toLowerCase();
  for (const candidate of [token, `周${token}`, `星期${token}`]) {
    if (Object.hasOwn(WEEKDAYS, candidate)) return WEEKDAYS[candidate];
  }
  throw new Error(`不认识星期几：${JSON.stringify(text)}（可写 mon / 周一 / 一 / 1 … sun / 周日 / 7）`);
}

/**
 * Parse a schedule line into one of the four shapes.
 *
 * Accepts the English and Chinese forms interchangeably, because the chat is bilingual: `daily 08:30`
 * and `每天 08:30` must mean the same thing, and a person should not have to remember which one works.
 */
export function parseSchedule(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("需要一个时间：daily 08:30 / weekly mon 09:00 / every 30m / once 2026-10-20 09:00");

  // "每天" / "每周一" without a time is a nearly-complete thought, not an interval - say that, rather
  // than letting it fall through to the `每` interval branch and complain about units.
  if (/^(daily|每天)$/i.test(raw)) throw new Error("需要一个时间：每天 08:30");
  if (/^(weekly|每周)[a-z一-龥0-9]*$/i.test(raw)) throw new Error("需要一个时间：每周一 09:00");

  // daily / 每天
  let match = /^(?:daily|每天)\s+(.+)$/i.exec(raw);
  if (match) return { kind: "daily", ...parseTimeOfDay(match[1]) };

  // weekly / 每周X
  match = /^(?:weekly|每周)\s*([a-z一-龥0-9]+)\s+(.+)$/i.exec(raw);
  if (match) return { kind: "weekly", weekday: parseWeekday(match[1]), ...parseTimeOfDay(match[2]) };

  // monthly / 每月 N 日  (checked before the generic `每` branch, which would otherwise swallow it)
  match = /^(?:monthly|每月)\s*(\d{1,2})\s*[日号]?\s+(.+)$/i.exec(raw);
  if (match) {
    const day = Number(match[1]);
    if (day < 1 || day > 31) throw new Error(`每月几号要在 1-31 之间，收到 ${day}`);
    return { kind: "monthly", day, ...parseTimeOfDay(match[2]) };
  }

  // every / 每 N 分钟
  match = /^(?:every|每)\s*(.+)$/i.exec(raw);
  if (match) return { kind: "every", everyMs: parseInterval(match[1]) };

  // once / 一次
  match = /^(?:once|一次)\s+(.+)$/i.exec(raw);
  if (match) return { kind: "once", atMs: parseMoment(match[1]) };

  throw new Error(`看不懂这个时间：${JSON.stringify(raw)}（可用 daily 08:30 / weekly mon 09:00 / every 30m / once 2026-10-20 09:00）`);
}

/** A local `YYYY-MM-DD HH:MM` stamp - the form every human-facing line in this plugin uses. */
export function formatWhen(ms) {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return "未知";
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** What the person wrote, in their words. */
export function describeSchedule(schedule) {
  if (!schedule) return "未知";
  const time = `${String(schedule.hours ?? 0).padStart(2, "0")}:${String(schedule.minutes ?? 0).padStart(2, "0")}`;
  if (schedule.kind === "daily") return `每天 ${time}`;
  if (schedule.kind === "weekly") return `每周${["一", "二", "三", "四", "五", "六", "日"][schedule.weekday - 1]} ${time}`;
  if (schedule.kind === "monthly") return `每月 ${schedule.day} 日 ${time}`;
  if (schedule.kind === "every") {
    const minutes = schedule.everyMs / 60_000;
    return minutes % 60 === 0 && minutes >= 60 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  return `${formatWhen(schedule.atMs)} 一次`;
}

/**
 * When this schedule next fires, strictly after `fromMs`.
 *
 * Strictly after, not at-or-after: a task that already ran this minute must not run again on the next
 * tick of a 20-second timer. `every` is the exception in shape only - it is just `from + interval`.
 */
export function nextRunAt(schedule, fromMs) {
  const from = Number(fromMs);
  if (!schedule) throw new Error("没有 schedule");
  if (schedule.kind === "every") return from + schedule.everyMs;
  if (schedule.kind === "once") return schedule.atMs;

  const after = new Date(from);
  const at = new Date(after.getTime());
  at.setHours(schedule.hours, schedule.minutes, 0, 0);
  if (schedule.kind === "daily") {
    if (at.getTime() <= from) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  if (schedule.kind === "monthly") {
    // The asked-for day may not exist in the month (31 in February), so the candidate is clamped to the
    // month's last day - a "31 号" reminder has to fire in February too, on the 28th/29th.
    const candidate = (year, month) => {
      const lastDay = new Date(year, month + 1, 0).getDate();
      const at2 = new Date(year, month, Math.min(schedule.day, lastDay), schedule.hours, schedule.minutes, 0, 0);
      return at2.getTime();
    };
    let year = after.getFullYear();
    let month = after.getMonth();
    if (candidate(year, month) <= from) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return candidate(year, month);
  }
  if (schedule.kind === "weekly") {
    // JS 0 = Sunday, our 1 = Monday; both directions of the shift are explicit here.
    const current = after.getDay() === 0 ? 7 : after.getDay();
    let delta = schedule.weekday - current;
    if (delta < 0) delta += 7;
    if (delta === 0 && at.getTime() <= from) delta = 7;
    at.setDate(at.getDate() + delta);
    return at.getTime();
  }
  throw new Error(`未知的 schedule.kind：${String(schedule.kind)}`);
}

/**
 * The tasks that are due right now.
 *
 * Due is derived from the task's own clock (`lastRunAt`, or `createdAt` when it has never run) rather
 * than from a stored `nextRunAt` - a stored one goes stale the moment the machine sleeps or the file is
 * edited by hand, and then a task either fires twice or never again.
 */
export function dueTasks(tasks, now) {
  const at = Number(now);
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (!task || task.enabled === false || !task.schedule) return false;
    if (task.schedule.kind === "once") {
      // "Has already run" is not the same as "is finished": a re-armed one-off keeps its history and gets a new
      // `atMs` in the future, so the guard compares the run against **this** occurrence. Checking presence alone
      // made a re-armed task permanently dead.
      if (task.lastRunAt && Number(task.lastRunAt) >= Number(task.schedule.atMs)) return false;
      return task.schedule.atMs <= at;
    }
    const from = Number(task.lastRunAt ?? task.createdAt ?? 0);
    try {
      return nextRunAt(task.schedule, from) <= at;
    } catch {
      return false; // an unreadable schedule must not take the scheduler down
    }
  });
}

/**
 * The next occurrence of a one-off: the same clock time, pushed forward a day at a time until it is in the
 * future. Used by "run again" and by the "re-arm after running" switch.
 *
 * A day at a time rather than "+24h from now", because a re-armed "下周一 9 点" should still be 9:00 - the
 * person picked a time of day, and drifting to "whenever I happened to click" would throw that away.
 */
/**
 * The steps "run again" can take. A day keeps the clock time; a week keeps the weekday; a month keeps the day
 * of the month, clamped when the target month is shorter (31 号 in February becomes the 28th).
 */
export const REARM_STEPS = Object.freeze({
  day: { advance: (at) => at.setDate(at.getDate() + 1), label: "天" },
  week: { advance: (at) => at.setDate(at.getDate() + 7), label: "周" },
  // Not `setMonth(+1)`: on 31 January that rolls into 3 March, and a "31 号" reminder would silently move
  // months. The day is clamped to the target month's last day instead, exactly like the monthly trigger.
  month: {
    advance: (at) => {
      const day = at.getDate();
      at.setDate(1);
      at.setMonth(at.getMonth() + 1);
      at.setDate(Math.min(day, new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate()));
    },
    label: "个月",
  },
});

export function rearmOnce(schedule, now = Date.now(), step = "day") {
  if (!schedule || schedule.kind !== "once") throw new Error("只有一次性任务可以重排");
  const at = new Date(Number(schedule.atMs));
  if (Number.isNaN(at.getTime())) throw new Error("这个一次性任务没有可用的时间");
  const unit = REARM_STEPS[step];
  if (!unit) throw new Error(`重排步长只能是 ${Object.keys(REARM_STEPS).join(" / ")}，收到 ${JSON.stringify(step)}`);
  // Always advance at least once, then keep going while still in the past. "Re-arm a task that is already in
  // the future" used to be a silent no-op that still answered ok:true - a button (or an API call) that reports
  // success and changes nothing. Now every call moves the task one step in the chosen direction.
  let rounds = 0;
  do {
    unit.advance(at);
    rounds += 1;
    if (rounds > 4000) throw new Error("重排次数过多，时间可能有误"); // a runaway guard, not a rule
  } while (at.getTime() <= Number(now));
  return { kind: "once", atMs: at.getTime() };
}

/**
 * How late a task may be and still run. A laptop that slept through the night would otherwise fire every
 * missed occurrence on the first tick after waking - five `prompt` tasks means five agent turns and five
 * messages about yesterday, at the same second. Past the window the occurrence is reported as missed and
 * the schedule moves on: a reminder that is hours stale is worse than one that did not arrive.
 */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

/**
 * When this task should have fired, i.e. the occurrence a tick at `now` is looking at.
 *
 * Separate from `dueTasks` so the scheduler can tell "due" from "late": the interesting question is never
 * only *whether* something is due, but by how much.
 */
export function occurrenceAt(task, now = Date.now()) {
  if (!task?.schedule) return undefined;
  if (task.schedule.kind === "once") return Number(task.schedule.atMs);
  try {
    return nextRunAt(task.schedule, Number(task.lastRunAt ?? task.createdAt ?? now));
  } catch {
    return undefined; // unreadable schedule: the caller treats "no occurrence" as nothing to do
  }
}

/**
 * Classify one task for a tick: `run` (due and inside the window), `missed` (due but stale), or `idle`.
 * `lateBy` answers "how late" for the log line, even when the answer is "too late".
 */
export function classifyOccurrence(task, now = Date.now(), graceMs = DEFAULT_GRACE_MS) {
  const at = occurrenceAt(task, now);
  if (at === undefined) return { verdict: "idle" };
  const lateBy = Number(now) - at;
  if (lateBy < 0) return { verdict: "idle" };
  if (Number(graceMs) > 0 && lateBy > Number(graceMs)) return { verdict: "missed", at, lateBy };
  return { verdict: "run", at, lateBy };
}

/** The next fire time for a task, or undefined for a finished one-off or an unreadable schedule. */
export function nextRunFor(task, now = Date.now()) {
  if (!task?.schedule) return undefined;
  if (task.schedule.kind === "once") {
    // Finished only if it ran **this** occurrence; a re-armed one-off has a future `atMs` and is due again.
    const ran = task.lastRunAt && Number(task.lastRunAt) >= Number(task.schedule.atMs);
    return ran ? undefined : task.schedule.atMs;
  }
  if (task.enabled === false) return undefined;
  try {
    return nextRunAt(task.schedule, Number(task.lastRunAt ?? task.createdAt ?? now));
  } catch {
    return undefined; // a hand-edited file must not break the listing
  }
}

export const TASK_ACTIONS = Object.freeze(["prompt", "message", "command"]);

/**
 * Build a task record, refusing anything a scheduler could not honour.
 *
 * `id` is short and human-quotable (`t3k9m2`) because the only way to remove a task is to name it in a
 * chat - a UUID would be a copy-paste exercise.
 */
export function createTask({ transport, accountId, chatId, peerName = "", action, payload, schedule, now = Date.now(), id, autoRearm = false } = {}) {
  const kind = String(action ?? "").trim();
  if (!TASK_ACTIONS.includes(kind)) throw new Error(`action 只能是 ${TASK_ACTIONS.join(" / ")} 之一，收到 ${JSON.stringify(action)}`);
  const body = String(payload ?? "").trim();
  if (!body) throw new Error(kind === "prompt" ? "prompt 任务需要一句话（到点要跑的内容）" : kind === "message" ? "message 任务需要要发的内容" : "command 任务需要要执行的命令");
  if (kind !== "command" && body.length > 4000) throw new Error(`内容太长（${body.length} 字符，上限 4000）`);
  if (!transport || !accountId || !chatId) throw new Error("任务必须指定会话（transport / accountId / chatId）");
  const parsed = typeof schedule === "string" ? parseSchedule(schedule) : schedule;
  return {
    id: String(id ?? `t${Math.random().toString(36).slice(2, 8)}`),
    transport: String(transport),
    accountId: String(accountId),
    chatId: String(chatId),
    peerName: String(peerName ?? ""),
    action: kind,
    payload: body,
    schedule: parsed,
    enabled: true,
    /**
     * One-offs only: after it runs, push the same clock time one day forward instead of finishing, which
     * is the "run it again tomorrow" some reminders actually mean. Ignored by recurring schedules, whose
     * own rule already repeats.
     */
    autoRearm: parsed.kind === "once" ? autoRearm === true : false,
    createdAt: Number(now),
    lastRunAt: null,
    lastResult: null,
    runs: 0,
  };
}

/** One line per task, for a chat listing or a tool answer. */
export function describeTask(task, now = Date.now()) {
  const when = describeSchedule(task.schedule);
  const next = nextRunFor(task, now);
  const state = task.enabled === false ? "⏸ 已暂停" : next ? `下次 ${formatWhen(next)}` : "✅ 已跑完";
  const last = task.lastRunAt ? ` · 上次 ${formatWhen(task.lastRunAt)} ${task.lastResult === "ok" ? "成功" : `失败：${task.lastResult ?? "?"}`}` : "";
  const runs = task.runs ? ` · 已运行 ${task.runs} 次` : "";
  // Every field is optional here on purpose: this line feeds `/task list`, the panel and the route, so one odd record must
  // degrade to a strange-looking row rather than break the whole list.
  const payload = String(task.payload ?? "").replace(/\s+/g, " ").slice(0, 40);
  const id = String(task.id ?? "(no id)");
  const action = String(task.action ?? "(no action)");
  return `${id} · ${when} · ${action} · ${state}${runs}${last}${payload ? ` · ${payload}` : ""}`;
}

/**
 * Which transport an account id belongs to.
 *
 * The plugin namespaces account ids with a prefix, but it has **two spellings**: `wecom:` as the id is
 * built, and `wecom-` as `normalizeAccountId` stores it. v0.26.2 matched only the colon form, so every
 * WeCom task was labelled WeChat and sent down the personal-WeChat path - failing with "account is gone",
 * which is the least helpful possible symptom. Both spellings; the default stays WeChat.
 */
export function transportOf(accountId) {
  const id = String(accountId ?? "").toLowerCase();
  if (id.startsWith("wecom:") || id.startsWith("wecom-")) return "wecom";
  if (id.startsWith("feishu:") || id.startsWith("feishu-")) return "feishu";
  return "wechat";
}

/**
 * How many times in a row a task has failed, from its history (newest first or oldest first - both work).
 *
 * Used to stop a task that can never succeed from retrying forever: a `prompt` task whose chat was deleted fails every
 * day, silently, and the person finds out when they notice nothing ever arrives.
 */
export function consecutiveFailures(entries, id) {
  const relevant = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.id === id)
    .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
  let count = 0;
  for (const entry of relevant) {
    if (entry.outcome === "ok") break;
    if (entry.outcome === "failed") count += 1;
    else break; // skipped/missed breaks the streak: it is not evidence the task is broken
  }
  return count;
}

/** The history entries to keep: newest `limit` for one task, or the whole log capped. */
export function trimHistory(entries, { limit = 200 } = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  return list.slice(-Math.max(1, Number(limit) || 200));
}

/**
 * The most recently used chat in a `routes.json` map, or undefined when there is none.
 *
 * `routes.json` is written on every inbound message and survives restarts, while `lastInbound` is memory
 * only. So this is what lets a task name its target right after a restart, without waiting for somebody
 * to send a message first - which is precisely the step a scheduled task cannot depend on.
 */
export function newestRouteTarget(routes) {
  const rows = [];
  for (const [accountId, chats] of Object.entries(routes && typeof routes === "object" ? routes : {})) {
    for (const [chatId, route] of Object.entries(chats && typeof chats === "object" ? chats : {})) {
      rows.push({
        accountId,
        chatId,
        peerName: String(route?.peerName ?? ""),
        at: Date.parse(route?.updatedAt ?? "") || 0,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at)[0];
}
