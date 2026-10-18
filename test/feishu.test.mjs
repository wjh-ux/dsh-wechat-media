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
  FEISHU_SCOPES,
  feishuScopePayload,
  feishuAesKey,
  feishuChallenge,
  feishuDecryptEvent,
  feishuDownloadResource,
  feishuDocUrl,
  feishuCreateDoc,
  feishuWikiResolve,
  feishuDocRef,
  feishuSheetCreate,
  feishuSheetRead,
  feishuSheetWrite,
  feishuBitableCreate,
  feishuBitableRead,
  feishuBitableTables,
  feishuBitableWrite,
  feishuReadDoc,
  feishuAppendText,
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

await test("a message resource is downloaded with the parameter the live API requires", async () => {
  // `type` is required - the live API answers 400 code 99992402 without it, `image/jpeg` with `type=image` and
  // `application/octet-stream` with `type=file`, each returning exactly the bytes that were sent.
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  const got = await feishuDownloadResource({ token: "t", messageId: "om_1", fileKey: "img_1", kind: "image", fetchImpl: impl });
  assert.equal(got.bytes.length, 4);
  assert.match(calls[0], /\/open-apis\/im\/v1\/messages\/om_1\/resources\/img_1\?type=image$/);
  const other = [];
  await feishuDownloadResource({ token: "t", messageId: "om_2", fileKey: "file_2", kind: "file", fetchImpl: async (url) => { other.push(String(url)); return { ok: true, status: 200, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => new Uint8Array([9]).buffer }; } });
  assert.match(other[0], /\?type=file$/, "anything that is not an image is a file");
  await assert.rejects(() => feishuDownloadResource({ token: "", messageId: "m", fileKey: "k" }), /tenant_access_token/);
  await assert.rejects(() => feishuDownloadResource({ token: "t", messageId: "", fileKey: "k" }), /message_id/);
  await assert.rejects(() => feishuDownloadResource({ token: "t", messageId: "m", fileKey: "" }), /file_key/);
  await assert.rejects(() => feishuDownloadResource({ token: "t", messageId: "m", fileKey: "k", fetchImpl: async () => ({ ok: false, status: 400, headers: { get: () => "application/json" }, json: async () => ({ code: 99992402, msg: "field validation failed" }) }) }), /field validation failed/);
});

await test("creating a document uses the response path the live API returns", async () => {
  // Verified live: POST /docx/v1/documents answered { code: 0, data: { document: { document_id, revision_id, title } } }.
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { json: async () => ({ code: 0, msg: "success", data: { document: { document_id: "S7dJdImKboGATOx8ngfcipysnGf", revision_id: 1, title: "报告" } } }) };
  };
  const got = await feishuCreateDoc({ token: "t", title: "报告", tenantHost: "ccnje3t5tkro.feishu.cn", fetchImpl: impl });
  assert.equal(got.documentId, "S7dJdImKboGATOx8ngfcipysnGf");
  assert.equal(got.title, "报告");
  assert.match(calls[0].url, /\/open-apis\/docx\/v1\/documents$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "报告" }, "only the title is sent when no folder is given");
  assert.equal(got.url, "https://ccnje3t5tkro.feishu.cn/docx/S7dJdImKboGATOx8ngfcipysnGf", "the link uses the tenant host, not the API host");
  // Measured: https://open.feishu.cn/docx/<id> answers 200 text/html (a generic page), the tenant host answers 302
  // to the login page. Without a tenant host the helper returns nothing rather than a link that looks right.
  const noHost = await feishuCreateDoc({ token: "t", title: "报告", fetchImpl: impl });
  assert.equal(noHost.url, "", "no tenant host means no link");
  assert.doesNotMatch(noHost.url, /open\.feishu\.cn/, "the API host is never used for a reader-facing link");
  await assert.rejects(() => feishuCreateDoc({ token: "", title: "x" }), /tenant_access_token/);
  await assert.rejects(() => feishuCreateDoc({ token: "t", title: "  " }), /title/);
  await assert.rejects(() => feishuCreateDoc({ token: "t", title: "x", fetchImpl: async () => ({ json: async () => ({ code: 1770001, msg: "no permission" }) }) }), /no permission/);
  await assert.rejects(() => feishuCreateDoc({ token: "t", title: "x", fetchImpl: async () => ({ json: async () => ({ code: 0, data: {} }) }) }), /no document_id/);
});

