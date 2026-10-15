/**
 * Tests for the Feishu half.
 *
 * The interesting assertions use values produced by an **independent** implementation (PowerShell/.NET), not by
 * this module: the AES layout and both signature compositions are checked against digests computed elsewhere, so a
 * mistake in my own code cannot quietly agree with itself.
 *
 * Run: node test/feishu.test.mjs
 */
import assert from "node:assert/strict";

import {
  feishuAesKey,
  feishuChallenge,
  feishuDecryptEvent,
  feishuDomain,
  feishuEncryptEventForTest,
  feishuEventSignature,
  feishuExplain,
  feishuFileType,
  feishuMediaContent,
  feishuMultipart,
  feishuPostContent,
  feishuReplyMessage,
  feishuSendMessage,
  feishuTenantToken,
  feishuTextContent,
  feishuUploadImage,
  feishuVerifyEvent,
  feishuWebhookSend,
  feishuWebhookSign,
} from "../feishu.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

/** A fake fetch that records what was sent and replies with the given JSON. */
function fakeFetch(reply, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { status, json: async () => reply };
  };
  impl.calls = calls;
  return impl;
}

const TS = "1700000000";
const NONCE = "abc123";
const BODY = '{"schema":"2.0","header":{"event_type":"im.message.receive_v1"}}';
const ENC_KEY = "test-encrypt-key";
const VER_TOKEN = "verify-token";

// -----------------------------------------------------------------------------------------------------------
// Cryptography - checked against digests computed by PowerShell/.NET, not by this module.
// -----------------------------------------------------------------------------------------------------------

await test("the event signature matches a digest computed independently", () => {
  assert.equal(
    feishuEventSignature({ timestamp: TS, nonce: NONCE, body: BODY, encryptKey: ENC_KEY }),
    "82c446af194fad857bb37c8809c4115dab3e8efff1adc1bb6e56b0ca906013c0",
  );
  // Without an encrypt key the composition changes to sha1 over the verification token.
  assert.equal(
    feishuEventSignature({ timestamp: TS, nonce: NONCE, body: BODY, verificationToken: VER_TOKEN }),
    "b78ad05966835dd4830b6739269a8429706f3e2d",
  );
});

await test("an event encrypted elsewhere decrypts to exactly its payload", () => {
  // Ciphertext produced by .NET with iv = "0123456789abcdef" and key = sha256("test-encrypt-key");
  // Feishu's own layout is iv-first, which is what this asserts.
  const encrypt = "MDEyMzQ1Njc4OWFiY2RlZhD0ex5LbGAyqnXVwZXu0ppWwS+RNu2T/iL2+lv59Xphwgi/6nhz4qntAlxg/UysLcD+uOu/MkBby0k4f5DAIUFTusuS2Z9/UUI9BwUbyfJOKOLeSdOHV7HHmbFhNvvqXw==";
  const text = feishuDecryptEvent({ encrypt, encryptKey: ENC_KEY });
  assert.equal(text, '{"schema":"2.0","header":{"event_type":"im.message.receive_v1","token":"verify-token"}}');
});

await test("a wrong encrypt key never yields the plaintext", () => {
  const encrypt = "MDEyMzQ1Njc4OWFiY2RlZhD0ex5LbGAyqnXVwZXu0ppWwS+RNu2T/iL2+lv59Xphwgi/6nhz4qntAlxg/UysLcD+uOu/MkBby0k4f5DAIUFTusuS2Z9/UUI9BwUbyfJOKOLeSdOHV7HHmbFhNvvqXw==";
  let revealed = "";
  try {
    revealed = feishuDecryptEvent({ encrypt, encryptKey: "not-the-key" });
  } catch {
    revealed = "";
  }
  assert.doesNotMatch(revealed, /im\.message\.receive_v1/, "a wrong key must not decrypt the event");
  assert.throws(() => feishuDecryptEvent({ encrypt: "AAAA", encryptKey: ENC_KEY }), /too short/);
  assert.throws(() => feishuDecryptEvent({ encrypt, encryptKey: "" }), /encrypt key/);
});

