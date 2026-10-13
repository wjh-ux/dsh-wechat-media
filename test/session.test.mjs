/**
 * Tests for the session ladder: the exact sequence of resume/create attempts that
 * stands between "a WeCom message arrived" and "a turn runs".
 *
 * The bug these cover was observed live on the WeCom long connection: resume
 * failed, create answered `session "…" already exists`, and every later message
 * to that chat died the same way - the bot simply stopped answering. The
 * important cases are therefore the *recovery* ones, and that nothing is
 * swallowed: whatever happened is reported in the returned issue.
 *
 * Run: node test/session.test.mjs
 */
import assert from "node:assert/strict";

import { describeError, isSessionExistsError, openSessionAgent } from "../session.js";
import { sessionIdFor } from "../index.js";

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

/** An `ctx.agents` double: scripted answers per call, recording every request. */
function stubAgents(script) {
  const calls = { resume: [], create: [] };
  const handleFor = (id) => ({ id, dispose: async () => {} });
  return {
    calls,
    async resume(options) {
      calls.resume.push(options);
      const step = script.resume.shift();
      if (step instanceof Error) throw step;
      return handleFor(step?.id ?? options.resumeSessionId);
    },
    async create(options) {
      calls.create.push(options);
      const step = script.create.shift();
      if (step instanceof Error) throw step;
      return handleFor(step?.id ?? options.sessionId);
    },
  };
}

const alreadyExists = (id) => Object.assign(new Error(`session "${id}" already exists`), { name: "SessionAlreadyExistsError" });

console.log("session ladder");

console.log("-- error classification --");

await test("the persistence errors are recognised by name or by wording", () => {
  assert.equal(isSessionExistsError(alreadyExists("wechat-1")), true);
  assert.equal(isSessionExistsError(Object.assign(new Error("session x is already owned"), { name: "SessionAlreadyOwnedError" })), true);
  assert.equal(isSessionExistsError(new Error("session persistence is not configured")), false);
  assert.equal(isSessionExistsError(undefined), false);
});

await test("a described error is one readable line", () => {
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError({ name: "WeirdError" }), "WeirdError");
  assert.equal(describeError("plain"), "plain");
});

console.log("-- the ordinary paths --");

await test("a resumable session is resumed and reported as clean", async () => {
  const agents = stubAgents({ resume: [{}], create: [] });
  const { handle, issue } = await openSessionAgent({ agents, sessionId: "wechat-a", meta: { cwd: "/inbox" } });
  assert.equal(handle.id, "wechat-a");
  assert.equal(issue, undefined);
  assert.equal(agents.calls.resume.length, 1);
  assert.equal(agents.calls.create.length, 0);
});

await test("a chat with no stored session is created, and the resume miss is reported", async () => {
  const agents = stubAgents({ resume: [new Error('session "wechat-a" not found')], create: [{}] });
  const { handle, sessionId, issue } = await openSessionAgent({ agents, sessionId: "wechat-a" });
  assert.equal(handle.id, "wechat-a");
  assert.equal(sessionId, "wechat-a");
  assert.match(issue.resume, /not found/);
  assert.equal(issue.create, null);
  assert.equal(issue.freshId, null);
});

await test("meta, agentOptions and setup reach whichever call succeeds", async () => {
  const setup = async () => {};
  const agents = stubAgents({ resume: [new Error("nope")], create: [{}] });
  const { issue } = await openSessionAgent({
    agents,
    sessionId: "wechat-b",
    meta: { cwd: "/inbox", agentPreset: "default" },
    agentOptions: { provider: "deepseek-official", model: "deepseek-flash" },
    setup,
  });
  assert.ok(issue);
  const [options] = agents.calls.create;
  assert.deepEqual(options.meta, { cwd: "/inbox", agentPreset: "default" });
  assert.equal(options.agentOptions.model, "deepseek-flash");
  assert.equal(options.setup, setup);
});

console.log("-- recovery: the live wedge --");

await test("an occupied id that becomes resumable is resumed instead of abandoned", async () => {
  // The historical failure: resume misses, create says "already exists", and a
  // naive implementation gives up (or starts a throwaway session, losing history).
  const agents = stubAgents({ resume: [new Error('session "wechat-c" not found'), {}], create: [alreadyExists("wechat-c")] });
  const { handle, sessionId, issue } = await openSessionAgent({ agents, sessionId: "wechat-c" });
  assert.equal(sessionId, "wechat-c", "the stored history must be kept");
  assert.equal(handle.id, "wechat-c");
  assert.match(issue.create, /already exists/);
  assert.match(issue.retryResume, /resumed on the second attempt/);
  assert.equal(issue.freshId, null);
  assert.equal(agents.calls.resume.length, 2);
});