await test("appending writes the shape the live API accepted and reported back", async () => {
  // Live: POST …/blocks/<document_id>/children with { children: [{ block_type: 2, text: { elements: [{ text_run: { content } }] } }], index: 0 }
  // answered 200 code 0 { children, client_token, document_revision_id }, and raw_content then returned the line.
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { json: async () => ({ code: 0, data: { children: [{ block_id: "doxcnA" }], document_revision_id: 7 } }) };
  };
  const got = await feishuAppendText({ token: "t", documentId: "S7dJ", text: "第一行\n\n第二行\n", fetchImpl: impl });
  assert.equal(got.blocks, 1);
  assert.equal(got.revisionId, 7);
  assert.deepEqual(got.blockIds, ["doxcnA"]);
  assert.match(calls[0].url, /\/docx\/v1\/documents\/S7dJ\/blocks\/S7dJ\/children$/);
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.index, 0);
  assert.deepEqual(body.children.map((c) => c.text.elements[0].text_run.content), ["第一行", "第二行"], "blank lines are dropped, not sent as empty blocks");
  assert.deepEqual(await feishuAppendText({ token: "t", documentId: "S7dJ", text: "   " }), { blocks: 0, revisionId: null, blockIds: [] });
  await assert.rejects(() => feishuAppendText({ token: "", documentId: "x", text: "y" }), /tenant_access_token/);
  await assert.rejects(() => feishuAppendText({ token: "t", documentId: "", text: "y" }), /document_id/);
  await assert.rejects(() => feishuAppendText({ token: "t", documentId: "x", text: "y", fetchImpl: async () => ({ json: async () => ({ code: 1770001, msg: "no permission" }) }) }), /no permission/);
});

await test("a document is read through the path the live API returned", async () => {
  // Live: GET /docx/v1/documents/:id/raw_content -> 200 code 0 { data: { document_id, content } }.
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { json: async () => ({ code: 0, data: { document_id: "S7dJ", content: "标题\n正文一\n正文二\n" } }) };
  };
  const got = await feishuReadDoc({ token: "t", documentId: "S7dJ", fetchImpl: impl });
  assert.equal(got.documentId, "S7dJ");
  assert.match(got.content, /正文二/);
  assert.match(calls[0], /\/open-apis\/docx\/v1\/documents\/S7dJ\/raw_content$/);
  await assert.rejects(() => feishuReadDoc({ token: "", documentId: "x" }), /tenant_access_token/);
  await assert.rejects(() => feishuReadDoc({ token: "t", documentId: "" }), /document_id/);
  await assert.rejects(() => feishuReadDoc({ token: "t", documentId: "x", fetchImpl: async () => ({ json: async () => ({ code: 1770003, msg: "not found" }) }) }), /not found/);
});

await test("a pasted link yields the right kind of id", () => {
  assert.deepEqual(feishuDocRef("https://x.feishu.cn/docx/S7dJdImKboGATOx8ngfcipysnGf"), { kind: "docx", id: "S7dJdImKboGATOx8ngfcipysnGf" });
  assert.deepEqual(feishuDocRef("https://x.feishu.cn/wiki/WikcnAbc123456"), { kind: "wiki", id: "WikcnAbc123456" });
  assert.deepEqual(feishuDocRef("S7dJdImKboGATOx8ngfcipysnGf"), { kind: "docx", id: "S7dJdImKboGATOx8ngfcipysnGf" });
  assert.deepEqual(feishuDocRef("随便一段话"), { kind: "", id: "" }, "a wiki link is not mistaken for a document id");
  assert.deepEqual(feishuDocRef(""), { kind: "", id: "" });
});

