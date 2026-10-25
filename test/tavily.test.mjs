// Tavily search for the chat channels. The shapes under test were copied from the user's own working plugin
// (wjh-ux/dsh-mcp-tavily, index.js), so these assertions pin the contract this bridge must keep.
import assert from "node:assert/strict";

// publicPrefs masks through the store's own list; this test evaluates its source, so the helper must be in scope.
import { maskSecretPrefs } from "../secrets.js";

const { tavilyHeaders, tavilyErrorText, tavilySearch, formatTavilyResults, TAVILY_HOST, TAVILY_SEARCH_DEPTHS } = await import("../tavily.js");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

await test("a search sends the body and headers the working plugin uses", async () => {
  const calls = [];
  const impl = async (url, options) => { calls.push({ url: String(url), options }); return jsonResponse({ results: [{ url: "https://e.com/a", title: "标题", content: "摘要内容", published_date: "2026-01-02" }] }); };
  const got = await tavilySearch({ query: "  dsh 插件  ", apiKey: "tvly-abc", maxResults: 3, searchDepth: "advanced", fetchImpl: impl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TAVILY_HOST}/search`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer tvly-abc");
  assert.equal(calls[0].options.headers["x-tavily-access-mode"], undefined, "a key means a bearer token, not keyless mode");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    query: "dsh 插件",
    max_results: 3,
    search_depth: "advanced",
    chunks_per_source: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  }, "the body matches their L211-219 exactly, plus nothing");
  assert.equal(got.keyless, false);
  assert.deepEqual(got.results, [{ url: "https://e.com/a", title: "标题", snippet: "摘要内容", publishedAt: "2026-01-02" }]);
});

await test("without a key the request asks for keyless mode", () => {
  const headers = tavilyHeaders("");
  assert.equal(headers["x-tavily-access-mode"], "keyless");
  assert.equal(headers.authorization, undefined);
  assert.equal(tavilyHeaders("  ").authorization, undefined, "a blank key is not a key");
  assert.equal(tavilyHeaders(" tvly-x ").authorization, "Bearer tvly-x", "and it is trimmed");
});

await test("domains, the depth fallback and the result cap behave", async () => {
  const bodies = [];
  const impl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ results: [] }); };
  await tavilySearch({ query: "q", searchDepth: "nonsense", maxResults: 99, includeDomains: ["a.com", " "], excludeDomains: ["b.com"], fetchImpl: impl });
  assert.equal(bodies[0].search_depth, "basic", "an unknown depth falls back to basic");
  assert.equal(bodies[0].max_results, 20, "the cap is 20");
  assert.deepEqual(bodies[0].include_domains, ["a.com"], "blank domains are dropped");
  assert.deepEqual(bodies[0].exclude_domains, ["b.com"]);
  await tavilySearch({ query: "q", fetchImpl: impl });
  assert.equal(bodies[1].include_domains, undefined, "no domains means no domain keys at all");
  assert.ok(TAVILY_SEARCH_DEPTHS.includes("fast"));
});

await test("errors report the most specific thing the API said", async () => {
  await assert.rejects(() => tavilySearch({ query: "  " }), /needs a query/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => jsonResponse({ error: "invalid api key" }, 401) }), /invalid api key/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => jsonResponse({ error: { message: "rate limited" } }, 429) }), /rate limited/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => jsonResponse({ detail: "quota" }, 432) }), /quota/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }) }), /HTTP 500/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => { const e = new Error("boom"); e.name = "TimeoutError"; throw e; } }), /timed out/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), /Tavily request failed: ECONNREFUSED/);
  await assert.rejects(() => tavilySearch({ query: "q", fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) }), /unprocessable/);
  const text = await tavilyErrorText({ status: 503, json: async () => ({ error: "down" }) });
  assert.equal(text, "down");
});

await test("a result without a url is dropped, and the chat answer is readable", async () => {
  const impl = async () => jsonResponse({ results: [{ title: "no url" }, { url: "https://e.com/b", title: "有", content: "c" }] });
  const got = await tavilySearch({ query: "q", fetchImpl: impl });
  assert.equal(got.results.length, 1, "a result the reader cannot check is not offered");
  assert.equal(got.results[0].url, "https://e.com/b");

  const empty = formatTavilyResults({ query: "q", results: [], keyless: true });
  assert.match(empty, /没有返回任何结果/);
  assert.match(empty, /免密钥模式/, "keyless mode is stated, not hidden");
  const filled = formatTavilyResults(got);
  assert.match(filled, /1\. 有/);
  assert.match(filled, /https:\/\/e\.com\/b/);
  assert.match(filled, /c$/m);
});

// The plugin's own wiring: the key must not be echoed, the tool must be registered, and a failure must say why.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const host = readFileSync(join(here, "..", "index.js"), "utf8");

await test("the Tavily key is redacted by every reader, including when no Feishu block exists", () => {
  // Evaluated rather than merely grepped: the first version of publicPrefs returned the whole prefs object when there
  // was no `feishu` key, which is exactly the shape a Tavily-only save produces.
  const start = host.indexOf("function publicPrefs");
  assert.ok(start > 0, "publicPrefs exists");
  const body = host.slice(start, host.indexOf("\n  }", start) + 4);
  // publicPrefs masks through the store's own list now; the helper comes from the top-of-file import.
  const publicPrefs = eval(`(${body})`);
  const withFeishu = publicPrefs({ tavily: { apiKey: "tvly-secret" }, feishu: { appSecret: "x" } });
  assert.equal(withFeishu.tavily.apiKey, "***", "the Tavily key is masked");
  assert.equal(withFeishu.feishu.appSecret, "***", "and so is the Feishu secret");
  const tavilyOnly = publicPrefs({ tavily: { apiKey: "tvly-secret", maxResults: "7" } });
  assert.equal(tavilyOnly.tavily.apiKey, "***", "a Tavily-only prefs object is still redacted");
  assert.equal(tavilyOnly.tavily.maxResults, "7", "only the secret is masked");
  assert.equal(publicPrefs({ tavily: { apiKey: "" } }).tavily.apiKey, "", "an empty key stays empty, not ***");
  assert.doesNotMatch(JSON.stringify(withFeishu), /tvly-secret/, "the plaintext never appears in the result");
});

await test("the tool is registered, refreshes before each call, and reports failures", () => {
  assert.match(host, /name: "tavily_search"/, "the tool exists");
  // Registered inside the loop that hands tools to the harness, without pinning the neighbours: the exact-string form
  // went stale the moment the browser tools were added - the same brittleness that has now bitten four times today.
  assert.match(host, /for \(const definition of \[[^\]]*tavilySearchTool[^\]]*\]\)/, "and it is registered with the harness");
  assert.match(host, /await refreshTavilySavedPrefs\(\);/, "it re-reads the saved settings before searching");
  // The reason has to be in the message: asserting only that "Tavily 搜索失败" appears passed even after the
  // `${error?.message}` was removed, which falsification caught. A failure that says nothing is the thing to avoid.
  assert.match(host, /Tavily 搜索失败：\$\{error\?\.message \?\? error\}/, "a failure states its reason, not just a label");
  assert.match(host, /await import\("\.\/tavily\.js"\)/, "it loads the module it uses");
});

await test("the state and prefs routes carry Tavily without leaking the key", () => {
  assert.match(host, /tavily: tavilyState\(\),/, "/state reports the Tavily state");
  assert.match(host, /const tavilyPatch = tavilyPrefsPatch/, "/prefs accepts the Tavily fields");
  assert.match(host, /tavily: applied\.tavily, tavilyChanged: applied\.changed/, "and reports what changed");
  // Every response that returns prefs must still go through the redaction helper.
  const responses = host.split(/\r?\n/).filter((line) => line.includes("json(res"));
  for (const line of responses) {
    for (const match of line.matchAll(/prefs:\s*([A-Za-z0-9_.]+)/g)) {
      assert.match(match[1], /^publicPrefs/, `a response returns prefs unredacted: ${match[1]}`);
    }
  }
});

await test("the panel offers the Tavily key without ever echoing it", () => {
  const client = readFileSync(join(here, "..", "client.js"), "utf8");
  assert.match(client, /tavilyLabel/, "the block is labelled");
  assert.match(client, /const \[tavilyDraft, setTavilyDraft\]/, "it keeps its own draft, apart from the Feishu one");
  // The key must be a masked input: a plain text field would show the secret on screen.
  const keyInput = client.slice(client.indexOf('key: "key"'), client.indexOf('key: "key"') + 300);
  assert.match(keyInput, /type: "password"/, "the key field is masked");
  assert.match(client, /tavilyApiKey: event\.target\.value/, "typing fills that draft");
  // A blank field is skipped, so saving other Tavily settings cannot wipe a stored key.
  assert.match(client, /if \(String\(value \?\? ""\)\.trim\(\)\) params\.set\(field/, "blank fields are never submitted");
  assert.match(client, /snapshot\??\.tavily\??\.keySet/, "the panel can say whether a key is set");
  // The key field must carry no `value` at all. The first version of this check looked for a literal `tavilyApiKey`
  // near `value:`, and filling the field from state with `value: snapshot?.tavily?.apiKey` slipped straight past it -
  // falsification caught that. "No value" is the property; naming one spelling of the mistake is not.
  assert.doesNotMatch(keyInput, /value:/, "the key field is never pre-filled from state");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
