/**
 * Tests for the Keil uVision5 bridge - the part that can be wrong without anyone noticing until a build "succeeds"
 * and no .hex exists.
 *
 * Nothing here starts UV4 or needs Keil installed: the process runner is injected, the filesystem is a map, and the
 * log is a string. What is pinned is the part that actually decides the answer - which switch per action, how UV4's
 * log dialects map to `file(line): severity: message`, and that "warning-only" is a success while "Target not
 * created" is not, whatever the summary line claims.
 *
 * Run: node test/keil.test.mjs
 */
import assert from "node:assert/strict";

import {
  ACTIONS,
  KEIL_TIMEOUT_MS,
  UV4_EXIT,
  assertProject,
  buildArgs,
  defaultLogPath,
  findUv4,
  flashPlan,
  projectOutput,
  projectVendor,
  stcProtocolFor,
  flashProgrammed,
  formatDiagnostic,
  inspectProject,
  keilSupport,
  normalizeKeilPrefs,
  pickBoardPort,
  parseBuildLog,
  parseToolsIni,
  runUv4,
  summarizeBuild,
  tailLines,
  targetsFromProject,
} from "../keil.js";

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

/** A filesystem that answers with the map and a log reader that answers with the same map. */
function fakeFs(files) {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    readFile: (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

const TOOLS_INI = [
  "[UV2]",
  'ORGANIZATION="jh"',
  "[C51]",
  'PATH="D:\\Keil_v5\\C51\\"',
  "VERSION=V9.61",
].join("\r\n");

await test("TOOLS.INI is read per section, quotes and trailing slash included", () => {
  const sections = parseToolsIni(TOOLS_INI);
  assert.equal(sections.C51.PATH, "D:\\Keil_v5\\C51\\");
  assert.equal(sections.C51.VERSION, "V9.61");
  assert.equal(sections.UV2.ORGANIZATION, "jh");
  // A comment and a blank line are not keys - `;` lines appear in real installs.
  assert.deepEqual(parseToolsIni("; hello\n[C51]\n\n").C51, {});
});

await test("the pinned environment wins, because that is what it is for", () => {
  const fs = fakeFs({ "E:\\tools\\UV4\\UV4.exe": "" });
  const hit = findUv4({ env: { KEIL_UV4: "E:\\tools\\UV4\\UV4.exe" }, ...fs, platform: "win32" });
  assert.equal(hit.program, "E:\\tools\\UV4\\UV4.exe");
  assert.equal(hit.source, "KEIL_UV4");
  // A directory is accepted too - people paste the folder, not the exe.
  const dir = findUv4({ env: { UV4_PATH: "E:\\tools" }, ...fs, platform: "win32" });
  assert.equal(dir.program, "E:\\tools\\UV4\\UV4.exe");
  assert.equal(dir.root, "E:\\tools");
});

await test("TOOLS.INI beats the default paths, because the install says where it is", () => {
  const fs = fakeFs({
    "D:\\Keil_v5\\TOOLS.INI": TOOLS_INI,
    "D:\\Keil_v5\\UV4\\UV4.exe": "",
  });
  const hit = findUv4({ env: {}, ...fs, platform: "win32" });
  // The path joiner normalises `C51\..\UV4` on the way out; the exe that was probed is the one returned.
  assert.ok(hit, "expected a hit from TOOLS.INI");
  assert.match(hit.program, /UV4[\\/]UV4\.exe$/);
  assert.equal(hit.source, "TOOLS.INI [C51]");
});

await test("no Keil is null, and not an exception the caller has to catch", () => {
  const fs = fakeFs({});
  assert.equal(findUv4({ env: {}, ...fs, platform: "win32" }), null);
  // Not Windows: Keil ships only for Windows, so the answer is null rather than a search of every drive.
  assert.equal(findUv4({ env: {}, ...fs, platform: "linux" }), null);
  const support = keilSupport({ env: {}, ...fs, platform: "linux" });
  assert.equal(support.ok, false);
  assert.match(support.reason, /Windows/);
});

await test("targets come out of the project, so -t is not a guess", () => {
  const xml = `<?xml version="1.0"?><Project>
    <Targets><Target><TargetName>Target 1</TargetName></Target>
    <Target><TargetName>Release</TargetName></Target>
    <Target><TargetName>Target 1</TargetName></Target></Targets></Project>`;
  assert.deepEqual(targetsFromProject(xml), ["Target 1", "Release"]);
  assert.deepEqual(targetsFromProject(""), []);
});

await test("a project path is checked before any process starts", () => {
  const fs = fakeFs({ "C:\\work\\blinky.uvprojx": "<Project/>" });
  assert.equal(assertProject("C:\\work\\blinky.uvprojx", fs), "C:\\work\\blinky.uvprojx");
  // Quotes are stripped: Keil's own #P substitution can arrive quoted.
  assert.equal(assertProject('"C:\\work\\blinky.uvprojx"', fs), "C:\\work\\blinky.uvprojx");
  assert.throws(() => assertProject("C:\\work\\main.c", fs), /不是 uVision 工程文件/);
  assert.throws(() => assertProject("C:\\work\\gone.uvprojx", fs), /不存在/);
  assert.throws(() => assertProject("", fs), /需要工程路径/);
});

await test("each action is UV4's own switch, and -j0 stays last", () => {
  assert.deepEqual(buildArgs({ action: "build", project: "a.uvprojx" }), ["-b", "a.uvprojx", "-j0"]);
  assert.deepEqual(buildArgs({ action: "rebuild", project: "a.uvprojx" }), ["-r", "a.uvprojx", "-j0"]);
  assert.deepEqual(buildArgs({ action: "clean", project: "a.uvprojx" }), ["-c", "a.uvprojx", "-j0"]);
  assert.deepEqual(buildArgs({ action: "flash", project: "a.uvprojx" }), ["-f", "a.uvprojx", "-j0"]);
  assert.deepEqual(buildArgs({ action: "build", project: "a.uvprojx", target: "Release", log: "b.log" }), [
    "-b",
    "a.uvprojx",
    "-t",
    "Release",
    "-o",
    "b.log",
    "-j0",
  ]);
  // An unknown action is refused here rather than passed to UV4, which would exit 11 and look like a bad path.
  assert.throws(() => buildArgs({ action: "deploy", project: "a.uvprojx" }), /未知动作/);
  assert.deepEqual(Object.keys(ACTIONS).sort(), ["build", "clean", "flash", "rebuild"]);
});

const C51_LOG = [
  "Build target 'Target 1'",
  "compiling main.c...",
  ".\\main.c(12): warning C206: 'delay': missing function-prototype",
  ".\\main.c(31): error C141: syntax error near 'return', expected '} '",
  "compiling gpio.c...",
  "gpio.c(7): error C202: 'P1': undefined identifier",
  "Target not created.",
  "",
  'Program Size: data=9.0 xdata=0 code=132',
  '"Target 1" - 2 Error(s), 1 Warning(s).',
].join("\r\n");

await test("a C51 log becomes errors with file and line, and a failure is a failure", () => {
  const parsed = parseBuildLog(C51_LOG);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.target, "Target 1");
  assert.equal(parsed.notCreated, true);
  assert.equal(parsed.errorCount, 2);
  assert.equal(parsed.warningCount, 1);
  assert.equal(parsed.size, "data=9.0 xdata=0 code=132");
  assert.deepEqual(
    parsed.errors.map((e) => [e.file, e.line, e.code]),
    [
      [".\\main.c", 31, "C141"],
      ["gpio.c", 7, "C202"],
    ],
  );
  assert.equal(parsed.errors[0].severity, "error");
  assert.equal(parsed.warnings[0].code, "C206");
});

await test("the ARMCC6 dialect is read too - same uVision, different compiler", () => {
  const log = [
    "Build started: Project: blinky, Configuration: Debug",
    "../src/main.c:23:5: error: use of undeclared identifier 'led_on'",
    "../src/main.c:40:9: warning: unused variable 'i' [-Wunused-variable]",
    "Error: L6218E: Undefined symbol led_on (referred from main.o).",
    "\"blinky.axf\" - 1 Error(s), 1 Warning(s).",
  ].join("\n");
  const parsed = parseBuildLog(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].file, "../src/main.c");
  assert.equal(parsed.errors[0].line, 23);
  assert.equal(parsed.errors[0].column, 5);
  assert.match(parsed.errors[0].message, /undeclared identifier/);
  assert.equal(parsed.warnings.length, 1);
});