await test("the AES key really is the sha256 of the encrypt key", () => {
  assert.equal(feishuAesKey("test-encrypt-key").toString("hex").length, 64);
  assert.equal(feishuAesKey("x").toString("hex"), feishuAesKey("x").toString("hex"));
  assert.notEqual(feishuAesKey("x").toString("hex"), feishuAesKey("y").toString("hex"));
});

await test("verification accepts a good signature and refuses a tampered body", () => {
  const signature = feishuEventSignature({ timestamp: TS, nonce: NONCE, body: BODY, encryptKey: ENC_KEY });
  const headers = {
    "X-Lark-Request-Timestamp": TS,
    "X-Lark-Request-Nonce": NONCE,
    "X-Lark-Signature": signature,
  };
  const good = feishuVerifyEvent({ headers, rawBody: BODY, parsed: JSON.parse(BODY), encryptKey: ENC_KEY });
  assert.equal(good.ok, true, good.reason);
  assert.equal(good.event.header.event_type, "im.message.receive_v1");

  const tampered = feishuVerifyEvent({ headers, rawBody: `${BODY} `, parsed: JSON.parse(BODY), encryptKey: ENC_KEY });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /signature does not match/);

  const missing = feishuVerifyEvent({ headers: {}, rawBody: BODY, parsed: JSON.parse(BODY), encryptKey: ENC_KEY });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no X-Lark-Request/);
});

