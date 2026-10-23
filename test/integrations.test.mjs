/**
 * Smoke-check the three new integration helpers without a running harness: the dashboard renders, the inbound request
 * normaliser accepts and rejects the right shapes, and the webhook signature matches an independent HMAC.
 */
import { createHmac } from "node:crypto";

const module = await import("../index.js");

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(["ok  ", name]);
  } catch (error) {
    checks.push(["FAIL", `${name} — ${error?.message ?? error}`]);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── dashboard ───────────────────────────────────────────────────────────────
const html = module.dashboardHtml({
  version: "1.2.3",
  builtAt: new Date().toISOString(),
  loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
  counters: { inboundRequests: 3, webhookSent: 2, retryFailed: 1, blocked: 0 },
  tokens: {
    total: { totalTokens: 12345, inputTokens: 100, outputTokens: 50, cachedTokens: 99, calls: 7 },
    windowDays: 30,
    accounts: [{ accountId: "acc1", chatId: "chat1", totalTokens: 99, calls: 2 }],
  },
  peers: { x: { y: {} } },
  tasks: { count: 1, enabled: 1 },
  prefs: { inboundToken: "abcdef0123456789", webhookUrl: "https://example.com/hook", webhookSecret: "***" },
  accounts: [{ accountId: "acc1", running: true, lastPollAt: Date.now() }],
  webhook: { last: { at: new Date().toISOString(), ok: true, status: 204 } },
  lastInbound: {},
  stream: {},
  routes: [{ path: "/inbound", at: Date.now() }],
});

check("dashboard renders the version and the three sections", () => {
  assert(html.includes("1.2.3"), "version must appear");
  for (const heading of ["会话与账号", "失败与丢弃", "Token 用量", "最近活动", "配置"]) {
    assert(html.includes(heading), `missing section ${heading}`);
  }
});
check("dashboard groups digits and shows the token ledger", () => {
  assert(html.includes("12,345"), "thousands separators");
  assert(html.includes("acc1"), "per-conversation row");
});
check("dashboard escapes attacker-shaped values", () => {
  const nasty = module.dashboardHtml({ prefs: { webhookUrl: "<script>alert(1)</script>", inboundToken: "\"><b>x" } });
  assert(!nasty.includes("<script>alert"), "a URL must not become markup");
  assert(nasty.includes("&lt;script&gt;"), "and must be escaped instead");
});
check("dashboard marks failures in red", () => {
  const failed = module.dashboardHtml({ counters: { retryFailed: 4, webhookFailed: 1 } });
  assert(failed.includes('class="bad"'), "a non-zero failure count must be visible as bad");
});

// ── inbound request ─────────────────────────────────────────────────────────
check("inbound accepts text + peer and defaults to wechat/reply", () => {
  const request = module.normalizeInboundRequest({ text: "  跑一遍测试  ", peer: "wxid_abc" });
  assert(request.text === "跑一遍测试", "text trimmed");
  assert(request.peer === "wxid_abc", "peer kept");
  assert(request.transport === "wechat", "default transport");
  assert(request.reply === true, "reply defaults to true");
});
check("inbound honours reply:false and an id", () => {
  const request = module.normalizeInboundRequest({ text: "x", peer: "p", reply: false, id: "ci-1", transport: "feishu" });
  assert(request.reply === false, "explicit false");
  assert(request.transport === "feishu", "transport kept");
  assert(request.id === "ci-1", "id kept");
});
check("inbound refuses an empty text or peer, and an oversized body", () => {
  assert(module.normalizeInboundRequest({ peer: "p" }).error, "missing text must be refused");
  assert(module.normalizeInboundRequest({ text: "x" }).error, "missing peer must be refused");
  assert(module.normalizeInboundRequest({ text: "x".repeat(8001), peer: "p" }).error, "oversized text must be refused");
});
check("an unknown transport falls back to wechat instead of guessing", () => {
  assert(module.normalizeInboundRequest({ text: "x", peer: "p", transport: "telegram" }).transport === "wechat", "fallback");
});

// ── inbound auth ────────────────────────────────────────────────────────────
check("inbound auth needs the token and rejects a near miss", () => {
  const prefs = { inboundToken: "0123456789abcdef" };
  assert(module.inboundTokenAccepted(prefs, { "x-dsh-token": "0123456789abcdef" }).ok === true, "exact token accepted");
  assert(module.inboundTokenAccepted(prefs, { authorization: "Bearer 0123456789abcdef" }).ok === true, "bearer accepted");
  assert(module.inboundTokenAccepted(prefs, {}).ok === false, "no token refused");
  assert(module.inboundTokenAccepted(prefs, { "x-dsh-token": "0123456789abcde" }).ok === false, "short token refused");
  assert(module.inboundTokenAccepted({}, { "x-dsh-token": "x" }).ok === false, "no configured token refused");
});

// ── webhook signature ───────────────────────────────────────────────────────
check("the webhook signature is a plain HMAC-SHA256 over body+secret", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ event: "turn.end", answer: "你好" });
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert(module.webhookSignature(secret, body) === expected, "must match an independent HMAC");
  assert(module.webhookSignature("", body) === "", "no secret means no signature header");
});
check("a different secret or body changes the signature", () => {
  const a = module.webhookSignature("a", "body");
  const b = module.webhookSignature("b", "body");
  const c = module.webhookSignature("a", "body2");
  assert(a !== b && a !== c, "signature must depend on both parts");
});

for (const [status, line] of checks) console.log(`${status} ${line}`);
const failed = checks.filter(([status]) => status === "FAIL").length;
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