await test("a tool-level *** ERROR is an error even when the summary says zero", () => {
  // Real case: the compiler never starts, so no file/line exists, but the build did not happen.
  const log = ["*** ERROR: Could not open file '.\nObjects\main.o'", '"Target 1" - 0 Error(s), 0 Warning(s).'].join("\n");
  const parsed = parseBuildLog(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /Could not open file/);
  // The counts are reported as they were written, so a person can see the contradiction.
  assert.equal(parsed.errorCount, 0);
});

await test("warnings alone exit 1 and are still a successful build", () => {
  const log = [
    "Build target 'Target 1'",
    ".\\main.c(5): warning C206: 'x': missing function-prototype",
    "creating hex file from \".\\Objects\\blinky\"...",
    '"Target 1" - 0 Error(s), 1 Warning(s).',
  ].join("\n");
  const parsed = parseBuildLog(log);
  assert.equal(parsed.ok, true, "warning-only must not be reported as a failure");
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.hex, ".\\Objects\\blinky");
});

await test("clean output has no summary and is not a failure", () => {
  const parsed = parseBuildLog("Build target 'Target 1'\n.\nObjects\\.\\blinky.hex - 0 Error(s), 0 Warning(s).");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parseBuildLog("").ok, true);
});

await test("a diagnostic prints the way a compiler prints it", () => {
  const parsed = parseBuildLog(C51_LOG);
  assert.equal(formatDiagnostic(parsed.errors[0]), ".\\main.c(31): error C141: syntax error near 'return', expected '} '");
  assert.equal(
    formatDiagnostic({ file: "", line: 0, severity: "error", code: "", message: "工具链不在 PATH 里" }),
    "error: 工具链不在 PATH 里",
  );
});

