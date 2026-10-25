/**
 * Secrets at rest.
 *
 * `prefs.json` is a plain JSON file: anything in it is readable by anyone who can read the file, and the
 * plugin's own Web UI round-trips that file. The Feishu app secret and the Tavily key are the two values
 * that actually grant access to something, so they are the ones worth encrypting.
 *
 * **DPAPI (Windows)**: the key is the logged-on user's, held by the OS, so the ciphertext is useless when
 * copied to another machine or read by another account. Nothing is asked of the user, and there is no
 * passphrase to lose. On any other platform there is no equivalent in box, so the values stay in plain
 * text and the state says so out loud (`secrets.atRest`) instead of implying protection that is not there.
 *
 * This module is deliberately dependency-free: the DPAPI call is a two-line PowerShell script, and the
 * functions that decide *what* is secret are pure, so they can be tested without Windows.
 */

/** Prefix marking a value as DPAPI ciphertext (base64 after the colon). */
export const CIPHER_PREFIX = "dpapi:";

/**
 * Where the secrets live in prefs. Only values that grant access belong here - an app id or a chat id is
 * an identifier, not a credential, and encrypting them would make prefs unreadable for no gain.
 */
export const SECRET_PATHS = Object.freeze([
  ["feishu", "appSecret"],
  ["tavily", "apiKey"],
  ["wecom", "botSecret"],
  ["wecom", "secret"],
  ["feishu", "webhookUrl"],
  // QQ arrived after the sealing mechanism did, so its secret was the one credential written in the clear.
  ["qq", "clientSecret"],
  ["email", "smtpPass"],
  ["email", "imapPass"],
]);

/**
 * Secrets that are not inside a block. `webhookSecret` signs every outbound delivery, so it is as sensitive as the rest and
 * was stored in plaintext for the same reason: nothing told the sealer it existed.
 */
export const TOP_LEVEL_SECRETS = Object.freeze(["webhookSecret"]);

/** A value that already looks like ciphertext. */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(CIPHER_PREFIX) && value.length > CIPHER_PREFIX.length;
}

/**
 * Walk `SECRET_PATHS` and return a new prefs object with `transform(value)` applied to each present secret.
 *
 * Pure, and only ever replaces values that exist: adding a `feishu.appSecret` key to a prefs object that
 * has no Feishu block would make the host think Feishu is half-configured.
 */
/**
 * A copy of `prefs` with every sealed path replaced by `***`.
 *
 * This is the readable projection every route returns. It lives here, next to `SECRET_PATHS`, because a second hand-written list in the
 * route layer is how the email passwords came back in the clear for a day: the store knew about them, the redaction did not.
 */
export function maskSecretPrefs(prefs, paths = SECRET_PATHS) {
  const safe = { ...(prefs && typeof prefs === "object" ? prefs : {}) };
  for (const [group, field] of paths) {
    const source = prefs?.[group];
    if (!source || typeof source !== "object") continue;
    const copy = { ...source };
    if (field in copy) copy[field] = copy[field] ? "***" : "";
    safe[group] = copy;
  }
  for (const field of TOP_LEVEL_SECRETS) {
    if (field in safe) safe[field] = safe[field] ? "***" : "";
  }
  return safe;
}

export function mapSecrets(prefs, transform, paths = SECRET_PATHS) {
  const copy = { ...(prefs ?? {}) };
  for (const [section, field] of paths) {
    const block = copy[section];
    if (!block || typeof block !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(block, field)) continue;
    const value = block[field];
    if (typeof value !== "string" || !value) continue;
    copy[section] = { ...block, [field]: transform(value, section, field) };
  }
  for (const field of TOP_LEVEL_SECRETS) {
    const value = copy[field];
    if (typeof value !== "string" || !value) continue;
    copy[field] = transform(value, "", field);
  }
  return copy;
}

/** The secret-shaped values currently in the clear. */
export function plaintextSecrets(prefs, paths = SECRET_PATHS) {
  const found = [];
  for (const [section, field] of paths) {
    const value = prefs?.[section]?.[field];
    if (typeof value === "string" && value && !isEncrypted(value)) found.push(`${section}.${field}`);
  }
  for (const field of TOP_LEVEL_SECRETS) {
    const value = prefs?.[field];
    if (typeof value === "string" && value && !isEncrypted(value)) found.push(field);
  }
  return found;
}

/** Prefs with every secret encrypted. Already-encrypted values are left alone (no double wrap). */
export function encryptSecrets(prefs, protect) {
  return mapSecrets(prefs, (value) => (isEncrypted(value) ? value : `${CIPHER_PREFIX}${protect(value)}`));
}

/** Prefs with every secret revealed. Plain values pass through, so a partly-migrated file still loads. */
export function decryptSecrets(prefs, reveal) {
  return mapSecrets(prefs, (value) => (isEncrypted(value) ? reveal(value.slice(CIPHER_PREFIX.length)) : value));
}

/**
 * The PowerShell that does the DPAPI call.
 *
 * Both directions take base64 in `DSH_SECRET_IN` and decode it themselves: for `protect` that is base64 of the
 * plaintext (so any Unicode survives the command line), for `reveal` it is the ciphertext, which is already
 * base64. Encoding the ciphertext a second time is a mistake that *looks* like a working call - PowerShell
 * decodes to the base64 text instead of the blob and DPAPI rejects it with "invalid data".
 */
export function dpapiScript(mode, base64Input) {
  const body = mode === "protect"
    ? "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'))"
    : "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'))";
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    `$env:DSH_SECRET_IN = '${base64Input}'`,
    "$bytes = [Convert]::FromBase64String($env:DSH_SECRET_IN)",
    body,
  ].join("\n");
}

/**
 * A protector for this platform. `available` is false off Windows - the caller must then say "plaintext"
 * rather than pretend.
 */
export function dpapi({ platform = process.platform, exec } = {}) {
  const supported = platform === "win32" && typeof exec === "function";
  const run = async (mode, text) => {
    // protect: base64 the plaintext so Unicode survives the command line. reveal: the ciphertext is already
    // base64 - encoding it again would hand PowerShell the base64 text rather than the blob.
    const input = mode === "protect" ? Buffer.from(String(text), "utf8").toString("base64") : String(text);
    const out = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(mode, input)], { timeoutMs: 15000 });
    const value = String(out ?? "").trim();
    if (!value) throw new Error("DPAPI 没有返回内容");
    return value;
  };
  return {
    available: supported,
    platform,
    protect: (text) => (supported ? run("protect", text) : Promise.reject(new Error("这台机器没有 DPAPI"))),
    reveal: (base64) => (supported ? run("reveal", base64) : Promise.reject(new Error("这台机器没有 DPAPI"))),
  };
}
