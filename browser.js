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
/**
 * How the browser should run, as three named modes rather than a boolean.
 *
 * `headless` is the default: nobody is watching, the window would only clutter. `headed` is the same session
 * with a window. `erp` is the one added for real work in a system the person uses: window on, **its own
 * persistent profile** (so the ERP login survives restarts), bigger viewport, and no auto-close - the point of
 * the mode is that a human can watch and take over, which a profile shared with test browsing would spoil.
 */
export const BROWSER_MODES = Object.freeze({
  headless: { headless: true, visible: false, width: 1280, height: 900, keepOpen: false },
  headed: { headless: false, visible: true, width: 1280, height: 900, keepOpen: true },
  erp: { headless: false, visible: true, width: 1600, height: 1000, keepOpen: true },
});

/** The mode names, in the order a panel should offer them. */
export const BROWSER_MODE_NAMES = Object.freeze(["headless", "headed", "erp"]);

/**
 * Turn a stored mode into the settings the launcher needs.
 *
 * `profileDir` is only overridden for `erp`: that mode exists so a login persists, and letting it share the
 * scratch profile would make "log in once, work all week" quietly false.
 */
export function browserModeSettings({ mode = "headless", profileDir = "", dshHome = ".", savedHeadless = undefined } = {}) {
  // An explicit legacy `headless: false` means the person wanted a window, which is `headed`.
  let wanted = String(mode ?? "").trim().toLowerCase();
  if (!BROWSER_MODES[wanted]) wanted = savedHeadless === false ? "headed" : "headless";
  const preset = BROWSER_MODES[wanted];
  const shared = String(profileDir ?? "").trim() || join(dshHome, "browser-profile");
  return {
    mode: wanted,
    headless: preset.headless,
    visible: preset.visible,
    keepOpen: preset.keepOpen,
    width: preset.width,
    height: preset.height,
    profileDir: wanted === "erp" ? String(profileDir ?? "").trim() || join(dshHome, "browser-profile-erp") : shared,
  };
}

/**
 * A proxy address, as Chrome takes it.
 *
 * `127.0.0.1:7897`, `localhost:7897`, `http://127.0.0.1:7897` and `socks5://127.0.0.1:7897` all mean something to
 * a person; Chrome wants scheme-less `host:port` in `--proxy-server` for http and the scheme kept for socks. An
 * empty string is "no proxy" - not an error, because switching it off is a normal thing to want.
 */
export function parseProxyAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { proxy: "" };
  if (raw.toLowerCase() === "off" || raw.toLowerCase() === "none") return { proxy: "" };
  const withScheme = /^[a-z0-9]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`代理地址看不懂：${JSON.stringify(raw)}（示例：127.0.0.1:7897，端口要有效）`);
  }
  // The scheme is checked **before** the port: `new URL` hides a protocol's default port, so `ftp://host:21`
  // arrives with an empty `port` and would be reported as "missing a port" - the wrong complaint entirely.
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!["http", "https", "socks4", "socks5"].includes(scheme)) {
    throw new Error(`代理协议只能是 http / https / socks4 / socks5，收到 ${scheme}`);
  }
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`代理地址要带端口：${JSON.stringify(raw)}（示例：127.0.0.1:7897）`);
  }
  const hostPort = `${url.hostname}:${port}`;
  // Chrome keeps the scheme for socks and drops it for http, which is the shape it actually passes to the network.
  return { proxy: scheme.startsWith("socks") ? `${scheme}://${hostPort}` : hostPort, host: url.hostname, port };
}

/**
 * Is anything listening on that proxy port? A proxy that is not running makes every page fail with an unrelated
 * error, so "the port answers" is worth answering before a launch.
 */
export async function proxyListening({ host = "127.0.0.1", port, timeoutMs = 1200, connectImpl } = {}) {
  const number = Number(port);
  if (!host || !Number.isInteger(number) || number <= 0) return { listening: false, reason: "没有可探测的地址" };
  const connect = connectImpl ?? (await import("node:net")).connect;
  // A local proxy frequently listens on one family only: Clash's mixed port is 127.0.0.1, while `localhost` may
  // resolve to ::1 first and be refused. Reporting "❌ ECONNREFUSED" for a working proxy is the worst answer, so
  // every plausible address for the same port is tried and the one that answered is named.
  const candidates = [...new Set([host, "127.0.0.1", "localhost"].filter(Boolean))];
  const attempts = [];
  for (const candidate of candidates) {
    const verdict = await probeOne(connect, candidate, number, timeoutMs);
    attempts.push({ host: candidate, ...verdict });
    if (verdict.listening) return { listening: true, host: candidate, reason: "", attempts };
  }
  return { listening: false, host: "", reason: attempts[0]?.reason ?? "连接被拒绝", attempts };
}

