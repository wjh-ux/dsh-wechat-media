/**
 * DSH Browser Bridge - the Chrome side of the extension transport.
 *
 * It polls the plugin for one command at a time and executes it through `chrome.debugger`, which speaks the same
 * DevTools protocol the plugin already uses. So `browser_click`, `browser_flow` and the rest work in *this* Chrome -
 * the one with the logins - without a debugging port and without copying a profile.
 *
 * Configuration (options page, or the action popup fallback): the plugin's address (`http://127.0.0.1:9339`) and the
 * token the panel shows. Both live in `chrome.storage.local`, so one setup survives restarts.
 */

const DEFAULTS = { endpoint: "http://127.0.0.1:9339", token: "" };
const ATTACH = { version: "1.3" };

/** Current settings, with the defaults filled in. */
async function settings() {
  const saved = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...saved };
}

/** Headers the plugin checks; the token rides on every request. */
function headers(token) {
  return { "content-type": "application/json", "x-dsh-token": token };
}

/** Wake the worker from an alarm if the browser suspended it. */
async function tabCount() {
  try { return (await chrome.tabs.query({})).length; } catch { return 0; }
}

/**
 * Run one command.
 *
 * `__tabId` is the tab the plugin means; without it the active tab is used, which is what a person expects when they
 * say "click that". A debugger that is already attached (another DevTools window, or a previous run) is detached and
 * retried once - otherwise every command fails until the browser is restarted.
 */
