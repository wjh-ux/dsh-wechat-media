/**
 * The email channel, part 1: everything that can be decided without a socket.
 *
 * Email is the one channel where **anyone on the internet can send you a message**, so two decisions shape this module:
 *
 *   - inbound is off until `allowSenders` names at least one address. An empty list is not "everyone", it is "nobody": a bridge with
 *     shell access that answers any stranger who guesses the address is not a feature.
 *   - the parser is defensive. Mail is the most hostile text format in common use - multipart, base64, quoted-printable, charsets,
 *     folded headers - so every field is optional and every decode has a fallback.
 */
import { createHash } from "node:crypto";

/** Ports and their default security, so a half-filled form still yields something coherent. */
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_IMAP_PORT = 993;

/** A poll faster than this is a way to get rate-limited by the mail provider. */
export const MIN_POLL_SECONDS = 15;
export const MAX_POLL_SECONDS = 600;

/** An address, once: `Name <a@b.c>` or `a@b.c`. */
export function parseAddressLine(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { name: "", address: "" };
  const angled = /^(.*?)<([^>]+)>/.exec(text);
  if (angled) {
    const name = angled[1].trim().replace(/^"|"$/g, "").trim();
    return { name, address: angled[2].trim().toLowerCase() };
  }
  return { name: "", address: text.toLowerCase() };
}

export function isEmailAddress(value) {
  const text = String(value ?? "").trim();
  return /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/.test(text);
}

/** The account id this bridge uses for the mailbox, in the same style as `wecom:` / `qq-`. */
export function emailAccountId(user) {
  const text = String(user ?? "").trim().toLowerCase();
  return `email:${text}`;
}

/**
 * Validate an email block. Returns `{ value }` or `{ error }` - never throws, because it is called straight from a route.
 *
 * The passwords are optional here: a saved password is sent back masked, so "leave it empty" has to mean keep it.
 */
export function normalizeEmailPrefs(source) {
  const input = source && typeof source === "object" ? source : {};
  const enabled = input.enabled === true;
  const user = String(input.user ?? "").trim().toLowerCase();
  const smtpHost = String(input.smtpHost ?? "").trim();
  const imapHost = String(input.imapHost ?? "").trim();
  const smtpPort = Number(input.smtpPort ?? DEFAULT_SMTP_PORT);
  const imapPort = Number(input.imapPort ?? DEFAULT_IMAP_PORT);
  const pollSeconds = Number(input.pollSeconds ?? 60);

  if (user && !isEmailAddress(user)) return { error: `邮箱地址不像话：${JSON.stringify(user)}` };
  for (const [label, host] of [["smtpHost", smtpHost], ["imapHost", imapHost]]) {
    if (host && !/^[A-Za-z0-9.-]+$/.test(host)) return { error: `${label} 不像话：${JSON.stringify(host)}` };
  }
  for (const [label, port] of [["smtpPort", smtpPort], ["imapPort", imapPort]]) {
    if (!Number.isFinite(port) || port < 1 || port > 65535) return { error: `${label} 必须是 1..65535（收到 ${input[label]}）` };
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds < MIN_POLL_SECONDS || pollSeconds > MAX_POLL_SECONDS) {
    return { error: `pollSeconds 必须是 ${MIN_POLL_SECONDS}..${MAX_POLL_SECONDS}（收到 ${input.pollSeconds}）` };
  }

  const allowSenders = Array.isArray(input.allowSenders)
    ? input.allowSenders
    : String(input.allowSenders ?? "").split(/[\s,;]+/);
  const senders = [];
  for (const entry of allowSenders) {
    const { address } = parseAddressLine(entry);
    if (!address) continue;
    if (!isEmailAddress(address)) return { error: `allowSenders 里有不像邮箱的项：${JSON.stringify(entry)}` };
    if (!senders.includes(address)) senders.push(address);
  }

  const caFile = String(input.caFile ?? "").trim();
  if (caFile && !/^[A-Za-z]:[\\/]|^\//.test(caFile)) {
    return { error: `caFile 必须是绝对路径（收到 ${JSON.stringify(caFile)}）` };
  }

  const value = {
    enabled,
    user,
    smtpHost,
    smtpPort,
    smtpSecure: input.smtpSecure !== false,
    imapHost,
    imapPort,
    imapSecure: input.imapSecure !== false,
    folder: String(input.folder ?? "INBOX").trim() || "INBOX",
    pollSeconds,
    autoReply: input.autoReply !== false,
    allowSenders: senders,
    ...(caFile ? { caFile } : {}),
  };
  // Passwords only travel when they are actually new: the card shows `***` for a stored one, and posting that back must not
  // replace it with three asterisks.
  for (const field of ["smtpPass", "imapPass"]) {
    const candidate = String(input[field] ?? "");
    if (candidate && candidate !== "***") value[field] = candidate;
  }
  return { value };
}

