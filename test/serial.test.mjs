/**
 * Tests for the serial/flashing module: discovery driven with a fake filesystem, the argv builders compared against what
 * each tool actually expects, the port parser fed the base64 the real script prints, and the flasher selection including
 * the STC route (stcgal), which is what makes this useful on the CH340/STC8 board that was actually plugged in.
 */
import assert from "node:assert/strict";

const serial = await import("../serial.js");

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

function fakeFs({ files = [], dirs = {} } = {}) {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path) || Object.prototype.hasOwnProperty.call(dirs, path),
    readdir: (path) => dirs[path] ?? [],
  };
}

await test("ESP-IDF is found in the Windows layout, newest version first", () => {
  const fs = fakeFs({
    dirs: {
      "D:\\Espressif\\frameworks": ["esp-idf-v4.4.8", "esp-idf-v5.1.2"],
      "D:\\Espressif\\python_env": ["idf5.1_py3.11_env"],
    },
    files: [
      "D:\\Espressif\\frameworks\\esp-idf-v4.4.8\\tools\\idf.py",
      "D:\\Espressif\\frameworks\\esp-idf-v5.1.2\\tools\\idf.py",
      "D:\\Espressif\\python_env\\idf5.1_py3.11_env\\Scripts\\python.exe",
    ],
  });
  const found = serial.findEspIdf({ env: {}, exists: fs.exists, readdir: fs.readdir });
  assert.match(found.framework, /esp-idf-v5\.1\.2$/, "the numeric version decides, not the string order");
  assert.equal(found.python, "D:\\Espressif\\python_env\\idf5.1_py3.11_env\\Scripts\\python.exe");
});

await test("stcgal is found in any python env, not just the newest one", () => {
  // Measured: stcgal had been pip-installed into py3.11 while the newest env by name was py3.8 - picking one env and
  // giving up reported "no stcgal" on a machine that had it.
  const fs = fakeFs({
    dirs: {
      "D:\\Espressif\\frameworks": ["esp-idf-v4.4.8"],
      "D:\\Espressif\\python_env": ["idf4.4_py3.8_env", "idf4.4_py3.11_env"],
    },
    files: [
      "D:\\Espressif\\frameworks\\esp-idf-v4.4.8\\tools\\idf.py",
      "D:\\Espressif\\python_env\\idf4.4_py3.8_env\\Scripts\\python.exe",
      "D:\\Espressif\\python_env\\idf4.4_py3.11_env\\Scripts\\python.exe",
      "D:\\Espressif\\python_env\\idf4.4_py3.11_env\\Scripts\\stcgal.exe",
    ],
  });
  const found = serial.findStcgal({ env: {}, exists: fs.exists, readdir: fs.readdir });
  assert.ok(found, "stcgal must be found in the env that has it");
  assert.match(found.program, /py3\.11_env\\Scripts\\stcgal\.exe$/);
});

await test("a machine with no toolchain at all says so", () => {
  const fs = fakeFs({});
  const support = serial.serialSupport({ env: { PATH: "C:\\Windows" }, platform: "win32", exists: fs.exists });
  assert.equal(support.ok, false);
  assert.match(support.reason, /stcgal|avrdude|ESP-IDF/);
  assert.match(serial.serialSupport({ platform: "linux" }).reason, /只在 Windows/);
});

await test("the port list is parsed from base64, and a port is never guessed", () => {
  const payload = { ok: true, ports: [{ port: "COM3", name: "USB-SERIAL CH340" }] };
  const stdout = "noise\r\n" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\r\n";
  assert.deepEqual(serial.parsePortsOutput(stdout), [{ port: "COM3", name: "USB-SERIAL CH340" }]);
  assert.throws(() => serial.parsePortsOutput("not json"), /base64 JSON/);
  assert.equal(serial.resolvePort("", [{ port: "COM3" }]), "COM3");
  assert.throws(() => serial.resolvePort("", [{ port: "COM3" }, { port: "COM7" }]), /请指定/);
  assert.throws(() => serial.resolvePort("", []), /没有找到任何串口/);
  assert.throws(() => serial.resolvePort("COM9", [{ port: "COM3" }]), /没有这个串口/);
});

