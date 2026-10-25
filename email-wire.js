/**
 * The email channel, part 2: the two protocols, written out rather than imported.
 *
 * This plugin has no runtime dependencies, and adding two (a mail sender and an IMAP client) for one channel would be a large trade:
 * tens of megabytes and a supply-chain surface, in a process that already holds chat credentials. What the channel actually needs is
 * small - EHLO/AUTH/MAIL/RCPT/DATA on the way out, LOGIN/SELECT/SEARCH/FETCH on the way in - so both are implemented here against
 * `node:tls` / `node:net`, and tested against fake servers in the suite.
 *
 * Both clients are deliberately narrow: no IDLE (a poll is enough and survives sleep), no pipelining, no attachment download.
 */

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A tiny line-oriented client over a socket, shared by both protocols.
 *
 * Buffers until a terminator is present, so a response split across packets is not a parse error - which is the single most common way
 * a hand-written protocol client breaks in the wild.
 */
class LineSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    /** Readers waiting for a number of bytes. */
    this.waiters = [];
    /** Callers waiting for *any* more data (used by readLine, which must not consume what it has not matched). */
    this.wakers = [];
    this.closed = false;
    this.error = null;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#flush();
    });
    socket.on("error", (error) => {
      this.error = error;
      this.#flush();
    });
    socket.on("close", () => {
      this.closed = true;
      this.#flush();
    });
  }

  #flush() {
    if (this.buffer.length > 0 || this.closed || this.error) {
      const wakers = this.wakers.splice(0);
      for (const waker of wakers) {
        if (this.error) waker.reject(this.error);
        else if (this.closed && this.buffer.length === 0) waker.reject(new Error("connection closed"));
        else waker.resolve();
      }
    }
    for (const waiter of [...this.waiters]) {
      if (this.buffer.length >= waiter.bytes) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        const chunk = this.buffer.subarray(0, waiter.bytes);
        this.buffer = this.buffer.subarray(waiter.bytes);
        waiter.resolve(chunk);
      } else if (this.closed || this.error) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.reject(this.error ?? new Error("connection closed"));
      }
    }
  }

  /** Read exactly `bytes` bytes. */
  readBytes(bytes) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ bytes, resolve, reject });
      this.#flush();
    });
  }

  /** Resolve as soon as there is more data, without consuming any of it. */
  waitForData() {
    return new Promise((resolve, reject) => {
      this.wakers.push({ resolve, reject });
      this.#flush();
    });
  }

  /** Read one line, without its CRLF; rejects on EOF or error. */
  async readLine() {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  write(text) {
    this.socket.write(text);
  }

  close() {
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

function openSocket({ host, port, secure, timeoutMs = DEFAULT_TIMEOUT_MS, ca }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true, ...(ca ? { ca } : {}) })
      : netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.once(secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Wrap the body in the MIME envelope a mail client expects. */
export function buildMail({ from, to, subject, text, headers = {}, messageId }) {
  const date = new Date().toUTCString().replace(/GMT$/, "+0000");
  const body = Buffer.from(String(text ?? ""), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(String(subject ?? ""), "utf8").toString("base64")}?=`,
    `Date: ${date}`,
    `Message-ID: ${messageId ?? `<${randomUUID()}@dsh-wechat-media>`}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "User-Agent: dsh-wechat-media",
  ];
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    lines.push(`${key}: ${String(value).replace(/[\r\n]+/g, " ")}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

/**
 * Send one plain-text message.
 *
 * STARTTLS is used when the connection started in the clear and the server offers it; a server that offers neither is refused rather
 * than sent credentials in the clear - a mail password on a plaintext socket is worse than a failed send.
 */
export async function smtpSend({
  host,
  port,
  secure = true,
  user,
  pass,
  mail,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  socketFactory = openSocket,
  ca,
}) {
  let socket = await socketFactory({ host, port, secure, timeoutMs, ca });
  let client = new LineSocket(socket);
  const transcript = [];
  /** Read one reply, following `250-` continuation lines, and hand back the final line. */
  const reply = async (label) => {
    let line = await client.readLine();
    transcript.push(`${label} <- ${line}`);
    while (/^\d{3}-/.test(line)) {
      line = await client.readLine();
      transcript.push(`${label} <- ${line}`);
    }
    return line;
  };
  /** Send a command (when given) and check the reply code. */
  const talk = async (label, accept, command) => {
    if (command !== undefined) {
      transcript.push(`${label} -> ${command}`);
      client.write(`${command}\r\n`);
    }
    const line = await reply(label);
    const code = Number(line.slice(0, 3));
    if (!accept(code)) throw new Error(`SMTP ${label} 失败：${line}`);
    return line;
  };

  try {
    await talk("greeting", (code) => code === 220);
    const ehloLine = await talk("EHLO", (code) => code === 250, `EHLO ${host}`);

    if (!secure && /STARTTLS/i.test(ehloLine)) {
      await talk("STARTTLS", (code) => code === 220, "STARTTLS");
      socket = await socketFactory({ host, port, secure: true, timeoutMs, replace: socket, ca });
      client = new LineSocket(socket);
      await talk("EHLO (tls)", (code) => code === 250, `EHLO ${host}`);
    }
    if (!secure && !/STARTTLS/i.test(ehloLine)) {
      throw new Error("服务器不支持 STARTTLS，拒绝用明文发送密码（改用 465 端口或换服务器）");
    }

    if (user) {
      await talk("AUTH LOGIN", (code) => code === 334, "AUTH LOGIN");
      await talk("user", (code) => code === 334, Buffer.from(user, "utf8").toString("base64"));
      await talk("pass", (code) => code === 235, Buffer.from(String(pass ?? ""), "utf8").toString("base64"));
    }

    await talk("MAIL FROM", (code) => code === 250, `MAIL FROM:<${mail.from}>`);
    await talk("RCPT TO", (code) => code === 250 || code === 251, `RCPT TO:<${mail.to}>`);
    await talk("DATA", (code) => code === 354, "DATA");
    const payload = `${mail.payload
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n")}\r\n.\r\n`;
    client.write(payload);
    await talk("body", (code) => code === 250);
    // Wait for the 221 instead of closing the socket on the spot.
    await talk("QUIT", (code) => code === 221, "QUIT");
    return { ok: true, transcript };
  } finally {
    client.close();
  }
}

/**
 * Fetch the unread messages in one folder.
 *
 * `BODY.PEEK[]` is essential: plain `BODY[]` marks the message as read, so a crash between fetch and handling would lose it. The
 * messages are marked seen *after* they are handed back, by `markSeen`.
 */
export async function imapFetch({
  host,
  port,
  secure = true,
  user,
  pass,
  folder = "INBOX",
  limit = 10,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  socketFactory = openSocket,
  ca,
}) {
  const socket = await socketFactory({ host, port, secure, timeoutMs, ca });
  const client = new LineSocket(socket);
  let tag = 0;
  const command = async (label, expected = "OK") => {
    tag += 1;
    const name = `a${tag}`;
    client.write(`${name} ${label}\r\n`);
    for (;;) {
      const line = await client.readLine();
      if (line.startsWith(`${name} `)) {
        if (!new RegExp(expected).test(line)) throw new Error(`IMAP ${label} 失败：${line}`);
        return line;
      }
      if (line.startsWith("* ")) continue;
      if (/^\* BYE/i.test(line)) throw new Error(`IMAP 断开：${line}`);
    }
  };

  try {
    const greeting = await client.readLine();
    if (!/^\* OK/i.test(greeting)) throw new Error(`IMAP greeting 异常：${greeting}`);
    await command(`LOGIN "${user}" "${String(pass ?? "").replace(/"/g, '\\"')}"`);
    await command(`SELECT "${folder}"`);

    // SEARCH returns the UIDs on an untagged line; collect everything until the tagged OK.
    tag += 1;
    const searchTag = `a${tag}`;
    client.write(`${searchTag} UID SEARCH UNSEEN\r\n`);
    const uids = [];
    for (;;) {
      const line = await client.readLine();
      if (line.startsWith(`${searchTag} `)) {
        if (!/OK/i.test(line)) throw new Error(`IMAP SEARCH 失败：${line}`);
        break;
      }
      const match = /^\* SEARCH\s*(.*)$/i.exec(line);
      if (match) {
        for (const value of match[1].split(/\s+/)) if (/^\d+$/.test(value)) uids.push(value);
      }
    }

    const wanted = uids.slice(-Math.max(1, limit));
    if (!wanted.length) return { uids: [], messages: [] };

    // FETCH with literals: `{123}` is followed by exactly 123 bytes that are not lines.
    tag += 1;
    const fetchTag = `a${tag}`;
    client.write(`${fetchTag} UID FETCH ${wanted.join(",")} (UID BODY.PEEK[])\r\n`);
    const messages = [];
    let pendingUid = "";
    for (;;) {
      const line = await client.readLine();
      if (line.startsWith(`${fetchTag} `)) {
        if (!/OK/i.test(line)) throw new Error(`IMAP FETCH 失败：${line}`);
        break;
      }
      const uidMatch = /\bUID (\d+)/.exec(line);
      if (uidMatch) pendingUid = uidMatch[1];
      const literal = /\{(\d+)\}\s*$/.exec(line);
      if (literal) {
        const bytes = await client.readBytes(Number(literal[1]));
        messages.push({ uid: pendingUid, raw: bytes.toString("utf8") });
        // the literal is followed by ")" on its own line
        await client.readLine();
        continue;
      }
    }
    return { uids: wanted, messages };
  } finally {
    client.close();
  }
}

/** Mark messages as seen, after their content has been handed to the agent. */
export async function imapMarkSeen({
  host,
  port,
  secure = true,
  user,
  pass,
  ids = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  socketFactory = openSocket,
  ca,
}) {
  if (!ids.length) return { ok: true, marked: 0 };
  const socket = await socketFactory({ host, port, secure, timeoutMs, ca });
  const client = new LineSocket(socket);
  try {
    const greeting = await client.readLine();
    if (!/^\* OK/i.test(greeting)) throw new Error(`IMAP greeting 异常：${greeting}`);
    const send = async (label) => {
      client.write(label);
      for (;;) {
        const line = await client.readLine();
        if (/^\* BYE/i.test(line)) throw new Error(`IMAP 断开：${line}`);
        if (/^a\d+ /i.test(line)) {
          if (!/OK/i.test(line)) throw new Error(`IMAP 失败：${line}`);
          return;
        }
      }
    };
    await send(`a1 LOGIN "${user}" "${String(pass ?? "").replace(/"/g, '\\"')}"\r\n`);
    await send(`a2 UID STORE ${ids.join(",")} +FLAGS (\\Seen)\r\n`);
    return { ok: true, marked: ids.length };
  } finally {
    client.close();
  }
}
