/**
 * Firmware builds and downloads for the three families this machine can meet: Keil (C51 or MDK-ARM), ESP-IDF, and a
 * plain CMake/Make project for anything with an `arm-none-eabi-gcc` toolchain and an ST-Link.
 *
 * Why one module instead of a tool per vendor: the person does not want to remember which incantation their project
 * needs. `detectProject` reads what is actually in the folder, and `buildPlan`/`flashPlan` turn that into an argv. Every
 * decision is overridable (`toolchain`, `flasher`), because "let me choose" is the whole point - detection is a default,
 * not a verdict.
 *
 * The args are built as plain arrays and the process is injected, so the suites can assert the exact command line
 * without a board, a compiler, or a probe attached.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUILD_TIMEOUT_MS = 900000;

/** Which build systems we know how to drive, in the order detection prefers them. */
export const TOOLCHAINS = ["keil", "idf", "arduino", "cmake", "make"];

/** Which downloaders we know. `uv4` is uVision's own (`-f`), the rest are external. */
export const FLASHERS = ["uv4", "stcgal", "idf", "arduino", "openocd", "stflash", "esptool", "uart"];

/** ST-Link boards people actually have; `openocd` needs a target config and this is the shortlist worth guessing from. */
export const OPENOCD_TARGETS = {
  stm32f0: "target/stm32f0x.cfg",
  stm32f1: "target/stm32f1x.cfg",
  stm32f2: "target/stm32f2x.cfg",
  stm32f3: "target/stm32f3x.cfg",
  stm32f4: "target/stm32f4x.cfg",
  stm32f7: "target/stm32f7x.cfg",
  stm32g0: "target/stm32g0x.cfg",
  stm32g4: "target/stm32g4x.cfg",
  stm32h7: "target/stm32h7x.cfg",
  stm32l0: "target/stm32l0x.cfg",
  stm32l1: "target/stm32l1x.cfg",
  stm32l4: "target/stm32l4x.cfg",
  stm32wb: "target/stm32wbx.cfg",
};

/**
 * What kind of project is this folder?
 *
 * Reads files, never writes: a `.uvprojx` says Keil, a `sdkconfig` (or `sdkconfig.defaults`) says ESP-IDF, and a
 * `CMakeLists.txt` / `Makefile` says neither of those - which is the arm-gcc + openocd path. The evidence is returned
 * with the verdict so a wrong guess can be argued with instead of silently obeyed.
 */
export function detectProject({ dir = ".", exists = existsSync, readdir = readdirSync } = {}) {
  if (!dir) return { kind: "unknown", reason: "没有工程目录" };
  const list = (() => {
    try {
      return readdir(dir);
    } catch {
      return [];
    }
  })();
  const has = (name) => list.some((entry) => String(entry).toLowerCase() === name.toLowerCase());

  const uvision = list.find((entry) => /\.uvprojx?$/i.test(String(entry)));
  if (uvision) return { kind: "keil", project: join(dir, String(uvision)), evidence: String(uvision) };

  // An Arduino sketch is a folder whose name matches a `.ino` inside it - that is the rule arduino-cli itself enforces,
  // and it is checked before CMake because a sketch often carries a CMakeLists.txt from some other tool.
  const sketch = list.find((entry) => /\.ino$/i.test(String(entry)));
  if (sketch) {
    const name = String(sketch).replace(/\.ino$/i, "");
    const folder = String(dir).replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    return { kind: "arduino", dir, sketch: join(dir, String(sketch)), sketchName: name, folderMatch: name === folder, evidence: String(sketch) };
  }

  // ESP-IDF before plain CMake: an IDF project also has a CMakeLists.txt, and the sdkconfig is what makes it an IDF
  // project rather than something a stock toolchain could build.
  if (has("sdkconfig") || has("sdkconfig.defaults")) return { kind: "idf", dir, evidence: "sdkconfig" };
  if (has("CMakeLists.txt") && has("main")) return { kind: "idf", dir, evidence: "CMakeLists.txt + main/" };
  if (has("CMakeLists.txt")) {
    return { kind: "cmake", dir, evidence: "CMakeLists.txt" };
  }
  if (has("Makefile") || has("makefile")) {
    return { kind: "make", dir, evidence: "Makefile" };
  }
  return { kind: "unknown", reason: `在 ${dir} 里没有找到 .uvprojx / sdkconfig / CMakeLists.txt / Makefile` };
}

