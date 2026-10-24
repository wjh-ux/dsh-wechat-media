/**
 * Tests for the chat commands: what counts as a command, what the answers say, and that
 * `/help` cannot drift away from the commands that actually exist.
 *
 * Run: node test/commands.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

import { COMMANDS, STOP_REASON, commandHelpText, findCommand, helpText, parseCommand, parseSwitch, parseWindowDays, statusText, unknownCommandText } from "../commands.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

console.log("chat commands");

console.log("-- what is a command --");

test("a slash message is parsed into name and args", () => {
  assert.deepEqual(parseCommand("/help"), { name: "help", known: true, args: "", raw: "/help" });
  assert.deepEqual(parseCommand("/new"), { name: "new", known: true, args: "", raw: "/new" });
  assert.deepEqual(parseCommand("  /status  "), { name: "status", known: true, args: "", raw: "/status" });
  assert.deepEqual(parseCommand("/new 额外 参数"), { name: "new", known: true, args: "额外 参数", raw: "/new 额外 参数" });
  assert.equal(parseCommand("/HELP").name, "help", "commands are case-insensitive");
});

test("aliases resolve to the canonical command", () => {
  for (const alias of ["h", "?", "帮助"]) assert.equal(parseCommand(`/${alias}`).name, "help");
  assert.equal(parseCommand("/reset").name, "new");
  assert.equal(parseCommand("/cancel").name, "stop");
  assert.equal(parseCommand("/状态").name, "status");
});

test("an ordinary message is not a command", () => {
  // A bare "/" is a message: people type it, and answering it with a command list would
  // be a surprise. So is anything that merely starts with a slash in the middle.
  for (const text of ["你好", "/", "", "   ", "/ ", "//", "and/or", "你好 /help"]) {
    assert.equal(parseCommand(text), undefined, `${JSON.stringify(text)} must not parse as a command`);
  }
});

test("an unknown command is recognised as one, but flagged", () => {
  const parsed = parseCommand("/deploy now");
  assert.equal(parsed.known, false);
  assert.equal(parsed.name, "deploy");
  assert.equal(parsed.args, "now");
});

console.log("-- the help cannot drift --");

test("help lists every command the module declares, and nothing else", () => {
  const text = helpText();
  for (const command of COMMANDS) {
    // Verbatim, not as a pattern: `/friends [on|off]` is full of regex metacharacters.
    assert.ok(text.includes(command.usage), `${command.usage} must appear in /help`);
    assert.ok(text.includes(command.summary), `${command.usage}'s summary must appear`);
  }
  // Every "/word" in the help must be a real command (catches a stale line).
  for (const mention of text.match(/\/[a-z]+/g) ?? []) {
    assert.ok(findCommand(mention.slice(1)), `${mention} appears in /help but is not a command`);
  }
});

test("an unknown command answer names it and then teaches the list", () => {
  const text = unknownCommandText("deploy");
  assert.match(text, /未知命令 \/deploy/);
  assert.match(text, /\/help/);
});

console.log("-- authorization --");

test("/auth is a command and takes the levels in both languages", () => {
  assert.equal(parseCommand("/auth").name, "auth");
  assert.equal(parseCommand("/auth strict").args, "strict");
  assert.equal(parseCommand("/auth 仅查看").args, "仅查看");
  assert.equal(parseCommand("/授权 full").name, "auth");
  assert.equal(parseCommand("/授权 full").args, "full");
});

test("status reports the authorization level when given one", () => {
  const text = statusText({ transport: "wechat", accountId: "a", chatId: "c", sessionId: "s", authLine: "授权档位：严格（strict）· 会在聊天里问" });
  assert.match(text, /授权档位：严格（strict）/);
  assert.match(text, /\/auth/, "the command list points at it");
});

console.log("-- interjection --");

test("/interject is a command, with the aliases people will type", () => {
  assert.equal(parseCommand("/interject").name, "interject");
  assert.equal(parseCommand("/interject on").args, "on");
  assert.equal(parseCommand("/插话 off").name, "interject");
  assert.equal(parseCommand("/插话 off").args, "off");
});

test("status reports the interjection switch and how often it fired", () => {
  const on = statusText({ transport: "wechat", accountId: "a", chatId: "c", sessionId: "s", interject: true, counters: { interjected: 4 } });
  assert.match(on, /插话：开/);
  assert.match(on, /已插话 4 次/);
  assert.match(on, /\/interject/, "the command list points at it");
  const off = statusText({ transport: "wechat", accountId: "a", chatId: "c", sessionId: "s" });
  assert.match(off, /插话：关/);
  assert.match(off, /\/interject on 可开/);
});

console.log("-- the token window --");

test("/tokens takes a number of days, with or without a unit", () => {
  assert.equal(parseWindowDays("7"), 7);
  assert.equal(parseWindowDays(" 30 "), 30);
  assert.equal(parseWindowDays("7天"), 7);
  assert.equal(parseWindowDays("14 d"), 14);
  assert.equal(parseWindowDays("1"), 1);
  // Out of range is passed through: the command clamps it and tells the user what it did,
  // which is more honest than silently ignoring 99.
  assert.equal(parseWindowDays("99"), 99);
  assert.equal(parseWindowDays(""), undefined);
  assert.equal(parseWindowDays("reset"), undefined);
  assert.equal(parseWindowDays("一周"), undefined, "no guesswork about Chinese units");
});

test("/tokens is a command, and its aliases work", () => {
  assert.equal(parseCommand("/tokens").name, "tokens");
  assert.equal(parseCommand("/tokens reset").args, "reset");
  assert.equal(parseCommand("/tokens 7").args, "7");
  assert.equal(parseCommand("/用量").name, "tokens");
  assert.equal(parseCommand("/token 30").name, "tokens");
});

test("status carries the token line when it is given one", () => {
  const withLine = statusText({ transport: "wechat", accountId: "a", chatId: "c", sessionId: "s", tokenLine: "Token 统计（7 天窗口）：共 1.5 万 · 3 次调用 · 2 天后清零" });
  assert.match(withLine, /Token 统计（7 天窗口）/);
  assert.match(withLine, /\/tokens/, "the command list points at it");
  const without = statusText({ transport: "wechat", accountId: "a", chatId: "c", sessionId: "s" });
  assert.doesNotMatch(without, /Token 统计/, "no line when the caller has none to give");
});

console.log("-- the friends-only switch --");

test("/friends takes on, off and the Chinese words, and toggles without an argument", () => {
  assert.equal(parseSwitch("on"), true);
  assert.equal(parseSwitch("OFF"), false);
  assert.equal(parseSwitch(" 开 "), true);
  assert.equal(parseSwitch("关闭"), false);
  assert.equal(parseSwitch("true"), true);
  assert.equal(parseSwitch("0"), false);
  // Not a switch word: the command reads undefined as "toggle", so a typo still does
  // something visible instead of silently nothing.
  assert.equal(parseSwitch(""), undefined);
  assert.equal(parseSwitch("maybe"), undefined);
});

test("/friends is a command with the aliases people will actually type", () => {
  assert.equal(parseCommand("/friends").name, "friends");
  assert.equal(parseCommand("/friends on").args, "on");
  assert.equal(parseCommand("/friend").name, "friends");
  assert.equal(parseCommand("/好友 off").name, "friends");
  assert.equal(parseCommand("/好友 off").args, "off");
});

test("status reports the switch and how much it has dropped", () => {
  const on = statusText({
    transport: "wechat",
    accountId: "a",
    chatId: "c",
    sessionId: "s",
    friendOnly: true,
    counters: { groupsSkipped: 7 },
  });
  assert.match(on, /只处理好友私聊：开/);
  assert.match(on, /已静默忽略群消息 7 条/);
  assert.match(on, /\/friends off 可关/);

  const off = statusText({ transport: "wechat", accountId: "a", chatId: "c", sessionId: "s" });
  assert.match(off, /只处理好友私聊：关/);
  assert.match(off, /\/friends on 可开/);
  assert.match(off, /\/friends/, "the command list mentions it");
});

test("the stop reason is a sentence the reply paths can act on", () => {
  assert.equal(typeof STOP_REASON, "string");
  assert.ok(STOP_REASON.trim().length > 8);
});

console.log("-- the status block --");

test("status names the transport, the chat, the session and the counters", () => {
  const text = statusText({
    transport: "wecom",
    accountId: "wecom-aibo3",
    chatId: "woIHRNCwAA",
    sessionId: "wechat-n07nI7em",
    generation: 0,
    counters: { received: 4, forwarded: 3, blocked: 1, answered: 0, mediaDownloaded: 2, mediaFailed: 1, mediaBytes: 3 * 1024 * 1024 },
    bot: { authenticated: true, connected: true },
    pendingApprovals: 1,
    lastInboundAt: "2026-10-14T02:00:00.000Z",
    inbox: "C:\\Users\\x\\.dsh\\wechat-inbox",
  });
  assert.match(text, /企业微信长连接/);
  assert.match(text, /账号：wecom-aibo3/);
  assert.match(text, /会话：woIHRNCwAA/);
  assert.match(text, /DSH 会话：wechat-n07nI7em/);
  assert.match(text, /收到 4 · 转发 3 · 拦截 1/);
  assert.match(text, /媒体：保存 2 · 失败 1 · 共 3\.0 MB/);
  assert.match(text, /待审批：1 个/);
  assert.match(text, /媒体目录：C:\\Users\\x\\\.dsh\\wechat-inbox/);
  assert.match(text, /\/help · \/status · \/new · \/stop/);
});

test("status stays readable with nothing to report", () => {
  const text = statusText({ transport: "wechat", accountId: "acct", chatId: "chat", sessionId: "wechat-abc" });
  assert.match(text, /通道：个人微信/);
  assert.match(text, /企业微信长连接/, "the bot line is present either way: it is how a user sees a disconnection");
  assert.doesNotMatch(text, /第 \d+ 段/, "no generation note for a chat that never ran /new");
});

test("a restarted chat says which segment it is on", () => {
  const text = statusText({ transport: "wecom", accountId: "a", chatId: "c", sessionId: "wechat-x", generation: 2 });
  assert.match(text, /第 3 段，\/new 过的/);
});

test("an unauthenticated bot is reported, with the reason when there is one", () => {
  const text = statusText({ transport: "wecom", accountId: "a", chatId: "c", sessionId: "s", bot: { connected: false, authenticated: false, error: "853000: invalid BotID" } });
  assert.match(text, /未连接（853000: invalid BotID）/);
});

test("every command the dispatcher handles is in the catalogue", () => {
  // This is the bug that shipped: index.js answered `/ssh`, but commands.js did not list it, and `parseCommand` marks
  // anything unlisted as unknown - so the branch was unreachable and the person got "未知命令 /ssh" with a list that did
  // not mention it either. A branch without a catalogue entry is dead code with a misleading error message.
  const source = readFileSync(path.join(here, "..", "index.js"), "utf8");
  const handled = [...source.matchAll(/command\.name === "([a-z0-9]+)"/g)].map((match) => match[1]);
  const catalogue = [...readFileSync(path.join(here, "..", "commands.js"), "utf8")
    .matchAll(/name: "([a-z0-9]+)"/g)].map((match) => match[1]);
  assert.ok(handled.length > 10, "sanity: the dispatcher was found");
  for (const name of new Set(handled)) {
    assert.ok(catalogue.includes(name), `/${name} is handled but missing from the command catalogue`);
  }
});

test("help can be asked about one command, and says so when it cannot", () => {
  const detail = commandHelpText("agent");
  assert.match(detail, /^\/agent/, "the page leads with the command");
  assert.match(detail, /用法：/, "and shows its usage");
  assert.match(detail, /\/agent model deepseek-account/, "the forms that are easy to get wrong are examples");
  // An alias resolves to the same page, which is what makes the alias worth printing in the list.
  assert.equal(commandHelpText("预设"), detail);

  const missing = commandHelpText("deploy");
  assert.match(missing, /没有这个命令：\/deploy/);
  assert.match(missing, /dsh-wechat-media 命令/, "and it falls back to the list, not to silence");

  // The grouped list still has to mention every command exactly once.
  const text = helpText();
  // A row per command, not a substring count: `/help` also appears in the footer hint that points at `/help <name>`.
  const rows = text.split("\n").map((line) => line.trim());
  for (const command of COMMANDS) {
    assert.ok(rows.some((row) => row.startsWith(command.usage)), `${command.name} must have its own row`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

