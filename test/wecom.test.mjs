/**
 * Tests for the WeCom transport: payload shapes, error mapping, token caching and
 * the request the client actually sends (with fetch injected, so no network).
 *
 * Run: node test/wecom.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  API_BASE,
  appMediaPayload,
  createTokenCache,
  getToken,
  imagePayload,
  isWebhookUrl,
  markdownPayload,
  maskSecret,
  sendAppMessage,
  sendWebhook,
  textPayload,
  wecomError,
  wecomUploadType,
} from "../wecom.js";

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

const KEY = "693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa";
const HOOK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`;

/** A fetch stub that records calls and answers with canned JSON. */
function stubFetch(answers) {
  const calls = [];
  const queue = [...answers];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    const body = typeof answer === "string" ? answer : JSON.stringify(answer ?? { errcode: 0, errmsg: "ok" });
    return { status: 200, ok: true, text: async () => body, json: async () => JSON.parse(body) };
  };
  impl.calls = calls;
  return impl;
}

console.log("wecom transport");

console.log("-- webhook url --");

await test("a real robot url is accepted, lookalikes are not", () => {
  assert.equal(isWebhookUrl(HOOK), true);
  assert.equal(isWebhookUrl(`  ${HOOK}  `), true);
  assert.equal(isWebhookUrl("http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x"), false, "https only");
  assert.equal(isWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send"), false, "the key is required");
  assert.equal(isWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/gettoken?key=x"), false, "wrong endpoint");
  assert.equal(isWebhookUrl("https://evil.example/webhook/send?key=x"), false);
  assert.equal(isWebhookUrl(""), false);
  assert.equal(isWebhookUrl(undefined), false);
});

console.log("-- payloads --");

await test("text and markdown carry their content", () => {
  assert.deepEqual(textPayload("hi"), { msgtype: "text", text: { content: "hi" } });
  const mentioned = textPayload("hi", { mentionedList: ["@all"], mentionedMobileList: ["13800000000"] });
  assert.deepEqual(mentioned.text.mentioned_list, ["@all"]);
  assert.deepEqual(mentioned.text.mentioned_mobile_list, ["13800000000"]);
  assert.deepEqual(markdownPayload("**bold**"), { msgtype: "markdown", markdown: { content: "**bold**" } });
});

await test("an image payload carries base64 plus its md5", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = imagePayload(bytes);
  assert.equal(payload.msgtype, "image");
  assert.equal(payload.image.base64, bytes.toString("base64"));
  assert.match(payload.image.md5, /^[0-9a-f]{32}$/);
  assert.equal(payload.image.md5, createHash("md5").update(bytes).digest("hex"));
});

await test("application media payloads use the right key", () => {
  assert.deepEqual(appMediaPayload("image", "M1"), { msgtype: "image", image: { media_id: "M1" } });
  assert.deepEqual(appMediaPayload("file", "M2"), { msgtype: "file", file: { media_id: "M2" } });
  assert.deepEqual(appMediaPayload("video", "M3"), { msgtype: "video", video: { media_id: "M3" } });
});

console.log("-- errors --");

await test("errors are named instead of just numbered", () => {
  assert.equal(wecomError({ errcode: 0, errmsg: "ok" }), undefined);
  assert.equal(wecomError({}), undefined);
  assert.match(wecomError({ errcode: 93000, errmsg: "invalid webhook url" }), /invalid webhook url/);
  assert.match(wecomError({ errcode: 40001, errmsg: "invalid credential" }), /corpsecret/);
  assert.match(wecomError({ errcode: 60020, errmsg: "not allow to access from your ip" }), /trusted IP list/);
  assert.match(wecomError({ errcode: 12345, errmsg: "weird" }), /WeCom 12345 - weird/);
  assert.equal(wecomError({ errcode: 93000, errmsg: "invalid webhook url" }), "WeCom 93000: invalid webhook url - check the key in the URL", "a redundant errmsg is not repeated");
  assert.equal(wecomError({ errcode: 40001, errmsg: "invalid credential" }), "WeCom 40001: invalid credential - check corpsecret (and that the app is enabled)");
  assert.match(wecomError({ errcode: 60020, errmsg: "not allow to access from your ip" }), /trusted IP list - not allow to access/);
});

console.log("-- sending --");

await test("a webhook post goes to the url as JSON", async () => {
  const fetchImpl = stubFetch([{ errcode: 0, errmsg: "ok" }]);
  const result = await sendWebhook({ webhookUrl: HOOK, payload: textPayload("hello"), fetchImpl });
  assert.equal(result.errcode, 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, HOOK);
  assert.equal(fetchImpl.calls[0].options.method, "POST");
  assert.equal(fetchImpl.calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), { msgtype: "text", text: { content: "hello" } });
});