await test("each flasher gets the arguments it actually expects", () => {
  assert.deepEqual(serial.buildIdfArgs({ port: "COM3", baud: 460800 }), ["-p", "COM3", "-b", "460800", "flash"]);
  assert.deepEqual(serial.buildEsptoolArgs({ port: "COM3", file: "app.bin", offset: "0x10000" }), [
    "-p", "COM3", "write_flash", "0x10000", "app.bin",
  ]);
  assert.deepEqual(serial.buildAvrdudeArgs({ port: "COM4", file: "main.hex" })[0], "-c");
  // stcgal: protocol, port, DTR reset, then the image. The DTR reset is what avoids the "pull the plug" dance.
  assert.deepEqual(serial.buildStcgalArgs({ port: "COM3", file: "app.hex" }), ["-P", "auto", "-p", "COM3", "-A", "dtr", "app.hex"]);
  assert.deepEqual(serial.buildStcgalArgs({ port: "COM3", protocol: "stc8g", file: "app.hex" }).slice(0, 2), ["-P", "stc8g"]);
  assert.deepEqual(serial.buildStcgalArgs({ port: "COM3", eject: true }), ["-P", "auto", "-p", "COM3", "-A", "dtr", "-e"]);
  assert.throws(() => serial.buildStcgalArgs({ port: "COM3" }), /需要 file/);
});

await test("the serial prefs block is validated, never trusted", () => {
  assert.deepEqual(serial.normalizeSerialPrefs({ enabled: true, baud: 115200, port: "com3" }), { enabled: true, baud: 115200, port: "COM3" });
  // Only the literal true arms flashing; a string must not.
  assert.equal(serial.normalizeSerialPrefs({ enabled: "true" }).enabled, false);
  // An absurd baud is dropped rather than stored, and a non-COM port is refused.
  assert.equal(serial.normalizeSerialPrefs({ baud: 999 }).baud, undefined);
  assert.throws(() => serial.normalizeSerialPrefs({ port: "/dev/ttyUSB0" }), /端口名不像话/);
});

await test("auto prefers idf.py on an ESP-IDF machine and runs it through export.ps1", async () => {
  const support = {
    ok: true,
    idf: { framework: "D:\\Espressif\\frameworks\\esp-idf-v5.1.2", idfPy: "D:\\Espressif\\frameworks\\esp-idf-v5.1.2\\tools\\idf.py", python: "D:\\p\\python.exe" },
    esptool: { python: "D:\\p\\python.exe", args: ["-m", "esptool"] },
    avrdude: "",
    stcgal: null,
  };
  const calls = [];
  const exec = (program, args, options, callback) => {
    calls.push({ program, args, options });
    process.nextTick(() => callback(null, "Hash of data verified.\n", ""));
    return {};
  };
  const result = await serial.flashFirmware({ support, port: "COM3", exec });
  assert.equal(result.tool, "idf");
  assert.equal(calls[0].program, "powershell.exe", "idf.py needs the export script, so it runs inside PowerShell");
  const command = calls[0].args.at(-1);
  assert.match(command, /export\.ps1/, "the export script is what puts cmake and the toolchain on PATH");
  assert.match(command, /idf\.py/);
  assert.equal(calls[0].options.env.IDF_PATH, support.idf.framework);
});

await test("idf.py is told which project: -C, or the flash happens in the wrong directory", () => {
  // This was a real bug: the tool documented and passed projectDir, flashFirmware dropped it, and idf.py then ran in the
  // plugin's own cwd - which is how "flash the folder I have open" becomes "flash nothing".
  const args = serial.buildIdfArgs({ port: "COM5", projectDir: "E:\\proj\\hello" });
  assert.deepEqual(args.slice(0, 2), ["-C", "E:\\proj\\hello"]);
  assert.ok(args.includes("flash"));
  assert.deepEqual(serial.buildIdfArgs({ port: "COM5" }), ["-p", "COM5", "flash"], "without a project it stays out");
  assert.deepEqual(
    serial.buildIdfArgs({ port: "COM5", projectDir: "p", target: "esp32s3", baud: 460800 }),
    ["-C", "p", "-DIDF_TARGET=esp32s3", "-p", "COM5", "-b", "460800", "flash"],
  );
});

