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

  const tabId = wantedTab ?? await pickTab();
  if (!tabId) throw new Error("没有可操作的标签页");

  try {
    await chrome.debugger.attach({ tabId }, ATTACH.version);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/already attached/i.test(message)) throw error;
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, ATTACH.version);
  }

  try {
    return await chrome.debugger.sendCommand({ tabId }, command.method, params);
  } finally {
    // `Page.navigate` leaves the target mid-load; detaching is what keeps a later attach from failing.
    await chrome.debugger.detach({ tabId }).catch(() => {});
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
    const result = await runCommand(command);
    body = { id: command.id, ok: true, result };
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
