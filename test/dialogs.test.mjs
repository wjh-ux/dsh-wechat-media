// The folder dialog's contract: the script it builds, what a cancel means, and the plugin wiring that exposes it to
// the panel. Nothing here opens a window - `run` is injected, which is the whole reason the dialog was written as a
// pair of pure-ish functions rather than inline PowerShell in a route handler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const { psQuote, folderDialogScript, fileDialogScript, pickFolder, pickFile, parseDialogOutput } = await import("../dialogs.js");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

await test("a path is quoted the one way PowerShell needs", () => {
  assert.equal(psQuote("D:\\导出"), "'D:\\导出'");
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote(""), "''");
});

await test("the folder script starts a real folder dialog, and seeds it with the current folder", () => {
  const script = folderDialogScript({ title: "选择流程导出文件夹", initial: "C:\\Users\\me\\.dsh\\exports" });
  assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/);
  assert.match(script, /New-Object System\.Windows\.Forms\.FolderBrowserDialog/);
  assert.match(script, /\$d\.Description = '选择流程导出文件夹'/);
  assert.ok(script.includes("$d.SelectedPath = 'C:\\Users\\me\\.dsh\\exports'"), "the current directory is where the dialog opens");
  assert.match(script, /ConvertTo-Json -Compress/, "the answer is one JSON line, which is what the parser expects");
  // No initial path: the seeding line is simply absent rather than set to an empty string, which WinForms would
  // reject. (The word `SelectedPath` still appears - it is how the chosen path is read back.)
  assert.doesNotMatch(folderDialogScript({}), /\$d\.SelectedPath = /);
});

await test("the file script uses the file dialog", () => {
  const script = fileDialogScript({ title: "选择文件" });
  assert.match(script, /OpenFileDialog/);
  assert.match(script, /\$d\.Title = '选择文件'/);
});

await test("a chosen path comes back trimmed, and a cancel is an empty answer rather than an error", async () => {
  const asked = [];
  const chosen = await pickFolder({ run: async (script) => { asked.push(script); return { ok: true, path: "  D:\\导出  " }; } });
  assert.equal(chosen.path, "D:\\导出", "the path is trimmed");
  assert.match(asked[0], /FolderBrowserDialog/);

  const cancelled = await pickFolder({ run: async () => ({ ok: true, path: "" }) });
  assert.equal(cancelled.path, "", "cancelling is not a failure");

  const file = await pickFile({ run: async () => ({ ok: true, path: "C:\\a\\b.csv" }) });
  assert.equal(file.path, "C:\\a\\b.csv");
});

await test("the dialog process is started with a window: windowsHide can hide the dialog itself", () => {
  const source = readFileSync(new URL("../dialogs.js", import.meta.url), "utf8");
  assert.match(source, /windowsHide: false/, "the child keeps a window, or the dialog never shows");
  assert.doesNotMatch(source, /from "\.\/desktop\.js"/, "not the screenshot helper, which hides the window");
  assert.match(source, /"-STA"/, "WinForms dialogs need a single-threaded apartment");
});

await test("the answer is the last JSON line, after whatever Add-Type printed", () => {
  const noisy = "Add-Type: warning\n{\"ok\":true,\"path\":\"D:\\\\导出\"}\n";
  const parsed = parseDialogOutput(noisy);
  assert.equal(parsed.path, "D:\\导出");
  assert.equal(parseDialogOutput("nothing useful"), null, "no JSON is null, not a crash");
});

// The wiring: a route the panel can call, a button that calls it, and the module shipped with the package.
const pluginDir = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const host = readFileSync(joinPath(pluginDir, "index.js"), "utf8");
const panel = readFileSync(joinPath(pluginDir, "client.js"), "utf8");

await test("the panel can browse for the export directory, and the host opens the dialog", () => {
  assert.match(host, /path: "\/dsh-wechat-media\/export-dir"/, "the route exists");
  assert.match(host, /dialogs\.pickFolder\(/, "and it asks the machine rather than the page");
  assert.match(host, /state\.savePrefs\(\{ flowExportDir: picked\.path \}\)/, "a chosen folder is saved");
  assert.match(panel, /async function browseExportDir\(\)/, "the panel has the action");
  assert.match(panel, /api\("\/export-dir\?action=browse"\)/, "and calls the route");
  assert.match(panel, /t\("browse", "浏览…"\)/, "the button is labelled 浏览…");
});

await test("dialogs.js is shipped with the package", () => {
  const pkg = JSON.parse(readFileSync(joinPath(pluginDir, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("dialogs.js"), "dialogs.js is in the published files");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
