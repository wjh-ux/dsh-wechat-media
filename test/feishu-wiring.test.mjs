/**
 * Drive the Feishu send half for real.
 *
 * The source-regex guard in test/wiring.test.mjs proves the code is *shaped* right; this proves it
 * *runs*: it calls apply() with a fake ctx, captures the registered tools, and executes them against a
 * stubbed fetch. Nothing here touches the network and no credential is real.
 *
 * Run: node test/feishu-wiring.test.mjs
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";
import { feishuWebhookSign } from "../feishu.js";

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
};

process.on("unhandledRejection", (error) => console.log("  (unhandled rejection: " + (error?.message ?? error) + ")"));

/** Boot the plugin with a fake harness and hand back the tools it registered. */
async function boot(feishuConfig) {
  const root = await mkdtemp(join(tmpdir(), "feishu-drive-"));
  const registered = new Map();
  const toolCtx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {}; } },
    effect: () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect: () => {},
    on: () => {},
    get: () => undefined,
    inject: (capabilities, callback) => {
      if (capabilities.includes("tools")) callback(toolCtx);
      // approval / webServer are skipped: this is about the outbound tools only.
    },
  };
  apply(ctx, { dshHome: root, stateDir: root, feishu: feishuConfig });
  await new Promise((resolve) => setTimeout(resolve, 80));
  return registered;
}

