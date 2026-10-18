import assert from "node:assert/strict";
import { hasModelBlock, insertModelBlock, isSelection, modelBlock, pickSelection, selectionOf } from "../modelguard.js";

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).split("\n")[0]}`);
  }
};

await test("a selection is a provider and a model, nothing more", () => {
  assert.equal(isSelection({ provider: "deepseek-account", model: "deepseek-flash" }), true);
  assert.equal(isSelection({ provider: "  ", model: "deepseek-flash" }), false, "a blank provider is not a selection");
  assert.equal(isSelection({ provider: "x" }), false, "a model is required");
  assert.equal(isSelection(null), false);
  assert.deepEqual(selectionOf({ provider: " p ", model: " m ", reasoningEffort: "high" }), { provider: "p", model: "m", reasoningEffort: "high" });
  assert.deepEqual(selectionOf({ provider: "p", model: "m", reasoningEffort: "" }), { provider: "p", model: "m" }, "an empty effort is dropped");
  assert.equal(selectionOf({ provider: "p" }), null);
});

await test("what the host offers wins, what last worked is the fallback, none means none", () => {
  const live = pickSelection({ provider: "a", model: "b" }, { provider: "c", model: "d" });
  assert.deepEqual(live, { selection: { provider: "a", model: "b" }, source: "current" });
  const remembered = pickSelection(undefined, { provider: "c", model: "d" });
  assert.deepEqual(remembered, { selection: { provider: "c", model: "d" }, source: "remembered" },
    "this is the whole point: the block can be gone and chats still work");
  assert.deepEqual(pickSelection(null, null), { selection: null, source: "none" });
  assert.deepEqual(pickSelection({ provider: "" }, null), { selection: null, source: "none" }, "a broken offer is not a selection");
});

await test("the block is recognised by id, whatever the formatting", () => {
  assert.equal(hasModelBlock("- id: agent-default-model\n  name: x"), true);
  assert.equal(hasModelBlock('- id: "agent-default-model"'), true, "quotes are allowed");
  assert.equal(hasModelBlock('  - id: agent-default-model'), false,
    "an indented entry is nested inside another one, not the top-level block");
  assert.equal(hasModelBlock("- id: agent-default-model-extra"), false, "a longer id is a different entry");
  assert.equal(hasModelBlock("# - id: agent-default-model"), false, "a comment is not an entry");
  assert.equal(hasModelBlock("- id: ui-chat"), false);
  assert.equal(hasModelBlock(""), false);
});

await test("a generated block is valid YAML and refuses half a selection", () => {
  const block = modelBlock({ provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" });
  assert.match(block, /^- id: agent-default-model$/m);
  assert.match(block, /^ {2}name: "@deepseek-ai\/dsh-agent-default-model"$/m);
  assert.match(block, /^ {4}provider: deepseek-account$/m);
  assert.match(block, /^ {4}model: deepseek-flash$/m);
  assert.match(block, /^ {4}reasoningEffort: high$/m);
  assert.ok(hasModelBlock(block), "and it is recognised as the block it is");
  assert.throws(() => modelBlock({ provider: "deepseek-account" }), /needs a provider and a model/);
});

await test("inserting keeps the file's other entries and never duplicates the block", () => {
  const file = "# header\n- id: ui-chat\n  name: x\n  config:\n    a: 1\n";
  const out = insertModelBlock(file, { provider: "deepseek-account", model: "deepseek-flash" });
  assert.ok(out.startsWith("# header\n- id: agent-default-model"), "the block goes first, after the comments");
  assert.match(out, /- id: ui-chat/, "the existing entry survives");
  assert.equal(out.indexOf("agent-default-model") < out.indexOf("ui-chat"), true, "order is block first");
  const again = insertModelBlock(out, { provider: "p", model: "m" });
  assert.equal(again, out, "inserting twice is a no-op");
  // A file that was truncated to an empty array still gets a usable array.
  const empty = insertModelBlock("[]\n", { provider: "p", model: "m" });
  assert.match(empty, /^- id: agent-default-model$/m);
  assert.doesNotMatch(empty, /^\[\]$/m, "the bare [] is gone, or the file would not be an array of entries");
  const blank = insertModelBlock("", { provider: "p", model: "m" });
  assert.match(blank, /^# Your patch layer/m, "an empty file gets the usual header");
  assert.ok(hasModelBlock(blank));
});

await test("a byte-order mark is dropped, because PowerShell puts one there and YAML may choke", () => {
  const withBom = `\uFEFF# header\n- id: ui-chat\n  name: x\n`;
  const out = insertModelBlock(withBom, { provider: "p", model: "m" });
  assert.equal(out.startsWith("\uFEFF"), false, "the mark is gone");
  assert.match(out, /^# header$/m, "the comment survived");
  assert.ok(hasModelBlock(withBom) === false, "and a file that only has the other entries is still detected as missing it");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