await test("an STC board goes through stcgal, with DTR reset and the protocol passed as chip", async () => {
  const calls = [];
  const exec = (program, args, options, callback) => {
    calls.push({ program, args, options });
    process.nextTick(() => callback(null, "Protocol detected: stc8g\nTarget model: STC8H1K08\n", ""));
    return {};
  };
  const support = {
    ok: true,
    idf: null,
    esptool: null,
    avrdude: "",
    stcgal: { program: "D:\\Espressif\\python_env\\idf4.4_py3.11_env\\Scripts\\stcgal.exe", args: [] },
  };
  const result = await serial.flashFirmware({ support, flasher: "stcgal", port: "COM3", file: "app.hex",
      exists: () => true, chip: "stc8g", exec });
  assert.equal(result.tool, "stcgal");
  assert.deepEqual(calls[0].args, ["-P", "stc8g", "-p", "COM3", "-A", "dtr", "app.hex"]);
  assert.match(result.stdout, /STC8H1K08/);
});

await test("avrdude is used when it is all there is", async () => {
  const exec = (program, args, options, callback) => {
    process.nextTick(() => callback(null, "avrdude done.  Thank you.\n", ""));
    return {};
  };
  const result = await serial.flashFirmware({
    support: { ok: true, idf: null, esptool: null, avrdude: "C:\\avrdude.exe", stcgal: null },
    port: "COM4",
    file: "main.hex",
      exists: () => true,
    exec,
  });
  assert.equal(result.tool, "avrdude");
  assert.ok(result.args.includes("flash:w:main.hex:i"));
});

await test("a flash with no toolchain refuses instead of running nothing", async () => {
  await assert.rejects(() => serial.flashFirmware({ support: { ok: false, reason: "没有工具" }, port: "COM3" }), /没有工具/);
});

await test("the monitor script opens the port exclusively and closes it even on error", () => {
  const script = serial.monitorScript({ port: "COM3", baud: 115200, seconds: 3 });
  assert.match(script, /SerialPort 'COM3', 115200/);
  assert.match(script, /AddMilliseconds\(3000\)/);
  assert.match(script, /finally \{ try \{ \$port\.Close\(\) \}/);
  assert.match(script, /ToBase64String/);
});

await test("a tqdm progress bar is dropped, and its carriage returns do not glue lines together", () => {
  // Measured on the real STC flash: the report ended with "Writing flash: 18%|????" because tqdm rewrites one line with
  // \r and the console codepage mangled it. The verdict ("Target UID: ...") was several lines further up.
  const noisy = [
    "Protocol detected: stc8g",
    "Writing flash:   0%|     | 0/3584",
    "Writing flash:  50%|###  | 1792/3584",
    "Finishing write: done",
    "Target UID: F734C3FC31F408",
  ].join("\r");
  const kept = serial.tail(noisy, 10);
  assert.match(kept, /Target UID: F734C3FC31F408/, "the verdict survives");
  assert.doesNotMatch(kept, /%\|/, "progress bars are not output");
  assert.ok(kept.split("\n").every((line) => !line.includes("%|")), "no line keeps a progress bar");
});

await test("flasher children get a UTF-8 environment", async () => {
  let seen;
  const exec = (program, args, options, callback) => {
    seen = options.env;
    process.nextTick(() => callback(null, "", ""));
    return {};
  };
  await serial.flashFirmware({
    support: { ok: true, idf: null, esptool: { python: "py.exe", args: ["-m", "esptool"] }, avrdude: "", stcgal: null },
    port: "COM3",
    file: "app.bin",
    exists: () => true,
    exec,
  });
  assert.equal(seen.PYTHONIOENCODING, "utf-8");
  assert.equal(seen.PYTHONUTF8, "1");
});

await test("a missing firmware file is refused here, not inside the flasher", async () => {
  // Measured: stcgal answered a missing path with its whole usage text, which reads like a broken tool rather than a
  // wrong path.
  assert.throws(() => serial.assertFile("C:\\nope\\app.hex", { exists: () => false }), /固件文件不存在/);
  assert.equal(serial.assertFile("", { exists: () => false }), "", "no file is fine for flasher=idf");
  assert.equal(serial.assertFile("app.hex", { exists: () => true }), "app.hex");
  await assert.rejects(
    () =>
      serial.flashFirmware({
        support: { ok: true, idf: null, esptool: null, avrdude: "", stcgal: { program: "stcgal.exe", args: [] } },
        flasher: "stcgal",
        port: "COM3",
        file: "C:\\nope\\app.hex",
        exec: () => {
          throw new Error("the flasher must not start");
        },
      }),
    /固件文件不存在/,
  );
});

await test("a flasher's verdict is the tail of its output", () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  assert.deepEqual(serial.tail(text, 2).split("\n"), ["line 29", "line 30"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