async function runCommand(command) {
  const params = { ...(command.params ?? {}) };
  const wantedTab = params.__tabId ?? null;
  delete params.__tabId;
  // The per-command cursor flag, stripped before the command reaches Chrome: `chrome.debugger` rejects unknown
  // parameters, so it must not travel any further than this function.
  const wantCursor = params.__cursor === true;
  delete params.__cursor;

  // The transport switch itself. It arrives on a poll, before the work it changes, so no command is ever run with the
  // wrong driver; id 0 is synthetic and its result is ignored.
  if (command.method === "__driver") {
    const mode = String(params.mode ?? "").toLowerCase();
    const stored = ["script", "hybrid"].includes(mode) ? mode : "debugger";
    await chrome.storage.local.set({ driver: stored });
    return { result: { driver: stored }, driver: "control" };
  }

  if (command.method === "__cursor") {
    await chrome.storage.local.set({ cursor: params.on === true || params.on === "true" });
    return { result: { cursor: params.on === true || params.on === "true" }, driver: "control" };
  }

  const tabId = wantedTab ?? await pickTab();
  if (!tabId) throw new Error("没有可操作的标签页");

  // The pointer is painted before the click and removed afterwards, so it shows up on both transports: the script path
  // never touches the debugger, and the debugger path has no cursor API of its own to turn on.
  await paintCursor(tabId, command.method, params, wantCursor);

  const driver = await currentDriver();
  if (driver === "script") return { result: await runScriptCommand(command, tabId, params), driver: "script" };
  if (driver === "hybrid") {
    // Hybrid: the script path is cheaper and leaves no banner, so it goes first; the debugger is the fallback for what
    // scripting genuinely cannot do (native input events, full-page capture, a click that found no element). The banner
    // therefore appears only on the commands that need it, instead of on every command - and every answer says which
    // path it took, so "did that flash?" is answerable after the fact.
    try {
      return { result: await runScriptCommand(command, tabId, params), driver: "script" };
    } catch { /* fall through to the debugger for this one command */ }
  }

  try {
    await chrome.debugger.attach({ tabId }, ATTACH.version);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/already attached/i.test(message)) throw error;
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, ATTACH.version);
  }

  try {
    return { result: await chrome.debugger.sendCommand({ tabId }, command.method, params), driver: "debugger" };
  } finally {
    // `Page.navigate` leaves the target mid-load; detaching is what keeps a later attach from failing - and it is also
    // what makes Chrome's "已开始调试此浏览器" banner disappear again.
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

/** The driver in force, defaulting to the capable one. */
async function currentDriver() {
  const { driver } = await chrome.storage.local.get({ driver: "debugger" });
  return ["script", "hybrid"].includes(driver) ? driver : "debugger";
}

/**
 * Paint a pointer where the click will land, when the setting is on.
 *
 * Chrome exposes no cursor API, so the "cursor" is a small fixed-position dot painted into the page - from an isolated
 * world, so it cannot clash with the page's own variables - with a ripple that fades out. It removes itself on a timer:
 * the click path stays free of cleanup bookkeeping, and a click that fails leaves nothing behind.
 */
async function paintCursor(tabId, method, params, enabled = false) {
  if (method !== "Input.dispatchMouseEvent") return;
  // One dot per press/release pair: the event arrives twice and two ripples would look like a double click.
  if (params.type !== "mousePressed") return;
  // The flag comes with the command (a stored setting can be one click stale); the stored value is only the fallback for
  // an older plugin that still sends `__cursor` as a separate handshake.
  let on = enabled === true;
  if (!on) {
    const { cursor } = await chrome.storage.local.get({ cursor: false });
    on = cursor === true;
  }
  if (!on) return;
  const x = Number(params.x) || 0;
  const y = Number(params.y) || 0;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [x, y],
      func: (x, y) => {
        const ID = "__dsh_cursor_dot";
        let dot = document.getElementById(ID);
        if (!dot) {
          dot = document.createElement("div");
          dot.id = ID;
          dot.style.cssText = "position:fixed;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;"
            + "background:rgba(255,64,64,.65);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.35);"
            + "pointer-events:none;z-index:2147483647;transition:transform .06s linear,opacity .3s ease;";
          document.documentElement.appendChild(dot);
        }
        dot.style.opacity = "1";
        dot.style.transform = `translate(${x}px, ${y}px)`;

        const ring = document.createElement("div");
        ring.style.cssText = "position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;"
          + "border:2px solid rgba(255,64,64,.85);pointer-events:none;z-index:2147483646;opacity:1;transition:all .5s ease-out;";
        ring.style.left = x + "px";
        ring.style.top = y + "px";
        document.documentElement.appendChild(ring);
        requestAnimationFrame(() => { ring.style.transform = "scale(3.5)"; ring.style.opacity = "0"; });
        setTimeout(() => ring.remove(), 650);
        setTimeout(() => { dot.style.opacity = "0"; }, 1000);
        return true;
      },
    });
  } catch { /* a page that forbids injection simply shows no pointer */ }
}

/**
 * The transport that never touches `chrome.debugger`, and therefore never shows Chrome's debugging banner.
 *
 * It is `chrome.scripting` in the page's own world: read, click, type and navigate all work; a screenshot cannot
 * (there is no capture API outside the debugger) and input is DOM-level rather than native. Those limits are the price
 * of the banner never appearing, and the error below says which command hit one.
 */
