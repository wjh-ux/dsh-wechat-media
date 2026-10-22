// The Google Maps patch: one async page-side run that scrolls the feed until it stops growing.
//
// The expression is a string that runs in the page, so the useful test is not "does it do the right thing in jsdom" -
// there is no feed here - but "is it a valid expression, and does it still contain the selectors Maps uses". The
// selectors are the part that breaks when Maps changes its markup, and the failure should be loud.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const { mapsPlacesExpression, MAPS_FIELDS } = await import("../maps.js");

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

await test("the expression is valid JavaScript, and closes over the page state it needs", () => {
  const source = mapsPlacesExpression({ limit: 42 });
  // `new Function` parses what the browser will parse; a syntax error here is a syntax error there.
  assert.doesNotThrow(() => new Function(`return ${source}`), "the expression parses");
  assert.match(source, /div\[role="feed"\]/, "the result feed");
  assert.match(source, /div\[role="article"\]/, "one card per result");
  assert.match(source, /a\[href\*="\/maps\/place\/"\]/, "the place link, which is also the dedupe key");
  assert.match(source, /span\[role="img"\]/, "the rating");
  assert.match(source, /W4Efsd/, "the address block");
  assert.match(source, /async \(\)/, "one async run: scrolling at page speed");
  assert.match(source, /const LIMIT = 42/, "the limit is passed through");
  assert.match(source, /setTimeout/, "it has to wait for lazy rows to render");
});

await test("the loop stops on a limit or on silence, never forever", () => {
  const source = mapsPlacesExpression({ limit: 10, stallRounds: 2 });
  assert.match(source, /rows\.size < LIMIT/, "the limit is a stop condition");
  assert.match(source, /quiet < STALL/, "so is a feed that stopped growing");
  assert.match(source, /const STALL = 2/, "with the stall rounds passed through");
  assert.match(source, /DEADLINE/, "and a deadline, so a page that keeps loading cannot hang the tool");
});

await test("rows are keyed the way the rest of the plugin writes them", () => {
  assert.deepEqual(Object.keys(MAPS_FIELDS), ["名称", "评分", "地址", "链接"]);
});

// The tool itself: registered, saved through the shared path, and shipped with the package.
const pluginDir = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const host = readFileSync(joinPath(pluginDir, "index.js"), "utf8");
const pkg = JSON.parse(readFileSync(joinPath(pluginDir, "package.json"), "utf8"));

await test("the tool is registered and saves with the same rules as everything else", () => {
  assert.match(host, /"browser_maps_places"/);
  assert.match(host, /mapsPlacesExpression\(\{ limit \}\)/, "it uses the expression above");
  assert.match(host, /saveFlowRows\(target, list, \{ name: "maps" \}\)/, "and the shared export path");
  assert.ok(pkg.files.includes("maps.js"), "maps.js is published");
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
