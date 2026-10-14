/**
 * Tests for WeCom long-connection inbound media: the cipher, the file name, and the
 * download wrapper.
 *
 * The scheme is not guessable and getting it wrong fails loudly in production, so it is
 * pinned here against the official SDK's implementation (`@wecom/aibot-node-sdk` v1.0.7,
 * src/crypto.ts): AES-256-CBC, key = base64(aeskey) (32 bytes), iv = key[0..16], PKCS#7
 * padded to a **32**-byte multiple. That last detail is why Node's own padding removal
 * cannot be used: it works in 16-byte blocks and throws `bad decrypt` on the boundary.
 *
 * Run: node test/wecom-media.test.mjs
 */
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decryptWecomMedia, downloadWecomMedia, fileNameFromDisposition, wecomMediaKey } from "../wecom-media.js";

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

/** Encrypt the way WeCom does: AES-256-CBC, iv = key[0..16], PKCS#7 to 32 bytes. */
function encryptLikeWeCom(plaintext, key) {
  const padLength = 32 - (plaintext.length % 32);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLength, padLength)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

const keyOf = () => randomBytes(32);
const keyTextOf = (key) => key.toString("base64");

console.log("wecom media");

console.log("-- the aeskey --");

await test("a base64 32-byte key is accepted, in both padded and unpadded form", () => {
  const key = keyOf();
  assert.equal(wecomMediaKey(keyTextOf(key)).length, 32);
  assert.deepEqual(wecomMediaKey(keyTextOf(key)), key);
  const unpadded = keyTextOf(key).replace(/=+$/, "");
  assert.deepEqual(wecomMediaKey(unpadded), key, "WeCom sometimes omits base64 padding");
});

await test("a missing or wrong-sized key is refused with a readable message", () => {
  assert.throws(() => wecomMediaKey(""), /aeskey is missing/);
  assert.throws(() => wecomMediaKey(undefined), /aeskey is missing/);
  assert.throws(() => wecomMediaKey(randomBytes(16).toString("base64")), /must decode to 32 bytes \(got 16\)/);
});

console.log("-- decryption --");

await test("a payload round-trips", () => {
  const key = keyOf();
  const plaintext = Buffer.from("企业微信图片内容 hello", "utf8");
  const decrypted = decryptWecomMedia(encryptLikeWeCom(plaintext, key), keyTextOf(key));
  assert.deepEqual(decrypted, plaintext);
});

await test("it survives the boundary Node's own padding removal would fail on", () => {
  // Plaintext of 32/48 bytes pads to a full 32-byte block: with auto padding on,
  // Node strips 16 bytes and exits with `bad decrypt`.
  const key = keyOf();
  for (const length of [32, 48, 64]) {
    const plaintext = Buffer.alloc(length, 0x41);
    const decrypted = decryptWecomMedia(encryptLikeWeCom(plaintext, key), keyTextOf(key));
    assert.equal(decrypted.length, length, `length ${length} must round-trip`);
    assert.deepEqual(decrypted, plaintext);
  }
});

await test("a wrong key or damaged ciphertext fails loudly", () => {
  const key = keyOf();
  const other = keyOf();
  const ciphertext = encryptLikeWeCom(Buffer.from("secret"), key);
  assert.throws(() => decryptWecomMedia(ciphertext, keyTextOf(other)), /decryption failed|padding/);
  assert.throws(() => decryptWecomMedia(Buffer.alloc(0), keyTextOf(key)), /nothing to decrypt/);
});

console.log("-- the file name --");

await test("Content-Disposition is read in both forms, and nothing else is invented", () => {
  assert.equal(fileNameFromDisposition('attachment; filename="report.pdf"'), "report.pdf");
  assert.equal(fileNameFromDisposition("attachment; filename=plain.zip"), "plain.zip");
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"), "报告.pdf");
  assert.equal(fileNameFromDisposition("attachment"), undefined);
  assert.equal(fileNameFromDisposition(undefined), undefined);
});

console.log("-- download + decrypt into the inbox --");

