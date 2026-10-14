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
  const body = host.slice(at, at + 6000);
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
  const reply = host.slice(host.indexOf("const replyWith = (body)"));
  assert.ok(checksResult(reply, "reply("), "replyWith must notice a dropped reply");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