async function runScriptCommand(command, tabId, params) {
  switch (command.method) {
    case "Page.enable":
      return {};
    case "Page.navigate": {
      await chrome.tabs.update(tabId, { url: String(params.url ?? "about:blank") });
      // `tabs.update` returns before the page loads, and the plugin reads the title immediately afterwards - without
      // this wait the title would belong to the previous page, which looks like a navigation that did nothing.
      await waitForLoad(tabId);
      return { frameId: "" };
    }
    case "Page.captureScreenshot": {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
      return { data: String(dataUrl).replace(/^data:image\/png;base64,/, "") };
    }
    case "Runtime.evaluate": {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [String(params.expression ?? "")],
        // `eval` in the page's world is what gives the plugin the same value it would get over CDP.
        func: async (expression) => {
          const value = eval(expression);
          return value instanceof Promise ? await value : value;
        },
      });
      return out?.result ?? null;
    }
    case "Input.insertText": {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [String(params.text ?? "")],
        func: (text) => {
          const el = document.activeElement;
          if (!el) return false;
          if ("value" in el && el.value !== undefined) {
            el.value = String(el.value ?? "") + text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }
          return document.execCommand("insertText", false, text);
        },
      });
      return out?.result ?? true;
    }
    case "Input.dispatchMouseEvent": {
      // One click per press/release pair: the mouse event arrives twice, and clicking twice would double-activate.
      if (params.type !== "mouseReleased") return {};
      const [clicked] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [Number(params.x) || 0, Number(params.y) || 0],
        func: (x, y) => {
          const el = document.elementFromPoint(x, y);
          if (el && typeof el.click === "function") el.click();
          return Boolean(el);
        },
      });
      // Nothing at that point means the scripted click could not land - exactly the case hybrid mode should hand to the
      // debugger, whose mouse event is real and may hit something the DOM lookup missed (an overlay, a frame).
      if (clicked?.result === false) throw new Error("脚本模式在该坐标没有找到可点击的元素");
      return {};
    }
    default:
      throw new Error(`脚本模式不支持 ${command.method}（就为了不出现调试横幅；需要它请切回调试器模式）`);
  }
}

/**
 * Which tab to drive when the plugin did not name one.
 *
 * Prefer the active tab, but never a `chrome://` or `chrome-extension://` one: the debugger refuses those ("Cannot
 * access a chrome:// URL"), and the tab in front is very often the settings page a person just opened to install this
 * extension. Fall back to any ordinary page, and create a blank one if the window is all browser UI.
 */
async function pickTab() {
  const usable = (tab) => Boolean(tab?.id) && (/^https?:\/\//i.test(tab.url ?? "") || tab.url === "about:blank");
  const all = await chrome.tabs.query({});
  const candidates = all.filter(usable);
  const active = candidates.find((tab) => tab.active) ?? candidates[0];
  if (active) return active.id;
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  return created?.id ?? null;
}

/** One poll round: fetch a command, run it, post the answer. */
async function round() {
  const { endpoint, token } = await settings();
  const tabs = await tabCount();
  const url = `${endpoint.replace(/\/$/, "")}/poll?tabs=${tabs}&name=${encodeURIComponent("Chrome 扩展")}`;
  let response;
  try {
    response = await fetch(url, { headers: headers(token), cache: "no-store" });
  } catch {
    return false; // plugin not running yet; the loop will try again
  }
  if (response.status === 204) return true; // nothing to do - the long poll simply expired
  if (!response.ok) return false;
  const payload = await response.json().catch(() => null);
  const command = payload?.command;
  if (!command?.id) return true;

  let body;
  try {
    const { result, driver } = await runCommand(command);
    body = { id: command.id, ok: true, result, driver };
  } catch (error) {
    body = { id: command.id, ok: false, error: String(error?.message ?? error) };
  }
  await fetch(`${endpoint.replace(/\/$/, "")}/result`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  }).catch(() => {});
  return true;
}

/**
 * Wait until the tab reports `status: "complete"`.
 *
 * Gives up rather than throwing: a page that never finishes loading still has a title and a DOM worth reading, and a
 * navigation that times out is better reported as "loaded slowly" than as a failed command.
 */
async function waitForLoad(tabId, { timeoutMs = 15000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === "complete") return true;
    } catch { return false; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** The polling loop. One at a time: parallel commands on one tab fight over the debugger. */
let running = false;
async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const ok = await round().catch(() => false);
      if (!ok) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => { loop(); });
chrome.runtime.onStartup.addListener(() => { loop(); });
chrome.action.onClicked.addListener(() => { loop(); });
chrome.alarms.create("dsh-bridge-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "dsh-bridge-keepalive") loop(); });

// Start immediately when the service worker is loaded by anything else (a page reload, a settings change).
loop();
