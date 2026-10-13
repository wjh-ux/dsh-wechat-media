/**
 * Offline tests for the pure policies behind remote approval and the contact
 * allowlist, plus the reply chunker.
 *
 * Run: node test/policy.test.mjs
 */
import assert from "node:assert/strict";

import { allowDecision, chunkText, formatApprovalPrompt, parseApprovalReply } from "../index.js";

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

console.log("policies");

test("an open bridge accepts everyone", () => {
  assert.deepEqual(allowDecision({ peer: undefined, prefs: { requireAllowlist: false } }), { accepted: true, reason: "open" });
  assert.equal(allowDecision({}).accepted, true);
});

test("with the allowlist on, only explicitly allowed chats pass", () => {
  const prefs = { requireAllowlist: true };
  assert.deepEqual(allowDecision({ peer: { allowed: true }, prefs }), { accepted: true, reason: "allowlisted" });
  assert.equal(allowDecision({ peer: { allowed: false }, prefs }).reason, "blocked");
  assert.equal(allowDecision({ peer: { name: "someone" }, prefs }).reason, "not-listed");
  assert.equal(allowDecision({ peer: undefined, prefs }).reason, "not-listed");
  // A null decision means "the user has not decided yet".
  assert.equal(allowDecision({ peer: { allowed: null }, prefs }).reason, "not-listed");
});

test("numbered and worded approvals are recognised", () => {
  for (const yes of ["1", " y ", "Y", "yes", "OK", "approve", "/approve", "allow", "同意", "批准", "可以", "好的"]) {
    assert.equal(parseApprovalReply(yes), "allowed-once", `"${yes}" should approve`);
  }
  for (const no of ["2", "n", "NO", "nope", "deny", "reject", "/reject", "拒绝", "不同意", "不行", "cancel"]) {
    assert.equal(parseApprovalReply(no), "rejected", `"${no}" should reject`);
  }
});

test("ordinary messages are not mistaken for approval answers", () => {
  for (const text of ["", "   ", "你好", "help me 1 day", "12345", "2 个文件", "yes please do it"]) {
    const parsed = parseApprovalReply(text);
    assert.ok(parsed === undefined, `"${text}" must stay an ordinary message (got ${parsed})`);
  }
});

test("long replies are chunked under the platform limit", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("hi"), ["hi"]);
  const long = "段落一。".repeat(800);
  const chunks = chunkText(long, 2000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 2000, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join(""), long.replace(/\s+/g, "") === long ? chunks.join("") : chunks.join(""));
});

test("chunking prefers paragraph boundaries", () => {
  const text = `${"a".repeat(1200)}\n\n${"b".repeat(1200)}`;
  const chunks = chunkText(text, 2000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith("a"));
  assert.ok(chunks[1].startsWith("b"));
});

test("an approval prompt names the tool and shows what it will do", () => {
  const prompt = formatApprovalPrompt({
    toolName: "pwsh",
    reason: "command outside the workspace",
    arguments: { command: "Get-Content C:\\Windows\\win.ini", timeoutMs: 5000 },
  });
  assert.match(prompt, /pwsh/);
  assert.match(prompt, /command outside the workspace/);
  assert.match(prompt, /win\.ini/, "the arguments must be visible before deciding");
  assert.match(prompt, /回 1 = 批准一次 · 回 2 = 拒绝/);
});

test("an approval prompt without arguments stays short and honest", () => {
  const prompt = formatApprovalPrompt({ toolName: "read_file" });
  assert.match(prompt, /read_file/);
  assert.ok(!prompt.includes("参数："), "no empty argument block");
  assert.ok(prompt.length < 200, `prompt should stay short, got ${prompt.length}`);
  assert.ok(!formatApprovalPrompt({ toolName: "x", arguments: {} }).includes("参数："));
});

test("a huge argument blob is truncated before it reaches WeChat", () => {
  const prompt = formatApprovalPrompt({ toolName: "write_file", arguments: { content: "x".repeat(5000) } });
  assert.match(prompt, /已截断/);
  assert.ok(prompt.length < 700, `prompt should be truncated, got ${prompt.length}`);
  // A string argument is shown as-is, not JSON-quoted.
  const raw = formatApprovalPrompt({ toolName: "t", arguments: "rm -rf /tmp/x" });
  assert.match(raw, /rm -rf \/tmp\/x/);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
