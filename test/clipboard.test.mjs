/**
 * The clipboard module, without touching the real clipboard: the scripts are inspected as text, and the read/write
 * functions are driven with a fake `exec` that answers in the base64 protocol the real one uses.
 *
 * The protocol check matters: the first version emitted raw JSON and every Chinese character came back as a question
 * mark, because `powershell.exe` writes stdout in the console codepage. A test that only asserted "text round-trips"
 * with an ASCII string would have passed that version.
 */
import assert from "node:assert/strict";

const clipboard = await import("../clipboard.js");

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

/** A fake PowerShell launcher: answers with the base64 of whatever object the test wants, as the real scripts do. */
function fakeExec(answer, { stdoutLines = [] } = {}) {
  const calls = [];
  const exec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const payload = Buffer.from(JSON.stringify(answer), "utf8").toString("base64");
    const out = [...stdoutLines, payload].join("\r\n") + "\r\n";
    process.nextTick(() => callback(null, out, ""));
    return { stdin: { end() {} } };
  };
  exec.calls = calls;
  return exec;
}

await test("the platform decides how the clipboard is reached", () => {
  assert.deepEqual(clipboard.clipboardSupport({ platform: "win32" }), { ok: true, via: "powershell" });
  assert.deepEqual(clipboard.clipboardSupport({ platform: "darwin" }), { ok: true, via: "pbcopy" });
  assert.equal(clipboard.clipboardSupport({ platform: "linux" }).ok, true);
  const unsupported = clipboard.clipboardSupport({ platform: "aix" });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reason, /不支持这个平台/);
});

await test("the read script caps inside PowerShell, and emits base64", () => {
  const script = clipboard.clipboardReadScript({ maxChars: 5000 });
  assert.match(script, /if \(\$text\.Length -gt 5000\)/);
  assert.match(script, /ConvertTo-Json -Compress -Depth 4/);
  assert.match(script, /ToBase64String/, "stdout must be base64, or the console codepage mangles Chinese");
  assert.match(script, /ContainsFileDropList/, "the file list is part of the answer");
  // A cap larger than the ceiling is clamped rather than trusted.
  assert.match(clipboard.clipboardReadScript({ maxChars: 10_000_000 }), new RegExp(`-gt ${clipboard.CLIPBOARD_MAX_CHARS}`));
});

await test("the write script base64-encodes the text and quotes paths safely", () => {
  const textScript = clipboard.clipboardWriteScript({ text: "你好 'quoted' $var" });
  assert.match(textScript, /FromBase64String\('[A-Za-z0-9+/=]+'\)/, "text travels as base64, never as a quoted literal");
  assert.match(textScript, /Clipboard\]::SetText/);
  const fileScript = clipboard.clipboardWriteScript({ paths: ["C:\\a b\\it's.txt"] });
  assert.match(fileScript, /SetFileDropList/);
  assert.match(fileScript, /C:\\a b\\it''s\.txt/, "a single quote is doubled, not dropped");
  assert.throws(() => clipboard.clipboardWriteScript({ text: "", paths: [] }), /没有可写的内容/);
});

await test("files win when both text and paths are given", () => {
  const script = clipboard.clipboardWriteScript({ text: "ignored", paths: ["C:\\x.txt"] });
  assert.match(script, /SetFileDropList/);
  assert.doesNotMatch(script, /SetText/);
});

await test("readClipboard parses the base64 answer, including Chinese and files", async () => {
  const exec = fakeExec({ ok: true, chars: 12, truncated: false, text: "中文不能变问号", files: ["C:\\a.txt"] });
  const answer = await clipboard.readClipboard({ exec, platform: "win32" });
  assert.equal(answer.text, "中文不能变问号");
  assert.deepEqual(answer.files, ["C:\\a.txt"]);
  assert.equal(answer.truncated, false);
  assert.equal(answer.via, "powershell");
  assert.equal(exec.calls[0].command, "powershell.exe");
  assert.ok(exec.calls[0].args.includes("-STA"), "the WinForms clipboard needs an STA thread");
  assert.ok(exec.calls[0].args.includes("-NonInteractive"));
});

await test("readClipboard reports truncation and tolerates a script that wrote noise first", async () => {
  const exec = fakeExec({ ok: true, chars: 900, truncated: true, text: "abc", files: [] }, { stdoutLines: ["WARNING: something"] });
  const answer = await clipboard.readClipboard({ exec, platform: "win32" });
  assert.equal(answer.truncated, true);
  assert.equal(answer.chars, 900);
});

await test("writeClipboard returns what was written, and says which kind", async () => {
  const textAnswer = await clipboard.writeClipboard({ text: "hello", exec: fakeExec({ ok: true, kind: "text", chars: 5 }), platform: "win32" });
  assert.deepEqual(textAnswer, { kind: "text", chars: 5, count: 0, via: "powershell" });
  const fileAnswer = await clipboard.writeClipboard({ paths: ["C:\\x.txt"], exec: fakeExec({ ok: true, kind: "files", count: 1 }), platform: "win32" });
  assert.equal(fileAnswer.kind, "files");
  assert.equal(fileAnswer.count, 1);
});

await test("a non-Windows platform refuses the file list instead of pretending", async () => {
  await assert.rejects(() => clipboard.writeClipboard({ paths: ["/tmp/x"], platform: "linux" }), /只写文字/);
});

await test("a failing script surfaces its first stderr line", async () => {
  const exec = (command, args, options, callback) => {
    process.nextTick(() => callback(new Error("Command failed"), "", "The clipboard is being used by another process.\r\nat line:1"));
    return { stdin: { end() {} } };
  };
  await assert.rejects(() => clipboard.readClipboard({ exec, platform: "win32" }), /another process/);
});

await test("garbage on stdout is named, not guessed at", async () => {
  const exec = (command, args, options, callback) => {
    process.nextTick(() => callback(null, "not-base64-json\r\n", ""));
    return { stdin: { end() {} } };
  };
  await assert.rejects(() => clipboard.readClipboard({ exec, platform: "win32" }), /base64 JSON/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