/** Replace global fetch for one scenario, recording every call and answering from `respond`. */
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const entry = { url: String(url), options, body: options.body };
    calls.push(entry);
    const answer = respond(entry) ?? {};
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ── Scenario A: a custom webhook bot only ──────────────────────────────────────
console.log("\nA) only a webhook URL is configured");
{
  const tools = await boot({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/TESTHOOK", secret: "s3cr3t" });
  check("feishu_send_text is registered", tools.has("feishu_send_text"));
  check("feishu_send_file is registered", tools.has("feishu_send_file"));

  const stub = stubFetch(() => ({ code: 0 }));
  try {
    const plain = await tools.get("feishu_send_text").execute({ text: "你好" });
    check("webhook path reports the webhook channel", plain.includes("custom webhook bot"), plain);
    const sent = stub.calls.at(-1);
    const body = JSON.parse(String(sent.body));
    check("webhook body carries msg_type=text", body.msg_type === "text", JSON.stringify(body));
    check("webhook body carries the text content", body.content?.text === "你好", JSON.stringify(body.content));
    const expected = feishuWebhookSign({ timestamp: body.timestamp, secret: "s3cr3t" });
    check("webhook body is signed with the secret", body.sign === expected, `sign=${body.sign} expected=${expected}`);
    check("the secret itself is never in the body", !String(sent.body).includes("s3cr3t"));

    const rich = await tools.get("feishu_send_text").execute({ text: "**粗**", markdown: true });
    const richBody = JSON.parse(String(stub.calls.at(-1).body));
    check("markdown goes out as a post", richBody.msg_type === "post", JSON.stringify(richBody));
    check("post content is the zh_cn md shape", Boolean(richBody.content?.zh_cn?.content), JSON.stringify(richBody.content));

    const file = await mkdtemp(join(tmpdir(), "feishu-drive-file-"));
    const path = join(file, "note.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const before = stub.calls.length;
    const refused = await tools.get("feishu_send_file").execute({ path });
    check("a webhook-only setup is told a file cannot be sent", refused.includes("发不了文件"), refused);
    check("...and it names the fix (app credentials)", refused.includes("appId"), refused);
    check("...and it sends nothing", stub.calls.length === before, `${stub.calls.length} vs ${before}`);
  } finally {
    stub.restore();
  }
}

// ── Scenario B: an app bot ─────────────────────────────────────────────────────
console.log("\nB) app credentials are configured (fetch stubbed)");
{
  const tools = await boot({ appId: "cli_test", appSecret: "shhh-1", to: "oc_testchat" });
  const stub = stubFetch((entry) => {
    if (entry.url.includes("/auth/v3/tenant_access_token/internal")) {
      return { code: 0, tenant_access_token: "t-1", expire: 7200 };
    }
    if (entry.url.includes("/im/v1/messages")) {
      return { code: 0, data: { message_id: "om_1", chat_id: "oc_testchat" } };
    }
    if (entry.url.includes("/im/v1/images")) return { code: 0, data: { image_key: "img_1" } };
    if (entry.url.includes("/im/v1/files")) return { code: 0, data: { file_key: "file_1" } };
    return { code: 0 };
  });
  try {
    const first = await tools.get("feishu_send_text").execute({ text: "走应用机器人" });
    check("app path reports the app channel", first.includes("through the Feishu app bot"), first);
    check("app path reports the message_id", first.includes("om_1"), first);
    const tokenCalls = () => stub.calls.filter((c) => c.url.includes("tenant_access_token")).length;
    check("the tenant token was fetched", tokenCalls() === 1, `calls=${tokenCalls()}`);
    const msg = stub.calls.find((c) => c.url.includes("/im/v1/messages"));
    check("receive_id_type defaults to chat_id", msg.url.includes("receive_id_type=chat_id"), msg.url);
    const payload = JSON.parse(String(msg.body));
    check("the message names the configured receive id", payload.receive_id === "oc_testchat", JSON.stringify(payload));
    check("the bearer token is sent", msg.options.headers.authorization === "Bearer t-1");
    check("content is a JSON string, as the API requires", typeof payload.content === "string" && JSON.parse(payload.content).text === "走应用机器人");

    await tools.get("feishu_send_text").execute({ text: "第二条" });
    check("the tenant token is reused, not refetched", tokenCalls() === 1, `calls=${tokenCalls()}`);

    // open_id is derived from the id's own prefix.
    await tools.get("feishu_send_text").execute({ text: "私聊", to: "ou_abc" });
    const direct = stub.calls.filter((c) => c.url.includes("/im/v1/messages")).at(-1);
    check("an ou_ id goes out as open_id", direct.url.includes("receive_id_type=open_id"), direct.url);

    const dir = await mkdtemp(join(tmpdir(), "feishu-drive-file-"));
    const img = join(dir, "shot.png");
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    const asImage = await tools.get("feishu_send_file").execute({ path: img, kind: "image" });
    check("an image is uploaded and sent as an image", stub.calls.some((c) => c.url.includes("/im/v1/images")) && asImage.includes("as image"), asImage);
    check("the image message carries the image_key", String(stub.calls.at(-1).body).includes("img_1"));

    const doc = join(dir, "report.pdf");
    await writeFile(doc, Buffer.from("%PDF-1.4 test"));
    const asFile = await tools.get("feishu_send_file").execute({ path: doc });
    check("a document is uploaded and sent as a file", stub.calls.some((c) => c.url.includes("/im/v1/files")) && asFile.includes("as file"), asFile);
    check("the file upload declares file_type=pdf", String(stub.calls.find((c) => c.url.includes("/im/v1/files")).body).includes("pdf"));

    const dir2 = await mkdtemp(join(tmpdir(), "feishu-drive-audio-"));
    const audio = join(dir2, "clip.opus");
    await writeFile(audio, Buffer.from([0x4f, 0x70, 0x75, 0x73]));
    const asAudio = await tools.get("feishu_send_file").execute({ path: audio, kind: "audio" });
    check("audio goes out as an audio message", asAudio.includes("as audio"), asAudio);

    const noTarget = await tools.get("feishu_send_text").execute({ text: "no target", to: "  " });
    check("an app bot with no receive id says what to pass", noTarget.includes("receive id"), noTarget);
  } finally {
    stub.restore();
  }
}

// ── Scenario C: nothing configured ────────────────────────────────────────────
console.log("\nC) nothing is configured");
{
  const tools = await boot({});
  const stub = stubFetch(() => ({ code: 0 }));
  try {
    const answer = await tools.get("feishu_send_text").execute({ text: "hello" });
    check("an unconfigured machine gets instructions, not an exception", answer.includes("飞书还没有配置"), answer);
    check("...naming the webhook route", answer.includes("FEISHU_WEBHOOK_URL"));
    check("...and the app route", answer.includes("FEISHU_APP_ID"));
    check("...and sending nothing", stub.calls.length === 0, `${stub.calls.length} calls`);
    const empty = await tools.get("feishu_send_text").execute({ text: "   " });
    check("empty text is refused before any call", empty.includes("nothing to send"), empty);
    const noPath = await tools.get("feishu_send_file").execute({});
    check("an empty path is refused", noPath.includes("nothing to send"), noPath);
  } finally {
    stub.restore();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
