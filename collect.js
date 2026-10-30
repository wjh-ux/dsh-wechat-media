/**
 * dsh-wechat-media - lead collection: the query builder, the de-duplicator, the contact extractor and the scorer.
 *
 * Why this module exists: the plugin could already *drive* a browser (`browser_flow`, `browser_maps_places`) and
 * already had messaging tools, but nothing turned "给我找德国做户外家具的进口商" into a usable list. Writing that as a
 * prompt loop works once and then drifts: the same company comes back twice under two names, a directory page ranks
 * above every real company, and "found it" gets confused with "it is a buyer".
 *
 * The method here is deliberately narrow and boring, because each piece is checkable on its own:
 *
 *  1. **A search term is a recall hint, not proof.** Role words (importer / wholesaler / distributor / 进口商) widen
 *     the net; the verdict comes later from the site itself - contacts, and evidence that it trades in this product.
 *  2. **Never trust one page of results.** A single SERP is dominated by directories; pages are walked until the
 *     budget or the hit target is reached, and a captcha stops the run instead of burning the address.
 *  3. **De-duplicate on two axes at once.** The same company is "ACME GmbH", "Acme GmbH" and "acme.de"; normalising the
 *     name without punctuation catches the first two, and the registrable host catches the third.
 *  4. **Score with reasons, never a bare number.** A lead at 60 with "has email, no contact page" is actionable; a
 *     lead at 60 with no reasons is a mystery nobody can audit.
 *
 * Everything here is pure: no browser, no network, no filesystem. The caller injects an adapter, which is what makes
 * the pipeline testable without a live page.
 */

/** Directory / marketplace hosts: high in search results, never the company itself. */
const DIRECTORY_HOSTS = [
  "alibaba.com", "aliexpress.com", "amazon.", "ebay.", "etsy.com", "indiamart.com", "made-in-china.com",
  "globalsources.com", "tradekey.com", "ec21.com", "kompass.com", "europages.", "yellowpages.", "yelp.",
  "wikipedia.org", "wikiwand.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com",
  "linkedin.com", "pinterest.com", "tiktok.com", "reddit.com", "quora.com", "medium.com", "blogspot.com",
  "wordpress.com", "wix.com", "shopify.com", "trustpilot.com", "crunchbase.com", "bloomberg.com", "zoominfo.com",
  "dnb.com", "opencorporates.com", "companieshouse.gov.uk", "handelsregister.de", "northdata.de", "unternehmen24.info",
  "google.", "bing.com", "duckduckgo.com", "baidu.com", "yandex.", "wikipedia.", "zhihu.com", "baike.baidu.com",
  "10100.com", "beiei.com", "sohu.com", "163.com", "qq.com", "sina.com", "toutiao.com", "b2b168.com", "hc360.com",
  "china.cn", "chinabidding.com", "tradeindia.com", "exportersindia.com", "go4worldbusiness.com",
];

/** Postal / generic mailboxes that are worth keeping but score lower than a named human or sales address. */
const GENERIC_MAILBOX = /^(info|kontakt|contact|sales|office|hello|mail|service|support|vertrieb|anfrage|enquiry|inquiry)@/i;

/** Local-language role words, so the net is not English-only. */
const ROLE_WORDS = {
  en: ["importer", "wholesaler", "distributor", "dealer", "reseller", "supplier", "brand owner", "private label", "retailer"],
  de: ["importeur", "großhandel", "grosshandel", "händler", "handler", "distributor", "fachhandel", "hersteller"],
  fr: ["importateur", "grossiste", "distributeur", "revendeur"],
  es: ["importador", "mayorista", "distribuidor", "revendedor"],
  it: ["importatore", "grossista", "distributore", "rivenditore"],
  nl: ["importeur", "groothandel", "distributeur", "wederverkoper"],
  ru: ["импортер", "оптовик", "дистрибьютор"],
  ar: ["مستورد", "تاجر الجملة", "موزع"],
};

