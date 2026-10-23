/**
 * SSH, as tools: run a command on another machine, and move a file there or back.
 *
 * Deliberately built on the platform's own OpenSSH client (`ssh.exe` / `scp.exe`) instead of a JS SSH library: those
 * binaries ship with Windows 10+, honour `~/.ssh/config` and `known_hosts`, and keep the private key exactly where the
 * person already put it. Nothing here reads a key file's contents - only its path.
 *
 * Three rules, each for a reason:
 *
 * - **Key-based only.** A password cannot be passed safely from a service-like process (no TTY, no prompt), so
 *   `BatchMode=yes` is always set: an auth problem fails fast with the client's own message instead of hanging.
 * - **Host keys are learned once, not ignored.** `StrictHostKeyChecking=accept-new` records a new host key and refuses a
 *   *changed* one; `no` would silently accept a man-in-the-middle, and `yes` would make the first connection impossible.
 * - **Off until armed.** Running commands on someone's servers is not a default-on capability; `/ssh on` is the switch,
 *   checked before any process starts.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const SSH_TIMEOUT_MS = 60_000;
export const SSH_OUTPUT_MAX_CHARS = 40_000;

/** Can this machine do it, and with what? */
export function sshSupport({ platform = process.platform } = {}) {
  if (platform === "win32") {
    const client = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
    return existsSync(client)
      ? { ok: true, ssh: client, scp: client.replace(/ssh\.exe$/i, "scp.exe") }
      : { ok: false, reason: "找不到 OpenSSH（Windows 10/11 的「可选功能 → OpenSSH 客户端」）" };
  }
  if (platform === "darwin" || platform === "linux") return { ok: true, ssh: "ssh", scp: "scp" };
  return { ok: false, reason: `不支持这个平台：${platform}` };
}

/**
 * `user@host`, `user@host:2222` or `host` → parts. The port is only taken from `:` after the host, never from an IPv6
 * literal (which would make `fe80::1` parse as port `:1`), so a bracketed `[fe80::1]:22` is also accepted.
 */
export function parseHostSpec(spec) {
  const text = String(spec ?? "").trim();
  if (!text) throw new Error("需要一个主机：user@host 或 user@host:port");
  const at = text.lastIndexOf("@");
  const user = at >= 0 ? text.slice(0, at) : "";
  const rest = at >= 0 ? text.slice(at + 1) : text;
  let host = rest;
  let port = 0;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    host = bracketed[1];
    port = Number(bracketed[2] ?? 0);
  } else if (/^[^:]+:\d+$/.test(rest)) {
    const index = rest.lastIndexOf(":");
    host = rest.slice(0, index);
    port = Number(rest.slice(index + 1));
  }
  if (!host.trim()) throw new Error(`主机是空的：${JSON.stringify(spec)}`);
  if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`端口不像话：${port}`);
  return { user: user.trim(), host: host.trim(), port };
}

/**
 * Validate the saved `ssh` prefs block: `{ enabled, hosts: [{ name, host, user, port, identity }] }`.
 *
 * Invalid input is refused with a sentence rather than silently repaired: a host list that quietly lost an entry is a
 * worse failure than one that says why it could not be saved.
 */
export function normalizeSshPrefs(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const hosts = [];
  const seen = new Set();
  for (const [index, raw] of (Array.isArray(source.hosts) ? source.hosts : []).entries()) {
    const item = raw && typeof raw === "object" ? raw : {};
    const name = String(item.name ?? "").trim();
    const spec = String(item.host ?? "").trim();
    if (!name) throw new Error(`第 ${index + 1} 个主机没有 name`);
    if (!spec) throw new Error(`主机 ${name} 没有 host`);
    if (seen.has(name)) throw new Error(`主机名重复：${name}`);
    seen.add(name);
    const parsed = parseHostSpec(spec.includes("@") || /:/.test(spec) ? spec : spec);
    const user = String(item.user ?? "").trim() || parsed.user;
    const port = Number(item.port ?? 0) || parsed.port || 22;
    const identity = String(item.identity ?? "").trim();
    if (identity && !existsSync(identity)) throw new Error(`主机 ${name} 的 identity 文件不存在：${identity}`);
    hosts.push({
      name,
      host: parsed.host,
      user,
      port,
      ...(identity ? { identity } : {}),
    });
  }
  return { enabled: source.enabled === true, hosts };
}

