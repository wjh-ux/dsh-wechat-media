#!/usr/bin/env node
/**
 * Pre-release acceptance run: the offline fuzz plus the hostile HTTP probe that found five real defects in 1.5.x.
 *
 * Two halves, because they catch different things:
 *
 *   --offline   pure functions only (parser, help renderers, pref normalisers, QQ payloads, scrapling validator). No plugin,
 *               no network, no credentials. This is the half that runs in CI.
 *   --live      the running plugin's HTTP surface, hit with the shapes a buggy caller sends. Read-only or negative only: every
 *               check either reads or expects a 4xx, so running it cannot damage a real installation's data.
 *
 * Exit code is 1 if anything failed, so it can gate a release.
 *
 *   node scripts/bug-hunt.mjs                 # both (live uses the default port)
 *   node scripts/bug-hunt.mjs --offline       # pure only
 *   node scripts/bug-hunt.mjs --live 19387    # one port
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const wantsOffline = args.length === 0 || args.includes("--offline");
const wantsLive = args.length === 0 || args.includes("--live");
const portIndex = args.indexOf("--live");
const port = portIndex >= 0 && args[portIndex + 1] && /^\d+$/.test(args[portIndex + 1]) ? args[portIndex + 1] : "19387";

let checks = 0;
const failures = [];
function check(label, fn) {
  checks += 1;
  try {
    const result = fn();
    if (result instanceof Promise) return result.catch((error) => failures.push(`${label}: ${error?.message ?? error}`));
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
  }
  return undefined;
}
async function checkAsync(label, fn) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
  }
}

// ── offline ────────────────────────────────────────────────────────────────
if (wantsOffline) {
  console.log("— offline: pure functions —");
  const CMD = await import(`file://${join(root, "commands.js").replace(/\\/g, "/")}`);
  const SSH = await import(`file://${join(root, "ssh.js").replace(/\\/g, "/")}`);
  const SERIAL = await import(`file://${join(root, "serial.js").replace(/\\/g, "/")}`);
  const QQ = await import(`file://${join(root, "qq-bot.js").replace(/\\/g, "/")}`);
  const SCRAP = await import(`file://${join(root, "scrapling.js").replace(/\\/g, "/")}`);

  const nasty = ["", "/", "//", "///", "/ ", "/help", "/HELP", "/unknown", "/a/b", "/" + "x".repeat(500), "/agent model a/b/c", "/task\tlist", "/stop\n", "/😀", "/serial baud abcdef", "/ssh add", "/name " + "长".repeat(200), null, undefined, 123, {}, [], true];
  for (const input of nasty) {
    check(`parseCommand(${String(input).slice(0, 24)})`, () => {
      const result = CMD.parseCommand(input);
      if (result !== undefined && typeof result.known !== "boolean") throw new Error("missing `known`");
    });
  }

  for (const command of CMD.COMMANDS) {
    check(`page ${command.name}`, () => {
      if (!CMD.commandHelpText(command.name).includes(command.usage)) throw new Error("no usage line");
    });
    for (const alias of command.aliases ?? []) {
      check(`alias ${alias}`, () => {
        if (!CMD.commandHelpText(alias).includes(command.usage)) throw new Error("alias resolves elsewhere");
      });
    }
  }
  check("help size", () => {
    const text = CMD.helpText();
    if (text.length > 6000) throw new Error(`${text.length} chars`);
    const listed = CMD.COMMANDS.filter((command) => text.includes(command.usage)).length;
    if (listed !== CMD.COMMANDS.length) throw new Error(`${listed}/${CMD.COMMANDS.length} listed`);
  });
  check("ssh normaliser", () => {
    for (const value of [undefined, null, 0, "", "x", [], {}, { enabled: "true" }, { hosts: [] }, { hosts: "no" }, { hosts: [{ name: "nas", host: "root@1.2.3.4:2222" }] }]) {
      let result;
      try {
        result = SSH.normalizeSshPrefs(value);
      } catch (error) {
        if (!/主机|name|host/i.test(String(error.message))) throw new Error(`unhelpful error: ${error.message}`);
        continue;
      }
      if (!result || typeof result !== "object") throw new Error(`bad shape for ${JSON.stringify(value)}`);
      if (result.enabled === true && value?.enabled !== true) throw new Error("armed by something other than true");
    }
  });
  check("serial normaliser", () => {
    for (const value of [undefined, null, 0, "", "x", [], {}, { baud: "abc" }, { baud: -1 }, { baud: 1e9 }, { port: "COM999" }, { enabled: "true" }]) {
      const result = SERIAL.normalizeSerialPrefs(value);
      if (!result || typeof result !== "object") throw new Error("bad shape");
      if (result.enabled === true) throw new Error(`armed by ${JSON.stringify(value)}`);
    }
  });
  for (const bad of ["COM0", "COM03", "comx", "ttyUSB0"]) {
    check(`port ${bad} refused`, () => {
      try {
        SERIAL.normalizePort(bad);
      } catch {
        return;
      }
      throw new Error("accepted");
    });
  }
  check("qq identify", () => {
    for (const token of ["x", "QQBot x", "a".repeat(500)]) {
      if (!/^QQBot /.test(QQ.buildIdentify({ token }).d.token)) throw new Error("token not prefixed");
    }
    try {
      QQ.buildIdentify({});
      throw new Error("empty token accepted");
    } catch (error) {
      if (!/access token/.test(String(error.message))) throw error;
    }
  });
  check("qq event parsing", () => {
    for (const event of [undefined, null, {}, { t: "READY" }, { t: "C2C_MESSAGE_CREATE", d: {} }]) {
      const parsed = QQ.parseQQEvent(event ?? {});
      if (parsed !== null && !parsed.chatId) throw new Error("parsed without a chat");
    }
  });
  const STATE = await import(`file://${join(root, "state.js").replace(/\\/g, "/")}`);
  const INDEX = await import(`file://${join(root, "index.js").replace(/\\/g, "/")}`);
  // Access control and the ids that become file names: the one area where a mistake is not just a confusing message.
  check("the allowlist decision", () => {
    if (INDEX.allowDecision({ peer: {}, prefs: { requireAllowlist: false } }).accepted !== true) throw new Error("open mode refused a peer");
    if (INDEX.allowDecision({ peer: { allowed: true }, prefs: { requireAllowlist: true } }).accepted !== true) throw new Error("an allowed peer was refused");
    if (INDEX.allowDecision({ peer: { allowed: false }, prefs: { requireAllowlist: true } }).accepted !== false) throw new Error("a blocked peer was accepted");
    // the two shapes a bad write used to leave behind must never read as allowed
    for (const value of [null, "true", 1, "yes", {}]) {
      if (INDEX.allowDecision({ peer: { allowed: value }, prefs: { requireAllowlist: true } }).accepted === true) {
        throw new Error(`allowed: ${JSON.stringify(value)} counted as allowed`);
      }
    }
  });
  check("account ids are filesystem safe", () => {
    const nasty = ["../escape", "..\\escape", "a/../../escape", "/abs/path", "C:\\absolute", "..", ".", "x".repeat(500), "长".repeat(100)];
    for (const raw of nasty) {
      let id;
      try {
        id = STATE.normalizeAccountId(raw);
      } catch {
        continue;
      }
      if (!id) throw new Error(`${JSON.stringify(raw)} normalised to nothing`);
      if (/\.\.|[/\\]/.test(id)) throw new Error(`unsafe id for ${JSON.stringify(raw)}: ${id}`);
    }
  });
  check("two spellings of one account share a file, different accounts do not", () => {
    for (const [left, right] of [["wecom:1", "wecom-1"], ["qq:2", "qq-2"]]) {
      if (STATE.normalizeAccountId(left) !== STATE.normalizeAccountId(right)) throw new Error(`${left} and ${right} should share a file`);
    }
    const distinct = ["wecom-1", "qq-1", "feishu-1", "群一", "群二"];
    const mapped = distinct.map((id) => STATE.normalizeAccountId(id));
    if (new Set(mapped).size !== distinct.length) throw new Error(`distinct accounts collided: ${mapped.join(", ")}`);
  });

  // The scheduler fires unattended, so its arithmetic is checked rather than trusted.
  const TASKS = await import(`file://${join(root, "tasks.js").replace(/\\/g, "/")}`);
  const FIXED_NOW = Date.UTC(2026, 9, 24, 3, 30, 0);
  for (const text2 of ["daily 08:30", "每天 08:30", "weekly mon 09:00", "每周日 00:00", "every 30m", "every 1m", "every 2h", "每30分钟", "once 2026-12-31 23:59"]) {
    check(`the schedule parser accepts ${text2}`, () => {
      const schedule = TASKS.parseSchedule(text2);
      const next = TASKS.nextRunAt(schedule, FIXED_NOW);
      if (!Number.isFinite(next) || next <= FIXED_NOW) throw new Error(`next run is not in the future: ${next}`);
    });
  }
  for (const text2 of ["daily 24:00", "daily 23:60", "weekly 8 09:00", "every 0m", "every 30s", "once 2026-02-30 09:00", "whenever", ""]) {
    check(`the schedule parser refuses ${JSON.stringify(text2)}`, () => {
      try {
        TASKS.parseSchedule(text2);
      } catch {
        return;
      }
      throw new Error("accepted");
    });
  }
  check("daily intervals are exactly 24h", () => {
    const schedule = TASKS.parseSchedule("daily 08:30");
    const first = TASKS.nextRunAt(schedule, FIXED_NOW);
    const second = TASKS.nextRunAt(schedule, first);
    if (second - first !== 24 * 60 * 60_000) throw new Error(`${(second - first) / 3_600_000}h between runs`);
  });
  check("a paused task is never due", () => {
    const task = TASKS.createTask({ transport: "wechat", accountId: "a", chatId: "c", action: "message", payload: { text: "hi" }, schedule: "every 1m", now: FIXED_NOW });
    task.enabled = false;
    if (TASKS.dueTasks([task], FIXED_NOW + 10 * 60_000).length !== 0) throw new Error("a paused task fired");
  });
  check("an odd task record cannot break its own row", () => {
    for (const task of [{}, { schedule: {} }, { id: "t", action: "message", payload: "" }]) {
      if (/undefined/.test(TASKS.describeTask(task, FIXED_NOW))) throw new Error("the row printed undefined");
    }
  });

  // Session ids decide "same conversation" or "fresh one": /new must really change them, and chats must never collide.
  const { sessionIdFor } = await import(`file://${join(root, "index.js").replace(/\\/g, "/")}`);
  check("session ids change with the generation", () => {
    if (sessionIdFor("acct", "chat", 0) === sessionIdFor("acct", "chat", 1)) throw new Error("generation 1 reused the id");
  });
  check("session ids never collide across awkward chats", () => {
    // Every entry is distinct - a duplicated chat in this list is a bug in the test, not a collision (it was, once).
    const chats = ["a", "A", "b", "a-b", "a/b", "..", "群 1", "群1", "a b"];
    const seen = new Set();
    for (const chat of chats) {
      for (const generation of [0, 1]) {
        const id = sessionIdFor("acct", chat, generation);
        if (seen.has(id)) throw new Error(`${JSON.stringify(chat)}/${generation} collided`);
        if (/[\\/]|\.\.|\s/.test(id)) throw new Error(`unsafe id: ${JSON.stringify(id)}`);
        seen.add(id);
      }
    }
  });

  for (const url of ["file:///c:/windows/win.ini", "javascript:alert(1)", "ftp://x", "data:text/html,x", ""]) {
    await checkAsync(`scrapling refuses ${url || "(empty)"}`, async () => {
      try {
        await SCRAP.scrape({ url });
      } catch (error) {
        if (!/只接受|缺少 url/.test(String(error.message))) throw new Error(`odd message: ${error.message}`);
        return;
      }
      throw new Error("accepted");
    });
  }
}

// ── live ───────────────────────────────────────────────────────────────────
if (wantsLive) {
  const base = `http://127.0.0.1:${port}/dsh-wechat-media`;
  const json = (payload) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const probe = async (label, path, options, expected) => {
    await checkAsync(label, async () => {
      let response;
      try {
        response = await fetch(`${base}${path}`, options);
      } catch (error) {
        throw new Error(`no answer from ${base}（插件在跑吗？）: ${error?.message ?? error}`);
      }
      const text = await response.text();
      if (!expected(response.status)) throw new Error(`expected ${expected}, got ${response.status} ${text.slice(0, 120)}`);
      if (response.status >= 500) throw new Error(`server error ${response.status}: ${text.slice(0, 120)}`);
    });
  };

  console.log(`— live: ${base} —`);
  const state = await (await fetch(`${base}/state`).catch(() => null))?.json?.().catch(() => null);
  if (!state) {
    failures.push(`/state did not answer at ${base}`);
  } else {
    console.log(`  version: ${state.version}`);
  }

  await probe("GET /state", "/state", {}, (s) => s === 200);
  await probe("GET /peers", "/peers", {}, (s) => s === 200);
  await probe("GET /tokens", "/tokens", {}, (s) => s === 200);
  await probe("GET /proxy-hosts", "/proxy-hosts", {}, (s) => s === 200);
  await probe("GET /dashboard", "/dashboard", {}, (s) => s === 200);
  await probe("GET unknown route", "/__nope__", {}, (s) => s === 404);
  await probe("POST /prefs invalid JSON", "/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" }, (s) => s >= 400 && s < 500);
  await probe("POST /prefs bad qq appId", "/prefs", json({ qq: { appId: "abc" } }), (s) => s === 400);
  await probe("POST /prefs bad serial port", "/prefs", json({ serial: { port: "/dev/ttyUSB0" } }), (s) => s === 400);
  await probe("POST /prefs COM0 refused", "/prefs", json({ serial: { port: "COM0" } }), (s) => s === 400);
  await probe("POST /prefs short inboundToken", "/prefs", json({ inboundToken: "short" }), (s) => s === 400);
  await probe("POST /prefs ssh host without name", "/prefs", json({ ssh: { hosts: [{ host: "root@h" }] } }), (s) => s === 400);
  await probe("POST /peers missing ids", "/peers", json({}), (s) => s === 400);
  await probe("POST /peers unknown account", "/peers", json({ accountId: "__nope__", chatId: "x", allowed: true }), (s) => s === 400);
  await probe("POST /inbound without token", "/inbound", json({ text: "hi" }), (s) => s === 401);
  await probe("POST /inbound wrong token", "/inbound", { method: "POST", headers: { "content-type": "application/json", "x-dsh-token": "nope" }, body: JSON.stringify({ text: "hi" }) }, (s) => s === 401);
}

console.log(`\nchecks: ${checks} | failed: ${failures.length}`);
for (const failure of failures) console.log("  ✖", failure);
if (failures.length) {
  console.log("\n❌ acceptance run failed");
  process.exit(1);
}
console.log("✅ acceptance run clean");