/** The compiler a Keil project wants: C51 and MDK both live behind UV4, so this is only for the error message. */
export function keilFamily(xml) {
  const text = String(xml ?? "");
  if (/<Vendor>STC<\/Vendor>|STC8|STC15|STC12|STC89/i.test(text)) return "c51";
  if (/<Vendor>STMicroelectronics<\/Vendor>|STM32/i.test(text)) return "arm";
  return "";
}

/**
 * What to run for `build`, per toolchain.
 *
 * `idf` builds through `idf.py -C <dir> build` - the same -C discipline as flashing, because building "the project in
 * whatever directory the plugin happens to be" is how a green build belongs to something else.
 */
export function buildPlan({ kind, dir = "", project = "", idfPy = "", idf = null, cmake = "", make = "", uv4 = "", arduinoCli = "", fqbn = "", target = "" } = {}) {
  // Every tool path comes in resolved where possible: a long-running process never re-reads PATH, so `cmake` installed
  // while DSH was running would spawn-fail even though the folder has it (which() is what found it).
  if (kind === "keil") {
    // Not the string "uv4": that would be spawned as a program name and fail in 3 ms. The caller resolves the
    // installed UV4.exe (keil.keilSupport) and hands the path in.
    if (!uv4) return { error: "没找到 UV4.exe —— 装了 Keil 之后用 KEIL_UV4 指一下，或装到默认位置" };
    return { tool: uv4, args: ["-b", project, "-j0"], note: "UV4 编译" };
  }
  if (kind === "idf") {
    if (!idfPy) return { error: "没找到 idf.py —— 设置 IDF_PATH 或装 ESP-IDF" };
    const args = ["-C", dir];
    if (target) args.push(`-DIDF_TARGET=${target}`);
    args.push("build");
    // `idf.py` is a .py file, so spawning it fails with EFTYPE, and even with an interpreter it needs cmake / ninja / the
    // xtensa toolchain on PATH - which only ESP-IDF's export.ps1 sets up. One PowerShell session sources it first.
    const wrapped = idfWrap({ idf, idfPy, argv: args });
    return wrapped ? { ...wrapped, note: "idf.py build（经 export.ps1）" } : { tool: idfPy, args, note: "idf.py build" };
  }
  if (kind === "arduino") {
    // arduino-cli is the scriptable face of the Arduino IDE: same cores, same board manager, no GUI. The FQBN
    // (`arduino:avr:uno`) is what names the board; without it nothing can be compiled, so it is an explicit error.
    if (!arduinoCli) return { error: "没找到 arduino-cli —— 装上它（单文件，放到 %USERPROFILE%\\tools\\arduino-cli\\）" };
    if (!fqbn) return { error: "不知道板子型号：给 board 参数（如 arduino:avr:uno），或在 sketch.yaml 里写 default_fqbn" };
    return { tool: arduinoCli, args: ["compile", "--fqbn", fqbn, dir], note: `arduino-cli compile · ${fqbn}` };
  }
  if (kind === "cmake") {
    if (!cmake) return { error: "没找到 cmake —— 装上 cmake（或改用 make）" };
    return { tool: cmake, args: ["--build", join(dir, "build")], note: "cmake --build build" };
  }
  if (kind === "make") {
    if (!make) return { error: "没找到 make —— 装上 make/gmake（或改用 cmake）" };
    return { tool: make, args: ["-C", dir, "-j"], note: "make -j" };
  }
  return { error: `不知道这个工程怎么编译（${kind}）` };
}

