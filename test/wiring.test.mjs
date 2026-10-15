/**
 * Wiring checks: does the host call helpers that exist?
 *
 * These are not style checks. The bug they exist for shipped and was invisible:
 * index.js answered every WeCom message with `wecom.streamBody(...)`, but `streamBody`,
 * `generateReqId`, `splitForStream` and `markdownBody` are exported by **wecom-bot.js**,
 * not by wecom.js. Calling a missing property is a plain `TypeError` at the call site,
 * and every one of those calls sits inside a try/catch that only logs - so the bot
 * received messages, ran the turn, and then silently never replied. Nothing in the test
 * suite noticed, because no test ever called the reply path.
 *
 * The rule is mechanical, so it can be: for every `import * as ns from "./module.js"`,
 * each `ns.name(...)` call must be exported by that module - unless the call is one of
 * the optional capabilities index.js probes with `typeof ns.name === "function"` before
 * using it (the personal-WeChat typing indicator is exactly that).
 *
 * Run: node test/wiring.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = readFileSync(join(root, "index.js"), "utf8");

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

/** `import * as ns from "./mod.js"` -> [{ ns, file }] */
function namespaceImports() {
  const found = [];
  for (const match of host.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+"(\.[^"]+)"/g)) {
    found.push({ ns: match[1], file: match[2] });
  }
  return found;
}

/** Every name a module exports, so a call can be checked against the real surface. */
function exportsOf(file) {
  const text = readFileSync(join(root, file), "utf8");
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  // `export { a, b as c }`
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Names this file probes before calling, i.e. genuinely optional capabilities. */
function guardedNames(ns) {
  const names = new Set();
  for (const match of host.matchAll(new RegExp(`typeof\\s+${ns}\\.([A-Za-z_$][\\w$]*)\\s*===\\s*"function"`, "g"))) {
    names.add(match[1]);
  }
  return names;
}

console.log("host wiring");

test("the host has namespace imports to check", () => {
  assert.ok(namespaceImports().length >= 2, "expected at least ilink and wecom namespace imports");
});

for (const { ns, file } of namespaceImports()) {
  const exported = exportsOf(file);
  const guarded = guardedNames(ns);
  const calls = new Set();
  for (const match of host.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "g"))) {
    calls.add(match[1]);
  }

  await test(`every ${ns}.name(...) call in index.js is exported by ${file}`, () => {
    const missing = [...calls].filter((name) => !exported.has(name) && !guarded.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      `${file} does not export ${missing.map((name) => `${ns}.${name}`).join(", ")} - ` +
        "the call would be a TypeError at runtime (check which module really owns the helper)",
    );
  });

  await test(`${ns} is actually used`, () => {
    assert.ok(calls.size > 0, `no ${ns}.name(...) call found; stale import?`);
  });
}

await test("the host module imports cleanly and still exports the plugin entry", async () => {
  // Loading it for real is the one check that catches a broken import in the entry
  // point, which no amount of static reading can.
  const mod = await import("../index.js");
  assert.equal(mod.name, "dsh-wechat-media");
  assert.equal(typeof mod.apply, "function");
  assert.ok(mod.inject.includes("agents"), "agents must stay injected");
  assert.equal(typeof mod.pickFolder, "function");
});

await test("the WeCom reply helpers come from wecom-bot.js", () => {
  const bot = exportsOf("wecom-bot.js");
  for (const helper of ["streamBody", "generateReqId", "splitForStream", "markdownBody"]) {
    assert.ok(bot.has(helper), `wecom-bot.js should export ${helper}`);
  }
  const imported = /import\s*\{([^}]*)\}\s*from\s*"\.\/wecom-bot\.js"/.exec(host)?.[1] ?? "";
  for (const helper of ["streamBody", "generateReqId", "splitForStream", "markdownBody"]) {
    assert.match(imported, new RegExp(`\\b${helper}\\b`), `index.js must import ${helper} from wecom-bot.js`);
  }
});

