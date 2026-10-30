// Outreach sends real messages to real people, so the properties pinned here are the ones that cause damage when they
// break: the same company twice, a template that goes out with `{{company}}` still in it, or a plan that says "3 ready"
// while quietly dropping the ones it could not address.
import assert from "node:assert/strict";

import {
  addressFor,
  outreachSummary,
  planOutreach,
  planText,
  recordSend,
  renderTemplate,
} from "../outreach.js";

const passed = [];
const failed = [];
function test(name, fn) {
  try { fn(); passed.push(name); console.log("ok   " + name); }
  catch (error) { failed.push(name); console.log("FAIL " + name + "\n     " + String(error?.message ?? error)); }
}

test("placeholders are filled, and what cannot be filled is reported instead of shipped", () => {
  const good = renderTemplate("Hi {{company}}, I saw {{website}}.", { company: "ACME", website: "acme.de" });
  assert.equal(good.text, "Hi ACME, I saw acme.de.");
  assert.deepEqual(good.missing, []);

  const bad = renderTemplate("Hi {{company}}, about {{contact}}", { company: "ACME" });
  assert.equal(bad.text, "Hi ACME, about {{contact}}", "the placeholder is left visible rather than blanked");
  assert.deepEqual(bad.missing, ["contact"]);
});

test("only email can address a stranger; a chat needs an existing conversation", () => {
  assert.deepEqual(addressFor("email", { email: "Sales@ACME.de" }), { to: "sales@acme.de" });
  assert.ok(addressFor("email", { email: "not-an-address" }).reason);
  assert.ok(addressFor("wechat", { company: "ACME" }).reason, "no chat, no message");
  assert.deepEqual(addressFor("wechat", { chatId: "wxid_1" }), { to: "wxid_1" });
  assert.ok(addressFor("wecom", { chatId: "g1", allowed: false }).reason);
});

test("a cooldown stops the same address being hammered", () => {
  const now = Date.UTC(2026, 9, 30);
  const history = [{ channel: "email", to: "a@x.de", ok: true, at: now - 5 * 86400000 }];
  const plan = planOutreach({
    channel: "email",
    targets: [{ company: "A", email: "a@x.de" }, { company: "B", email: "b@x.de" }],
    template: "Hi {{company}}",
    history,
    cooldownDays: 30,
    now,
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].to, "b@x.de");
  assert.match(plan.skipped[0].reason, /冷却期/);
});

test("a failed send does not start a cooldown, a successful one does", () => {
  const now = Date.UTC(2026, 9, 30);
  let history = recordSend([], { channel: "email", to: "a@x.de", label: "A" }, { ok: false, at: now, error: "550" });
  let plan = planOutreach({ channel: "email", targets: [{ company: "A", email: "a@x.de" }], template: "Hi", history, now });
  assert.equal(plan.items.length, 1, "a bounce must not lock the address out for a month");
  history = recordSend(history, { channel: "email", to: "a@x.de", label: "A" }, { ok: true, at: now });
  plan = planOutreach({ channel: "email", targets: [{ company: "A", email: "a@x.de" }], template: "Hi", history, now });
  assert.equal(plan.items.length, 0);
});

test("the plan never exceeds its cap and never repeats an address inside one batch", () => {
  const targets = [
    { company: "C0", email: "c0@x.de" },
    { company: "C1", email: "c0@x.de" },
    { company: "C2", email: "c2@x.de" },
    { company: "C3", email: "c3@x.de" },
    { company: "C4", email: "c4@x.de" },
  ];
  const plan = planOutreach({ channel: "email", targets, template: "Hi {{company}}", limit: 3 });
  assert.equal(plan.items.length, 3);
  assert.equal(new Set(plan.items.map((item) => item.to)).size, 3);
  assert.ok(plan.skipped.some((row) => row.reason.includes("重复")));
});

test("the summary counts what actually left, per channel", () => {
  const now = Date.UTC(2026, 9, 30);
  let history = recordSend([], { channel: "email", to: "a@x.de", label: "A" }, { ok: true, at: now });
  history = recordSend(history, { channel: "wechat", to: "wxid_1", label: "B" }, { ok: false, at: now, error: "ret=-3" });
  const summary = outreachSummary(history, { now });
  assert.equal(summary.byChannel.email.sent, 1);
  assert.equal(summary.byChannel.wechat.failed, 1);
  assert.equal(summary.total, 2);
});

test("the preview shows the message body, not only the address", () => {
  const plan = planOutreach({ channel: "email", targets: [{ company: "ACME", email: "a@x.de" }], template: "您好 {{company}}，我们是做户外家具的。" });
  const text = planText(plan);
  assert.match(text, /a@x\.de/);
  assert.match(text, /您好 ACME/);
});

console.log(`\n${passed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