await test("a refused webhook throws a readable error and a bad url never posts", async () => {
  const fetchImpl = stubFetch([{ errcode: 93000, errmsg: "invalid webhook url" }]);
  await assert.rejects(() => sendWebhook({ webhookUrl: HOOK, payload: textPayload("x"), fetchImpl }), /invalid webhook url/);
  const never = stubFetch([{ errcode: 0 }]);
  await assert.rejects(() => sendWebhook({ webhookUrl: "https://example.com/?key=x", payload: textPayload("x"), fetchImpl: never }), /must look like/);
  assert.equal(never.calls.length, 0, "a malformed url must not leave the process");
});

await test("a non-JSON answer is reported, not swallowed", async () => {
  const fetchImpl = stubFetch(["<html>gateway error</html>"]);
  await assert.rejects(() => sendWebhook({ webhookUrl: HOOK, payload: textPayload("x"), fetchImpl }), /non-JSON body/);
});

console.log("-- application api --");

await test("getToken reads the token and refuses an incomplete config", async () => {
  const fetchImpl = stubFetch([{ errcode: 0, access_token: "tok-123", expires_in: 7200 }]);
  const { token, expiresIn } = await getToken({ corpId: "ww123", corpSecret: "secret", fetchImpl });
  assert.equal(token, "tok-123");
  assert.equal(expiresIn, 7200);
  assert.match(fetchImpl.calls[0].url, new RegExp(`^${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/gettoken\\?corpid=ww123&corpsecret=secret$`));
  await assert.rejects(() => getToken({ corpId: "ww123" }), /corpId and corpSecret/);
});

await test("a rejected credential surfaces the hint about corpsecret", async () => {
  const fetchImpl = stubFetch([{ errcode: 40001, errmsg: "invalid credential" }]);
  await assert.rejects(() => getToken({ corpId: "ww123", corpSecret: "bad", fetchImpl }), /corpsecret/);
});

await test("token caching reuses a live token and refreshes an expired one", () => {
  let clock = 1_000_000;
  const cache = createTokenCache({ now: () => clock, safetyMs: 60_000 });
  assert.equal(cache.get(), undefined, "nothing cached yet");
  cache.set("tok-1", 7200);
  assert.equal(cache.get(), "tok-1");
  clock += 7300 * 1000; // past the two hours
  assert.equal(cache.get(), undefined, "an expired token is not reused");
  cache.set("tok-2", 7200);
  clock += 7150 * 1000; // inside the safety margin before expiry
  assert.equal(cache.get(), undefined, "the safety margin refreshes early");
  cache.clear();
  assert.equal(cache.get(), undefined);
});

await test("an application message carries agentid and touser", async () => {
  const fetchImpl = stubFetch([{ errcode: 0, errmsg: "ok", msgid: "m1" }]);
  const result = await sendAppMessage({
    token: "tok",
    agentId: 1000002,
    toUser: "zhangsan|@all",
    payload: textPayload("hello"),
    fetchImpl,
  });
  assert.equal(result.msgid, "m1");
  assert.match(fetchImpl.calls[0].url, /message\/send\?access_token=tok$/);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.agentid, 1000002);
  assert.equal(body.touser, "zhangsan|@all");
  assert.equal(body.safe, 0);
  assert.equal(body.msgtype, "text");
  await assert.rejects(() => sendAppMessage({ token: "tok", agentId: "nope", payload: textPayload("x"), fetchImpl }), /agentId must be a number/);
});

console.log("-- helpers --");

await test("upload types follow the extension", () => {
  assert.equal(wecomUploadType("C:\\tmp\\a.PNG"), "image");
  assert.equal(wecomUploadType("/tmp/a.mp4"), "video");
  assert.equal(wecomUploadType("a.amr"), "voice");
  assert.equal(wecomUploadType("a.zip"), "file");
  assert.equal(wecomUploadType("no-extension"), "file");
});

await test("secrets are masked but still recognisable", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret("abcdefghijklmnop"), "abcd…mnop");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
