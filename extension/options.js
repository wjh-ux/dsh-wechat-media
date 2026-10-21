/** Options page: where the plugin lives, and the token it expects. Saved in chrome.storage.local. */

const DEFAULTS = { endpoint: "http://127.0.0.1:9339", token: "" };

const $ = (id) => document.getElementById(id);

/** Fill the form from what is saved. */
async function load() {
  const saved = await chrome.storage.local.get(DEFAULTS);
  $("endpoint").value = saved.endpoint ?? DEFAULTS.endpoint;
  $("token").value = saved.token ?? "";
  await ping();
}

/** Ask the plugin whether it is up, and say so in one sentence. */
async function ping() {
  const saved = await chrome.storage.local.get(DEFAULTS);
  const endpoint = String(saved.endpoint ?? DEFAULTS.endpoint).replace(/\/$/, "");
  try {
    const response = await fetch(`${endpoint}/status`, {
      headers: { "x-dsh-token": String(saved.token ?? "") },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    $("status").textContent = body.connected
      ? `已连接：${body.name} · ${body.tabs} 个标签页 · 端口 ${body.port}`
      : `插件在线（端口 ${body.port}），但扩展还没连上——点一下工具栏图标`;
  } catch (error) {
    $("status").textContent = `连不上 ${endpoint}：${String(error?.message ?? error)}`;
  }
}

$("save").addEventListener("click", async () => {
  const endpoint = $("endpoint").value.trim() || DEFAULTS.endpoint;
  const token = $("token").value.trim();
  await chrome.storage.local.set({ endpoint, token });
  $("status").textContent = "已保存，正在重新连接…";
  // The background worker restarts on the next alarm; poking it now makes the change immediate.
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  setTimeout(ping, 800);
});

load();