await test("an encrypted event is decrypted during verification", () => {
  const payload = { schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: { message: { message_id: "om_1" } } };
  const encrypt = feishuEncryptEventForTest({ payload, encryptKey: ENC_KEY });
  const body = JSON.stringify({ encrypt });
  const signature = feishuEventSignature({ timestamp: TS, nonce: NONCE, body, encryptKey: ENC_KEY });
  const result = feishuVerifyEvent({
    headers: { "x-lark-request-timestamp": TS, "x-lark-request-nonce": NONCE, "x-lark-signature": signature },
    rawBody: body,
    parsed: { encrypt },
    encryptKey: ENC_KEY,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.event.event.message.message_id, "om_1");

  // Encrypted but no key configured must fail closed rather than pass the ciphertext through.
  const noKey = feishuVerifyEvent({ headers: {}, rawBody: body, parsed: { encrypt }, verificationToken: "" });
  assert.equal(noKey.ok, false);
});

await test("the URL-verification handshake is recognised", () => {
  assert.equal(feishuChallenge({ challenge: "abc-123", type: "url_verification" }), "abc-123");
  assert.equal(feishuChallenge({ challenge: "" }), undefined);
  assert.equal(feishuChallenge({ schema: "2.0" }), undefined);
  assert.equal(feishuChallenge(undefined), undefined);
});

// -----------------------------------------------------------------------------------------------------------
// Custom webhook bot - the signature here uses an empty HMAC message, which is the API's own trap.
// -----------------------------------------------------------------------------------------------------------

await test("the webhook signature matches an independent HMAC-SHA256", () => {
  assert.equal(feishuWebhookSign({ timestamp: 1700000000, secret: "webhook-secret" }), "UUNE3IuO1mPMy8fpSivoJl2p0oqpcfp6L1+ac6lldNY=");
  // Published test vector from an independent Rust implementation (lark-webhook-notify 0.1.0, Apache-2.0),
  // which signs the empty string with key = timestamp + "\n" + secret - the same trap in a different language.
  assert.equal(feishuWebhookSign({ timestamp: "1234567890", secret: "test_secret" }), "3H7JNC7ltBAwibQHFO1KFVN9HTkLtm2virjdsmGcAzw=");
});

await test("an interactive card is sent under `card`, not `content`", async () => {
  const impl = fakeFetch({ code: 0 });
  await feishuWebhookSend({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x", msgType: "interactive", content: { elements: [] }, fetchImpl: impl });
  const sent = JSON.parse(impl.calls[0].options.body);
  assert.equal(sent.msg_type, "interactive");
  assert.deepEqual(sent.card, { elements: [] });
  assert.equal(sent.content, undefined, "a card must not also carry content");
});

await test("a webhook send carries the timestamp and sign only when a secret is set", async () => {
  const withSecret = fakeFetch({ code: 0 });
  await feishuWebhookSend({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x", secret: "s", content: { text: "hi" }, timestamp: 1700000000, fetchImpl: withSecret });
  const sent = JSON.parse(withSecret.calls[0].options.body);
  assert.deepEqual(Object.keys(sent).sort(), ["content", "msg_type", "sign", "timestamp"]);
  assert.equal(sent.msg_type, "text");

  const withoutSecret = fakeFetch({ StatusCode: 0 });
  await feishuWebhookSend({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x", content: { text: "hi" }, fetchImpl: withoutSecret });
  assert.deepEqual(Object.keys(JSON.parse(withoutSecret.calls[0].options.body)).sort(), ["content", "msg_type"]);

  await assert.rejects(() => feishuWebhookSend({ webhookUrl: "http://insecure/hook" }), /https/);
  const refused = fakeFetch({ code: 19021, msg: "sign match fail" });
  await assert.rejects(() => feishuWebhookSend({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x", content: {}, fetchImpl: refused }), /refused the message/);
});

// -----------------------------------------------------------------------------------------------------------
// App bot: token, send, reply, upload.
// -----------------------------------------------------------------------------------------------------------

await test("the tenant token is fetched with the app credentials and carries an expiry", async () => {
  const impl = fakeFetch({ code: 0, tenant_access_token: "t-abc", expire: 7200 });
  const result = await feishuTenantToken({ appId: "cli_x", appSecret: "secret", fetchImpl: impl });
  assert.equal(result.token, "t-abc");
  assert.ok(result.expiresAt > Date.now() + 7000 * 1000);
  const sent = JSON.parse(impl.calls[0].options.body);
  assert.deepEqual(sent, { app_id: "cli_x", app_secret: "secret" });
  assert.match(impl.calls[0].url, /\/open-apis\/auth\/v3\/tenant_access_token\/internal$/);

  await assert.rejects(() => feishuTenantToken({ appId: "", appSecret: "x" }), /app_id and app_secret/);
  const bad = fakeFetch({ code: 99991663, msg: "app not found" });
  await assert.rejects(() => feishuTenantToken({ appId: "a", appSecret: "b", fetchImpl: bad }), /credentials are wrong/);
});

await test("sending puts the receive id, type and JSON-string content where Feishu expects", async () => {
  const impl = fakeFetch({ code: 0, data: { message_id: "om_9", chat_id: "oc_1" } });
  const result = await feishuSendMessage({
    token: "t",
    receiveId: "oc_1",
    receiveIdType: "chat_id",
    content: feishuTextContent("你好"),
    fetchImpl: impl,
  });
  assert.equal(result.messageId, "om_9");
  assert.match(impl.calls[0].url, /\/open-apis\/im\/v1\/messages\?receive_id_type=chat_id$/);
  const sent = JSON.parse(impl.calls[0].options.body);
  assert.deepEqual(sent, { receive_id: "oc_1", msg_type: "text", content: '{"text":"你好"}' });
  assert.equal(impl.calls[0].options.headers.authorization, "Bearer t");

  await assert.rejects(() => feishuSendMessage({ token: "", receiveId: "x" }), /tenant_access_token/);
  await assert.rejects(() => feishuSendMessage({ token: "t", receiveId: "" }), /receive_id/);
  const refused = fakeFetch({ code: 230002, msg: "bot not in chat" });
  await assert.rejects(() => feishuSendMessage({ token: "t", receiveId: "oc", content: "{}", fetchImpl: refused }), /bot is not in this chat/);
});

await test("replying targets the message being answered", async () => {
  const impl = fakeFetch({ code: 0, data: { message_id: "om_new" } });
  await feishuReplyMessage({ token: "t", messageId: "om_old", content: feishuTextContent("ok"), fetchImpl: impl });
  assert.match(impl.calls[0].url, /\/open-apis\/im\/v1\/messages\/om_old\/reply$/);
  await assert.rejects(() => feishuReplyMessage({ token: "t", messageId: "" }), /message_id/);
});

await test("media and rich text are built as the API documents them", () => {
  assert.equal(feishuTextContent("hi"), '{"text":"hi"}');
  assert.equal(feishuMediaContent("image", "img_1"), '{"image_key":"img_1"}');
  assert.equal(feishuMediaContent("file", "file_1"), '{"file_key":"file_1"}');
  const post = JSON.parse(feishuPostContent("# 标题\n正文", { title: "t" }));
  assert.equal(post.zh_cn.title, "t");
  assert.deepEqual(post.zh_cn.content, [[{ tag: "md", text: "# 标题\n正文" }]]);
});

await test("the multipart body carries the declared fields and the file", () => {
  const { body, boundary } = feishuMultipart([{ name: "image_type", value: "message" }], {
    name: "image",
    filename: "a.png",
    contentType: "image/png",
    bytes: Buffer.from([1, 2, 3]),
  });
  const text = body.toString("latin1");
  assert.match(text, new RegExp(`--${boundary}\\r\\ncontent-disposition: form-data; name="image_type"\\r\\n\\r\\nmessage`));
  assert.match(text, /content-disposition: form-data; name="image"; filename="a\.png"/);
  assert.match(text, /content-type: image\/png/);
  assert.match(text, new RegExp(`--${boundary}--\\r\\n$`));
  assert.ok(body.includes(Buffer.from([1, 2, 3])), "the bytes are in the body");
});

await test("an image upload returns the key a message then refers to", async () => {
  const impl = fakeFetch({ code: 0, data: { image_key: "img_7" } });
  const result = await feishuUploadImage({ token: "t", bytes: Buffer.from("x"), filename: "a.jpg", fetchImpl: impl });
  assert.equal(result.imageKey, "img_7");
  assert.match(impl.calls[0].url, /\/open-apis\/im\/v1\/images$/);
  assert.match(String(impl.calls[0].options.headers["content-type"]), /^multipart\/form-data; boundary=/);
  await assert.rejects(() => feishuUploadImage({ token: "t", bytes: Buffer.alloc(0) }), /needs bytes/);
});

await test("the file type follows what Feishu accepts", () => {
  assert.equal(feishuFileType("a.mp4"), "mp4");
  assert.equal(feishuFileType("a.opus"), "opus");
  assert.equal(feishuFileType("a.pdf"), "pdf");
  assert.equal(feishuFileType("a.docx"), "doc");
  assert.equal(feishuFileType("a.zip"), "stream");
  assert.equal(feishuFileType("voice.wav", { kind: "audio" }), "opus", "audio travels as opus");
});

await test("errors are explained in terms a person can act on", () => {
  assert.match(feishuExplain({ code: 99991664, msg: "no permission" }), /add the scope/);
  assert.match(feishuExplain({ code: 230020 }), /rate limited/);
  assert.match(feishuExplain({}), /no error detail/);
  assert.match(feishuExplain({ code: 12345, msg: "something else" }), /code 12345 \(something else\)/);
});

await test("domains resolve to the platform or to an explicit URL", () => {
  assert.equal(feishuDomain(), "https://open.feishu.cn");
  assert.equal(feishuDomain("lark"), "https://open.larksuite.com");
  assert.equal(feishuDomain("https://open.feishu.cn/"), "https://open.feishu.cn");
  assert.equal(feishuDomain("nonsense"), "https://open.feishu.cn");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