/**
 * What to run for `flash`, per toolchain and downloader.
 *
 * `auto` follows the family: STC parts have no uVision download driver, so they go to stcgal; every other Keil project
 * goes through `UV4 -f`; ESP-IDF flashes itself; and a CMake/Make project with an ELF is an ST-Link job, which means
 * openocd when it is installed and st-flash when it is not.
 */
export function flashPlan({
  kind = "",
  flasher = "auto",
  dir = "",
  project = "",
  file = "",
  idfPy = "",
  idf = null,
  uv4 = "",
  openocd = "",
  stflash = "",
  chip = "",
  target = "stm32f1x",
  port = "",
  python = "",
  arduinoCli = "",
  fqbn = "",
  baud = 0,
  family = "F1",
  stc = false,
} = {}) {
  const wanted = String(flasher || "auto").toLowerCase();
  const resolved =
    wanted !== "auto"
      ? wanted
      : kind === "idf"
        ? "idf"
        : kind === "arduino"
          ? "arduino"
        : stc
          ? "stcgal"
          : kind === "keil"
            ? "uv4"
            : openocd
              ? "openocd"
              : stflash
                ? "stflash"
                : "";

  if (resolved === "uv4") {
    if (!uv4) return { error: "没找到 UV4.exe —— 装上 Keil（MDK-ARM）或设置 KEIL_UV4" };
    return { tool: uv4, args: ["-f", project, "-j0"], note: "UV4 -f（工程里配的调试器）" };
  }
  if (resolved === "stcgal") {
    if (!file) return { error: "没有 hex 文件：先编译，或指定 file" };
    return { tool: "stcgal", args: [], note: "stcgal 串口 ISP", chip, port, file, delegated: true };
  }
  if (resolved === "idf") {
    if (!idfPy) return { error: "没找到 idf.py" };
    if (!port) return { error: "ESP-IDF 烧录要给串口（例如 port=\"COM6\"）" };
    const args = ["-C", dir];
    // Not `target`: that is the openocd target name ("stm32f1x") and it leaked into an ESP-IDF command as
    // `-DIDF_TARGET=stm32f1x`. The IDF target is `esp32` and belongs in `chip`.
    if (chip) args.push(`-DIDF_TARGET=${chip}`);
    args.push("-p", port);
    if (baud) args.push("-b", String(baud));
    args.push("flash");
    const wrapped = idfWrap({ idf, idfPy, argv: args });
    return wrapped ? { ...wrapped, note: "idf.py flash（经 export.ps1，会先编译）" } : { tool: idfPy, args, note: "idf.py flash（会先编译）" };
  }
  if (resolved === "arduino") {
    if (!arduinoCli) return { error: "没找到 arduino-cli" };
    if (!fqbn) return { error: "不知道板子型号：给 board 参数（如 arduino:avr:uno）" };
    if (!port) return { error: "Arduino 烧录要给串口（例如 port=\"COM3\"）" };
    // `upload` alone is not enough: arduino-cli looks for a compiled sketch by its project hash and fails with
    // "Compiled sketch not found in ...sketches\<hash>" when nothing was built. `compile --upload` is one command that
    // builds and writes, which is also what "flash this project" means to the person asking.
    return {
      tool: arduinoCli,
      args: ["compile", "--fqbn", fqbn, "--upload", "-p", port, dir],
      note: `arduino-cli compile --upload · ${fqbn} · ${port}`,
    };
  }
  if (resolved === "openocd") {
    if (!openocd) return { error: "没找到 openocd —— 装上 openocd（或改用 st-flash）" };
    // Both spellings are in the wild: the map is keyed `stm32f4`, people say `stm32f4x` (which is what the .cfg file
    // is called). Normalise rather than making the caller guess which one we meant.
    const key = String(target).toLowerCase().replace(/x$/, "");
    const cfg = OPENOCD_TARGETS[key] ?? `target/${String(target).toLowerCase()}.cfg`;
    return {
      tool: openocd,
      args: ["-f", "interface/stlink.cfg", "-f", cfg, "-c", `program "${file}" verify reset exit`],
      note: `openocd · ${cfg}`,
    };
  }
  if (resolved === "stflash") {
    if (!stflash) return { error: "没找到 st-flash —— 装上 stlink-tools" };
    return { tool: stflash, args: ["write", file, "0x8000000"], note: "st-flash write 0x8000000" };
  }
  if (resolved === "uart") {
    // The STM32 UART bootloader (AN3155) through `stm32loader`: the only path for a board with no SWD debugger, which is
    // exactly the board this was verified on (a C8T6 clone at 32K). BOOT0 must be 1 and the reset pressed, which is the
    // price of not owning an ST-Link - so the note says it rather than failing at "no ACK".
    if (!python) return { error: "没找到 python —— UART 引导烧录要用 python -m stm32loader" };
    if (!file) return { error: "没有固件：先编译，或指定 file（.bin）" };
    if (!port) return { error: "UART 引导烧录要给串口（例如 port=\"COM3\"）" };
    return {
      tool: python,
      args: ["-m", "stm32loader", "-p", port, "-b", String(baud || 115200), "-f", String(family || "F1"), "-e", "-w", file, "-v"],
      note: `stm32loader UART 引导（BOOT0=1 + 复位后才能连上）`,
    };
  }
  if (resolved === "esptool") return { tool: "esptool", args: ["-p", port, "write_flash", "0x0", file], note: "esptool" };
  // Nothing usable: name the packages, because "不知道" is not an instruction.
  const wants = kind === "cmake" || kind === "make" ? "openocd 或 stlink-tools（st-flash）" : "一个烧录器";
  return { error: `没有可用的烧录器：需要 ${wants}；也可以用 flasher 显式指定（${FLASHERS.join(" / ")}）` };
}

