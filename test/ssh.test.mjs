/**
 * The SSH module without a network: argv construction, host parsing, prefs validation, and the runner driven with a fake
 * `exec`. The properties that matter are the ones that fail silently in production - a missing `BatchMode` (hangs on a
 * password prompt), `StrictHostKeyChecking=no` (accepts a changed host key), or a `-p` where `scp` wants `-P`.
 */
import assert from "node:assert/strict";

const ssh = await import("../ssh.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

// ── host parsing ────────────────────────────────────────────────────────────
await test("a host spec is parsed the way people write it", () => {
  assert.deepEqual(ssh.parseHostSpec("root@192.168.1.10"), { user: "root", host: "192.168.1.10", port: 0 });
  assert.deepEqual(ssh.parseHostSpec("me@nas.local:2222"), { user: "me", host: "nas.local", port: 2222 });
  assert.deepEqual(ssh.parseHostSpec("nas.local"), { user: "", host: "nas.local", port: 0 });
  assert.deepEqual(ssh.parseHostSpec("me@[fe80::1]:22"), { user: "me", host: "fe80::1", port: 22 });
  // An unbracketed IPv6 literal must not be read as host:port.
  assert.deepEqual(ssh.parseHostSpec("me@fe80::1"), { user: "me", host: "fe80::1", port: 0 });
  assert.throws(() => ssh.parseHostSpec(""), /需要一个主机/);
  assert.throws(() => ssh.parseHostSpec("me@host:99999"), /端口不像话/);
});

await test("the prefs block is validated as a whole, and refuses what it cannot keep", () => {
  const clean = ssh.normalizeSshPrefs({
    enabled: true,
    hosts: [
      { name: "nas", host: "root@192.168.1.10", port: 22 },
      { name: "vps", host: "me@vps.example.com:2222" },
    ],
  });
  assert.equal(clean.enabled, true);
  assert.equal(clean.hosts.length, 2);
  assert.deepEqual(clean.hosts[0], { name: "nas", host: "192.168.1.10", user: "root", port: 22 });
  assert.deepEqual(clean.hosts[1], { name: "vps", host: "vps.example.com", user: "me", port: 2222 });

  assert.throws(() => ssh.normalizeSshPrefs({ hosts: [{ host: "x" }] }), /没有 name/);
  assert.throws(() => ssh.normalizeSshPrefs({ hosts: [{ name: "a" }] }), /没有 host/);
  assert.throws(() => ssh.normalizeSshPrefs({ hosts: [{ name: "a", host: "h" }, { name: "a", host: "g" }] }), /重复/);
  assert.throws(() => ssh.normalizeSshPrefs({ hosts: [{ name: "a", host: "h", identity: "C:\\nope\\id_ed25519" }] }), /identity 文件不存在/);
  // `enabled` is only true when it is exactly true: a string "true" must not arm remote execution.
  assert.equal(ssh.normalizeSshPrefs({ enabled: "true", hosts: [] }).enabled, false);
});

await test("a saved name resolves to its entry; anything else is an ad-hoc target", () => {
  const prefs = { ssh: { enabled: true, hosts: [{ name: "nas", host: "192.168.1.10", user: "root", port: 22 }] } };
  assert.deepEqual(ssh.resolveHost(prefs, "nas"), { name: "nas", host: "192.168.1.10", user: "root", port: 22, saved: true });
  const adhoc = ssh.resolveHost(prefs, "me@other:2200");
  assert.equal(adhoc.host, "other");
  assert.equal(adhoc.port, 2200);
  assert.equal(adhoc.saved, false);
  assert.throws(() => ssh.resolveHost(prefs, ""), /缺少 host/);
});

// ── argv ────────────────────────────────────────────────────────────────────
await test("ssh argv is batch-mode, learn-once, ported and identity-aware", () => {
  const args = ssh.buildSshArgs({ target: { user: "me", host: "h", port: 2222, identity: "C:\\k\\id" }, command: "uptime" });
  assert.deepEqual(args, [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-p", "2222",
    "-i", "C:\\k\\id",
    "--", "me@h", "uptime",
  ]);
  // The defaults, and a command that starts with a dash must not be read as an option.
  const plain = ssh.buildSshArgs({ target: { host: "h", port: 22 }, command: "-rf /" });
  assert.ok(plain.includes("BatchMode=yes"), "a password prompt would hang the turn");
  assert.ok(plain.join(" ").includes("StrictHostKeyChecking=accept-new"), "no= would accept a changed host key, yes= would break a first connection");
  assert.equal(plain.at(-2), "h");
  assert.equal(plain.at(-1), "-rf /");
  assert.throws(() => ssh.buildSshArgs({ target: { host: "h" }, command: "  " }), /缺少 command/);
});

await test("scp argv uses -P (not -p), and the direction decides the operand order", () => {
  const target = { user: "me", host: "h", port: 2222 };
  const up = ssh.buildScpArgs({ direction: "upload", target, local: "C:\\a.txt", remote: "/tmp/a.txt" });
  assert.ok(up.includes("-P"), "scp wants -P for the port; -p there means preserve times");
  assert.deepEqual(up.slice(-2), ["C:\\a.txt", "me@h:/tmp/a.txt"]);
  const down = ssh.buildScpArgs({ direction: "download", target, local: "C:\\b.txt", remote: "/tmp/b.txt" });
  assert.deepEqual(down.slice(-2), ["me@h:/tmp/b.txt", "C:\\b.txt"]);
  assert.ok(ssh.buildScpArgs({ direction: "upload", target, local: "C:\\d", remote: "/tmp", recursive: true }).includes("-r"));
  assert.throws(() => ssh.buildScpArgs({ direction: "sideways", target, local: "a", remote: "b" }), /direction/);
  assert.throws(() => ssh.buildScpArgs({ direction: "upload", target, local: "", remote: "b" }), /local/);
});

// ── runner ──────────────────────────────────────────────────────────────────
function fakeExec({ code = 0, stdout = "", stderr = "", error = null } = {}) {
  const calls = [];
  const exec = (program, args, options, callback) => {
    calls.push({ program, args, options });
    process.nextTick(() => callback(error ?? (code === 0 ? null : Object.assign(new Error("exit"), { code })), stdout, stderr));
    return {};
  };
  exec.calls = calls;
  return exec;
}

await test("a non-zero exit is data, not an exception", async () => {
  const result = await ssh.runOpenSsh("ssh.exe", ["x"], { exec: fakeExec({ code: 7, stdout: "out", stderr: "boom" }) });
  assert.equal(result.code, 7);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "boom");
});

