/**
 * dsh-wechat-media - the "act as the person" half of the Feishu (Lark) integration, backed by the official lark-cli.
 *
 * Why this exists: every call in `feishu.js` speaks with a `tenant_access_token`, which is the *application's* own
 * identity. Feishu treats an application as a principal in its own right: it owns its own files, it is a member of
 * nothing, and nothing of a person's is visible to it. The practical consequences, measured on a real tenant:
 *
 *  - a document created with the app token lands in the app's private drive space, where no person can see it;
 *  - a 知识库 (wiki) refuses writes from a non-member, so `move_docs_to_wiki` cannot work at all;
 *  - and adding the app to a space is an administrator action most individuals simply cannot perform.
 *
 * The official CLI (github.com/larksuite/cli, MIT, maintained by the larksuite team) holds a `user_access_token`
 * instead: the same calls run *as the person*, so their knowledge bases, folders, ownership and shares are already
 * in scope. That is the whole trick - it is a different principal, not a different API.
 *
 * This module is a thin, dependency-free wrapper around that binary: resolve it, run one command, parse the JSON it
 * prints. No credentials are stored here - `lark-cli config init` and `lark-cli auth login` own those, in the OS
 * keychain.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a global `npm install -g @larksuite/cli` puts the JavaScript entry point on each platform. */