/**
 * The board, from the three places it can be stated.
 *
 * `sketch.yaml` is arduino-cli's own project file and wins (it is what `arduino-cli sketch new` writes); `args.board`
 * is the person overriding it; and `arduino-cli board list --format json` is the last resort, because it can only
 * recognise a board that is plugged in - which is exactly right for `upload` and useless for `compile`.
 */
/**
 * `idf.py` inside the environment that makes it work.
 *
 * Two separate problems, both real: the file is `.py`, so `spawn` fails with EFTYPE, and idf.py needs cmake / ninja / the
 * xtensa toolchain on PATH, which only ESP-IDF's `export.ps1` sets up. One PowerShell session that sources the script and
 * then runs the interpreter solves both - the same shape serial.js has always used for flashing.
 */
export function idfWrap({ idf, idfPy = "", python = "", argv = [] } = {}) {
  const framework = String(idf?.framework ?? "").replace(/[\\/]+$/, "");
  if (!framework) return null;
  // The script is the *first argument* to the interpreter: `python idf.py -C dir build`. Passing the script where the
  // interpreter belongs made python read `-C` as its own option ("Unknown option: -C").
  const script = String(idf?.idfPy ?? idfPy ?? "");
  if (!script) return null;
  const interpreter = String(idf?.python ?? python ?? "") || "python";
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  // PATH is left alone deliberately: export.ps1 itself calls `python`, so emptying PATH first makes the export fail
  // ("python is not recognized") and then idf.py reports "'cmake' must be available on the PATH". The "Not using an
  // unsupported version of tool cmake found in PATH" lines this machine prints are harmless - export.ps1 prepends
  // ESP-IDF's own tools, so those win.
  const command = [
    `& ${quote(`${framework}\\export.ps1`)}`,
    `& ${quote(interpreter)} ${[script, ...argv].map(quote).join(" ")}`,
  ].join("; ");
  return { tool: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] };
}
/**
 * Intel HEX → `{ base, bytes }`.
 *
 * `stm32loader` refuses a hex that does not start at address 0 (`assert addresses[0] == 0`) and needs the `intelhex`
 * package to read one at all - while the STM32 bootloader wants a raw binary at 0x08000000 anyway. Converting here means
 * one code path for both compilers, no python package, and a length that can be checked against the Program Size line.
 */
