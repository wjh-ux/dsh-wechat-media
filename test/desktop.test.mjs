/**
 * Desktop control: the scripts, the parser and the gate - without touching a real screen.
 *
 * Nothing here moves the pointer or presses a key. What it checks is the part that decides **what
 * would run**: the exact PowerShell a given call produces, that user text never reaches the command
 * line un-encoded, that a wrong argument is refused by name, and that a failure comes back as a
 * sentence with the reason rather than as a silent zero.
 *
 * Run: node test/desktop.test.mjs
 */
import assert from "node:assert/strict";

import {
  DESKTOP_TIMEOUT_MS,
  INPUT_SIZE,
  MOUSE_ACTIONS,
  coordinate,
  desktopKey,
  desktopMouse,
  desktopScreenshot,
  desktopSupport,
  desktopType,
  focusScript,
  keyScript,
  mouseScript,
  parseChord,
  parseDesktopOutput,
  psLiteral,
  runDesktopScript,
  screenScript,
  screenshotScript,
  typeScript,
  windowsScript,
} from "../desktop.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

console.log("desktop");

await test("support is Windows-only and says which platform refused", async () => {
  assert.deepEqual(desktopSupport({ platform: "win32" }), { ok: true, missing: [] });
  const linux = desktopSupport({ platform: "linux" });
  assert.equal(linux.ok, false);
  assert.match(linux.reason, /linux/, "the reason names the platform it found");
  assert.deepEqual(linux.missing, ["win32"]);
});

await test("every script makes the process DPI aware before measuring anything", async () => {
  // Logical vs physical pixels is the classic reason a click lands next to its target.
  for (const script of [screenScript(), windowsScript(), screenshotScript({ path: "x.png" }), mouseScript({ action: "move", x: 1, y: 2 })]) {
    assert.match(script, /SetProcessDPIAware/, "the script must claim DPI awareness");
  }
});

await test("every script writes UTF-8, or Chinese titles come back as mojibake", async () => {
  // Live: `powershell.exe -Command` wrote stdout in the console's ANSI codepage (CP936) and Node decoded
  // the pipe as UTF-8, so every Chinese window title arrived as `????` - and a title nobody can read is a
  // title nobody can click. The encoding must be set before the first write, so it leads the prelude.
  for (const script of [screenScript(), windowsScript(), focusScript({ title: "x" }), screenshotScript({ path: "x.png" }), mouseScript({ action: "move", x: 1, y: 2 }), typeScript({ text: "x" }), keyScript({ keys: "enter" })]) {
    assert.match(script, /\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/, "stdout must be UTF-8");
    assert.ok(script.indexOf("OutputEncoding") < script.indexOf("Add-Type"), "and set before anything is written");
  }
});

await test("the INPUT struct layout is the size SendInput validates", async () => {
  // A wrong layout makes SendInput return 0 without an error, which looks like "nothing happened".
  assert.equal(INPUT_SIZE.x64, 40);
  assert.equal(INPUT_SIZE.ia32, 28);
  // The script asks the C# for the real size, so the live run reports it rather than trusting us.
  assert.match(screenScript(), /StructSize\(\)/, "and the live script reports Marshal.SizeOf");
});

await test("the screen script emits one JSON object and reads the pointer", async () => {
  const script = screenScript();
  assert.match(script, /SystemInformation\]::VirtualScreen/);
  assert.match(script, /Cursor\]::Position/);
  assert.match(script, /ConvertTo-Json/);
  assert.match(script, /AllScreens/, "monitor count is part of the answer");
});

await test("the window list is capped, and never by an absurd number", async () => {
  assert.match(windowsScript({ limit: 5 }), /\[DshWindows\]::List\(5\)/);
  assert.match(windowsScript({ limit: 9999 }), /List\(200\)/, "capped at 200");
  assert.match(windowsScript({}), /List\(40\)/, "40 by default");
  assert.match(windowsScript({ limit: 0 }), /List\(40\)/, "zero means the default, not an empty list");
});

await test("a window title travels as base64, so it cannot become a command", async () => {
  const hostile = "'; Remove-Item -Recurse C:\\ ; '";
  const script = focusScript({ title: hostile });
  assert.doesNotMatch(script, /Remove-Item/, "the raw text must not appear in the script");
  assert.match(script, /FromBase64String\(/, "it is decoded by PowerShell instead");
  assert.equal(script.includes(Buffer.from(hostile, "utf8").toString("base64")), true, "and the payload is that text");
});

await test("a full-screen capture and a region capture ask for different rectangles", async () => {
  const full = screenshotScript({ path: "a.png" });
  assert.match(full, /VirtualScreen/, "full screen follows the virtual desktop, so it spans monitors");
  assert.doesNotMatch(full, /\$w = 800/, "and takes no fixed size");
  const region = screenshotScript({ path: "b.png", region: { x: 10, y: 20, width: 800, height: 600 } });
  assert.match(region, /\$x = 10; \$y = 20; \$w = 800; \$h = 600/);
  assert.doesNotMatch(region, /VirtualScreen/, "a region must not silently become the whole screen");
  assert.match(region, /Format\]::Png/);
});