function candidateScripts({ env = process.env, platform = process.platform } = {}) {
  const out = [];
  if (String(env.LARK_CLI_SCRIPT ?? "").trim()) out.push(String(env.LARK_CLI_SCRIPT).trim());
  if (env.APPDATA) out.push(join(env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
  if (env.ProgramFiles) out.push(join(env.ProgramFiles, "nodejs", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
  if (platform === "win32") {
    out.push(join(env.LOCALAPPDATA ?? "", "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"));
  } else {
    out.push("/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js");
    out.push("/usr/lib/node_modules/@larksuite/cli/scripts/run.js");
  }
  return out.filter(Boolean);
}

/**
 * The CLI entry point and the Node binary that can run it.
 *
 * The `.cmd` shim is deliberately not used: Node refuses to `execFile` a batch file without a shell, and turning the
 * shell on would put Chinese file names through unescaped command-line parsing. Running `node run.js` is exactly what
 * that shim does, without the quoting problem.
 */
export function larkCliPath({ env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  for (const script of candidateScripts({ env, platform })) {
    if (existsSync(script)) return { node: execPath || "node", script };
  }
  return null;
}

/** One sentence a caller can act on, instead of "ENOENT". */
export function larkCliMissingHint() {
  return "找不到 lark-cli。装一次就行：`npx @larksuite/cli@latest install`，然后 `lark-cli config init --new` 和 `lark-cli auth login --recommend` 各自授权一次。";
}

/**
 * Run one CLI command and parse what it prints.
 *
 * Every `lark-cli` subcommand speaks the same envelope: `{ ok, data }` on success, `{ ok:false, error:{ message,
 * hint } }` on failure. The envelope is returned as-is rather than unwrapped, because "the call failed" and "the
 * call failed *and* the reason is a permission the person can grant" are different answers for the caller.
 *
 * @returns {Promise<{ok: boolean, data?: any, error?: {message?: string, hint?: string, type?: string}, raw: string}>}
 */
export function larkCli(args, { timeoutMs = 120000, execFileImpl = execFile, cli = undefined, cwd = undefined } = {}) {
  const resolved = cli ?? larkCliPath();
  if (!resolved) return Promise.reject(new Error(larkCliMissingHint()));
  const argv = Array.isArray(args) ? args.map((value) => String(value)) : [String(args)];
  return new Promise((resolveRun, rejectRun) => {
    execFileImpl(
      resolved.node,
      [resolved.script, ...argv],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, encoding: "utf8", ...(cwd ? { cwd } : {}) },
      (error, stdout, stderr) => {
        const raw = String(stdout ?? "").trim();
        // A non-zero exit is normal here: the CLI exits 1 for every `ok:false` envelope, including permission ones.
        // Only "no JSON at all" is a transport failure worth throwing for.
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") return resolveRun({ ...parsed, raw });
          } catch { /* fall through: what came back is not an envelope */ }
        }
        const message = String(stderr ?? "").trim() || String(error?.message ?? error ?? "").trim();
        if (error && error.killed) return rejectRun(new Error(`lark-cli ${argv[0]} 超时（${Math.round(timeoutMs / 1000)}s）`));
        rejectRun(new Error(message ? `lark-cli ${argv.join(" ")} 失败：${message}` : `lark-cli ${argv.join(" ")} 没有输出`));
      },
    );
  });
}

/** Turn an `ok:false` envelope into an Error carrying the CLI's own hint, so a permission problem reads as one. */
export function larkFailure(envelope, action) {
  const error = envelope?.error ?? {};
  const parts = [error.message || `${action}失败`];
  if (error.hint) parts.push(error.hint);
  if (Array.isArray(error.missing_scopes) && error.missing_scopes.length) parts.push(`缺权限：${error.missing_scopes.join(", ")}`);
  return new Error(parts.join("；"));
}

/**
 * Split a command line into argv, honouring quotes.
 *
 * No shell is ever involved: `larkCli` spawns `node run.js <argv…>` with `execFile`, so this tokenizer is the only
 * place a character could be reinterpreted - and it never interprets anything, it only groups. That is what lets a
 * Chinese file name with spaces or a `&` in it reach the CLI intact.
 */
export function larkSplitArgs(input) {
  const text = String(input ?? "");
  const out = [];
  let current = "";
  let quote = "";
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) { quote = ""; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { out.push(current); current = ""; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * Commands a tool must not run on someone's behalf.
 *
 * Two kinds, both measured rather than guessed:
 *  - **interactive** ones (`auth login`, `config init/remove`) wait on a browser round-trip or a prompt, so from a tool
 *    they do not fail - they hang until the timeout, which looks like "the plugin is broken";
 *  - **credential destruction** (`config remove`) would unauthenticate the machine with no undo.
 *
 * Everything else is allowed, because that is the point of a bridge: the CLI is the authority on its own commands, and
 * a hardcoded list of 200 would be wrong the first time lark-cli ships a new domain.
 */
const LARK_INTERACTIVE = new Set(["auth login", "auth logout", "config init", "config remove", "config keychain-downgrade"]);

/** Throw when argv would block on a human, destroy credentials, or delete without an explicit confirmation. */
export function larkAssertRunnable(argv, { confirmDanger = false } = {}) {
  const words = (Array.isArray(argv) ? argv : []).map((value) => String(value));
  const head = words.slice(0, 2).join(" ");
  const domain = words[0] ?? "";
  if (LARK_INTERACTIVE.has(head) || LARK_INTERACTIVE.has(domain)) {
    throw new Error(`\`lark-cli ${head}\` 是交互命令，在工具里跑会一直等到超时。请在终端里手动执行一次。`);
  }
  const wantsYes = words.some((word) => word === "--yes" || word === "-y");
  if (wantsYes && !confirmDanger) {
    throw new Error("这条命令带 --yes（删除/高危写）。确认真的执行，就把 confirmDanger 设为 true 再调一次。");
  }
  return words;
}

/**
 * Run a command for its human-readable text rather than its JSON.
 *
 * `--help` is the discovery mechanism for 200+ commands: printing it is how the model learns what a domain can do, and
 * a JSON parser would throw that text away.
 */
export function larkText(args, { timeoutMs = 60000, execFileImpl = execFile, cli = undefined, cwd = undefined } = {}) {
  const resolved = cli ?? larkCliPath();
  if (!resolved) return Promise.reject(new Error(larkCliMissingHint()));
  const argv = (Array.isArray(args) ? args : [args]).map((value) => String(value));
  return new Promise((resolveRun, rejectRun) => {
    execFileImpl(
      resolved.node,
      [resolved.script, ...argv],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, encoding: "utf8", ...(cwd ? { cwd } : {}) },
      (error, stdout, stderr) => {
        const text = `${String(stdout ?? "")}${String(stderr ?? "")}`.trim();
        if (text) return resolveRun(text);
        rejectRun(new Error(error ? String(error.message) : `lark-cli ${argv.join(" ")} 没有输出`));
      },
    );
  });
}


/**
 * Who the CLI will act as, and whether that identity is usable.
 *
 * `user` readiness is the only thing that matters for everything in this module: without it, every write would fall
 * back to the app identity and hit the wall this module exists to avoid.
 */
export async function larkStatus({ timeoutMs = 30000, ...rest } = {}) {
  const envelope = await larkCli(["auth", "status", "--json"], { timeoutMs, ...rest });
  // `auth status` answers with the identity block itself rather than the usual `{ok, data}` envelope - measured, so
  // both shapes are accepted instead of reading `undefined` and calling a working login broken.
  if (envelope.ok === false) throw larkFailure(envelope, "读取 lark-cli 身份");
  const root = envelope.data ?? envelope;
  const identities = root?.identities ?? {};
  return {
    appId: root?.appId ?? "",
    user: identities.user?.status ?? "unknown",
    userOpenId: identities.user?.openId ?? "",
    bot: identities.bot?.status ?? "unknown",
    ready: identities.user?.status === "ready",
  };
}

/**
 * The tenant's own host, e.g. `https://ccnje3t5tkro.feishu.cn`.
 *
 * A link a person can click has to carry the tenant domain: `www.feishu.cn/wiki/space/<id>` only redirects after a
 * login round-trip, and pasted into a chat it reads as a generic page rather than "your knowledge base". The CLI does
 * not expose the domain directly (`whoami`, `spaces get` and `node get` all omit it, and `tenant/v2/tenant/query`
 * needs a bot scope this app does not hold), but every URL it prints carries it - node create, file upload, and the
 * document search results. So the origin is learned from whichever of those we see and cached for the process.
 */
let tenantOriginCache = "";

/** Pull the origin out of any URL-bearing envelope field, and remember it. */
export function rememberOrigin(value) {
  const text = String(value ?? "");
  const found = text.match(/https:\/\/[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)/i);
  if (found && !tenantOriginCache) tenantOriginCache = found[0];
  return tenantOriginCache;
}

/** `` for "not known yet" - callers fall back to the generic link. */
export function tenantOrigin() {
  return tenantOriginCache;
}

/**
 * Learn the tenant host without writing anything: one document search, whose results carry full URLs.
 *
 * `query` is required by the search API, so the caller passes something it already knows - a knowledge base name is
 * the natural choice, because whoever is looking at a space link just came from that name.
 */
export async function larkDiscoverOrigin({ query = "", timeoutMs = 60000, ...rest } = {}) {
  if (tenantOriginCache) return tenantOriginCache;
  const wanted = String(query ?? "").trim();
  if (!wanted) return "";
  try {
    const envelope = await larkCli(["drive", "+search", "--query", wanted, "--json"], { timeoutMs, ...rest });
    if (envelope.ok) rememberOrigin(envelope.raw);
  } catch { /* no search index, no scope, or nothing matches: the caller falls back to the generic link */ }
  return tenantOriginCache;
}

/** The clickable link for a knowledge base, tenant host when known. */
export function spaceUrl(spaceId) {
  const id = String(spaceId ?? "").trim();
  if (!id) return "";
  return tenantOriginCache ? `${tenantOriginCache}/wiki/space/${id}` : `https://www.feishu.cn/wiki/space/${id}`;
}

/** The knowledge bases (wiki spaces) this person can reach. The app identity sees none of these. */
export async function larkWikiSpaces({ timeoutMs = 60000, ...rest } = {}) {
  const envelope = await larkCli(["wiki", "+space-list", "--json"], { timeoutMs, ...rest });
  if (!envelope.ok) throw larkFailure(envelope, "列出知识库");
  const rows = envelope.data?.spaces ?? envelope.data?.items ?? [];
  const spaces = rows.map((space) => ({
    spaceId: String(space.space_id ?? space.spaceId ?? ""),
    name: String(space.name ?? ""),
    type: String(space.space_type ?? ""),
    visibility: String(space.visibility ?? ""),
  }));
  // Best-effort: one search for a known name teaches us the tenant host, so every link below is clickable rather
  // than a generic redirect. A failure here costs nothing - spaceUrl falls back on its own.
  if (spaces.length) await larkDiscoverOrigin({ query: spaces[0].name, ...rest });
  return spaces.map((space) => ({ ...space, url: spaceUrl(space.spaceId) }));
}

/** Create a knowledge base. `--as user` is the only identity the API accepts. */
export async function larkWikiCreateSpace({ name = "", description = "", timeoutMs = 60000, ...rest } = {}) {
  if (!String(name ?? "").trim()) throw new Error("新建知识库需要一个名字");
  const envelope = await larkCli(["wiki", "+space-create", "--name", name, "--description", description, "--json"], { timeoutMs, ...rest });
  if (!envelope.ok) throw larkFailure(envelope, "新建知识库");
  const space = envelope.data ?? {};
  rememberOrigin(envelope.raw);
  const spaceId = String(space.space_id ?? "");
  return { spaceId, name: String(space.name ?? name), url: String(space.url ?? "") || spaceUrl(spaceId) };
}

/** Create one node (a titled child) inside a space; `parentNodeToken` omitted means the space root. */
export async function larkWikiCreateNode({ spaceId = "", title = "", parentNodeToken = "", objType = "docx", timeoutMs = 60000, ...rest } = {}) {
  if (!String(spaceId ?? "").trim()) throw new Error("建节点需要 spaceId");
  if (!String(title ?? "").trim()) throw new Error("建节点需要一个标题");
  const args = ["wiki", "+node-create", "--space-id", spaceId, "--obj-type", objType, "--title", title, "--json"];
  if (String(parentNodeToken ?? "").trim()) args.push("--parent-node-token", parentNodeToken);
  const envelope = await larkCli(args, { timeoutMs, ...rest });
  if (!envelope.ok) throw larkFailure(envelope, `建节点「${title}」`);
  const node = envelope.data ?? {};
  rememberOrigin(node.url);
  return {
    nodeToken: String(node.node_token ?? ""),
    title: String(node.title ?? title),
    url: String(node.url ?? ""),
    parentNodeToken: String(node.parent_node_token ?? ""),
  };
}

/** The titles already sitting under one node - what makes a re-run skip instead of duplicating. */
export async function larkNodeChildren({ spaceId = "", parentNodeToken = "", timeoutMs = 60000, ...rest } = {}) {
  const args = ["wiki", "+node-list", "--space-id", spaceId, "--json"];
  if (String(parentNodeToken ?? "").trim()) args.push("--parent-node-token", parentNodeToken);
  const envelope = await larkCli(args, { timeoutMs, ...rest });
  if (!envelope.ok) throw larkFailure(envelope, "列出知识库节点");
  const rows = envelope.data?.nodes ?? envelope.data?.items ?? [];
  return rows.map((node) => ({ title: String(node.title ?? ""), token: String(node.node_token ?? ""), type: String(node.obj_type ?? "") }));
}

/**
 * Upload one local file *into* a wiki node.
 *
 * `--wiki-token` is what makes this one step instead of two: the CLI maps it to `parent_type=wiki`, so the file is
 * born inside the knowledge base. Uploading to Drive and then moving it would leave a window where it lives in the
 * wrong place, and would need a second permission for the move.
 */
export async function larkUploadToNode({ file = "", nodeToken = "", timeoutMs = 300000, ...rest } = {}) {
  if (!String(file ?? "").trim()) throw new Error("上传需要一个本地文件路径");
  if (!String(nodeToken ?? "").trim()) throw new Error("上传需要一个知识库节点 token");

  const { dirname, resolve, join } = await import("node:path");
  const { copyFile, unlink, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const absolute = resolve(String(file));

  // The CLI refuses a `--file` outside its allowlist (the process cwd, the account's temp dir, or `~/files`), which is
  // a sensible guard for a command a person types and a problem for a plugin: the file it was told to upload can be
  // anywhere. Running the CLI *from the file's own directory* puts it inside the allowlist without copying anything -
  // measured against a 1.79 MB archive that failed with "unsafe file path" before the cwd was set.
  const upload = (path, cwd) => larkCli(["drive", "+upload", "--file", path, "--wiki-token", nodeToken, "--json"], { timeoutMs, cwd, ...rest });

  let envelope;
  try {
    envelope = await upload(absolute, dirname(absolute));
  } catch (error) {
    throw new Error(`上传 ${absolute} 失败：${error?.message ?? error}`);
  }
  if (envelope.ok !== true && /unsafe file path/i.test(String(envelope.error?.message ?? ""))) {
    // Second line of defence: a temp copy under the account's temp dir, which is always allowed. Only reached when a
    // cwd-based run is still rejected (for example a network path the CLI resolves differently).
    const scratch = await mkdtemp(join(tmpdir(), "dsh-lark-"));
    const copy = join(scratch, absolute.split(/[\\/]/).pop());
    await copyFile(absolute, copy);
    try {
      envelope = await upload(copy, scratch);
    } finally {
      await unlink(copy).catch(() => {});
    }
  }
  if (envelope.ok !== true) throw larkFailure(envelope, `上传 ${absolute}`);
  const data = envelope.data ?? {};
  rememberOrigin(data.url);
  return { fileName: String(data.file_name ?? ""), fileToken: String(data.file_token ?? ""), url: String(data.url ?? ""), size: Number(data.size ?? 0) };
}

/**
 * Upload a local file or a local directory tree into a knowledge base, creating one node per top-level folder.
 *
 * The shape this mirrors is the one a course download arrives in - 5 chapter folders, each with lesson folders, each
 * with documents - and the shape a person wants to find later: one node per chapter, the files underneath. Lesson
 * folders are flattened on purpose: a knowledge base navigates by node, and a three-level tree of 49 documents is
 * harder to use than five nodes you can open.
 *
 * @param {object} options
 * @param {string} options.path            local file or directory
 * @param {string} options.spaceId         target space; empty auto-picks the only space there is
 * @param {string} [options.parentNodeToken] parent for the created nodes (default: space root)
 * @param {"folder"|"flat"} [options.groupBy] one node per folder, or a single node for everything
 * @param {string} [options.nodeTitle]     title for the flat node (default: the directory's own name)
 * @param {(event: object) => void} [options.onProgress]
 */
export async function larkUploadTree({
  path = "",
  spaceId = "",
  parentNodeToken = "",
  groupBy = "folder",
  nodeTitle = "",
  onProgress = () => {},
  dryRun = false,
  ...rest
} = {}) {
  const { statSync, readdirSync } = await import("node:fs");
  const absolute = resolve(String(path ?? ""));
  if (!absolute) throw new Error("上传需要一个本地路径");
  const info = statSync(absolute, { throwIfNoEntry: false });
  if (!info) throw new Error(`本地路径不存在：${absolute}`);

  // Which space: an explicit id is honoured, otherwise the only space is used and an ambiguous list is reported
  // rather than guessed - writing into the wrong knowledge base is not a recoverable mistake from here.
  let target = String(spaceId ?? "").trim();
  if (!target) {
    const spaces = await larkWikiSpaces(rest);
    if (spaces.length === 1) target = spaces[0].spaceId;
    else if (!spaces.length) throw new Error("这个账号下没有知识库，先用 `lark-cli wiki +space-create --name ...` 建一个");
    else throw new Error(`有多个知识库，需要指定 spaceId：${spaces.map((s) => `${s.name}(${s.spaceId})`).join("、")}`);
  }

  const uploadFile = async (filePath, nodeToken) => {
    const result = await larkUploadToNode({ file: filePath, nodeToken, ...rest });
    onProgress({ type: "file", file: filePath, url: result.url });
    return result;
  };

  const nodes = [];
  const failed = [];
  let uploaded = 0;
  let skipped = 0;

  // One file: it needs a node to live in, so reuse the named one or make it.
  if (!info.isDirectory()) {
    const title = String(nodeTitle ?? "").trim() || dirname(absolute).split(/[\\/]/).pop() || "资料";
    const existing = await larkNodeChildren({ spaceId: target, parentNodeToken, ...rest });
    const found = existing.find((node) => node.title === title);
    const nodeToken = found ? found.token : (dryRun ? "(dry-run)" : (await larkWikiCreateNode({ spaceId: target, title, parentNodeToken, ...rest })).nodeToken);
    if (!dryRun) {
      const children = await larkNodeChildren({ spaceId: target, parentNodeToken: nodeToken, ...rest });
      const name = absolute.split(/[\\/]/).pop();
      if (children.some((child) => child.title === name)) {
        skipped += 1;
      } else {
        try {
          await uploadFile(absolute, nodeToken);
          uploaded += 1;
        } catch (error) {
          failed.push(`${name} :: ${error.message}`);
        }
      }
    }
    return { spaceId: target, url: spaceUrl(target), nodes: [{ title, nodeToken, url: "" }], uploaded, skipped, failed };
  }

  const entries = readdirSync(absolute, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const looseFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();

  /** Every file under one directory, recursively - the lesson level is flattened. */
  const walkFiles = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(full));
      else if (entry.isFile() && !entry.name.startsWith("~$")) out.push(full);
    }
    return out;
  };

  const groups = [];
  if (groupBy === "flat" || !folders.length) {
    groups.push({ title: String(nodeTitle ?? "").trim() || absolute.split(/[\\/]/).pop() || "资料", files: [...folders.flatMap((name) => walkFiles(join(absolute, name))), ...looseFiles.map((name) => join(absolute, name))] });
  } else {
    for (const folder of folders) groups.push({ title: folder, files: walkFiles(join(absolute, folder)) });
    if (looseFiles.length) groups.push({ title: String(nodeTitle ?? "").trim() || absolute.split(/[\\/]/).pop() || "资料", files: looseFiles.map((name) => join(absolute, name)) });
  }

  const existingNodes = await larkNodeChildren({ spaceId: target, parentNodeToken, ...rest });
  for (const group of groups) {
    const found = existingNodes.find((node) => node.title === group.title);
    const nodeToken = dryRun ? "(dry-run)" : (found ? found.token : (await larkWikiCreateNode({ spaceId: target, title: group.title, parentNodeToken, ...rest })).nodeToken);
    const record = { title: group.title, nodeToken, url: "", files: group.files.length };
    nodes.push(record);
    onProgress({ type: "node", title: group.title, files: group.files.length });
    if (dryRun) continue;

    const children = await larkNodeChildren({ spaceId: target, parentNodeToken: nodeToken, ...rest });
    const present = new Set(children.map((child) => child.title));
    for (const filePath of group.files) {
      const name = filePath.split(/[\\/]/).pop();
      if (present.has(name)) {
        skipped += 1;
        continue;
      }
      try {
        await uploadFile(filePath, nodeToken);
        uploaded += 1;
      } catch (error) {
        failed.push(`${name} :: ${error.message}`);
      }
    }
  }

  return { spaceId: target, url: spaceUrl(target), nodes, uploaded, skipped, failed };
}