export function hexToBin(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const chunks = [];
  let base = 0;
  let upper = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith(":")) continue;
    const bytes = [];
    for (let i = 1; i + 1 < line.length; i += 2) {
      const value = Number.parseInt(line.slice(i, i + 2), 16);
      if (!Number.isFinite(value)) return { error: `hex 行里有非十六进制字符：${line.slice(0, 20)}…` };
      bytes.push(value);
    }
    if (bytes.length < 5) continue;
    const count = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + count);
    if (data.length !== count) return { error: "hex 行的长度和声明的字节数不一致" };
    if (type === 0x00) {
      chunks.push({ address: (upper << 16) + address, data });
      continue;
    }
    if (type === 0x01) break; // EOF
    if (type === 0x02 && data.length >= 2) {
      upper = ((data[0] << 8) | data[1]) >>> 12;
      continue;
    }
    if (type === 0x04 && data.length >= 2) {
      upper = (data[0] << 8) | data[1];
      continue;
    }
    // 0x03 / 0x05 are start addresses: irrelevant to what gets written.
  }
  if (!chunks.length) return { error: "hex 里没有任何数据记录" };

  const start = Math.min(...chunks.map((chunk) => chunk.address));
  const end = Math.max(...chunks.map((chunk) => chunk.address + chunk.data.length));
  const buffer = Buffer.alloc(end - start);
  for (const chunk of chunks) chunk.data.forEach((value, index) => { buffer[chunk.address - start + index] = value; });
  return { base: start, bytes: buffer, size: buffer.length };
}
export function fqbnFromSketchYaml(text) {
  // `default_fqbn:` at the top level is the plain case; a `profiles:` block also carries `fqbn:` lines, and taking the
  // first one is right for the common sketch with a single profile. The answer is printed in the tool's output either
  // way, so a wrong pick is visible rather than silent.
  const match = String(text ?? "").match(/^\s*(?:default_fqbn|fqbn)\s*:\s*["']?([\w:.\-]+)["']?\s*$/m);
  return match ? match[1].trim() : "";
}

/** One entry of `arduino-cli board list --format json`: the port, its address and the FQBN it was recognised as. */
export function boardFromList(json, { port = "" } = {}) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return "";
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.detected_ports) ? parsed.detected_ports : [];
  const withBoard = [];
  for (const row of rows) {
    const address = String(row?.port?.address ?? "").trim();
    const fqbn = String(row?.matching_boards?.[0]?.fqbn ?? row?.boards?.[0]?.fqbn ?? "").trim();
    if (fqbn) withBoard.push({ address, fqbn });
  }
  if (port) {
    const hit = withBoard.find((row) => row.address.toLowerCase() === String(port).toLowerCase());
    if (hit) return hit.fqbn;
  }
  // No port asked for (or it did not match): only answer when exactly one board was recognised.
  return withBoard.length === 1 ? withBoard[0].fqbn : "";
}

/** Newest `.elf` / `.bin` under a build folder - what a CMake project just produced, without asking which one. */
export function findFirmware(dir, { exists = existsSync, readdir = readdirSync, stat = statSync, depth = 3 } = {}) {
  const found = [];
  const walk = (current, level) => {
    if (level < 0) return;
    let entries;
    try {
      entries = readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, level - 1);
        continue;
      }
      if (/\.(elf|bin|hex)$/i.test(entry.name)) {
        try {
          found.push({ path, mtime: stat(path).mtimeMs });
        } catch {
          // vanished while walking: not a candidate
        }
      }
    }
  };
  // `build` is what CMake/Make/IDF produce; `Objects` is where uVision puts its .hex and .axf. Trying only the first one
  // meant a Keil project always reported "没有固件" even with Objects\blink.hex sitting there.
  walk(join(dir, "build"), depth);
  walk(join(dir, "Objects"), Math.max(depth - 1, 1));
  if (!found.length) walk(dir, depth);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path ?? "";
}

/**
 * The `build` preference block: which toolchain and downloader to use, and where the project is.
 *
 * `auto` is the default on both, which is what "detect it, but let me override" means in storage. A value outside the
 * known vocabularies is dropped rather than stored, because a typo that silently becomes "auto" is worse than one that
 * is refused.
 */
