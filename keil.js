/**
 * Keil uVision5 for the chat: this does not compile anything itself, it *drives* the UV4.exe that is already
 * installed - the same way `serial.js` drives idf.py rather than reimplementing a bootloader.
 *
 * Why a wrapper at all: UV4's command line is the only supported automation entry (`-b` build, `-r` rebuild,
 * `-c` clean, `-f` download-to-flash, `-o` log, `-j0` no window), and everything a person needs to know about a
 * build - what failed, in which file, at which line, and whether a .hex was produced - is written to that log
 * file rather than to stdout. A build that "failed" with an empty console is the normal case, so the log is the
 * contract here: `parseBuildLog` is what turns it into an answer.
 *
 * The two dialects are both parsed, because the same uVision ships both:
 *   - C51 / ARMCC5:  `.\main.c(12): error C141: syntax error near 'x'`
 *   - ARMCC6 / GCC:  `../src/main.c:12:5: error: use of undeclared identifier 'x'`
 * and a third form the tools themselves emit: `*** ERROR: ...`, `*** WARNING: ...`, `*** FATAL ERROR: ...`.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** A cold C51 build of a real project takes seconds; ARM with packs can take a minute. 5 minutes is "something hung". */
export const KEIL_TIMEOUT_MS = 300000;

/** What UV4's exit code means. 0 and 1 both mean "a download can follow"; 2 and up mean "do not flash this". */
export const UV4_EXIT = {
  0: "没有错误也没有警告",
  1: "有警告，但没有错误",
  2: "有错误",
  3: "致命错误（工具链本身失败）",
  11: "打不开工程文件",
  12: "找不到该器件（缺器件包或 Target 名不对）",
  13: "写文件失败",
  15: "读文件失败",
  20: "License 问题（Lite 版有 32K 限制）",
};

/** Where a Keil install usually is, most specific first. Only used after the environment and TOOLS.INI say nothing. */
const UV4_CANDIDATES = [
  "D:\\Keil_v5\\UV4\\UV4.exe",
  "C:\\Keil_v5\\UV4\\UV4.exe",
  "D:\\Keil\\UV4\\UV4.exe",
  "C:\\Keil\\UV4\\UV4.exe",
  "C:\\Program Files\\Keil_v5\\UV4\\UV4.exe",
  "C:\\Program Files (x86)\\Keil_v5\\UV4\\UV4.exe",
];

/** `[C51] PATH="D:\Keil_v5\C51\"` → `{ C51: "D:\\Keil_v5\\C51\\", UV2: ... }`. Keil writes one section per toolchain. */
export function parseToolsIni(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const head = line.match(/^\[([^\]]+)\]$/);
    if (head) {
      current = head[1].trim();
      sections[current] ??= {};
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^"([^"]*)"/);
    if (quoted) value = quoted[1];
    sections[current][key] = value;
  }
  return sections;
}

/**
 * Find UV4.exe. Order: what the caller pinned (`KEIL_UV4`, then `UV4_PATH`, either the exe or the Keil root), then
 * TOOLS.INI - which is the install's own statement of where its toolchains are - then the usual folders.
 *
 * Returns `{ program, root, source }` or null: the caller decides whether "Keil is not installed" is an error or a
 * sentence in an answer.
 */
