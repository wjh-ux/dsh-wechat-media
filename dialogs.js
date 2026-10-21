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

import { runDesktopScript } from "./desktop.js";

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
export function fileDialogScript({ title = "选择文件", initial = "" } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Title = ${psQuote(title)}`,
    "$d.CheckFileExists = $false",
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
export async function pickFolder({ title = "选择文件夹", initial = "", run = runDesktopScript } = {}) {
  const answer = await run(folderDialogScript({ title, initial }));
  return { path: String(answer?.path ?? "").trim() };
}

export async function pickFile({ title = "选择文件", initial = "", run = runDesktopScript } = {}) {
  const answer = await run(fileDialogScript({ title, initial }));
  return { path: String(answer?.path ?? "").trim() };
}