/** One address, one attempt. Resolves either way; the socket is always destroyed. */
function probeOne(connect, host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const done = (listening, reason) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy?.(); } catch { /* already gone */ }
      resolve({ listening, reason });
    };
    try {
      socket = connect({ host, port });
    } catch (error) {
      resolve({ listening: false, reason: String(error?.code ?? error?.message ?? error) });
      return;
    }
    socket.setTimeout?.(Number(timeoutMs) || 1200);
    socket.once?.("connect", () => done(true, ""));
    socket.once?.("timeout", () => done(false, "连接超时"));
    socket.once?.("error", (error) => done(false, String(error?.code ?? error?.message ?? error)));
  });
}

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

/**
 * Close the browser itself, over the browser-level CDP endpoint.
 *
 * `process.kill(pid)` was wrong, and the way it was wrong is worth keeping: Chrome starts, hands the profile to a
 * second process, and the one we spawned can exit while the real browser keeps the window - so the pid we recorded
 * was already gone and the window stayed open, while the tool reported success. `Browser.close` asks the browser to
 * shut down, and it does not care which pid claims to be in charge.
 *
 * Returns `{ closed: true }`, or throws with what answered instead - never reports a close it did not perform.
 */
export async function browserCloseBrowser({ port = 9222, fetchImpl = fetch, webSocketImpl = globalThis.WebSocket, timeoutMs = 8000 } = {}) {
  const version = await browserVersion({ port, fetchImpl, timeoutMs });
  const url = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!url) throw new Error(`the browser on port ${port} has no browser-level webSocketDebuggerUrl`);
  const session = createCdpSession(url, { webSocketImpl, timeoutMs });
  try {
    await session.ready;
    // The browser closes before it can answer, so do not wait for the reply: sending the command is the request.
    session.send("Browser.close").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    try { session.close(); } catch { /* the socket usually dies first */ }
  }
  // A browser that is really closing stops answering the port; one that ignored us keeps answering.
  let stillThere = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await browserVersion({ port, fetchImpl, timeoutMs: 800 });
      stillThere = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      stillThere = false;
      break;
    }
  }
  if (stillThere) throw new Error(`asked the browser on port ${port} to close, but it is still answering`);
  return { closed: true };
}

/**
 * The command line of the browser that is already listening, straight from CDP.
 *
 * `Browser.getBrowserCommandLine` is the only reliable way to know how the *running* instance was started - the pid,
 * the profile and the proxy are all in there, and a process listing cannot be trusted to answer it portably. This is
 * what lets the plugin notice that the browser on the port predates the settings the person just changed.
 */
export async function browserRunningArgs({ port = 9222, fetchImpl = fetch, webSocketImpl = globalThis.WebSocket, timeoutMs = 8000 } = {}) {
  const version = await browserVersion({ port, fetchImpl, timeoutMs });
  const url = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!url) throw new Error(`the browser on port ${port} has no browser-level webSocketDebuggerUrl`);
  const session = createCdpSession(url, { webSocketImpl, timeoutMs });
  try {
    await session.ready;
    const answer = await session.send("Browser.getBrowserCommandLine");
    return { args: Array.isArray(answer?.arguments) ? answer.arguments.map(String) : [] };
  } finally {
    try { session.close(); } catch { /* the socket usually closes itself */ }
  }
}

/**
 * Does the running browser match the settings the person wants now?
 *
 * Only the three things that change what a person sees are compared: window visibility (`--headless`), the profile
 * directory, and the proxy. Ports are the same by definition (we found it by port), and the channel is implied.
 */
export function browserArgsMatch(args, { headless = true, profileDir = "", proxy = "", pacUrl = "" } = {}) {
  const list = Array.isArray(args) ? args : [];
  const value = (prefix) => {
    const hit = list.find((arg) => String(arg).startsWith(prefix));
    return hit === undefined ? "" : String(hit).slice(prefix.length).replace(/^"|"$/g, "");
  };
  const runningHeadless = list.some((arg) => String(arg).startsWith("--headless"));
  const runningProfile = value("--user-data-dir=");
  const runningProxy = value("--proxy-server=");
  const runningPac = value("--proxy-pac-url=");
  const wantedProxy = String(proxy ?? "").trim();
  const wantedPac = String(pacUrl ?? "").trim();
  // A PAC and a fixed proxy are two ways to answer the same question, so they are compared as alternatives:
  // comparing the PAC against `--proxy-server` made every open look stale once a host list existed, which meant a
  // restart on every single open.
  // Chrome may report the profile spelled differently (long path, trailing separator, different case), so the
  // comparison is lenient: the full path after normalising, or the final segment, which is what distinguishes
  // `browser-profile` from `browser-profile-erp`. A strict comparison would restart the browser on every open.
  const profileMatches = !profileDir || !runningProfile || comparablePath(runningProfile) === comparablePath(profileDir)
    || comparablePath(runningProfile.replace(/[\\/]+$/, "").split(/[\\/]/).pop()) === comparablePath(String(profileDir).replace(/[\\/]+$/, "").split(/[\\/]/).pop());
  const proxyMatches = wantedPac
    ? comparablePath(runningPac) === comparablePath(wantedPac)
    : runningProxy === wantedProxy && !runningPac;
  return {
    match: runningHeadless === Boolean(headless) && profileMatches && proxyMatches,
    running: { headless: runningHeadless, profileDir: runningProfile, proxy: runningProxy, pacUrl: runningPac },
    wanted: { headless: Boolean(headless), profileDir, proxy: wantedProxy, pacUrl: wantedPac },
  };
}

