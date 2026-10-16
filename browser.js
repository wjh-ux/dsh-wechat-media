/**
 * Browser automation for the chat channels, over the Chrome DevTools Protocol.
 *
 * No third-party dependency: Node 24 ships a global `WebSocket` (already used by feishu-ws.js), and Chrome/Edge speak
 * CDP over one. Everything here was measured against a real browser rather than read off documentation:
 *
 *   launch   chrome.exe --remote-debugging-port=9224 --user-data-dir=<dedicated>
 *            --no-first-run --no-default-browser-check --headless=new --window-size=1280,900 about:blank
 *   probe    GET /json/version -> { Browser, "Protocol-Version": "1.3", webSocketDebuggerUrl }
 *            GET /json/list    -> [{ type, title, url, webSocketDebuggerUrl }, …]
 *   session  ws://127.0.0.1:<port>/devtools/page/<id>; send {id, method, params}; reply {id, result}
 *   navigate Page.navigate { url }            -> { frameId, loaderId, isDownload }
 *            load is done at the event `Page.loadEventFired`
 *   read     Runtime.evaluate { expression, returnByValue: true } -> { result: { type, value } }
 *   shot     Page.captureScreenshot { format: "png" }             -> { data: <base64> }
 *   input    Input.dispatchMouseEvent { type, x, y, button, clickCount } -> {}
 *            Input.insertText { text }                                -> {}
 *
 * The dedicated `--user-data-dir` is deliberate: attaching to the browser a person is already using would take over
 * their session, so this starts its own instance and leaves theirs alone.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Where the two browsers live on Windows; a channel that is not installed is reported, not assumed. */
export const BROWSER_CHANNELS = Object.freeze({
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
});

/** The first path of `channel` that exists, or "" - so "not installed" is a fact rather than a guess. */
export function browserExecutable(channel = "chrome") {
  const list = BROWSER_CHANNELS[String(channel).toLowerCase()] ?? BROWSER_CHANNELS.chrome;
  for (const path of list) if (existsSync(path)) return path;
  return "";
}

/** The debugging endpoint for a port. */
export function cdpBase(port = 9222) {
  return `http://127.0.0.1:${Number(port) || 9222}`;
}

