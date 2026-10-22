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

/** Ask the plugin a question and return its answer text. */
async function ask(prompt, { sessionHint = "" } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("问题是空的");
  const body = { prompt: sessionHint ? `${text}\n\n（上下文：${sessionHint}）` : text };
  const answer = await request("POST", "/dsh-vscode/ask", body);
  const reply = String(answer.text ?? "").trim();
  // An empty answer is not a success: the route reports *why* (`stopReason`), and that reason is the only thing that
  // makes the failure fixable - showing a blank bubble would look like the model said nothing.
  if (!reply) throw new Error(`DSH 没有给出内容（stopReason: ${answer.stopReason ?? "unknown"}）`);
  return reply;
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
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type !== "ask") return;
      try {
        const answer = await ask(message.text);
        webviewView.webview.postMessage({ type: "answer", text: answer });
      } catch (error) {
        webviewView.webview.postMessage({ type: "error", text: String(error?.message ?? error) });
      }
    });
  }
}

/** The panel's HTML. Inline by design: one file to read, nothing to load from disk. */
function chatHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 8px; }
  #log { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .msg { padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .me { background: var(--vscode-input-background); }
  .dsh { background: var(--vscode-editorWidget-background); border-left: 2px solid var(--vscode-focusBorder); }
  .err { color: var(--vscode-errorForeground); }
  .meta { opacity: .6; font-size: 11px; margin-top: 2px; }
  #row { display: flex; gap: 6px; }
  textarea { flex: 1; min-height: 54px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; font: inherit; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="row">
    <textarea id="input" placeholder="问 DSH…（Ctrl+Enter 发送）"></textarea>
    <button id="send">发送</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const send = document.getElementById("send");

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
    window.scrollTo(0, document.body.scrollHeight);
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    add("me", text);
    input.value = "";
    send.disabled = true;
    add("dsh", "思考中…", "已发送到 DSH");
    vscode.postMessage({ type: "ask", text });
  }

  send.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  });

  window.addEventListener("message", (event) => {
    const message = event.data ?? {};
    const pending = [...log.querySelectorAll(".dsh")].pop();
    if (pending && (message.type === "answer" || message.type === "error")) pending.remove();
    if (message.type === "answer") add("dsh", message.text || "（空回答）");
    if (message.type === "error") add("dsh err", "失败：" + message.text);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.ask", async () => {
      const text = await vscode.window.showInputBox({ prompt: "问 DSH", placeHolder: "例如：把这个文件里的函数补上注释" });
      if (!text) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "DSH 正在回答…" }, async () => {
        try {
          showAnswer(text, await ask(text));
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
          showAnswer(`[${hint}] ${question || "解释这段代码"}`, await ask(prompt));
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
