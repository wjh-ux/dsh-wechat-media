// Importing the real Chrome's state: what is copied, what is skipped, and what is refused. The files are made here, so
// the test states the rule - "an absent journal is skipped, a same-directory import is refused" - instead of depending
// on whatever Chrome happens to have on this machine.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { importChromeProfile, CHROME_PROFILE_FILES } = await import("../profile.js");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

/** A throwaway source profile with the files a real Chrome would have. */
async function makeSource() {
  const root = await mkdtemp(join(tmpdir(), "dsh-chrome-src-"));
  await mkdir(join(root, "Default", "Network"), { recursive: true });
  await writeFile(join(root, "Local State"), "{\"os_crypt\":{}}", "utf8");
  await writeFile(join(root, "Default", "Network", "Cookies"), "cookie-db", "utf8");
  await writeFile(join(root, "Default", "Bookmarks"), "bookmarks-json", "utf8");
  return root;
}

await test("cookies, saved passwords and bookmarks are copied, and absent files are only reported", async () => {
  const from = await makeSource();
  const to = await mkdtemp(join(tmpdir(), "dsh-chrome-dst-"));
  const result = await importChromeProfile({ from, to });

  assert.deepEqual(result.copied.sort(), ["Default/Bookmarks", "Default/Network/Cookies", "Local State"].sort());
  assert.ok(result.missing.includes("Default/Login Data"), "a file the source does not have is reported, not fatal");
  assert.equal(await readFile(join(to, "Default", "Network", "Cookies"), "utf8"), "cookie-db", "the cookie database arrives intact");
  assert.equal(await readFile(join(to, "Local State"), "utf8"), "{\"os_crypt\":{}}", "and so does the key material");
  assert.ok(result.bytes > 0, "the size is reported so a chat can say how much moved");
});

await test("importing a profile onto itself is refused, because it would copy files onto themselves", async () => {
  const from = await makeSource();
  await assert.rejects(() => importChromeProfile({ from, to: from }), /同一个/);
  await assert.rejects(() => importChromeProfile({ from: "", to: from }), /从哪里导入/);
  await assert.rejects(() => importChromeProfile({ from, to: "" }), /导入到哪里/);
});

await test("the file list is the one that carries a login, not the whole profile", () => {
  for (const needed of ["Local State", "Default/Network/Cookies", "Default/Login Data", "Default/Bookmarks"]) {
    assert.ok(CHROME_PROFILE_FILES.includes(needed), `${needed} is imported`);
  }
  assert.ok(!CHROME_PROFILE_FILES.some((file) => file.includes("History")), "browsing history is not worth the megabytes");
  assert.ok(!CHROME_PROFILE_FILES.includes("Default/Extensions"), "extensions are not copied");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
