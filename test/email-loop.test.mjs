/**
 * The whole email path in one test, without a mailbox: a fake IMAP hands over a real message, it is parsed and admitted the way the
 * plugin does it, a reply is built the way the plugin does it, and a fake SMTP proves the reply carried the right headers and body.
 *
 * This is the closest thing to end-to-end that does not need a real mail account - and it covers the seams the unit tests do not: the
 * parsed message flowing into the admission decision and back out as a threaded reply.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { connect } from "node:net";

import { describeForModel, messageKey, parseMail, replySubject, senderAllowed, threadHeaders } from "../email.js";
import { buildMail, imapFetch, imapMarkSeen, smtpSend } from "../email-wire.js";

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
};

const socketFactory = ({ host, port, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs ?? 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", reject);
  });

/** An IMAP server that serves one message and records the STORE. */
function fakeImapServer(raw) {
  const seen = { stored: [] };
  const server = createServer((socket) => {
    socket.write("* OK fake IMAP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const [tag, ...rest] = line.split(" ");
        const command = (rest[0] ?? "").toUpperCase();
        if (command === "LOGIN" || command === "SELECT" || command === "LOGOUT") {
          socket.write(`${tag} OK ${command.toLowerCase()}\r\n`);
          if (command === "LOGOUT") socket.end();
        } else if (command === "UID" && /SEARCH/i.test(rest[1] ?? "")) {
          socket.write("* SEARCH 42\r\n");
          socket.write(`${tag} OK search\r\n`);
        } else if (command === "UID" && /FETCH/i.test(rest[1] ?? "")) {
          socket.write(`* 42 FETCH (UID 42 BODY[] {${Buffer.byteLength(raw)}}\r\n`);
          socket.write(raw);
          socket.write(")\r\n");
          socket.write(`${tag} OK fetch\r\n`);
        } else if (command === "UID" && /STORE/i.test(rest[1] ?? "")) {
          seen.stored.push(rest[2]);
          socket.write(`${tag} OK stored\r\n`);
        } else {
          socket.write(`${tag} OK ok\r\n`);
        }
      }
    });
  });
  return { server, seen };
}

/** An SMTP server that records the one message it is given. */
function fakeSmtpServer() {
  const seen = { data: "" };
  const server = createServer((socket) => {
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    let inData = false;
    let stage = "commands";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          seen.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) socket.write("250 fake\r\n");
        else if (upper.startsWith("AUTH LOGIN")) {
          socket.write("334 VXNlcm5hbWU6\r\n");
          stage = "user";
        } else if (stage === "user") {
          socket.write("334 UGFzc3dvcmQ6\r\n");
          stage = "pass";
        } else if (stage === "pass") {
          socket.write("235 ok\r\n");
          stage = "commands";
        } else if (upper === "DATA") {
          socket.write("354 go\r\n");
          inData = true;
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return { server, seen };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const incoming = [
  "From: Boss <boss@example.com>",
  "To: me@example.com",
  `Subject: =?UTF-8?B?${Buffer.from("备份说明", "utf8").toString("base64")}?=`,
  "Message-ID: <incoming-1@example.com>",
  "Date: Fri, 24 Oct 2026 15:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("请在服务器上跑一下备份。\n> 上一封的内容", "utf8").toString("base64"),
].join("\r\n");

await test("a mail arrives, is admitted, and the reply is threaded", async () => {
  const imap = fakeImapServer(incoming);
  const smtp = fakeSmtpServer();
  const imapPort = await listen(imap.server);
  const smtpPort = await listen(smtp.server);

  try {
    // 1. receive
    const fetched = await imapFetch({
      host: "127.0.0.1",
      port: imapPort,
      secure: false,
      user: "me@example.com",
      pass: "p",
      socketFactory,
    });
    assert.equal(fetched.messages.length, 1);

    // 2. parse + admit, exactly as pollEmailOnce does
    const parsed = parseMail(fetched.messages[0].raw);
    assert.equal(parsed.subject, "备份说明");
    assert.equal(parsed.text, "请在服务器上跑一下备份。", "quoted history is dropped");
    const prefs = { email: { allowSenders: ["boss@example.com"] } };
    assert.equal(senderAllowed(prefs, parsed.from).allowed, true);
    assert.match(describeForModel(parsed), /\[邮件\] Boss <boss@example\.com>/);
    assert.equal(messageKey(parsed), "<incoming-1@example.com>");

    // 3. reply, threaded
    const reply = buildMail({
      from: "me@example.com",
      to: parsed.from,
      subject: replySubject(parsed.subject),
      text: "备份已经跑完，日志在 /var/log/backup.log。",
      headers: threadHeaders(parsed),
    });
    await smtpSend({
      host: "127.0.0.1",
      port: smtpPort,
      secure: true,
      user: "me@example.com",
      pass: "p",
      mail: { from: "me@example.com", to: parsed.from, payload: reply },
      socketFactory,
    });

    // 4. what the receiver saw
    assert.match(smtp.seen.data, /In-Reply-To: <incoming-1@example\.com>/);
    assert.match(smtp.seen.data, /References: <incoming-1@example\.com>/);
    assert.match(smtp.seen.data, /Subject: =\?UTF-8\?B\?/);
    const body = smtp.seen.data.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "备份已经跑完，日志在 /var/log/backup.log。");

    // 5. only now is the question marked read
    await imapMarkSeen({ host: "127.0.0.1", port: imapPort, secure: false, user: "me@example.com", pass: "p", ids: ["42"], socketFactory });
    assert.deepEqual(imap.seen.stored, ["42"]);
  } finally {
    imap.server.close();
    smtp.server.close();
  }
});

await test("a stranger's mail is not admitted", async () => {
  const imap = fakeImapServer(incoming);
  const port = await listen(imap.server);
  try {
    const fetched = await imapFetch({ host: "127.0.0.1", port, secure: false, user: "u", pass: "p", socketFactory });
    const parsed = parseMail(fetched.messages[0].raw);
    assert.equal(senderAllowed({ email: { allowSenders: ["someone-else@example.com"] } }, parsed.from).allowed, false);
    assert.equal(senderAllowed({ email: { allowSenders: [] } }, parsed.from).allowed, false, "an empty list allows nobody");
  } finally {
    imap.server.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