await test("a wedged id with no way back gets a fresh session so the chat keeps working", async () => {
  const warnings = [];
  const agents = stubAgents({
    resume: [new Error("not found"), alreadyExists("wechat-d")],
    create: [alreadyExists("wechat-d"), {}],
  });
  const { handle, sessionId, issue } = await openSessionAgent({
    agents,
    sessionId: "wechat-d",
    logger: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
    freshId: (base) => `${base}-r9zz`,
  });
  assert.equal(sessionId, "wechat-d-r9zz");
  assert.equal(handle.id, "wechat-d-r9zz");
  assert.equal(issue.freshId, "wechat-d-r9zz");
  assert.match(issue.resume, /not found/);
  assert.match(issue.create, /already exists/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /wechat-d-r9zz/);
});

await test("every attempt is named when even a fresh session cannot be created", async () => {
  const agents = stubAgents({
    resume: [new Error("not found"), alreadyExists("wechat-e")],
    create: [alreadyExists("wechat-e"), new Error("no persistence backend")],
  });
  await assert.rejects(
    () => openSessionAgent({ agents, sessionId: "wechat-e", freshId: (base) => `${base}-r1` }),
    (error) => {
      assert.match(error.message, /no persistence backend/);
      assert.match(error.message, /already exists/);
      assert.equal(error.issue.requested, "wechat-e");
      return true;
    },
  );
});

await test("a create failure that is not an id clash is reported, not papered over", async () => {
  const agents = stubAgents({ resume: [new Error("resume exploded")], create: [new Error("provider is not configured")] });
  await assert.rejects(
    () => openSessionAgent({ agents, sessionId: "wechat-f" }),
    (error) => {
      assert.match(error.message, /provider is not configured/);
      assert.match(error.message, /resume exploded/);
      return true;
    },
  );
  assert.equal(agents.calls.create.length, 1, "no pointless fresh-id attempt after a real failure");
  assert.equal(agents.calls.resume.length, 1);
});

await test("a missing agents service is refused with a readable message", async () => {
  await assert.rejects(() => openSessionAgent({ sessionId: "wechat-g" }), /ctx\.agents\.resume\/create are required/);
  await assert.rejects(() => openSessionAgent({ agents: { resume: async () => {} }, sessionId: "x" }), /are required/);
  await assert.rejects(
    () => openSessionAgent({ agents: { resume: async () => {}, create: async () => {} }, sessionId: "" }),
    /a session id is required/,
  );
});

console.log("-- one conversation per chat --");

// A stand-in with the real shape: `wecom:` + a 35-character BotID, so the account id
// alone is longer than the 30 bytes the old id rule had room for. Deliberately fake.
const WECOM_ACCOUNT = "wecom-example0BotId0NotReal0000000000000";

await test("every chat of one account gets its own session id", () => {
  // The historical bug: the id was the first 40 base64url characters of
  // `${accountId}\0${chatId}` (~30 bytes) while a WeCom account id alone is 41
  // characters, so all four of these resolved to ONE id - a direct message, a group
  // and a debug chat sharing a conversation. Verified live before the fix.
  const chats = [
    "woIHRNCwEXAMPLEchatId00000000000",
    "debug-verify-1",
    "another-chat-2",
    "12345678@chatroom",
  ];
  const ids = chats.map((chat) => sessionIdFor(WECOM_ACCOUNT, chat));
  assert.equal(new Set(ids).size, chats.length, `expected one id per chat, got ${JSON.stringify(ids)}`);
});

await test("the same chat under different accounts is a different conversation", () => {
  const chat = "woIHRNCwEXAMPLEchatId00000000000";
  assert.notEqual(sessionIdFor("b775a478733a-im-bot", chat), sessionIdFor(WECOM_ACCOUNT, chat));
});

await test("two personal chats that share a long prefix do not merge either", () => {
  const account = "b775a478733a-im-bot";
  const a = "o9cq804M3lHB9fiVfj9vwwBe_hpc@im.wechat";
  const b = "o9cq804M3lHB9fiVfj9vwwBe_other@im.wechat";
  assert.notEqual(sessionIdFor(account, a), sessionIdFor(account, b));
});

await test("the id is stable, short and filesystem-safe", () => {
  const first = sessionIdFor(WECOM_ACCOUNT, "chat-1");
  assert.equal(first, sessionIdFor(WECOM_ACCOUNT, "chat-1"), "a restart must resolve to the same conversation");
  assert.match(first, /^wechat-[A-Za-z0-9]{32}$/);
  assert.ok(first.length <= 40, "session ids become directory names");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
