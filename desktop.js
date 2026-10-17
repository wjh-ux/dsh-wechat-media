/**
 * Desktop control: the mouse, the keyboard, screenshots and windows.
 *
 * This is the one capability in this plugin that can click something on the user's own screen, so the
 * design leans on three rules:
 *
 *   1. **Off unless switched on.** Nothing here runs until `desktopControl` is true (see /desktop).
 *   2. **Every script is built, never interpolated.** Arguments travel as numbers or base64, and the
 *      generated PowerShell is a pure string this module produces - so a window title or a piece of
 *      text cannot smuggle a `; Remove-Item` into the command line.
 *   3. **Structure over events.** The C# is compiled per call with `Add-Type`; the struct layout that
 *      makes `SendInput` accept our events is asserted by a test against `Marshal.SizeOf`, because a
 *      wrong layout fails with a silent zero rather than an error.
 *
 * Everything that is pure - the script builders and the output parser - is exported, so the suites can
 * check the exact PowerShell that would run without running it.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";

/** How long any one desktop action may take. Add-Type compilation dominates the first call. */
export const DESKTOP_TIMEOUT_MS = 20000;

/** What `desktop_mouse` accepts; anything else is refused by name. */
export const MOUSE_ACTIONS = Object.freeze(["move", "click", "double_click", "right_click", "middle_click", "drag", "scroll"]);

/** Virtual-key codes for the key names a chat can reasonably type. Letters and digits are handled by VkKeyScan. */
export const VK = Object.freeze({
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  printscreen: 0x2c, capslock: 0x14,
});

/** Keys whose virtual-key event must carry KEYEVENTF_EXTENDEDKEY. */
export const EXTENDED_KEYS = new Set([0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2d, 0x2e]);

/** How to convert the byte length of the INPUT struct, per architecture, for the size guard. */
export const INPUT_SIZE = { x64: 40, ia32: 28 };

const C = {
  mouseDown: 0x0002,
  mouseUp: 0x0004,
  wheel: 0x0800,
  leftDown: 0x0002,
  leftUp: 0x0004,
  rightDown: 0x0008,
  rightUp: 0x0010,
  middleDown: 0x0020,
  middleUp: 0x0040,
};

/**
 * Make the process DPI aware before measuring or clicking anything.
 *
 * Without this, `GetSystemMetrics`, `Cursor.Position` and `CopyFromScreen` mix logical and physical
 * pixels on a scaled display, and a click at "the centre of the screenshot" lands somewhere else. It is
 * best-effort: an older Windows that lacks the call still works at 100%.
 */
const DPI = [
  "try {",
  '  Add-Type -TypeDefinition @"',
  "using System.Runtime.InteropServices;",
  "public static class DshDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }",
  '"@',
  "  [DshDpi]::SetProcessDPIAware() | Out-Null",
  "} catch { }",
].join("\n");

