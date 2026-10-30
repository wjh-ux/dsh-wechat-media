/**
 * DSH Bridge for VS Code.
 *
 * Three ways in, all of them through the same endpoint the plugin exposes on loopback:
 *
 *   panel     a chat view in the activity bar - type, get the answer back in place
 *   commands  "DSH: 提问…" and "DSH: 用选中内容提问", so a selection can be sent without leaving the editor
 *   status    one status-bar item that says whether the plugin is reachable and what it is connected to
 *
 * No bundler, no TypeScript, no dependencies: VS Code runs this file as-is. The endpoint is discovered from
 * `gui-port.json` in the plugin's state directory, because that port changes on every DSH restart and hard-coding it
 * would mean "reconfigure after every restart".
 */

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

/** Where the plugin keeps its state, unless the person points somewhere else. */
function stateDir() {
  const configured = String(vscode.workspace.getConfiguration("dsh").get("stateDir") ?? "").trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".dsh", "dsh-wechat-media");
}

/** The address of the running plugin: configured, discovered, or empty. */
function endpoint() {
  const manual = String(vscode.workspace.getConfiguration("dsh").get("endpoint") ?? "").trim().replace(/\/$/, "");
  if (manual) return manual;
  return endpointCandidates()[0] ?? "";
}

/**
 * Every address worth trying, newest first.
 *
 * `gui-port.json` is written by the plugin, but it can lag one restart behind - measured: it said 1826 while the GUI was
 * on 63295, and the extension showed a bare "DSH" forever. The file keeps a `previousPort` and a short `history`, so the
 * fix is to try them rather than to trust one number.
 */
function endpointCandidates() {
  const ports = [];
  const push = (value) => {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port);
  };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir(), "gui-port.json"), "utf8"));
    push(saved?.port);
    push(saved?.previousPort);
    for (const entry of (Array.isArray(saved?.history) ? saved.history : []).slice(-6).reverse()) push(entry?.port);
  } catch {
    // No file yet: DSH has not written one, or the state directory is elsewhere.
  }
  return ports.map((port) => `http://127.0.0.1:${port}`);
}

/** The base URL that last answered, so a poll does not re-probe six ports every time. */
let activeBase = "";

/** One HTTP request to the plugin, with a timeout that fails as a sentence rather than a hang. */
function request(method, endpointPath, body, { timeoutMs = 180000, base = activeBase || endpoint() } = {}) {
  if (!base) return Promise.reject(new Error("找不到 DSH 地址：先启动 DSH，或在设置里填 dsh.endpoint"));
  const url = new URL(base + endpointPath);
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload ? { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) } : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
          if (!parsed) return reject(new Error(`插件返回了无法解析的内容：${text.slice(0, 200)}`));
          if (res.statusCode >= 400 || parsed.ok === false) {
            return reject(new Error(String(parsed.error ?? `HTTP ${res.statusCode}`)));
          }
          resolve(parsed);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("插件没有在 3 分钟内回答")));
    req.on("error", (error) => reject(error));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Created in `activate`. */
let statusItem;
let channel;
let lastStatus;
let pollTimer;

function renderStatus(status) {
  if (!statusItem) return;
  statusItem.show();
  if (!status) {
    statusItem.text = "$(circle-slash) DSH 未连接";
    statusItem.tooltip = "DSH 未连接（点击查看状态）";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }
  const bits = [];
  if (status.wechat?.accounts) bits.push(`微信 ${status.wechat.accounts}`);
  if (status.feishu?.configured) bits.push("飞书");
  if (status.browser?.extension) bits.push(`浏览器 ${status.browser.target || ""}`.trim());
  if (status.tasks) bits.push(`任务 ${status.tasks}`);
  statusItem.text = `$(comment-discussion) DSH${bits.length ? " · " + bits.join(" · ") : ""}`;
  statusItem.tooltip = [
    `DSH v${status.version ?? "?"} · ${status.enabled === false ? "编辑器桥已关闭（/vscode on）" : "在线"}`,
    bits.length ? bits.join(" · ") : "没有其他已连接的服务",
    "点击查看状态",
  ].join("\n");
  statusItem.backgroundColor = undefined;
}

