/**
 * Offline tests for the media helpers: extension-based classification for
 * outbound files, magic-byte sniffing for inbound ones, the size guard and the
 * text handed to the model.
 *
 * Run: node test/media.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeForModel, ensureMediaExtension, outboundKind, outboundMime, prepareOutbound } from "../media.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), "wx-media-test-"));
  try {
    await fn(dir);
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  } finally {
    // Windows occasionally holds the directory for a moment (indexer, antivirus);
    // a flaky cleanup would report a passing suite as failed.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

console.log("media helpers");

await test("outbound files are classified by extension", () => {
  assert.equal(outboundKind("a.JPG"), "image");
  assert.equal(outboundKind("a.png"), "image");
  assert.equal(outboundKind("clip.mp4"), "video");
  assert.equal(outboundKind("report.pdf"), "file");
  assert.equal(outboundKind("archive.7z"), "file");
  assert.equal(outboundMime("x.png"), "image/png");
  assert.equal(outboundMime("x.zip"), "application/zip");
  assert.equal(outboundMime("x.unknown"), "application/octet-stream");
});

await test("prepareOutbound reports kind, size and name and rejects junk", async (dir) => {
  const file = join(dir, "报告.zip");
  await writeFile(file, Buffer.alloc(2048, 7));
  const prepared = await prepareOutbound(file);
  assert.equal(prepared.kind, "file");
  assert.equal(prepared.bytes, 2048);
  assert.equal(prepared.name, "报告.zip");

  await assert.rejects(() => prepareOutbound(join(dir, "missing.bin")));
  await assert.rejects(() => prepareOutbound(file, { maxBytes: 10 }));

  const empty = join(dir, "empty.txt");
  await writeFile(empty, "");
  await assert.rejects(() => prepareOutbound(empty));
});

await test("a JPEG downloaded as .bin is renamed to .jpg", async (dir) => {
  const file = join(dir, "weixin-image-1.bin");
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]));
  const renamed = await ensureMediaExtension(file);
  assert.equal(renamed, join(dir, "weixin-image-1.jpg"));
  await stat(renamed);
  await assert.rejects(() => stat(file), "the placeholder name must be gone");
});

await test("PNG, ZIP and PDF are recognised too", async (dir) => {
  const cases = [
    ["a.bin", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ".png"],
    ["b.bin", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], ".zip"],
    ["c.bin", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], ".pdf"],
  ];
  for (const [name, magic, ext] of cases) {
    const file = join(dir, name);
    await writeFile(file, Buffer.concat([Buffer.from(magic), Buffer.alloc(16)]));
    const renamed = await ensureMediaExtension(file);
    assert.equal(renamed, join(dir, name.replace(".bin", ext)));
  }
});

await test("an unknown payload keeps its name and a matching one is left alone", async (dir) => {
  const unknown = join(dir, "mystery.bin");
  await writeFile(unknown, Buffer.from("not a known format at all"));
  assert.equal(await ensureMediaExtension(unknown), unknown);

  const jpeg = join(dir, "already.jpg");
  await writeFile(jpeg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(8)]));
  assert.equal(await ensureMediaExtension(jpeg), jpeg);
});

await test("the model gets a path and an image hint", () => {
  const image = describeForModel({ kind: "image", path: "C:\\inbox\\a.jpg", name: "a.jpg", bytes: 2048 });
  assert.match(image, /微信图片/);
  assert.match(image, /read_image/);
  assert.match(image, /C:\\inbox\\a\.jpg/);

  const doc = describeForModel({ kind: "file", path: "C:\\inbox\\报告.zip", name: "报告.zip", bytes: 5 * 1024 * 1024 });
  assert.match(doc, /微信文件/);
  assert.match(doc, /5\.0 MB/);
  assert.ok(!/read_image/.test(doc));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
