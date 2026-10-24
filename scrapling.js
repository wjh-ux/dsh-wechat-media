/**
 * Scrapling: a real scraping engine behind one tool.
 *
 * Scrapling does the part that is genuinely hard - TLS fingerprints, browser-shaped headers, adaptive selectors - and this
 * module does the part that makes it usable from a chat: find a python that has it, pass a JSON request over base64
 * (because a Windows console mangles anything else), cap what comes back, and always say *why* when a page cannot be read.
 *
 * Two rules worth stating:
 * - **A fetch that fails is reported, not retried into a wall.** Scrapling raises on network trouble; the tool returns the
 *   exception's own text, which is what a person needs in order to decide (proxy? Cloudflare? wrong URL?).
 * - **Output is capped, and the cap is visible.** A page can be megabytes; the transcript should not be.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const SCRAPLING_TIMEOUT_MS = 120_000;
export const SCRAPLING_TEXT_MAX = 20_000;
export const SCRAPLING_ITEMS_MAX = 50;

/**
 * The python side. Kept as one string so the module stays a single file (files[] in package.json is a list, and a missing
 * helper file is how a plugin installs and then fails at runtime).
 *
 * Every section is wrapped: a selector that matches nothing must still return the page's text, and a missing optional
 * dependency must not lose a fetch that already succeeded.
 */
export function scraplingScript() {
  return `
import base64, json, sys

request = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
answer = {"ok": False, "url": request.get("url", ""), "items": [], "text": "", "links": [], "html": "", "warnings": []}
try:
    from scrapling.fetchers import Fetcher, StealthyFetcher
except Exception as error:  # noqa: BLE001 - report, never crash
    answer["error"] = f"scrapling 不可用：{type(error).__name__}: {error}"
    print(base64.b64encode(json.dumps(answer, ensure_ascii=False).encode("utf-8")).decode())
    sys.exit(0)

kwargs = {"timeout": int(request.get("timeout") or 30)}
if request.get("proxy"):
    kwargs["proxy"] = request["proxy"]
if request.get("headers"):
    kwargs["headers"] = request["headers"]

fetcher = Fetcher
if request.get("stealth"):
    fetcher = StealthyFetcher
    if request.get("wait"):
        kwargs["wait"] = int(request["wait"])

try:
    page = fetcher.get(request["url"], **kwargs)
except Exception as error:  # noqa: BLE001
    answer["error"] = f"{type(error).__name__}: {error}"
    print(base64.b64encode(json.dumps(answer, ensure_ascii=False).encode("utf-8")).decode())
    sys.exit(0)

answer["ok"] = True
answer["status"] = getattr(page, "status", None)
answer["url"] = str(getattr(page, "url", request["url"]))
if request.get("mode") == "html":
    answer["html"] = (page.html_content or "")[: int(request.get("limit") or 20000)]

limit = int(request.get("limit") or 20)
selector = (request.get("selector") or "").strip()
if selector:
    try:
        nodes = page.css(selector)
        for node in nodes[:limit]:
            text = getattr(node, "text", None)
            if not text and hasattr(node, "get_all_text"):
                text = node.get_all_text()
            entry = {"text": (text or "").strip()[:2000]}
            attrib = getattr(node, "attrib", None)
            if isinstance(attrib, dict) and attrib:
                entry["attrib"] = {k: str(v)[:200] for k, v in list(attrib.items())[:10]}
            answer["items"].append(entry)
        if not answer["items"]:
            answer["warnings"].append(f"选择器 {selector!r} 没有匹配到任何节点")
    except Exception as error:  # noqa: BLE001
        answer["warnings"].append(f"选择器 {selector!r} 出错：{type(error).__name__}: {error}")

try:
    answer["text"] = (page.get_all_text() or "")[: int(request.get("textLimit") or 20000)]
except Exception as error:  # noqa: BLE001
    answer["warnings"].append(f"取正文失败：{type(error).__name__}: {error}")

if request.get("links"):
    try:
        anchors = page.css("a")
        for node in anchors[:limit]:
            attrib = getattr(node, "attrib", {}) or {}
            answer["links"].append({"href": str(attrib.get("href", ""))[:500], "text": (getattr(node, "text", "") or "").strip()[:200]})
    except Exception as error:  # noqa: BLE001
        answer["warnings"].append(f"取链接失败：{type(error).__name__}: {error}")

print(base64.b64encode(json.dumps(answer, ensure_ascii=False).encode("utf-8")).decode())
`;
}

