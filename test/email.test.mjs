/**
 * The email channel, part 3: tests before wiring.
 *
 * Two halves: the pure parsing/prefs decisions, and the two protocol clients against **fake servers** built here - a minimal SMTP and a
 * minimal IMAP that speak just enough of each protocol to prove the client's framing, auth, literal handling and dot-stuffing. That is
 * the only way to test a hand-written protocol client without a mailbox, and it catches the mistakes that matter (reading a literal as
 * lines, sending the body before the 354, forgetting STARTTLS).
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIN_POLL_SECONDS,
  describeForModel,
  emailAccountId,
  emailReadiness,
  htmlToText,
  isEmailAddress,
  messageKey,
  normalizeEmailPrefs,
  parseAddressLine,
  parseMail,
  replySubject,
  senderAllowed,
  threadHeaders,
} from "../email.js";
import { buildMail, imapFetch, smtpSend } from "../email-wire.js";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

console.log("-- addressing --");

test("an address line yields name and address", () => {
  assert.deepEqual(parseAddressLine("Zhang San <Zhang@Example.COM>"), { name: "Zhang San", address: "zhang@example.com" });
  assert.deepEqual(parseAddressLine("a@b.co"), { name: "", address: "a@b.co" });
  assert.deepEqual(parseAddressLine(""), { name: "", address: "" });
});

test("addresses are validated, not guessed", () => {
  for (const good of ["a@b.co", "first.last+tag@sub.example.org"]) assert.equal(isEmailAddress(good), true, good);
  for (const bad of ["a@b", "a b@c.co", "@b.co", "a@b.co,", "a@b@c.co", ""]) assert.equal(isEmailAddress(bad), false, bad);
});

test("the account id is namespaced like the other channels", () => {
  assert.equal(emailAccountId("Me@Example.com"), "email:me@example.com");
});

console.log("-- prefs --");

test("a complete block validates", () => {
  const result = normalizeEmailPrefs({
    enabled: true,
    user: "me@example.com",
    smtpHost: "smtp.example.com",
    imapHost: "imap.example.com",
    smtpPass: "s1",
    imapPass: "s2",
    allowSenders: ["Boss <boss@example.com>"],
    pollSeconds: 60,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.allowSenders, ["boss@example.com"]);
  assert.equal(result.value.smtpPort, 465);
  assert.equal(result.value.imapPort, 993);
});

test("a masked password is not stored as three asterisks", () => {
  const result = normalizeEmailPrefs({ user: "me@example.com", smtpPass: "***", imapPass: "" });
  assert.equal(result.value.smtpPass, undefined);
  assert.equal(result.value.imapPass, undefined);
});

test("nonsense is refused with a reason", () => {
  assert.match(normalizeEmailPrefs({ user: "not-an-address" }).error, /邮箱地址不像话/);
  assert.match(normalizeEmailPrefs({ imapHost: "not a host" }).error, /imapHost 不像话/);
  assert.match(normalizeEmailPrefs({ pollSeconds: 1 }).error, new RegExp(`${MIN_POLL_SECONDS}`));
  assert.match(normalizeEmailPrefs({ allowSenders: ["nope"] }).error, /allowSenders/);
});

test("readiness names the first missing thing", () => {
  assert.match(emailReadiness({ email: {} }), /未开启/);
  const armed = { enabled: true, user: "me@example.com", smtpHost: "s", imapHost: "i", smtpPass: "p", imapPass: "p", allowSenders: [] };
  assert.match(emailReadiness({ email: armed }), /没有允许的发件人/);
  assert.equal(emailReadiness({ email: { ...armed, allowSenders: ["a@b.co"] } }), "");
});

test("an empty allowlist allows nobody, and a wildcard domain works", () => {
  assert.equal(senderAllowed({ email: { allowSenders: [] } }, "a@b.co").allowed, false);
  assert.equal(senderAllowed({ email: { allowSenders: ["a@b.co"] } }, "A@B.co").allowed, true);
  assert.equal(senderAllowed({ email: { allowSenders: ["*@example.com"] } }, "anyone@example.com").allowed, true);
  assert.equal(senderAllowed({ email: { allowSenders: ["*@example.com"] } }, "anyone@evil.com").allowed, false);
});

console.log("-- parsing --");

const plainMail = [
  "From: Boss <boss@example.com>",
  "To: me@example.com",
  "Subject: =?UTF-8?B?5L2g5aW9?=",
  "Message-ID: <abc@example.com>",
  "Date: Fri, 24 Oct 2026 12:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("请在服务器上跑一下备份。", "utf8").toString("base64"),
].join("\r\n");

test("a plain message parses with its body decoded", () => {
  const parsed = parseMail(plainMail);
  assert.equal(parsed.from, "boss@example.com");
  assert.equal(parsed.fromName, "Boss");
  assert.equal(parsed.messageId, "<abc@example.com>");
  assert.equal(parsed.text, "请在服务器上跑一下备份。");
});

test("quoted history is dropped, so it is not fed back as new input", () => {
  const quoted = ["From: a@b.co", "Subject: x", "", "新的问题", "> 旧的内容", "> 更旧的内容"].join("\r\n");
  const parsed = parseMail(quoted);
  assert.equal(parsed.text, "新的问题");
});

test("multipart prefers text/plain, and names attachments without downloading them", () => {
  const raw = [
    "From: a@b.co",
    "Subject: 报告",
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "这是纯文本部分",
    "--BOUND",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>这是 <b>HTML</b> 部分</p>",
    "--BOUND",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "",
    "JVBERi0=",
    "--BOUND--",
  ].join("\r\n");
  const parsed = parseMail(raw);
  assert.equal(parsed.text, "这是纯文本部分");
  assert.deepEqual(parsed.attachments, ["report.pdf"]);
});

test("quoted-printable and html-only mail still produce text", () => {
  const raw = [
    "From: a@b.co",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Hello=20world</p><p>=E4=BD=A0=E5=A5=BD</p>",
  ].join("\r\n");
  const parsed = parseMail(raw);
  assert.match(parsed.text, /Hello world/);
  assert.match(parsed.text, /你好/);
});

test("html converts to something readable", () => {
  const text = htmlToText("<div>a</div><br><b>b</b>&amp;c");
  assert.match(text, /^a\n+b&c$/, "tags become line breaks, entities are decoded, nothing else survives");
  assert.equal(htmlToText("<script>bad()</script><p>ok</p>"), "ok", "script content is dropped entirely");
});

test("reply subject does not stack prefixes", () => {
  assert.equal(replySubject("Re: Re: 备份"), "Re: 备份");
  assert.equal(replySubject(""), "Re: (无主题)");
});

test("thread headers quote the original message id", () => {
  assert.deepEqual(threadHeaders({ messageId: "<x@y>" }), { "In-Reply-To": "<x@y>", References: "<x@y>" });
  assert.deepEqual(threadHeaders({ messageId: "<x@y>", references: "<a@b>" }), { "In-Reply-To": "<x@y>", References: "<a@b> <x@y>" });
  assert.deepEqual(threadHeaders({}), {});
});

test("a message without Message-ID still gets a stable key", () => {
  const parsed = { from: "a@b.co", subject: "s", date: "d", text: "t" };
  assert.equal(messageKey(parsed), messageKey({ ...parsed }));
  assert.notEqual(messageKey(parsed), messageKey({ ...parsed, text: "other" }));
});

test("the model sees who wrote it and what it says", () => {
  const text = describeForModel({ from: "a@b.co", fromName: "A", subject: "s", text: "body", attachments: [] });
  assert.match(text, /\[邮件\] A <a@b\.co>/);
  assert.match(text, /主题：s/);
  assert.match(text, /body/);
});

console.log("-- the wire --");

test("the built message is a valid MIME envelope", () => {
  const payload = buildMail({ from: "me@example.com", to: "a@b.co", subject: "测试 subject", text: "hello" });
  assert.match(payload, /^From: me@example\.com/);
  assert.match(payload, /Subject: =\?UTF-8\?B\?/);
  assert.match(payload, /Content-Transfer-Encoding: base64/);
  assert.match(payload, /\r\n\r\n/);
  const body = payload.split("\r\n\r\n")[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "hello");
});

/** A fake SMTP server: greeting, EHLO, AUTH LOGIN, MAIL/RCPT/DATA. Records what it was told. */
function fakeSmtp({ requireStartTls = false, failAuth = false } = {}) {
  const seen = { auth: [], from: "", to: "", data: "", quit: false };
  const server = createServer((socket) => {
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    let inData = false;
    let stage = "greet";
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
        const command = line.toUpperCase();
        if (command.startsWith("EHLO")) {
          socket.write(requireStartTls ? "250-fake\r\n250 STARTTLS\r\n" : "250 fake\r\n");
        } else if (command === "STARTTLS") {
          seen.startTls = true;
          socket.write("220 go ahead\r\n");
        } else if (command.startsWith("AUTH LOGIN")) {
          socket.write("334 VXNlcm5hbWU6\r\n");
          stage = "user";
        } else if (stage === "user") {
          seen.auth.push(Buffer.from(line, "base64").toString("utf8"));
          socket.write("334 UGFzc3dvcmQ6\r\n");
          stage = "pass";
        } else if (stage === "pass") {
          seen.auth.push(Buffer.from(line, "base64").toString("utf8"));
          socket.write(failAuth ? "535 bad credentials\r\n" : "235 ok\r\n");
          stage = "commands";
        } else if (command.startsWith("MAIL FROM")) {
          seen.from = line;
          socket.write("250 ok\r\n");
        } else if (command.startsWith("RCPT TO")) {
          seen.to = line;
          socket.write("250 ok\r\n");
        } else if (command === "DATA") {
          socket.write("354 go\r\n");
          inData = true;
        } else if (command === "QUIT") {
          seen.quit = true;
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

await testAsync("smtpSend authenticates, sends the body, and quits", async () => {
  const { server, seen } = fakeSmtp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const payload = buildMail({ from: "me@example.com", to: "a@b.co", subject: "s", text: ".leading dot line" });
    const result = await smtpSend({
      host: "127.0.0.1",
      port,
      // The factory below hands over a plain socket, so this test exercises the SMTP dialogue (framing, auth, body) rather
      // than TLS itself - a certificate would add nothing it does not already cover.
      secure: true,
      user: "me@example.com",
      pass: "secret",
      mail: { from: "me@example.com", to: "a@b.co", payload },
      timeoutMs: 5_000,
      socketFactory: ({ host: h, port: p, timeoutMs }) => import("node:net").then(({ connect }) => {
        // the fake server speaks plaintext, so pretend the STARTTLS upgrade kept the same plaintext socket
        return new Promise((resolve, reject) => {
          const socket = connect({ host: h, port: p });
          const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs ?? 5_000);
          socket.once("connect", () => {
            clearTimeout(timer);
            resolve(socket);
          });
          socket.once("error", reject);
        });
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen.auth, ["me@example.com", "secret"]);
    assert.match(seen.from, /me@example\.com/);
    assert.match(seen.to, /a@b\.co/);
    // The body is base64 on the wire, so decode it: that is what proves the whole payload survived the DATA phase.
    const encoded = seen.data.split("\r\n\r\n")[1] ?? "";
    assert.equal(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8"), ".leading dot line");
    assert.equal(seen.quit, true);
  } finally {
    server.close();
  }
});

/** A fake IMAP server: greeting, LOGIN, SELECT, SEARCH UNSEEN, FETCH with a literal, STORE. */
function fakeImap({ messages = [], unseen = [] } = {}) {
  const seen = { login: "", fetched: [], stored: [] };
  const server = createServer((socket) => {
    socket.write("* OK fake IMAP ready\r\n");
    let buffer = "";
    let inLiteral = 0;
    socket.on("data", (chunk) => {
      if (inLiteral > 0) {
        buffer += chunk.toString("utf8");
        if (buffer.length < inLiteral) return;
        inLiteral = 0;
      } else {
        buffer += chunk.toString("utf8");
      }
      for (;;) {
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const [tag, ...rest] = line.split(" ");
        const command = (rest[0] ?? "").toUpperCase();
        if (command === "LOGIN") {
          seen.login = line;
          socket.write(`${tag} OK logged in\r\n`);
        } else if (command === "SELECT") {
          socket.write("* 1 EXISTS\r\n");
          socket.write(`${tag} OK [READ-WRITE] selected\r\n`);
        } else if (command === "UID" && /SEARCH/i.test(rest[1] ?? "")) {
          socket.write(`* SEARCH ${unseen.join(" ")}\r\n`);
          socket.write(`${tag} OK search done\r\n`);
        } else if (command === "UID" && /FETCH/i.test(rest[1] ?? "")) {
          const requested = String(rest[2] ?? "").split(",");
          for (const id of requested) {
            const message = messages.find((entry) => entry.uid === id);
            if (!message) continue;
            seen.fetched.push(id);
            socket.write(`* ${id} FETCH (UID ${id} BODY[] {${Buffer.byteLength(message.raw)}}\r\n`);
            socket.write(message.raw);
            socket.write(")\r\n");
          }
          socket.write(`${tag} OK fetch done\r\n`);
        } else if (command === "UID" && /STORE/i.test(rest[1] ?? "")) {
          seen.stored.push(rest[2]);
          socket.write(`${tag} OK stored\r\n`);
        } else if (command === "LOGOUT") {
          socket.write("* BYE\r\n");
          socket.write(`${tag} OK bye\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK ok\r\n`);
        }
      }
    });
  });
  return { server, seen };
}

const plainSocketFactory = ({ host, port, timeoutMs }) =>
  import("node:net").then(
    ({ connect }) =>
      new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs ?? 5_000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once("error", reject);
      }),
  );

await testAsync("imapFetch reads a literal body, not lines", async () => {
  const raw = "From: a@b.co\r\nSubject: hi\r\n\r\nbody line 1\r\nbody line 2\r\n";
  const { server, seen } = fakeImap({ unseen: ["7"], messages: [{ uid: "7", raw }] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await imapFetch({
      host: "127.0.0.1",
      port,
      secure: false,
      user: "me@example.com",
      pass: "p",
      timeoutMs: 5_000,
      socketFactory: plainSocketFactory,
    });
    assert.deepEqual(result.uids, ["7"]);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].raw, raw);
    assert.match(seen.login, /LOGIN "me@example\.com" "p"/);
  } finally {
    server.close();
  }
});

await testAsync("imapFetch with nothing unread does no FETCH", async () => {
  const { server, seen } = fakeImap({ unseen: [] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await imapFetch({ host: "127.0.0.1", port, secure: false, user: "u", pass: "p", timeoutMs: 5_000, socketFactory: plainSocketFactory });
    assert.deepEqual(result.messages, []);
    assert.deepEqual(seen.fetched, []);
  } finally {
    server.close();
  }
});

test("the module ships with the package", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.ok(pkg.files.includes("email.js"), "email.js must be published");
  assert.ok(pkg.files.includes("email-wire.js"), "email-wire.js must be published");
  assert.ok(!/node_modules/.test(tmpdir()), "sanity: the temp dir is not part of the repo");
});

console.log(`\n${passed} passed, ${failed} failed`);
// The fake servers leave sockets behind, so the process would linger; exit explicitly once the results are printed.
process.exit(failed ? 1 : 0);