await test("an impossible region or path is refused before anything runs", async () => {
  assert.throws(() => screenshotScript({ path: "" }), /需要一个保存路径/);
  assert.throws(() => screenshotScript({ path: "a.png", region: { x: 0, y: 0, width: 0, height: 10 } }), /宽高必须大于 0/);
  assert.throws(() => screenshotScript({ path: "a.png", region: { x: "left", y: 0, width: 10, height: 10 } }), /region\.x 必须是数字/);
});

await test("a click is exactly one button down and one up", async () => {
  const click = mouseScript({ action: "click", x: 100, y: 200 });
  assert.match(click, /SetCursorPos\(100, 200\)/);
  assert.equal((click.match(/mouse_event\(2, 0, 0, 0/g) ?? []).length, 1, "one left down");
  assert.equal((click.match(/mouse_event\(4, 0, 0, 0/g) ?? []).length, 1, "one left up");
  // Order matters: an up before a down would leave the button logically released.
  assert.ok(click.indexOf("mouse_event(2,") < click.indexOf("mouse_event(4,"));
});

await test("a double click presses twice, and the other buttons use their own flags", async () => {
  const double = mouseScript({ action: "double_click", x: 1, y: 1 });
  assert.equal((double.match(/mouse_event\(2, 0, 0, 0/g) ?? []).length, 2);
  const right = mouseScript({ action: "right_click", x: 1, y: 1 });
  assert.match(right, /mouse_event\(8, 0, 0, 0/);
  assert.match(right, /mouse_event\(16, 0, 0, 0/);
  const middle = mouseScript({ action: "middle_click", x: 1, y: 1 });
  assert.match(middle, /mouse_event\(32, 0, 0, 0/);
  assert.match(middle, /mouse_event\(64, 0, 0, 0/);
});

await test("a drag holds the button down across the whole move", async () => {
  const drag = mouseScript({ action: "drag", x: 0, y: 0, toX: 100, toY: 50, steps: 4 });
  assert.equal((drag.match(/mouse_event\(2, 0, 0, 0/g) ?? []).length, 1, "pressed once");
  assert.equal((drag.match(/mouse_event\(4, 0, 0, 0/g) ?? []).length, 1, "released once");
  const moves = [...drag.matchAll(/SetCursorPos\((\d+), (\d+)\)/g)].map((m) => `${m[1]},${m[2]}`);
  assert.deepEqual(moves, ["0,0", "25,13", "50,25", "75,38", "100,50"], "interpolated, ending exactly on the target");
  assert.ok(drag.indexOf("mouse_event(2,") < drag.indexOf("SetCursorPos(25, 13)"), "the press comes before the move");
  assert.ok(drag.lastIndexOf("mouse_event(4,") > drag.indexOf("SetCursorPos(100, 50)"), "the release comes after it");
});

await test("a scroll is wheel notches, not pixels, and needs no position", async () => {
  const up = mouseScript({ action: "scroll", amount: 3 });
  assert.match(up, /mouse_event\(2048, 0, 0, 360/);
  assert.doesNotMatch(up, /\[DshInput\]::SetCursorPos\(/, "without x/y the pointer is left where the user put it");
  const down = mouseScript({ action: "scroll", amount: -2, x: 5, y: 6 });
  assert.match(down, /mouse_event\(2048, 0, 0, -240/);
  assert.match(down, /SetCursorPos\(5, 6\)/);
  assert.throws(() => mouseScript({ action: "scroll", amount: 0 }), /非零的 amount/);
  assert.throws(() => mouseScript({ action: "scroll", amount: 21 }), /最多 20 格/);
});

await test("a bad action or coordinate is refused by name", async () => {
  assert.throws(() => mouseScript({ action: "teleport", x: 1, y: 1 }), /action 只能是/);
  assert.throws(() => mouseScript({ action: "click", y: 10 }), /x 必须是数字/);
  assert.throws(() => mouseScript({ action: "click", x: 1, y: 2.5e9 }), /超出合理范围/);
  assert.deepEqual(MOUSE_ACTIONS, ["move", "click", "double_click", "right_click", "middle_click", "drag", "scroll"]);
  assert.equal(coordinate("12.6", "x"), 13, "a numeric string is accepted and rounded");
});

await test("typed text is base64'd, capped, and never interpolated", async () => {
  const text = "中文 \"quotes\" 'single' ; Write-Host pwned";
  const script = typeScript({ text });
  assert.doesNotMatch(script, /pwned/, "the raw text is not in the script");
  assert.equal(script.includes(Buffer.from(text, "utf8").toString("base64")), true);
  assert.match(script, /TypeText\(\$text\)/, "and the C# types it as Unicode scan codes");
  assert.throws(() => typeScript({ text: "" }), /需要一个 text/);
  assert.throws(() => typeScript({ text: "x".repeat(2001) }), /最多输入 2000 个字符/);
});

await test("a chord becomes virtual key codes, modifiers first and released in reverse", async () => {
  assert.deepEqual(parseChord("ctrl+shift+s"), [0x11, 0x10, 0x53]);
  assert.deepEqual(parseChord("alt+1"), [0x12, 0x31]);
  assert.deepEqual(parseChord("win"), [0x5b], "a single key is a chord of one");
  assert.throws(() => parseChord("ctrl+nope"), /不认识的按键名："nope"/);
  assert.throws(() => parseChord(""), /需要一个 keys/);

  const script = keyScript({ keys: "up" });
  assert.match(script, /Key\(38, \$false, \$true\)/, "an arrow key is extended, or the app never sees it");
  const combo = keyScript({ keys: "ctrl+s" });
  const downs = [...combo.matchAll(/Key\((\d+), \$false/g)].map((m) => m[1]);
  const ups = [...combo.matchAll(/Key\((\d+), \$true/g)].map((m) => m[1]);
  assert.deepEqual(downs, ["17", "83"]);
  assert.deepEqual(ups, ["83", "17"], "released in reverse order, so ctrl is still held for the letter");
});

await test("the parser takes the last JSON line and turns a reported failure into an error", async () => {
  const noisy = "WARNING: something\r\n{\"ok\":true,\"count\":2}\r\n";
  assert.deepEqual(parseDesktopOutput(noisy), { ok: true, count: 2 });
  assert.deepEqual(parseDesktopOutput("\uFEFF{\"ok\":true}"), { ok: true }, "a BOM is tolerated");
  assert.throws(() => parseDesktopOutput('{"ok":false,"error":"没有交互式会话"}'), /没有交互式会话/);
  assert.throws(() => parseDesktopOutput("not json at all"), /无法解析/);
  assert.throws(() => parseDesktopOutput(""), /没有输出/);
});

await test("the executor is injectable, so the whole path can be driven without a mouse", async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, '{"ok":true,"action":"click","x":7,"y":8,"pointerX":7,"pointerY":8}', "");
  };
  // `platform: "win32"` is injected for the same reason `exec` is: this must pass on the Linux runner too,
  // where the real platform guard would stop the call before the fake executor ever ran.
  const result = await desktopMouse({ action: "click", x: 7, y: 8, exec: fakeExec, platform: "win32" });
  assert.equal(result.x, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
  assert.match(calls[0].args[4], /SetCursorPos\(7, 8\)/, "the script that ran is the one the builder produced");
  assert.equal(calls[0].options.timeout, DESKTOP_TIMEOUT_MS);
});

await test("a failing run surfaces the reason, not the whole command line", async () => {
  const fakeExec = (file, args, options, callback) => {
    const error = new Error("Command failed: powershell.exe -NoProfile ... (a very long command)");
    callback(error, "", "Add-Type : Cannot add type. The type name 'DshInput' already exists.\r\nAt line:1 char:1\r\n+ Add-Type ...\r\n");
  };
  await assert.rejects(
    () => desktopType({ text: "hi", exec: fakeExec, platform: "win32" }),
    (error) => {
      assert.match(error.message, /^Add-Type : Cannot add type/, "the message line wins, not the call stack");
      assert.ok(!error.message.includes("Command failed"), "the command itself is not echoed back");
      return true;
    },
  );
});

await test("a platform that cannot do this refuses before any script is built", async () => {
  // The guard has to fire *before* the executor is touched, or "unsupported here" would still spawn a
  // PowerShell that cannot exist.
  let touched = false;
  const fakeExec = () => {
    touched = true;
    assert.fail("nothing may be executed on a platform that cannot do this");
  };
  await assert.rejects(
    () => desktopMouse({ action: "move", x: 1, y: 2, exec: fakeExec, platform: "darwin" }),
    /darwin/,
  );
  assert.equal(touched, false, "and the executor was never called");
});

await test("psLiteral round-trips any text, including the characters that break quoting", async () => {
  for (const text of ["中文", "a'b\"c", "$env:PATH", "`backtick`", "line\nbreak", "😀 emoji"]) {
    const literal = psLiteral(text);
    const base64 = /FromBase64String\('([^']+)'\)/.exec(literal)[1];
    assert.equal(Buffer.from(base64, "base64").toString("utf8"), text, `round-trip failed for ${JSON.stringify(text)}`);
  }
});

await test("every public helper names the script it would run", async () => {
  // A light smoke test: each exported action reaches a builder, so none of them is a stub.
  const scripts = {
    screen: screenScript(),
    windows: windowsScript(),
    focus: focusScript({ title: "x" }),
    shot: screenshotScript({ path: "x.png" }),
    mouse: mouseScript({ action: "move", x: 1, y: 2 }),
    type: typeScript({ text: "x" }),
    key: keyScript({ keys: "enter" }),
  };
  for (const [name, script] of Object.entries(scripts)) {
    assert.match(script, /ConvertTo-Json/, `${name} must print JSON`);
    assert.match(script, /Add-Type|System\.Windows\.Forms|System\.Drawing/, `${name} must reach a real API`);
  }
  assert.equal(typeof desktopScreenshot, "function");
  assert.equal(typeof desktopKey, "function");
  assert.equal(typeof runDesktopScript, "function");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