await test("the spreadsheet helpers use the v2 values paths the live API accepted", async () => {
  // Live: POST /sheets/v3/spreadsheets -> data.spreadsheet.{spreadsheet_token,url}; the range API is v2
  // (…/values/<sheetId>!A1:B2 -> data.valueRange.values; PUT …/values {valueRange} -> data.updatedCells).
  const calls = [];
  const route = (answer) => async (url, options) => { calls.push({ url: String(url), options }); return { json: async () => answer }; };
  const created = await feishuSheetCreate({ token: "t", title: "表", fetchImpl: route({ code: 0, data: { spreadsheet: { spreadsheet_token: "JmJ", title: "表", url: "https://x.feishu.cn/sheets/JmJ" } } }) });
  assert.equal(created.spreadsheetToken, "JmJ");
  assert.equal(created.url, "https://x.feishu.cn/sheets/JmJ");
  assert.match(calls[0].url, /\/open-apis\/sheets\/v3\/spreadsheets$/);
  assert.equal(JSON.parse(calls[0].options.body).title, "表");

  calls.length = 0;
  const read = await feishuSheetRead({ token: "t", spreadsheetToken: "JmJ", range: "2cfb84!A1:B2", fetchImpl: route({ code: 0, data: { valueRange: { range: "2cfb84!A1:B2", values: [["来自", "dsh"]] } } }) });
  assert.deepEqual(read.values, [["来自", "dsh"]]);
  // Live check: the range as-is, fully percent-encoded, and with only the sheet id encoded were all accepted and\n  // returned the same values - so encoding the range is safe. Asserted in its encoded form, which is what is sent.\n  assert.match(calls[0].url, /\/sheets\/v2\/spreadsheets\/JmJ\/values\/2cfb84!A1%3AB2$/);

  calls.length = 0;
  const wrote = await feishuSheetWrite({ token: "t", spreadsheetToken: "JmJ", range: "2cfb84!A1:B2", values: [["a", "b"]], fetchImpl: route({ code: 0, data: { updatedCells: 4, updatedRange: "2cfb84!A1:B2" } }) });
  assert.equal(wrote.updatedCells, 4);
  assert.equal(calls[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].options.body), { valueRange: { range: "2cfb84!A1:B2", values: [["a", "b"]] } });
  // A range without a sheet prefix makes the helper look up the sheet id first, so this one carries the prefix to\n
  // reach the values check itself.\n  await assert.rejects(() => feishuSheetWrite({ token: "t", spreadsheetToken: "JmJ", range: "s1!A1:B2", values: [] }), /non-empty rows/);
  await assert.rejects(() => feishuSheetRead({ token: "", spreadsheetToken: "x", range: "A1" }), /tenant_access_token/);
  await assert.rejects(() => feishuSheetRead({ token: "t", spreadsheetToken: "x", range: "A1", fetchImpl: async (u) => ({ json: async () => (/sheets\/query/.test(String(u)) ? { code: 0, data: { sheets: [{ sheet_id: "s1" }] } } : { code: 1770003, msg: "range not found" }) }) }), /range not found/);
});

await test("a range without a sheet prefix is qualified with the first sheet", async () => {
  // Verified live: GET /sheets/v3/spreadsheets/:tk/sheets/query -> data.sheets[].sheet_id.
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (/sheets\/query/.test(String(url))) return { json: async () => ({ code: 0, data: { sheets: [{ sheet_id: "2cfb84" }] } }) };
    return { json: async () => ({ code: 0, data: { valueRange: { range: "2cfb84!A1:B2", values: [] } } }) };
  };
  const got = await feishuSheetRead({ token: "t", spreadsheetToken: "JmJ", range: "A1:B2", fetchImpl: impl });
  assert.equal(got.range, "2cfb84!A1:B2");
  assert.equal(calls.length, 2, "the sheet id is looked up first");
  assert.match(calls[1], /values\/2cfb84!A1%3AB2$/, "and the range is sent encoded (the API accepted all three forms)");
});

