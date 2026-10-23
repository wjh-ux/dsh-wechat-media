/**
 * The clipboard, as something the agent can use.
 *
 * Two honest uses drive this: taking what the person just copied (a block of text, a file) into a turn, and putting a
 * result where the next paste will find it. Reading a clipboard is mildly sensitive - it may hold a password - so the
 * switch (`clipboard`, on by default, `/clipboard off`) and the size cap are part of the contract, and the tool
 * descriptions say what happens rather than pretending it is free.
 *
 * Windows goes through the WinForms clipboard on an STA thread, which is the only way `SetText`/`GetText` behave
 * reliably from a service-like process; macOS and Linux shell out to the platform tools.
 *
 * **The protocol is base64.** PowerShell writes its stdout in the console codepage, so a JSON line carrying Chinese
 * came back as question marks (measured: 「剪贴板自检」 arrived as `??????`). Every script therefore emits the base64 of
 * its UTF-8 JSON, which survives any codepage, and the runner decodes it.
 */
import { execFile } from "node:child_process";

export const CLIPBOARD_TIMEOUT_MS = 15_000;
/** A clipboard can hold megabytes; a turn should not. */
export const CLIPBOARD_MAX_CHARS = 200_000;

/** Can this machine do it at all, and with what? */
export function clipboardSupport({ platform = process.platform } = {}) {
  if (platform === "win32") return { ok: true, via: "powershell" };
  if (platform === "darwin") return { ok: true, via: "pbcopy" };
  if (platform === "linux") return { ok: true, via: "wl-copy" };
  return { ok: false, reason: `不支持这个平台：${platform}（剪贴板目前只有 Windows / macOS / Linux）` };
}

/** The last two lines of every Windows script: build `$json`, then emit it as base64. */
function emitBase64() {
  return [
    "$json = $payload | ConvertTo-Json -Compress -Depth 4",
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))",
  ].join("\n");
}

/**
 * The PowerShell that reads the clipboard: text and the file-drop list, both optional.
 *
 * The cap is applied inside the script, not after it, so a 20 MB clipboard does not travel through stdout first.
 */
export function clipboardReadScript({ maxChars = CLIPBOARD_MAX_CHARS } = {}) {
  const cap = Math.max(1, Math.min(CLIPBOARD_MAX_CHARS, Math.round(Number(maxChars) || CLIPBOARD_MAX_CHARS)));
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    '$text = ""',
    "try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() } } catch { }",
    "$files = @()",
    "try { if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { $files = @([System.Windows.Forms.Clipboard]::GetFileDropList()) } } catch { }",
    "$truncated = $false",
    `if ($text.Length -gt ${cap}) { $text = $text.Substring(0, ${cap}); $truncated = $true }`,
    "$payload = @{ ok = $true; chars = $text.Length; truncated = $truncated; text = $text; files = $files }",
    emitBase64(),
  ].join("\n");
}

/**
 * The PowerShell that writes the clipboard: text in base64 (so no quoting or encoding can mangle it), or a file-drop
 * list. Files win when both are given - a clipboard holds one thing, and a file has no other way to be pasted.
 */
export function clipboardWriteScript({ text = "", paths = [] } = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((value) => String(value ?? "").trim()).filter(Boolean);
  const body = String(text ?? "");
  if (list.length === 0 && !body.length) throw new Error("没有可写的内容：text 和 paths 都是空的");
  const lines = ["Add-Type -AssemblyName System.Windows.Forms"];
  if (list.length > 0) {
    lines.push("$col = New-Object System.Collections.Specialized.StringCollection");
    for (const path of list) lines.push(`$col.Add(${psSingleQuoted(path)}) | Out-Null`);
    lines.push("[System.Windows.Forms.Clipboard]::SetFileDropList($col)");
    lines.push(`$payload = @{ ok = $true; kind = "files"; count = ${list.length} }`);
  } else {
    const base64 = Buffer.from(body, "utf8").toString("base64");
    lines.push(`$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))`);
    lines.push("[System.Windows.Forms.Clipboard]::SetText($text)");
    lines.push('$payload = @{ ok = $true; kind = "text"; chars = $text.Length }');
  }
  lines.push(emitBase64());
  return lines.join("\n");
}