/** A fetch stub that answers with canned bytes and headers. */
function stubFetch({ body, headers = {}, status = 200, statusText = "OK", fail } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (fail) throw new Error(fail);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      arrayBuffer: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

await test("an image is fetched, decrypted and written with the extension its bytes imply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wecom-media-test-"));
  try {
    const key = keyOf();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
    const fetchImpl = stubFetch({ body: encryptLikeWeCom(png, key), headers: { "content-type": "image/png" } });
    const file = await downloadWecomMedia({
      item: { type: "image", url: "https://example.invalid/a", aesKey: keyTextOf(key) },
      destDir: dir,
      fetchImpl,
    });
    assert.match(file, /wecom-image-\d+-[0-9a-f]{8}\.png$/, "an unnamed image gets a generated name with the right extension");
    assert.deepEqual(await readFile(file), png, "the bytes on disk are the decrypted payload");
    assert.equal(fetchImpl.calls[0].url, "https://example.invalid/a");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test("a file keeps the name the Content-Disposition header gives it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wecom-media-test-"));
  try {
    const key = keyOf();
    const payload = Buffer.from("PK\x03\x04 not really a zip but close enough", "utf8");
    const fetchImpl = stubFetch({
      body: encryptLikeWeCom(payload, key),
      headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="季度报表.zip"' },
    });
    const file = await downloadWecomMedia({
      item: { type: "file", url: "https://example.invalid/b", aesKey: keyTextOf(key) },
      destDir: dir,
      fetchImpl,
    });
    assert.match(file, /季度报表\.zip$/);
    assert.deepEqual(await readFile(file), payload);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test("a payload with no aeskey is saved as-is (the protocol allows it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wecom-media-test-"));
  try {
    const bytes = Buffer.from("plain bytes", "utf8");
    const file = await downloadWecomMedia({
      item: { type: "file", url: "https://example.invalid/c" },
      destDir: dir,
      fileName: "plain.txt",
      fetchImpl: stubFetch({ body: bytes, headers: { "content-type": "text/plain" } }),
    });
    assert.match(file, /plain\.txt$/);
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).size, bytes.length);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test("an expired url, an HTTP error and an oversized payload all say what happened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wecom-media-test-"));
  try {
    await assert.rejects(
      () => downloadWecomMedia({ item: { type: "image", url: "https://example.invalid/x" }, destDir: dir, fetchImpl: stubFetch({ fail: "socket hang up" }) }),
      /only valid for five minutes/,
    );
    await assert.rejects(
      () => downloadWecomMedia({ item: { type: "image", url: "https://example.invalid/x" }, destDir: dir, fetchImpl: stubFetch({ body: Buffer.alloc(0), status: 403, statusText: "Forbidden" }) }),
      /HTTP 403 Forbidden/,
    );
    await assert.rejects(
      () => downloadWecomMedia({
        item: { type: "file", url: "https://example.invalid/x" },
        destDir: dir,
        maxBytes: 4,
        fetchImpl: stubFetch({ body: Buffer.alloc(10), headers: { "content-length": "10" } }),
      }),
      /over the 4 byte cap/,
    );
    await assert.rejects(
      () => downloadWecomMedia({ item: { type: "image" }, destDir: dir }),
      /carried no download url/,
    );
    await assert.rejects(
      () => downloadWecomMedia({ item: { type: "image", url: "https://example.invalid/x" }, destDir: "relative/dir" }),
      /destDir must be an absolute directory/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test("a decryption failure is reported, not written out as garbage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wecom-media-test-"));
  try {
    await assert.rejects(
      () => downloadWecomMedia({
        item: { type: "image", url: "https://example.invalid/x", aesKey: keyTextOf(keyOf()) },
        destDir: dir,
        fetchImpl: stubFetch({ body: Buffer.from("not encrypted at all, really") }),
      }),
      /decryption failed|padding/,
    );
    const left = (await import("node:fs/promises")).readdir(dir);
    assert.deepEqual(await left, [], "nothing is left behind when decryption fails");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
