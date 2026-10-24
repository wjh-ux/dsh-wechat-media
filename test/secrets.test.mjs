/**
 * Secrets at rest: what is secret, and that encryption never silently degrades.
 *
 * Run: node test/secrets.test.mjs
 */
import assert from "node:assert/strict";

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

const {
  CIPHER_PREFIX,
  SECRET_PATHS,
  dpapi,
  dpapiScript,
  decryptSecrets,
  encryptSecrets,
  isEncrypted,
  mapSecrets,
  plaintextSecrets,
  TOP_LEVEL_SECRETS,
} = await import("../secrets.js");

const PREFS = {
  autoReply: true,
  feishu: { appId: "cli_a93c", appSecret: "s".repeat(32), tenantHost: "open.feishu.cn" },
  tavily: { apiKey: "tvly-" + "k".repeat(52) },
  wecom: { botId: "aibo3S7u" },
};

test("an app id is an identifier, a secret is a secret", () => {
  const names = SECRET_PATHS.map(([section, field]) => `${section}.${field}`);
  assert.ok(names.includes("feishu.appSecret"));
  assert.ok(names.includes("tavily.apiKey"));
  assert.equal(names.includes("feishu.appId"), false, "encrypting an app id buys nothing and hides it from debugging");
});

test("encrypting wraps every secret and touches nothing else", () => {
  const sealed = encryptSecrets(PREFS, (value) => Buffer.from(value).toString("base64"));
  assert.equal(sealed.feishu.appSecret.startsWith(CIPHER_PREFIX), true);
  assert.equal(sealed.tavily.apiKey.startsWith(CIPHER_PREFIX), true);
  assert.equal(sealed.feishu.appId, "cli_a93c", "the app id is untouched");
  assert.equal(sealed.feishu.tenantHost, "open.feishu.cn");
  assert.equal(sealed.autoReply, true, "booleans survive");
  assert.notEqual(sealed, PREFS, "a new object, never a mutation of the caller's");
  assert.equal(PREFS.feishu.appSecret.length, 32, "and the original is not modified");
});

test("encrypting twice does not wrap twice", () => {
  const once = encryptSecrets(PREFS, (v) => Buffer.from(v).toString("base64"));
  const twice = encryptSecrets(once, (v) => Buffer.from(v).toString("base64"));
  assert.deepEqual(twice, once);
});

test("decrypting restores the plaintext, and plain values pass through", () => {
  const sealed = encryptSecrets(PREFS, (v) => Buffer.from(v).toString("base64"));
  const opened = decryptSecrets(sealed, (b64) => Buffer.from(b64, "base64").toString("utf8"));
  assert.equal(opened.feishu.appSecret, PREFS.feishu.appSecret);
  assert.equal(opened.tavily.apiKey, PREFS.tavily.apiKey);
  // A half-migrated file (one wrapped, one not) must still load.
  const mixed = { ...sealed, feishu: { ...sealed.feishu, appSecret: "still-plain" } };
  const openedMixed = decryptSecrets(mixed, (b64) => Buffer.from(b64, "base64").toString("utf8"));
  assert.equal(openedMixed.feishu.appSecret, "still-plain");
});

test("plaintextSecrets names what is still exposed", () => {
  assert.deepEqual(plaintextSecrets(PREFS).sort(), ["feishu.appSecret", "tavily.apiKey"]);
  const sealed = encryptSecrets(PREFS, (v) => Buffer.from(v).toString("base64"));
  assert.deepEqual(plaintextSecrets(sealed), []);
  assert.deepEqual(plaintextSecrets({}), [], "no blocks, nothing to report");
});

test("a block that is absent is not invented", () => {
  const out = mapSecrets({ autoReply: true }, (v) => `x${v}`);
  assert.deepEqual(out, { autoReply: true }, "no feishu/wecom keys appear out of nowhere");
  const empty = mapSecrets({ feishu: { appId: "cli" } }, (v) => `x${v}`);
  assert.deepEqual(empty, { feishu: { appId: "cli" } }, "a missing secret is not created");
  assert.equal(isEncrypted(`${CIPHER_PREFIX}`), false, "the prefix alone is not ciphertext");
  assert.equal(isEncrypted(null), false);
});

test("off Windows the protector says so instead of pretending", async () => {
  const none = dpapi({ platform: "linux" });
  assert.equal(none.available, false);
  await assert.rejects(() => none.protect("x"), /没有 DPAPI/);
  const win = dpapi({ platform: "win32", exec: async () => "QUJD" });
  assert.equal(win.available, true);
  assert.equal(await win.protect("abc"), "QUJD");
});

test("the DPAPI script asks for the current user scope, in both directions", () => {
  const protect = dpapiScript("protect", "QUJD");
  assert.match(protect, /ProtectedData\]::Protect\(\$bytes, \$null, 'CurrentUser'\)/);
  const reveal = dpapiScript("reveal", "QUJD");
  assert.match(reveal, /ProtectedData\]::Unprotect\(\$bytes, \$null, 'CurrentUser'\)/);
  assert.match(protect, /\$env:DSH_SECRET_IN = 'QUJD'/);
  assert.doesNotMatch(protect, /Unprotect/, "the two directions cannot drift into each other");
});

// ── the paths that arrived later ──────────────────────────────────────────
await test("the secret table covers the QQ client secret and the top-level webhook secret", () => {
  // QQ arrived after the sealing mechanism did, so its secret was the one credential written in the clear; webhookSecret has
  // no section at all, which is why the walkers needed to learn about top-level fields.
  const paths = SECRET_PATHS.map(([section, field]) => `${section}.${field}`);
  assert.ok(paths.includes("qq.clientSecret"), "qq.clientSecret must be sealed at rest");
  assert.ok(paths.includes("feishu.appSecret"), "and the older ones must still be there");
  assert.deepEqual([...TOP_LEVEL_SECRETS], ["webhookSecret"]);

  const prefs = { qq: { clientSecret: "abc", enabled: true }, webhookSecret: "s", feishu: { appSecret: "f" } };
  assert.deepEqual(plaintextSecrets(prefs).sort(), ["feishu.appSecret", "qq.clientSecret", "webhookSecret"]);
  const sealed = mapSecrets(prefs, (value) => `dpapi:${value}`);
  assert.equal(sealed.qq.clientSecret, "dpapi:abc");
  assert.equal(sealed.webhookSecret, "dpapi:s");
  assert.equal(sealed.qq.enabled, true, "sealing must not touch anything that is not a secret");
  // Already-sealed values are not wrapped twice.
  // The no-double-wrap guarantee belongs to encryptSecrets, not to the generic walker - mapSecrets applies the
  // transform it is given, which is what lets decryptSecrets reuse it.
  assert.equal(encryptSecrets(sealed, (value) => `dpapi:${value}`).qq.clientSecret, "dpapi:abc");
  assert.equal(encryptSecrets(sealed, (value) => `dpapi:${value}`).webhookSecret, "dpapi:s");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
