/**
 * Offline tests for the ported iLink protocol client.
 *
 * These cover the pure halves - identity headers, the AES-ECB envelope, the CDN
 * URL builders and inbound normalization - which is where the two documented
 * traps live: the media key's two possible encodings, and the ciphertext size
 * formula that the upload request must report. No network calls are made.
 *
 * Run: node test/ilink.test.mjs
 */
import assert from "node:assert/strict";

import * as ilink from "../ilink.js";
import { mediaKindOf } from "../media.js";
import {
  aesEcbPaddedSize,
  buildBaseInfo,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  buildClientVersion,
  buildHeaders,
  decryptAesEcb,
  describeInbound,
  encryptAesEcb,
  getMediaLabel,
  getMessageId,
  isMediaItem,
  parseAesKey,
  pickMediaRef,
} from "../ilink.js";

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

console.log("ilink protocol client");

test("client version is the decimal 0x00MMNNPP the platform expects", () => {
  assert.equal(buildClientVersion("2.4.10"), 132106);
  assert.equal(buildClientVersion("2.4.6"), 132102);
  assert.equal(buildClientVersion("1.0.0"), 65536);
});

test("ciphertext size is the padded size, not the plaintext size", () => {
  // ceil((rawsize + 1) / 16) * 16 - the +1 is the PKCS#7 pad byte.
  assert.equal(aesEcbPaddedSize(100), 112);
  assert.equal(aesEcbPaddedSize(16), 32);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(0), 16);
});

test("AES-128-ECB round-trips", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("微信媒体传输 wechat media", "utf8");
  const ciphertext = encryptAesEcb(plaintext, key);
  assert.equal(ciphertext.length, aesEcbPaddedSize(plaintext.length));
  assert.deepEqual(decryptAesEcb(ciphertext, key), plaintext);
});

test("parseAesKey accepts base64 of 16 raw bytes", () => {
  const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const parsed = parseAesKey(raw.toString("base64"));
  assert.deepEqual(parsed, raw);
  assert.equal(parsed.length, 16);
});

test("parseAesKey also accepts base64 of the 32-character hex text (the trap)", () => {
  const hex = "00112233445566778899aabbccddeeff";
  const parsed = parseAesKey(Buffer.from(hex, "utf8").toString("base64"));
  assert.deepEqual(parsed, Buffer.from(hex, "hex"));
});

test("parseAesKey refuses anything else instead of guessing", () => {
  assert.throws(() => parseAesKey(Buffer.from("not-a-key").toString("base64")));
});

test("headers identify the bot and never send an empty bearer token", () => {
  const withToken = buildHeaders({ token: "  tok-1  " });
  assert.equal(withToken.Authorization, "Bearer tok-1");
  assert.equal(withToken.AuthorizationType, "ilink_bot_token");
  assert.equal(withToken["Content-Type"], "application/json");
  assert.equal(typeof withToken["iLink-App-Id"], "string");
  assert.equal(typeof withToken["iLink-App-ClientVersion"], "string");
  // X-WECHAT-UIN is base64 of the decimal form of a random uint32.
  const uin = Buffer.from(withToken["X-WECHAT-UIN"], "base64").toString("utf8");
  assert.match(uin, /^\d+$/);
  assert.ok(Number(uin) >= 0 && Number(uin) <= 4294967295);

  const withoutToken = buildHeaders({});
  assert.equal(withoutToken.Authorization, undefined);
});

test("base_info carries a channel version and a bounded bot agent", () => {
  const info = buildBaseInfo();
  assert.equal(typeof info.channel_version, "string");
  assert.ok(info.channel_version.length > 0);
  assert.equal(typeof info.bot_agent, "string");
  assert.ok(info.bot_agent.length > 0 && info.bot_agent.length <= 256);
});

test("CDN url builders encode their parameters", () => {
  const upload = buildCdnUploadUrl("https://cdn.example/c2c/", "a b+c", "fk/1");
  assert.ok(upload.startsWith("https://cdn.example/c2c/upload?"));
  assert.ok(upload.includes("encrypted_query_param=a%20b%2Bc"));
  assert.ok(upload.includes("filekey=fk%2F1"));

  const download = buildCdnDownloadUrl("https://cdn.example/c2c", "x y");
  assert.ok(download.startsWith("https://cdn.example/c2c/download?"));
  assert.ok(download.includes("encrypted_query_param=x%20y"));
});

test("media items are recognised and labelled", () => {
  assert.equal(isMediaItem({ type: 2 }), true); // image
  assert.equal(isMediaItem({ type: 4 }), true); // file
  assert.equal(isMediaItem({ type: 1 }), false); // text
  // getMediaLabel is display copy, not the internal kind - the plugin derives
  // that itself in media.js (mediaKindOf) so the image branch cannot miss.
  assert.ok(typeof getMediaLabel(2) === "string" && getMediaLabel(2).length > 0);
  assert.notEqual(getMediaLabel(2), "image");
});

test("mediaKindOf maps item types to the internal kinds", () => {
  assert.equal(mediaKindOf(ilink, { type: 2 }), "image");
  assert.equal(mediaKindOf(ilink, { type: 5 }), "video");
  assert.equal(mediaKindOf(ilink, { type: 4 }), "file");
  assert.equal(mediaKindOf(ilink, { type: 3 }), "voice");
  assert.equal(mediaKindOf(ilink, { type: 1 }), "file");
  assert.equal(mediaKindOf(undefined, { type: 2 }), "file");
});

test("a media reference is picked out of an image item", () => {
  const ref = pickMediaRef({
    type: 2,
    image_item: { media: { full_url: "https://cdn.example/d/1", aes_key: "AAAA", encrypt_type: 1 } },
  });
  assert.ok(ref, "expected a media reference");
  assert.equal(ref.fullUrl, "https://cdn.example/d/1");
});

test("message ids fall back to the first item's id", () => {
  assert.equal(getMessageId({ message_id: 12345 }), "12345");
  assert.equal(getMessageId({ item_list: [{ msg_id: "m-1" }] }), "m-1");
});

test("describeInbound normalizes an inbound image message", () => {
  const described = describeInbound({
    message_id: "m-9",
    from_user_id: "wxid_alice",
    session_id: "wxid_alice",
    item_list: [
      { type: 1, text_item: { text: "看看这张图" } },
      { type: 2, image_item: { media: { full_url: "https://cdn.example/d/2", aes_key: "AAAA", encrypt_type: 1 } } },
    ],
  });
  assert.equal(described.fromWxid, "wxid_alice");
  assert.equal(described.chatId, "wxid_alice");
  assert.equal(described.text, "看看这张图");
  assert.equal(described.kind, "text");
  assert.equal(described.media.length, 1);
  assert.equal(described.media[0].type, 2);
  assert.ok(described.media[0].item, "the raw item must ride along for downloadMedia");
});

test("describeInbound reports a media-only message as that media kind", () => {
  const described = describeInbound({
    from_user_id: "wxid_bob",
    group_id: "12345@chatroom",
    item_list: [{ type: 4, file_item: { file_name: "报告.pdf", media: { full_url: "https://cdn.example/f/1", aes_key: "AAAA" } } }],
  });
  assert.equal(described.kind, "file");
  assert.equal(described.chatId, "12345@chatroom");
  assert.equal(described.media.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
