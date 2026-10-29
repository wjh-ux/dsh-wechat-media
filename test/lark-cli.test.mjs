// The Feishu CLI bridge takes a command *line* from the model and turns it into argv with no shell anywhere in the
// path. That makes two things worth pinning down: the tokenizer must not invent or drop arguments (a Chinese title with
// a space, an `&`, an empty string), and the guard must refuse the commands that would hang a tool call or wipe the
// stored credentials.
import assert from "node:assert/strict";

import { larkAssertRunnable, larkSplitArgs } from "../lark.js";

const passed = [];
const failed = [];
function test(name, fn) {
  try { fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

test("a plain command line becomes one word per argument", () => {
  assert.deepEqual(larkSplitArgs("calendar +agenda --date today"), ["calendar", "+agenda", "--date", "today"]);
});

test("a quoted title keeps its spaces and shell metacharacters", () => {
  assert.deepEqual(
    larkSplitArgs('docs +create --title "军事理论 · 第 1 课" --folder fldcn1'),
    ["docs", "+create", "--title", "军事理论 · 第 1 课", "--folder", "fldcn1"],
  );
  // `&` and `;` are ordinary characters here: nothing downstream re-parses the string, so they must survive untouched.
  assert.deepEqual(larkSplitArgs("im +send --text 'a & b; c'"), ["im", "+send", "--text", "a & b; c"]);
});

test("an empty quoted argument is kept, because a flag may legitimately want emptiness", () => {
  assert.deepEqual(larkSplitArgs('docs +create --title "" --parent ""'), ["docs", "+create", "--title", "", "--parent", ""]);
});

test("runaway whitespace never produces phantom arguments", () => {
  assert.deepEqual(larkSplitArgs("   wiki   +space-list  "), ["wiki", "+space-list"]);
  assert.deepEqual(larkSplitArgs(""), []);
});

test("a command carrying --yes is refused until the caller confirms the danger", () => {
  assert.throws(
    () => larkAssertRunnable(["wiki", "+node-delete", "--node-token", "abc", "--yes"]),
    /confirmDanger/,
    "a deletion must not run just because the model typed --yes",
  );
  assert.deepEqual(
    larkAssertRunnable(["wiki", "+node-delete", "--node-token", "abc", "--yes"], { confirmDanger: true }),
    ["wiki", "+node-delete", "--node-token", "abc", "--yes"],
    "with the confirmation the argument is forwarded unchanged",
  );
});

test("interactive commands are refused instead of hanging until the timeout", () => {
  for (const command of ["auth login", "config init", "config remove", "auth logout"]) {
    assert.throws(() => larkAssertRunnable(larkSplitArgs(command)), /交互命令/, `${command} waits on a human`);
  }
});

test("a read-only command passes the guard untouched", () => {
  assert.deepEqual(larkAssertRunnable(larkSplitArgs("calendar +agenda --date today")), ["calendar", "+agenda", "--date", "today"]);
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