/** Poll the plugin so the status bar tells the truth without the person asking. */
async function refreshStatus({ quiet = true } = {}) {
  const tried = [];
  for (const base of [activeBase, endpoint(), ...endpointCandidates()].filter(Boolean)) {
    if (tried.includes(base)) continue;
    tried.push(base);
    try {
      lastStatus = await request("GET", "/dsh-vscode/status", undefined, { timeoutMs: 4000, base });
      activeBase = base;
      renderStatus(lastStatus);
      return lastStatus;
    } catch (error) {
      if (!quiet && tried.length === 1) vscode.window.showErrorMessage(`DSH：${error.message}`);
    }
  }
  lastStatus = null;
  activeBase = "";
  renderStatus(null);
  return null;
}

/**
 * Ask through the streaming route: `onDelta` is called for every text chunk as it arrives, and the promise resolves
 * with the final answer.
 *
 * A separate function from `request` because the body has to be read incrementally - waiting for `end` is exactly the
 * behaviour this replaces.
 */
/**
 * Whether the editor session may edit the project.
 *
 * On by default when a folder is open: the whole point of asking about your own project from the editor is that the
 * answer can be applied. The panel shows a checkbox, because a writable agent deserves a visible switch rather than a
 * hidden setting.
 */
let writeEnabled = true;

/** The project the request is about: the first workspace folder, or empty when none is open. */
function projectCwd() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? "";
}

function streamAsk(prompt, { onDelta = () => {}, onStart = () => {}, timeoutMs = 600000, base = activeBase || endpoint(), cwd = "", write = true } = {}) {
  if (!base) return Promise.reject(new Error("找不到 DSH 地址：先启动 DSH，或在设置里填 dsh.endpoint"));
  const url = new URL(base + "/dsh-vscode/stream");
  const payload = JSON.stringify({ prompt, cwd, write: write ? "1" : "0" });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* fallthrough */ }
            reject(new Error(String(parsed?.error ?? `HTTP ${res.statusCode}`)));
          });
          return;
        }
        res.setEncoding("utf8");
        let buffer = "";
        let final = "";
        let settled = false;
        const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
        res.on("data", (chunk) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              let event;
              try { event = JSON.parse(line.slice(6)); } catch { continue; }
              if (event.type === "delta") {
                final += event.text;
                onDelta(event.text);
              } else if (event.type === "done") {
                finish(resolve, { text: event.text || final, stopReason: event.stopReason });
              } else if (event.type === "error") {
                finish(reject, new Error(String(event.error ?? "未知错误")));
              }
            }
          }
        });
        res.on("end", () => finish(resolve, { text: final, stopReason: "eof" }));
        onStart();
      },
    );
    req.on("timeout", () => req.destroy(new Error("DSH 没有在 10 分钟内回答")));
    req.on("error", (error) => reject(error));
    req.write(payload);
    req.end();
  });
}

/**
 * A snapshot of the open project: folder, file tree, the files that explain it.
 *
 * The point is that `@file` only answers about a file you already know about. "What is this project" needs the shape:
 * which folders exist, what the build file says, where the entry points are. All of it bounded - a snapshot that drags
 * in `node_modules` is not context, it is a denial of service on the prompt budget.
 */
const PROJECT_IGNORES = new Set([
  "node_modules", ".git", "dist", "out", "build", "target", ".venv", "venv", "__pycache__", ".next", ".nuxt",
  "coverage", ".idea", ".vscode", "vendor", "bin", "obj", ".gradle", ".dart_tool", "Pods",
]);

const KEY_FILES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "README.md", "README", "requirements.txt", "tsconfig.json"];

/** Walk the workspace, breadth-first, skipping the folders nobody wants in a prompt. */
async function projectTree(root, { maxEntries = 300, maxDepth = 4 } = {}) {
  const lines = [];
  const queue = [{ uri: root, depth: 0, prefix: "" }];
  let truncated = false;
  while (queue.length) {
    const { uri, depth, prefix } = queue.shift();
    let entries;
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      continue;
    }
    entries.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 2 ? -1 : 1));
    for (const [name, kind] of entries) {
      if (lines.length >= maxEntries) { truncated = true; break; }
      if (name.startsWith(".") && name !== ".env.example") continue;
      if (PROJECT_IGNORES.has(name)) continue;
      const isDir = kind === 2;
      lines.push(`${prefix}${isDir ? name + "/" : name}`);
      if (isDir && depth < maxDepth) queue.push({ uri: vscode.Uri.joinPath(uri, name), depth: depth + 1, prefix: prefix + "  " });
    }
    if (truncated) break;
  }
  return { lines, truncated };
}

