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
import { CIPHER_PREFIX, SECRET_PATHS, dpapi, isEncrypted, plaintextSecrets } from "./secrets.js";
import { execFile } from "node:child_process";

/**
 * The secret protector, built once.
 *
 * DPAPI is a PowerShell call, so it is a process per operation: prefs are revealed on first read and cached,
 * and encrypted on write. Off Windows `available` is false and the file keeps plaintext - which /state then
 * reports as `secrets.atRest: "plaintext"` rather than implying protection that does not exist.
 */
let protector;
function secretProtector() {
  if (!protector) {
    protector = dpapi({
      exec: (file, args, options) => new Promise((resolve, reject) => {
        execFile(file, args, { timeout: options?.timeoutMs ?? 15000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }),
    });
  }
  return protector;
}

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

  /**
   * Scheduled tasks, in `tasks.json`.
   *
   * A file of their own on purpose: the scheduler rewrites this on every run, and folding it into prefs
   * would mean a task firing rewrites the settings file somebody may be editing at the same moment.
   */
  async loadTasks() {
    const file = await readJson(join(this.root, "tasks.json"), []);
    return Array.isArray(file) ? file.filter((task) => task && typeof task === "object" && task.id) : [];
  }

  async saveTasks(tasks) {
    await writeJson(join(this.root, "tasks.json"), Array.isArray(tasks) ? tasks : []);
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
    const file = await this.readPrefsRevealed();
    return {
      autoReply: true,
      requireAllowlist: false,
      // "Only answer friends" - see the note in index.js: the protocol carries no
      // friendship flag, so this means 1:1 chats only, with group messages skipped
      // silently. Off by default: an upgrade must not change who the bot answers.
      friendOnly: false,
      // Interjection: a message that arrives while the agent is still answering is steered
      // into the running turn instead of queueing its own. Off by default - queueing is what
      // every existing chat already does, and `steer` changes what the model sees mid-turn.
      interject: false,
  // One retry after a transient model-transport failure: the turn produced no answer, the cause is usually a
  // hiccup, and the alternative is the person getting nothing at all. The Web UI and /retry toggle it.
  retry: true,
      // How a reply leaves the bridge: "whole" sends the finished answer, "stream" shows it while
      // it is written. Only WeCom can do that (its `stream` message is incremental); personal
      // WeChat has no way to edit a message that was already sent.
      delivery: "whole",
      // Desktop control: the mouse, the keyboard and screenshots of the user's own screen. Off by
      // default and deliberately so - every other tool in this plugin acts on the bridge or on a
      // document, while this one can click anything the pointer can reach. `/desktop on` arms it.
      desktopControl: false,
      // Scheduled `command` tasks run a local shell command on a timer. Off by default for the obvious
      // reason: everything else in this plugin sends text, this one executes code. `/task command on`.
      taskCommand: false,
      // What a chat sees: "plain" strips the markdown WeChat and WeCom cannot render, "raw" sends the
      // model's text untouched. Plain is the default because markdown arrives as literal punctuation.
      format: "plain",
      // Authorization level for the approval channel this plugin owns: strict / moderate /
      // full / readonly. "moderate" is exactly the behaviour of every earlier release.
      authorization: "moderate",
      maxMediaMiB: 100,
      // Where relative paths from the office tools land. Empty means "the bridge's working directory",
      // which is what it did before there was a setting; `/office dir <path>` fills it in.
      officeDir: "",
      // The wizard shows until it is finished or skipped. Stored, not remembered in the browser: someone who
      // closes the tab halfway should not be asked again, and someone who uninstalls and reinstalls is a new
      // user who should be.
      wizardDone: false,

      ...(file && typeof file === "object" ? file : {}),
    };
  }

  async savePrefs(patch) {
    const merged = { ...(await this.loadPrefs()), ...patch };
    await this.init();
    // Written sealed: on disk the secret is DPAPI ciphertext bound to this Windows account, so a copy of the
    // file is worthless elsewhere. `encryptSecrets` leaves already-sealed values alone, so saving twice is safe.
    const seal = secretProtector();
    let sealed = merged;
    this.secretError = undefined;
    if (seal.available) {
      // Built field by field rather than through `encryptSecrets`: DPAPI is async and that helper is not,
      // so its callback would have to guess which field it is sealing - which is how the first version
      // silently fell back to plaintext.
      sealed = { ...merged };
      for (const [section, field] of SECRET_PATHS) {
        const value = merged?.[section]?.[field];
        if (typeof value !== "string" || !value || isEncrypted(value)) continue;
        try {
          sealed[section] = { ...sealed[section], [field]: `${CIPHER_PREFIX}${await seal.protect(value)}` };
        } catch (error) {
          // Never fail a save because the seal failed - but record it, so /state can say the file is not
          // protected instead of implying it is.
          this.secretError = `无法加密 ${section}.${field}：${String(error?.message ?? error)}`;
        }
      }
    }
    await writeJson(join(this.root, "prefs.json"), sealed);
    this._prefsRevealed = undefined;
    return merged;
  }

  /** Prefs as stored, with the secrets revealed once and cached. */
  async readPrefsRevealed() {
    if (this._prefsRevealed) return this._prefsRevealed;
    const raw = await readJson(join(this.root, "prefs.json"), {});
    const out = { ...raw };
    const seal = secretProtector();
    if (seal.available) {
      for (const [section, field] of SECRET_PATHS) {
        const value = out?.[section]?.[field];
        if (!isEncrypted(value)) continue;
        try {
          out[section] = { ...out[section], [field]: await seal.reveal(value.slice("dpapi:".length)) };
        } catch (error) {
          // A sealed value from another account or machine cannot be opened. Keep the ciphertext so the
          // status can say "unreadable" rather than pretending the credential is absent.
          this.secretError = `无法解开 ${section}.${field}：${String(error?.message ?? error)}`;
          out[section] = { ...out[section], [field]: "" };
        }
      }
    }
    this._prefsRevealed = out;
    return out;
  }

  /** What /state may say about secrets at rest: how they are stored, and what is still in the clear. */
  async secretsStatus() {
    const raw = await readJson(join(this.root, "prefs.json"), {});
    const seal = secretProtector();
    return {
      atRest: seal.available ? "dpapi" : "plaintext",
      platform: seal.platform,
      exposed: plaintextSecrets(raw),
      error: this.secretError ?? null,
    };
  }

  /**
   * Task run history, bounded. One file for all tasks keeps "why did nothing arrive" answerable with a single read,
   * and `trimHistory` decides how much of it is worth keeping.
   */
  async loadTaskHistory() {
    const file = await readJson(join(this.root, "task-history.json"), []);
    return Array.isArray(file) ? file : [];
  }

  async appendTaskHistory(entry, { limit = 200 } = {}) {
    const list = await this.loadTaskHistory();
    list.push(entry);
    const trimmed = list.slice(-Math.max(1, Number(limit) || 200));
    await this.init();
    await writeJson(join(this.root, "task-history.json"), trimmed);
    return trimmed;
  }

  /**
   * The provider/model that last opened a session successfully.
   *
   * Kept because the `agent-default-model` entry in the profile patch can disappear (it has twice), and when it does the
   * default route needs an API key that this machine does not have. Remembering what worked is the only answer that
   * survives the deletion of the configuration.
   */
  async loadModelSelection() {
    return await readJson(join(this.root, "model-selection.json"), null);
  }

  async saveModelSelection(selection) {
    await this.init();
    await writeJson(join(this.root, "model-selection.json"), { ...selection, at: new Date().toISOString() });
    return selection;
  }

  /**
   * The provider/model that last opened a session successfully.
   *
   * Kept because the `agent-default-model` entry in the profile patch can disappear (it has twice), and when it does the
   * default route needs an API key that this machine does not have. Remembering what worked is the only answer that
   * survives the deletion of the configuration.
   */
  async loadModelSelection() {
    return await readJson(join(this.root, "model-selection.json"), null);
  }

  async saveModelSelection(selection) {
    await this.init();
    await writeJson(join(this.root, "model-selection.json"), { ...selection, at: new Date().toISOString() });
    return selection;
  }

  /**
   * Domains that should go through the proxy (PAC patterns). Kept in its own file because it is edited by hand as
   * often as through a route - a text file is the friendlier of the two.
   */
  async loadProxyHosts() {
    const file = await readJson(join(this.root, "proxy-hosts.json"), { patterns: [] });
    return Array.isArray(file?.patterns) ? file.patterns : [];
  }

  async saveProxyHosts(patterns) {
    const list = Array.isArray(patterns) ? patterns : [];
    await this.init();
    await writeJson(join(this.root, "proxy-hosts.json"), { patterns: list, updatedAt: new Date().toISOString() });
    return list;
  }

  /**
   * The port the Web GUI is listening on **this run**.
   *
   * The plugin cannot choose it - the host picks a free port, which is why it changes on every restart - but it sees
   * it on every request (`Host:`), and writing it down means a script or a person never has to grep a runtime log to
   * find the page again. `history` keeps the last few, so "it moved again" is visible rather than surprising.
   */
  async loadGuiPort() {
    const file = await readJson(join(this.root, "gui-port.json"), {});
    return file && typeof file === "object" ? file : {};
  }

  async saveGuiPort(port, { host = "", url = "", keep = 8 } = {}) {
    const number = Number(port);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    const before = await this.loadGuiPort();
    if (before.port === number) {
      // Only the heartbeat moves; rewriting on every request would churn the disk for nothing.
      const same = { ...before, host: host || before.host, url: url || before.url, seenAt: new Date().toISOString() };
      await this.init();
      await writeJson(join(this.root, "gui-port.json"), same);
      return same;
    }
    const history = Array.isArray(before.history) ? before.history : [];
    const next = {
      port: number,
      host: host || `127.0.0.1:${number}`,
      url: url || `http://127.0.0.1:${number}`,
      seenAt: new Date().toISOString(),
      previousPort: before.port ?? null,
      history: [...history, { port: number, at: new Date().toISOString() }].slice(-Math.max(1, Number(keep) || 8)),
    };
    await this.init();
    await writeJson(join(this.root, "gui-port.json"), next);
    return next;
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
