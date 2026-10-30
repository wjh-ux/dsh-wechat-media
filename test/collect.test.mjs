// The collector is the one part of this plugin whose output a salesperson acts on, so the properties that matter are
// pinned here rather than discovered in production: a directory must never become a lead, the same company must not
// arrive twice under two spellings, and a score must come with the reasons that produced it.
import assert from "node:assert/strict";

import {
  collectLeads,
  contactLinks,
  extractEmails,
  extractPhones,
  hostOf,
  isDirectoryHost,
  leadQueries,
  mergeLead,
  normalizeCompany,
  resolveMarket,
  classifyRole,
  scoreLead,
} from "../collect.js";

const passed = [];
const failed = [];
function test(name, fn) {
  try { const out = fn(); if (out && typeof out.then === "function") throw new Error("test must be synchronous unless awaited"); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}
async function testAsync(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

test("the market decides which role words are searched", () => {
  assert.equal(resolveMarket("德国").lang, "de");
  const queries = leadQueries({ goal: "户外家具", market: "de", max: 3 });
  assert.equal(queries.length, 3);
  assert.match(queries[0], /importeur|großhandel|grosshandel|händler/);
});

test("a company name de-duplicates regardless of punctuation and case", () => {
  assert.equal(normalizeCompany("ACME GmbH & Co. KG"), normalizeCompany("acme gmbh co kg"));
  assert.equal(normalizeCompany("Müller & Söhne"), normalizeCompany("Muller Sohne"));
});

test("the host is the second de-duplication axis, without www", () => {
  assert.equal(hostOf("https://www.Acme.de/kontakt"), "acme.de");
  assert.equal(hostOf("acme.de"), "acme.de");
  assert.equal(hostOf(""), "");
});

test("marketplaces and directories are never a company's own site", () => {
  for (const host of ["www.alibaba.com", "de.alibaba.com", "amazon.de", "linkedin.com", "europages.co.uk", "www.bing.com"]) {
    assert.equal(isDirectoryHost(host), true, host);
  }
  assert.equal(isDirectoryHost("acme-outdoor.de"), false);
});

test("asset names, template placeholders and builder addresses are not contacts", () => {
  const page = "info@acme.de sales@acme.de logo@2x.png name@example.com x@wixpress.com u003e@acme.de";
  assert.deepEqual(extractEmails(page), ["info@acme.de", "sales@acme.de"]);
});

test("a five-digit number is a postcode, not a phone", () => {
  assert.deepEqual(extractPhones("PLZ 10115, Tel. +49 30 1234567"), ["+49 30 1234567"]);
});

test("the contact page is preferred over the about page", () => {
  const links = [
    { href: "https://acme.de/about", text: "About us" },
    { href: "https://acme.de/kontakt", text: "Kontakt" },
    { href: "https://acme.de/products", text: "Products" },
  ];
  assert.deepEqual(contactLinks(links), ["https://acme.de/kontakt", "https://acme.de/about"]);
});

test("a score always carries the reasons that produced it", () => {
  const { score, reasons } = scoreLead(
    {
      url: "https://acme-outdoor.de", title: "ACME GmbH",
      text: "Wir sind Importeur und Großhandel für Outdoor-Möbel. USt-IdNr DE123456789",
      emails: ["info@acme-outdoor.de"], phones: ["+49 30 1234567"], socials: [{ kind: "whatsapp", url: "https://wa.me/49" }],
      contactPage: "https://acme-outdoor.de/kontakt",
    },
    { goal: "outdoor furniture", market: "de" },
  );
  assert.ok(score >= 70, `expected a strong lead, got ${score}`);
  assert.ok(reasons.length >= 4);
  assert.ok(reasons.some((reason) => reason.includes("邮箱")));
  assert.ok(reasons.some((reason) => reason.includes(".de")));
});

test("merging is idempotent: the same host twice does not become two leads", () => {
  const first = { company: "ACME GmbH", url: "https://acme.de", emails: ["info@acme.de"], score: 60, reasons: ["有邮箱"] };
  const one = mergeLead([], first);
  assert.equal(one.added, true);
  const two = mergeLead(one.store, { company: "Acme GmbH", url: "https://www.acme.de", emails: ["sales@acme.de"], score: 70, reasons: ["有电话"] });
  assert.equal(two.added, false);
  assert.equal(two.store.length, 1);
  assert.deepEqual(two.store[0].emails, ["info@acme.de", "sales@acme.de"]);
  assert.equal(two.store[0].score, 70);
});

await testAsync("the pipeline skips directories, collapses duplicates and keeps the contacts", async () => {
  const visits = [];
  const search = async (query) => [
    { title: "Alibaba outdoor furniture", url: "https://www.alibaba.com/showroom/outdoor.html" },
    { title: "ACME Outdoor", url: "https://acme-outdoor.de", snippet: "Outdoor-Möbel Großhandel" },
    { title: "ACME again", url: "https://www.acme-outdoor.de/ueber-uns", snippet: "Über uns" },
    { title: "Bergmann Garten", url: "https://bergmann-garten.de", snippet: "Gartenmöbel Importeur" },
  ];
  const visit = async (url) => {
    visits.push(url);
    if (url.includes("acme")) {
      return {
        url, title: "ACME Outdoor GmbH | Outdoor-Möbel",
        text: "ACME Outdoor GmbH. Importeur und Großhandel. info@acme-outdoor.de +49 30 1234567",
        links: [{ href: "https://acme-outdoor.de/kontakt", text: "Kontakt" }],
      };
    }
    return { url, title: "Bergmann Garten", text: "Gartenmöbel. kontakt@bergmann-garten.de", links: [] };
  };
  const result = await collectLeads({ goal: "outdoor furniture", market: "de", limit: 5, search, visit, maxSearches: 1, maxPagesPerQuery: 1, queries: ["outdoor moebel importeur"] });
  assert.equal(result.leads.length, 2, "one directory filtered, one duplicate collapsed");
  assert.ok(!result.leads.some((lead) => lead.url.includes("alibaba")));
  assert.ok(result.skipped.includes("alibaba.com"));
  const acme = result.leads.find((lead) => lead.url.includes("acme"));
  assert.deepEqual(acme.emails, ["info@acme-outdoor.de"]);
  assert.equal(acme.contactPage, "https://acme-outdoor.de/kontakt");
  assert.ok(visits.some((url) => url.endsWith("/kontakt")), "the contact page is fetched, not just linked");
});

await testAsync("a page that never answers is abandoned, not waited on", async () => {
  const search = async () => [{ title: "Slow Co", url: "https://slow.example.co" }, { title: "Fast Co", url: "https://fast.example.co" }];
  const visit = async (url) => {
    if (url.includes("slow")) return new Promise(() => {});
    return { url, title: "Fast Co", text: "hello@fast.example.co", links: [] };
  };
  const started = Date.now();
  const result = await collectLeads({ goal: "widgets", limit: 2, search, visit, queries: ["widgets"], maxSearches: 1, stepTimeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(result.leads.length, 1, "the fast company is still collected");
  assert.ok(elapsed < 3000, `the hung page must not cost more than the budget (took ${elapsed}ms)`);
});

await testAsync("three timeouts in a row stop the run and name the browser as the problem", async () => {
  const search = async () => [
    { title: "A", url: "https://a.example.co" }, { title: "B", url: "https://b.example.co" }, { title: "C", url: "https://c.example.co" },
  ];
  const visit = async () => new Promise(() => {});
  const result = await collectLeads({ goal: "widgets", limit: 3, search, visit, queries: ["widgets"], maxSearches: 1, stepTimeoutMs: 200, maxConsecutiveTimeouts: 3 });
  assert.equal(result.stopped, "bridge");
  assert.equal(result.leads.length, 0);
});
test("an exporter is not a buyer, however many product words it shares", () => {
  const seller = classifyRole("We are a manufacturer with our own factory in Foshan. OEM and ODM services, production capacity 20000 pcs/month. We export to Europe.");
  assert.equal(seller.role, "seller");
  const buyer = classifyRole("Wir sind Importeur und Großhandel für Outdoor-Möbel. Einkauf und Vertrieb unter einem Dach.");
  assert.equal(buyer.role, "buyer");
  const unclear = classifyRole("Gartenmöbel. Schöne Dinge für draußen.");
  assert.equal(unclear.role, "unclear", "no role evidence must stay unclear rather than guess");
});

test("the role moves the score in the right direction", () => {
  const base = { url: "https://x.de", title: "X", emails: ["info@x.de"], phones: [], socials: [], contactPage: "" };
  const seller = scoreLead({ ...base, text: "We are a manufacturer, our factory exports worldwide. OEM available." }, { goal: "garden furniture", market: "de" });
  const buyer = scoreLead({ ...base, text: "Wir sind Importeur und Großhandel für Gartenmöbel." }, { goal: "garden furniture", market: "de" });
  assert.ok(buyer.score > seller.score, `buyer ${buyer.score} should beat seller ${seller.score}`);
  assert.equal(seller.role, "seller");
  assert.ok(seller.reasons.some((reason) => reason.includes("卖家")), "the reason must say why it lost points");
});

await testAsync("buyerOnly drops the sellers instead of shipping them to a salesperson", async () => {
  const search = async () => [{ title: "Maker", url: "https://maker.cn" }, { title: "Buyer", url: "https://buyer.de" }];
  const visit = async (url) => url.includes("maker")
    ? { url, title: "Maker", text: "We are a manufacturer with our own factory. OEM/ODM, export worldwide.", links: [] }
    : { url, title: "Buyer GmbH", text: "Wir sind Importeur und Großhandel. kontakt@buyer.de", links: [] };
  const all = await collectLeads({ goal: "garden furniture", market: "de", limit: 5, search, visit, queries: ["q"], maxSearches: 1 });
  const onlyBuyers = await collectLeads({ goal: "garden furniture", market: "de", limit: 5, search, visit, queries: ["q"], maxSearches: 1, buyerOnly: true, store: [] });
  assert.equal(all.leads.length, 2);
  assert.equal(onlyBuyers.leads.length, 1);
  assert.match(onlyBuyers.leads[0].url, /buyer\.de/);
});
console.log(`\n${passed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