/** The text a `@项目` reference expands into. */
async function projectSnapshot({ maxChars = 24000 } = {}) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) throw new Error("没有打开的工作区：先用「文件 → 打开文件夹」打开一个项目");
  const root = folders[0].uri;
  const name = folders[0].name;
  const { lines, truncated } = await projectTree(root);

  const parts = [`项目：${name}（${root.fsPath}）`, "", "文件树（已省略依赖与构建目录）：", "```", ...lines, truncated ? "…（已截断）" : "", "```"];

  // The files that explain the project, capped so one lockfile cannot eat the whole budget.
  const included = [];
  for (const candidate of KEY_FILES) {
    const uri = vscode.Uri.joinPath(root, candidate);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 8000) continue;
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      parts.push("", `文件 ${candidate}：`, "```", text.slice(0, 4000), "```");
      included.push(candidate);
      if (parts.join("\n").length > maxChars) break;
    } catch {
      // Not every project has every build file.
    }
  }

  const active = vscode.window.activeTextEditor?.document?.fileName;
  if (active) parts.push("", `当前打开的文件：${vscode.workspace.asRelativePath(active, false)}`);

  const text = parts.join("\n");
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) + "\n…（快照已截断）" : text,
    name,
    files: lines.length,
    keyFiles: included,
  };
}

/**
 * Expand `@file` references in a prompt into real file content.
 *
 * A path is taken literally (quoted or not) and resolved against the workspace folder first, then as an absolute path.
 * The content is fenced and labelled, so the model can tell where each block came from - and a missing file is reported
 * as a sentence instead of silently sending a dangling `@`. `@项目` (or `@project`) is special: it expands to the
 * project snapshot above, which is the one reference a person cannot type as a path.
 */
async function expandFileRefs(text) {
  const source = String(text ?? "");
  const pattern = /@(?:"([^"]+)"|([^\s@]+))/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) return { prompt: source, attached: [], problems: [] };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const attached = [];
  const problems = [];
  let prompt = source;
  for (const match of matches) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;
    if (raw === "项目" || /^project$/i.test(raw)) {
      try {
        const snapshot = await projectSnapshot();
        attached.push({ path: `项目 ${snapshot.name}`, chars: snapshot.text.length });
        prompt = prompt.replace(match[0], `\n\n${snapshot.text}\n`);
      } catch (error) {
        problems.push(String(error?.message ?? error));
      }
      continue;
    }
    const candidates = [];
    if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) candidates.push(vscode.Uri.file(raw));
    else if (root) candidates.push(vscode.Uri.joinPath(root, raw));
    let content = null;
    let used = null;
    let tooBig = false;
    for (const uri of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 60_000) { tooBig = true; used = uri; break; }
        content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        used = uri;
        break;
      } catch {
        // try the next candidate
      }
    }
    const label = used ? vscode.workspace.asRelativePath(used, false) : raw;
    if (tooBig) {
      problems.push(`${label} 太大（>60 KB），没有附上`);
      continue;
    }
    if (content === null) {
      problems.push(`${label} 找不到`);
      continue;
    }
    attached.push({ path: label, chars: content.length });
    prompt = prompt.replace(match[0], `\n\n文件 ${label}：\n\`\`\`\n${content}\n\`\`\``);
  }
  return { prompt, attached, problems };
}

/** Ask the plugin a question and return its answer text. */
async function ask(prompt, { sessionHint = "", onDelta } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("问题是空的");
  const { prompt: expanded, attached, problems } = await expandFileRefs(text);
  const withHint = sessionHint ? `${expanded}\n\n（上下文：${sessionHint}）` : expanded;
  const answer = await streamAsk(withHint, { onDelta, cwd: projectCwd(), write: writeEnabled });
  const reply = String(answer.text ?? "").trim();
  // An empty answer is not a success: the route reports *why* (`stopReason`), and that reason is the only thing that
  // makes the failure fixable - showing a blank bubble would look like the model said nothing.
  if (!reply) throw new Error(`DSH 没有给出内容（stopReason: ${answer.stopReason ?? "unknown"}）`);
  return { reply, attached, problems };
}

