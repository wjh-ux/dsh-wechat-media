/**
 * dsh-wechat-media - on-disk state.
 *
 * Everything the bridge must remember across a dsh restart lives here: the bot
 * credentials of every paired WeChat account, each account's `getupdates` cursor,
 * the per-peer context tokens used for proactive sends, the chat -> DSH session
 * routing table, the contact allowlist and the user's preferences.
 *
 * Layout under `<root>` (default `$DSH_HOME/dsh-wechat-media`):
 *
 *   accounts.json                     ["b0f5860fdecb-im-bot", ...]   (index only)
 *   accounts/<accountId>.json         { token, baseUrl, userId, botId, savedAt }
 *   accounts/<accountId>.sync.json    { getUpdatesBuf }              (receive cursor)
 *   accounts/<accountId>.context-tokens.json
 *                                     { "<peer>": { token, savedAt } }
 *   routes.json                       { "<accountId>": { "<chatId>": { sessionId, ... } } }
 *   peers.json                        { "<accountId>": { "<chatId>": { allowed, ... } } }
 *   prefs.json                        { autoReply, mediaDir, maxMediaMiB, ... }
 *   tokens.json                       { windowDays, windowStartedAt, accounts: { … } }
 *
 * Account ids are stored normalized (`b0f5860fdecb@im.bot` -> `b0f5860fdecb-im-bot`)
 * because the platform hands out the raw form in one place and the normalized
 * form in another; lookups accept either.
 *
 * Writes are atomic (temp file + rename) and files holding a token are mode 0600.
 * The plugin never writes a secret into the repository or into a cordis patch.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accumulate, due, reset, setWindow } from "./tokens.js";

/** Directory name under $DSH_HOME. */
const STATE_DIR_NAME = "dsh-wechat-media";

/**
 * Normalize a platform account id into a filesystem-safe form.
 * The platform's own rule: `b0f5860fdecb@im.bot` -> `b0f5860fdecb-im-bot`, so
 * every character outside `[A-Za-z0-9_-]` (including the dot) collapses to `-`.
 */
export function normalizeAccountId(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read a JSON file, returning `fallback` when it is absent or unreadable. */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically; `0600` when the content holds a credential. */
async function writeJson(path, value, { secret = false } = {}) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (secret) {
    try {
      await chmod(temporary, 0o600);
    } catch {
      // Windows ignores POSIX modes; nothing to do.
    }
  }
  await rename(temporary, path);
}

/**
 * The bridge's state store. One instance per host plugin; every method is safe to
 * call concurrently because each mutation rewrites a whole small file.
 */
export class WechatState {
  /** @param {{ root: string }} options */
  constructor({ root }) {
    this.root = root;
    this.accountsDir = join(root, "accounts");
  }

  /** Create the directory tree. */
  async init() {
    await mkdir(this.accountsDir, { recursive: true });
  }

  accountFile(accountId) {
    return join(this.accountsDir, `${normalizeAccountId(accountId)}.json`);
  }

  cursorFile(accountId) {
    return join(this.accountsDir, `${normalizeAccountId(accountId)}.sync.json`);
  }

  contextTokenFile(accountId) {
    return join(this.accountsDir, `${normalizeAccountId(accountId)}.context-tokens.json`);
  }

  /** Account ids known to this install. */
  async listAccounts() {
    const ids = await readJson(join(this.root, "accounts.json"), []);
    return Array.isArray(ids) ? ids : [];
  }

  /** Paired account records, skipping ids whose file disappeared. */
  async loadAccounts() {
    const out = [];
    for (const id of await this.listAccounts()) {
      const record = await this.loadAccount(id);
      if (record) out.push({ accountId: id, ...record });
    }
    return out;
  }

  async loadAccount(accountId) {
    return readJson(this.accountFile(accountId), null);
  }