/** Market → the language whose role words are worth appending, and a TLD hint for scoring. */
const MARKETS = {
  de: { lang: "de", tld: [".de", ".at", ".ch"], label: "德国" },
  uk: { lang: "en", tld: [".co.uk", ".uk"], label: "英国" },
  us: { lang: "en", tld: [".us", ".com"], label: "美国" },
  fr: { lang: "fr", tld: [".fr", ".be"], label: "法国" },
  es: { lang: "es", tld: [".es"], label: "西班牙" },
  it: { lang: "it", tld: [".it"], label: "意大利" },
  nl: { lang: "nl", tld: [".nl", ".be"], label: "荷兰" },
  ru: { lang: "ru", tld: [".ru"], label: "俄罗斯" },
  ae: { lang: "ar", tld: [".ae"], label: "阿联酋" },
};

/** The market a person named, or none of the above. Accepts the code, the Chinese label, or a raw country name. */
export function resolveMarket(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (MARKETS[text]) return { code: text, ...MARKETS[text] };
  for (const [code, spec] of Object.entries(MARKETS)) {
    if (spec.label === text || spec.tld.some((tld) => tld === `.${text}`)) return { code, ...spec };
  }
  return { code: text, lang: "en", tld: [], label: text };
}

/**
 * Search terms for one goal.
 *
 * Two per role word, not one: `"<goal>" <role>` finds pages that describe themselves that way, `<goal> <role> <market>`
 * finds ones that also name the market. The cap matters - 40 queries against one engine is a captcha, and the first
 * few carry almost all the recall.
 */
export function leadQueries({ goal = "", market = "", max = 8 } = {}) {
  const wanted = String(goal ?? "").trim();
  if (!wanted) return [];
  const resolved = resolveMarket(market);
  const roles = ROLE_WORDS[resolved?.lang ?? "en"] ?? ROLE_WORDS.en;
  const english = ROLE_WORDS.en;
  const out = [];
  for (const role of roles) out.push(`${wanted} ${role}`);
  for (const role of english) out.push(`${wanted} ${role} ${resolved?.label ?? ""}`.trim());
  const seen = new Set();
  return out
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query) => {
      const key = query.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(20, Number(max) || 8)));
}

