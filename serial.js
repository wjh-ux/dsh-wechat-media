/**
 * Serial ports and flashing: find the board, flash a firmware, read what it prints.
 *
 * This does not implement a flasher. It *drives* the ones people already have - ESP-IDF's `idf.py` / `esptool`, or
 * `avrdude` for AVR boards - because reimplementing a bootloader protocol is how a tool ends up bricking a board on a bad
 * day. What lives here is the error-prone part: which port, which baud, which file, which offset, and the exact command
 * echoed back so a failure can be repeated by hand instead of guessed at.
 *
 * Four rules, each because the alternative is silent damage:
 *
 * - **Off until armed** (`/serial on`). Writing a board's flash is not a default-on capability.
 * - **Never guess the port.** A port must be named, or there must be exactly one serial port. Two ports and no answer is
 *   "say which one", not "pick the first".
 * - **Echo the command.** A flash that fails with its command in the transcript is diagnosable.
 * - **One owner per port.** The monitor opens the port exclusively; Windows allows one owner, so a flash and a monitor
 *   cannot overlap - the second one fails with a reason instead of corrupting the first.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const FLASH_TIMEOUT_MS = 300_000;
export const SERIAL_DEFAULT_BAUD = 115_200;

/** `esp-idf-v4.4.8` vs `esp-idf-v5.1.2` - the numeric parts decide, not the string. */
export function compareVersions(a, b) {
  const numbers = (value) => (String(value).match(/\d+/g) ?? []).map(Number);
  const left = numbers(a);
  const right = numbers(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Locate a program on PATH without starting it. */
export function which(name, { env = process.env, exists = existsSync } = {}) {
  const pathValue = String(env.PATH ?? env.Path ?? "");
  const extensions = [""].concat(String(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean));
  for (const dir of pathValue.split(";").filter(Boolean)) {
    for (const extension of extensions) {
      const suffix = extension && !name.toLowerCase().endsWith(extension.toLowerCase()) ? extension : "";
      const candidate = join(dir, `${name}${suffix}`);
      if (exists(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * Where ESP-IDF lives: the environment's answer first, then the layout the Windows installer uses
 * (`<root>/frameworks/esp-idf-vX.Y.Z` with `<root>/python_env/<env>/Scripts/python.exe`).
 */
export function findEspIdf({ env = process.env, exists = existsSync, readdir = readdirSync } = {}) {
  const roots = [env.IDF_PATH, "D:\\Espressif", "C:\\Espressif", join(env.USERPROFILE ?? "", "esp"), join(env.LOCALAPPDATA ?? "", "Espressif")]
    .filter(Boolean);
  const frameworks = [];
  for (const root of roots) {
    if (exists(join(root, "tools", "idf.py"))) {
      frameworks.push(root);
      continue;
    }
    const dir = join(root, "frameworks");
    if (!exists(dir)) continue;
    let entries = [];
    try {
      entries = readdir(dir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const candidate = join(dir, name);
      if (exists(join(candidate, "tools", "idf.py"))) frameworks.push(candidate);
    }
  }
  if (!frameworks.length) return null;
  frameworks.sort(compareVersions);
  const framework = frameworks.at(-1);
  const root = join(framework, "..", "..");
  const pythons = [];
  const envRoot = join(root, "python_env");
  let envs = [];
  try {
    envs = exists(envRoot) ? readdir(envRoot) : [];
  } catch {
    envs = [];
  }
  for (const entry of envs) {
    const python = join(envRoot, entry, "Scripts", "python.exe");
    if (exists(python)) pythons.push(python);
  }
  if (env.IDF_PYTHON_ENV_PATH) {
    const direct = join(env.IDF_PYTHON_ENV_PATH, "Scripts", "python.exe");
    if (exists(direct)) pythons.push(direct);
  }
  return { framework, root, idfPy: join(framework, "tools", "idf.py"), python: pythons.at(-1) ?? "" };
}

/** Where stcgal lives: on PATH, or as a console script inside an ESP-IDF python env. */
export function findStcgal({ env = process.env, exists = existsSync, readdir = readdirSync } = {}) {
  const onPath = which("stcgal", { env, exists }) || which("stcgal.exe", { env, exists });
  if (onPath) return { program: onPath, args: [] };
  // A pip install inside an ESP-IDF python env puts stcgal.exe in <env>/Scripts. Every env is searched, because "the
  // newest framework" and "the env that has stcgal" are not the same question - measured: stcgal lived in py3.11 while
  // the newest env by name was py3.8.
  const idf = findEspIdf({ env, exists, readdir });
  const envRoots = [];
  if (idf?.root) envRoots.push(join(idf.root, "python_env"));
  if (env.IDF_PYTHON_ENV_PATH) envRoots.push(env.IDF_PYTHON_ENV_PATH);
  for (const root of envRoots) {
    let entries = [];
    try {
      entries = exists(root) ? readdir(root) : [];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const scripts = join(root, entry, "Scripts");
      const exe = join(scripts, "stcgal.exe");
      if (exists(exe)) return { program: exe, args: [] };
      const py = join(scripts, "stcgal-script.py");
      if (exists(py)) return { program: join(scripts, "python.exe"), args: [py] };
    }
  }
  return null;
}

/** `stcgal -P stc8g -p COM3 -A dtr flash.hex` - the protocol, the port, and a DTR-based cold start. */
export function buildStcgalArgs({ port, protocol = "auto", baud = 0, file = "", reset = "dtr", eject = false } = {}) {
  if (!file && !eject) throw new Error("用 stcgal 烧录需要 file（.hex 或 .bin 固件路径），或者 eject=true 只探测芯片");
  const args = ["-P", String(protocol || "auto"), "-p", port];
  if (baud) args.push("-b", String(baud));
  if (reset) args.push("-A", String(reset));
  if (eject) args.push("-e");
  if (file) args.push(file);
  return args;
}

/** Which flashers this machine has; `null`/"" means "not found", never "pretend it works". */
export function serialSupport({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (platform !== "win32") {
    return { ok: false, reason: "串口烧录目前只在 Windows 上实现（用 System.IO.Ports 列端口、ESP-IDF / avrdude 烧录）" };
  }
  const idf = findEspIdf({ env, exists });
  const avrdude = which("avrdude", { env, exists }) || which("avrdude.exe", { env, exists }) || "";
  const stcgal = findStcgal({ env, exists });
  const esptool = idf?.python ? { python: idf.python, args: ["-m", "esptool"] } : null;
  return {
    ok: Boolean(idf?.idfPy || avrdude || stcgal),
    idf,
    esptool,
    avrdude,
    stcgal,
    reason: idf?.idfPy || avrdude || stcgal ? "" : "既没有找到 ESP-IDF（idf.py / esptool）、avrdude，也没有 stcgal —— 先装一个再烧录",
  };
}

/**
 * The PowerShell that lists serial ports, with the device name behind each.
 *
 * `SerialPort.GetPortNames()` is the authoritative list of *openable* names; the PnP query adds "what is plugged in",
 * because COM3 vs COM4 means nothing without "Silicon Labs CP210x".
 */
export function portsScript() {
  return [
    "$names = @([System.IO.Ports.SerialPort]::GetPortNames())",
    "$rows = @()",
    "foreach ($name in $names) {",
    '  $device = Get-CimInstance Win32_PnPEntity -Filter "Name LIKE \'%($name)%\'" -ErrorAction SilentlyContinue | Select-Object -First 1',
    "  $rows += [ordered]@{ port = $name; name = if ($device) { $device.Name } else { '' } }",
    "}",
    "$json = @{ ok = $true; ports = $rows } | ConvertTo-Json -Compress -Depth 4",
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))",
  ].join("\n");
}

/** Parse the base64 JSON the port script prints (base64 because the console codepage mangles Chinese device names). */
export function parsePortsOutput(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  try {
    const answer = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
    return Array.isArray(answer?.ports) ? answer.ports.map((row) => ({ port: String(row.port ?? ""), name: String(row.name ?? "") })) : [];
  } catch {
    throw new Error(`列串口脚本的输出不是 base64 JSON：${line.slice(0, 200)}`);
  }
}

/**
 * Validate the saved `serial` block: `{ enabled, baud, port }`.
 *
 * Clamped where a value is merely unwise (a baud outside 1200..4M is a typo) and refused where it is meaningless (a port
 * name that is not a COM name). `enabled` is true only for the literal `true`: a string "true" must not arm flashing.
 */
export function normalizeSerialPrefs(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const baud = Number(source.baud);
  const port = String(source.port ?? "").trim().toUpperCase();
  return {
    enabled: source.enabled === true,
    ...(Number.isFinite(baud) && baud >= 1200 && baud <= 4_000_000 ? { baud: Math.round(baud) } : {}),
    ...(port ? { port: normalizePort(port) } : {}),
  };
}

/**
 * A firmware path that does not exist is refused here, not inside the flasher.
 *
 * Measured: passing a missing file to stcgal produced its whole `usage:` text, which reads like a broken tool rather
 * than a wrong path. One line from here is a better answer.
 */
export function assertFile(file, { exists = existsSync } = {}) {
  const value = String(file ?? "").trim();
  if (!value) return "";
  if (!exists(value)) throw new Error(`固件文件不存在：${value}`);
  return value;
}

/** `com3` / `COM3` → `COM3`; anything else is a mistake worth saying out loud. */
export function normalizePort(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return "";
  if (!/^COM\d{1,3}$/.test(text)) throw new Error(`端口名不像话：${JSON.stringify(value)}（Windows 形如 COM3）`);
  return text;
}

/**
 * Pick the port, or refuse to. One port is a decision; two are a question.
 */
export function resolvePort(wanted, ports = []) {
  const named = normalizePort(wanted);
  if (named) {
    if (ports.length && !ports.some((row) => row.port.toUpperCase() === named)) {
      throw new Error(`没有这个串口：${named}（现在有：${ports.map((row) => row.port).join("、") || "无"}）`);
    }
    return named;
  }
  if (ports.length === 1) return ports[0].port;
  if (!ports.length) throw new Error("没有找到任何串口 —— 板子插上了吗？驱动装了吗？");
  throw new Error(`有 ${ports.length} 个串口（${ports.map((row) => row.port).join("、")}），请指定要烧哪个`);
}

/** `idf.py -p COM3 -b 460800 flash` - the project's sdkconfig owns the offsets. */
export function buildIdfArgs({ port, baud, target = "", projectDir = "" } = {}) {
  const args = [];
  // "-C" is how idf.py is told which project to work on; without it the flash happens in whatever directory the plugin
  // happens to be running in, which is how "flash the open folder" silently becomes "flash nothing".
  if (projectDir) args.push("-C", projectDir);
  if (target) args.push(`-DIDF_TARGET=${target}`);
  args.push("-p", port);
  if (baud) args.push("-b", String(baud));
  args.push("flash");
  return args;
}

/** `esptool -p COM3 -b 460800 write_flash 0x0 firmware.bin` - explicit offsets, for a plain bin. */
export function buildEsptoolArgs({ port, baud, file, offset = "0x0", chip = "", erase = false } = {}) {
  if (!file && !erase) throw new Error("用 esptool 烧录需要 file（.bin 固件路径），或者 erase=true");
  const args = ["-p", port];
  if (baud) args.push("-b", String(baud));
  if (chip) args.push("--chip", chip);
  if (erase) args.push("erase_flash");
  else args.push("write_flash", String(offset || "0x0"), file);
  return args;
}

/** `avrdude -c arduino -p atmega328p -P COM3 -b 115200 -U flash:w:firmware.hex:i` */
export function buildAvrdudeArgs({ port, baud, file, mcu = "atmega328p", programmer = "arduino" } = {}) {
  if (!file) throw new Error("用 avrdude 烧录需要 file（.hex 固件路径）");
  return ["-c", programmer, "-p", mcu, "-P", port, "-b", String(baud || SERIAL_DEFAULT_BAUD), "-U", `flash:w:${file}:i`];
}

/**
 * Read what the board prints, for a bounded time.
 *
 * A monitor that runs forever is useless from a chat turn, so this stops after `seconds`. The port is opened
 * exclusively: if a terminal already holds it, the error says so instead of silently reading nothing.
 */
export function monitorScript({ port, baud = SERIAL_DEFAULT_BAUD, seconds = 8 } = {}) {
  const ms = Math.max(500, Math.min(120_000, Math.round(Number(seconds) * 1000) || 8000));
  return [
    `$port = New-Object System.IO.Ports.SerialPort '${String(port).replace(/'/g, "''")}', ${Number(baud) || SERIAL_DEFAULT_BAUD}`,
    "$port.ReadTimeout = 500",
    "$text = ''",
    "$failure = ''",
    "try {",
    "  $port.Open()",
    `  $deadline = (Get-Date).AddMilliseconds(${ms})`,
    "  while ((Get-Date) -lt $deadline) {",
    "    try { $text += $port.ReadExisting() } catch { Start-Sleep -Milliseconds 100 }",
    "  }",
    "} catch { $failure = $_.Exception.Message } finally { try { $port.Close() } catch { } }",
    "$json = @{ ok = ($failure -eq ''); text = $text; error = $failure; port = $port.PortName; baud = $port.BaudRate } | ConvertTo-Json -Compress -Depth 4",
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))",
  ].join("\n");
}

/** Parse the monitor's base64 JSON. */
export function parseMonitorOutput(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(Buffer.from(line, "base64").toString("utf8"));
  } catch {
    throw new Error(`读串口的输出不是 base64 JSON：${line.slice(0, 200)}`);
  }
}

/** One process run, reported as a fact: exit code, streams, timing. A timeout is an error, not a code. */
export function runProcess(program, args, { exec = execFile, timeoutMs = FLASH_TIMEOUT_MS, env = process.env, cwd } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // Any of these flashers may be a python program (stcgal, esptool); without this, a Chinese Windows console turns
    // their bytes into mojibake before the output ever reaches the transcript.
    const childEnv = { ...env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    exec(program, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv, ...(cwd ? { cwd } : {}) }, (error, out, err) => {
      if (error && error.killed) {
        reject(new Error(`超时（${Math.round(timeoutMs / 1000)}s）——烧录没有在预期时间内结束`));
        return;
      }
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout: String(out ?? ""), stderr: String(err ?? ""), ms: Date.now() - started });
    });
  });
}