/** Windows paths are case-insensitive and separator-agnostic; comparing them raw reports false mismatches. */
function comparablePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * The proxy host list worth starting from, for a person behind a filtering network.
 *
 * These are the domains that are unreachable from inside mainland China, grouped so a missing entry is easy to spot.
 * A bare host also covers its subdomains, which is why `google.com` and not `www.google.com`: the PAC rule is a suffix
 * match, so one line covers the dozens of hosts those sites actually use. Apply with `/browser hosts preset` (or
 * `POST /dsh-wechat-media/proxy-hosts {"action":"preset"}`); it *replaces* the list, and every other host keeps going
 * direct - which is the point of a PAC rather than a global proxy.
 *
 * It is deliberately not the default. A list someone did not ask for silently routes their traffic through a proxy, and
 * "why is this slow / why is this failing" is a bad first experience; a preset they chose is a different thing.
 */
export const COMMON_PROXY_HOSTS = Object.freeze([
  // Google
  "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "googlevideo.com",
  // video
  "youtube.com", "ytimg.com",
  // code and packages
  "github.com", "githubusercontent.com", "githubassets.com", "jsdelivr.net", "unpkg.com",
  // social
  "x.com", "twitter.com", "twimg.com", "telegram.org", "t.me", "reddit.com", "medium.com",
  // knowledge
  "wikipedia.org", "duckduckgo.com",
  // AI services
  "openai.com", "chatgpt.com", "claude.ai", "anthropic.com", "huggingface.co",
]);

/**
 * One proxy rule, normalised.
 *
 * People paste what they see in the address bar: `https://x.com/home`, `www.google.com`, `*.github.com`. A rule is a
 * **host pattern**: a bare host matches itself and its subdomains, `*.host` matches subdomains only. Anything that
 * looks like a URL is reduced to its host, because a path has no meaning to a proxy decision.
 */