/** A PowerShell single-quoted literal: `'` doubled, which is the only escape inside single quotes. */
export function psSingleQuoted(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/** Run one PowerShell script and parse the base64 JSON it prints. */
async function runPowerShell(script, { exec = execFile, timeoutMs = CLIPBOARD_TIMEOUT_MS } = {}) {
  const stdout = await new Promise((resolve, reject) => {
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, out, err) => {
        if (error) {
          const detail = String(err ?? "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
          reject(new Error(detail || String(error.message).split("\n")[0]));
          return;
        }
        resolve(String(out ?? ""));
      });
  });
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(Buffer.from(line, "base64").toString("utf8"));
  } catch {
    throw new Error(`剪贴板脚本的输出不是 base64 JSON：${line.slice(0, 200)}`);
  }
}

/** Run a small text-mode tool, optionally feeding stdin, and return stdout. */
function runPlain(command, args, { exec = execFile, timeoutMs = CLIPBOARD_TIMEOUT_MS, input = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, out, err) => {
      if (error) {
        const detail = String(err ?? "").trim().split(/\r?\n/).filter(Boolean)[0] ?? "";
        reject(new Error(detail || String(error.message).split("\n")[0]));
        return;
      }
      resolve(String(out ?? ""));
    });
    if (input !== undefined && child?.stdin) child.stdin.end(input);
  });
}

/**
 * Read the clipboard.
 *
 * @returns {Promise<{text: string, chars: number, truncated: boolean, files: string[], via: string}>}
 */
export async function readClipboard({ maxChars = CLIPBOARD_MAX_CHARS, exec = execFile, platform = process.platform, timeoutMs = CLIPBOARD_TIMEOUT_MS } = {}) {
  const support = clipboardSupport({ platform });
  if (!support.ok) throw new Error(support.reason);
  if (platform === "win32") {
    const answer = await runPowerShell(clipboardReadScript({ maxChars }), { exec, timeoutMs });
    return {
      text: String(answer?.text ?? ""),
      chars: Number(answer?.chars ?? 0),
      truncated: Boolean(answer?.truncated),
      files: Array.isArray(answer?.files) ? answer.files.map(String) : [],
      via: "powershell",
    };
  }
  const command = platform === "darwin" ? "pbpaste" : "wl-paste";
  const text = await runPlain(command, platform === "darwin" ? [] : ["--no-newline"], { exec, timeoutMs });
  const capped = text.slice(0, Math.max(1, Math.min(CLIPBOARD_MAX_CHARS, maxChars)));
  return { text: capped, chars: text.length, truncated: capped.length < text.length, files: [], via: command };
}

/**
 * Write the clipboard: `text` becomes the text, `paths` becomes a file-drop list (what Explorer pastes).
 *
 * @returns {Promise<{kind: "text"|"files", chars: number, count: number, via: string}>}
 */
export async function writeClipboard({ text = "", paths = [], exec = execFile, platform = process.platform, timeoutMs = CLIPBOARD_TIMEOUT_MS } = {}) {
  const support = clipboardSupport({ platform });
  if (!support.ok) throw new Error(support.reason);
  const list = (Array.isArray(paths) ? paths : [paths]).map((value) => String(value ?? "").trim()).filter(Boolean);
  if (platform === "win32") {
    const answer = await runPowerShell(clipboardWriteScript({ text, paths: list }), { exec, timeoutMs });
    return {
      kind: String(answer?.kind ?? (list.length ? "files" : "text")),
      chars: Number(answer?.chars ?? 0),
      count: Number(answer?.count ?? 0),
      via: "powershell",
    };
  }
  if (list.length) throw new Error("这个平台的剪贴板只写文字（文件拖放列表只有 Windows 支持）");
  const value = String(text ?? "");
  const command = platform === "darwin" ? "pbcopy" : "wl-copy";
  await runPlain(command, [], { exec, timeoutMs, input: value });
  return { kind: "text", chars: value.length, count: 0, via: command };
}
