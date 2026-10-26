/**
 * Offline tests for the QR login state machine.
 *
 * The protocol client is stubbed, so these run without a network, a phone or a
 * WeChat account: each scripted status list drives one attempt and the
 * assertions check the resulting session plus what was persisted.
 *
 * Run: node test/login.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WechatLoginManager } from "../login.js";
import { WechatState } from "../state.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const root = await mkdtemp(join(tmpdir(), "wx-login-test-"));
  const state = new WechatState({ root });
  await state.init();
  try {
    await fn({ state, root });
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  } finally {
    // Windows occasionally holds the directory for a moment (indexer, antivirus);
    // a flaky cleanup would report a passing suite as failed.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** A protocol client that replays a scripted list of statuses. */
function stubClient(statuses, { qr = {} } = {}) {
  const calls = { qr: 0, polls: [], bases: [] };
  let index = 0;
  return {
    calls,
    async requestQrCode() {
      calls.qr += 1;
      return { qrcode: `QR-${calls.qr}`, raw: { qrcode_img_content: `https://qr.example/${calls.qr}.png` } };
    },
    async pollQrStatus({ baseUrl, verifyCode }) {
      calls.polls.push({ verifyCode });
      calls.bases.push(baseUrl);
      const next = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      return { ...next, ...qr };
    },
  };
}

/** A clock that only moves when the test says so. */
function fakeClock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

console.log("login state machine");

await test("wait -> scaned -> confirmed persists the credential", async ({ state }) => {
  const clock = fakeClock();
  const ilink = stubClient([
    { status: "wait" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok-1", ilink_bot_id: "b0f5860fdecb@im.bot", ilink_user_id: "wxid_me", baseurl: "https://api.example" },
  ]);
  const logins = new WechatLoginManager({ state, ilink, now: clock.now, sleep: async () => {} });
  const session = await logins.start();
  assert.equal(session.status, "wait");
  assert.equal(session.qrcode, "QR-1");
  // What goes inside the QR code: the platform's landing-page URL.
  assert.equal(session.qrPayload, "https://qr.example/1.png");

  for (let i = 0; i < 3; i += 1) await logins.tick(session);
  assert.equal(session.status, "confirmed");
  assert.equal(session.botId, "b0f5860fdecb@im.bot");
  assert.equal(session.accountId, "b0f5860fdecb-im-bot");

  const accounts = await state.loadAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, "b0f5860fdecb-im-bot");
  assert.equal(accounts[0].token, "tok-1");
  assert.equal(accounts[0].baseUrl, "https://api.example");
  assert.equal(accounts[0].userId, "wxid_me");
  assert.match(accounts[0].savedAt, /^\d{4}-\d{2}-\d{2}T/);
});

