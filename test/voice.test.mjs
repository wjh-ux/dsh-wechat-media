/**
 * Tests for text-to-speech voice messages.
 *
 * The pure parts (PowerShell quoting, the script, the format table) are checked everywhere. The real
 * synthesis is checked too, but **skipped** where the machine cannot do it - CI has no ffmpeg - so a
 * missing tool never turns into a red suite.
 *
 * Run: node test/voice.test.mjs
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { VOICE_FORMATS, pcmToWav, probeDurationSec, quotePowerShell, silkToWav, synthesizeVoice, voiceDeliveryFor, voiceScript, voiceSupport } from "../voice.js";

let passed = 0;
let failed = 0;
let skipped = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    if (error?.skip) {
      skipped += 1;
      console.log(`  skip ${name} (${error.skip})`);
      return;
    }
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}
const skip = (why) => Object.assign(new Error(why), { skip: why });

console.log("voice");

await test("PowerShell literals are quoted, never interpolated", () => {
  // The text goes into a script, so this is the one place where the feature could be dangerous.
  assert.equal(quotePowerShell("你好"), "'你好'");
  assert.equal(quotePowerShell("it's here"), "'it''s here'");
  assert.equal(quotePowerShell("$(Get-ChildItem)"), "'$(Get-ChildItem)'", "a subexpression stays literal");
  assert.equal(quotePowerShell("`n`t"), "'`n`t'", "backticks stay literal");
  assert.equal(quotePowerShell('say "hi"'), `'say "hi"'`, "double quotes are harmless inside single quotes");
  assert.equal(quotePowerShell("a'b'c"), "'a''b''c'");
  assert.equal(quotePowerShell(undefined), "''");
  assert.equal(quotePowerShell(42), "'42'");
});

await test("the speech script speaks into a file and nothing else", () => {
  const script = voiceScript({ text: "测试", wavPath: "C:\\tmp\\a.wav", voice: "Microsoft Huihui", rate: 2 });
  assert.match(script, /Add-Type -AssemblyName System\.Speech/);
  assert.match(script, /New-Object System\.Speech\.Synthesis\.SpeechSynthesizer/);
  assert.match(script, /\$s\.Rate = 2/);
  assert.match(script, /\$s\.SelectVoice\('Microsoft Huihui'\)/);
  assert.match(script, /\$s\.SetOutputToWaveFile\('C:\\tmp\\a\.wav'\)/);
  assert.match(script, /\$s\.Speak\('测试'\)/);
  assert.match(script, /\$s\.Dispose\(\)/);
  assert.doesNotMatch(script, /Invoke-|Start-Process|Remove-Item/, "the script does nothing but speak");
  // An injection attempt must remain a string.
  const nasty = voiceScript({ text: "'; Remove-Item -Recurse C:\\ ; '", wavPath: "x", rate: 0 });
  assert.match(nasty, /Speak\('''; Remove-Item -Recurse C:\\ ; '''\)/);
  assert.doesNotMatch(nasty, /^\s*Remove-Item/m);
  // The rate is clamped rather than passed through.
  assert.match(voiceScript({ text: "x", wavPath: "y", rate: 99 }), /\$s\.Rate = 10/);
  assert.match(voiceScript({ text: "x", wavPath: "y", rate: -99 }), /\$s\.Rate = -10/);
  assert.doesNotMatch(voiceScript({ text: "x", wavPath: "y", rate: 0 }), /Rate =/, "a zero rate is left alone");
});

await test("every advertised format has an extension and conversion arguments", () => {
  for (const [name, spec] of Object.entries(VOICE_FORMATS)) {
    assert.match(spec.extension, /^\.[a-z0-9]+$/, `${name} needs an extension`);
    assert.ok(Array.isArray(spec.args) && spec.args.length > 0, `${name} needs conversion arguments`);
  }
  assert.ok(VOICE_FORMATS.mp3, "mp3 is the cross-platform default");
  assert.ok(VOICE_FORMATS.amr, "amr is what WeCom specifies for voice");
});

await test("a missing tool is reported by name, not as a mystery", async () => {
  const support = await voiceSupport({ ffmpeg: "definitely-not-a-real-ffmpeg", powershell: "definitely-not-a-real-powershell" });
  assert.equal(support.ok, false);
  assert.equal(support.ffmpeg, false);
  assert.equal(support.speech, false);
  assert.deepEqual(support.formats, [], "no speech engine means no voice at all");
  assert.ok(support.missing.some((piece) => /ffmpeg/.test(piece)), "ffmpeg must be named");
  assert.ok(support.missing.some((piece) => /speech/i.test(piece)), "the speech engine must be named");
});

await test("the real machine reports what it can actually do", async () => {
  const support = await voiceSupport();
  console.log(`       support: speech=${support.speech} ffmpeg=${support.ffmpeg} formats=${support.formats.join(",") || "none"}`);
  // No assertion about the outcome: this machine may legitimately have neither, and CI has no ffmpeg.
  assert.equal(typeof support.ok, "boolean");
});

await test("an empty text is refused before anything is spawned", async () => {
  await assert.rejects(() => synthesizeVoice({ text: "   " }), /nothing to say/);
});

await test("speaking produces a file a chat can send", async () => {
  const support = await voiceSupport();
  if (!support.speech) throw skip("no System.Speech on this machine");
  const wanted = support.ffmpeg ? "mp3" : "wav";
  const voice = await synthesizeVoice({ text: "这是一条语音测试。", format: wanted });
  try {
    const info = await stat(voice.path);
    assert.ok(info.size > 1000, `expected real audio, got ${info.size} bytes`);
    assert.equal(voice.format, wanted);
    assert.ok(voice.bytes > 0);
    assert.match(voice.path, new RegExp(`${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "the file must carry the format's extension");
  } finally {
    await voice.cleanup();
  }
});

await test("a spoken message is labelled for the model, and a missing transcript says so", async () => {
  const { spokenText, VOICE_LABEL } = await import("../voice.js");
  assert.equal(spokenText({ platform: "wechat", text: "你好" }), `${VOICE_LABEL.wechat} 你好`);
  assert.equal(spokenText({ platform: "wecom", text: "帮我查一下" }), `${VOICE_LABEL.wecom} 帮我查一下`);
  assert.match(spokenText({ platform: "wecom", text: "   " }), /未提供转写/, "silence must be admitted, not invented");
  assert.match(spokenText({}), /微信语音/, "the default platform is WeChat");
});

await test("a voice bubble is only promised where the platform can decode it", () => {
  // WeChat renders a bubble only for SILK, and the iLink API needs playtime besides; anything else sent as a
  // voice item is accepted and then dropped (measured: text arrived, the voice did not). WeCom takes AMR.
  assert.equal(voiceDeliveryFor({ platform: "wecom", extension: "amr" }), "bubble");
  assert.equal(voiceDeliveryFor({ platform: "wecom", extension: "mp3" }), "bubble");
  // Measured, not preferred: WeChat voice items are accepted and then dropped by the client, Tencent's own
  // WeChat channel never sends the VOICE media type at all, and the equivalent issue elsewhere is `blocked`.
  assert.equal(voiceDeliveryFor({ platform: "wechat", extension: "silk" }), "file");
  assert.equal(voiceDeliveryFor({ platform: "wechat", extension: "mp3" }), "file");
  assert.equal(voiceDeliveryFor({ platform: "wechat", extension: ".amr" }), "file");
  assert.equal(voiceDeliveryFor({ platform: "wechat", extension: "wav" }), "file");
  assert.equal(voiceDeliveryFor({}), "file", "WeChat is the default, and mp3 is not SILK");
});

await test("the playtime a voice item requires is read, not guessed", async () => {
  const support = await voiceSupport();
  if (!support.speech) throw skip("no System.Speech on this machine");
  if (!support.ffmpeg) throw skip("ffprobe ships with ffmpeg, which is missing");
  const voice = await synthesizeVoice({ text: "时长测试，读出一句话需要几秒钟。", format: "mp3" });
  try {
    assert.ok(voice.seconds > 0.5, `a spoken sentence lasts longer than half a second, got ${voice.seconds}`);
    assert.ok(voice.seconds < 60, `and well under a minute, got ${voice.seconds}`);
    assert.equal(await probeDurationSec({ path: voice.path }), voice.seconds, "the probe is what the item reports");
    assert.equal(await probeDurationSec({ path: "no-such-file.mp3" }), 0, "an unreadable file is 0, not a guess");
  } finally {
    await voice.cleanup();
  }
});
await test("SILK is produced when the vendored encoder is available", async () => {
  const support = await voiceSupport();
  if (!support.silk) throw skip("no SILK encoder or no ffmpeg on this machine");
  const voice = await synthesizeVoice({ text: "这是一条 SILK 测试。", format: "silk" });
  try {
    assert.equal(voice.format, "silk");
    assert.ok(voice.bytes > 1000, `expected real audio, got ${voice.bytes} bytes`);
    assert.ok(voice.seconds > 0.3 && voice.seconds < 60, `plausible duration, got ${voice.seconds}`);
    const head = (await readFile(voice.path)).subarray(0, 10).toString("latin1");
    assert.match(head, /#!SILK_V3/, "the SILK v3 container signature is what WeChat expects");
  } finally {
    await voice.cleanup();
  }
});

await test("the vendored encoder is recorded, not just dropped in", async () => {
  // Third-party code in the tree must be traceable: package, version, licence and the hash it was
  // verified against. The README beside it is what makes that checkable later.
  const readme = await readFile(new URL("../vendor/silk-wasm/README.md", import.meta.url), "utf8");
  assert.match(readme, /silk-wasm/);
  assert.match(readme, /MIT/);
  assert.match(readme, /3\.7\.1/);
  assert.match(readme, /sha512-mXPwLRtZxrYV3TZx41jMAeKc80wvmyrcXIcs8HctFxK15Ahz2OJQENYhNgEPeCEOdI6Mbx1NxQsqxzwc3DKerw==/, "the verified hash must be recorded");
  const licence = await readFile(new URL("../vendor/silk-wasm/LICENSE", import.meta.url), "utf8");
  assert.match(licence, /MIT|Permission is hereby granted/i);
});
await test("raw PCM is wrapped in a WAV container a player understands", () => {
  const pcm = Buffer.alloc(1000, 3);
  const wav = pcmToWav(pcm, 24_000);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1, "PCM format");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16, "16-bit samples");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data chunk length");
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF size");
});

await test("an incoming SILK voice message decodes into playable WAV", async () => {
  // The reason the codec is vendored: WeChat *sends* SILK, and nothing else here can play it.
  const support = await voiceSupport();
  if (!support.silk) throw skip("no SILK codec or no ffmpeg on this machine");
  const silk = await synthesizeVoice({ text: "这是一条入站语音解码测试。", format: "silk" });
  try {
    const decoded = await silkToWav(await readFile(silk.path));
    assert.equal(decoded.wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(decoded.wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.ok(decoded.wav.length > 10_000, `expected real audio, got ${decoded.wav.length} bytes`);
    assert.ok(decoded.seconds > 0.3, `plausible duration, got ${decoded.seconds}`);
  } finally {
    await silk.cleanup();
  }
  await assert.rejects(() => silkToWav(Buffer.alloc(0)), /nothing to decode/);
});
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
