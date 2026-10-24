/**
 * Tests for the scrapling module: request shaping, the base64 protocol, output parsing, failure reporting and the
 * renderer. No network and no python - the script is exercised through an injected exec.
 */
import assert from "node:assert/strict";

const scrapling = await import("../scrapling.js");

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

const encode = (object) => Buffer.from(JSON.stringify(object), "utf8").toString("base64");

await test("the python side is one self-contained script with every section guarded", () => {
  const script = scrapling.scraplingScript();
  assert.match(script, /from scrapling\.fetchers import Fetcher, StealthyFetcher/);
  // A selector that matches nothing must not lose the body, and a missing optional dependency must not lose the fetch.
  assert.equal((script.match(/except Exception as error/g) ?? []).length >= 4, true);
  assert.match(script, /ToBase64String|b64encode/, "output must be base64, or the console codepage mangles it");
  assert.match(script, /PYTHONIOENCODING|ensure_ascii=False/);
});

await test("the request is validated before a process starts", async () => {
  await assert.rejects(() => scrapling.scrape({}), /缺少 url/);
  await assert.rejects(() => scrapling.scrape({ url: "file:///etc/passwd" }), /只接受 http\(s\)/);
});

await test("numbers are clamped, so a huge limit cannot flood the transcript", async () => {
  let seen;
  const exec = (program, args, options, callback) => {
    seen = { program, args, options };
    process.nextTick(() => callback(null, encode({ ok: true, status: 200, items: [], text: "", links: [] }), ""));
    return {};
  };
  await scrapling.scrape(
    { url: "https://example.com", limit: 9999, textLimit: 999999, timeout: 9999 },
    { exec, exists: () => true, env: { SCRAPLING_PYTHON: "py.exe" } },
  );
  const request = JSON.parse(Buffer.from(seen.args.at(-1), "base64").toString("utf8"));
  assert.equal(request.limit, scrapling.SCRAPLING_ITEMS_MAX);
  assert.equal(request.textLimit, scrapling.SCRAPLING_TEXT_MAX);
  assert.equal(request.timeout, 120);
  assert.equal(seen.options.env.PYTHONIOENCODING, "utf-8");
});

await test("a scrapling failure is reported with the exception text, not swallowed", async () => {
  const exec = (program, args, options, callback) => {
    process.nextTick(() => callback(null, encode({ ok: false, error: "ModuleNotFoundError: No module named 'curl_cffi'" }), ""));
    return {};
  };
  const result = await scrapling.scrape({ url: "https://example.com" }, { exec, exists: () => true, env: { SCRAPLING_PYTHON: "py.exe" } });
  assert.equal(result.ok, false);
  assert.match(scrapling.renderScrape(result), /抓取失败.*curl_cffi/);
});

await test("a real-shaped success renders status, items and a truncated body", () => {
  const result = {
    ok: true,
    status: 200,
    url: "https://quotes.toscrape.com/",
    ms: 1713,
    items: [{ text: "“The world as we have created it…”" }],
    text: "x".repeat(5000),
    links: [{ href: "/login", text: "Login" }],
    warnings: ["选择器 'h1' 没有匹配到任何节点"],
  };
  const rendered = scrapling.renderScrape(result);
  assert.match(rendered, /✅ 200 · https:\/\/quotes\.toscrape\.com\/ · 1713ms/);
  assert.match(rendered, /⚠️ 选择器/);
  assert.match(rendered, /选择器命中 1 条/);
  assert.match(rendered, /已截断/, "a long body is truncated in the transcript, and says so");
  assert.match(rendered, /Login -> \/login/);
});

await test("output that is not base64 JSON is an error, not a crash", () => {
  assert.throws(() => scrapling.parseScraplingOutput("Traceback (most recent call last)"), /不是 base64 JSON/);
  assert.deepEqual(scrapling.parseScraplingOutput(encode({ ok: true, status: 204 })), { ok: true, status: 204 });
});

await test("the module ships: scrapling.js is in files[]", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("scrapling.js"), "scrapling.js must be in files[] or an install has no tool");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