/**
 * The chat panel.
 *
 * A webview, because a chat needs an input box and history; everything it can do is one message to this extension,
 * which does the HTTP call - the webview never talks to the plugin itself, so the endpoint stays in one place.
 */
class ChatView {
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = chatHtml();
    const announce = () => {
      const cwd = projectCwd();
      const name = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
      webviewView.webview.postMessage({
        type: "where",
        text: cwd ? `项目：${name}（${writeEnabled ? "可改" : "只读"}）` : "没有打开文件夹（只读）",
      });
      webviewView.webview.postMessage({ type: "write-state", value: writeEnabled });
      // Which project the Compile/Flash buttons will act on - the panel should not make a person guess.
      keilState()
        .then((state) => {
          webviewView.webview.postMessage({
            type: "keil-state",
            project: String(state?.project ?? ""),
            target: String(state?.target ?? ""),
            uv4: Boolean(state?.uv4),
          });
        })
        .catch(() => {
          webviewView.webview.postMessage({ type: "keil-state", project: "", target: "", uv4: false });
        });
    };
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "pick") {
        // Picking files by hand is what makes `@` discoverable: nobody types a path they cannot see.
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: "附上",
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!picked?.length) return;
        const paths = picked.map((uri) => vscode.workspace.asRelativePath(uri, false));
        webviewView.webview.postMessage({ type: "picked", paths });
        return;
      }
      if (message?.type === "ready") {
        announce();
        return;
      }
      if (message?.type === "keil") {
        // The buttons call the plugin directly: one HTTP call, no model turn, and the plugin's own gates decide.
        const action = String(message.action ?? "build");
        const label = action === "flash" ? "烧录" : "编译";
        try {
          const result = await runKeil(action);
          webviewView.webview.postMessage({ type: "keil-result", ok: Boolean(result?.ok), label, text: String(result?.text ?? "") });
        } catch (error) {
          webviewView.webview.postMessage({ type: "keil-result", ok: false, label, text: String(error?.message ?? error) });
        }
        return;
      }
      if (message?.type === "open-project") {
        // "编辑" starts with getting to the file people actually change: main.c beside the .uvprojx, else the project.
        try {
          const state = await keilState();
          const project = String(state?.project ?? "").trim();
          if (!project) {
            vscode.window.showInformationMessage("还没设置 Keil 工程：在聊天里用 /keil project <路径>，或面板里点浏览");
            return;
          }
          const dir = project.replace(/[\\/][^\\/]+$/, "");
          const main = vscode.Uri.file(dir + "\\main.c");
          let target = vscode.Uri.file(project);
          try {
            await vscode.workspace.fs.stat(main);
            target = main;
          } catch {
            // no main.c beside it: the project file itself is still worth opening
          }
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
        } catch (error) {
          vscode.window.showErrorMessage("打开工程失败：" + String(error?.message ?? error));
        }
        return;
      }
      if (message?.type === "toggle-write") {
        writeEnabled = Boolean(message.value);
        announce();
        return;
      }
      if (message?.type !== "ask") return;
      const webview = webviewView.webview;
      let partial = "";
      try {
        const result = await ask(message.text, {
          onDelta: (chunk) => {
            partial += chunk;
            webview.postMessage({ type: "delta", text: partial, attached: null });
          },
        });
        webview.postMessage({
          type: "answer",
          text: result.reply,
          attached: result.attached,
          problems: result.problems,
        });
      } catch (error) {
        webview.postMessage({ type: "error", text: String(error?.message ?? error), partial });
      }
    });
  }
}

/**
 * Compile or flash the remembered Keil project through the same tool the chat calls.
 *
 * No model turn: a button that says "编译" should compile. The plugin's own gates still decide (`/keil on`,
 * `/serial on`), so this cannot arm anything the person has not armed.
 */
async function runKeil(action) {
  return request("POST", "/dsh-wechat-media/keil-run", { action }, { timeoutMs: 900000 });
}