/** Lowercase, strip everything that is not a letter or digit - so "ACME GmbH & Co. KG" and "acme gmbh co kg" meet. */
export function normalizeCompany(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** The host a lead's website lives on, without `www.` - the de-duplication key that survives a rename. */
export function hostOf(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** True for a host that is a marketplace, directory, social network or search engine - never a company's own site. */
export function isDirectoryHost(host) {
  const value = String(host ?? "").toLowerCase();
  if (!value) return true;
  return DIRECTORY_HOSTS.some((entry) => (entry.endsWith(".") ? value.includes(entry) || value.startsWith(entry) : value === entry || value.endsWith(`.${entry}`)));
}

/**
 * Email addresses out of page text, filtered for the noise every site carries.
 *
 * The filters are all measured failures from real pages: `logo@2x.png` (an asset name that matches the shape),
 * `name@example.com` (a placeholder in a template), `@sentry.io` / `@wixpress.com` (the site builder's own address),
 * and `u003e@` (JSON-escaped markup).
 */
export function extractEmails(text, { max = 6 } = {}) {
  const source = String(text ?? "").replace(/\\u003[cde]/gi, " ");
  const found = source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  const noise = /\.(png|jpg|jpeg|gif|webp|svg|css|js|woff2?)$/i;
  const banned = /@(example|domain|email|mail|yourdomain|sentry|wixpress|squarespace|godaddy|shopify|cloudflare|wordpress|sentry\.io|2x|3x)\./i;
  // Encoding artefacts: an HTML entity or a JSON escape that survived into the text looks exactly like a mailbox.
  const artefact = /^(u00[0-9a-f]{2}|gt|lt|amp|quot|nbsp|#\d+)$/i;
  const out = [];
  for (const raw of found) {
    const email = raw.replace(/[.,;:]+$/, "").toLowerCase();
    if (noise.test(email) || banned.test(email)) continue;
    if (artefact.test(email.split("@")[0])) continue;
    if (email.length > 80) continue;
    if (!out.includes(email)) out.push(email);
    if (out.length >= max) break;
  }
  return out;
}

/** Phone numbers, international shape only - a bare 5-digit number is a postcode, not a contact. */
export function extractPhones(text, { max = 4 } = {}) {
  const source = String(text ?? "");
  const found = source.match(/(?:\+|00)\s?\d[\d\s()./-]{6,20}\d/g) ?? [];
  const out = [];
  for (const raw of found) {
    const phone = raw.replace(/\s+/g, " ").trim();
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 16) continue;
    if (!out.includes(phone)) out.push(phone);
    if (out.length >= max) break;
  }
  return out;
}

/** Social / messaging handles a salesperson can actually use. */
export function extractSocials(text, { max = 4 } = {}) {
  const source = String(text ?? "");
  const patterns = [
    ["whatsapp", /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^\s"'<>]+/gi],
    ["linkedin", /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>]+/gi],
    ["facebook", /https?:\/\/(?:[a-z]{2,3}\.)?facebook\.com\/[^\s"'<>]+/gi],
    ["instagram", /https?:\/\/(?:[a-z]{2,3}\.)?instagram\.com\/[^\s"'<>]+/gi],
  ];
  const out = [];
  for (const [kind, pattern] of patterns) {
    const match = source.match(pattern);
    if (match) out.push({ kind, url: match[0].replace(/[.,;:]+$/, "") });
    if (out.length >= max) break;
  }
  return out;
}

/** Links on a page that look like the contact / about / imprint page, most specific first. */
export function contactLinks(links, { max = 3 } = {}) {
  const wanted = /(kontakt|contact|impressum|imprint|about|uber-uns|ueber-uns|company|legal-notice|reach-us|enquir)/i;
  const scored = [];
  for (const link of Array.isArray(links) ? links : []) {
    const href = String(link?.href ?? "").trim();
    const label = `${link?.text ?? ""} ${href}`;
    if (!href || !/^https?:/i.test(href)) continue;
    if (!wanted.test(label)) continue;
    const weight = /kontakt|contact|impressum|imprint/i.test(label) ? 2 : 1;
    scored.push({ href, weight });
  }
  scored.sort((a, b) => b.weight - a.weight);
  const out = [];
  for (const entry of scored) if (!out.includes(entry.href)) out.push(entry.href);
  return out.slice(0, max);
}

/**
 * Score one lead, with the reasons attached.
 *
 * The weights say what a salesperson cares about: a reachable person beats a beautiful website, and evidence of
 * trading in the product beats both. Nothing here is a model call - a score you cannot explain is a score you cannot
 * defend in a meeting.
 */
/**
 * Words that say "this company trades, it does not make".
 *
 * The distinction a salesperson needs is not "does it mention furniture" but "is it a buyer or a competitor". A
 * manufacturer's page is full of the same product words as an importer's, and ranks just as well - measured: a run
 * for German outdoor furniture returned a Chinese *exporter* at the top with a perfect score, because every signal
 * the scorer had (email, phone, contact page, product words) was satisfied by a seller.
 *
 * Weights, not just hits: "we are a manufacturer" is a different statement from the noun "manufacturer" appearing in a
 * footer, and "import and export" is a trader's phrase rather than a maker's.
 */
/**
 * Titles that name a directory, a marketplace or a data vendor rather than a company.
 *
 * Host blocklists lose this fight: the same aggregator rotates domains, and "Global Import Export Trade Data Provider
 * of 100+ Countries" arrived as a lead at score 0 - it was filtered by score, not by knowing what it was. The title is
 * the honest signal, because that is exactly what the page says about itself.
 */
export const JUNK_TITLE = /marketplace|b2b\b|trade data|import export data|customs data|directory|yellow ?pages|suppliers? (?:list|directory|network)|business directory|company list|黄页|名录|数据平台|企业库/i;

const ROLE_SIGNALS = {
  buyer: [
    [/we (?:are|r) (?:an? )?(?:importer|distributor|wholesaler|retailer)/i, 4],
    [/(?:importer|importateur|importador|importeur|importatore)\s*(?:and|&|und|et|y)\s*(?:distributor|wholesaler|großhändler|grosshandler)/i, 4],
    [/\b(?:importer|importers|importeur|importeure|importateur|importador|importatore|импорт[её]р)\b/i, 3],
    [/\b(?:distributor|distributors|distributeur|distribuidor|distributore|großhändler|grosshandler|groothandel|wholesaler|wholesale distributor)\b/i, 3],
    [/\b(?:dealer|dealers|retailer|retailers|reseller|resellers|fachhändler|fachhandel|händler|rivenditore|revendeur)\b/i, 2],
    [/\b(?:we (?:import|buy|purchase)|einkauf|einkäufer|procurement|purchasing|sourcing|buying (?:department|office|team))\b/i, 3],
    [/\b(?:brand owner|private label|own brand|handelsmarke|eigenmarke)\b/i, 2],
    [/进口商|进口公司|经销商|代理商|批发商|采购/, 3],
  ],
  seller: [
    [/\b(?:we are|we're) (?:a |an )?(?:manufacturer|factory|producer|maker)\b/i, 5],
    [/\bour (?:own )?factory\b/i, 5],
    [/\b(?:oem|odm)\b/i, 4],
    [/\b(?:manufacturer|manufactory|hersteller|produzent|fabrik|fabricant|fabricante|fabbricante|производитель)\b/i, 3],
    [/\b(?:exporter|exporters|exporteur|exportateur|exportador|esportatore)\b/i, 4],
    [/\b(?:(?:we|our company) export|export(?:ing)? (?:to|worldwide)|made in china|中国制造|出口商|制造商|工厂|厂家|生产商)\b/i, 4],
    [/\b(?:supplier|suppliers|lieferant|proveedor|fornitore|поставщик)\b/i, 2],
    [/\b(?:production capacity|production line|assembly line|mass production)\b/i, 3],
  ],
};

/**
 * Decide whether a page reads like a buyer, a seller, or neither.
 *
 * Deliberately conservative: "unclear" is a legitimate answer and far better than a confident wrong one. The collector
 * is allowed to hand a person a list they still have to judge; it is not allowed to call an exporter a customer.
 */
export function classifyRole(text) {
  const haystack = String(text ?? "");
  let buyer = 0;
  let seller = 0;
  const buyerEvidence = [];
  const sellerEvidence = [];
  for (const [pattern, weight] of ROLE_SIGNALS.buyer) {
    const match = haystack.match(pattern);
    if (!match) continue;
    buyer += weight;
    if (buyerEvidence.length < 4) buyerEvidence.push(match[0].trim().slice(0, 40));
  }
  for (const [pattern, weight] of ROLE_SIGNALS.seller) {
    const match = haystack.match(pattern);
    if (!match) continue;
    seller += weight;
    if (sellerEvidence.length < 4) sellerEvidence.push(match[0].trim().slice(0, 40));
  }
  const role = buyer > seller + 1 ? "buyer" : seller > buyer + 1 ? "seller" : "unclear";
  return {
    role,
    buyerWeight: buyer,
    sellerWeight: seller,
    evidence: role === "buyer" ? buyerEvidence : role === "seller" ? sellerEvidence : [...buyerEvidence, ...sellerEvidence].slice(0, 4),
  };
}

export function scoreLead(lead, { goal = "", market = "" } = {}) {
  const reasons = [];
  let score = 0;
  const emails = Array.isArray(lead.emails) ? lead.emails : [];
  const phones = Array.isArray(lead.phones) ? lead.phones : [];
  const socials = Array.isArray(lead.socials) ? lead.socials : [];
  const haystack = `${lead.title ?? ""} ${lead.text ?? ""} ${lead.url ?? ""}`.toLowerCase();
  const words = String(goal ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 2);

  if (emails.length) {
    const named = emails.some((email) => !GENERIC_MAILBOX.test(email));
    score += named ? 25 : 20;
    reasons.push(named ? `有具体邮箱（${emails[0]}）` : `有通用邮箱（${emails[0]}）`);
  } else {
    reasons.push("没有邮箱");
  }
  if (phones.length) { score += 15; reasons.push(`有电话（${phones[0]}）`); }
  if (socials.length) { score += 10; reasons.push(`有 ${socials.map((s) => s.kind).join("/")}`); }
  if (lead.contactPage) { score += 10; reasons.push("有联系/关于页"); }

  const matched = words.filter((word) => haystack.includes(word));
  if (matched.length) { score += Math.min(20, 8 + matched.length * 4); reasons.push(`正文命中：${matched.slice(0, 3).join("、")}`); }

  // Role evidence replaces the old "any role word is good" rule: a seller's page is full of role words too, and the
  // only thing that separates a lead from a competitor is *which* role the words describe.
  const role = classifyRole(`${lead.title ?? ""} ${lead.text ?? ""}`);
  if (role.role === "buyer") {
    score += 15;
    reasons.push(`像买家：${role.evidence.slice(0, 2).join("、")}`);
  } else if (role.role === "seller") {
    score -= 25;
    reasons.push(`像卖家/同行：${role.evidence.slice(0, 2).join("、")}`);
  } else if (role.evidence.length) {
    reasons.push(`角色不明：${role.evidence.slice(0, 2).join("、")}`);
  }

  const resolved = resolveMarket(market);
  if (resolved) {
    const host = hostOf(lead.url);
    const tldHit = resolved.tld.some((tld) => host.endsWith(tld));
    const textHit = resolved.lang !== "en" && (ROLE_WORDS[resolved.lang] ?? []).some((word) => haystack.includes(word.toLowerCase()));
    if (tldHit || textHit) { score += 10; reasons.push(tldHit ? `市场域名 ${resolved.tld[0]}` : `当地语言内容`); }
  }
  if (/\b(ust\.?-?id|vat|steuernummer|handelsregister|siret|partita iva|cvr)\b/i.test(haystack)) { score += 10; reasons.push("有工商/税号信息（可验证主体）"); }

  return { score: Math.max(0, Math.min(100, score)), reasons, role: role.role, roleEvidence: role.evidence };
}

/** One CSV line per lead, quoted the way a spreadsheet expects. */
export function leadCsv(rows) {
  const columns = ["公司", "网址", "国家", "邮箱", "电话", "社媒", "分数", "理由", "来源查询", "抓取时间"];
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) {
    lines.push([
      row.company, row.url, row.market,
      (row.emails ?? []).join(" "), (row.phones ?? []).join(" "),
      (row.socials ?? []).map((s) => `${s.kind}:${s.url}`).join(" "),
      row.score, (row.reasons ?? []).join("；"), row.query, row.at,
    ].map(escape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Merge a new lead into the store, replacing on host match and adding otherwise. Returns `{ store, added, merged }`. */
export function mergeLead(store, lead) {
  const rows = Array.isArray(store) ? [...store] : [];
  const host = hostOf(lead?.url);
  const name = normalizeCompany(lead?.company);
  const index = rows.findIndex((row) => (host && hostOf(row.url) === host) || (name && normalizeCompany(row.company) === name));
  if (index >= 0) {
    const previous = rows[index];
    rows[index] = {
      ...previous,
      ...lead,
      emails: [...new Set([...(previous.emails ?? []), ...(lead.emails ?? [])])].slice(0, 6),
      phones: [...new Set([...(previous.phones ?? []), ...(lead.phones ?? [])])].slice(0, 4),
      socials: [...(previous.socials ?? []), ...(lead.socials ?? [])].slice(0, 4),
      score: Math.max(Number(previous.score) || 0, Number(lead.score) || 0),
      reasons: [...new Set([...(previous.reasons ?? []), ...(lead.reasons ?? [])])],
    };
    return { store: rows, added: false, merged: true };
  }
  rows.push(lead);
  return { store: rows, added: true, merged: false };
}

/**
 * Run the pipeline against an injected adapter.
 *
 * The adapter is two functions - `search(query, pageIndex)` returning SERP rows, and `visit(url)` returning a page
 * snapshot - which is what lets the same pipeline run against the real browser, a fixture in a test, or a cached
 * capture. Nothing in this function knows what a browser is.
 *
 * @param {object} options
 * @param {(query: string, page: number) => Promise<Array<{title?: string, url?: string, snippet?: string}>>} options.search
 * @param {(url: string) => Promise<{url: string, title?: string, text?: string, links?: Array<{href: string, text?: string}>}>} options.visit
 */
export async function collectLeads({
  goal = "",
  market = "",
  limit = 10,
  sources = ["search"],
  queries = [],
  search = async () => [],
  visit = async () => ({ url: "", text: "", links: [] }),
  store = [],
  onProgress = () => {},
  maxSearches = 4,
  maxPagesPerQuery = 1,
  deadlineMs = 180000,
  stepTimeoutMs = 12000,
  maxConsecutiveTimeouts = 3,
  buyerOnly = false,
  minScore = 20,
} = {}) {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > deadlineMs;

  /**
   * Run one adapter call under a budget.
   *
   * Measured: a page that never finishes loading leaves the transport's own ceiling to fire, and one live run spent
   * ~5 minutes per company - 25 minutes for five leads, long enough that the tool call itself was killed. The budget
   * belongs here rather than in the caller because this is the layer that knows a step is optional.
   */
  const withinBudget = (promise, what) => new Promise((resolveStep, rejectStep) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`${what} 超时 ${Math.round(stepTimeoutMs / 1000)}s`);
      error.timeout = true;
      rejectStep(error);
    }, stepTimeoutMs);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStep(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectStep(error);
    });
  });
  let timeoutsInARow = 0;
  const noteTimeout = (timedOut) => {
    timeoutsInARow = timedOut ? timeoutsInARow + 1 : 0;
    return timeoutsInARow;
  };
  let bridgeDead = false;
  const wanted = String(goal ?? "").trim();
  if (!wanted) throw new Error("collect_leads 需要一个目标，例如 goal=\"户外家具 进口商\"");
  const target = Math.max(1, Math.min(200, Number(limit) || 10));
  const terms = (Array.isArray(queries) && queries.length ? queries.map(String) : leadQueries({ goal: wanted, market, max: maxSearches })).slice(0, maxSearches);

  const seenHosts = new Set((Array.isArray(store) ? store : []).map((row) => hostOf(row?.url)).filter(Boolean));
  const candidates = [];
  const skipped = [];
  let searches = 0;

  for (const term of terms) {
    if (outOfTime()) break;
    for (let page = 0; page < maxPagesPerQuery; page += 1) {
      if (outOfTime()) break;
      let rows = [];
      try {
        rows = await withinBudget(search(term, page), "搜索");
        noteTimeout(false);
      } catch (error) {
        onProgress({ stage: "search", query: term, page, error: String(error?.message ?? error) });
        if (error?.timeout && noteTimeout(true) >= maxConsecutiveTimeouts) { bridgeDead = true; break; }
        continue;
      }
      searches += 1;
      onProgress({ stage: "search", query: term, page, results: rows.length });
      let fresh = 0;
      for (const row of rows) {
        const host = hostOf(row?.url);
        if (!host) continue;
        if (isDirectoryHost(host)) { skipped.push(host); continue; }
        if (row?.title && JUNK_TITLE.test(String(row.title))) { skipped.push(`marketplace:${host}`); continue; }
        if (seenHosts.has(host)) continue;
        seenHosts.add(host);
        candidates.push({ url: `https://${host}`, host, title: row?.title ?? "", snippet: row?.snippet ?? "", query: term });
        fresh += 1;
        if (candidates.length >= target * 3) break;
      }
      if (!fresh && page > 0) break;
      if (candidates.length >= target * 3) break;
    }
    if (candidates.length >= target * 3) break;
  }

  const leads = [];
  let merged = 0;
  let current = Array.isArray(store) ? [...store] : [];

  let stopped = "";
  for (const candidate of candidates) {
    if (leads.length >= target) break;
    if (outOfTime()) { stopped = "deadline"; break; }
    onProgress({ stage: "visit", url: candidate.url, collected: leads.length, of: target });
    let page = { url: candidate.url, title: candidate.title, text: "", links: [] };
    try {
      page = await withinBudget(visit(candidate.url), "打开站点");
      noteTimeout(false);
    } catch (error) {
      onProgress({ stage: "visit", url: candidate.url, error: String(error?.message ?? error) });
      if (error?.timeout && noteTimeout(true) >= maxConsecutiveTimeouts) { bridgeDead = true; stopped = "bridge"; break; }
      continue;
    }
    let text = String(page?.text ?? "");
    let contactPage = "";
    const contacts = contactLinks(page?.links);
    if (contacts.length) {
      contactPage = contacts[0];
      try {
        const extra = await withinBudget(visit(contactPage), "打开联系页");
        text += `\n${String(extra?.text ?? "")}`;
      } catch { /* a dead contact page still leaves the homepage evidence */ }
    }
    const title = String(page?.title ?? candidate.title ?? "");
    // The company name is the title without the marketing tail every site appends: "ACME GmbH | Outdoor furniture".
    const company = title.split(/\s[|–—·:]\s|\s\|\s/)[0].trim().slice(0, 80) || candidate.host;
    const base = {
      company, url: candidate.url, market: String(market ?? ""),
      title, text: text.slice(0, 4000),
      emails: extractEmails(text), phones: extractPhones(text), socials: extractSocials(text),
      contactPage, query: candidate.query, at: new Date().toISOString(),
    };
    const { score, reasons, role, roleEvidence } = scoreLead(base, { goal: wanted, market });
    const lead = { ...base, score, reasons, role, roleEvidence };
    delete lead.text;
    // `buyerOnly` drops the companies whose own page says they make or export the thing - the single biggest source of
    // wasted outreach, and the one thing a keyword search cannot tell you.
    if (buyerOnly && role === "seller") {
      onProgress({ stage: "skip-seller", url: candidate.url, evidence: roleEvidence });
      continue;
    }
    if (minScore && score < minScore) {
      onProgress({ stage: "drop-low", url: candidate.url, score });
      continue;
    }
    const result = mergeLead(current, lead);
    current = result.store;
    if (result.added) leads.push(lead); else merged += 1;
  }

  if (!stopped && bridgeDead) stopped = "bridge";
  return { goal: wanted, market, queries: terms, searches, candidates: candidates.length, leads, merged, stopped, elapsedMs: Date.now() - started, buyerOnly, minScore, skipped: [...new Set(skipped)].slice(0, 20), store: current };
}

/**
 * Bing's server-rendered result page -> rows.
 *
 * Parsing HTML instead of driving a browser is a deliberate trade: the collector needs no login, and a plain `fetch`
 * answers in ~200 ms where the extension bridge costs seconds per command (and, measured, sometimes never answers at
 * all - 45 s then a timeout, which is how a run ends with "0 results" and no error). Bing still ships the results
 * inside `li.b_algo` for non-JavaScript clients, so the data is there without a renderer.
 */
export function parseBingSerp(html, { max = 20 } = {}) {
  const source = String(html ?? "");
  const out = [];
  const blocks = source.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = decodeBingLink(anchor[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = htmlToText(anchor[2]).slice(0, 140);
    const snippet = htmlToText(block.replace(/<h2[\s\S]*?<\/h2>/i, "")).slice(0, 300);
    if (!out.some((row) => row.url === url)) out.push({ title, url, snippet });
    if (out.length >= max) break;
  }
  return out;
}

/** Bing sometimes wraps outbound links in `/ck/a?...&u=a1<base64url>`; unwrap it rather than claiming a bing URL. */
export function decodeBingLink(href) {
  const raw = String(href ?? "").replace(/&amp;/g, "&");
  if (!/\/ck\/a\?/i.test(raw)) return raw;
  const match = raw.match(/[?&]u=a1([^&]+)/i);
  if (!match) return raw;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : raw;
  } catch { return raw; }
}

/** Rough but dependency-free: drop the parts a reader never sees, then flatten the rest to one line. */
export function htmlToText(html, { max = 20000 } = {}) {
  const source = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
  return source.replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, max);
}

/** Every anchor on a page, absolute and de-duplicated - the input the contact-page picker needs. */
export function htmlLinks(html, baseUrl = "", { max = 400 } = {}) {
  const source = String(html ?? "");
  const out = [];
  const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const raw = String(match[1] ?? "").replace(/&amp;/g, "&").trim();
    if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let absolute = raw;
    try { absolute = new URL(raw, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(absolute)) continue;
    const text = htmlToText(match[2]).slice(0, 80);
    if (out.some((link) => link.href === absolute)) continue;
    out.push({ href: absolute, text });
    if (out.length >= max) break;
  }
  return out;
}

/** One page snapshot, in the shape the collector's `visit` adapter promises. */
export function pageFromHtml(html, url = "") {
  const source = String(html ?? "");
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    url,
    title: titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : "",
    text: htmlToText(source),
    links: htmlLinks(source, url),
  };
}