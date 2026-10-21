/**
 * The browser-extension bridge: a small HTTP endpoint the companion extension polls, so DSH can drive the Chrome the
 * person is already using.
 *
 * Why this exists: Chrome 136+ ignores `--remote-debugging-port` on the default profile directory, and Chrome 127+
 * encrypts cookies with an app-bound key that dies with the profile, so neither "start their Chrome" nor "copy their
 * logins" works. A Chrome extension is the one supported way in: it runs *inside* that browser, and `chrome.debugger`
 * speaks the very protocol the rest of this plugin already speaks. So the extension becomes a transport, and every
 * `browser_*` tool keeps working unchanged.
 *
 * Transport is deliberately HTTP polling rather than a WebSocket server: Node has a WebSocket *client* built in but no
 * server, and this package has no dependencies. A long poll is one `fetch` the extension holds open for up to 25 s; a
 * command sent during that window arrives immediately, and the round trip is roughly one poll interval.
 *
 * Auth: bound to 127.0.0.1 only, and the caller must present the token the plugin generated at startup. Loopback alone
 * would let any local process drive the browser, which is too much to hand out by accident.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/** How long a poll waits for a command before answering "nothing yet". */
const POLL_HOLD_MS = 25_000;
/** A client that has not polled for this long is treated as gone. */
const STALE_MS = 45_000;

/**
 * One bridge: the queue of commands, the long-poll waiters, and the client that answers them.
 *
 * `call` returns whatever the extension reports, so a session adapter can hand it straight to the existing CDP-shaped
 * code in browser.js.
 */
export class ExtensionBridge {
  constructor({ port = 9339, token = "", host = "127.0.0.1", now = () => Date.now() } = {}) {
    this.port = Number(port) || 9339;
    this.host = host;
    this.token = String(token ?? "");
    this.now = now;
    this.queue = [];
    this.waiters = [];
    this.pending = new Map();
    this.nextId = 1;
    this.client = null;
    this.server = null;
    // `debugger` by default: it is the capable transport, and the banner it shows is Chrome's, not ours.
    this.driver = "debugger";
    this.driverSent = "";
    // Draw a cursor where each click lands. Off by default: it is a debugging aid, not something to surprise people
    // with on a page they are reading.
    this.cursor = false;
    this.cursorSent = "";
    // Which transport the last command used, and how many times the banner could have appeared: in hybrid mode this is
    // the difference between "it worked" and "it worked without flashing".
    this.lastDriver = "";
    this.debuggerUses = 0;
  }

  /** What the panel and `/browser ext` report. */
  status() {
    const connected = Boolean(this.client) && this.now() - (this.client.lastSeen ?? 0) < STALE_MS;
    return {
      running: Boolean(this.server),
      port: this.port,
      connected,
      name: connected ? this.client.name : "",
      tabs: connected ? this.client.tabs : 0,
      waiting: this.waiters.length,
      pending: this.pending.size,
      // Which transport the extension is using: `debugger` shows Chrome's "已开始调试此浏览器" bar, `script`
      // injects instead and shows nothing. The panel reports it so the trade-off is visible.
      driver: this.driver,
      lastDriver: this.lastDriver,
      debuggerUses: this.debuggerUses,
      cursor: this.cursor,
    };
  }

  /**
   * Switch the extension's transport.
   *
   * `debugger` is the capable one - real mouse events, screenshots, any frame - at the cost of Chrome's own
   * "已开始调试此浏览器" banner, which no extension can hide. `script` never touches the debugger, so the banner never
   * appears; it drives the page with `chrome.scripting` instead. `hybrid` runs a command through the script path first
   * and only reaches for the debugger when that path cannot do it - so the banner appears exactly when it is needed,
   * not on every command.
   */
  async setDriver(mode) {
    const wanted = ["debugger", "script", "hybrid"].includes(String(mode ?? "").toLowerCase())
      ? String(mode).toLowerCase()
      : "debugger";
    this.driver = wanted;
    // Force the next poll to carry the switch, instead of waiting for a client that may not even be connected yet.
    this.driverSent = "";
    return { driver: wanted };
  }

  /** Draw (or stop drawing) a cursor where clicks land. Delivered on the next poll, like the driver. */
  setCursor(on) {
    this.cursor = Boolean(on);
    this.cursorSent = "";
    return { cursor: this.cursor };
  }

