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
  assert.match(host, /ensureAgent\("vscode", chatId, cwd \? "VS Code 项目"/, "through the same ensureAgent a chat uses");
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

await test("streaming is a real turn written as it arrives, filtered by session", () => {
  assert.match(host, /path: "\/dsh-vscode\/stream"/, "a streaming route exists");
  assert.match(host, /text\/event-stream/, "it speaks SSE");
  assert.match(host, /header\?\.id \?\? ""\) !== sessionId/, "and only forwards its own session's deltas");
  assert.match(host, /type: "delta"/, "chunks are typed");
  assert.match(host, /type: "done"/, "so is the end");
  const client = readFileSync(new URL("../vscode-extension/extension.js", import.meta.url), "utf8");
  assert.match(client, /function streamAsk/, "the editor reads the stream incrementally");
  assert.match(client, /onDelta\(event\.text\)/, "calling back per chunk");
  assert.match(client, /class="msg dsh streaming"|dsh streaming/, "and the panel paints into a growing bubble");
});

await test("the editor can ask DSH to change the project, inside a real sandbox", () => {
  // Reading is not the same as editing: the session has to run *in* the project, and it has to be given a sandbox that
  // permits writes there and nothing wider. `never` means an editor request can never wait for a person who is not there.
  assert.match(host, /async function enforceProjectMode/, "there is a mode helper");
  assert.match(host, /const mode = writable \? "workspace-write" : "read-only"/, "writes and reads are both expressible");
  assert.match(host, /setApprovalPolicy\?\.\(session, "never"\)/, "and nothing waits on an absent approver");
  assert.match(host, /const projectCwd = String\(options\.cwd/, "the project directory drives the session's cwd");
  assert.match(host, /"project:" \+ cwd\.toLowerCase\(\)/, "each project gets its own session, so histories do not mix");
  assert.match(host, /write: writable/, "and the write flag reaches ensureAgent");
  // The route must not trust the folder it is handed: a relative path would attach the request to whatever directory
  // DSH runs from, and an edit would land somewhere the person never opened.
  assert.match(host, /function editorProject\(body/, "the request is parsed in one place");
  assert.match(host, /raw && isAbsolute\(raw\) \? raw : ""/, "and only an absolute folder counts as a project");
  // `ask` and `never` are both policies; whoever writes last wins, and the project session must be left on `never`.
  assert.match(host, /if \(!options\.cwd\) \{/, "a project session is not put back on `ask` behind enforceProjectMode");

  const client = readFileSync(new URL("../vscode-extension/extension.js", import.meta.url), "utf8");
  assert.match(client, /function projectCwd/, "the editor knows its folder");
  assert.match(client, /write: write \? "1" : "0"/, "and states whether it may edit");
  assert.match(client, /id="write"/, "the panel has a visible 可写 switch");
  assert.match(client, /toggle-write/, "which is not a hidden setting");
});

await test("the open project can be sent as context", () => {
  const client = readFileSync(new URL("../vscode-extension/extension.js", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../vscode-extension/package.json", import.meta.url), "utf8"));
  assert.match(client, /async function projectSnapshot/, "there is a snapshot builder");
  assert.match(client, /PROJECT_IGNORES/, "with an ignore list");
  assert.match(client, /node_modules/, "that skips dependencies - a tree full of them is not context");
  assert.match(client, /maxEntries/, "and a bound on how much it walks");
  assert.match(client, /raw === "项目"/, "@项目 is recognised");
  assert.match(client, /projectSnapshot\(\)/, "and expands to the snapshot");
  assert.match(client, /KEY_FILES/, "including the files that explain the project");
  assert.match(client, /没有打开的工作区/, "with a sentence when nothing is open, not a crash");
  const ids = manifest.contributes.commands.map((command) => command.command);
  assert.ok(ids.includes("dsh.project"), "the command is declared");
  assert.match(client, /id="project"/, "the panel has a 项目 button");
});

await test("an @file reference becomes real content, and a missing file is reported", () => {
  const client = readFileSync(new URL("../vscode-extension/extension.js", import.meta.url), "utf8");
  assert.match(client, /async function expandFileRefs/, "there is an expander");
  assert.match(client, /@\(\?:"\(\[\^"\]\+\)"\|\(\[\^\\s@\]\+\)\)/, "it understands @path and @\"path with spaces\"");
  assert.match(client, /60_000|60000/, "and refuses files too big to be useful context");
  assert.match(client, /找不到/, "reporting a missing file instead of silently dropping the @");
  assert.match(client, /type: "pick"/, "a file picker exists, because nobody types a path they cannot see");
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