/**
 * Flash one board, and say exactly what ran.
 *
 * `flasher: "auto"` prefers `idf.py` (its sdkconfig owns the offsets), then esptool for a plain `.bin`, then avrdude for
 * a `.hex`. The choice is reported, because "which tool ran" is the first question when a flash fails.
 */
export async function flashFirmware({
  support,
  flasher = "auto",
  port,
  baud = 0,
  file = "",
  offset = "0x0",
  chip = "",
  erase = false,
  projectDir = "",
  exec = execFile,
  env = process.env,
  exists = existsSync,
  timeoutMs = FLASH_TIMEOUT_MS,
} = {}) {
  if (!support?.ok) throw new Error(support?.reason ?? "没有可用的烧录工具");
  // Checked before the toolchain is picked: a wrong path must not depend on which flasher runs.
  assertFile(file, { exists });
  const kind = String(flasher || "auto").toLowerCase();
  const wantsAvr = kind === "avrdude" || (kind === "auto" && !support.idf?.idfPy && support.avrdude);
  if (wantsAvr) {
    if (!support.avrdude) throw new Error("没有找到 avrdude");
    const args = buildAvrdudeArgs({ port, baud: baud || SERIAL_DEFAULT_BAUD, file, mcu: chip || "atmega328p" });
    const result = await runProcess(support.avrdude, args, { exec, timeoutMs, env });
    return { tool: "avrdude", program: support.avrdude, args, ...result };
  }
  if (kind === "idf" || (kind === "auto" && support.idf?.idfPy)) {
    if (!support.idf?.idfPy) throw new Error("没有找到 ESP-IDF 的 idf.py");
    const args = [support.idf.idfPy, ...buildIdfArgs({ port, baud, target: chip, projectDir })];
    // idf.py needs cmake, ninja and the toolchain on PATH; ESP-IDF's own export script is what puts them there, so the
    // flash runs inside one PowerShell session that sources it. Measured: calling idf.py directly fails with
    // "'cmake' must be available on the PATH", which reads like a broken install rather than a missing environment.
    const exportScript = join(support.idf.framework, "export.ps1");
    const quoted = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const command = [`& ${quoted(exportScript)}`, `& ${quoted(support.idf.python || "python")} ${args.map(quoted).join(" ")}`].join("; ");
    const result = await runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      exec,
      timeoutMs,
      env: { ...env, IDF_PATH: support.idf.framework },
      cwd: projectDir || undefined,
    });
    return { tool: "idf", program: "powershell.exe", args: ["-Command", command], ...result };
  }
  if (kind === "stcgal" || (kind === "auto" && support.stcgal && !support.idf?.idfPy && file.toLowerCase().endsWith(".hex"))) {
    if (!support.stcgal) throw new Error("没有找到 stcgal（pip install stcgal）");
    const args = [...support.stcgal.args, ...buildStcgalArgs({ port, file, protocol: chip || "auto", baud, eject: erase })];
    const result = await runProcess(support.stcgal.program, args, { exec, timeoutMs, env });
    return { tool: "stcgal", program: support.stcgal.program, args, ...result };
  }
  if (!support.esptool) throw new Error("没有找到 esptool（它随 ESP-IDF 的 python 环境一起安装）");
  const args = [...support.esptool.args, ...buildEsptoolArgs({ port, baud, file, offset, chip, erase })];
  const result = await runProcess(support.esptool.python, args, { exec, timeoutMs, env });
  return { tool: "esptool", program: support.esptool.python, args, ...result };
}

/** A tqdm-style progress line: "Writing flash: 18%|██ | 640/3584 [00:00<00:00]". */
const PROGRESS_LINE = /:?\s*\d{1,3}%\|.*\|\s*\d+\/\d+/;

/**
 * The last `lines` useful lines of a flasher's output - where it puts its verdict.
 *
 * Splits on `\r` as well as `\n` because tqdm rewrites one line with carriage returns, and drops the progress lines: a
 * bar that ends at 100% is not a result, and in a chat answer it is noise. Measured: without this, the STC flash report
 * ended with a mojibake progress bar instead of `Target UID: ...`.
 */
export function tail(text, lines = 20) {
  const all = String(text ?? "")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !PROGRESS_LINE.test(line));
  return all.slice(-Math.max(1, lines)).join("\n");
}