/** The host a tool call names: a saved name, or an ad-hoc `user@host[:port]` (which is not saved). */
export function resolveHost(prefs, wanted) {
  const key = String(wanted ?? "").trim();
  if (!key) throw new Error("缺少 host：写一个已保存的主机名，或 user@host[:port]");
  // Accept either the whole prefs object or the `ssh` block itself: the tools hold one and the routes hold the other,
  // and a lookup that silently ignored the host list would make every saved name fail as an ad-hoc spec.
  const block = prefs && typeof prefs === "object" && prefs.ssh !== undefined ? prefs.ssh : prefs;
  const saved = normalizeSshPrefs(block).hosts.find((entry) => entry.name === key);
  if (saved) return { ...saved, saved: true };
  const parsed = parseHostSpec(key);
  return { name: key, host: parsed.host, user: parsed.user, port: parsed.port || 22, saved: false };
}

/** The argv for one `ssh` command. `--` keeps a command that starts with `-` from being read as an option. */
export function buildSshArgs({ target, command, connectTimeout = 10 } = {}) {
  const text = String(command ?? "").trim();
  if (!text) throw new Error("缺少 command");
  const host = `${target.user ? `${target.user}@` : ""}${target.host}`;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Math.max(1, Math.min(120, Number(connectTimeout) || 10))}`,
    "-p", String(target.port || 22),
  ];
  if (target.identity) args.push("-i", target.identity);
  args.push("--", host, text);
  return args;
}

/** The argv for one `scp` transfer. `-O` forces the classic protocol, which Windows' scp speaks to older servers. */
export function buildScpArgs({ direction, target, local, remote, recursive = false } = {}) {
  const from = String(local ?? "").trim();
  const to = String(remote ?? "").trim();
  if (!from) throw new Error("缺少 local 路径");
  if (!to) throw new Error("缺少 remote 路径");
  const host = `${target.user ? `${target.user}@` : ""}${target.host}`;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-P", String(target.port || 22),
  ];
  if (target.identity) args.push("-i", target.identity);
  if (recursive) args.push("-r");
  if (direction === "upload") args.push("--", from, `${host}:${to}`);
  else if (direction === "download") args.push("--", `${host}:${to}`, from);
  else throw new Error(`direction 只能是 upload 或 download，收到 ${direction}`);
  return args;
}

/** Run one OpenSSH program and collect its result; never throws on a non-zero exit (that is data, not an exception). */
export function runOpenSsh(program, args, { exec = execFile, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    exec(program, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, out, err) => {
      const stdout = String(out ?? "");
      const stderr = String(err ?? "");
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      // A timeout or a missing binary is not a remote failure; say which it was.
      if (error && error.killed) {
        reject(new Error(`超时（${timeoutMs}ms）：${stderr.trim().split(/\r?\n/)[0] || "没有输出"}`));
        return;
      }
      if (error && code === 1 && /ENOENT/.test(String(error.message ?? ""))) {
        reject(new Error(`找不到 ssh 客户端：${program}`));
        return;
      }
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/** Cap a captured stream so a chatty remote command cannot flood a turn. */
export function capOutput(text, maxChars = SSH_OUTPUT_MAX_CHARS) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

/**
 * Run a command on a host and return a report ready for a chat: exit code, stdout, stderr, timing, and whether either
 * stream was cut.
 */
export async function execRemote({ prefs, host, command, exec, timeoutMs = SSH_TIMEOUT_MS, connectTimeout = 10 } = {}) {
  const target = resolveHost(prefs, host);
  const support = sshSupport();
  if (!support.ok) throw new Error(support.reason);
  const args = buildSshArgs({ target, command, connectTimeout });
  const result = await runOpenSsh(support.ssh, args, { exec, timeoutMs });
  const out = capOutput(result.stdout);
  const err = capOutput(result.stderr);
  return { ...result, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, target };
}

/** Move one file: upload from this machine, or download to it. */
export async function transferRemote({ prefs, host, direction, local, remote, recursive = false, exec, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  const target = resolveHost(prefs, host);
  const support = sshSupport();
  if (!support.ok) throw new Error(support.reason);
  const args = buildScpArgs({ direction, target, local, remote, recursive });
  const result = await runOpenSsh(support.scp, args, { exec, timeoutMs });
  return { ...result, target, direction };
}