  /** Merge a login result into the account file and keep the index in sync. */
  async saveAccount(accountId, patch) {
    const id = normalizeAccountId(accountId);
    const existing = (await this.loadAccount(id)) ?? {};
    const merged = {
      ...existing,
      ...patch,
      savedAt: new Date().toISOString(),
    };
    await this.init();
    await writeJson(this.accountFile(id), merged, { secret: true });
    const ids = await this.listAccounts();
    if (!ids.includes(id)) {
      ids.push(id);
      await writeJson(join(this.root, "accounts.json"), ids);
    }
    return merged;
  }

  async removeAccount(accountId) {
    const id = normalizeAccountId(accountId);
    for (const path of [this.accountFile(id), this.cursorFile(id), this.contextTokenFile(id)]) {
      try {
        await unlink(path);
      } catch {
        // already gone
      }
    }
    const ids = (await this.listAccounts()).filter((entry) => entry !== id);
    await writeJson(join(this.root, "accounts.json"), ids);
  }

  /** The `get_updates_buf` cursor: only ever replaced by a non-empty value. */
  async loadCursor(accountId) {
    const file = await readJson(this.cursorFile(accountId), null);
    return typeof file?.getUpdatesBuf === "string" ? file.getUpdatesBuf : "";
  }

  async saveCursor(accountId, getUpdatesBuf) {
    if (typeof getUpdatesBuf !== "string" || getUpdatesBuf.length === 0) return;
    await this.init();
    await writeJson(this.cursorFile(accountId), { getUpdatesBuf });
  }

  /** Per-peer tokens that let the bot push outside a conversation window. */
  async loadContextTokens(accountId) {
    const file = await readJson(this.contextTokenFile(accountId), {});
    return file && typeof file === "object" ? file : {};
  }

  async saveContextToken(accountId, peer, token) {
    if (!peer || typeof token !== "string" || token.length === 0) return;
    const all = await this.loadContextTokens(accountId);
    all[peer] = { token, savedAt: new Date().toISOString() };
    await this.init();
    await writeJson(this.contextTokenFile(accountId), all, { secret: true });
  }

  // ── routing: one DSH session per WeChat chat ───────────────────────────────

  async loadRoutes() {
    const file = await readJson(join(this.root, "routes.json"), {});
    return file && typeof file === "object" ? file : {};
  }

  /** The session serving one chat, or undefined when it has never been seen. */
  async getRoute(accountId, chatId) {
    const routes = await this.loadRoutes();
    return routes[normalizeAccountId(accountId)]?.[chatId];
  }

  async setRoute(accountId, chatId, route) {
    const routes = await this.loadRoutes();
    const id = normalizeAccountId(accountId);
    routes[id] = { ...(routes[id] ?? {}), [chatId]: { ...route, updatedAt: new Date().toISOString() } };
    await this.init();
    await writeJson(join(this.root, "routes.json"), routes);
  }

  /** Forget a chat's session (the next message starts a fresh conversation). */
  async clearRoute(accountId, chatId) {
    const routes = await this.loadRoutes();
    const id = normalizeAccountId(accountId);
    if (routes[id]?.[chatId]) {
      delete routes[id][chatId];
      await writeJson(join(this.root, "routes.json"), routes);
    }
  }

  // ── allowlist ─────────────────────────────────────────────────────────────

  async loadPeers() {
    const file = await readJson(join(this.root, "peers.json"), {});
    return file && typeof file === "object" ? file : {};
  }

  async getPeer(accountId, chatId) {
    const peers = await this.loadPeers();
    return peers[normalizeAccountId(accountId)]?.[chatId];
  }