await test("the WeCom transport (wecom.js) does not own those reply helpers", () => {
  const transport = exportsOf("wecom.js");
  for (const helper of ["streamBody", "generateReqId", "splitForStream", "markdownBody"]) {
    assert.ok(!transport.has(helper), `wecom.js must not define ${helper}; it belongs to the long connection`);
  }
});

/** Is the result of `call(...)` compared against false nearby? */
function checksResult(text, call) {
  const at = text.indexOf(call);
  if (at === -1) return false;
  return /===\s*false/.test(text.slice(at, at + 200));
}

await test("no reply path silently truncates to its first part", () => {
  // One WeCom stream body is 20480 bytes and one WeChat message is ~2000 characters, so a
  // long answer *must* be split and sent in pieces. Three call sites used to send
  // `splitForStream(text)[0]`: the tail disappeared without a trace.
  assert.doesNotMatch(host, /splitForStream\([^)]*\)\[0\]/, "a WeCom reply must not be cut to its first part");
  assert.equal([...host.matchAll(/replyWecomInParts\(/g)].length, 5, "the helper plus its four call sites: the command answer and the three turn outcomes");
  assert.doesNotMatch(host, /outcome\.error\}`\.slice\(0, MAX_TEXT_CHARS\)/, "the WeChat error notice is chunked, not sliced");
  assert.match(host, /for \(const chunk of chunkText\(`❌ agent 出错：\$\{outcome\.error\}`\)\)/);
});

await test("both inbound paths answer /commands instead of forwarding them", () => {
  const calls = [...host.matchAll(/runChatCommand\(\{\s*transport:\s*"(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(calls.sort(), ["wechat", "wecom"], "each transport must dispatch commands");
  for (const match of host.matchAll(/const handled = await runChatCommand\([\s\S]{0,700}?\n\s*\}\);\n(\s*)if \(handled\) return;/g)) {
    assert.ok(match[1].length >= 0, "a command that was answered must not reach the agent");
  }
  assert.equal([...host.matchAll(/if \(handled\) return;/g)].length, 2, "both call sites must return early");
});

await test("/new moves the chat onto a new generation, /stop cancels the turn", () => {
  const at = host.indexOf("async function runChatCommand");
  assert.ok(at > -1);
  const body = host.slice(at, at + 10000);
  assert.match(body, /const generation = previous \+ 1/, "/new must bump the generation");
  assert.match(body, /sessionIdFor\(accountId, chatId, generation\)/, "...and route to the new session id");
  assert.match(body, /conversations\.delete\(previousId\)/, "...and forget the old conversation");
  assert.match(body, /handle\?\.dispose\?\.\(\)/, "...and dispose the old agent");
  assert.match(body, /agent\.cancel\?\.\(new Error\(STOP_REASON\)\)/, "/stop must cancel the running turn");
  assert.match(body, /statusText\(\{/, "/status must render the status block");
  assert.match(body, /helpText\(\)/, "/help must render the command list");
});

await test("the WeCom outbound media path uploads over the long connection", () => {
  const at = host.indexOf("async function wecomSendMedia");
  assert.ok(at > -1, "wecomSendMedia must exist");
  const body = host.slice(at, at + 2600);
  assert.match(body, /wecomBot\.uploadMedia\(/, "it must upload through the long connection");
  assert.match(body, /sendMediaMessage\(/, "...and send the resulting media_id");
  const tool = host.indexOf('name: "wecom_send_file"');
  assert.ok(tool > -1, "the wecom_send_file tool must exist");
  assert.match(host.slice(tool, tool + 1400), /wecomSendMedia\(/, "the tool must go through that helper");
});

await test("approvals in a WeCom chat go out over the long connection", () => {
  const at = host.indexOf("const approvals = createApprovalBridge");
  assert.ok(at > -1, "the approval bridge must be created in index.js");
  const wiring = host.slice(at, at + 900);
  assert.match(wiring, /via === "wecom"/, "the approval notifier must branch on the WeCom pseudo account");
  assert.match(wiring, /sendWecomProactive\(/, "...and use the long-connection sender for it, not the ilink one");
  assert.match(host, /async function sendWecomProactive\(/, "sendWecomProactive must exist");
});

await test("the approval self-test obeys the authorization level and can reach a WeCom chat", () => {
  // A self-test that prompts while the level says "never ask here" contradicts the setting it
  // sits next to - and it would be the one code path that could be mistaken for proof. It also
  // has to work on a bot-only setup, where the WeChat account has no usable token.
  const at = host.indexOf('path: "/dsh-wechat-media/test-approval"');
  const body = host.slice(at, at + 5200);
  assert.match(body, /approvalPolicyFor\(\(await state\.loadPrefs\(\)\)\.authorization\)/, "it must read the level");
  assert.match(body, /if \(!policy\.ask\)/, "and refuse or skip when the level does not ask");
  assert.match(body, /skipped: policy\.level/, "reporting which level skipped it");
  assert.match(body, /approvals\.record\?\./, "the level's own decision is recorded as an outcome");
  assert.match(body, /via: "wecom"/, "it must be able to ask through the long connection");
  assert.match(body, /wecomBotStatus\.authenticated/, "...only while that connection is authenticated");
});
await test("the debug routes report the session the chat actually runs in", () => {
  // A chat restarted with `/new` runs on generation 1; echoing the generation-0 id sent a
  // reader after a session that was no longer in use (the live transcript had moved on).
  const wecom = host.slice(host.indexOf('path: "/dsh-wechat-media/wecom/inbound-test"'), host.indexOf('path: "/dsh-wechat-media/wecom"'));
  assert.match(wecom, /const generation = await generationOf\(accountId, chatId\)/, "the WeCom echo must resolve the generation");
  assert.match(wecom, /sessionId: sessionIdFor\(accountId, chatId, generation\)/, "...and hash the id with it");
  assert.match(wecom, /generation,\n/, "the answer must say which generation it used");
  assert.doesNotMatch(wecom, /sessionId: sessionIdFor\(accountId, chatId\),/, "the bare, generation-0 echo must be gone");
  // The personal-WeChat route echoes the route entry itself, which already carries the real id.
  const wechat = host.slice(host.indexOf('path: "/dsh-wechat-media/debug/inbound"'));
  assert.match(wechat.slice(0, 1600), /route: after\[accountId\]\?\.\[chatId\]/, "the WeChat echo must come from the stored route");
});

await test("token usage is counted from the session events, not invented", () => {
  // The harness reports usage on the `assistant/message` session event; the collector turns
  // it into ledger entries per account and chat.
  const at = host.indexOf("class ReplyCollector");
  const collector = host.slice(at, at + 4800);
  assert.match(collector, /event\.type === "assistant\/message" && event\.data\?\.usage/, "the usage event must be recognised");
  assert.match(collector, /this\.onUsage\?\.\(\{ sessionId, usage/, "...and handed to the callback before the reply bookkeeping");
  const wiring = host.slice(host.indexOf("new ReplyCollector(ctx"));
  assert.match(wiring.slice(0, 3600), /conversations\.get\(sessionId\)/, "the event's session id must be resolved to an account");
  assert.match(wiring.slice(0, 3600), /state\.addTokens\(/, "...and written to the ledger");
  assert.match(wiring.slice(0, 3600), /token accounting failed/, "a failure to count must be logged, not swallowed");
  assert.match(wiring.slice(0, 3600), /usageDisagreement\(usage\)/, "a provider whose total disagrees with its parts must be reported");
  assert.match(host, /command\.name === "tokens"/, "the /tokens command must be handled");
  assert.match(host, /tokenLine: await tokenStatusLine\(\)/, "/status must include the token line");
});

await test("the debug inbound routes can synthesise a group message", () => {
  // Group-only rules cannot be checked against the live platform without a second person
  // in a real group, so the synthetic routes have to be able to produce one.
  const wecom = host.slice(host.indexOf('path: "/dsh-wechat-media/wecom/inbound-test"'), host.indexOf('path: "/dsh-wechat-media/wecom"'));
  assert.match(wecom, /args\.chatType/, "the WeCom route must take a chatType");
  assert.match(wecom, /chattype: chatType/, "...and put it on the frame it injects");
  assert.match(wecom, /chatType,/, "the answer must echo what it injected");
  const wechat = host.slice(host.indexOf('path: "/dsh-wechat-media/debug/inbound"'));
  assert.match(wechat.slice(0, 1200), /syntheticInbound\(/, "the WeChat route synthesises an envelope");
  const synthetic = host.slice(host.indexOf("export function syntheticInbound"));
  assert.match(synthetic.slice(0, 700), /@chatroom/, "...which marks a group by its chat id");
});

await test("the WeCom inbound path decides exactly like the WeChat one", () => {
  const at = host.indexOf("async function handleWecomInboundInner");
  assert.ok(at > -1);
  const body = host.slice(at, at + 2500);
  assert.match(body, /classifyWecomInbound\(/, "the long connection must classify with classifyWecomInbound");
  assert.match(body, /consumeApproval: consumeApprovalReply/, "a 1/2 answer must be offered to the approval bridge");
});

await test("a dropped long-connection send is never reported as success", () => {
  const send = host.slice(host.indexOf("async function wecomSendText"));
  assert.ok(checksResult(send, "sendMessage("), "wecomSendText must check that the proactive send really happened");
  const reply = host.slice(host.indexOf("function replyWecomInParts"));
  assert.ok(checksResult(reply, "reply("), "replyWecomInParts must notice a dropped reply");
});

await test("a live preview and its answer share one req_id", () => {
  // v0.13.4 sent the preview on one req_id and the answer on another, so the platform showed two
  // messages: an unfinished preview and the answer. One stream, one id, one closing send.
  const at = host.indexOf("function replyWecomInParts");
  const body = host.slice(at, at + 1400);
  assert.match(body, /const live = liveFrames\.get\(frame\);/, "the final send must look up the open preview");
  assert.match(body, /const head = firstReqId \?\? live\?\.reqId;/, "...and reuse its req id for the first part");
  assert.match(body, /index === 0 && head \? head : generateReqId/, "...while later parts still get their own");
  const streamer = host.slice(host.indexOf("function wecomStreamer"), host.indexOf("function wecomStreamer") + 900);
  assert.match(streamer, /liveFrames\.set\(frame, live\);/, "opening a preview must register it");
  assert.match(host, /function closeLiveStream\(frame, text\)/, "a turn without a text reply must still close the stream");
  assert.match(host, /deliveredByTool\) \{ closeLiveStream\(frame\); return; \}/, "including the tool-answered path");
});
await test("every answer is cleaned for the chat before it is sent", () => {
  // WeChat and WeCom render no markdown, so both transports must pass the answer through chatBody.
  assert.match(host, /import \{ toPlainText \} from "\.\/plain-text\.js";/, "the sanitiser must be imported");
  assert.match(host, /async function chatBody\(text\)/, "one place decides what a chat sees");
  assert.match(host, /replyWecomInParts\(frame, await chatBody\(outcome\.text\), "stream"/, "the WeCom answer is cleaned");
  assert.match(host, /chunkText\(await chatBody\(outcome\.text\)\)/, "the personal-WeChat answer is cleaned");
  assert.match(host, /splitForStream\(plain \? toPlainText\(live\.text\) : live\.text\)/, "the live preview is cleaned per flush");
  const state = readFileSync(join(root, "state.js"), "utf8");
  assert.match(state, /format: "plain"/, "the default is cleaned, not raw");
  assert.match(host, /format must be "plain" or "raw"/, "the prefs route validates the mode");
});
await test("a stream is closed with an acknowledged frame, and never opened with two characters", () => {
  // Two defects this guards: the closing frame was fire-and-forget, so a refusal by the platform
  // (errcode 6000 when it races the last preview) was invisible and the chat kept a fragment; and the
  // throttle measured from the streamer's creation, so the first preview could be two characters.
  assert.match(host, /replyAndWait\(frame, streamBody\(reqId, content, true\)/, "the closing frame must be acknowledged");
  assert.match(host, /async function closeWecomStream\(frame, reqId, content/, "one place closes a stream");
  assert.match(host, /graceMs = 250, attempts = 3/, "it waits for the queue to settle and retries");
  assert.match(host, /counters\.streamFallback \+= 1/, "a close that never succeeds falls back to its own message");
  assert.match(host, /lastStreamFinalizeError = String\(error/, "...and the reason is kept for /state");
  assert.match(host, /live\.sent === 0 && live\.text\.length < 16/, "the first preview must be a real sentence");
  assert.match(host, /live\.at === 0\) live\.at = Date\.now\(\)/, "the clock starts at the first delta, not at creation");
  const bot = readFileSync(join(root, "wecom-bot.js"), "utf8");
  assert.match(bot, /replyAndWait\(frame, body, \{ timeoutMs = 8000 \} = \{\}\)/, "the bot must expose the acknowledged reply");
});
await test("a refused close falls back to a proactive message, and a dead id is not retried", () => {
  // v0.16.0 "fell back" to the same passive reply path that had just been refused, which cannot work.
  // The fallback must be the proactive send (aibot_send_msg), which needs no reply id at all.
  assert.match(host, /export function isStaleReplyError/, "one place decides what a dead reply id means");
  assert.match(host, /if \(isStaleReplyError\(lastStreamFinalizeError\)\) break;/, "a dead id is not retried");
  assert.match(host, /wecomBot\?\.sendMessage\(chatId, textBody\(parts\[index\]\)\)/, "the fallback must be the proactive path");
  assert.match(host, /streamFinalizeErrors\.push\(lastStreamFinalizeError\)/, "the sequence of failures is recorded");
  assert.match(host, /finalizeErrors: \[\.\.\.streamFinalizeErrors\]/, "...and exposed in /state");
});
await test("every personal-WeChat send carries the conversation's context token", () => {
  // Without it the platform accepts the send and then drops it - which looked exactly like "the API said
  // success but nothing arrived", for plain text as much as for a voice message. The token was already
  // being stored on inbound; these are the paths that must read it back.
  assert.match(host, /async function contextTokenFor\(account, chatId\)/, "one place reads the stored token");
  assert.match(host, /state\.loadContextTokens\(accountId\)/, "...from the state that inbound messages write");
  assert.match(host, /ilink\.sendText\(\{ baseUrl: account\.baseUrl, token: account\.token, toWxid: chatId, text, contextToken: await contextTokenFor/, "text sends must carry it");
  assert.match(host, /const contextToken = await contextTokenFor\(account, chatId\);/, "the voice path reads the token once");
  assert.match(host, /ilink\.sendVoice\(\{[^}]*contextToken \}\)/, "voice bubble sends must carry it");
  assert.match(host, /ilink\.sendFile\(\{[^}]*contextToken \}\)/, "and so must the audio-file path");
  assert.match(host, /const common = \{[^}]*contextToken: await contextTokenFor\(account, chatId\)/, "media sends must carry it");
});
await test("interjection can never lose a message", () => {
  // `await agent.steer(message); return;` was unguarded: a steer that raced the end of a turn (or was refused)
  // would drop the message - neither joined to the running turn nor queued. Both paths must fall through to the
  // queue when steering fails.
  const steers = (host.match(/if \(interject === "steer"\) \{/g) ?? []).length;
  assert.equal(steers, 2, "both inbound paths interject");
  assert.equal((host.match(/await agent\.steer\(message2\);/g) ?? []).length, 2, "each steer is awaited once");
  assert.equal((host.match(/catch \(error\) \{\s*\n\s*\/\/ Steering loses a race/g) ?? []).length, 2, "and each is guarded by a catch that queues instead");
  assert.equal((host.match(/counters\.interjectFailed \+= 1;/g) ?? []).length, 2, "a failed steer is counted, not hidden");
  assert.match(host, /interjectFailed: 0/, "the counter is part of /state");
  // The steer must not be counted before it succeeded.
  assert.doesNotMatch(host, /if \(interject === "steer"\) \{\s*\n\s*counters\.interjected \+= 1;/, "a failure must not be counted as an interjection");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