/** What the browser says it is. Also the cheapest way to ask "is a debug port listening?". */
export async function browserVersion({ port = 9222, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const response = await fetchImpl(`${cdpBase(port)}/json/version`, signalOption(timeoutMs));
  if (!response.ok) throw new Error(`the debugging port ${port} answered HTTP ${response.status}`);
  return response.json();
}

/** The open targets (tabs, extensions, workers). */
export async function browserTargets({ port = 9222, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const response = await fetchImpl(`${cdpBase(port)}/json/list`, signalOption(timeoutMs));
  if (!response.ok) throw new Error(`the debugging port ${port} answered HTTP ${response.status}`);
  const list = await response.json();
  return Array.isArray(list) ? list : [];
}

/** The first real page target, which is what every page-level command needs. */
export async function browserPageTarget({ port = 9222, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const targets = await browserTargets({ port, fetchImpl, timeoutMs });
  const page = targets.find((target) => target?.type === "page" && target?.webSocketDebuggerUrl);
  if (!page) throw new Error(`no page target on port ${port} (${targets.length} targets open, none usable)`);
  return page;
}

function signalOption(timeoutMs) {
  const ms = Number(timeoutMs) || 0;
  if (!ms || typeof AbortSignal?.timeout !== "function") return {};
  return { signal: AbortSignal.timeout(ms) };
}

/**
 * Start a browser with its own profile and a debugging port, and wait until the port answers.
 *
 * `spawnImpl` and `fetchImpl` are injectable so the launch path can be tested without starting anything.
 */
export async function browserLaunch({
  channel = "chrome",
  port = 9222,
  headless = true,
  profileDir = "",
  width = 1280,
  height = 900,
  spawnImpl = spawn,
  fetchImpl = fetch,
  waitMs = 15000,
} = {}) {
  const executable = browserExecutable(channel);
  if (!executable) throw new Error(`no ${channel} executable found in ${BROWSER_CHANNELS[channel] ? BROWSER_CHANNELS[channel].join(" or ") : "the known locations"}`);
  const profile = String(profileDir ?? "").trim() || join(tmpdir(), "dsh-browser-profile");
  try { mkdirSync(profile, { recursive: true }); } catch (error) { throw new Error(`could not create the browser profile directory ${profile}: ${String(error?.message ?? error)}`); }
  const args = [
    `--remote-debugging-port=${Number(port) || 9222}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${Number(width) || 1280},${Number(height) || 900}`,
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  let child;
  try {
    child = spawnImpl(executable, args, { detached: true, stdio: "ignore" });
  } catch (error) {
    throw new Error(`could not start ${channel}: ${String(error?.message ?? error)}`);
  }
  child?.unref?.();
  // Wait for the port rather than assuming: a browser that failed to start must not look like one that did.
  const until = Date.now() + (Number(waitMs) || 15000);
  for (;;) {
    try {
      const version = await browserVersion({ port, fetchImpl, timeoutMs: 1500 });
      return { ok: true, pid: child?.pid ?? null, channel, port, profileDir: profile, executable, version };
    } catch (error) {
      if (Date.now() > until) {
        throw new Error(`started ${channel} but its debugging port ${port} never answered within ${waitMs}ms（${String(error?.message ?? error)}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * One CDP session over a target's WebSocket.
 *
 * Replies are matched by id, events are queued for whoever waits on them, and every request has a timeout so a dead
 * browser surfaces as an error rather than as a hang.
 */
export function createCdpSession(wsUrl, { webSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  if (typeof webSocketImpl !== "function") throw new Error("this Node has no global WebSocket, which CDP needs");
  const socket = new webSocketImpl(wsUrl);
  socket.binaryType = "arraybuffer";
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(new Error(`the CDP socket failed to open: ${String(event?.message ?? "error")}`)), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      message = JSON.parse(text);
    } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(`CDP ${message.error.message ?? "error"}${message.error.code ? ` (${message.error.code})` : ""}`));
      else resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      for (const handler of listeners.get(message.method) ?? []) handler(message.params ?? {});
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = (event, waitMs = timeoutMs) => new Promise((resolve, reject) => {
    const handler = (params) => { clearTimeout(timer); listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler)); resolve(params); };
    const timer = setTimeout(() => {
      listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
      reject(new Error(`waiting for ${event} timed out after ${waitMs}ms`));
    }, waitMs);
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
  });
  return {
    socket,
    ready,
    send,
    once,
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

/** Open a URL and wait for load. Returns the title, so the caller learns whether it worked. */
export async function browserOpen(session, url, { waitMs = 20000 } = {}) {
  const wanted = String(url ?? "").trim();
  if (!wanted) throw new Error("opening a page needs a url");
  if (!/^https?:\/\//i.test(wanted)) throw new Error(`a page url must start with http:// or https:// (got "${wanted.slice(0, 60)}")`);
  const loaded = session.once("Page.loadEventFired", waitMs);
  const navigated = await session.send("Page.navigate", { url: wanted });
  await loaded.catch(() => undefined); // a page that never fires load is still readable
  const title = await browserEvaluate(session, "document.title");
  return { url: wanted, title: String(title ?? ""), frameId: navigated?.frameId ?? "" };
}

/** Evaluate an expression in the page and return its value. */
export async function browserEvaluate(session, expression) {
  const answer = await session.send("Runtime.evaluate", { expression: String(expression ?? ""), returnByValue: true, awaitPromise: true });
  if (answer?.exceptionDetails) throw new Error(`the page threw: ${answer.exceptionDetails.text ?? "unknown"} ${answer.exceptionDetails.exception?.description ?? ""}`.trim());
  return answer?.result?.value;
}

/** Title plus the page's visible text, which is what a chat answer usually wants. */
export async function browserText(session, { maxChars = 4000 } = {}) {
  const title = String((await browserEvaluate(session, "document.title")) ?? "");
  const body = String((await browserEvaluate(session, "document.body ? document.body.innerText : ''")) ?? "");
  const limit = Math.max(200, Math.min(20000, Number(maxChars) || 4000));
  return { title, url: String((await browserEvaluate(session, "location.href")) ?? ""), text: body.slice(0, limit), truncated: body.length > limit };
}

/** The centre of an element, found through the page itself - no DOM protocol needed. */
export async function browserElementCentre(session, selector) {
  const wanted = String(selector ?? "").trim();
  if (!wanted) throw new Error("locating an element needs a CSS selector");
  const found = await browserEvaluate(
    session,
    `(() => { const el = document.querySelector(${JSON.stringify(wanted)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, text: (el.innerText || el.value || "").slice(0, 120) }; })()`,
  );
  if (!found) throw new Error(`nothing on the page matches the selector "${wanted}"`);
  return found;
}

/** Click an element by selector. */
export async function browserClick(session, selector) {
  const box = await browserElementCentre(session, selector);
  const point = { x: Math.round(box.x), y: Math.round(box.y) };
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return { selector: String(selector), x: point.x, y: point.y, text: String(box.text ?? "") };
}

/**
 * Type into an element: focus it, clear it, then insert the text.
 *
 * `Input.insertText` needs the element focused, so focusing happens through the page rather than by clicking - that
 * keeps the caret where the text should go even for an input that scrolls into view.
 */
export async function browserType(session, selector, text) {
  const wanted = String(selector ?? "").trim();
  if (!wanted) throw new Error("typing needs a CSS selector");
  const focused = await browserEvaluate(
    session,
    `(() => { const el = document.querySelector(${JSON.stringify(wanted)}); if (!el) return false; el.focus(); if ("value" in el && el.value !== undefined) el.value = ""; return true; })()`,
  );
  if (!focused) throw new Error(`nothing on the page matches the selector "${wanted}"`);
  await session.send("Input.insertText", { text: String(text ?? "") });
  return { selector: wanted, chars: String(text ?? "").length };
}

/** A PNG of the current viewport, as a Buffer (CDP hands back base64). */
export async function browserScreenshot(session) {
  const shot = await session.send("Page.captureScreenshot", { format: "png" });
  const base64 = String(shot?.data ?? "");
  if (!base64) throw new Error("the browser returned an empty screenshot");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error("the screenshot could not be decoded");
  return bytes;
}