  async setPeer(accountId, chatId, patch) {
    const peers = await this.loadPeers();
    const id = normalizeAccountId(accountId);
    const bucket = peers[id] ?? {};
    bucket[chatId] = { ...(bucket[chatId] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    peers[id] = bucket;
    await this.init();
    await writeJson(join(this.root, "peers.json"), peers);
    return bucket[chatId];
  }

  // ── preferences ───────────────────────────────────────────────────────────

  async loadPrefs() {
    const file = await readJson(join(this.root, "prefs.json"), {});
    return {
      autoReply: true,
      requireAllowlist: false,
      // "Only answer friends" - see the note in index.js: the protocol carries no
      // friendship flag, so this means 1:1 chats only, with group messages skipped
      // silently. Off by default: an upgrade must not change who the bot answers.
      friendOnly: false,
      maxMediaMiB: 100,
      ...(file && typeof file === "object" ? file : {}),
    };
  }

  async savePrefs(patch) {
    const merged = { ...(await this.loadPrefs()), ...patch };
    await this.init();
    await writeJson(join(this.root, "prefs.json"), merged);
    return merged;
  }

  // ── token ledger ──────────────────────────────────────────────────────────

  /**
   * Ledger writes are **serialised**.
   *
   * They are read-modify-write cycles, and the collector calls `addTokens` fire-and-forget: a
   * turn that reports several model calls (or two turns arriving close together) would let two
   * cycles interleave, and the later write would erase the earlier one's addition. Measured
   * live: the transcript had six calls while the ledger kept five - one turn's 8651 tokens
   * (267 in / 64 out / 8320 cached) simply vanished. Chaining the three writers removes that
   * whole class rather than hoping the timing works out.
   */
  #tokenChain = Promise.resolve();

  #serialized(work) {
    const run = this.#tokenChain.then(work, work);
    // The chain must survive a rejection, or one failed write would stall every later one.
    this.#tokenChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The per-account token counters, with the window's expiry already applied.
   *
   * The reset is lazy on purpose: a host that was off for a week zeroes its counters on the
   * next read or write instead of depending on a timer that would have missed the moment
   * anyway (and that a restart would forget).
   */
  async loadTokens(now = Date.now()) {
    const file = await readJson(join(this.root, "tokens.json"), undefined);
    return due(file, now);
  }

  /** Add one model call's usage. Returns the ledger that was written. */
  async addTokens({ accountId, chatId, usage, now = Date.now() } = {}) {
    return this.#serialized(async () => {
      const updated = accumulate(await this.loadTokens(now), { accountId, chatId, usage, now });
      await this.init();
      await writeJson(join(this.root, "tokens.json"), updated);
      return updated;
    });
  }

  /** Zero the counters now (manual reset), keeping the window length and the account list. */
  async resetTokens({ now = Date.now(), windowDays } = {}) {
    return this.#serialized(async () => {
      const updated = reset(await this.loadTokens(now), { now, windowDays });
      await this.init();
      await writeJson(join(this.root, "tokens.json"), updated);
      return updated;
    });
  }

  /** Change the window length (1..30 days) and re-anchor it so the change is immediate. */
  async setTokenWindow(windowDays, { now = Date.now() } = {}) {
    return this.#serialized(async () => {
      const updated = setWindow(await this.loadTokens(now), windowDays, { now });
      await this.init();
      await writeJson(join(this.root, "tokens.json"), updated);
      return updated;
    });
  }

  // ── WeCom (企业微信) ───────────────────────────────────────────────────────

  /**
   * WeCom settings live in their own `0600` file: they hold a robot webhook key and a
   * corpsecret, which have nothing to do with the personal-WeChat account state.
   */
  async loadWecom() {
    const file = await readJson(join(this.root, "wecom.json"), {});
    return {
      webhookUrl: "",
      corpId: "",
      corpSecret: "",
      agentId: "",
      toUser: "@all",
      // The intelligent robot's long connection: BotID + Secret, and no public URL.
      botId: "",
      botSecret: "",
      botEnabled: false,
      ...(file && typeof file === "object" ? file : {}),
    };
  }

  async saveWecom(patch) {
    const merged = { ...(await this.loadWecom()), ...patch };
    await this.init();
    await writeJson(join(this.root, "wecom.json"), merged, { secret: true });
    return merged;
  }
}

/**
 * Default state root: `$DSH_HOME/dsh-wechat-media`, falling back to
 * `~/.dsh/dsh-wechat-media` when the harness did not export DSH_HOME.
 */
export function defaultStateRoot(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
  return join(home, STATE_DIR_NAME);
}
