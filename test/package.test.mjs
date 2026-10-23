/**
 * Packaging checks: the things that silently break a published dsh plugin.
 *
 * Run: node test/package.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/**
 * Every shipped JavaScript module that runs on the host: taken from the manifest, so
 * a new module cannot be published without also being import-checked here. The client
 * half is excluded because it is bundled for the browser, not resolved by node.
 */
function hostModules() {
  return pkg.files.filter((file) => file.endsWith(".js") && file !== "client.js");
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

console.log("packaging");

test("manifest declares what dsh needs", () => {
  assert.equal(pkg.name, "dsh-wechat-media");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.repository?.url?.includes("dsh-wechat-media"));
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh?.client?.platform, "web");
});

test("every published file exists", () => {
  for (const file of pkg.files) {
    assert.ok(existsSync(join(root, file)), `files entry missing on disk: ${file}`);
  }
});

test("exports point at real files and cover the client half", () => {
  assert.ok(existsSync(join(root, pkg.main)), `main missing: ${pkg.main}`);
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === "./package.json") continue;
    assert.ok(existsSync(join(root, target)), `exports["${key}"] missing: ${target}`);
  }
  assert.equal(pkg.exports["./client"], "./client.js");
});

test("the client inject list holds PACKAGE names", () => {
  const inject = pkg.dsh.client.inject ?? [];
  assert.ok(inject.length > 0, "dsh.client.inject must not be empty");
  for (const name of inject) {
    assert.ok(name.startsWith("@deepseek-ai/"), `unexpected package name: ${name}`);
  }
});

test("the client module inject list holds SERVICE names", () => {
  const code = readFileSync(join(root, "client.js"), "utf8");
  const match = /const inject = (\[[^\]]*\]);/.exec(code);
  assert.ok(match, "client.js must declare `const inject = [...]`");
  const services = JSON.parse(match[1].replace(/'/g, '"'));
  assert.ok(services.includes("slots"));
  for (const name of services) {
    assert.ok(!name.startsWith("@"), `service names only, found package: ${name}`);
  }
});

test("the client half keeps its __ModuleLoader__ wrapper", () => {
  const code = readFileSync(join(root, "client.js"), "utf8");
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(code, /id: "dsh-wechat-media"/);
  assert.ok(code.trimEnd().endsWith("});"), "the wrapper must close the file");
  assert.match(code, /exports\.apply = apply;/);
});

test("every relative import resolves", () => {
  for (const source of hostModules()) {
    assert.ok(existsSync(join(root, source)), `published source missing: ${source}`);
    const text = readFileSync(join(root, source), "utf8");
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = join(root, dirname(source), match[1]);
      assert.ok(existsSync(target), `${source} imports missing module ${match[1]}`);
    }
  }
});

test("every module a published module imports is published too", () => {
  // `files[]` is a whitelist: a module that is imported but not listed still works in a checkout and is missing from
  // every installed copy. Measured from a real `dsh plugin add github:` install: importing `index.js` died on
  // `Cannot find module .../modelguard.js`, because `modelguard.js` was never added to the list when it was written.
  const published = new Set(pkg.files.map((file) => file.replace(/\\/g, "/")));
  for (const source of hostModules()) {
    const text = readFileSync(join(root, source), "utf8");
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = join(dirname(source), match[1]).replace(/\\/g, "/");
      assert.ok(
        published.has(target),
        `${source} imports ${target}, which is missing from package.json files[]`,
      );
    }
  }
  // The SILK encoder is loaded by path at runtime rather than imported by name, so it needs its own line: a missing
  // wasm makes every voice message silently unsendable in an installed copy.
  for (const asset of ["vendor/silk-wasm/index.mjs", "vendor/silk-wasm/silk.wasm"]) {
    assert.ok(published.has(asset), `${asset} must be listed in package.json files[]`);
    assert.ok(existsSync(join(root, asset)), `${asset} must exist on disk`);
  }
});

test("the host half never statically imports a harness package", () => {
  // A link-installed plugin cannot resolve @deepseek-ai/* from its own directory,
  // so those must go through the loader at runtime instead.
  for (const source of hostModules()) {
    const text = readFileSync(join(root, source), "utf8");
    for (const match of text.matchAll(/^\s*import[^;]*from\s+"(@deepseek-ai\/[^"]+)"/gm)) {
      assert.fail(`${source} statically imports ${match[1]}; use ctx.loader.internal.import`);
    }
  }
});

test("the cookbook ships and the README links to it", () => {
  // A document that is not in files[] never reaches an installed copy, and one nobody
  // links to is never found - both are silent losses, so both are checked here.
  const doc = "docs/build-a-knowledge-base.md";
  assert.ok(pkg.files.includes(doc), `${doc} must be listed in package.json files[]`);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(readme.includes(`./${doc}`), `README.md must link to ./${doc}`);
});

test("the patch inserts exactly one row and carries no secret", () => {
  const yaml = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  const inserts = [...yaml.matchAll(/- id: ([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  assert.deepEqual(inserts, ["wechat-media"]);
  assert.ok(!/tvly-|Bearer\s+[A-Za-z0-9]/.test(yaml), "no credential may appear in the patch");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
