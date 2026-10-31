/**
 * Tests for the firmware planner: which build system a folder is, and the exact argv each downloader needs.
 *
 * Nothing here compiles or flashes: the planners return arrays and `runPlan` takes an injected `exec`, so the only thing
 * under test is the decision - which is where a wrong answer bricks a board ("flash the STM32 through UV4" on a machine
 * whose Keil has no ARM compiler, or `st-flash write` without a 0x8000000).
 *
 * Run: node test/firmware.test.mjs
 */
import assert from "node:assert/strict";

import {
  FLASHERS,
  OPENOCD_TARGETS,
  TOOLCHAINS,
  boardFromList,
  buildPlan,
  detectProject,
  findFirmware,
  flashPlan,
  fqbnFromSketchYaml,
  hexToBin,
  keilFamily,
  normalizeBuildPrefs,
  runPlan,
  tidyOutput,
  toolchainReport,
} from "../firmware.js";

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

function fakeDir(files) {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    readdir: (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

await test("the folder says what it is, and the evidence comes with the verdict", () => {
  const cases = [
    [{ "C:\\a": ["main.c", "blinky.uvprojx"] }, "keil", "blinky.uvprojx"],
    [{ "C:\\a": ["sdkconfig", "CMakeLists.txt", "main"] }, "idf", "sdkconfig"],
    [{ "C:\\a": ["CMakeLists.txt", "src"] }, "cmake", "CMakeLists.txt"],
    [{ "C:\\a": ["Makefile", "src"] }, "make", "Makefile"],
  ];
  for (const [files, kind, evidence] of cases) {
    const dir = Object.keys(files)[0];
    const found = detectProject({ dir, ...fakeDir(files) });
    assert.equal(found.kind, kind, `${dir} should be ${kind}`);
    assert.equal(found.evidence, evidence);
  }
  // An empty folder is unknown, and says so with the reason rather than throwing.
  const unknown = detectProject({ dir: "C:\\empty", ...fakeDir({ "C:\\empty": [] }) });
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.reason, /没有找到/);
  // A directory that does not exist is the same answer, not an exception: detection runs before every build.
  assert.equal(detectProject({ dir: "C:\\gone", ...fakeDir({}) }).kind, "unknown");
});

await test("an ESP-IDF project is not mistaken for a plain CMake one", () => {
  // Both have CMakeLists.txt; the sdkconfig (or main/) is what makes it IDF.
  const idf = detectProject({ dir: "C:\\p", ...fakeDir({ "C:\\p": ["CMakeLists.txt", "sdkconfig", "main"] }) });
  assert.equal(idf.kind, "idf");
  const cmake = detectProject({ dir: "C:\\p", ...fakeDir({ "C:\\p": ["CMakeLists.txt", "src"] }) });
  assert.equal(cmake.kind, "cmake");
});

await test("a Keil project's family decides which flash tool can even work", () => {
  assert.equal(keilFamily("<Vendor>STC</Vendor><Device>STC8H1K08 Series</Device>"), "c51");
  assert.equal(keilFamily("<Vendor>STMicroelectronics</Vendor><Device>STM32F103C8</Device>"), "arm");
  assert.equal(keilFamily("<Device>AT89C52</Device>"), "");
});

await test("every toolchain builds with the directory it was told to, not wherever the plugin happens to be", () => {
  assert.deepEqual(buildPlan({ kind: "keil", project: "C:\\w\\b.uvprojx", uv4: "UV4.exe" }).args, ["-b", "C:\\w\\b.uvprojx", "-j0"]);
  // A placeholder instead of a path is how the first version failed in 3 ms.
  assert.match(buildPlan({ kind: "keil", project: "C:\\w\\b.uvprojx" }).error, /UV4/);
  assert.deepEqual(buildPlan({ kind: "idf", dir: "C:\\w", idfPy: "idf.py" }).args, ["-C", "C:\\w", "build"]);
  assert.deepEqual(buildPlan({ kind: "cmake", dir: "C:\\w", cmake: "cmake.exe" }).args, ["--build", "C:\\w\\build"]);
  assert.match(buildPlan({ kind: "cmake", dir: "C:\\w" }).error, /cmake/);
  assert.deepEqual(buildPlan({ kind: "make", dir: "C:\\w", make: "make.exe" }).args, ["-C", "C:\\w", "-j"]);
  // A missing tool is an error string, not a spawn of "undefined".
  assert.match(buildPlan({ kind: "idf", dir: "C:\\w" }).error, /idf\.py/);
  assert.match(buildPlan({ kind: "unknown" }).error, /不知道/);
});

await test("auto follows the family: STC→stcgal, other Keil→UV4, ELF→openocd", () => {
  const stc = flashPlan({ kind: "keil", stc: true, file: "C:\\w\\o.hex", port: "COM3", chip: "stc8g" });
  assert.equal(stc.tool, "stcgal");
  assert.equal(stc.chip, "stc8g");

  const arm = flashPlan({ kind: "keil", project: "C:\\w\\m.uvprojx", uv4: "UV4.exe" });
  assert.equal(arm.tool, "UV4.exe", "the resolved path, not a placeholder");
  assert.deepEqual(arm.args, ["-f", "C:\\w\\m.uvprojx", "-j0"]);
  assert.match(flashPlan({ kind: "keil", project: "C:\\w\\m.uvprojx" }).error, /UV4/);

  const idf = flashPlan({ kind: "idf", idfPy: "idf.py", dir: "C:\\w", port: "COM3" });
  assert.deepEqual(idf.args, ["-C", "C:\\w", "-p", "COM3", "flash"]);

  const elf = flashPlan({ kind: "cmake", file: "C:\\w\\build\\app.elf", openocd: "openocd.exe", target: "stm32f4" });
  assert.equal(elf.tool, "openocd.exe");
  assert.deepEqual(elf.args, [
    "-f",
    "interface/stlink.cfg",
    "-f",
    OPENOCD_TARGETS.stm32f4,
    "-c",
    'program "C:\\w\\build\\app.elf" verify reset exit',
  ]);
  // Both spellings land on the same .cfg: people say `stm32f4x` because that is what the file is called.
  assert.equal(flashPlan({ kind: "cmake", file: "a.elf", openocd: "o", target: "stm32f4x" }).args[3], OPENOCD_TARGETS.stm32f4);
  // No openocd but st-flash present: the same intent, a different program.
  const st = flashPlan({ kind: "cmake", file: "C:\\w\\build\\app.bin", stflash: "st-flash.exe" });
  assert.equal(st.tool, "st-flash.exe");
  assert.deepEqual(st.args, ["write", "C:\\w\\build\\app.bin", "0x8000000"]);
});

await test("the choice is overridable, because detection is a default and not a verdict", () => {
  // Force uVision even for a CMake folder (someone may have a .uvprojx beside an IDF project).
  const forced = flashPlan({ kind: "cmake", flasher: "uv4", project: "C:\\w\\a.uvprojx", uv4: "UV4.exe" });
  assert.equal(forced.tool, "UV4.exe");
  // Force ESP-IDF esptool instead of idf.py.
  const esptool = flashPlan({ kind: "idf", flasher: "esptool", port: "COM7", file: "app.bin" });
  assert.deepEqual(esptool.args, ["-p", "COM7", "write_flash", "0x0", "app.bin"]);
  // And a downloader that is not installed says which package to install instead of failing at spawn time.
  assert.match(flashPlan({ kind: "cmake", file: "a.elf", openocd: "" }).error, /openocd/);
  assert.match(flashPlan({ kind: "keil", stc: true }).error, /hex/);
});

await test("a board with no debugger flashes over its own UART bootloader", () => {
  // This is the board that was actually verified: a C8T6 clone with no SWD debugger, wired PA9/PA10 to a CH340.
  const plan = flashPlan({ kind: "cmake", flasher: "uart", file: "build/app.bin", port: "COM3", python: "python.exe" });
  assert.deepEqual(plan.args, ["-m", "stm32loader", "-p", "COM3", "-b", "115200", "-f", "F1", "-e", "-w", "build/app.bin", "-v"]);
  // The three things it cannot do without, each with its own sentence.
  assert.match(flashPlan({ kind: "cmake", flasher: "uart", file: "a.bin", port: "COM3" }).error, /python/);
  assert.match(flashPlan({ kind: "cmake", flasher: "uart", port: "COM3", python: "p" }).error, /固件/);
  assert.match(flashPlan({ kind: "cmake", flasher: "uart", file: "a.bin", python: "p" }).error, /串口/);
});
await test("an Arduino sketch is a folder with a matching .ino, and the board is a separate question", () => {
  const dir = "C:\\work\\arduino-blink";
  const found = detectProject({ dir, ...fakeDir({ [dir]: ["arduino-blink.ino", "sketch.yaml"] }) });
  assert.equal(found.kind, "arduino");
  assert.equal(found.evidence, "arduino-blink.ino");
  assert.equal(found.folderMatch, true, "the name matches the folder, which is arduino-cli's rule");

  // arduino-cli's own project file is the first place the board can be stated.
  assert.equal(fqbnFromSketchYaml("default_fqbn: arduino:avr:uno\n"), "arduino:avr:uno");
  // A profiles block carries the fqbn too; one profile is the common case, and the choice is printed.
  assert.equal(fqbnFromSketchYaml('profiles:\n  fqbn: "esp32:esp32:esp32"\n'), "esp32:esp32:esp32");
  assert.equal(fqbnFromSketchYaml(""), "");

  // Building needs the board; a missing FQBN is a sentence, not a spawn of "undefined".
  const plan = buildPlan({ kind: "arduino", dir, arduinoCli: "arduino-cli.exe", fqbn: "arduino:avr:uno" });
  assert.deepEqual(plan.args, ["compile", "--fqbn", "arduino:avr:uno", dir]);
  assert.match(buildPlan({ kind: "arduino", dir, arduinoCli: "arduino-cli.exe" }).error, /板子型号/);
  assert.match(buildPlan({ kind: "arduino", dir, fqbn: "arduino:avr:uno" }).error, /arduino-cli/);

  // Uploading needs the port as well.
  const flash = flashPlan({ kind: "arduino", dir, arduinoCli: "arduino-cli.exe", fqbn: "arduino:avr:uno", port: "COM3" });
  // `compile --upload`, not a bare `upload`: the latter needs a sketch that was compiled first.
  assert.deepEqual(flash.args, ["compile", "--fqbn", "arduino:avr:uno", "--upload", "-p", "COM3", dir]);
  assert.match(flashPlan({ kind: "arduino", dir, arduinoCli: "a", fqbn: "arduino:avr:uno" }).error, /串口/);
  // auto: an arduino project goes to arduino-cli, not to openocd or uart.
  assert.equal(flashPlan({ kind: "arduino", dir, arduinoCli: "a", fqbn: "f", port: "COM3" }).tool, "a");
});

await test("the plugged-in board names itself when nobody else did", () => {
  const listed = JSON.stringify({
    detected_ports: [
      { port: { address: "COM3" }, matching_boards: [{ fqbn: "arduino:avr:uno", name: "Arduino Uno" }] },
      { port: { address: "COM7" }, matching_boards: [] },
    ],
  });
  assert.equal(boardFromList(listed, { port: "COM3" }), "arduino:avr:uno");
  assert.equal(boardFromList(listed), "arduino:avr:uno", "only one board was recognised, so it is unambiguous");
  // Two recognised boards and no port is a question, not a guess.
  const two = JSON.stringify({
    detected_ports: [
      { port: { address: "COM3" }, matching_boards: [{ fqbn: "arduino:avr:uno" }] },
      { port: { address: "COM7" }, matching_boards: [{ fqbn: "esp32:esp32:esp32" }] },
    ],
  });
  assert.equal(boardFromList(two), "");
  assert.equal(boardFromList(two, { port: "COM7" }), "esp32:esp32:esp32");
  assert.equal(boardFromList("not json"), "");
});
await test("a Keil hex becomes the binary the bootloader wants, and its size can be checked", () => {
  // Records at 0x08000000, which is exactly what stm32loader refuses (`assert addresses[0] == 0`).
  const hex = [
    ":020000040800F2",
    ":0400000001020304F2",
    ":0400040005060708DE",
    ":00000001FF",
  ].join("\n");
  const parsed = hexToBin(hex);
  assert.equal(parsed.base, 0x08000000);
  assert.equal(parsed.size, 8);
  assert.deepEqual([...parsed.bytes], [1, 2, 3, 4, 5, 6, 7, 8]);

  // A hex with no data records is an error, not an empty firmware.
  assert.match(hexToBin(":00000001FF").error, /没有任何数据/);
  // Garbage is refused rather than producing a half image.
  assert.match(hexToBin(":04000000ZZ010203F2").error, /非十六进制/);
});

await test("Keil output is found in Objects/, and a named flasher overrides UV4", () => {
  const dir = "C:\\work\\blink";
  // findFirmware walks with `withFileTypes`, so the fake readdir has to answer with Dirent-shaped entries.
  const tree = { [`${dir}\\Objects`]: ["blink.hex", "blink.axf", "blink.lnp"] };
  const found = findFirmware(dir, {
    exists: () => true,
    readdir: (path) => (tree[path] ?? []).map((name) => ({ name, isDirectory: () => false })),
    stat: () => ({ mtimeMs: 1 }),
  });
  assert.match(found, /Objects.blink\.hex$/, "the hex uVision produced, not a random file");

  // `flasher: "uart"` on a Keil project must build a stm32loader command, because that is the only way to program a
  // board with no debugger attached.
  const plan = flashPlan({ kind: "keil", flasher: "uart", dir, file: `${dir}\\Objects\\blink.hex`, port: "COM3", python: "python.exe" });
  assert.match(String(plan.tool), /python/, "the python interpreter that has stm32loader");
  assert.ok(plan.args.includes("stm32loader"));
  assert.ok(plan.args.includes(`${dir}\\Objects\\blink.hex`));
});
await test("the newest ELF is the one it picks, not the first one it sees", () => {
  const files = {
    "C:\\w\\build": [{ name: "app.elf", isDirectory: () => false }, { name: "boot.bin", isDirectory: () => false }],
  };
  const picked = findFirmware("C:\\w", {
    exists: () => true,
    readdir: (path) => files[path] ?? [],
    // The mtime is what decides: the newest artifact is the one this build produced.
    stat: (path) => ({ mtimeMs: path.endsWith("app.elf") ? 2000 : 1000 }),
  });
  assert.match(picked, /app\.elf$/);
  assert.equal(findFirmware("C:\\nothing", { exists: () => false, readdir: () => [] }), "");
});

await test("the machine is summarised honestly before anything is attempted", () => {
  const text = toolchainReport({ keilC51: true, keilArm: false, idfPy: "D:\\Espressif\\idf.py" });
  assert.match(text, /只有 C51/);
  assert.match(text, /idf\.py/);
  assert.match(text, /openocd 无/);
});

await test("a plan with no tool is reported, not spawned as undefined", async () => {
  const result = await runPlan({ error: "没有 openocd" }, { exec: () => { throw new Error("must not spawn"); } });
  assert.equal(result.ok, false);
  assert.equal(result.code, -1);
  assert.match(result.output, /没有 openocd/);
});

await test("runPlan hands back the output and the exit code the caller must judge", async () => {
  const seen = [];
  const exec = (program, args, options, callback) => {
    seen.push({ program, args });
    callback(null, "Build complete", "");
  };
  const ok = await runPlan({ tool: "cmake", args: ["--build", "build"] }, { exec, cwd: "C:\\w" });
  assert.equal(ok.ok, true);
  assert.match(ok.output, /Build complete/);
  assert.deepEqual(seen[0], { program: "cmake", args: ["--build", "build"] });

  // Exit 0 with nothing printed is a program that refused to start, not a build.
  const silent = await runPlan({ tool: "UV4.exe", args: ["-b", "x"] }, {
    exec: (program, args, options, callback) => callback(null, "", ""),
  });
  assert.equal(silent.ok, false);
  // A "successful" exit with `error:` in the output is how a CMake build that linked nothing still exits 0.
  const lying = await runPlan({ tool: "cmake", args: [] }, {
    exec: (program, args, options, callback) => callback(null, "undefined reference to `main'", ""),
  });
  assert.equal(lying.ok, false);
});

await test("the vocabularies are declared, so a typo is caught rather than passed through", () => {
  assert.deepEqual(TOOLCHAINS, ["keil", "idf", "arduino", "cmake", "make"]);
  assert.deepEqual(FLASHERS, ["uv4", "stcgal", "idf", "arduino", "openocd", "stflash", "esptool", "uart"]);
});

await test("the override is stored only when it is a real choice", () => {
  assert.deepEqual(normalizeBuildPrefs({}), { toolchain: "auto", flasher: "auto", dir: "" });
  assert.deepEqual(normalizeBuildPrefs({ toolchain: "IDF", flasher: "openocd", dir: "C:\\w\\" }), {
    toolchain: "idf",
    flasher: "openocd",
    dir: "C:\\w",
  });
  // A typo must not silently become "auto": `keil` is a choice, `keill` is a mistake and is dropped to auto.
  assert.equal(normalizeBuildPrefs({ toolchain: "keill", flasher: "stlink" }).toolchain, "auto");
  assert.equal(normalizeBuildPrefs({ flasher: "stlink" }).flasher, "auto");
});
await test("newlib's nosys noise is counted, not printed", () => {
  const noisy = [
    // The real output is a three-line group per stub: header, warning, note.
    "C:/tools/armgcc/bin/../arm-none-eabi/bin/ld.exe: C:/tools/libc_nano.a(libc_a-closer.o): in function `_close_r':",
    "closer.c:(.text._close_r+0xc): warning: _close is not implemented and will always fail",
    "... note: the message above does not take linker garbage collection into account",
    "   text\t   data\t    bss\t    dec\t    hex\tfilename",
    "    212\t      0\t      0\t    212\t     d4\tstm32_template.elf",
  ].join("\n");
  const tidy = tidyOutput(noisy);
  assert.equal(tidy.dropped, 3, "header + warning + note");
  assert.match(tidy.text, /text.*data.*bss/);
  assert.match(tidy.text, /212/);
  assert.ok(!/not implemented/.test(tidy.text), "the noise is gone");
  assert.ok(!/in function/.test(tidy.text), "and so is the orphaned header");

  // A real error survives, because it is not on the noise list.
  const failed = tidyOutput("Error: undefined reference to `main'\n_close is not implemented and will always fail");
  assert.match(failed.text, /undefined reference/);
  assert.equal(failed.dropped, 1);
  // arduino-cli colours its output; the escapes are noise in a chat bubble, not information.
  const coloured = tidyOutput("\u001b[92mUsed platform\u001b[0m  \u001b[93mesp32:esp32\u001b[0m 3.1.1");
  assert.equal(coloured.text, "Used platform  esp32:esp32 3.1.1");
  assert.ok(!/\u001b/.test(coloured.text), "no escape survives");
  // And an empty build prints nothing rather than a blank block.
  assert.equal(tidyOutput("").text, "");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