await test("a timeout says so instead of looking like a remote failure", async () => {
  const killed = Object.assign(new Error("killed"), { killed: true });
  await assert.rejects(() => ssh.runOpenSsh("ssh.exe", [], { exec: fakeExec({ error: killed }), timeoutMs: 5 }), /超时/);
});

await test("a missing client names the program", async () => {
  const missing = Object.assign(new Error("spawn ENOENT"), { code: 1 });
  await assert.rejects(() => ssh.runOpenSsh("nope-ssh", [], { exec: fakeExec({ error: missing }) }), /找不到 ssh 客户端/);
});

await test("output is capped with a flag, not silently cut", () => {
  const long = "x".repeat(ssh.SSH_OUTPUT_MAX_CHARS + 10);
  const capped = ssh.capOutput(long);
  assert.equal(capped.text.length, ssh.SSH_OUTPUT_MAX_CHARS);
  assert.equal(capped.truncated, true);
  assert.deepEqual(ssh.capOutput("short"), { text: "short", truncated: false });
});

await test("execRemote resolves a saved host and reports what happened", async () => {
  const exec = fakeExec({ code: 0, stdout: "Linux nas 6.1\n" });
  const result = await ssh.execRemote({
    prefs: { ssh: { enabled: true, hosts: [{ name: "nas", host: "192.168.1.10", user: "root", port: 2222 }] } },
    host: "nas",
    command: "uname -a",
    exec,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Linux nas/);
  assert.equal(result.target.name, "nas");
  assert.equal(exec.calls.length, 1);
  const call = exec.calls[0];
  assert.ok(/ssh(\.exe)?$/i.test(call.program));
  assert.ok(call.args.includes("2222"));
  assert.equal(call.args.at(-1), "uname -a");
});

await test("transferRemote hands scp the right direction and says which one it did", async () => {
  const exec = fakeExec({ code: 0 });
  const result = await ssh.transferRemote({
    prefs: { ssh: { enabled: true, hosts: [{ name: "nas", host: "10.0.0.2", user: "root", port: 22 }] } },
    host: "nas",
    direction: "download",
    local: "C:\\tmp\\x.txt",
    remote: "/etc/hosts",
    exec,
  });
  assert.equal(result.direction, "download");
  assert.deepEqual(exec.calls[0].args.slice(-2), ["root@10.0.0.2:/etc/hosts", "C:\\tmp\\x.txt"]);
});

await test("support is reported per platform instead of assumed", () => {
  assert.equal(ssh.sshSupport({ platform: "linux" }).ok, true);
  assert.equal(ssh.sshSupport({ platform: "darwin" }).ok, true);
  const win = ssh.sshSupport({ platform: "win32" });
  assert.equal(win.ok, true, "OpenSSH ships with Windows 10/11");
  assert.match(win.ssh, /ssh\.exe$/i);
  assert.equal(ssh.sshSupport({ platform: "aix" }).ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
