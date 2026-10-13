/**
 * Probe how this account must address a chat when sending.
 *
 * The protocol port could not determine from its sources which field addresses a
 * WeChat *group*: inbound messages may carry the group in `group_id`, in
 * `session_id`, or only in `from_user_id`, and the upstream implementation is
 * direct-chat only. This script sends a clearly labelled test message to one chat
 * id using each candidate addressing, and prints the platform's `ret`/`errmsg` for
 * each attempt, so the answer comes from the server instead of a guess.
 *
 * Usage (stops the bridge's own polling is NOT required - sending is independent):
 *   node scripts/probe-group-send.mjs "<chatId>" [--text "probe"] [--account <accountId>]
 *
 * Read the state directory from $DSH_HOME (defaults to ~/.dsh).
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sendText } from "../ilink.js";

const args = process.argv.slice(2);
const chatId = args.find((value) => !value.startsWith("--"));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
if (!chatId) {
  console.error('usage: node scripts/probe-group-send.mjs "<chatId>" [--text "probe"] [--account <accountId>]');
  process.exit(2);
}

const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const stateDir = join(dshHome, "dsh-wechat-media");
const accountId = flag("account", JSON.parse(readFileSync(join(stateDir, "accounts.json"), "utf8"))[0]);
const account = JSON.parse(readFileSync(join(stateDir, "accounts", `${accountId}.json`), "utf8"));

let contextToken;
try {
  const tokens = JSON.parse(readFileSync(join(stateDir, "accounts", `${accountId}.context-tokens.json`), "utf8"));
  contextToken = tokens[chatId]?.token;
} catch {
  // No window token yet: the platform may answer ret=-2.
}

const text = flag("text", `[dsh-wechat-media probe] ${new Date().toISOString()}`);
console.log(`account   : ${accountId}`);
console.log(`chatId    : ${chatId}`);
console.log(`baseUrl   : ${account.baseUrl}`);
console.log(`contextTok: ${contextToken ? "present" : "MISSING (expect ret=-2 if the window is closed)"}`);
console.log(`text      : ${text}`);
console.log("");

// Each attempt is a plain send with one addressing variant. `to_user_id` is what
// this client always sets, so the variants differ only in which id we put there.
const variants = [
  { label: "to_user_id = <chatId as given>", to: chatId },
];
if (chatId.includes("@chatroom") && chatId.includes(":")) {
  // Some platforms hand out `room:member` style ids for group senders.
  variants.push({ label: "to_user_id = group part before ':'", to: chatId.split(":")[0] });
}

for (const variant of variants) {
  try {
    const result = await sendText({
      baseUrl: account.baseUrl,
      token: account.token,
      toWxid: variant.to,
      text,
      contextToken,
    });
    console.log(`${variant.label}\n  -> ret=${result?.ret} errcode=${result?.errcode} errmsg=${result?.errmsg ?? ""}`);
  } catch (error) {
    console.log(`${variant.label}\n  -> threw: ${error?.message ?? error}`);
  }
}

// Report which chats the bridge has already seen, so a tester can copy a real id.
try {
  const routes = JSON.parse(readFileSync(join(stateDir, "routes.json"), "utf8"))[accountId] ?? {};
  console.log("\nknown chats:");
  for (const [id, route] of Object.entries(routes)) {
    console.log(`  ${id}  (${route.kind ?? "?"}, session ${route.sessionId ?? "?"})`);
  }
} catch {
  // no routing table yet
}
console.log(`\ninbox: ${join(dshHome, "wechat-inbox")}`);
try {
  console.log(`  ${readdirSync(join(dshHome, "wechat-inbox")).length} entries`);
} catch {
  console.log("  (no inbound media yet)");
}
