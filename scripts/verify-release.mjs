#!/usr/bin/env node
/**
 * "Did anything get left out?" - compares three sources of truth and exits 1 when they disagree.
 *
 *   1. the work tree        (what was written)
 *   2. GitHub `main`        (what is published, by blob hash)
 *   3. the installed copy   (what actually runs), restricted to the `files[]` packing contract
 *
 * Needs a token with read access to the repository: GH_TOKEN=... node scripts/verify-release.mjs [owner/repo]
 *
 * Tests are deliberately NOT expected in the installed copy - `files[]` is the packaging contract, and the 44 test files live in
 * the repository only. Comparing them was how the first version of this audit produced two false alarms.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const REPO = process.argv[2] ?? "wjh-ux/dsh-wechat-media";
const INSTALLED =
  process.env.DSH_PLUGIN_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh/profiles/desktop/node_modules/dsh-wechat-media");
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("GH_TOKEN is required (read access to the repository is enough)");
  process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_FILES = /\.(tgz|vsix)$/;
function walk(dir, prefix = "", out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel, out);
    else if (!SKIP_FILES.test(entry.name)) out.push(rel);
  }
  return out;
}

const sha = (buffer) => createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
const headers = { authorization: `Bearer ${TOKEN}`, "user-agent": "dsh-verify", accept: "application/vnd.github+json" };

const work = walk(ROOT);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const shouldShip = new Set();
const dangling = [];
for (const entry of pkg.files ?? []) {
  const abs = join(ROOT, entry);
  if (!existsSync(abs)) {
    dangling.push(entry);
    continue;
  }
  if (statSync(abs).isDirectory()) for (const rel of walk(abs, entry)) shouldShip.add(rel);
  else shouldShip.add(entry);
}

const ref = await (await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/main`, { headers })).json();
const commit = await (await fetch(`https://api.github.com/repos/${REPO}/git/commits/${ref.object.sha}`, { headers })).json();
const tree = await (await fetch(`https://api.github.com/repos/${REPO}/git/trees/${commit.tree.sha}?recursive=1`, { headers })).json();
const remote = new Map(tree.tree.filter((node) => node.type === "blob").map((node) => [node.path, node.sha]));

const missing = [];
const different = [];
for (const rel of work) {
  const local = sha(readFileSync(join(ROOT, rel)));
  if (!remote.has(rel)) missing.push(rel);
  else if (remote.get(rel) !== local) different.push(rel);
}

const unshipped = [...shouldShip].filter((rel) => !existsSync(join(INSTALLED, rel)));
const installedVersion = existsSync(join(INSTALLED, "package.json"))
  ? JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8")).version
  : "(not installed)";

console.log("main:", ref.object.sha.slice(0, 8), "-", commit.message.split("\n")[0]);
console.log(`work tree: ${work.length} files | missing on GitHub: ${missing.length} | different: ${different.length}`);
if (missing.length) console.log("  MISSING:", missing.join(", "));
if (different.length) console.log("  DIFFERENT:", different.join(", "));
console.log(`files[] entries that do not exist: ${dangling.length ? dangling.join(", ") : "(none)"}`);
console.log(`should ship: ${shouldShip.size} files | absent from the installed copy: ${unshipped.length ? unshipped.join(", ") : "(none)"}`);
console.log(`versions: { package: ${pkg.version}, installed: ${installedVersion} }`);

const ok = missing.length === 0 && different.length === 0 && dangling.length === 0 && unshipped.length === 0 && pkg.version === installedVersion;
console.log(ok ? "\n✅ work tree = GitHub main, files[] = installed copy" : "\n❌ something is out of step");
process.exit(ok ? 0 : 1);
