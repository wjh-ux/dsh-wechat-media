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
  const sources = ["index.js", "client.js", "ilink.js", "login.js", "media.js", "state.js"];
  for (const source of sources) {
    const text = readFileSync(join(root, source), "utf8");
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = join(root, dirname(source), match[1]);
      assert.ok(existsSync(target), `${source} imports missing module ${match[1]}`);
    }
  }
});

test("the host half never statically imports a harness package", () => {
  // A link-installed plugin cannot resolve @deepseek-ai/* from its own directory,
  // so those must go through the loader at runtime instead.
  for (const source of ["index.js", "login.js", "media.js", "state.js"]) {
    const text = readFileSync(join(root, source), "utf8");
    for (const match of text.matchAll(/^\s*import[^;]*from\s+"(@deepseek-ai\/[^"]+)"/gm)) {
      assert.fail(`${source} statically imports ${match[1]}; use ctx.loader.internal.import`);
    }
  }
});

test("the patch inserts exactly one row and carries no secret", () => {
  const yaml = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  const inserts = [...yaml.matchAll(/- id: ([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  assert.deepEqual(inserts, ["wechat-media"]);
  assert.ok(!/tvly-|Bearer\s+[A-Za-z0-9]/.test(yaml), "no credential may appear in the patch");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