await test("UV4 is run with the log file, and the log is what gets parsed", async () => {
  const calls = [];
  const exec = (program, args, options, callback) => {
    calls.push({ program, args, options });
    callback(null, "", "");
  };
  const result = await runUv4({
    uv4: "D:\\Keil_v5\\UV4\\UV4.exe",
    project: "C:\\work\\blinky.uvprojx",
    action: "build",
    logPath: "",
    exec,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, "D:\\Keil_v5\\UV4\\UV4.exe");
  assert.deepEqual(calls[0].args, ["-b", "C:\\work\\blinky.uvprojx", "-j0"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, KEIL_TIMEOUT_MS);
  assert.equal(result.code, 0);
  assert.equal(result.parsed.ok, true);
  assert.equal(result.program, "D:\\Keil_v5\\UV4\\UV4.exe");
});

await test("an exec error carries UV4's exit code, not Node's string", async () => {
  const exec = (program, args, options, callback) => {
    const error = new Error("exit 2");
    error.code = 2;
    callback(error, "", "");
  };
  const result = await runUv4({ uv4: "UV4.exe", project: "a.uvprojx", exec, logPath: "" });
  assert.equal(result.code, 2);
  assert.equal(UV4_EXIT[2], "有错误");
});

await test("the answer names the file and the line, then the size", () => {
  const text = summarizeBuild(
    { code: 2, ms: 1234, log: C51_LOG, parsed: parseBuildLog(C51_LOG) },
    { project: "C:\\work\\blinky.uvprojx", action: "build" },
  );
  assert.match(text, /❌ 编译失败/);
  assert.match(text, /\.\\main\.c\(31\): error C141/);
  assert.match(text, /程序大小：data=9\.0/);
  assert.match(text, /Target not created/);
  assert.match(text, /C:\\work\\blinky\.uvprojx/);
});

await test("the log lands in .dsh-logs, named by action - not scattered among the sources", () => {
  // `Objects\` belongs to Keil and the folder next to main.c belongs to the person; a tool's own log is neither.
  assert.equal(defaultLogPath("C:\\work\\blinky.uvprojx", "build"), "C:\\work\\.dsh-logs\\blinky.build.log");
  assert.equal(defaultLogPath("C:\\work\\blinky.uvproj", "flash"), "C:\\work\\.dsh-logs\\blinky.flash.log");
  assert.equal(defaultLogPath("C:\\a b\\c.d\\proj.uvprojx", "rebuild"), "C:\\a b\\c.d\\.dsh-logs\\proj.rebuild.log");
  assert.equal(tailLines("a\n\nb\nc\n", 2), "b\nc");
});

await test("inspectProject answers the two questions /keil needs: which targets, which folder", () => {
  const fs = fakeFs({
    "C:\\work\\blinky.uvprojx": "<Targets><Target><TargetName>Debug</TargetName></Target></Targets>",
  });
  const info = inspectProject("C:\\work\\blinky.uvprojx", fs);
  assert.equal(info.dir, "C:\\work");
  assert.deepEqual(info.targets, ["Debug"]);
});

await test("the prefs block is the same shape /keil writes, and only an explicit true arms it", () => {
  assert.deepEqual(normalizeKeilPrefs(), { enabled: false, project: "", target: "" });
  assert.deepEqual(normalizeKeilPrefs({ enabled: "true", project: "  C:\\a.uvprojx  " }), {
    enabled: false,
    project: "C:\\a.uvprojx",
    target: "",
  });
  assert.deepEqual(normalizeKeilPrefs({ enabled: true, project: "C:\\a.uvprojx", target: "Debug" }), {
    enabled: true,
    project: "C:\\a.uvprojx",
    target: "Debug",
  });
  // A folder without a project is dropped, so a stale one cannot outlive the project it described.
  assert.equal(normalizeKeilPrefs({ project: "", dir: "C:\\work" }).dir, undefined);
  assert.equal(normalizeKeilPrefs({ project: "C:\\a.uvprojx", dir: "C:\\work" }).dir, "C:\\work");
});

await test("an STC project is not a UV4 download, and the plan says so before a port is opened", () => {
  const stcXml = `<Project><Targets><Target><TargetName>Target 1</TargetName><TargetOption>
    <TargetCommonOption><Device>STC8H1K08 Series</Device><Vendor>STC</Vendor>
    <OutputName>DS18B20_TM1650</OutputName><OutputDirectory>.\\Objects\\</OutputDirectory></TargetCommonOption>
    </TargetOption></Target></Targets></Project>`;
  assert.equal(projectVendor(stcXml), "STC");
  assert.deepEqual(projectOutput(stcXml), { name: "DS18B20_TM1650", dir: "Objects" });
  assert.equal(stcProtocolFor("STC8H1K08 Series"), "stc8g");
  assert.equal(stcProtocolFor("STC15F104W"), "stc15");
  assert.equal(stcProtocolFor("STC89C52RC"), "stc89");
  assert.equal(stcProtocolFor("STM32F103"), "");

  const hex = "C:\\work\\ds\\Objects\\DS18B20_TM1650.hex";
  const plan = flashPlan({ project: "C:\\work\\ds\\DS18B20_TM1650.uvproj", xml: stcXml, exists: (path) => path === hex });
  assert.equal(plan.via, "stcgal");
  assert.equal(plan.hex, hex);
  assert.equal(plan.chip, "stc8g");
  assert.equal(plan.device, "STC8H1K08 Series");

  // A hex that is not there yet is named, not silently flashed as nothing.
  const missing = flashPlan({ project: "C:\\work\\ds\\p.uvproj", xml: stcXml, exists: () => false });
  assert.equal(missing.hex, "");
  assert.ok(missing.candidates.length >= 2, "it says which paths it looked at");

  // Anything that is not an STC part keeps the uVision path.
  const arm = flashPlan({ project: "C:\\work\\m.uvprojx", xml: "<Device>STM32F407VG</Device><Vendor>STMicroelectronics</Vendor>" });
  assert.equal(arm.via, "uv4");
});
await test("the board is the USB port, not the Bluetooth modem next to it", () => {
  // The real machine: COM4/COM5 are "蓝牙链接上的标准串行", COM3 is the CH340 the board is on.
  const ports = [
    { port: "COM4", name: "蓝牙链接上的标准串行 (COM4)" },
    { port: "COM5", name: "蓝牙链接上的标准串行 (COM5)" },
    { port: "COM3", name: "USB-SERIAL CH340 (COM3)" },
  ];
  const picked = pickBoardPort(ports);
  assert.equal(picked?.port, "COM3");
  assert.match(picked.name, /CH340/);

  // Two USB candidates is still ambiguous: asking beats flashing the wrong one.
  assert.equal(pickBoardPort([...ports, { port: "COM6", name: "Silicon Labs CP210x (COM6)" }]), null);
  // Nothing that looks like a bridge: fall back to the existing "tell me which" behaviour.
  assert.equal(pickBoardPort([{ port: "COM4", name: "蓝牙链接上的标准串行" }]), null);
  assert.equal(pickBoardPort([]), null);
});
await test("a flash that wrote nothing is not a flash, whatever the exit code said", () => {
  // The real case: UV4 -f on an STC project with no download driver exited 0 in 1.4s with a 0-byte log, and the first
  // version of this tool printed "下载到芯片完成" for it. Nothing had touched the chip.
  assert.equal(flashProgrammed(""), false);
  assert.equal(flashProgrammed("   \r\n  "), false);
  assert.equal(flashProgrammed("Build target 'Target 1'\n0 Error(s), 0 Warning(s)."), false);
  // ARM/Keil download logs that really wrote something.
  assert.equal(flashProgrammed("Erase Done.\nProgramming Done.\nVerify OK.\nApplication running ..."), true);
  assert.equal(flashProgrammed('Flash Load finished at 19:16:22'), true);
  // ... and the failures that also mention programming.
  assert.equal(flashProgrammed("Programming Flash...\n*** Flash Download failed - Target DLL has been cancelled"), false);
  assert.equal(flashProgrammed("No ULINK Device found"), false);
});

await test("the answer says UV4 did not flash, and points at the tool that can", () => {
  const text = summarizeBuild(
    { code: 0, ms: 1400, log: "", parsed: parseBuildLog("") },
    { project: "C:\\work\\stc.uvproj", action: "flash" },
  );
  assert.match(text, /UV4 没有写芯片/);
  assert.match(text, /没有配置下载驱动/);
  assert.match(text, /stcgal/);
});

await test("a real download log still reads as success", () => {
  const log = "Erase Done.\nProgramming Done.\nVerify OK.\nApplication running ...";
  const text = summarizeBuild({ code: 0, ms: 2000, log, parsed: parseBuildLog(log) }, { action: "flash" });
  assert.match(text, /下载到芯片完成/);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