/** Why inbound would not work right now, in one line, or an empty string when it would. */
export function emailReadiness(prefs) {
  const email = prefs?.email ?? {};
  if (email.enabled !== true) return "邮件通道未开启";
  if (!email.user) return "缺少邮箱地址";
  if (!email.smtpHost) return "缺少 SMTP 服务器";
  if (!email.imapHost) return "缺少 IMAP 服务器";
  if (!String(email.smtpPass ?? "").trim()) return "缺少 SMTP 密码";
  if (!String(email.imapPass ?? "").trim()) return "缺少 IMAP 密码";
  if (!Array.isArray(email.allowSenders) || email.allowSenders.length === 0) {
    return "没有允许的发件人：邮件通道默认拒绝所有人（在 allowSenders 里加上你自己的地址）";
  }
  return "";
}

/**
 * Is this sender allowed to reach the agent?
 *
 * Deliberately a separate decision from the chat allowlist: an email address is trivial to spoof, so the default is deny and only an
 * explicit list opens it.
 */
export function senderAllowed(prefs, sender) {
  const email = prefs?.email ?? {};
  const address = parseAddressLine(sender).address;
  const list = Array.isArray(email.allowSenders) ? email.allowSenders : [];
  if (!address) return { allowed: false, reason: "no sender" };
  if (!list.length) return { allowed: false, reason: "empty allowlist" };
  if (list.includes(address)) return { allowed: true, reason: "allowlisted" };
  // A wildcard domain (`*@example.com`) is also accepted: a team mailbox is a real case, an open list is not.
  const domain = address.split("@")[1] ?? "";
  if (list.includes(`*@${domain}`)) return { allowed: true, reason: "domain" };
  return { allowed: false, reason: "not-listed" };
}

// ── MIME ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function decodeQuotedPrintable(text) {
  return String(text ?? "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(text) {
  try {
    return Buffer.from(String(text ?? "").replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Convert the small subset of HTML that mail clients produce into readable text. */
export function htmlToText(html) {
  let text = String(html ?? "");
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "· ");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Decode a body part according to its own headers.
 *
 * `charset` is honoured for utf-8 and latin1; anything else falls back to utf-8 bytes read as latin1, which is lossy but never throws -
 * a broken mail must not take a turn down.
 */
export function decodePart(headers, body) {
  const encoding = String(headers["content-transfer-encoding"] ?? "").trim().toLowerCase();
  const charset = (String(headers["content-type"] ?? "").match(/charset="?([^";]+)"?/i)?.[1] ?? "utf-8").toLowerCase();
  let text;
  if (encoding === "base64") text = decodeBase64(body);
  else if (encoding === "quoted-printable") {
    const bytes = Buffer.from(decodeQuotedPrintable(body), "latin1");
    text = /utf-?8|gb/.test(charset) ? bytes.toString(/gb/i.test(charset) ? "latin1" : "utf8") : bytes.toString("latin1");
  } else text = String(body ?? "");
  return text;
}

/** Split a raw message into folded headers and the body text after them. */
export function splitMessage(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  const boundary = text.indexOf("\n\n");
  const head = boundary < 0 ? text : text.slice(0, boundary);
  const body = boundary < 0 ? "" : text.slice(boundary + 2);
  const headers = {};
  let last = "";
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    last = match[1].toLowerCase();
    headers[last] = match[2];
  }
  return { headers, body };
}

/**
 * Decode RFC 2047 encoded words: `=?UTF-8?B?…?=` (base64) and `=?UTF-8?Q?…?=` (quoted-printable).
 *
 * A mail client sends a non-ASCII subject this way, so without this the model is handed base64 where the topic should be - which is
 * what a Chinese subject looked like before the loop test caught it.
 */
export function decodeEncodedWords(value) {
  const text = String(value ?? "");
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, payload) => {
    try {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(payload, "base64")
          : Buffer.from(decodeQuotedPrintable(payload.replace(/_/g, " ")), "latin1");
      const name = String(charset).toLowerCase();
      if (/utf-?8/.test(name)) return bytes.toString("utf8");
      if (/gb/i.test(name)) return bytes.toString("latin1");
      if (/iso-8859-1|latin1/.test(name)) return bytes.toString("latin1");
      return bytes.toString("utf8");
    } catch {
      return whole;
    }
  })
    // RFC 2047: whitespace *between* two encoded words is dropped, not preserved.
    .replace(/(\?=)\s+(=\?)/g, "$1$2");
}