/** What the panel needs to draw its Keil row: the project, its targets, and whether UV4 was found. */
async function keilState() {
  return request("GET", "/dsh-wechat-media/keil", undefined, { timeoutMs: 15000 });
}

/**
 * The panel's HTML. Inline by design: one file to read, nothing to load from disk.
 *
 * Laid out for a *sidebar*, which is where it lives: 300px wide, and often short. So the log takes every pixel that is
 * left and scrolls, the composer is pinned to the bottom, and the input gets its own row - putting a textarea, two
 * attach buttons and Send on one line is what made the first version unreadable at that width.
 */
function chatHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { height: 100%; }
  body {
    font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground);
    margin: 0; display: flex; flex-direction: column; overflow: hidden;
  }
  #log { flex: 1 1 auto; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  #log:empty::before {
    content: "问什么都可以。Ctrl+Enter 或 Enter 发送，Shift+Enter 换行，@文件 附上内容。";
    opacity: .55; font-size: 12px;
  }
  .msg { padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .me { background: var(--vscode-input-background); }
  .dsh { background: var(--vscode-editorWidget-background); border-left: 2px solid var(--vscode-focusBorder); }
  .dsh.streaming::after { content: "▍"; opacity: .5; animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }
  .tool { font: 11.5px/1.45 var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); border-left: 2px solid var(--vscode-charts-blue, #3794ff); max-height: 45vh; overflow: auto; }
  .tool.bad { border-left-color: var(--vscode-errorForeground); }
  .tool .tool-head { font-family: var(--vscode-font-family); opacity: .8; margin-bottom: 4px; }
  .meta-line { opacity: .7; font-size: 11px; font-style: italic; }
  .err { color: var(--vscode-errorForeground); }
  .meta { opacity: .6; font-size: 11px; margin-top: 2px; }
  #composer { flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 8px; }
  textarea {
    display: block; width: 100%; box-sizing: border-box; min-height: 58px; max-height: 40vh; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; font: inherit;
  }
  #bar { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  #bar .gap { flex: 1 1 auto; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; padding: 5px 10px; cursor: pointer; font: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  #foot { display: flex; gap: 8px; align-items: center; margin-top: 6px; font-size: 11px; opacity: .85; min-width: 0; }
  #foot label { display: flex; gap: 4px; align-items: center; cursor: pointer; white-space: nowrap; }
  #where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #keil { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  #keil.none { opacity: .6; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" placeholder="问 DSH…"></textarea>
    <div id="bar">
      <button id="project" title="附上当前项目（插入 @项目）">项目</button>
      <button id="file" title="附上文件（插入 @路径）">＋文件</button>
      <button id="build" title="编译当前 Keil 工程（与聊天里的 keil_build 同一个工具）">编译</button>
      <button id="flash" title="编译产物烧到板子（STC 自动走 stcgal）">烧录</button>
      <span class="gap"></span>
      <button id="send" class="primary">发送</button>
    </div>
    <div id="foot">
      <label title="允许 DSH 修改这个项目里的文件"><input type="checkbox" id="write" checked> 可写</label>
      <span id="where"></span>
      <span id="keil" class="none" title="点击打开工程文件">Keil：读取中…</span>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const buildBtn = document.getElementById("build");
  const flashBtn = document.getElementById("flash");
  const keilChip = document.getElementById("keil");

  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 40; }
  function scrollDown(force) { if (force || atBottom()) log.scrollTop = log.scrollHeight; }

  function add(kind, text, meta) {
    const el = document.createElement("div");
    el.className = "msg " + kind;
    el.textContent = text;
    if (meta) {
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = meta;
      el.appendChild(m);
    }
    log.appendChild(el);
    scrollDown(true);
    return el;
  }

  /** A tool result: monospace, scrollable, and it says which command produced it. */
  function addTool(head, text, ok) {
    const el = document.createElement("div");
    el.className = "msg tool" + (ok ? "" : " bad");
    const h = document.createElement("div");
    h.className = "tool-head";
    h.textContent = head;
    const body = document.createElement("div");
    body.textContent = text || "（没有输出）";
    el.appendChild(h);
    el.appendChild(body);
    log.appendChild(el);
    scrollDown(true);
    return el;
  }

  function setRunning(on, which) {
    for (const [btn, label] of [[buildBtn, "编译"], [flashBtn, "烧录"]]) {
      btn.disabled = on;
      btn.textContent = on && btn === which ? "进行中…" : label;
    }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    add("me", text);
    input.value = "";
    input.style.height = "";
    send.disabled = true;
    add("dsh streaming", "");
    vscode.postMessage({ type: "ask", text });
  }

  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }

  send.addEventListener("click", submit);
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (event) => {
    // Enter sends, Shift+Enter breaks the line: this is a chat, and the panel is too narrow to hunt for Ctrl+Enter.
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  buildBtn.addEventListener("click", () => {
    setRunning(true, buildBtn);
    addTool("编译中…", "正在调用 keil_build(action=build)", true);
    vscode.postMessage({ type: "keil", action: "build" });
  });
  flashBtn.addEventListener("click", () => {
    setRunning(true, flashBtn);
    addTool("烧录中…", "正在调用 keil_build(action=flash)", true);
    vscode.postMessage({ type: "keil", action: "flash" });
  });
  keilChip.addEventListener("click", () => vscode.postMessage({ type: "open-project" }));
  vscode.postMessage({ type: "ready" });
  document.getElementById("file").addEventListener("click", () => vscode.postMessage({ type: "pick" }));
  document.getElementById("write").addEventListener("change", (event) => {
    vscode.postMessage({ type: "toggle-write", value: event.target.checked });
  });
  document.getElementById("project").addEventListener("click", () => {
    input.value = (input.value ? input.value.trimEnd() + " " : "") + "@项目 ";
    input.focus();
    grow();
  });

  window.addEventListener("message", (event) => {
    const message = event.data ?? {};
    if (message.type === "write-state") {
      document.getElementById("write").checked = Boolean(message.value);
      return;
    }
    if (message.type === "where") {
      const where = document.getElementById("where");
      where.textContent = message.text || "";
      where.title = message.text || "";
      return;
    }
    if (message.type === "keil-state") {
      const p = message.project || "";
      const short = p ? p.split(/[\\\\/]/).pop() : "";
      keilChip.textContent = p
        ? "Keil：" + short + (message.target ? " · " + message.target : "") + (message.uv4 ? "" : "（未找到 UV4）")
        : "Keil：未设置工程";
      keilChip.className = p ? "" : "none";
      keilChip.title = p ? p + "\\n点击打开工程" : "还没设置 Keil 工程（面板或 /keil project）";
      return;
    }
    if (message.type === "keil-result") {
      setRunning(false, null);
      addTool(message.ok ? "✅ " + message.label : "❌ " + message.label, message.text, Boolean(message.ok));
      return;
    }
    if (message.type === "picked") {
      const refs = (message.paths || []).map((p) => (/\\s/.test(p) ? '@"' + p + '"' : "@" + p)).join(" ");
      if (refs) input.value = (input.value ? input.value.trimEnd() + " " : "") + refs + " ";
      input.focus();
      grow();
      return;
    }
    if (message.type === "delta") {
      const live = log.querySelector(".dsh.streaming");
      const bubble = live ?? add("dsh streaming", "");
      bubble.className = "msg dsh streaming";
      bubble.textContent = message.text;
      scrollDown(false);
      return;
    }
    const live = log.querySelector(".dsh.streaming");
    if (live) live.remove();
    if (message.type === "answer") {
      add("dsh", message.text || "（空回答）");
      if (Array.isArray(message.attached) && message.attached.length) {
        add("meta-line", "已附上：" + message.attached.map((f) => f.path + "（" + f.chars + " 字符）").join("，"));
      }
      if (Array.isArray(message.problems) && message.problems.length) add("dsh err", message.problems.join("；"));
    }
    if (message.type === "error") {
      add("dsh err", "失败：" + message.text);
      if (message.partial) add("dsh", message.partial);
    }
    send.disabled = false;
  });
</script>
</body>
</html>`;
}
/** Show an answer in the output channel - the keyboard path has no panel to draw in. */
function showAnswer(question, answer) {
  channel.appendLine(`> ${question}`);
  channel.appendLine(answer || "（空回答）");
  channel.appendLine("");
  channel.show(true);
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "dsh.showStatus";
  statusItem.show();
  context.subscriptions.push(statusItem);
  channel = vscode.window.createOutputChannel("DSH");
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("dsh.chat", new ChatView(), { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // The same two actions the panel's buttons send, on the palette: a person who prefers the keyboard should not have to
  // click. Both go through the plugin, which owns the gates.
  const runKeilCommand = (action, label) => async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `DSH: ${label}…` }, async () => {
      try {
        const result = await runKeil(action);
        const text = String(result?.text ?? "");
        if (result?.ok) vscode.window.showInformationMessage(`DSH ${label}：${text.split("\n")[0]}`);
        else {
          channel.appendLine(text);
          channel.show(true);
          vscode.window.showWarningMessage(`DSH ${label} 未通过，详见输出面板`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`DSH ${label} 失败：${String(error?.message ?? error)}`);
      }
    });
  };
  context.subscriptions.push(vscode.commands.registerCommand("dsh.build", runKeilCommand("build", "编译")));
  context.subscriptions.push(vscode.commands.registerCommand("dsh.flash", runKeilCommand("flash", "烧录")));

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.ask", async () => {
      const text = await vscode.window.showInputBox({ prompt: "问 DSH", placeHolder: "例如：把这个文件里的函数补上注释" });
      if (!text) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "DSH 正在回答…" }, async () => {
        try {
          showAnswer(text, (await ask(text)).reply);
        } catch (error) {
          vscode.window.showErrorMessage(`DSH：${error.message}`);
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.project", async () => {
      // The one question a project snapshot is always good for, with an escape hatch for anything else.
      const question = await vscode.window.showInputBox({
        prompt: "关于当前项目问什么？",
        placeHolder: "总结这个项目的结构、技术栈和入口文件",
        value: "总结这个项目的结构、技术栈和入口文件，并指出我该先看哪几个文件",
      });
      if (question === undefined) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "DSH 正在读取项目…" }, async () => {
        try {
          const result = await ask(`@项目 ${question || "总结这个项目的结构、技术栈和入口文件"}`);
          showAnswer(`[@项目] ${question}`, result.reply);
          if (result.problems?.length) channel.appendLine(`（${result.problems.join("；")}）`);
        } catch (error) {
          vscode.window.showErrorMessage(`DSH：${error.message}`);
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.askSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage("没有打开的编辑器");
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) return vscode.window.showWarningMessage("没有选中内容");
      const question = await vscode.window.showInputBox({
        prompt: "关于选中的内容问什么？（留空 = 解释这段代码）",
        placeHolder: "解释这段代码",
      });
      if (question === undefined) return;
      const file = path.basename(editor.document.fileName);
      const hint = `${file} 第 ${editor.selection.start.line + 1}-${editor.selection.end.line + 1} 行`;
      const prompt = `${question || "解释这段代码"}\n\n文件：${hint}\n\`\`\`\n${selection}\n\`\`\``;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "DSH 正在回答…" }, async () => {
        try {
          showAnswer(`[${hint}] ${question || "解释这段代码"}`, (await ask(prompt)).reply);
        } catch (error) {
          vscode.window.showErrorMessage(`DSH：${error.message}`);
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.showStatus", async () => {
      const status = await refreshStatus({ quiet: false });
      if (!status) return;
      const rows = [
        `版本 ${status.version ?? "?"} · ${status.enabled === false ? "编辑器桥已关闭（/vscode on）" : "在线"}`,
        `微信账号 ${status.wechat?.accounts ?? 0} · 飞书 ${status.feishu?.configured ? "已配置" : "未配置"}`,
        `浏览器扩展 ${status.browser?.extension ? `已连接（${status.browser.target || "?"}）` : "未连接"}`,
        `定时任务 ${status.tasks ?? 0} 个`,
      ].join("\n");
      vscode.window.showInformationMessage(rows, { modal: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.openChat", async () => {
      await vscode.commands.executeCommand("dsh.chat.focus");
    }),
  );

  refreshStatus();
  pollTimer = setInterval(() => refreshStatus(), 15000);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

module.exports = { activate, deactivate };
