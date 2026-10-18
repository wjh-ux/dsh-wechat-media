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
  assert.equal([...host.matchAll(/replyWecomInParts\(/g)].length, 6, "the helper plus its five call sites: the command answer, the three turn outcomes and the retry notice");
  assert.doesNotMatch(host, /outcome\.error\}`\.slice\(0, MAX_TEXT_CHARS\)/, "the WeChat error notice is chunked, not sliced");
  assert.match(host, /for \(const chunk of chunkText\(`❌ agent 出错：\$\{outcome\.error\}`\)\)/);
});

await test("both inbound paths answer /commands instead of forwarding them", () => {
  const calls = [...host.matchAll(/runChatCommand\(\{\s*transport:\s*"(\w+)"/g)].map((match) => match[1]);
  let sites = 0;
  assert.deepEqual(calls.sort(), ["feishu", "wechat", "wecom"], "each transport must dispatch commands");
  for (const match of host.matchAll(/const handled = await runChatCommand\([\s\S]{0,900}?\n\s*\}\);\n(\s*)if \(handled\) return;/g)) {
    assert.ok(match[1].length >= 0, "a command that was answered must not reach the agent");
    sites += 1;
  }
  assert.equal(sites, 3, "every transport call site must still match the shape this guard expects");
  assert.equal([...host.matchAll(/if \(handled\) return;/g)].length, 3, "all three call sites must return early");
});

await test("/new moves the chat onto a new generation, /stop cancels the turn", () => {
  const at = host.indexOf("async function runChatCommand");
  assert.ok(at > -1);
  // Slice the whole dispatcher, not an arbitrary number of characters: every command added lengthens
  // it, and a fixed window silently stops checking the handlers that fall past the end (adding /feishu
  // pushed /stop out of a 10000-character window and this test failed for the wrong reason).
  const after = host.slice(at + 10).search(/\n  (?:async )?function /);
  const body = host.slice(at, after > -1 ? at + 10 + after : at + 20000);
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
  assert.equal(steers, 3, "each inbound path interjects");
  assert.equal((host.match(/await agent\.steer\(message2\);/g) ?? []).length, 3, "each steer is awaited once");
  assert.equal((host.match(/catch \(error\) \{\s*\n\s*\/\/ Steering loses a race/g) ?? []).length, 3, "and each is guarded by a catch that queues instead");
  assert.equal((host.match(/counters\.interjectFailed \+= 1;/g) ?? []).length, 3, "a failed steer is counted, not hidden");
  assert.match(host, /interjectFailed: 0/, "the counter is part of /state");
  // The steer must not be counted before it succeeded.
  assert.doesNotMatch(host, /if \(interject === "steer"\) \{\s*\n\s*counters\.interjected \+= 1;/, "a failure must not be counted as an interjection");
});
await test("interjection decisions are recorded, not just counted", () => {
  // The counters reset with the process, so "interjected stayed 0" cannot settle "did it ever steer?" after a
  // restart. Every decision is therefore written down - with the reason - and surfaced by /state.
  assert.match(host, /async function recordInterjection/, "there is a recorder");
  assert.match(host, /interjections\.jsonl/, "it writes a durable line");
  assert.equal((host.match(/await recordInterjection\(/g) ?? []).length, 6, "each transport records its decision and its steer failure");
  // v0.19.5 claimed /state exposed this, but the field was handed to statusText(), which ignores unknown
  // parameters - so it showed nowhere. Assert the real route, and the /status wiring, not just a string.
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  assert.match(host, /counters: \{ \.\.\.counters \},\n\s*interjections: interjections\.slice\(-10\),/, "the /state route carries the record");
  assert.match(host, /lastInterjection: interjections\.at\(-1\) \?\? null/, "/status is handed the latest one at the call site");
  assert.match(commandsSource, /lastInterjection = null,/, "statusText declares the parameter");
  assert.match(commandsSource, /最近一次判定：/, "and renders it");
  assert.match(host, /export function interjectReason/, "and the reason is a named function, so it can be asserted");
  assert.match(host, /no turn was running for this chat at that moment/, "the most likely reason is spelled out");
});
await test("the build line is declared, rendered and fed - beside the /state fields it summarises", () => {
  // Same lesson as the interjection record above: handing statusText() a parameter it does not declare
  // drops it silently, so both halves are asserted, plus the route those two numbers come from.
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  assert.match(host, /buildLine: await buildStatusLine\(\)/, "/status is handed the build line at the call site");
  assert.match(commandsSource, /buildLine,/, "statusText declares the parameter");
  assert.match(commandsSource, /if \(buildLine\) lines\.push\(buildLine\)/, "and renders it");
  assert.match(host, /version: build\.version,/, "/state carries the version");
  assert.match(host, /builtAt: build\.builtAt,/, "and the build time");
  // The version must be read from the manifest, not typed in: a literal cannot be checked against the
  // published package.json, and drifts on the next release. It is read at import time, so it describes
  // the loaded code - hence the ordering assertion rather than just a match.
  assert.match(host, /JSON\.parse\(readFileSync\(join\(PLUGIN_ROOT, "package\.json"\), "utf8"\)\)/, "the version is read from this package's own manifest");
  const readAt = host.indexOf('readFileSync(join(PLUGIN_ROOT, "package.json")');
  assert.ok(readAt > -1 && readAt < host.indexOf("export const name"), "and read at import time, so it describes the code that is running");
  assert.doesNotMatch(host, /version: "\d+\.\d+\.\d+"/, "never a hard-coded version");
  // builtAt, by contrast, must NOT be cached: a cached one answers with the disk as it looked when the
  // first caller asked, which hides the very case this feature exists to expose.
  assert.doesNotMatch(host, /buildIdentity\s*\?\?=/, "the identity is not memoised");
  assert.match(host, /builtAt: await shippedNewestMtime\(MANIFEST\),/, "builtAt is computed per request");
});
await test("the build line names both times, and warns when the files are newer", async () => {
  // The whole reason the line exists: a `link:`-installed plugin keeps serving the code it loaded,
  // so "the files changed after this process started" has to be visible rather than inferred.
  const mod = await import("../index.js");
  assert.equal(typeof mod.buildLineText, "function", "the formatter is exported, so it can be tested");
  const current = mod.buildLineText({ version: "1.2.3", builtAt: "2026-10-16T10:00:00.000Z", loadedAt: "2026-10-16T11:00:00.000Z" });
  assert.match(current, /版本：1\.2\.3/);
  assert.match(current, /构建 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "the build time is a readable stamp");
  // Local time, not a slice of the ISO string: on a UTC+8 machine the naive version printed a time
  // eight hours off the reader's own clock. CI runs in UTC, where the two agree - so the expected
  // value is recomputed from the same instant here instead of being written as a literal.
  const localStamp = (iso) => {
    const at = new Date(iso);
    const pad = (value) => String(value).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  };
  assert.ok(current.includes(`构建 ${localStamp("2026-10-16T10:00:00.000Z")}`), "the build time is rendered in local time");
  assert.ok(current.includes(`加载 ${localStamp("2026-10-16T11:00:00.000Z")}`), "and so is the load time");
  assert.doesNotMatch(current, /重启/, "a process that is up to date says nothing about restarting");
  const stale = mod.buildLineText({ version: "1.2.3", builtAt: "2026-10-16T12:00:00.000Z", loadedAt: "2026-10-16T11:00:00.000Z" });
  assert.match(stale, /重启后才生效/, "files newer than the process are called out");
  // Missing timestamps are reported as unknown rather than as 1970 or an empty gap.
  const unknown = mod.buildLineText({});
  assert.match(unknown, /版本：未知 · 构建 未知 · 加载 未知/);
  assert.doesNotMatch(unknown, /重启/, "and no warning is invented from nothing");
});
await test("every desktop tool goes through the one wrapper that checks the switch", () => {
  // This is the only capability that can click on the user's own screen, so the gate must be impossible
  // to forget: `desktopTool` is the sole definition helper, and it refuses unless the preference is on.
  const names = [...host.matchAll(/const (desktop\w+Tool) = desktopTool\(\s*"(desktop_\w+)"/g)].map((m) => m[2]);
  assert.deepEqual(
    names.sort(),
    ["desktop_focus", "desktop_key", "desktop_mouse", "desktop_screen", "desktop_screenshot", "desktop_type", "desktop_windows"],
    "all seven tools are defined through the wrapper",
  );
  assert.doesNotMatch(host, /define\(\{\s*name: "desktop_/, "no desktop tool may bypass the wrapper");
  assert.match(host, /desktopControl === true\) return;/, "the wrapper reads the switch");
  assert.match(host, /桌面控制未开启/, "and says how to arm it when it refuses");
  assert.match(host, /desktopScreenTool, desktopWindowsTool, desktopFocusTool, desktopScreenshotTool, desktopMouseTool, desktopTypeTool, desktopKeyTool,/, "all seven are registered");
  // The switch itself has to be reachable from all three surfaces, or it is not a switch.
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  const stateSource = readFileSync(join(root, "state.js"), "utf8");
  assert.match(commandsSource, /name: "desktop"/, "the /desktop command exists");
  assert.match(host, /command\.name === "desktop"/, "and the host handles it");
  assert.match(stateSource, /desktopControl: false/, "the default is off");
  assert.match(host, /asBool\(body\.desktopControl\)/, "the /prefs route can arm it");
  assert.match(host, /desktop: desktopState\(prefs\)/, "and /state reports whether it is armed");
});
await test("no tool parameter asks defineTool for a type it does not know", () => {
  // v0.25.0 shipped `region: { type: "object" }` for the screenshot tool. The real `defineTool` threw
  // while *defining* it, the tools section rejected as a whole, and because that section shares an async
  // block with the HTTP routes, every `/dsh-wechat-media/*` endpoint answered 404 - the plugin looked
  // uninstalled. All 27 local suites stayed green, because without the harness the plugin falls back to
  // `(definition) => definition`, which accepts anything. The accepted set is what every shipped tool
  // already uses; these assertions are exactly what the fallback cannot tell us.
  assert.doesNotMatch(host, /type:\s*"object"/, "object parameters are not supported; use scalar fields");
  assert.doesNotMatch(host, /type:\s*"array"/, "and neither are array parameters; use a comma-separated string");
  assert.match(host, /regionX: \{ type: "number"/, "the screenshot region is four numbers");
  // The blast radius is bounded too: a failure inside the tools section may not cost the plugin its routes.
  assert.match(host, /\}\)\(\)\.catch\(/, "the tools section catches its own rejection");
  assert.match(host, /tools section failed/, "and says so in the log");
});
await test("the desktop switch is reachable from the chat, the panel and the host", () => {
  // v0.20.0's lesson, applied before it can bite: a switch the panel renders but /prefs does not accept is
  // a checkbox that toggles nothing. Every end has to line up.
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  assert.match(commandsSource, /name: "desktop"/, "the /desktop command exists");
  assert.match(host, /command\.name === "desktop"/, "the host handles it");
  assert.match(host, /asBool\(body\.desktopControl\)/, "the /prefs route accepts it");
  assert.match(clientSource, /async function setDesktop\(/, "the panel can set it");
  assert.match(clientSource, /desktopControl=\$\{desktopControl \? "true" : "false"\}/, "through /prefs");
  assert.match(clientSource, /checked: Boolean\(snapshot\?\.prefs\?\.desktopControl\)/, "and shows the stored value");
  assert.match(clientSource, /snapshot\?\.desktop\?\.supported === false/, "while refusing to pretend it works where it cannot");
  assert.match(host, /desktop: desktopState\(prefs\)/, "which is the same answer /state gives");
});
await test("scheduled tasks are wired from the timer through to the switch", () => {
  // A scheduled task runs with no message arriving, so the wiring has to be complete or the failure is
  // silent by construction: no tick, no task, no error anybody sees.
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  const stateSource = readFileSync(join(root, "state.js"), "utf8");
  assert.match(host, /import \* as tasks from "\.\/tasks\.js"/, "the pure module is imported");
  assert.match(host, /setInterval\(\(\) => \{ void schedulerTick\(\); \}, 20_000\)/, "there is a 20-second tick");
  assert.match(host, /timer\.unref\?\.\(\)/, "which cannot hold the process open");
  assert.match(host, /clearInterval\(timer\)/, "and is cleared on dispose");
  assert.match(host, /schedulerBusy/, "a tick cannot overlap itself");
  // A one-off ends after running unless it is set to re-arm, in which case the same clock time comes back
  // tomorrow: both branches have to be there, or the switch silently does nothing.
  assert.match(host, /if \(task\.autoRearm === true\)/, "a re-arming one-off keeps going");
  assert.match(host, /tasks\.rearmOnce\(task\.schedule, startedAt\)/, "by pushing the schedule forward");
  assert.match(host, /return \{ enabled: false \}/, "and a plain one-off still ends");
  // Three actions, each routed to a different capability - and the dangerous one behind its own switch.
  assert.match(host, /task\.action === "message"/, "message tasks send fixed text");
  assert.match(host, /task\.action === "command"/, "command tasks run locally");
  assert.match(host, /taskCommand !== true\) return "命令任务没开启/, "and refuse until /task command on");
  assert.match(stateSource, /taskCommand: false/, "the command switch defaults off");
  assert.match(stateSource, /async loadTasks\(\)/, "tasks are stored");
  assert.match(stateSource, /async saveTasks\(tasks\)/, "and written back");
  // The surface: three tools and a /task command.
  assert.match(host, /name: "task_add"/, "task_add exists");
  assert.match(host, /name: "task_list"/, "task_list exists");
  assert.match(host, /name: "task_remove"/, "task_remove exists");
  assert.match(host, /taskAddTool, taskListTool, taskRemoveTool,/, "and all three are registered");
  // Two target shapes reach task_add: `{ accountId }` from the default target, and `{ account: { accountId } }`
  // from an explicit `to`. v0.26.0 read `.account.accountId` first, which is a TypeError on the shape with no
  // `account` - found live, on the first task anyone created. The optional chain is the fix; this keeps it.
  assert.match(host, /target\.accountId \?\? target\.account\?\.accountId/, "the account id is read from either shape");
  assert.doesNotMatch(host, /target\.account\.accountId/, "never by dereferencing the shape that may not exist");
  assert.match(commandsSource, /name: "task"/, "the /task command exists");
  assert.match(host, /command\.name === "task"/, "the host handles it");
  // The card's buttons and the chat command must be two doors onto the same operations, not two
  // implementations - so the route reuses `taskSummary` and the client calls that route.
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  assert.match(host, /path: "\/dsh-wechat-media\/tasks"/, "the /tasks route exists");
  assert.match(host, /action === "add"/, "creating from the card goes through it");
  assert.match(host, /action === "toggle"/, "pause/resume goes through it");
  assert.match(host, /action === "remove"/, "so does delete");
  assert.match(host, /action === "command"/, "and the command switch");
  // The card's form must call the same route, with the same three fields the tool takes.
  assert.match(clientSource, /async function addTask\(/, "the card can create a task");
  assert.match(clientSource, /action: "add", when, kind: taskDraft\.kind \|\| "message", text/, "with when/kind/text");
  assert.match(clientSource, /answer\?\.ok === false\) throw/, "and it surfaces the host's refusal instead of reporting success");
  assert.match(host, /tasks: await taskSummary\(\)/, "the route answers with the same summary /state gives");
  assert.match(clientSource, /async function taskAction\(/, "the card can call the route");
  assert.match(clientSource, /action: "toggle", id/, "for pause/resume");
  assert.match(clientSource, /action: "remove", id/, "for delete");
  assert.match(clientSource, /snapshot\?\.tasks\?\.items/, "and it renders the rows");
  assert.match(clientSource, /tasksEmpty/, "with an empty state that says how to create one");
  // A finished one-off cannot be resumed - `dueTasks` ignores a `once` task that has run - so the card must not
  // offer the button. Found by clicking it: it flipped a flag and changed nothing.
  assert.match(host, /finished: task\.schedule\?\.kind === "once" && Boolean\(task\.lastRunAt\)/, "the host marks finished one-offs");
  assert.match(clientSource, /task\.finished \? null : h\("button"/, "and the card hides the toggle for them");
  // Hiding the button is not enough: the route and the chat command are other doors onto the same operation, and
  // both must refuse rather than report success for something that can never happen.
  assert.match(host, /wanted === true && ranThisOccurrence/, "the route refuses a plain resume of a finished one-off");
  assert.match(host, /sub === "on" && found\.schedule\?\.kind === "once" && found\.lastRunAt/, "and so does the chat command");
  // "Run again" and its switch exist on both sides, or the button is decorative.
  assert.match(host, /action === "rearm"/, "the route can re-arm a one-off");
  assert.match(host, /action === "auto"/, "and set its re-arm switch");
  assert.match(clientSource, /const rearmTask = \(id, step = "day"\) => taskAction\(\{ action: "rearm", id, step \}\)/, "the card calls it, with a step");
  assert.match(clientSource, /setTaskAutoRearm\(task\.id, event\.target\.checked\)/, "and the switch writes through");
  assert.match(clientSource, /taskSteps\[task\.id\] \?\? "day"/, "each row remembers its own step");
  assert.match(host, /tasks\.rearmOnce\(found\.schedule, Date\.now\(\), step\)/, "the route passes the step to the pure helper");
  // The helper must always move: `do { advance } while (past)` rather than `while (past) { advance }`, because the
  // second shape answers ok without changing anything when the task is already scheduled.
  const tasksSource = readFileSync(join(root, "tasks.js"), "utf8");
  assert.match(tasksSource, /do \{\s*unit\.advance\(at\);/, "re-arm always advances at least one step");
  assert.match(clientSource, /task\.finished \? h\("select"/, "the finished row offers a step select");
  assert.match(clientSource, /key: "again"/, "next to the run-again button");
  assert.match(host, /\/task command \[on\|off\]/, "including its own usage line");
});
await test("secrets are sealed at rest, and the state says how", () => {
  // The hard part is not encryption, it is honesty: a file that stores plaintext while the product implies
  // otherwise is worse than one that admits it. So the wiring has to reach all four places.
  const stateSource = readFileSync(join(root, "state.js"), "utf8");
  const secretsSource = readFileSync(join(root, "secrets.js"), "utf8");
  assert.match(stateSource, /from "\.\/secrets\.js"/, "state.js imports the module");
  assert.match(stateSource, /CIPHER_PREFIX/, "and knows the marker");
  assert.match(stateSource, /await seal\.protect\(value\)/, "savePrefs seals each secret");
  assert.match(stateSource, /await seal\.reveal\(/, "loadPrefs reveals them");
  assert.match(stateSource, /async secretsStatus\(\)/, "and reports how they are stored");
  // The DPAPI call must ask for the user's own key, and never turn into a shell.
  assert.match(secretsSource, /'CurrentUser'\)/, "DPAPI is scoped to the current user");
  assert.match(secretsSource, /export function dpapi\(\{ platform = process\.platform, exec \}/, "the protector takes an injectable exec, so no test has to spawn a process");
  assert.match(stateSource, /execFile\(file, args,/, "and state.js spawns without a shell, so a secret never becomes part of a command line");
  // /state reports it, and a plaintext file is sealed at startup without waiting for someone to press Save.
  assert.match(host, /secrets: await state\.secretsStatus\(\)/, "/state reports the at-rest status");
  assert.match(host, /sealed %d secret\(s\) with DPAPI/, "startup seals what is still plaintext");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("secrets.js"), "the module ships");
});

await test("office tools are registered, honest about a missing toolchain, and reachable", () => {
  const officeSource = readFileSync(join(root, "office.js"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("office.js"), "the module ships");
  assert.match(host, /import \* as office from "\.\/office\.js"/, "the host imports it");
  for (const tool of ["office_read", "office_write", "office_convert", "office_render"]) {
    assert.match(host, new RegExp(`name: "${tool}"`), `${tool} exists`);
  }
  assert.match(host, /officeReadTool, officeWriteTool, officeConvertTool, officeRenderTool\]\)/, "all four are registered");
  // A missing program must be named, never guessed at: these are the two messages that distinguish
  // "toolchain absent" from "document broken".
  assert.match(officeSource, /找不到 Python（设置 officePython/, "read/write name the missing Python, where the runner is");
  assert.match(officeSource, /找不到 LibreOffice Kit（设置 officeKit/, "convert/render name the missing kit");
  assert.match(host, /if \(!tool\.kit\) return "office_convert 失败/, "and the tools surface it verbatim");
  assert.match(host, /office: \(\(\) => \{/, "/state reports the toolchain");
  // The payload goes over argv as base64, so no shell ever sees a path or a cell value.
  assert.match(officeSource, /base64\.b64decode\(sys\.argv\[1\]\)/, "python reads base64 from argv");
  assert.match(officeSource, /sys\.stdout\.reconfigure\(encoding="utf-8"\)/, "and answers in UTF-8");
  // The directory is a setting, not a guess: it is reported, settable from a chat, writable through /prefs,
  // and every tool resolves against it - otherwise "relative to the workspace" is a claim the code does not keep.
  const stateSource = readFileSync(join(root, "state.js"), "utf8");
  assert.match(stateSource, /officeDir: ""/, "prefs carry the setting, empty by default");
  assert.match(host, /office\.resolveBaseDir\(\{ prefs \}\)/, "/state reports the directory");
  assert.match(host, /office\.absolutePath\(args\?\.path, base\)/, "the tools resolve against it");
  assert.match(host, /if \(sub\.startsWith\("dir"\)\)/, "/office dir sets it from a chat");
  assert.match(host, /patch\.officeDir = String\(body\.officeDir/, "and /prefs accepts it");
  assert.match(host, /officeDir \(see \/office/, "the tool description names the setting instead of a workspace");
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  assert.match(commandsSource, /name: "office"/, "the /office command exists");
  assert.match(host, /command\.name === "office"/, "and the host handles it");
  // The card half: it shows what /state reports and writes through the same pref the command sets, or the
  // panel and the chat would drift into two sources of truth.
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  assert.match(clientSource, /key: "office", className: "dswxCard"/, "the card has an Office section");
  assert.match(clientSource, /snapshot\?\.office\?\.canRead/, "it shows whether reading works");
  assert.match(clientSource, /snapshot\?\.office\?\.canConvert/, "and whether conversion works");
  assert.match(clientSource, /async function setOfficeDir\(/, "it can set the directory");
  assert.match(clientSource, /api\(`\/prefs\?officeDir=\$\{encodeURIComponent/, "through the same pref the command writes");
  assert.match(clientSource, /setOfficeDir\(""\)/, "and can go back to the default");
});

await test("the ERP browser mode is reachable from the card, the command and /state", () => {
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  const browserSource = readFileSync(join(root, "browser.js"), "utf8");
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  assert.match(browserSource, /export const BROWSER_MODES = Object\.freeze\(\{/, "the modes are declared once");
  assert.match(browserSource, /export function browserModeSettings\(/, "and mapped in one pure function");
  // Used must mean imported - the v0.38.1 lesson, applied before it bites.
  assert.match(host, /import \{ BROWSER_MODE_NAMES, browserModeSettings \} from "\.\/browser\.js"/, "the host imports the helpers");
  assert.match(host, /mode: settings\.mode/, "/state reports the mode");
  assert.match(host, /visible: settings\.visible/, "and whether a human can see the window");
  assert.match(commandsSource, /name: "browser"/, "the /browser command exists");
  assert.match(host, /command\.name === "browser"/, "and the host handles it");
  assert.match(host, /applyBrowserPrefs\(\{ browserMode: wanted \}\)/, "it writes the same pref the card writes");
  assert.match(clientSource, /t\("browserModeErp", "ERP 操作/, "the card offers the ERP mode");
  assert.match(clientSource, /browserDraft\.browserMode/, "through the same draft the other browser fields use");
});

await test("the Feishu scopes can be copied from the card", () => {
  // Copying a scope list is only useful if it is the *right* list: the app the user pasted from holds ~150
  // scopes, and half of them are access this plugin never exercises. The route serves the derived minimum.
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  const feishuSource = readFileSync(join(root, "feishu.js"), "utf8");
  assert.match(host, /path: "\/dsh-wechat-media\/feishu-scopes"/, "the route exists");
  assert.match(host, /feishuScopePayload\(\)/, "and answers with the derived payload");
  // Called is not imported. v0.38.0 shipped exactly that: the handler referenced the helper, the import
  // list did not have it, and the route answered 400 with an empty body at the first click.
  assert.match(host, /^\s+feishuScopePayload,$/m, "the helper is imported, not only called");
  assert.match(feishuSource, /export const FEISHU_SCOPES = Object\.freeze\(\[/, "the list is declared once");
  assert.match(feishuSource, /scopes: \{ tenant: list \}/, "the JSON is the API's own shape");
  assert.match(clientSource, /async function copyFeishuScopes\(\)/, "the card can copy it");
  assert.match(clientSource, /await navigator\.clipboard\.writeText\(text\)/, "through the clipboard API");
  assert.match(clientSource, /document\.execCommand\("copy"\)/, "with a fallback for browsers that refuse");
  assert.match(clientSource, /t\("copyScopes"/, "and a labelled button");
});

await test("the wizard shows once and then stays away", () => {
  // A wizard that cannot be dismissed is a nag; one that comes back after every restart is worse, because
  // the second time it is a bug. So: shown only when the stored preference says it is not done, and both
  // "skip" and "done" write that preference.
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  const stateSource = readFileSync(join(root, "state.js"), "utf8");
  assert.match(stateSource, /wizardDone: false/, "the preference exists and defaults to not done");
  assert.match(host, /patch\.wizardDone = asBool\(body\.wizardDone\)/, "and the route can set it");
  assert.match(clientSource, /snapshot\?\.prefs\?\.wizardDone !== true \? h\("div", \{ key: "wizard"/, "the card is gated on it");
  assert.match(clientSource, /async function endWizard\(\)/, "there is one way to finish");
  assert.match(clientSource, /await api\("\/prefs\?wizardDone=true"\)/, "which writes the preference");
  // Four steps, and the same switches the rest of the card uses - a wizard with its own copies would drift.
  for (const step of ["wizardStep === 0", "wizardStep === 1", "wizardStep === 2", "wizardStep === 3", "wizardStep === 4"]) {
    assert.match(clientSource, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${step} exists`);
  }
  assert.match(clientSource, /setAllowlist\(event\.target\.checked\)/, "step 2 reuses the allowlist switch");
  assert.match(clientSource, /setDesktop\(event\.target\.checked\)/, "step 3 reuses the desktop switch");
  assert.match(clientSource, /setTaskCommand\(event\.target\.checked\)/, "and the command switch");
  assert.match(clientSource, /setOfficeDir\(officeDirInput/, "step 4 reuses the office directory writer");
  assert.match(clientSource, /t\("wizardSkip", "跳过（我熟）"\)|t\("wizardSkip"/, "the skip button exists");
  // Step 1 pairs, step 2 sends: "configured" and "working" are different states, and only one of them is
  // worth showing a new user.
  assert.match(clientSource, /onClick: startPairing/, "step 1 can pair a WeChat account");
  assert.match(clientSource, /async function sendWizardTest\(\)/, "step 2 has its own action");
  assert.match(clientSource, /await api\("\/test-send"\)/, "which calls the test-send route");
  assert.match(host, /path: "\/dsh-wechat-media\/test-send"/, "the route exists");
  assert.match(host, /await deliverTo\(target, text\)/, "and sends through the real delivery path");
});

await test("the retry switch is reachable from the command, the host and the Web UI", () => {
  // The feature is only real if all three can reach it: a `/retry` command in a chat, the preference the
  // host reads before each turn, and a checkbox in the Web UI panel.
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  assert.match(commandsSource, /name: "retry"/, "the command exists");
  assert.match(commandsSource, /usage: "\/retry \[on\|off\]"/, "with a usage line");
  assert.match(host, /command\.name === "retry"/, "and the host handles it");
  assert.match(host, /args\.retry === "true"/, "the card route sets the same preference");
  // The Web UI writes through /prefs, not /panel: v0.20.0 only wired the card path, so the panel checkbox
  // toggled nothing. Both routes must accept it.
  assert.match(host, /asBool\(body\.retry\) !== null\) patch\.retry = asBool\(body\.retry\)/, "and so does the /prefs route the Web UI actually calls");
  const stateSource = readFileSync(join(root, "state.js"), "utf8");
  assert.match(stateSource, /retry: true,/, "the default is on");  // the preference lives in state.js, not the host
  assert.match(host, /shouldRetryTurn\(\{ error: outcome\.error, attempt: 1/, "both paths consult the policy");
  assert.match(host, /counters\.retried \+= 1/, "a retry is counted");
  assert.match(host, /counters\.retryFailed \+= 1/, "and so is a failed retry");
  assert.match(host, /正在重试一次/, "the chat is told what is happening");
  assert.match(clientSource, /async function setRetry\(/, "the Web UI can set it");
  assert.match(clientSource, /snapshot\?\.prefs\?\.retry !== false/, "and shows the current value");
});
await test("the Feishu send half is wired, and never claims what it cannot do", () => {
  // Two channels, one sender: an app bot (files, and a message_id to report) and a custom webhook bot
  // (text only). The platform limit is the interesting part - a webhook genuinely cannot carry a file,
  // and the tool has to say that instead of reporting a success that never arrived.
  const commandsSource = readFileSync(join(root, "commands.js"), "utf8");
  const feishuSource = readFileSync(join(root, "feishu.js"), "utf8");
  assert.match(host, /import \{[\s\S]*?\} from "\.\/feishu\.js";/, "the host imports the Feishu module");
  assert.match(host, /name: "feishu_send_text"/, "the text tool exists");
  assert.match(host, /name: "feishu_send_file"/, "the file tool exists");
  assert.match(
    host,
    /const DELIVERY_TOOLS = new Set\(\[[^\]]*"feishu_send_text", "feishu_send_file"\]/,
    "both count as the answer being delivered",
    // Every platform that can answer by sending must list all of its send tools, or the relay     // duplicates an answer that already went out. WeCom text/file were missing until this was asserted.     for (const tool of ["wechat_send_text", "wechat_send_file", "wecom_send_text", "wecom_send_file", "feishu_send_text", "feishu_send_file"]) {       assert.match(host, new RegExp(`const DELIVERY_TOOLS = new Set\\(\\[[^\\]]*"${tool}"`), `${tool} counts as delivering the answer`);     }
  );
  // Every platform that can answer by sending must list all of its send tools, or the relay
  // duplicates an answer that already went out. WeCom text/file were missing until this was asserted.
  for (const tool of ["wechat_send_text", "wechat_send_file", "wecom_send_text", "wecom_send_file", "feishu_send_text", "feishu_send_file"]) {
    assert.match(host, new RegExp(`const DELIVERY_TOOLS = new Set\\(\\[[^\\]]*"${tool}"`), `${tool} counts as delivering the answer`);
  }
  // Assert each tool by name inside the registration array rather than pinning the whole list: the exact-list form
  // went stale twice as tools were added, which is a guard that fails for the wrong reason.
  for (const tool of ["feishuText", "feishuFile", "feishuDocCreate", "feishuDocRead", "feishuDocAppend"]) {
    assert.match(host, new RegExp(`for \\(const definition of \\[[^\\]]*\\b${tool}\\b`), `${tool} is registered with the harness`);
  }
  assert.match(host, /function feishuConfig\(\)/, "the configuration is resolved in one place");
  assert.match(host, /FEISHU_WEBHOOK_URL/, "with the documented webhook environment fallback");
  assert.match(host, /FEISHU_APP_SECRET/, "and the app-bot ones");
  assert.match(host, /feishuTenantToken\(/, "the app path fetches a tenant token");
  assert.match(host, /let feishuTokenCache/, "and reuses it instead of asking per message");
  assert.match(host, /function feishuReceiveIdType\(/, "the receive id type is derived from the id");
  assert.match(host, /command\.name === "feishu"/, "the /feishu command is handled");
  assert.match(commandsSource, /name: "feishu",/, "and listed in the command table");
  assert.match(host, /feishuLine: feishuStatusLine\(\)/, "/status is handed the Feishu line");
  assert.match(commandsSource, /^  feishuLine,$/m, "which the renderer declares as a parameter");
  assert.match(commandsSource, /if \(feishuLine\) lines\.push\(feishuLine\);/, "and pushes outside the lines array");
  assert.match(commandsSource, /\/feishu/, "the footer names the command");
  // The honest half.
  assert.match(host, /自定义机器人（webhook）发不了文件/, "a webhook-only setup is told the truth about files");
  assert.match(host, /refused: true/, "as a refusal rather than a success");
  assert.match(host, /feishuSetupHint\(\)/, "and an unconfigured machine gets instructions, not an exception");
  // No secret may be echoed back, in any form.
  assert.doesNotMatch(host, /\$\{settings\.appSecret\}/, "the app secret is never interpolated anywhere");
  assert.doesNotMatch(host, /\$\{settings\.secret\}/, "nor the webhook secret");
  assert.match(feishuSource, /feishuDecryptEvent/, "the receive half's helpers are already in place");
});
await test("the Feishu receive half is wired, end to end", () => {
  // The long connection is opened through the lifecycle, so it is started and disposed with the plugin.
  assert.match(host, /import \{ FeishuLongConnection \} from "\.\/feishu-ws\.js";/, "the host imports the long connection");
  assert.match(host, /ctx\.effect\(\(\) => \{\s*\n\s*startFeishuAfterPrefs\(\);\s*\n\s*return \(\) => stopFeishuLongConnection\(\);/, "it is started and stopped by the scope");
  // The start must wait for the saved settings to be in the cache: `feishuConfig()` is synchronous and
  // the settings the panel saved (v0.23.0) live in prefs, so starting in parallel with the load would
  // connect with the config/env values and report the panel's settings as absent.
  // Property rather than adjacency: the saved settings must be refreshed *before* the connection starts. Pinning the
  // next line meant that adding another cache to the startup chain read as a broken startup. Falsifiable: move the
  // connection before the refreshes and this fails.
  assert.match(host, /const startFeishuAfterPrefs = \(\) => \{[\s\S]*?refreshFeishuSavedPrefs\(\)[\s\S]*?startFeishuLongConnection\(\)/, "the saved settings are loaded before the connection starts");
  assert.match(host, /async function refreshFeishuSavedPrefs\(/, "the cache has one writer");
  assert.match(host, /connection\.onEvent\(/, "events are handed to the connection");
  assert.match(host, /async function handleFeishuEvent\(appId, event\)/, "and answered by a handler that reports its own failures");
  assert.match(host, /async function startFeishuLongConnection\(/, "the connection is started in one place");

  // /state must carry it, or "is the receive half up?" is unanswerable.
  assert.match(host, /feishu: await feishuState\(\),/, "/state reports the Feishu half");

  // The loop guard must come *before* anything can produce a turn: a bot answering itself is the one
  // failure that never stops on its own.
  const appGuard = host.indexOf('parts.senderType === "app"');
  const firstForward = host.indexOf("counters.forwarded += 1;", host.indexOf("async function handleFeishuEventInner"));
  assert.ok(appGuard > -1, "the bot-own-message guard exists");
  assert.ok(firstForward > -1, "the forward counter exists");
  assert.ok(appGuard < firstForward, "the self-message guard must run before the message can be forwarded");

  // Redelivery is deduped, and the reply is a reply to the question.
  assert.match(host, /rememberSeen\(accountId, parts\.messageId\)/, "a redelivered event is deduped");
  assert.match(host, /feishuReplyMessage\(\{ token, messageId, msgType, content, domain: settings\.domain \}\)/, "the answer replies to the question");
  assert.match(host, /result = await feishuSendMessage\(\{\s*\n\s*token,\s*\n\s*receiveId: chatId,/, "...with a plain send as the fallback");

  // Attachments are described, never silently dropped, and never downloaded on a guessed parameter.
  assert.match(host, /未能下载/, "the fallback note says an attachment could not be fetched");
  // Checked against code, not prose: the comment in feishuAttachmentNote names the endpoint on purpose,
  // which is exactly how the reader learns why it is not called.
  const hostCode = host.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  assert.doesNotMatch(hostCode, /\/resources\//, "and no code guesses the resource-download parameter");
  assert.match(host, /暂不支持/, "an unconverted message type is named, not swallowed");

  // The /feishu command must not claim more than the connection can prove: "已连接" is reachable only
  // through the state-based predicate, and otherwise the reason is printed.
  assert.match(host, /长连接接收：\$\{feishuWsReason\(\)\}/, "/feishu explains why the long connection is not up");
  assert.match(host, /feishuWsEnabled\(\)\s*\n\s*\? `长连接接收：已连接/, "/feishu claims connected only via feishuWsEnabled()");
  assert.match(host, /飞书暂未实现逐字预览/, "/feishu admits that a stream preference is answered whole here");
});
await test("the panel can configure Feishu without setx and without a restart", () => {
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  // One table names the fields, and both routes go through the same apply path - the panel writes
  // /prefs while the cards write /panel, and v0.20.0 shipped a switch wired to only one of them.
  assert.match(host, /const FEISHU_PREF_FIELDS = Object\.freeze\(\{/, "one table names the fields");
  assert.match(host, /const FEISHU_PREF_SWITCHES = Object\.freeze\(\{ feishuLongConnection/, "and one names the booleans");
  assert.match(host, /if \(feishuPatch\.error\) return json\(res, 400/, "/prefs validates before saving");
  assert.match(host, /const applied = await applyFeishuPrefs\(args\);/, "/panel uses the same path");
  assert.match(host, /await state\.savePrefs\(\{ feishu: result\.patch \}\);/, "the settings are saved in prefs");
  assert.match(host, /await startFeishuLongConnection\(\{ force: true \}\)/, "saving restarts the long connection");
  assert.match(host, /const startFeishuAfterPrefs = \(\) => \{[\s\S]*?refreshFeishuSavedPrefs\(\)[\s\S]*?startFeishuLongConnection\(\)/, "and startup loads the saved settings first");
  // Secrets never travel back: one redaction helper, used by every route that returns prefs.
  assert.match(host, /function publicPrefs\(prefs = \{\}\) \{/, "there is one redaction helper");
  // Counted rather than pinned, and limited to responses: the number of routes returning prefs grew when the Tavily
  // block landed, while an internal `resolveInboxDir({ prefs: await state.loadPrefs() })` is not a response at all
  // (the first version of this check flagged it). What matters is that every response carrying prefs is redacted.
  const responsePrefs = host
    .split(/\r?\n/)
    .filter((line) => line.includes("json(res"))
    .flatMap((line) => [...line.matchAll(/prefs:\s*([A-Za-z0-9_.]+)/g)].map((match) => match[1]));
  assert.ok(responsePrefs.length >= 3, `prefs is returned from ${responsePrefs.length} responses`);
  for (const name of responsePrefs) {
    assert.match(name, /^publicPrefs/, `prefs must be redacted before it is returned, found: ${name}`);
  }
  assert.match(host, /prefs: publicPrefs\(prefs\),/, "/state redacts the stored settings too");
  assert.doesNotMatch(host, /json\(res, 200, \{ ok: true, prefs \}\)/, "no route hands the raw prefs back");
  // The panel block itself.
  assert.match(clientSource, /feishuLabel:/, "the block is labelled");
  assert.equal((clientSource.match(/feishuLabel:/g) ?? []).length, 2, "in both languages");
  assert.match(clientSource, /feishuAppSecret: event\.target\.value/, "with an app secret input");
  // At least the two Feishu secrets, and now the Tavily key as well: the property is "secrets are masked inputs", not
  // a fixed count. The exact count was pinned here and broke the moment a third secret existed - for the right reason,
  // but it read as a failure of the panel rather than of the assertion.
  assert.ok((clientSource.match(/type: "password"/g) ?? []).length >= 2, "secret inputs are masked");
  assert.match(clientSource, /async function setFeishu\(patch, mode = "filled"\)/, "saving goes through one helper");
  assert.match(clientSource, /await api\(`\/prefs\?\$\{params\.toString\(\)\}`\)/, "which writes the route the panel uses");
  assert.match(clientSource, /if \(mode === "filled" && \(value === undefined \|\| value === null \|\| String\(value\)\.trim\(\) === ""\)\) continue;/, "and never sends a blank field by accident");
  assert.match(clientSource, /feishuClear:/, "clearing is a deliberate, separate action");
});
await test("the panel's Feishu checkbox cannot get stuck on", () => {
  // `Boolean(draft ?? x === "true")` parses as `draft ?? (x === "true")`, so a draft of "false" - a non-empty
  // string - rendered as checked, and the box could only be cleared by reloading the page. The comparison has
  // to sit outside the nullish coalescing.
  const client = readFileSync(join(root, "client.js"), "utf8");
  assert.doesNotMatch(client, /Boolean\(feishuDraft\.feishuLongConnection/, "no truthiness of a draft string");
  assert.match(client, /\(feishuDraft\.feishuLongConnection \?\? \(snapshot\?\.feishu\?\.longConnectionWanted !== false \? "true" : "false"\)\) === "true"/, "the comparison is outside the ??");
});
await test("the Feishu panel shows what is saved, and says what a Save did", () => {
  // Reported from a real session: the fields were filled, and after a refresh the panel looked empty, so there
  // was no way to tell whether anything had been stored. Identifiers come back from /state; secrets never do.
  const client = readFileSync(join(root, "client.js"), "utf8");
  assert.match(client, /value: feishuDraft\.feishuAppId \?\? snapshot\?\.feishu\?\.appId \?\? ""/, "the app id falls back to the saved value");
  assert.doesNotMatch(client, /value: feishuDraft\.feishuAppSecret \?\? snapshot/, "the app secret is never read back");
  assert.doesNotMatch(client, /value: feishuDraft\.feishuWebhookSecret \?\? snapshot/, "nor the webhook secret");
  assert.ok((client.match(/type: "password"/g) ?? []).length >= 2, "both secrets stay password inputs");
  assert.match(client, /feishuAppSecretSaved/, "the panel says when a secret is already saved");
  // The stored webhook URL comes back truncated, so it is a hint - saving it back would store the ellipsis.
  assert.match(client, /placeholder: snapshot\?\.feishu\?\.webhookUrlPrefix/, "the saved webhook URL is shown as a hint");
  assert.doesNotMatch(client, /value: feishuDraft\.feishuWebhookUrl \?\? snapshot/, "the prefix is never written back as a value");
  // A Save must produce a visible outcome inside the block, and an unsaved draft must be visible too.
  assert.match(client, /setFeishuNotice\(\{ ok: true, text: `已保存/, "a successful save reports itself");
  assert.match(client, /连接状态：\$\{state\}/, "including the connection state");
  assert.match(client, /setFeishuNotice\(\{ ok: false, text: `保存失败/, "a failure is visible too");
  assert.match(client, /feishuUnsaved/, "an unsaved draft is flagged");
  assert.match(client, /feishuNotice\.text/, "and the notice is rendered in the block");
});
await test("the Feishu state refreshes the live connection counters", () => {
  // The cached status was only written when the connection changed, so /state reported the frame counters from
  // connect time - zeros - while events were arriving. Reading the live snapshot must happen where /state is built.
  assert.match(host, /if \(feishuWs && typeof feishuWs\.status === "function"\) \{\s*\n\s*const liveStatus = feishuWs\.status\(\);/, "the state builder re-reads the connection");
  assert.match(host, /async function feishuState\(\) \{[\s\S]{0,1200}?feishuWs\.status\(\)/, "and does it inside feishuState");
  assert.match(host, /stats: liveStatus\?\.stats \?\? feishuWsStatus\.stats/, "refreshing the counters only - never the recorded failure state");
});
await test("a panel write is visible in the route log", () => {
  // "The panel saves nothing" was unfalsifiable: the host route worked when called directly, and nothing
  // recorded whether the browser ever called it. The route now logs the field names it received.
  assert.match(host, /noteRoute\("\/prefs", \{ fields: Object\.keys\(body \?\? \{\}\)\.slice\(0, 12\) \}\)/, "the prefs route records what it was asked to change");
});
await test("the panel's Feishu Save really sends a request", async () => {
  // This is the oracle that finally found the bug: the whole client module is loaded the way DSH loads it,
  // the card is rendered, the Save button is found and **clicked**, and the fetch stub has to see a request.
  // The button used to throw `setFeishu is not defined` - a missing brace had nested it inside setInterject -
  // so it sent nothing and said nothing, and every source-level assertion still passed.
  let captured = null;
  let card = null;
  globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
  await import("../client.js");
  const reactStub = {
    createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }),
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useEffect() {}, useRef: () => ({ current: null }), useMemo: (fn) => fn(), useCallback: (fn) => fn,
    Fragment: "Fragment", createContext: () => ({}),
  };
  const mod = captured.factory((name) => { if (name === "react") return reactStub; throw new Error(`require ${name}`); });
  const ctx = {
    slots: { inject: (_slot, fn) => fn(), register: (def, comp) => { card = { def, comp }; return () => {}; } },
    effect() {}, logger: { info() {}, warn() {}, error() {} }, on() {}, provide() {},
    inject: (_deps, fn) => { if (typeof fn === "function") fn(ctx); },
  };
  mod.apply(ctx);
  const tree = card.comp({ snapshot: { feishu: { configured: true, connection: { state: "connected" } } } });
  const nodes = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") { nodes.push(node); walk(node.kids); }
  })(tree);
  const textOf = (node) => {
    const parts = [];
    (function gather(n) {
      if (Array.isArray(n)) return n.forEach(gather);
      if (typeof n === "string") return parts.push(n);
      if (n && typeof n === "object") gather(n.kids);
    })(node.kids);
    return parts.join(" ").trim();
  };
  const save = nodes.find((n) => typeof n?.props?.onClick === "function" && /Feishu settings/i.test(textOf(n)));
  assert.ok(save, "the Feishu Save button is rendered");
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, feishu: { connection: { state: "connected" } } }) };
  };
  const result = save.props.onClick({ target: {} });
  if (result && typeof result.then === "function") await result;
  assert.ok(calls.some((url) => url.includes("/dsh-wechat-media/prefs?")), `clicking Save must send a /prefs request, saw: ${calls.join(", ") || "nothing"}`);
  delete globalThis.window;
  delete globalThis.fetch;
});
await test("the Feishu attachment download is imported, wired and honest about failure", () => {
  // A helper that exists but is never imported throws at run time - which is exactly what happened while this
  // was being built, twice. Both halves are asserted, plus the fallback that keeps a failed fetch visible.
  assert.match(host, /^\s*feishuDownloadResource,$/m, "the downloader is imported");
  assert.match(host, /async function feishuDownload\(/, "the saveInboundMedia contract is implemented");
  assert.match(host, /download: feishuDownload,/, "and handed to the inbox sink");
  assert.match(host, /currentFeishuMessageId = parts\.messageId/, "the message id is threaded to the downloader");
  assert.match(host, /describeForModel\(saved, "飞书"\)/, "a saved attachment becomes a path for the model");
  assert.match(host, /lines\.push\(feishuAttachmentNote\(item, parts\.messageId\)\);/, "a failed fetch still describes the attachment");
  assert.match(host, /未保存\] \$\{error\?\.message \?\? error\}/, "and states why it could not be saved, never swallowing it");
});
await test("a Feishu attachment gets a real file name", () => {
  // Found on the live API: an image attachment carries no `name`, and the inbox sink derived "undefined.jpg"
  // from the missing field. The name is now built from the kind and the key, and the extension is sniffed
  // from the bytes by the shared sink.
  assert.match(host, /fileName: item\.name \|\| `\$\{item\.type\}-/, "the name falls back to kind + key");
  assert.doesNotMatch(host, /fileName: undefined/, "and is never literally undefined");
});
await test("the Feishu downloader takes the token the way feishuToken() actually returns it", () => {
  // feishuToken() returns the token **string** (`return fresh.token`). Destructuring it gave `undefined`, and the
  // download failed before any request was made - visible in the live prompt as
  // "[飞书image未保存] downloading a resource needs a tenant_access_token". The wrong form is asserted against.
  assert.match(host, /const token = await feishuToken\(\);/, "the token is taken as a string");
  assert.doesNotMatch(host, /const \{ token \} = await feishuToken\(\);/, "never destructured from a string");
});
await test("the document tool creates, then really writes the body", () => {
  // The first version created the document and returned a link while saying the body was pending - honest, but half
  // a feature. The append endpoint is now settled against the live API, so the write is a real call, and the tool
  // must not fall back to the "pending" wording.
  assert.match(host, /^\s*feishuAppendText,$/m, "the append helper is imported");
  assert.match(host, /const feishuDocCreate = define\(\{/, "the tool exists");
  assert.match(host, /await feishuAppendText\(\{ token: await feishuToken\(\), documentId: created\.documentId, text \}\)/, "and writes the body through it, with its own token");
  assert.doesNotMatch(host, /待"追加"能力上线/, "no placeholder wording is left behind");
});
await test("a reader-facing Feishu link never comes from the API host", () => {
  const feishuSource = readFileSync(join(root, "feishu.js"), "utf8");
  // Measured: https://open.feishu.cn/docx/<id> answers 200 text/html (a generic page, not the document), while the
  // tenant host answers 302 to the login page. So the URL builder takes a tenant host, and the API host is never
  // used for a link a person is meant to open.
  assert.match(feishuSource, /export function feishuDocUrl\(documentId, host = ""\)/, "the builder takes a host");
  assert.match(feishuSource, /if \(!id \|\| !base\) return "";/, "and returns nothing without one");
  assert.match(feishuSource, /url: feishuDocUrl\(documentId, tenantHost\)/, "the create path passes the tenant host");
  assert.doesNotMatch(host, /feishuDocUrl\(documentId, domain\)/, "never the API domain");
  assert.doesNotMatch(feishuSource, /feishuDomain\(domain\)\}\/docx\//, "the API host is not used to build document links");
});

await test("the link parsers cannot mistake prose for an id", () => {
  const feishuSource = readFileSync(join(root, "feishu.js"), "utf8");
  // Each parser accepts a URL form or a bare token of real length, and nothing else - a chat message pasted by
  // mistake must not be treated as a document, sheet or app token.
  assert.match(feishuSource, /raw\.match\(\/\\\/docx\\\/\(\[A-Za-z0-9\]\+\)\/\)/, "docx links are matched by form");
  assert.match(feishuSource, /if \(\/\^\[A-Za-z0-9\]\{10,\}\$\/\.test\(raw\)\) return \{ kind: "docx", id: raw \}/, "a bare id must be alphanumeric and long");
  assert.match(host, /function feishuSheetTokenFrom\(input\)/, "the sheet parser exists");
  assert.match(host, /function feishuBitableTokenFrom\(input\)/, "the bitable parser exists");
  assert.match(host, /return \/\^\[A-Za-z0-9\]\{10,\}\$\/\.test\(raw\) \? raw : "";/, "and both require a long alphanumeric token");
});

await test("every new Feishu document tool reports failure instead of swallowing it", () => {
  for (const tool of ["feishu_doc_create", "feishu_doc_read", "feishu_doc_append", "feishu_sheet_create", "feishu_sheet_read", "feishu_sheet_write", "feishu_bitable_create", "feishu_bitable_write", "feishu_bitable_read"]) {
    assert.match(host, new RegExp(`name: "${tool}"`), `${tool} exists`);
  }
  assert.match(host, /catch \(error\) \{\s*\n\s*noteRoute\("\/feishu-doc", \{ action: "bitable-read", error/, "a failed read is reported with its reason");
});
await test("every Feishu document helper call fetches its own token", () => {
  // Shipped without this twice: the tools passed no token at all, then one of fourteen call sites was missed while
  // its siblings worked ("appending to a document needs a tenant_access_token"). A fixed count of 14 then went stale
  // the moment the panel route added call sites, and a floor of 11 would have let a broken one through - so each
  // helper is compared against itself instead of against a number.
  const helpers = ["feishuCreateDoc", "feishuReadDoc", "feishuAppendText", "feishuWikiResolve", "feishuSheetCreate", "feishuSheetRead", "feishuSheetWrite", "feishuBitableCreate", "feishuBitableTables", "feishuBitableWrite", "feishuBitableRead"];
  let seen = 0;
  for (const helper of helpers) {
    const all = (host.match(new RegExp(`await ${helper}\\(`, "g")) ?? []).length;
    const withToken = (host.match(new RegExp(`await ${helper}\\(\\{\\s*token:`, "g")) ?? []).length;
    assert.equal(withToken, all, `${helper}: ${all - withToken} of ${all} call sites skip the token`);
    seen += all;
  }
  assert.ok(seen >= 20, `the helpers are called from both the tools and the panel route (${seen} call sites)`);
});

await test("the tenant host is configurable from the panel, the route and the environment", () => {
  // The field exists so a created document can come back as a link a person can open: without a tenant host the tools
  // return the id and say why, because a link built from the API host opens a generic page rather than the document.
  const clientSource = readFileSync(join(root, "client.js"), "utf8");
  assert.match(host, /tenantHost: settings\.tenantHost \|\| null/, "/state reports the tenant host");
  assert.match(host, /feishuTenantHost: "tenantHost"/, "the preference route accepts it");
  assert.match(host, /tenantHost: pick\(saved\.tenantHost, given\.tenantHost, env\.FEISHU_TENANT_HOST\)/, "saved, config or env");
  assert.match(clientSource, /feishuTenantHost/, "the panel has a field for it");
  assert.match(clientSource, /feishuDraft\.feishuTenantHost \?\? snapshot\?\.feishu\?\.tenantHost/, "and shows the saved value after a reload");
  assert.match(clientSource, /feishuTenantHost: event\.target\.value/, "typing fills the draft that Save submits");
});;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