export function findUv4({ env = process.env, exists = existsSync, readFile = readFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return null;

  const tryPath = (candidate, source) => {
    if (!candidate) return null;
    const exe = /\.exe$/i.test(candidate) ? candidate : join(candidate, "UV4", "UV4.exe");
    if (!exists(exe)) return null;
    return { program: exe, root: dirname(dirname(exe)), source };
  };

  for (const [name, value] of [["KEIL_UV4", env.KEIL_UV4], ["UV4_PATH", env.UV4_PATH]]) {
    const hit = tryPath(value, name);
    if (hit) return hit;
  }

  // TOOLS.INI lives at the Keil root and names each toolchain's folder; C51's PATH is `<root>\C51\`.
  const roots = [...new Set(UV4_CANDIDATES.map((p) => dirname(dirname(p))))];
  for (const root of roots) {
    const ini = join(root, "TOOLS.INI");
    if (!exists(ini)) continue;
    let sections;
    try {
      sections = parseToolsIni(readFile(ini, "utf8"));
    } catch {
      continue;
    }
    for (const section of ["C51", "ARM", "UV2"]) {
      const toolchain = sections[section]?.PATH;
      if (!toolchain) continue;
      const exe = join(dirname(toolchain.replace(/[\\/]+$/, "")), "UV4", "UV4.exe");
      if (exists(exe)) return { program: exe, root: dirname(dirname(exe)), source: `TOOLS.INI [${section}]` };
    }
  }

  for (const candidate of UV4_CANDIDATES) {
    if (exists(candidate)) return { program: candidate, root: dirname(dirname(candidate)), source: "default path" };
  }
  return null;
}

/** Targets are what `-t` accepts; reading them out of the project beats guessing and then reporting exit code 12. */
export function targetsFromProject(xml) {
  const found = [];
  const re = /<TargetName>([^<]+)<\/TargetName>/g;
  let match;
  while ((match = re.exec(String(xml ?? "")))) {
    const name = match[1].trim();
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/** `<Vendor>STC</Vendor>` - the one fact that decides whether `UV4 -f` is even the right tool. */
export function projectVendor(xml) {
  const match = String(xml ?? "").match(/<Vendor>([^<]+)<\/Vendor>/i);
  return match ? match[1].trim() : "";
}

/** `<OutputName>X</OutputName>` + `<OutputDirectory>.\Objects\</OutputDirectory>`: where the .hex will be. */
export function projectOutput(xml) {
  const text = String(xml ?? "");
  const name = (text.match(/<OutputName>([^<]+)<\/OutputName>/i)?.[1] ?? "").trim();
  const dir = (text.match(/<OutputDirectory>([^<]+)<\/OutputDirectory>/i)?.[1] ?? "").trim();
  // Keil writes `.\Objects\`; strip both the leading `.\` and the trailing slash so the path we build is clean.
  return { name, dir: dir.replace(/^[.][\\/]/, "").replace(/\\+$/, "") };
}

/**
 * STC parts are programmed over the serial ISP protocol, not through uVision's download driver - which is why
 * `UV4 -f` on an STC project exits 0 having done nothing. stcgal names its protocols per family; picking one from the
 * device name is what the `chip` argument of `serial_flash` wants.
 */
export function stcProtocolFor(device) {
  const name = String(device ?? "").toUpperCase();
  if (!name.startsWith("STC")) return "";
  // STC89 first: "STC89C52" also starts with "STC8", and picking stc8g for an STC89 would fail at the ISP handshake.
  if (name.startsWith("STC89")) return "stc89";
  if (name.startsWith("STC8")) return "stc8g";
  if (name.startsWith("STC15")) return "stc15";
  if (name.startsWith("STC12")) return "stc12";
  return "auto";
}

/**
 * Which tool can actually put this project's .hex on the chip.
 *
 * `{ via: "uv4" }` - a part uVision has a download driver for (ARM, or a 51 board with a monitor).
 * `{ via: "stcgal", hex, chip }` - an STC part, where `UV4 -f` is a no-op; the hex is looked for where the project says
 * it writes it, then in the usual places, because a flash that cannot find its input should say so before opening a port.
 */
export function flashPlan({ project, xml = "", exists = () => false } = {}) {
  const vendor = projectVendor(xml);
  const device = (String(xml ?? "").match(/<Device>([^<]+)<\/Device>/i)?.[1] ?? "").trim();
  if (!/^STC/i.test(vendor) && !/^STC/i.test(device)) return { via: "uv4", vendor, device };
  const dir = String(project).replace(/[\\/][^\\/]+$/, "");
  const output = projectOutput(xml);
  const candidates = [
    output.dir && output.name ? `${dir}\\${output.dir}\\${output.name}.hex` : "",
    output.name ? `${dir}\\Objects\\${output.name}.hex` : "",
    output.name ? `${dir}\\${output.name}.hex` : "",
  ].filter(Boolean);
  const hex = candidates.find((candidate) => exists(candidate)) ?? "";
  return { via: "stcgal", vendor, device, chip: stcProtocolFor(device), hex, candidates };
}

/**
 * Which port a dev board is on, when the machine also has Bluetooth modems pretending to be serial ports.
 *
 * `serial.resolvePort("", ports)` correctly refuses to guess between three ports - but two of them here are
 * "蓝牙链接上的标准串行", and refusing to flash because a laptop has Bluetooth is not a useful answer. A USB-serial
 * bridge (CH340, CP210x, FTDI) is what a board actually is, so when exactly one port looks like one it is chosen and
 * the choice is reported; anything else keeps the original "tell me which" behaviour.
 */
export function pickBoardPort(ports = []) {
  const rows = Array.isArray(ports) ? ports.filter((row) => row?.port) : [];
  const looksUsb = (row) => /USB|CH34|CH910|CP21|FTDI|Silicon\s*Labs|ACM/i.test(String(row?.name ?? ""));
  const usb = rows.filter(looksUsb);
  if (usb.length === 1) return { port: usb[0].port, name: String(usb[0].name ?? ""), reason: "唯一一个 USB 串口" };
  return null;
}

/** A project path is only usable if it is a file and looks like a uVision project - checked before any process runs. */
export function assertProject(project, { exists = existsSync } = {}) {
  const file = String(project ?? "").trim().replace(/^"|"$/g, "");
  if (!file) throw new Error("需要工程路径（.uvprojx）");
  if (!/\.uvprojx?$/i.test(file)) throw new Error(`不是 uVision 工程文件：${file}（应该是 .uvprojx）`);
  const absolute = isAbsolute(file) ? file : resolve(file);
  if (!exists(absolute)) throw new Error(`工程文件不存在：${absolute}`);
  return absolute;
}

/** Actions map onto UV4's own switches; anything else is a typo worth refusing rather than passing through. */
export const ACTIONS = {
  build: "-b",
  rebuild: "-r",
  clean: "-c",
  flash: "-f",
};

/**
 * `UV4 -b project.uvprojx -o build.log -j0` — the order UV4 documents, `-j0` last so no window flashes up on a
 * machine that is being driven from a chat. `-t` only when a target was named: passing an empty one is exit code 11.
 */
export function buildArgs({ action = "build", project, target = "", log = "" } = {}) {
  const flag = ACTIONS[action];
  if (!flag) throw new Error(`未知动作：${action}（可用：${Object.keys(ACTIONS).join(" / ")}）`);
  const args = [flag, project];
  if (target) args.push("-t", target);
  if (log) args.push("-o", log);
  args.push("-j0");
  return args;
}

const C51_DIAG = /^(.*?)\((\d+)\):\s*(error|warning|fatal error)\s*:?\s*(?:([A-Z]+\d+)\s*:?\s*)?(.*)$/i;
const GCC_DIAG = /^(.*?):(\d+):(\d+):\s*(error|warning|fatal error|note)\s*:\s*(.*)$/i;
const STAR_DIAG = /^\*\*\*\s*(ERROR|WARNING|FATAL ERROR)\s*:?\s*(.*)$/i;
const SUMMARY = /(\d+)\s+Error\(s\),\s*(\d+)\s+Warning\(s\)/i;

/**
 * Turn a UV4 log into `{ ok, errors, warnings, summary, size, hex, target, notCreated }`.
 *
 * `ok` is not "the exit code was 0": a warning-only build exits 1 and is a successful build, while a log with
 * `Target not created` is a failure even when the counts look clean. Both facts are in the text, so both are read.
 */
export function parseBuildLog(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const notes = [];
  let summary = "";
  let size = "";
  let hex = "";
  let target = "";
  let notCreated = false;
  let errorCount = null;
  let warningCount = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const sum = line.match(SUMMARY);
    if (sum) {
      errorCount = Number(sum[1]);
      warningCount = Number(sum[2]);
      summary = line;
      continue;
    }
    if (/program size\s*:/i.test(line)) {
      size = line.replace(/^.*?Program Size\s*:\s*/i, "").trim();
      continue;
    }
    const hexLine = line.match(/creating hex file from\s+"?([^"]+)"?/i);
    if (hexLine) {
      hex = hexLine[1].trim();
      continue;
    }
    const buildTarget = line.match(/build target '([^']+)'/i) ?? line.match(/build (?:target|targets?) '([^']+)'/i);
    if (buildTarget) {
      target = buildTarget[1].trim();
      continue;
    }
    if (/target not created/i.test(line)) {
      notCreated = true;
      continue;
    }

    for (const [re, shape] of [
      [GCC_DIAG, "gcc"],
      [C51_DIAG, "c51"],
      [STAR_DIAG, "tool"],
    ]) {
      const match = line.match(re);
      if (!match) continue;
      const shaped = shapeOfDiagnostic(shape, match, line);
      if (!shaped) break;
      if (/^note$/i.test(shaped.severity)) notes.push(shaped);
      else if (/warning/i.test(shaped.severity)) warnings.push(shaped);
      else errors.push(shaped);
      break;
    }
  }

  // The counts in the log are the tool's own; the lists are what a person reads. Keep both, and let the lists win
  // when they disagree (a truncated "0 Error(s)" after "*** ERROR" is a real thing).
  const failed = notCreated || errors.length > 0 || (errorCount !== null && errorCount > 0);
  return {
    ok: !failed,
    errors,
    warnings,
    notes,
    summary,
    errorCount: errorCount ?? errors.length,
    warningCount: warningCount ?? warnings.length,
    size,
    hex,
    target,
    notCreated,
  };
}

function shapeOfDiagnostic(shape, match, line) {
  if (shape === "gcc") {
    const [, file, lineNo, col, severity, message] = match;
    return { file: file.trim(), line: Number(lineNo), column: Number(col), severity: severity.toLowerCase(), code: "", message: message.trim(), raw: line };
  }
  if (shape === "c51") {
    const [, file, lineNo, severity, code, message] = match;
    return { file: file.trim(), line: Number(lineNo), column: 0, severity: severity.toLowerCase(), code: (code ?? "").trim(), message: message.trim(), raw: line };
  }
  const [, severity, message] = match;
  return { file: "", line: 0, column: 0, severity: severity.toLowerCase(), code: "", message: message.trim(), raw: line };
}

/** One-line-per-problem rendering: `main.c(12): error C141: syntax error near 'x'` reads better than a JSON blob. */
export function formatDiagnostic(item) {
  const where = item.file ? (item.line ? `${item.file}(${item.line})` : item.file) : "";
  const code = item.code ? ` ${item.code}` : "";
  return `${where ? `${where}: ` : ""}${item.severity}${code}: ${item.message}`.trim();
}

/** Run UV4 and hand back the log it wrote, which is where every useful sentence about the build is. */
export function runUv4({
  uv4,
  project,
  action = "build",
  target = "",
  logPath = "",
  timeoutMs = KEIL_TIMEOUT_MS,
  exec = execFile,
  env = process.env,
} = {}) {
  const args = buildArgs({ action, project, target, log: logPath });
  const started = Date.now();
  // UV4 does not create the folder it is told to write the log into: without this the log silently never appears and
  // every "why did the build fail" answer loses its evidence. Both callers (the tool and the CLI) get it here.
  const ready = logPath ? mkdir(dirname(logPath), { recursive: true }).catch(() => {}) : Promise.resolve();
  return ready.then(() => new Promise((resolvePromise) => {
    exec(uv4, args, { windowsHide: true, timeout: timeoutMs, env }, (error, stdout, stderr) => {
      const code = error?.code ?? 0;
      let log = "";
      if (logPath) {
        try {
          log = readFileSync(logPath, "utf8");
        } catch {
          log = "";
        }
      }
      const text = log || [String(stdout ?? ""), String(stderr ?? "")].filter(Boolean).join("\n");
      resolvePromise({
        code: Number.isFinite(Number(code)) ? Number(code) : -1,
        ms: Date.now() - started,
        program: uv4,
        args,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        log: text,
        parsed: parseBuildLog(text),
      });
    });
  }));
}

/** The sentence a person gets back: verdict, then the problems with file and line, then the size / hex if produced. */
export function summarizeBuild(result, { project = "", action = "build" } = {}) {
  const { parsed } = result;
  // A flash run is only a success if the log says something was written: `UV4 -f` exits 0 having programmed nothing
  // when no download driver is configured, and a success message for that would be the worst kind of lie.
  const programmed = action === "flash" ? flashProgrammed(result.log) : undefined;
  const head = parsed.ok
    ? action === "clean"
      ? "🧹 清理完成"
      : action === "flash"
        ? programmed
          ? "⚡ 下载到芯片完成"
          : "⚠️ UV4 没有写芯片"
        : "✅ 编译通过"
    : "❌ 编译失败";
  const lines = [`${head}（${parsed.summary || `退出码 ${result.code}`}，${result.ms}ms）`];
  if (project) lines.push(`工程：${project}`);
  if (parsed.target) lines.push(`Target：${parsed.target}`);

  for (const item of parsed.errors.slice(0, 20)) lines.push(`  ✖ ${formatDiagnostic(item)}`);
  if (parsed.errors.length > 20) lines.push(`  … 还有 ${parsed.errors.length - 20} 条错误`);
  for (const item of parsed.warnings.slice(0, 10)) lines.push(`  ⚠ ${formatDiagnostic(item)}`);
  if (parsed.warnings.length > 10) lines.push(`  … 还有 ${parsed.warnings.length - 10} 条警告`);

  if (parsed.size) lines.push(`程序大小：${parsed.size}`);
  if (parsed.hex) lines.push(`HEX：${parsed.hex}`);
  if (parsed.notCreated) lines.push("（Target not created：没有产出可下载的文件）");
  if (UV4_EXIT[result.code] && result.code !== 0) lines.push(`UV4 退出码 ${result.code}：${UV4_EXIT[result.code]}`);

  if (action === "flash" && !programmed && parsed.ok) {
    lines.push("UV4 的日志里没有任何写芯片的记录（多半是空的）：这个工程没有配置下载驱动。");
    lines.push("STC 这类 8051 芯片通常靠 STC-ISP 或 stcgal 走串口 ISP 烧，用 serial_flash(flasher=stcgal, chip=stc8g, port=COMx) 烧上面那个 hex。");
  }
  const tail = result.log ? tailLines(result.log, parsed.errors.length ? 6 : 3) : "";
  if (tail) lines.push(`--- 日志末尾 ---\n${tail}`);
  return lines.join("\n");
}

/**
 * Did this log describe a program that reached a chip?
 *
 * `UV4 -f` exits 0 having done nothing when the project has no download driver configured - the log is 0 bytes and
 * Keil is happy. That is how the first real flash test produced "⚡ 下载到芯片完成" on a project whose chip had not
 * been touched: the exit code is not the answer, the log is. STC parts in particular are normally programmed through
 * STC-ISP or stcgal over the serial ISP protocol, not through uVision's own download.
 */
const FLASH_EVIDENCE = /(erase|programming|program\s|verify|flash load finished|application running|writing flash)/i;
const FLASH_FAILURE = /(flash download failed|cannot access target|no ulink|not connected|error:)/i;

export function flashProgrammed(log) {
  const text = String(log ?? "");
  if (!text.trim()) return false;
  if (FLASH_FAILURE.test(text)) return false;
  return FLASH_EVIDENCE.test(text);
}

/** Last `count` non-empty lines - UV4 pads its log with blanks and banner text. */
export function tailLines(text, count = 6) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim());
  return lines.slice(-count).join("\n");
}

