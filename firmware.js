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
export const TOOLCHAINS = ["keil", "idf", "cmake", "make"];

/** Which downloaders we know. `uv4` is uVision's own (`-f`), the rest are external. */
export const FLASHERS = ["uv4", "stcgal", "idf", "openocd", "stflash", "esptool"];

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
export function buildPlan({ kind, dir = "", project = "", idfPy = "", cmake = "", make = "", uv4 = "", target = "" } = {}) {
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
    return { tool: idfPy, args, note: "idf.py build" };
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
  uv4 = "",
  openocd = "",
  stflash = "",
  chip = "",
  target = "stm32f1x",
  port = "",
  stc = false,
} = {}) {
  const wanted = String(flasher || "auto").toLowerCase();
  const resolved =
    wanted !== "auto"
      ? wanted
      : kind === "idf"
        ? "idf"
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
    const args = ["-C", dir];
    if (port) args.push("-p", port);
    args.push("flash");
    return { tool: idfPy, args, note: "idf.py flash（会先编译）" };
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
  if (resolved === "esptool") return { tool: "esptool", args: ["-p", port, "write_flash", "0x0", file], note: "esptool" };
  // Nothing usable: name the packages, because "不知道" is not an instruction.
  const wants = kind === "cmake" || kind === "make" ? "openocd 或 stlink-tools（st-flash）" : "一个烧录器";
  return { error: `没有可用的烧录器：需要 ${wants}；也可以用 flasher 显式指定（${FLASHERS.join(" / ")}）` };
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
  walk(join(dir, "build"), depth);
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
