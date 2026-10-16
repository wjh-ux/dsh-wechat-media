/**
 * Tavily web search, for the chat channels this bridge serves.
 *
 * Every shape here is copied from the user's own working plugin (`wjh-ux/dsh-mcp-tavily`, `index.js`) rather than
 * guessed - that file is the trustworthy source:
 *
 *   POST https://api.tavily.com/search                                     (their TAVILY_HOST + L207)
 *   headers { content-type, accept } +                                       (their tavilyHeaders, L151)
 *     `authorization: Bearer <key>` when a key is set, otherwise
 *     `x-tavily-access-mode: keyless`                                        (their L154 - search works keyless too)
 *   body { query, max_results, search_depth: basic|advanced|fast,           (their L211-219)
 *          chunks_per_source: 3, include_answer: false,
 *          include_raw_content: false, include_images: false }
 *   response { results: [{ url, title, content, published_date }] }          (their toSources, L163-174)
 *   errors  json.error (string) | json.error.message | json.message | json.detail | `HTTP <status>`
 *                                                                           (their tavilyErrorText, L188-199)
 */

export const TAVILY_HOST = "https://api.tavily.com";

/** The depth tiers Tavily accepts; anything else falls back to `basic`, as their code does. */
export const TAVILY_SEARCH_DEPTHS = ["basic", "advanced", "fast"];

/**
 * Request headers. A key gives a bearer token; without one we explicitly ask for keyless mode, which Tavily supports
 * and which means search still works on a machine where no key has been configured yet.
 */
export function tavilyHeaders(apiKey = "") {
  const headers = { "content-type": "application/json", accept: "application/json" };
  const key = String(apiKey ?? "").trim();
  if (key) headers.authorization = `Bearer ${key}`;
  else headers["x-tavily-access-mode"] = "keyless";
  return headers;
}

/** The most specific message the API is willing to give, falling back to the status line. Never throws. */
export async function tavilyErrorText(response) {
  let message = `Tavily API error (HTTP ${response?.status ?? "?"})`;
  try {
    const payload = await response.json();
    const detail = typeof payload?.error === "string"
      ? payload.error
      : payload?.error?.message || payload?.message || payload?.detail;
    if (typeof detail === "string" && detail.trim()) message = detail;
  } catch {
    // keep the status-line fallback
  }
  return message;
}

/**
 * Run one search.
 *
 * @param {{ query?: string, apiKey?: string, maxResults?: number, searchDepth?: string,
 *           includeDomains?: string[], excludeDomains?: string[], timeoutMs?: number,
 *           fetchImpl?: Function }} input
 * @returns {Promise<{ query: string, results: Array<{ url: string, title: string, snippet: string, publishedAt: string }>, keyless: boolean }>}
 */
export async function tavilySearch({
  query = "",
  apiKey = "",
  maxResults = 5,
  searchDepth = "basic",
  includeDomains = [],
  excludeDomains = [],
  timeoutMs = 30_000,
  fetchImpl = fetch,
} = {}) {
  const asked = String(query ?? "").trim();
  if (!asked) throw new Error("a Tavily search needs a query");
  const key = String(apiKey ?? "").trim();
  const count = Math.max(1, Math.min(20, Number(maxResults) || 5));
  const depth = TAVILY_SEARCH_DEPTHS.includes(String(searchDepth)) ? String(searchDepth) : "basic";
  const domains = (value) => (Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : []);
  const body = {
    query: asked,
    max_results: count,
    search_depth: depth,
    chunks_per_source: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };
  const include = domains(includeDomains);
  const exclude = domains(excludeDomains);
  if (include.length) body.include_domains = include;
  if (exclude.length) body.exclude_domains = exclude;

  const options = {
    method: "POST",
    redirect: "error",
    headers: tavilyHeaders(key),
    body: JSON.stringify(body),
  };
  if (Number(timeoutMs) > 0 && typeof AbortSignal?.timeout === "function") options.signal = AbortSignal.timeout(Number(timeoutMs));

  let response;
  try {
    response = await fetchImpl(`${TAVILY_HOST}/search`, options);
  } catch (error) {
    // A timeout and a network failure are different problems for whoever has to fix it, so they say different things.
    const name = String(error?.name ?? "");
    if (name === "TimeoutError" || name === "AbortError") throw new Error(`Tavily search timed out after ${timeoutMs}ms`);
    throw new Error(`Tavily request failed: ${String(error?.message ?? error)}`);
  }
  if (!response?.ok) throw new Error(await tavilyErrorText(response));

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Tavily returned an unprocessable response: ${String(error?.message ?? error)}`);
  }
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const results = [];
  for (const row of rows) {
    const url = String(row?.url ?? "");
    if (!url) continue; // a result without a URL cannot be checked by the reader
    results.push({
      url,
      title: String(row?.title ?? ""),
      snippet: String(row?.content ?? "").slice(0, 800),
      publishedAt: String(row?.published_date ?? ""),
    });
  }
  return { query: asked, results, keyless: !key };
}

/** One line per result, for a chat answer. */
export function formatTavilyResults(outcome) {
  const lines = [];
  lines.push(`Tavily${outcome?.keyless ? "（无 key，免密钥模式）" : ""} 搜索：${outcome?.query ?? ""}`);
  const results = Array.isArray(outcome?.results) ? outcome.results : [];
  if (!results.length) {
    lines.push("没有返回任何结果。");
    return lines.join("\n");
  }
  results.forEach((item, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${item.title || "(无标题)"}`);
    lines.push(`   ${item.url}`);
    if (item.snippet) lines.push(`   ${item.snippet}`);
    if (item.publishedAt) lines.push(`   发布时间：${item.publishedAt}`);
  });
  return lines.join("\n");
}