/** The input half of the native surface: cursor position, button and wheel events, text and keys. */
const NATIVE_INPUT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DshInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

  public static int StructSize() { return Marshal.SizeOf(typeof(INPUT)); }

  public static uint TypeText(string text) {
    if (string.IsNullOrEmpty(text)) return 0;
    var items = new List<INPUT>();
    foreach (char c in text) {
      INPUT down = new INPUT(); down.type = 1; down.U.ki.wScan = (ushort)c; down.U.ki.dwFlags = 0x0004; items.Add(down);
      INPUT up = new INPUT(); up.type = 1; up.U.ki.wScan = (ushort)c; up.U.ki.dwFlags = 0x0004 | 0x0002; items.Add(up);
    }
    return SendInput((uint)items.Count, items.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static uint Key(int vk, bool up, bool extended) {
    INPUT item = new INPUT();
    item.type = 1;
    item.U.ki.wVk = (ushort)vk;
    item.U.ki.dwFlags = (up ? 0x0002u : 0u) | (extended ? 0x0001u : 0u);
    return SendInput(1, new INPUT[] { item }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
`;

/** The window half: enumeration and focus. Separate because most calls do not need it. */
const NATIVE_WINDOWS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshWindows {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);

  // One line per window, fields joined by U+0001 so a title can contain anything else.
  public static string[] List(int limit) {
    var rows = new List<string>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr lParam) {
      if (rows.Count >= limit) return false;
      if (!IsWindowVisible(hwnd)) return true;
      int length = GetWindowTextLengthW(hwnd);
      if (length <= 0) return true;
      var text = new StringBuilder(length + 1);
      GetWindowTextW(hwnd, text, text.Capacity);
      string title = text.ToString();
      if (title.Trim().Length == 0) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      RECT rect; GetWindowRect(hwnd, out rect);
      rows.Add(string.Join("\u0001", new string[] {
        hwnd.ToInt64().ToString(), pid.ToString(), title,
        rect.Left.ToString(), rect.Top.ToString(), rect.Right.ToString(), rect.Bottom.ToString(),
        IsIconic(hwnd) ? "1" : "0"
      }));
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  // First visible window whose title contains the needle; returns its title, or null.
  public static string Focus(string needle) {
    string hit = null;
    EnumWindows(delegate(IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd)) return true;
      int length = GetWindowTextLengthW(hwnd);
      if (length <= 0) return true;
      var text = new StringBuilder(length + 1);
      GetWindowTextW(hwnd, text, text.Capacity);
      string title = text.ToString();
      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      ShowWindow(hwnd, 9); // SW_RESTORE
      SetForegroundWindow(hwnd);
      hit = title;
      return false;
    }, IntPtr.Zero);
    return hit;
  }
}
"@
`;

/** A base64 UTF-8 literal for a PowerShell expression - the only way text enters a script. */
export function psLiteral(value) {
  const base64 = Buffer.from(String(value ?? ""), "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))`;
}

/**
 * Finish a script by printing one JSON object.
 *
 * The value goes through a variable first: `ConvertTo-Json -InputObject [ordered]@{…}` is not valid
 * PowerShell - in an argument position `[ordered]@{}` is read as a type constraint, not a hashtable -
 * and the failure is a parse error at the first line of the object, which is a confusing place for it.
 */
function emit(expression) {
  return `$__out = ${expression}\n[Console]::Out.Write((ConvertTo-Json -InputObject $__out -Compress -Depth 5))`;
}

/** Refuse a coordinate that is not a finite integer, naming what arrived instead. */
export function coordinate(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是数字，收到 ${JSON.stringify(value)}`);
  const rounded = Math.round(number);
  if (Math.abs(rounded) > 100000) throw new Error(`${label} 超出合理范围：${rounded}`);
  return rounded;
}

/** The PowerShell that reports the screen geometry and where the pointer is. */
export function screenScript() {
  return [
    DPI,
    NATIVE_INPUT,
    "$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$pointer = [System.Windows.Forms.Cursor]::Position",
    emit("[ordered]@{ ok = $true; virtualX = $screen.X; virtualY = $screen.Y; width = $screen.Width; height = $screen.Height; " +
      "monitors = [System.Windows.Forms.Screen]::AllScreens.Count; pointerX = $pointer.X; pointerY = $pointer.Y; " +
      "structSize = [DshInput]::StructSize(); primaryWidth = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; " +
      "primaryHeight = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height }"),
  ].join("\n");
}

/** The PowerShell that lists visible top-level windows. */
export function windowsScript({ limit = 40 } = {}) {
  const cap = Math.max(1, Math.min(200, Math.round(Number(limit) || 40)));
  return [
    DPI,
    NATIVE_WINDOWS,
    `$rows = [DshWindows]::List(${cap})`,
    "$items = @()",
    "foreach ($row in $rows) {",
    "  $f = $row -split [char]1",
    "  $items += [ordered]@{ hwnd = $f[0]; pid = [int]$f[1]; title = $f[2]; x = [int]$f[3]; y = [int]$f[4]; " +
      "w = [int]$f[5] - [int]$f[3]; h = [int]$f[6] - [int]$f[4]; minimized = ($f[7] -eq '1') }",
    "}",
    emit("[ordered]@{ ok = $true; count = $items.Count; windows = $items }"),
  ].join("\n");
}

/** The PowerShell that brings the first window whose title contains `needle` to the front. */
export function focusScript({ title } = {}) {
  const needle = String(title ?? "").trim();
  if (!needle) throw new Error("需要一个 title（窗口标题的一部分）");
  return [
    DPI,
    NATIVE_WINDOWS,
    `$needle = ${psLiteral(needle)}`,
    "$hit = [DshWindows]::Focus($needle)",
    emit("[ordered]@{ ok = $true; requested = $needle; focused = $hit; found = ($null -ne $hit) }"),
  ].join("\n");
}

/**
 * The PowerShell that captures the screen (or a region of it) to a PNG.
 *
 * `region` is in the same coordinates `desktop_screen` reports; omitting it captures the whole virtual
 * screen, which spans every monitor. The file is written by .NET, so no image tool is needed.
 */
export function screenshotScript({ path, region } = {}) {
  const target = String(path ?? "").trim();
  if (!target) throw new Error("需要一个保存路径");
  const box = region
    ? [coordinate(region.x, "region.x"), coordinate(region.y, "region.y"),
       coordinate(region.width, "region.width"), coordinate(region.height, "region.height")]
    : null;
  if (box && (box[2] <= 0 || box[3] <= 0)) throw new Error(`区域宽高必须大于 0，收到 ${box[2]}x${box[3]}`);
  const lines = [DPI, NATIVE_INPUT];
  if (box) {
    lines.push(`$x = ${box[0]}; $y = ${box[1]}; $w = ${box[2]}; $h = ${box[3]}`);
  } else {
    lines.push("$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen");
    lines.push("$x = $screen.X; $y = $screen.Y; $w = $screen.Width; $h = $screen.Height");
  }
  lines.push(
    `$path = ${psLiteral(target)}`,
    "$bitmap = New-Object System.Drawing.Bitmap $w, $h",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)",
    "$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$graphics.Dispose(); $bitmap.Dispose()",
    "$info = Get-Item -LiteralPath $path",
    emit("[ordered]@{ ok = $true; path = $info.FullName; width = $w; height = $h; bytes = $info.Length }"),
  );
  return lines.join("\n");
}

/**
 * The PowerShell for one mouse action.
 *
 * The pointer is positioned with `SetCursorPos` (exact pixels) and the button or wheel event follows
 * with `mouse_event`, which needs no coordinates and therefore cannot drift. `drag` presses at the
 * start, moves in two steps and releases at the target.
 */
export function mouseScript({ action, x, y, toX, toY, amount, button = "left", steps = 12 } = {}) {
  const what = String(action ?? "").trim();
  if (!MOUSE_ACTIONS.includes(what)) {
    throw new Error(`action 只能是 ${MOUSE_ACTIONS.join(" / ")} 之一，收到 ${JSON.stringify(action)}`);
  }
  const fields = { action: what };
  if (what === "scroll") {
    const notches = Math.round(Number(amount));
    if (!Number.isFinite(notches) || notches === 0) throw new Error("scroll 需要一个非零的 amount（正数向上，负数向下）");
    if (Math.abs(notches) > 20) throw new Error(`一次滚动最多 20 格，收到 ${notches}`);
    const px = x === undefined ? undefined : coordinate(x, "x");
    const py = y === undefined ? undefined : coordinate(y, "y");
    const lines = [DPI, NATIVE_INPUT];
    if (px !== undefined && py !== undefined) lines.push(`[DshInput]::SetCursorPos(${px}, ${py}) | Out-Null`);
    lines.push(`[DshInput]::mouse_event(${C.wheel}, 0, 0, ${notches * 120}, [UIntPtr]::Zero)`);
    lines.push("$pointer = [System.Windows.Forms.Cursor]::Position");
    lines.push(emit(`[ordered]@{ ok = $true; action = 'scroll'; amount = ${notches}; pointerX = $pointer.X; pointerY = $pointer.Y }`));
    return lines.join("\n");
  }
  const px = coordinate(x, "x");
  const py = coordinate(y, "y");
  const lines = [DPI, NATIVE_INPUT, `[DshInput]::SetCursorPos(${px}, ${py}) | Out-Null`];
  const press = (down, up) => {
    lines.push(`[DshInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)`);
    lines.push(`[DshInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`);
  };
  if (what === "click" || what === "double_click") {
    const times = what === "double_click" ? 2 : 1;
    for (let i = 0; i < times; i += 1) press(button === "right" ? C.rightDown : button === "middle" ? C.middleDown : C.leftDown,
      button === "right" ? C.rightUp : button === "middle" ? C.middleUp : C.leftUp);
  } else if (what === "right_click") {
    press(C.rightDown, C.rightUp);
  } else if (what === "middle_click") {
    press(C.middleDown, C.middleUp);
  } else if (what === "drag") {
    const tx = coordinate(toX, "toX");
    const ty = coordinate(toY, "toY");
    const count = Math.max(1, Math.min(40, Math.round(Number(steps) || 12)));
    lines.push(`[DshInput]::mouse_event(${C.leftDown}, 0, 0, 0, [UIntPtr]::Zero)`);
    for (let i = 1; i <= count; i += 1) {
      const mx = Math.round(px + ((tx - px) * i) / count);
      const my = Math.round(py + ((ty - py) * i) / count);
      lines.push(`[DshInput]::SetCursorPos(${mx}, ${my}) | Out-Null`);
      lines.push("Start-Sleep -Milliseconds 8");
    }
    lines.push(`[DshInput]::mouse_event(${C.leftUp}, 0, 0, 0, [UIntPtr]::Zero)`);
    fields.toX = tx;
    fields.toY = ty;
  }
  lines.push("$pointer = [System.Windows.Forms.Cursor]::Position");
  lines.push(emit("[ordered]@{ ok = $true; action = '" + what + "'; x = " + px + "; y = " + py +
    (fields.toX !== undefined ? "; toX = " + fields.toX + "; toY = " + fields.toY : "") +
    "; pointerX = $pointer.X; pointerY = $pointer.Y }"));
  return lines.join("\n");
}

/** The PowerShell that types literal text with Unicode scan codes (so Chinese survives). */
export function typeScript({ text } = {}) {
  const value = String(text ?? "");
  if (!value) throw new Error("需要一个 text");
  if (value.length > 2000) throw new Error(`一次最多输入 2000 个字符，收到 ${value.length}`);
  return [
    DPI,
    NATIVE_INPUT,
    `$text = ${psLiteral(value)}`,
    "$sent = [DshInput]::TypeText($text)",
    emit("[ordered]@{ ok = $true; chars = $text.Length; events = [int]$sent }"),
  ].join("\n");
}

/**
 * Parse a key chord like `ctrl+shift+s` into virtual-key codes, refusing unknown names by name.
 * Letters, digits and punctuation come from `VkKeyScan`, so `ctrl+.` and `alt+1` work too.
 */
export function parseChord(chord) {
  const raw = String(chord ?? "").trim();
  if (!raw) throw new Error("需要一个 keys，例如 ctrl+s");
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`无法解析 keys：${JSON.stringify(chord)}`);
  return parts.map((name) => {
    const key = name.toLowerCase();
    if (Object.hasOwn(VK, key)) return VK[key];
    if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 0x30 && code <= 0x5a) return code; // digits, letters, and the punctuation between them
    }
    throw new Error(`不认识的按键名：${JSON.stringify(name)}（可用：字母、数字、${Object.keys(VK).join("/")}）`);
  });
}

/** The PowerShell that presses a chord: modifiers down in order, then everything up in reverse. */
export function keyScript({ keys } = {}) {
  const codes = parseChord(keys);
  const presses = codes
    .map((code) => `[DshInput]::Key(${code}, $false, ${EXTENDED_KEYS.has(code) ? "$true" : "$false"}) | Out-Null`)
    .join("\n");
  const releases = [...codes]
    .reverse()
    .map((code) => `[DshInput]::Key(${code}, $true, ${EXTENDED_KEYS.has(code) ? "$true" : "$false"}) | Out-Null`)
    .join("\n");
  return [
    DPI,
    NATIVE_INPUT,
    presses,
    "Start-Sleep -Milliseconds 30",
    releases,
    emit(`[ordered]@{ ok = $true; keys = ${JSON.stringify(String(keys).trim())}; codes = @(${codes.join(", ")}) }`),
  ].join("\n");
}

/**
 * Pull the JSON object out of whatever PowerShell printed.
 *
 * `Add-Type` and warnings can land on stdout before the answer, so the last line that parses wins; a
 * result without `ok: true` becomes an error carrying the reason the script reported.
 */
export function parseDesktopOutput(stdout) {
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("脚本没有输出（桌面操作可能需要交互式会话）");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.ok === false) throw new Error(String(parsed.error ?? "脚本报告失败"));
    return parsed;
  }
  throw new Error(`脚本输出无法解析：${text.slice(0, 200)}`);
}

/** Whether desktop control can work at all on this machine, and why not when it cannot. */
export function desktopSupport({ platform = process.platform } = {}) {
  if (platform === "win32") return { ok: true, missing: [] };
  return { ok: false, missing: ["win32"], reason: `桌面操作目前只在 Windows 上实现（本机是 ${platform}）` };
}

/**
 * Run one generated script and parse its answer.
 *
 * Both `exec` and `platform` are injectable, and for the same reason: a suite has to be able to drive
 * the whole tool path on a machine that is not Windows, and the platform guard is the first thing that
 * would otherwise stop it - which is exactly how this failed on the Linux runner while passing here.
 */
export async function runDesktopScript(script, { timeoutMs = DESKTOP_TIMEOUT_MS, exec = execFile, platform = process.platform } = {}) {
  const support = desktopSupport({ platform });
  if (!support.ok) throw new Error(support.reason);
  const stdout = await new Promise((resolve, reject) => {
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, out, err) => {
        if (error) {
          // PowerShell writes the message first and the call stack after it, so the *first* non-empty
          // stderr line is the sentence worth keeping; `error.message` would repeat the whole script.
          const detail = String(err ?? "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
          reject(new Error(detail || String(error.message).split("\n")[0]));
          return;
        }
        resolve(String(out ?? ""));
      });
  });
  return parseDesktopOutput(stdout);
}

export async function desktopScreen(options = {}) {
  return runDesktopScript(screenScript(), options);
}

export async function desktopWindows({ limit, ...options } = {}) {
  return runDesktopScript(windowsScript({ limit }), options);
}

export async function desktopFocus({ title, ...options } = {}) {
  return runDesktopScript(focusScript({ title }), options);
}

export async function desktopScreenshot({ path, region, ...options } = {}) {
  const info = await runDesktopScript(screenshotScript({ path, region }), options);
  const size = statSync(info.path).size;
  return { ...info, bytes: size };
}

export async function desktopMouse(options = {}) {
  return runDesktopScript(mouseScript(options), options);
}

export async function desktopType({ text, ...options } = {}) {
  return runDesktopScript(typeScript({ text }), options);
}

export async function desktopKey({ keys, ...options } = {}) {
  return runDesktopScript(keyScript({ keys }), options);
}
