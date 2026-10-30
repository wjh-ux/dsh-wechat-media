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

  const roleHits = [];
  for (const list of Object.values(ROLE_WORDS)) for (const role of list) if (haystack.includes(role.toLowerCase())) roleHits.push(role);
  if (roleHits.length) { score += Math.min(15, 6 + roleHits.length * 3); reasons.push(`角色词：${[...new Set(roleHits)].slice(0, 3).join("、")}`); }

  const resolved = resolveMarket(market);
  if (resolved) {
    const host = hostOf(lead.url);
    const tldHit = resolved.tld.some((tld) => host.endsWith(tld));
    const textHit = resolved.lang !== "en" && (ROLE_WORDS[resolved.lang] ?? []).some((word) => haystack.includes(word.toLowerCase()));
    if (tldHit || textHit) { score += 10; reasons.push(tldHit ? `市场域名 ${resolved.tld[0]}` : `当地语言内容`); }
  }
  if (/\b(ust\.?-?id|vat|steuernummer|handelsregister|siret|partita iva|cvr)\b/i.test(haystack)) { score += 10; reasons.push("有工商/税号信息（可验证主体）"); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
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
} = {}) {
  const wanted = String(goal ?? "").trim();
  if (!wanted) throw new Error("collect_leads 需要一个目标，例如 goal=\"户外家具 进口商\"");
  const target = Math.max(1, Math.min(200, Number(limit) || 10));
  const terms = (Array.isArray(queries) && queries.length ? queries.map(String) : leadQueries({ goal: wanted, market, max: maxSearches })).slice(0, maxSearches);

  const seenHosts = new Set((Array.isArray(store) ? store : []).map((row) => hostOf(row?.url)).filter(Boolean));
  const candidates = [];
  const skipped = [];
  let searches = 0;

  for (const term of terms) {
    for (let page = 0; page < maxPagesPerQuery; page += 1) {
      let rows = [];
      try {
        rows = await search(term, page);
      } catch (error) {
        onProgress({ stage: "search", query: term, page, error: String(error?.message ?? error) });
        continue;
      }
      searches += 1;
      onProgress({ stage: "search", query: term, page, results: rows.length });
      let fresh = 0;
      for (const row of rows) {
        const host = hostOf(row?.url);
        if (!host) continue;
        if (isDirectoryHost(host)) { skipped.push(host); continue; }
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

  for (const candidate of candidates) {
    if (leads.length >= target) break;
    onProgress({ stage: "visit", url: candidate.url, collected: leads.length, of: target });
    let page = { url: candidate.url, title: candidate.title, text: "", links: [] };
    try {
      page = await visit(candidate.url);
    } catch (error) {
      onProgress({ stage: "visit", url: candidate.url, error: String(error?.message ?? error) });
      continue;
    }
    let text = String(page?.text ?? "");
    let contactPage = "";
    const contacts = contactLinks(page?.links);
    if (contacts.length) {
      contactPage = contacts[0];
      try {
        const extra = await visit(contactPage);
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
    const { score, reasons } = scoreLead(base, { goal: wanted, market });
    const lead = { ...base, score, reasons };
    delete lead.text;
    const result = mergeLead(current, lead);
    current = result.store;
    if (result.added) leads.push(lead); else merged += 1;
  }

  return { goal: wanted, market, queries: terms, searches, candidates: candidates.length, leads, merged, skipped: [...new Set(skipped)].slice(0, 20), store: current };
}
