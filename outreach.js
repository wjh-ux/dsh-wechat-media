/**
 * dsh-wechat-media — outreach: turning a lead list into messages, without ever sending the same thing twice.
 *
 * Three channels exist in this plugin and they are not interchangeable:
 *
 *  - **email** is the only one that can reach a stranger. A lead's address is on its own website; that is enough.
 *  - **WeChat** and **WeCom** can only reach a *conversation that already exists* - a contact who wrote to the bot, or
 *    a group it was added to. There is no "cold message a phone number" API, and building one would be building a
 *    spam tool against a personal account, which is how accounts get banned.
 *
 * So this module plans against what actually exists: addresses for email, existing chats for the other two. Everything
 * here is pure - rendering, de-duplication, cooldowns, history - and the sending itself is the caller's job, which is
 * what makes "what would be sent" answerable before anything is.
 */

/** Placeholders a template may use, and what fills them. */
export const TEMPLATE_VARS = Object.freeze(["company", "email", "website", "city", "market", "country", "score", "role"]);

/**
 * Fill `{{name}}` placeholders.
 *
 * Unknown placeholders are left in place **and reported**, because a message that goes out reading `{{контакт}}` is
 * worse than one that refuses: the first is a mistake the recipient sees, the second is one the sender sees.
 */
export function renderTemplate(template, vars = {}) {
  const text = String(template ?? "");
  const missing = [];
  const rendered = text.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (whole, key) => {
    const value = vars[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      if (!missing.includes(key)) missing.push(key);
      return whole;
    }
    return String(value);
  });
  return { text: rendered, missing };
}

/** Which channel can reach this target at all. Kept explicit so "why was it skipped" always has an answer. */
export function addressFor(channel, target = {}) {
  if (channel === "email") {
    const email = String(target.email ?? "").trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { to: email.toLowerCase() } : { reason: "没有可用邮箱" };
  }
  if (channel === "wechat" || channel === "wecom") {
    const chatId = String(target.chatId ?? "").trim();
    if (!chatId) return { reason: "还没有这个联系人的会话（先让他给机器人发一条消息）" };
    if (target.allowed === false) return { reason: "这个会话在白名单里被标为忽略" };
    return { to: chatId };
  }
  return { reason: `未知通道：${channel}` };
}

/** Stable id for one planned message, so a plan can be re-read and a send can name exactly what it sent. */
export function planItemId(channel, to, index = 0) {
  const base = `${channel}:${String(to ?? "").toLowerCase()}`;
  return index ? `${base}#${index}` : base;
}

/**
 * Build the plan: who gets what, and why everyone else does not.
 *
 * Cooldown is the whole point. A lead list refreshed weekly would otherwise re-message the same 40 companies every
 * week, which is the fastest way to be marked as spam - and the plugin already had this failure once in its own
 * notification path, which is why this is a history table rather than a best-effort `lastSentAt`.
 */
export function planOutreach({
  channel = "email",
  targets = [],
  template = "",
  history = [],
  limit = 20,
  cooldownDays = 30,
  now = Date.now(),
} = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 20));
  const cooldownMs = Math.max(0, Number(cooldownDays) || 0) * 86400000;
  const sent = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    // Only a *delivered* message starts a cooldown. A bounce or a refused send is a reason to try again tomorrow, not
    // a reason to lock the address out for a month - measured by the test that sends to a bad mailbox first.
    if (!row || row.channel !== channel || row.ok === false) continue;
    const key = String(row.to ?? "").toLowerCase();
    const at = Number(row.at) || 0;
    if (!key) continue;
    if (!sent.has(key) || at > sent.get(key)) sent.set(key, at);
  }

  const items = [];
  const skipped = [];
  const seen = new Set();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (items.length >= cap) break;
    const label = String(target.company ?? target.name ?? target.chatId ?? "").trim() || "(未命名)";
    const address = addressFor(channel, target);
    if (address.reason) { skipped.push({ label, reason: address.reason }); continue; }
    const to = address.to;
    if (seen.has(to)) { skipped.push({ label, reason: "这批里重复" }); continue; }
    const lastAt = sent.get(to) ?? 0;
    if (lastAt && now - lastAt < cooldownMs) {
      const days = Math.max(1, Math.round((now - lastAt) / 86400000));
      skipped.push({ label, reason: `冷却期内（${days} 天前发过）` });
      continue;
    }
    const rendered = renderTemplate(template, {
      company: target.company,
      email: target.email,
      website: target.website ?? target.url,
      city: target.city ?? target.address,
      market: target.market,
      country: target.market,
      score: target.score,
      role: target.role,
    });
    if (rendered.missing.length) {
      skipped.push({ label, reason: `模板缺少取值：${rendered.missing.join(", ")}` });
      continue;
    }
    if (!rendered.text.trim()) { skipped.push({ label, reason: "模板渲染后是空的" }); continue; }
    seen.add(to);
    items.push({
      id: planItemId(channel, to, items.length + 1),
      channel, to, label,
      accountId: target.accountId ?? "", chatId: target.chatId ?? "",
      email: channel === "email" ? to : "",
      text: rendered.text.trim(),
      subject: String(target.subject ?? "").trim(),
    });
  }
  return { channel, items, skipped, createdAt: new Date(now).toISOString(), cooldownDays };
}

/** Append a send outcome to the history, keeping it bounded. */
export function recordSend(history, item, { ok = true, at = Date.now(), error = "" } = {}) {
  const rows = Array.isArray(history) ? [...history] : [];
  rows.push({ channel: item.channel, to: item.to, label: item.label, ok: Boolean(ok), at, error: String(error ?? "") });
  // 2000 rows is years of real outreach and still a small file; beyond that the oldest sends are already outside any
  // cooldown that matters.
  return rows.slice(-2000);
}

/** What has been sent, per channel - the answer to "did anything actually go out". */
export function outreachSummary(history, { now = Date.now() } = {}) {
  const rows = Array.isArray(history) ? history : [];
  const byChannel = {};
  for (const row of rows) {
    const channel = String(row?.channel ?? "?");
    byChannel[channel] = byChannel[channel] ?? { sent: 0, failed: 0, lastAt: 0 };
    if (row.ok) byChannel[channel].sent += 1; else byChannel[channel].failed += 1;
    byChannel[channel].lastAt = Math.max(byChannel[channel].lastAt, Number(row.at) || 0);
  }
  return {
    total: rows.length,
    byChannel,
    lastAt: rows.reduce((max, row) => Math.max(max, Number(row?.at) || 0), 0),
    recent: rows.slice(-5).map((row) => ({ channel: row.channel, label: row.label, ok: row.ok, at: row.at })),
  };
}

/** Human-readable plan, the same text a person reviews before saying yes. */
export function planText(plan, { preview = 3 } = {}) {
  const lines = [`通道 ${plan.channel}：${plan.items.length} 条待发，跳过 ${plan.skipped.length} 条（冷却 ${plan.cooldownDays} 天）`];
  for (const item of plan.items.slice(0, 12)) {
    const body = item.text.replace(/\s+/g, " ").slice(0, preview > 0 ? 120 : 0);
    lines.push(`  ${item.id}  → ${item.label} <${item.to}>`);
    if (body) lines.push(`      ${body}${item.text.length > 120 ? "…" : ""}`);
  }
  if (plan.items.length > 12) lines.push(`  …（还有 ${plan.items.length - 12} 条）`);
  const reasons = new Map();
  for (const row of plan.skipped) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  if (reasons.size) {
    lines.push("跳过原因：");
    for (const [reason, count] of reasons) lines.push(`  ${count} 条 · ${reason}`);
  }
  return lines.join("\n");
}