/** Where scrapling lives: a python on PATH, or the ESP-IDF env that pip tends to install into on this machine. */
export function findPython({ env = process.env, exists = existsSync } = {}) {
  const candidates = [
    env.SCRAPLING_PYTHON,
    env.DSH_PYTHON,
    "D:\\Espressif\\python_env\\idf4.4_py3.11_env\\Scripts\\python.exe",
    "D:\\Espressif\\python_env\\idf4.4_py3.8_env\\Scripts\\python.exe",
    "C:\\Python311\\python.exe",
    "C:\\Python312\\python.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return "";
}

/** Parse the base64 JSON the python side prints. */
export function parseScraplingOutput(stdout) {
  const line = String(stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) ?? "";
  try {
    return JSON.parse(Buffer.from(line, "base64").toString("utf8"));
  } catch {
    throw new Error(`scrapling 的输出不是 base64 JSON：${line.slice(0, 300)}`);
  }
}

/** Run one scrape. `exec` and `exists` are injectable so the argv logic is testable without python or a network. */
export function scrape(request = {}, { exec = execFile, exists = existsSync, env = process.env, timeoutMs = SCRAPLING_TIMEOUT_MS } = {}) {
  const url = String(request.url ?? "").trim();
  if (!url) return Promise.reject(new Error("缺少 url"));
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error(`只接受 http(s) 地址：${url}`));
  const python = findPython({ env, exists });
  if (!python) return Promise.reject(new Error("找不到装了 scrapling 的 python —— 先 pip install scrapling"));
  const payload = {
    url,
    selector: request.selector ?? "",
    mode: request.mode ?? "text",
    limit: clampNumber(request.limit, 1, SCRAPLING_ITEMS_MAX, 20),
    textLimit: clampNumber(request.textLimit, 500, SCRAPLING_TEXT_MAX, 10000),
    timeout: clampNumber(request.timeout, 5, 120, 30),
    stealth: Boolean(request.stealth),
    wait: clampNumber(request.wait, 0, 60, 0),
    links: Boolean(request.links),
    proxy: String(request.proxy ?? ""),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    exec(python, ["-c", scraplingScript(), encoded], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new Error(`超时（${Math.round(timeoutMs / 1000)}s）`));
        return;
      }
      try {
        resolve({ ...parseScraplingOutput(stdout), ms: Date.now() - started });
      } catch (parseError) {
        reject(new Error(`${parseError.message}${stderr ? `\n${String(stderr).slice(-500)}` : ""}`));
      }
    });
  });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/** Render one scrape as the text a chat wants: the status line, the selector hits, then the body. */
export function renderScrape(result) {
  const lines = [];
  if (!result?.ok) {
    lines.push(`❌ 抓取失败：${result?.error ?? "未知原因"}`);
    return lines.join("\n");
  }
  lines.push(`✅ ${result.status ?? "?"} · ${result.url} · ${result.ms}ms`);
  if (Array.isArray(result.warnings) && result.warnings.length) {
    for (const warning of result.warnings) lines.push(`⚠️ ${warning}`);
  }
  if (Array.isArray(result.items) && result.items.length) {
    lines.push("", `选择器命中 ${result.items.length} 条：`);
    for (const item of result.items) lines.push(`  · ${item.text}`);
  }
  if (result.html) {
    lines.push("", "--- HTML（截断）---", result.html);
    return lines.join("\n");
  }
  if (result.text) {
    const text = String(result.text);
    lines.push("", "--- 正文 ---", text.length > 4000 ? `${text.slice(0, 4000)}\n…（共 ${text.length} 字符，已截断）` : text);
  }
  if (Array.isArray(result.links) && result.links.length) {
    lines.push("", `链接 ${result.links.length} 个：`);
    for (const link of result.links) lines.push(`  · ${link.text || "(无文字)"} -> ${link.href}`);
  }
  return lines.join("\n");
}