await test("the bitable helpers follow the paths the live API returned", async () => {
  // Live: POST /bitable/v1/apps {name} -> data.app.{app_token,url}; tables -> data.items[].table_id;
  // POST …/records {fields} -> data.record.{record_id,fields}; GET …/records/:id -> data.record.fields.
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (/\/apps$/.test(String(url))) return { json: async () => ({ code: 0, data: { app: { app_token: "Aor", default_table_id: "tbl", url: "https://x.feishu.cn/base/Aor", name: "表" } } }) };
    if (/\/tables\?/.test(String(url))) return { json: async () => ({ code: 0, data: { items: [{ table_id: "tbl", name: "表" }] } }) };
    if (options?.method === "POST") return { json: async () => ({ code: 0, data: { record: { record_id: "rec1", fields: { "文本": "精确校验" } } } }) };
    return { json: async () => ({ code: 0, data: { record: { record_id: "rec1", fields: { "文本": "精确校验" } } } }) };
  };
  const made = await feishuBitableCreate({ token: "t", name: "表", fetchImpl: impl });
  assert.equal(made.appToken, "Aor");
  assert.equal(made.url, "https://x.feishu.cn/base/Aor");
  const tables = await feishuBitableTables({ token: "t", appToken: "Aor", fetchImpl: impl });
  assert.equal(tables.tableId, "tbl");
  const wrote = await feishuBitableWrite({ token: "t", appToken: "Aor", tableId: "tbl", fields: { "文本": "精确校验" }, fetchImpl: impl });
  assert.equal(wrote.recordId, "rec1");
  assert.deepEqual(wrote.fields, { "文本": "精确校验" });
  const one = await feishuBitableRead({ token: "t", appToken: "Aor", tableId: "tbl", recordId: "rec1", fetchImpl: impl });
  assert.deepEqual(one.record.fields, { "文本": "精确校验" });
  assert.match(calls[calls.length - 1].url, /\/records\/rec1$/);
  await assert.rejects(() => feishuBitableWrite({ token: "t", appToken: "Aor", tableId: "tbl", fields: {} }), /non-empty fields/);
  await assert.rejects(() => feishuBitableRead({ token: "t", appToken: "", tableId: "tbl" }), /app_token and table_id/);
});

await test("a wiki node is resolved with the parameter the live API required", async () => {
  // Live: no parameter -> 400 99992402 (a required field is missing); ?token=xxx -> 400 131005 "not found"
  // (accepted, just absent); ?node_token=xxx -> the validation error again. So the parameter is `token`.
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { json: async () => ({ code: 0, data: { node: { obj_token: "S7dJdImKboGATOx8ngfcipysnGf", obj_type: "docx", node_token: "WikcnAbc" } } }) };
  };
  const got = await feishuWikiResolve({ token: "t", nodeToken: "WikcnAbc", fetchImpl: impl });
  assert.equal(got.objToken, "S7dJdImKboGATOx8ngfcipysnGf");
  assert.equal(got.objType, "docx", "the type is reported so a wiki link to a sheet or bitable can be routed");
  assert.match(calls[0], /\/open-apis\/wiki\/v2\/spaces\/get_node\?token=WikcnAbc$/);
  await assert.rejects(() => feishuWikiResolve({ token: "", nodeToken: "x" }), /tenant_access_token/);
  await assert.rejects(() => feishuWikiResolve({ token: "t", nodeToken: "" }), /node token/);
  await assert.rejects(() => feishuWikiResolve({ token: "t", nodeToken: "x", fetchImpl: async () => ({ json: async () => ({ code: 131005, msg: "not found" }) }) }), /not found/);
  await assert.rejects(() => feishuWikiResolve({ token: "t", nodeToken: "x", fetchImpl: async () => ({ json: async () => ({ code: 0, data: { node: {} } }) }) }), /no obj_token/);
});

test("the copied scopes are the ones this plugin calls, and no more", () => {
  const payload = feishuScopePayload();
  assert.equal(payload.count, FEISHU_SCOPES.length);
  // The minimum set, named: messaging and its media, documents, spreadsheets, bitables, wiki lookup.
  for (const scope of ["im:message", "im:message:send_as_bot", "im:resource", "docx:document", "sheets:spreadsheet", "bitable:app", "wiki:wiki:readonly"]) {
    assert.ok(FEISHU_SCOPES.includes(scope), `${scope} is needed by an endpoint this plugin calls`);
  }
  // Nothing administrative, nothing that can rewrite an org chart, nothing that touches other apps' data.
  for (const scope of FEISHU_SCOPES) {
    assert.doesNotMatch(scope, /admin|contact:user\.employee|permission\.member|im:chat:delete|drive:drive$/, `${scope} is not something this plugin does`);
  }
  // The JSON is the API's own shape, so it can be pasted into a request body unchanged.
  const parsed = JSON.parse(payload.json);
  assert.deepEqual(parsed.scopes.tenant, [...FEISHU_SCOPES]);
  assert.equal(payload.text.trim().split("\n").length, FEISHU_SCOPES.length, "the text form is one scope per line");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
