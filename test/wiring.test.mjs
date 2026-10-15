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
  assert.match(host, /feishuText, feishuFile\]\)/, "and both are registered with the harness");
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
  assert.match(host, /const startFeishuAfterPrefs = \(\) => \{\s*\n\s*void refreshFeishuSavedPrefs\(\)\s*\n\s*\.then\(\(\) => startFeishuLongConnection\(\)\)/, "the saved settings are loaded before the connection starts");
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
  assert.match(host, /const startFeishuAfterPrefs = \(\) => \{\s*\n\s*void refreshFeishuSavedPrefs\(\)/, "and startup loads the saved settings first");
  // Secrets never travel back: one redaction helper, used by every route that returns prefs.
  assert.match(host, /function publicPrefs\(prefs = \{\}\) \{/, "there is one redaction helper");
  // Three: the normal /prefs return, the Feishu-save return, and /state (which also carries prefs).
  assert.equal((host.match(/prefs: publicPrefs\(/g) ?? []).length, 3, "every response that returns prefs redacts it");
  assert.match(host, /prefs: publicPrefs\(prefs\),/, "/state redacts the stored settings too");
  assert.doesNotMatch(host, /json\(res, 200, \{ ok: true, prefs \}\)/, "no route hands the raw prefs back");
  // The panel block itself.
  assert.match(clientSource, /feishuLabel:/, "the block is labelled");
  assert.equal((clientSource.match(/feishuLabel:/g) ?? []).length, 2, "in both languages");
  assert.match(clientSource, /feishuAppSecret: event\.target\.value/, "with an app secret input");
  assert.equal((clientSource.match(/type: "password"/g) ?? []).length, 2, "both secrets are masked inputs");
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
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
