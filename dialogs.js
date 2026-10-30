/**
 * Native Windows dialogs the panel can open on the person's own screen.
 *
 * Why this exists at all: a browser cannot hand a page an absolute path. `<input type="file" webkitdirectory>` gives
 * only relative names, and `showDirectoryPicker()` deliberately hides the real path. So "browse for a folder" has to
 * be asked of the machine - the plugin process runs on that machine, a small PowerShell script shows the ordinary
 * Windows folder dialog, and the chosen path comes back as text.
 *
 * The dialog is modal to nothing: it floats above other windows, and cancelling it is a normal answer (`path: ""`),
 * not an error - a person changing their mind is not a failure.
 */

import { execFile } from "node:child_process";

/** Single-quote a string for PowerShell: `'it''s'` - the only escape that language needs in a literal. */
export function psQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/**
 * The script that shows the folder dialog.
 *
 * `-STA` matters: the WinForms dialog needs a single-threaded apartment, and the caller passes it. `ShowDialog()`
 * without an owner puts the window in front of whatever is focused, which is what "browse" should do.
 */
export function folderDialogScript({ title = "选择文件夹", initial = "" } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description = ${psQuote(title)}`,
    "$d.ShowNewFolderButton = $true",
    ...(String(initial ?? "").trim() ? [`$d.SelectedPath = ${psQuote(initial)}`] : []),
    "$r = $d.ShowDialog()",
    "$p = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath } else { '' }",
    "@{ ok = $true; path = $p } | ConvertTo-Json -Compress",
  ].join("\n");
}

/** The same for one file, so a flow can point at an existing `.csv` if that is what the person wants. */
export function fileDialogScript({ title = "选择文件", initial = "", filter = "" } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Title = ${psQuote(title)}`,
    "$d.CheckFileExists = $false",
    // A filter is what stops "选择 Keil 工程" from listing every file in the folder; the Windows Forms syntax is
    // `说明|模式|说明|模式`, and it only goes in when a caller asked for one.
    ...(String(filter ?? "").trim() ? [`$d.Filter = ${psQuote(filter)}`] : []),
    ...(String(initial ?? "").trim() ? [`$d.InitialDirectory = ${psQuote(initial)}`] : []),
    "$r = $d.ShowDialog()",
    "$p = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName } else { '' }",
    "@{ ok = $true; path = $p } | ConvertTo-Json -Compress",
  ].join("\n");
}

/**
 * Show the folder dialog and return the chosen path, or `""` when the person cancelled.
 *
 * `runDesktopScript` is injectable so a suite can assert the script without opening a window on a machine that has
 * no screen - which is every CI runner.
 */
/**
 * Run one dialog script and return the JSON it printed.
 *
 * Deliberately **not** `runDesktopScript`: that one launches with `windowsHide: true`, which can leave the child
 * without a usable window - and a dialog nobody can see is a dialog that never appears. The lesson is already in
 * this plugin's history (the inbox folder picker uses `windowsHide: false` for the same reason), so the flag is
 * spelled out here rather than inherited from a helper built for screenshots.
 */
export async function runDialogScript(script, { timeoutMs = 300000, exec = execFile, platform = process.platform } = {}) {
  if (platform !== "win32") throw new Error(`文件夹选择框目前只在 Windows 上实现（本机是 ${platform}）`);
  const stdout = await new Promise((resolve, reject) => {
    exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { windowsHide: false, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, out, err) => {
        if (error) {
          // The first non-empty stderr line is the sentence worth keeping; the rest is a PowerShell stack.
          const detail = String(err ?? "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
          reject(new Error(detail || String(error.message).split("\n")[0]));
          return;
        }
        resolve(String(out ?? ""));
      },
    );
  });
  const parsed = parseDialogOutput(stdout);
  if (parsed?.ok === false) throw new Error(String(parsed.error ?? "对话框报告失败"));
  return parsed ?? {};
}

/** The last line that parses as JSON - `Add-Type` and warnings can land on stdout before the answer. */
export function parseDialogOutput(stdout) {
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  return null;
}

export async function pickFolder({ title = "选择文件夹", initial = "", run = runDialogScript } = {}) {
  const answer = await run(folderDialogScript({ title, initial }));
  return { path: String(answer?.path ?? "").trim() };
}

export async function pickFile({ title = "选择文件", initial = "", filter = "", run = runDialogScript } = {}) {
  const answer = await run(fileDialogScript({ title, initial }));
  return { path: String(answer?.path ?? "").trim() };
}
