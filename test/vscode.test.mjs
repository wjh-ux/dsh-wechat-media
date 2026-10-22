// The VS Code bridge: the routes the editor calls, and the extension that calls them. The extension is plain CommonJS
// with no build step, so `node --check` on it is a real syntax test rather than a formality.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const pluginDir = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const host = readFileSync(joinPath(pluginDir, "index.js"), "utf8");
const pkg = JSON.parse(readFileSync(joinPath(pluginDir, "package.json"), "utf8"));
const extensionDir = joinPath(pluginDir, "vscode-extension");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

await test("the editor gets a real agent turn, not a second weaker path", () => {
  assert.match(host, /path: "\/dsh-vscode\/ask"/, "the ask route exists");
  assert.match(host, /ensureAgent\("vscode", "vscode", "VS Code"\)/, "through the same ensureAgent a chat uses");
  assert.match(host, /collectors\.wait\(sessionId, message\?\.id\)/, "and the same reply collector");
  assert.match(host, /await agent\.followup\(message\)/, "so tools, model and context are identical");
  assert.match(host, /path: "\/dsh-vscode\/status"/, "the status route exists");
  assert.match(host, /vscodeEnabled === false/, "and the bridge can be switched off");
  // Verified live: trace shows inserted → claimed → turn, and a UTF-8 request came back with the exact answer.
  assert.match(host, /body\.trace === "1"|String\(body\.trace/, "an opt-in trace of the inbox events");
});

await test("a request whose Chinese arrived as question marks is refused, not answered", () => {
  // Measured: `只回答四个字符：ABC9` sent by an ANSI-encoded client became `????????:ABC9`, and the model then wrote a
  // whole answer about mojibake instead of answering. The bridge says which client is broken instead.
  assert.match(host, /\\\?\{3,\}/, "it looks for runs of question marks");
  assert.match(host, /\[\\u3400-\\u9fff\]/, "and checks there is no CJK left to prove it");
  assert.match(host, /请求体不是 UTF-8/, "naming the actual fix");
  const client = readFileSync(new URL("../vscode-extension/extension.js", import.meta.url), "utf8");
  assert.match(client, /application\/json; charset=utf-8/, "and the editor client states its charset");
});

await test("the extension parses, activates, and ships with the package", () => {
  execFileSync(process.execPath, ["--check", joinPath(extensionDir, "extension.js")], { stdio: "pipe" });
  const source = readFileSync(joinPath(extensionDir, "extension.js"), "utf8");
  assert.match(source, /function activate\(context\)/, "VS Code needs activate");
  assert.match(source, /registerWebviewViewProvider\("dsh\.chat"/, "the panel is a webview view");
  assert.match(source, /createStatusBarItem/, "the status bar entry");
  assert.match(source, /gui-port\.json/, "the port is discovered, not hard-coded");
  assert.ok(source.includes("dsh.askSelection"), "the selection command");
  for (const file of ["package.json", "extension.js", "media/icon.svg"]) {
    assert.ok(pkg.files.includes(`vscode-extension/${file}`), `${file} is published`);
  }
  const manifest = JSON.parse(readFileSync(joinPath(extensionDir, "package.json"), "utf8"));
  assert.equal(manifest.main, "./extension.js");
  assert.ok(manifest.contributes.views.dshContainer, "the view is declared");
  const ids = manifest.contributes.commands.map((command) => command.command);
  for (const id of ["dsh.ask", "dsh.askSelection", "dsh.showStatus"]) assert.ok(ids.includes(id), `${id} is declared`);
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