await test("need_verifycode asks for the digits and forwards them", async ({ state }) => {
  const ilink = stubClient([
    { status: "need_verifycode" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok-2", ilink_bot_id: "acct-two" },
  ]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();

  await logins.tick(session);
  assert.equal(session.verifyCodeNeeded, true);
  assert.equal(session.verifyCodeSubmitted, false);

  assert.equal(logins.submitVerifyCode(session, " 4821 "), true);
  await logins.tick(session);
  assert.equal(ilink.calls.polls.at(-1).verifyCode, "4821");
  // The phone accepted the digits, so they are not sent again.
  assert.equal(session.verifyCodeSubmitted, false);
  assert.equal(session.verifyCodeNeeded, false);

  await logins.tick(session);
  assert.equal(session.status, "confirmed");
  assert.equal(ilink.calls.polls.at(-1).verifyCode, undefined);
});

await test("scaned_but_redirect moves later polls to the redirect host", async ({ state }) => {
  const ilink = stubClient([
    { status: "scaned_but_redirect", redirectHost: "redirect.example:443" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok-3", ilink_bot_id: "acct-three" },
  ]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();

  await logins.tick(session);
  assert.equal(session.redirectHost, "redirect.example:443");
  await logins.tick(session);
  assert.equal(ilink.calls.bases.at(-1), "https://redirect.example:443");
  await logins.tick(session);
  assert.equal(session.status, "confirmed");
});

await test("expired replaces the QR and gives up after three refreshes", async ({ state }) => {
  // An explicit script: each (wait, expired) pair burns exactly one refresh.
  const ilink = stubClient([
    { status: "wait" }, { status: "expired" },
    { status: "wait" }, { status: "expired" },
    { status: "wait" }, { status: "expired" },
    { status: "wait" }, { status: "expired" },
  ]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();

  for (const expected of [1, 2, 3]) {
    await logins.tick(session); // wait
    assert.equal(session.status, "wait");
    await logins.tick(session); // expired -> a fresh QR
    assert.equal(session.refreshes, expected);
    assert.equal(session.qrcode, `QR-${expected + 1}`);
    assert.equal(session.status, "wait");
  }

  await logins.tick(session); // wait
  await logins.tick(session); // expired, but the budget is spent
  assert.equal(session.status, "give_up");
  assert.equal(session.message, "too-many-qr-refreshes");
});

await test("a QR older than five minutes is replaced before polling", async ({ state }) => {
  const clock = fakeClock();
  const ilink = stubClient([{ status: "wait" }]);
  const logins = new WechatLoginManager({ state, ilink, now: clock.now, sleep: async () => {} });
  const session = await logins.start();
  clock.advance(5 * 60 * 1000 + 1);
  await logins.tick(session);
  assert.equal(session.refreshes, 1);
  assert.equal(ilink.calls.polls.length, 0, "it should not poll with a stale QR");
});

await test("the whole attempt gives up after eight minutes", async ({ state }) => {
  const clock = fakeClock();
  const ilink = stubClient([{ status: "wait" }]);
  const logins = new WechatLoginManager({ state, ilink, now: clock.now, sleep: async () => {} });
  const session = await logins.start();
  clock.advance(481 * 1000);
  await logins.tick(session);
  assert.equal(session.status, "give_up");
  assert.equal(session.message, "login-timeout");
});

await test("confirmed without a bot id is an error", async ({ state }) => {
  const ilink = stubClient([{ status: "confirmed", bot_token: "tok-x" }]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  await logins.tick(session);
  assert.equal(session.status, "error");
  assert.equal(session.error, "confirmed-without-bot-id");
  assert.deepEqual(await state.loadAccounts(), []);
});

await test("binded_redirect reuses an account that already holds a token", async ({ state }) => {
  await state.saveAccount("acct-existing", { token: "tok-old", baseUrl: "https://api.example", userId: "wxid_old" });
  const ilink = stubClient([{ status: "binded_redirect" }]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  await logins.tick(session);
  assert.equal(session.status, "confirmed");
  assert.equal(session.accountId, "acct-existing");
  assert.equal(session.message, "reused-existing-binding");
});

await test("binded_redirect without a stored token gives up", async ({ state }) => {
  const ilink = stubClient([{ status: "binded_redirect" }]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  await logins.tick(session);
  assert.equal(session.status, "give_up");
  assert.equal(session.message, "binded-without-stored-token");
});

await test("an unknown status keeps waiting instead of failing", async ({ state }) => {
  const ilink = stubClient([{ status: "something_new" }]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  await logins.tick(session);
  assert.equal(session.phase, "pending");
});

await test("network failures during a poll are not fatal", async ({ state }) => {
  const ilink = {
    async requestQrCode() { return { qrcode: "QR-net" }; },
    async pollQrStatus() { throw new Error("524 timeout"); },
  };
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  await logins.tick(session);
  assert.equal(session.phase, "pending");
  assert.match(session.message, /poll-failed/);
});

await test("run() drives the attempt to completion", async ({ state }) => {
  const ilink = stubClient([{ status: "scaned" }, { status: "confirmed", bot_token: "tok-run", ilink_bot_id: "acct-run" }]);
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  const finished = await logins.run(session);
  assert.equal(finished.status, "confirmed");
  assert.equal((await state.loadAccounts())[0].accountId, "acct-run");
});

await test("records two accounts side by side", async ({ state }) => {
  await state.saveAccount("small-acct", { token: "tok-small", userId: "wxid_small" });
  await state.saveAccount("main-acct", { token: "tok-main", userId: "wxid_main" });
  const accounts = await state.loadAccounts();
  assert.deepEqual(accounts.map((a) => a.accountId).sort(), ["main-acct", "small-acct"]);
  assert.equal(await state.loadCursor("small-acct"), "");
  await state.saveCursor("small-acct", "cursor-1");
  assert.equal(await state.loadCursor("small-acct"), "cursor-1");
  // An empty cursor must never overwrite a good one.
  await state.saveCursor("small-acct", "");
  assert.equal(await state.loadCursor("small-acct"), "cursor-1");
  await state.removeAccount("small-acct");
  assert.deepEqual((await state.loadAccounts()).map((a) => a.accountId), ["main-acct"]);
});

await test("cancelling during an in-flight poll keeps the attempt cancelled", async ({ state }) => {
  // Cancel is a verdict, not a hint. The poll that was already in flight wrote the platform's "wait" back over it,
  // so the attempt came back to life, kept issuing QR codes and reported "pending" again - the Cancel button
  // looked like it did nothing.
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const ilink = {
    async requestQrCode() {
      return { qrcode: "QR-1", raw: { qrcode_img_content: "https://qr.example/1.png" } };
    },
    async pollQrStatus() {
      await gate;
      return { status: "wait" };
    },
  };
  const logins = new WechatLoginManager({ state, ilink, sleep: async () => {} });
  const session = await logins.start();
  const inFlight = logins.tick(session);
  await Promise.resolve();
  logins.cancel(session);
  open();
  await inFlight;
  assert.equal(session.status, "cancelled");
  assert.equal(session.phase, "cancelled");
  // A later tick must not restart it either.
  await logins.tick(session);
  assert.equal(session.status, "cancelled");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
