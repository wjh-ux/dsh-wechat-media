/**
 * Tests for the configurable inbox directory: the runtime preference wins over the
 * plugin config, which wins over the default, and a relative path is refused rather
 * than silently resolved somewhere surprising.
 *
 * Run: node test/inbox.test.mjs
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { inboxRoot, resolveInboxDir, saveInboundMedia } from "../media.js";
import { FOLDER_PICK_SCRIPT, parsePickedPath } from "../index.js";

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

const home = join(tmpdir(), "dsh-home-example");
const custom = join(tmpdir(), "my-wechat-files");
const fromConfig = join(tmpdir(), "from-config");

console.log("inbox directory");

await test("the default is $DSH_HOME/wechat-inbox", () => {
  assert.equal(resolveInboxDir({ dshHome: home }), inboxRoot(home));
  assert.ok(resolveInboxDir({ dshHome: home }).endsWith("wechat-inbox"));
});

await test("the runtime preference wins over the plugin config", () => {
  assert.equal(resolveInboxDir({ prefs: { inboxDir: custom }, config: { inboxDir: fromConfig }, dshHome: home }), custom);
  assert.equal(resolveInboxDir({ prefs: { inboxDir: custom }, dshHome: home }), custom);
});

await test("the plugin config is used when no preference is set", () => {
  assert.equal(resolveInboxDir({ prefs: {}, config: { inboxDir: fromConfig }, dshHome: home }), fromConfig);
});

await test("blank, relative and non-string values fall back to the default", () => {
  for (const bad of ["", "   ", "files/inbox", "./inbox", 42, null, undefined, {}]) {
    assert.equal(
      resolveInboxDir({ prefs: { inboxDir: bad }, dshHome: home }),
      inboxRoot(home),
      `"${String(bad)}" must not become an inbox root`,
    );
  }
});

await test("surrounding whitespace is trimmed, not treated as part of the path", () => {
  assert.equal(resolveInboxDir({ prefs: { inboxDir: `  ${custom}  ` }, dshHome: home }), custom);
});

await test("saveInboundMedia writes under the override and keeps the day/chat layout", async () => {
  const writes = [];
  const ilink = {
    async downloadMedia({ destDir, fileName }) {
      writes.push({ destDir, fileName });
      // Pretend the protocol wrote a PNG; the wrapper then sniffs the extension.
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(destDir, { recursive: true });
      const target = join(destDir, fileName ?? "image.bin");
      await writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
      return target;
    },
  };
  const saved = await saveInboundMedia({
    ilink,
    chatId: "123@chatroom",
    item: { type: 2 },
    dshHome: home,
    inboxPath: custom,
    now: Date.UTC(2026, 9, 13, 5, 0, 0),
  });
  assert.ok(saved.path.startsWith(custom), `expected ${saved.path} under ${custom}`);
  assert.ok(saved.path.includes("2026-10-13"), "the day folder is preserved");
  assert.ok(saved.path.includes("123-chatroom"), "the chat folder is preserved");
  assert.equal(typeof saved.kind, "string"); // the kind comes from the item fields, not from the path
  assert.equal(writes[0].destDir.startsWith(custom), true);
});

await test("a relative inboxPath is ignored in favour of the default root", async () => {
  const ilink = {
    async downloadMedia({ destDir, fileName }) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(destDir, { recursive: true });
      const target = join(destDir, fileName ?? "image.bin");
      await writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return target;
    },
  };
  const saved = await saveInboundMedia({ ilink, chatId: "wxid_a", item: { type: 2 }, dshHome: home, inboxPath: "relative/dir" });
  assert.ok(saved.path.startsWith(resolve(inboxRoot(home))), `expected the default root, got ${saved.path}`);
});

console.log("-- system folder picker --");

await test("the picker script asks Windows for a folder, in STA", () => {
  assert.match(FOLDER_PICK_SCRIPT, /FolderBrowserDialog/);
  assert.match(FOLDER_PICK_SCRIPT, /ShowDialog/);
  assert.match(FOLDER_PICK_SCRIPT, /SelectedPath/);
});

await test("only an absolute path from the dialog is accepted", () => {
  assert.equal(parsePickedPath("D:\\wechat-files\r\n"), "D:\\wechat-files");
  assert.equal(parsePickedPath("  C:\\Users\\Administrator\\Documents  "), "C:\\Users\\Administrator\\Documents");
  assert.equal(parsePickedPath(""), undefined, "a cancelled dialog prints nothing");
  assert.equal(parsePickedPath("   "), undefined);
  assert.equal(parsePickedPath("relative\\dir"), undefined, "a relative answer is refused");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);