  /** The token, shown once in the panel so it can be pasted into the extension. */
  tokenForDisplay() {
    return this.token;
  }

  /** Start listening. Re-starting on the same port is a no-op, so a tool call can be lazy about it. */
  async start() {
    if (this.server) return this.status();
    const server = createServer((req, res) => { this.#handle(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } }); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    return this.status();
  }

  async stop() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("浏览器扩展桥已关闭"));
      this.pending.delete(id);
    }
    for (const waiter of this.waiters) waiter.resolve(null);
    this.waiters = [];
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    this.client = null;
  }

  /**
   * Queue one CDP command for the extension and wait for its answer.
   *
   * A command handed to a poll that has already gone away (the service worker suspended mid-poll, or was reloaded) is
   * otherwise lost forever: the response goes nowhere, the queue entry is gone, and the caller times out with no clue.
   * So a command with no answer is **re-queued once** before the error is reported - the second poll almost always
   * comes from the restarted worker.
   */
  call(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const id = this.nextId++;
    const pending = new Promise((resolve, reject) => {
      const settleTimer = (attempts) => setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        if (attempts < 1) {
          // Put it back at the head: the next poll gets it, and the deadline starts again for one more round.
          entry.attempts = attempts + 1;
          entry.timer = settleTimer(attempts + 1);
          this.queue.unshift({ id, method, params });
          this.#wake();
          return;
        }
        this.pending.delete(id);
        reject(new Error(`扩展 ${Math.round(timeoutMs / 1000)}s 内没有回应 ${method}（浏览器扩展没在运行？）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer: settleTimer(0), method, attempts: 0 });
      this.queue.push({ id, method, params });
      this.#wake();
    });
    // A bridge that closes (or times out) with commands in flight must not take the process down with an unhandled
    // rejection: the caller still sees the rejection, but the runtime is told somebody is listening.
    pending.catch(() => {});
    return pending;
  }

  /** Called by the extension after executing a command. */
  resolveResult({ id, ok, result, error, driver }) {
    const entry = this.pending.get(Number(id));
    if (!entry) return { accepted: false };
    clearTimeout(entry.timer);
    this.pending.delete(Number(id));
    // Which transport actually ran it. In hybrid mode the choice is made per command, so "did the banner flash?" is only
    // answerable if the worker reports it back.
    if (driver) {
      this.lastDriver = String(driver);
      if (driver === "debugger") this.debuggerUses += 1;
    }
    if (ok === false) entry.reject(new Error(String(error || `${entry.method} 失败（扩展未给原因）`)));
    else entry.resolve(result ?? null);
    return { accepted: true };
  }

  /** The long poll: resolve with a command, or with `null` after the hold. */
  poll() {
    // A driver change is delivered on the next poll, before any work: the worker has to know *how* to run the command
    // it is about to receive. Id 0 is synthetic - no caller is waiting, and a result for it is simply ignored.
    if (this.driver !== this.driverSent) {
      this.driverSent = this.driver;
      return Promise.resolve({ id: 0, method: "__driver", params: { mode: this.driver } });
    }
    // The same handshake for the cursor overlay: a setting the worker has to hold before it can draw anything.
    if (this.cursor !== this.cursorSent) {
      this.cursorSent = this.cursor;
      return Promise.resolve({ id: 0, method: "__cursor", params: { on: this.cursor } });
    }
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const waiter = { resolve: (value) => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(null);
      }, POLL_HOLD_MS);
      this.waiters.push(waiter);
    });
  }

  /** After a poll: update what we know about the client. */
  touch({ name, tabs } = {}) {
    const previous = this.client ?? {};
    this.client = {
      name: String(name ?? previous.name ?? "Chrome 扩展"),
      tabs: Number.isFinite(Number(tabs)) ? Number(tabs) : (previous.tabs ?? 0),
      lastSeen: this.now(),
      connectedAt: previous.connectedAt ?? this.now(),
    };
    return this.status();
  }

  #wake() {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    const next = this.queue.shift();
    waiter.resolve(next ?? null);
  }

  /** Authorised only with the token the plugin minted at startup. */
  #authorized(req) {
    if (!this.token) return true;
    const header = String(req.headers["x-dsh-token"] ?? "");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = String(url.searchParams.get("token") ?? "");
    return header === this.token || query === this.token;
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(text);
    };
    // A preflight from a page the extension is not, is harmless and lets a quick manual test work.
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-dsh-token" }); res.end(); return; }
    if (!this.#authorized(req)) { send(401, { ok: false, error: "token 不对（在面板里复制扩展 token）" }); return; }

    if (url.pathname === "/status") { send(200, { ok: true, ...this.status() }); return; }

    if (url.pathname === "/poll") {
      const name = url.searchParams.get("name") ?? undefined;
      const tabs = Number(url.searchParams.get("tabs")) || undefined;
      this.touch({ name, tabs });
      const command = await this.poll();
      if (!command) { res.writeHead(204, { "access-control-allow-origin": "*" }); res.end(); return; }
      send(200, { ok: true, command });
      return;
    }

    if (url.pathname === "/result" && req.method === "POST") {
      const body = await readJson(req);
      this.touch({});
      send(200, { ok: true, ...this.resolveResult(body ?? {}) });
      return;
    }

    send(404, { ok: false, error: "unknown endpoint" });
  }
}

/** Read a JSON body, capped: a bridge that accepts an unbounded body is a memory leak with a port. */async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

/** A token for one run. 32 hex characters, so it is pasteable and unguessable. */
export function bridgeToken() {
  return randomBytes(16).toString("hex");
}

/**
 * A session shaped like the CDP session `browser.js` expects, backed by the extension.
 *
 * `once` rejects immediately on purpose: the extension returns command results but not protocol events, and
 * `browserOpen` waits for `Page.loadEventFired` with a 20-second timeout. Rejecting is what makes that wait collapse to
 * zero instead of stalling every navigation.
 */
export function extensionSession(bridge, { tabId = null } = {}) {
  return {
    kind: "extension",
    tabId,
    send: (method, params = {}) => bridge.call(method, { ...params, __tabId: tabId }, { timeoutMs: method === "Page.navigate" ? 45_000 : 30_000 }),
    once: () => Promise.reject(new Error("扩展桥没有协议事件")),
    close: () => {},
  };
}

/**
 * Package the extension folder as a .zip, for the panel's "one-click install" button.
 *
 * Chrome cannot be made to install an extension silently from a page - that is a deliberate security rule, not a gap
 * this plugin can close - so "one click" means: hand the user a zip, open `chrome://extensions` already focused, and
 * put the token on the clipboard. Three steps become two clicks.
 *
 * Uses `Compress-Archive`, which ships with Windows PowerShell; a machine without it gets a sentence, not a stack.
 */
export async function packExtension({ dir, zipPath, execFileImpl } = {}) {
  const source = String(dir ?? "").trim();
  const target = String(zipPath ?? "").trim();
  if (!source || !target) throw new Error("打包扩展需要源目录和目标 zip 路径");
  if (process.platform !== "win32") throw new Error("扩展打包目前用 Windows 的 Compress-Archive 实现");
  const exec = execFileImpl ?? (await import("node:child_process")).execFile;
  const script = `Compress-Archive -Path ${psQuote(`${source}\\*`)} -DestinationPath ${psQuote(target)} -Force`;
  await new Promise((resolve, reject) => {
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 60_000 }, (error, _out, err) => {
      if (error) reject(new Error(String(err ?? "").trim().split(/\r?\n/)[0] || String(error.message).split("\n")[0]));
      else resolve();
    });
  });
  return { dir: source, zip: target };
}

/** Single-quote a value for PowerShell: the only escaping a literal needs is a doubled quote. */
function psQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/**
 * Ask the desktop to open Chrome's extensions page.
 *
 * A page cannot navigate to `chrome://` (the plugin's own `browser_open` refuses it too, and rightly), so the host
 * asks Windows to start the browser with that URL - which is exactly what clicking a shortcut does.
 */
export async function openExtensionsPage({ execFileImpl, channel = "chrome" } = {}) {
  if (process.platform !== "win32") throw new Error("打开浏览器扩展页目前只在 Windows 上实现");
  // Edge is Chromium with the same extension API and the same `chrome.debugger`; only its settings URL differs.
  const page = String(channel).toLowerCase() === "edge" ? "edge://extensions" : "chrome://extensions";
  const exec = execFileImpl ?? (await import("node:child_process")).execFile;
  await new Promise((resolve, reject) => {
    exec("cmd.exe", ["/c", "start", "", page], { windowsHide: true, timeout: 15_000 }, (error) => {
      if (error) reject(new Error(String(error.message).split("\n")[0]));
      else resolve();
    });
  });
  return { opened: true, page };
}