export function normalizeBuildPrefs(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const pick = (field, allowed) => {
    const raw = String(source[field] ?? "").trim().toLowerCase();
    return raw && allowed.includes(raw) ? raw : "auto";
  };
  const next = {
    toolchain: pick("toolchain", ["auto", ...TOOLCHAINS]),
    flasher: pick("flasher", ["auto", ...FLASHERS]),
    dir: typeof source.dir === "string" ? source.dir.trim() : "",
  };
  if (next.dir) next.dir = next.dir.replace(/[\\/]+$/, "");
  return next;
}

/**
 * Drop newlib's `nosys` stub warnings from a build's output.
 *
 * `--specs=nosys.specs` makes every libc syscall wrapper complain (`_close is not implemented and will always fail`)
 * and the linker add a note about garbage collection. A bare-metal link produces a dozen of these, all harmless, and
 * they drown the two lines that matter: the errors and the `text data bss` summary. Counting them is better than
 * hiding them, so the caller can say "12 known warnings filtered".
 */
// Three shapes, because one warning is a three-line group: the ld header naming the object and symbol
// (`libc_nano.a(libc_a-closer.o): in function `_close_r':`), the warning itself, and the linker's garbage-collection
// note. Filtering only the last two leaves a column of orphaned headers, which is how the first version of this looked.
const NOSYS_NOISE =
  /(not implemented and will always fail|does not take linker garbage collection into account|libc_nano\.a\(libc_a-[a-z]+\.o\): in function `_[a-z]+_r':)/i;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function tidyOutput(text, { maxLines = 14 } = {}) {
  // arduino-cli and several compilers colour their output. Those escapes are not information in a chat bubble; they are
  // four characters of noise in front of every path (`[92mUsed platform[0m`).
  const lines = String(text ?? "").replace(ANSI, "").split(/\r?\n/);
  const kept = lines.filter((line) => !NOSYS_NOISE.test(line));
  const dropped = lines.length - kept.length;
  const tail = kept
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim())
    .slice(-maxLines);
  return { text: tail.join("\n"), dropped };
}

/** One sentence about what this machine can do, so "why did it not build" is answerable before trying. */
export function toolchainReport({ keilArm = false, keilC51 = false, idfPy = "", cmake = "", make = "", openocd = "", stflash = "", armGcc = "" } = {}) {
  return [
    `Keil：${keilArm ? "MDK-ARM 可用" : keilC51 ? "只有 C51（编译不了 STM32）" : "没找到 UV4"}`,
    `ESP-IDF：${idfPy || "没找到 idf.py"}`,
    `cmake：${cmake || "没有"} · make：${make || "没有"} · arm-none-eabi-gcc：${armGcc || "没有"}`,
    `烧录器：openocd ${openocd ? "有" : "无"} · st-flash ${stflash ? "有" : "无"}`,
  ].join("\n");
}

/** Run a prepared plan. Kept separate from the planners so the suites can assert the argv without spawning anything. */
export function runPlan(plan, { exec = execFile, timeoutMs = BUILD_TIMEOUT_MS, env = process.env, cwd } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    if (!plan || plan.error || !plan.tool) {
      resolve({ ok: false, code: -1, ms: 0, output: plan?.error ?? "没有可执行的计划", plan });
      return;
    }
    exec(plan.tool, plan.args, { windowsHide: true, timeout: timeoutMs, env, cwd }, (error, stdout, stderr) => {
      const output = [String(stdout ?? ""), String(stderr ?? "")].filter(Boolean).join("\n");
      // An empty console with exit 0 is how a GUI program that refused to start looks, and calling that a success is
      // the mistake this file already learned once (UV4 -f on an STC part). No output is not a verdict.
      const spoke = output.trim().length > 0;
      resolve({
        ok: !error && spoke && !/Error:|error:|FAILED|undefined reference/i.test(output),
        code: typeof error?.code === "number" ? error.code : error ? -1 : 0,
        ms: Date.now() - started,
        output,
        plan,
      });
    });
  });
}