export function normalizeProxyPattern(value) {
  const typed = String(value ?? "").trim();
  if (!typed) return ""; // a blank line is not an error
  let raw = typed.toLowerCase();
  raw = raw.replace(/^[a-z0-9+.-]+:\/\//, ""); // drop a scheme
  raw = raw.replace(/[/?#].*$/, ""); // drop a path, query or fragment
  raw = raw.replace(/^\*?\./, (match) => (match.startsWith("*") ? "*." : ""));
  raw = raw.replace(/\.$/, ""); // a trailing dot is the DNS root, not part of the name
  // Something was typed and nothing survived: say so, rather than dropping it from the list silently.
  if (!raw) throw new Error(`不是有效的域名：${JSON.stringify(typed)}（示例：example.com、*.google.com）`);
  // A host: letters, digits, dots, hyphens, and an optional leading `*.`.
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
    throw new Error(`不是有效的域名：${JSON.stringify(value)}（示例：example.com、*.google.com）`);
  }
  return raw;
}

/** Clean a list, dropping duplicates while keeping the order the person wrote. */
export function normalizeProxyPatterns(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const pattern = normalizeProxyPattern(value);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/** Does a host match a pattern? The rule Chrome's PAC will apply, kept here so a test can state it. */
export function hostMatchesPattern(host, pattern) {
  const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const rule = String(pattern ?? "").trim().toLowerCase();
  if (!name || !rule) return false;
  if (rule.startsWith("*.")) return name.endsWith(rule.slice(1)) && name.length > rule.length - 1;
  return name === rule || name.endsWith(`.${rule}`);
}

/**
 * The PAC script Chrome will execute.
 *
 * Written as a file and passed with `--proxy-pac-url`: that is the only mechanism that lets the *browser* decide per
 * request, which is what "these sites go through the proxy, the rest direct" means. `dnsDomainIs` is host-only here -
 * no `dnsResolve`, because a PAC that resolves names blocks page loads on a slow resolver.
 */
export function buildPacScript({ patterns = [], proxy = "" } = {}) {
  const list = normalizeProxyPatterns(patterns);
  const cleaned = String(proxy ?? "").trim();
  if (!cleaned) throw new Error("PAC 需要一个代理地址（例如 127.0.0.1:7897）");
  // Chrome wants `PROXY host:port` for http and `SOCKS5 host:port` for a socks proxy.
  const directive = cleaned.toLowerCase().startsWith("socks")
    ? `${cleaned.toLowerCase().startsWith("socks5") ? "SOCKS5" : "SOCKS"} ${cleaned.replace(/^[a-z0-9]+:\/\//i, "")}`
    : `PROXY ${cleaned.replace(/^[a-z]+:\/\//i, "")}`;
  return [
    "// Generated by dsh-wechat-media. Rewritten whenever the host list changes.",
    "function FindProxyForURL(url, host) {",
    `  var patterns = ${JSON.stringify(list)};`,
    "  host = String(host || '').toLowerCase();",
    "  for (var i = 0; i < patterns.length; i += 1) {",
    "    var rule = patterns[i];",
    "    if (rule.indexOf('*.') === 0) {",
    "      if (dnsDomainIs(host, rule.slice(1))) return " + JSON.stringify(directive) + ";",
    "    } else if (host === rule || dnsDomainIs(host, '.' + rule)) {",
    "      return " + JSON.stringify(directive) + ";",
    "    }",
    "  }",
    "  return 'DIRECT';",
    "}",
    "",
  ].join("\n");
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
  proxy = "",
  pacUrl = "",
  // `--enable-automation` is what Chrome needs before it will answer `Browser.getBrowserCommandLine`, and it is also
  // what draws the "自动测试软件正在控制 Chrome" bar. Nothing in the plugin needs that command any more (the leftover
  // browser is found by port, not by its command line), so the flag is optional: off means no bar, at the cost of one
  // CDP call nobody makes.
  automation = true,
  spawnImpl = spawn,
  fetchImpl = fetch,
  waitMs = 15000,
  executable = "",
} = {}) {
  // Injectable, so a unit test need not depend on this machine having a browser: asking the machine made the launch
  // test pass here and fail on the CI runner, where "no browser installed" is the honest answer.
  const resolved = String(executable ?? "").trim() || browserExecutable(channel);
  if (!resolved) throw new Error(`no ${channel} executable found in ${BROWSER_CHANNELS[channel] ? BROWSER_CHANNELS[channel].join(" or ") : "the known locations"}`);
  const profile = String(profileDir ?? "").trim() || join(tmpdir(), "dsh-browser-profile");
  try { mkdirSync(profile, { recursive: true }); } catch (error) { throw new Error(`could not create the browser profile directory ${profile}: ${String(error?.message ?? error)}`); }
  const args = [
    `--remote-debugging-port=${Number(port) || 9222}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // See the `automation` parameter: the flag is only passed when the caller wants `getBrowserCommandLine` back.
    ...(automation ? ["--enable-automation"] : []),
    `--window-size=${Number(width) || 1280},${Number(height) || 900}`,
    ...(headless ? ["--headless=new"] : []),
    // `--proxy-pac-url` wins when a host list is configured: then the *browser* decides per request, which is what
    // "only these sites go through the proxy" means. Otherwise the proxy applies to everything, as before.
    ...(pacUrl ? [`--proxy-pac-url=${pacUrl}`] : (() => {
      const parsed = parseProxyAddress(proxy);
      return parsed.proxy ? [`--proxy-server=${parsed.proxy}`] : [];
    })()),
    "about:blank",
  ];
  let child;
  try {
    child = spawnImpl(resolved, args, { detached: true, stdio: "ignore" });
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
  // The catch goes on **at creation**, not after the next await. When `Page.navigate` rejects first (a timeout is
  // exactly that), the load waiter is never reached and its 20-second rejection becomes an unhandled promise -
  // which DSH escalates to a fatal load failure and kills the whole app. Measured: a slow page took the GUI down.
  const loaded = session.once("Page.loadEventFired", waitMs).catch(() => undefined);
  const navigated = await session.send("Page.navigate", { url: wanted });
  await loaded; // a page that never fires load is still readable
  const title = await browserEvaluate(session, "document.title");
  return { url: wanted, title: String(title ?? ""), frameId: navigated?.frameId ?? "" };
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * `options.timeoutMs` is for expressions that legitimately take a while - a loop that scrolls a feed until it stops
 * growing, say. The transport's default ceiling (30 s for the extension) is right for a click and wrong for that.
 */
export async function browserEvaluate(session, expression, options = undefined) {
  const answer = await session.send("Runtime.evaluate", { expression: String(expression ?? ""), returnByValue: true, awaitPromise: true }, options);
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