/**
 * Where the log for a run goes.
 *
 * Beside the project but in its own folder: a build drops `.obj`/`.hex` into `Objects\` and Keil owns that directory,
 * so a `.build.log` next to `main.c` is clutter a person did not ask for. `.dsh-logs\` keeps it findable after the chat
 * is gone without pretending to be part of the build.
 */
export function defaultLogPath(project, action = "build") {
  const dir = String(project).replace(/[\\/][^\\/]+$/, "");
  const stem = String(project).replace(/^.*[\\/]/, "").replace(/\.uvprojx?$/i, "");
  return `${dir}\\.dsh-logs\\${stem}.${action}.log`;
}

/** `/keil` and the `/prefs` route agree on this shape: one switch, one project, one optional target. */
export function normalizeKeilPrefs(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const text = (field) => (typeof source[field] === "string" ? source[field].trim() : "");
  const next = { enabled: source.enabled === true, project: text("project"), target: text("target") };
  // `dir` is derived when a project is set, and dropped with it - a stale folder must not outlive its project.
  if (next.project && source.dir) next.dir = String(source.dir);
  return next;
}

/** Everything the tool needs to know about this machine's Keil, in one object - also what `/keil` prints. */
export function keilSupport({ env = process.env, exists = existsSync, readFile = readFileSync, platform = process.platform } = {}) {
  const uv4 = findUv4({ env, exists, readFile, platform });
  if (!uv4) {
    return {
      ok: false,
      reason:
        platform !== "win32"
          ? "Keil uVision 只有 Windows 版，这台机器不是 Windows"
          : "没找到 UV4.exe——可以用环境变量 KEIL_UV4 指向它（例如 D:\\Keil_v5\\UV4\\UV4.exe）",
      uv4: null,
    };
  }
  return { ok: true, uv4 };
}

/** Arm the tool from a project path: reads the targets so `/keil target` has something real to offer. */
export function inspectProject(project, { exists = existsSync, readFile = readFileSync } = {}) {
  const file = assertProject(project, { exists });
  const targets = targetsFromProject(readFile(file, "utf8"));
  return { file, dir: dirname(file), targets };
}