/**
 * The text a mail contributes to a turn.
 *
 * `text/plain` wins when both parts exist: it is what the sender meant, and the HTML alternative is usually the same words wrapped in
 * markup. Attachments are named but not downloaded - the file tools can read a saved path, and guessing where to put a stranger's
 * attachment is not this module's call.
 */
export function parseMail(raw) {
  const { headers, body } = splitMessage(raw);
  const from = parseAddressLine(headers.from ?? "");
  const contentType = String(headers["content-type"] ?? "");
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  let text = "";
  const attachments = [];

  if (/multipart\//i.test(contentType) && boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(`--${boundary}`);
    const found = [];
    for (const part of parts) {
      const trimmed = part.replace(/^\n/, "");
      if (!trimmed || /^--/.test(trimmed)) continue;
      const split = splitMessage(trimmed);
      const partType = String(split.headers["content-type"] ?? "text/plain");
      const disposition = String(split.headers["content-disposition"] ?? "");
      const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? /name="?([^";]+)"?/i.exec(partType)?.[1];
      if (/attachment/i.test(disposition) || /name=/.test(partType)) {
        if (name) attachments.push(name);
        continue;
      }
      if (/text\/html/i.test(partType)) found.push({ type: "html", text: htmlToText(decodePart(split.headers, split.body)) });
      else if (/text\/plain/i.test(partType)) found.push({ type: "text", text: decodePart(split.headers, split.body) });
    }
    const plain = found.find((entry) => entry.type === "text");
    text = (plain ?? found[0])?.text ?? "";
  } else if (/text\/html/i.test(contentType)) {
    text = htmlToText(decodePart(headers, body));
  } else {
    text = decodePart(headers, body);
  }

  // Quoted reply text would be fed back to the model as if the person had typed it.
  const withoutQuotes = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/\n*^--\s*$/m, "")
    .trim();

  return {
    from: from.address,
    fromName: decodeEncodedWords(from.name),
    to: parseAddressLine((headers.to ?? "").split(",")[0]).address,
    subject: decodeEncodedWords(String(headers.subject ?? "")).replace(/\s+/g, " ").trim(),
    messageId: String(headers["message-id"] ?? "").trim(),
    inReplyTo: String(headers["in-reply-to"] ?? "").trim(),
    references: String(headers.references ?? "").trim(),
    date: String(headers.date ?? "").trim(),
    text: withoutQuotes,
    attachments,
  };
}

/** `Re: Re: x` -> `Re: x`, so a thread does not accumulate prefixes. */
export function replySubject(subject) {
  const base = String(subject ?? "").replace(/^\s*((re|fw|fwd|答复|回复)\s*:\s*)+/i, "").trim();
  return `Re: ${base || "(无主题)"}`;
}

/** Threading headers for the reply, so mail clients group it with the question. */
export function threadHeaders(original) {
  const messageId = String(original?.messageId ?? "").trim();
  const references = String(original?.references ?? "").trim();
  const headers = {};
  if (messageId) {
    headers["In-Reply-To"] = messageId;
    headers.References = references ? `${references} ${messageId}` : messageId;
  }
  return headers;
}

/** A stable id for de-duplicating a message, even when the server omits Message-ID. */
export function messageKey(parsed) {
  const explicit = String(parsed?.messageId ?? "").trim();
  if (explicit) return explicit;
  return `sha:${createHash("sha256").update(`${parsed?.from ?? ""}|${parsed?.subject ?? ""}|${parsed?.date ?? ""}|${parsed?.text ?? ""}`).digest("hex").slice(0, 32)}`;
}

/** The prompt text a mail contributes, in the same shape as the chat channels. */
export function describeForModel(parsed) {
  const who = parsed.fromName ? `${parsed.fromName} <${parsed.from}>` : parsed.from;
  const lines = [`[邮件] ${who}`, `主题：${parsed.subject || "(无主题)"}`];
  if (parsed.attachments?.length) lines.push(`附件（未下载）：${parsed.attachments.join("、")}`);
  lines.push("", parsed.text || "(正文为空)");
  return lines.join("\n");
}
