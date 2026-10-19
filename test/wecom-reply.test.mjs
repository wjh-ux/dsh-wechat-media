// The WeCom reply path once called an identifier that was never defined (`textBody`), so every reply that fell back
// to a proactive message threw - found by pushing a synthetic inbound through the real path, not by reading code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const host = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.js"), "utf8");
const passed = [];
const failed = [];
function test(name, fn) {
  try { fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

test("the WeCom reply path names no identifier it never defined", () => {
  assert.doesNotMatch(host, /textBody\(/, "`textBody` is defined nowhere, so calling it can only throw");
  const body = host.slice(host.indexOf("async function replyWecomInParts"), host.indexOf("async function replyWecomInParts") + 1600);
  assert.match(body, /sendMessage\(chatId, markdownBody\(parts\[index\]\)\)/, "the proactive branch sends the same body as the passive one");
});

test("a reply that cannot close its stream still goes out proactively", () => {
  const body = host.slice(host.indexOf("async function replyWecomInParts"), host.indexOf("async function replyWecomInParts") + 1600);
  assert.match(body, /streamFallback/, "the fallback is counted, not hidden");
  assert.match(body, /sendMessage\(chatId/, "and it sends proactively instead of giving up");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
