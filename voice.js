/**
 * Turning text into a voice message.
 *
 * Both WeChat and WeCom accept a voice file, and neither offers text-to-speech - so the audio is made
 * here. On Windows the system's own speech engine (SAPI, through `System.Speech`) does the speaking and
 * `ffmpeg` converts its WAV into a format a chat accepts. **Nothing leaves the machine**: no cloud
 * service, no API key, no account. If either piece is missing, the caller is told plainly rather than
 * being handed silence.
 *
 * The one security-relevant detail is that the text ends up inside a PowerShell script, so it is quoted
 * as a single-quoted PowerShell literal (every `'` doubled) - never interpolated. `voiceScript` is
 * exported so that property can be tested directly.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How a spoken message is shown to the model, in one place so both platforms read the same. */
export const VOICE_LABEL = Object.freeze({
  wechat: "[微信语音（平台转写）]",
  wecom: "[企业微信语音（平台转写）]",
});

/**
 * The prompt line for a spoken message.
 *
 * Both platforms transcribe voice themselves, so the words are available - but the model should know it
 * is reading *speech*, both to answer in a fitting register and to be honest when a voice message
 * arrived without any transcription.
 *
 * @param {{ platform?: "wechat" | "wecom", text?: unknown }} [input]
 * @returns {string}
 */
export function spokenText({ platform = "wechat", text = "" } = {}) {
  const words = String(text ?? "").trim();
  const label = platform === "wecom" ? VOICE_LABEL.wecom : VOICE_LABEL.wechat;
  return words ? `${label} ${words}` : `${label}（平台未提供转写）`;
}

/** The two external pieces, named as commands rather than hard-coded paths. */
export const DEFAULT_POWERSHELL = "powershell.exe";
export const DEFAULT_FFMPEG = "ffmpeg";
/** Reads the duration that a voice item must report. */
export const DEFAULT_FFPROBE = "ffprobe";

/**
 * The formats a chat accepts, best first.
 *
 * `silk` is what a **WeChat voice bubble** needs and nothing else can replace it; it is produced by the
 * vendored MIT encoder (see `vendor/silk-wasm` and THIRD-PARTY.md), fed by the 24 kHz mono WAV that
 * `args` describes. `mp3` is the safe, dependency-free default; `amr` is what WeCom specifies for voice;
 * `wav` needs no conversion at all and works whenever SAPI does.
 */
export const VOICE_FORMATS = Object.freeze({
  silk: { extension: ".silk", args: ["-ar", "24000", "-ac", "1", "-f", "wav"] },
  mp3: { extension: ".mp3", args: ["-ar", "44100", "-ac", "1", "-b:a", "64k"] },
  amr: { extension: ".amr", args: ["-ar", "8000", "-ac", "1", "-ab", "12.2k", "-f", "amr"] },
  wav: { extension: ".wav", args: ["-ar", "16000", "-ac", "1"] },
});

/** Every format name this module can produce. */
export const VOICE_FORMAT_NAMES = Object.freeze(Object.keys(VOICE_FORMATS));

/**
 * The vendored SILK encoder, loaded only when SILK is actually asked for.
 *
 * `vendor/silk-wasm` is the MIT-licensed `silk-wasm` package (see the README beside it and THIRD-PARTY.md).
 * It is vendored rather than declared as a dependency because this plugin is installed as a directory -
 * an `npm install` never runs, so a dependency would simply be missing at runtime.
 */
async function loadSilk() {
  const module = await import("./vendor/silk-wasm/index.mjs");
  if (typeof module.encode !== "function") throw new Error("the vendored SILK encoder exposes no encode()");
  return module;
}

/**
 * Quote a string as a PowerShell single-quoted literal.
 *
 * Single quotes are the only escape that exists inside such a literal, which is exactly why the text
 * goes in this way: no `$`, no backtick and no `"` can be interpreted.
 *
 * @param {unknown} value
 * @returns {string} the value wrapped in quotes, safe to paste into a script
 */
export function quotePowerShell(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/**
 * The PowerShell program that speaks `text` into `wavPath`.
 *
 * `System.Speech` is part of Windows itself; this asks it for a WAV file and nothing else. The voice is
 * optional - an unknown name makes SAPI throw, which the caller reports rather than hides.
 *
 * @param {{ text?: string, wavPath?: string, voice?: string, rate?: number }} input
 * @returns {string}
 */
export function voiceScript({ text = "", wavPath = "", voice = "", rate = 0 } = {}) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  ];
  const speed = Math.max(-10, Math.min(10, Number(rate) || 0));
  if (speed !== 0) lines.push(`$s.Rate = ${speed}`);
  if (voice) lines.push(`$s.SelectVoice(${quotePowerShell(voice)})`);
  lines.push(`$s.SetOutputToWaveFile(${quotePowerShell(wavPath)})`);
  lines.push(`$s.Speak(${quotePowerShell(text)})`);
  lines.push("$s.Dispose()");
  return lines.join("\n");
}

/** Turn an execFile failure into one readable line. */
function failure(command, error) {
  const stderr = String(error?.stderr ?? "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
  const detail = stderr || String(error?.message ?? error);
  return new Error(`${command} failed: ${detail}`);
}

/**
 * Is the machine able to make a voice message at all?
 *
 * Both pieces are probed, and each is named in the answer: "no voice" with no reason is the kind of
 * message that costs an hour.
 *
 * @param {{ ffmpeg?: string, powershell?: string }} [options]
 * @returns {Promise<{ ok: boolean, missing: string[], ffmpeg: boolean, speech: boolean, formats: string[] }>}
 */
export async function voiceSupport({ ffmpeg = DEFAULT_FFMPEG, powershell = DEFAULT_POWERSHELL } = {}) {
  let hasFfmpeg = false;
  try {
    await run(ffmpeg, ["-hide_banner", "-version"], { timeout: 20_000, windowsHide: true });
    hasFfmpeg = true;
  } catch {
    hasFfmpeg = false;
  }
  let hasSpeech = false;
  // The count matters as much as the assembly: a machine with System.Speech and no voices writes a WAV header and no
  // samples (measured on a CI runner: 46 bytes), which a chat would receive as a broken voice message.
  let voices = 0;
  try {
    const probe = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $n = $s.GetInstalledVoices().Count; $s.Dispose(); \"ok:$n\"";
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", probe], { timeout: 30_000, windowsHide: true });
    const hit = /ok:(\d+)/.exec(String(stdout));
    hasSpeech = hit !== null;
    voices = hit ? Number(hit[1]) : 0;
  } catch {
    hasSpeech = false;
  }
  // SILK needs both the vendored encoder and ffmpeg (to resample into it), so it is probed too.
  let hasSilk = false;
  if (hasFfmpeg) {
    try {
      await loadSilk();
      hasSilk = true;
    } catch {
      hasSilk = false;
    }
  }
  const missing = [];
  if (!hasSpeech) missing.push("windows speech (System.Speech)");
  if (!hasFfmpeg) missing.push("ffmpeg");
  const formats = hasSpeech ? (hasFfmpeg ? VOICE_FORMAT_NAMES.filter((name) => name !== "silk" || hasSilk) : ["wav"]) : [];
  return {
    ok: missing.length === 0,
    missing,
    ffmpeg: hasFfmpeg,
    speech: hasSpeech,
    voices,
    silk: hasSilk,
    // Without ffmpeg, SAPI's own WAV is still a usable voice file - so the capability is not all-or-nothing.
    formats: [...formats],
  };
}

/**
 * Speak `text` and return the path of a file a chat can send.
 *
 * The temporary directory is the caller's to keep (the file has to outlive this call to be uploaded);
 * `cleanup` removes it once the send is done.
 *
 * @param {{ text?: string, format?: string, voice?: string, rate?: number, ffmpeg?: string, powershell?: string, keepWav?: boolean }} [options]
 * @returns {Promise<{ path: string, format: string, bytes: number, wavBytes: number, cleanup: () => Promise<void>, dir: string }>}
 */
export async function synthesizeVoice({
  text = "",
  format = "mp3",
  voice = "",
  rate = 0,
  ffmpeg = DEFAULT_FFMPEG,
  ffprobe = "",
  powershell = DEFAULT_POWERSHELL,
  keepWav = false,
} = {}) {
  const spoken = String(text ?? "").trim();
  if (!spoken) throw new Error("nothing to say: the text is empty");
  const wanted = VOICE_FORMATS[format] ? format : "mp3";
  const dir = await mkdtemp(join(tmpdir(), "dsh-voice-"));
  const cleanup = async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); };
  const wavPath = join(dir, "speech.wav");
  try {
    const script = voiceScript({ text: spoken, wavPath, voice, rate });
    await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 120_000, windowsHide: true });
  } catch (error) {
    await cleanup();
    throw failure("text-to-speech", error);
  }
  const wavBytes = (await stat(wavPath).catch(() => ({ size: 0 }))).size;
  if (!wavBytes || wavBytes <= 128) {
    await cleanup();
    // A voice-less SAPI writes exactly the RIFF header and nothing else; sending those bytes is worse than an error.
    throw new Error("text-to-speech produced no audio (the text may be unspeakable, or this machine has no SAPI voice installed)");
  }
  if (wanted === "wav") {
    return { path: wavPath, format: "wav", bytes: wavBytes, wavBytes, cleanup: keepWav ? async () => {} : cleanup, dir };
  }
  const target = join(dir, `speech${VOICE_FORMATS[wanted].extension}`);
  if (wanted === "silk") {
    // Two steps: ffmpeg resamples SAPI's WAV (the codec wants 24 kHz mono), then the vendored encoder
    // turns that into SILK - the only format WeChat renders as a voice bubble.
    const source = join(dir, "speech24.wav");
    try {
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, ...VOICE_FORMATS.silk.args, source], { timeout: 120_000, windowsHide: true });
    } catch (error) {
      await cleanup();
      throw failure("resampling for SILK", error);
    }
    try {
      const { encode } = await loadSilk();
      const encoded = await encode(await readFile(source), 0);
      if (!encoded?.data?.length) throw new Error("the encoder produced nothing");
      await writeFile(target, encoded.data);
      const durationMs = Number(encoded.duration) || 0;
      const bytes = encoded.data.length;
      return { path: target, format: "silk", bytes, wavBytes, seconds: durationMs ? Math.round(durationMs / 10) / 100 : await probeDurationSec({ path: target }), cleanup: keepWav ? async () => {} : cleanup, dir };
    } catch (error) {
      await cleanup();
      throw failure("SILK encoding", error);
    }
  }
  try {
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, ...VOICE_FORMATS[wanted].args, target], { timeout: 120_000, windowsHide: true });
  } catch (error) {
    // The WAV is still a valid voice file, so a converter that refuses is a downgrade, not a failure.
    const reason = String(error?.stderr ?? error?.message ?? error).trim().split("\n").slice(-1)[0];
    await cleanup();
    throw new Error(`converting to ${wanted} failed (${reason}); "wav" needs no conversion`);
  }
  const bytes = (await stat(target)).size;
  if (!bytes) {
    await cleanup();
    throw new Error(`converting to ${wanted} produced an empty file`);
  }
  // The duration is a required field of a voice item, so it is read from the file that was just written. When
  // ffprobe cannot be found the caller gets 0 and the item falls back to its minimum - never a made-up number.
  const probeBin = ffprobe || (ffmpeg === DEFAULT_FFMPEG ? DEFAULT_FFPROBE : ffmpeg.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1"));
  const seconds = await probeDurationSec({ path: target, ffprobe: probeBin });
  return { path: target, format: wanted, bytes, wavBytes, seconds, cleanup: keepWav ? async () => {} : cleanup, dir };
}

/**
 * How long a piece of audio plays, in seconds.
 *
 * iLink's voice item carries `playtime` (seconds) as a required field, and the platform accepts an item
 * without it and then drops the message - so this is not cosmetic. `ffprobe` reads it; when ffprobe is
 * missing the caller gets 0 and decides what to do rather than being handed a guess.
 *
 * @param {{ path?: string, ffprobe?: string }} [input]
 * @returns {Promise<number>} seconds, rounded to two decimals, or 0 when it cannot be read
 */
export async function probeDurationSec({ path = "", ffprobe = DEFAULT_FFPROBE } = {}) {
  if (!path) return 0;
  try {
    const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { timeout: 30_000, windowsHide: true });
    const seconds = Number.parseFloat(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

/**
 * How a piece of audio should be delivered to a chat.
 *
 * **WeChat only renders a voice bubble for SILK**, and the iLink API additionally requires
 * `voice_item.playtime`; anything else sent as a voice item is accepted and then silently dropped
 * (measured: text arrived, the voice never did). WeCom is different - it takes AMR and really does show a
 * bubble. So the rule is explicit rather than hopeful: a bubble only where the platform can decode it,
 * and an ordinary audio file everywhere else, which does arrive and does play.
 *
 * @param {{ platform?: "wechat" | "wecom", extension?: string }} [input]
 * @returns {"bubble" | "file"}
 */
export function voiceDeliveryFor({ platform = "wechat", extension = "" } = {}) {
  if (platform === "wecom") return "bubble";
  // Personal WeChat never gets a bubble, and that is a measured platform limit rather than a preference:
  // Tencent's own OpenClaw WeChat channel never sends the VOICE media type at all (image/video/file only),
  // the equivalent issue in another implementation has been open and `blocked` for months, and two live
  // attempts here - mp3 inside an open conversation window, then SILK with `playtime` - were both accepted by
  // the API and then dropped by the client. Audio goes as a file, which really does arrive and play.
  return "file";
}

/**
 * Wrap raw PCM in a WAV header.
 *
 * `silk-wasm`'s decoder returns bare `pcm_s16le`; a WAV container is what a player (and the model's tooling)
 * expects. Pure, so the header can be asserted byte for byte.
 *
 * @param {Uint8Array | Buffer} pcm mono 16-bit little-endian samples
 * @param {number} [sampleRate]
 * @returns {Buffer}
 */
export function pcmToWav(pcm, sampleRate = 24_000) {
  const data = Buffer.from(pcm ?? []);
  const rate = Math.max(1, Number(sampleRate) || 24_000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate = rate * channels * bytesPerSample
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Decode a SILK voice message into playable WAV.
 *
 * This is the direction the codec is genuinely needed for: WeChat *sends* voice as SILK, and nothing else on a
 * normal machine can play it. Tencent's own OpenClaw WeChat channel vendors `silk-wasm` for exactly this
 * (decoding incoming voice), which is why the same module is vendored here.
 *
 * @param {Uint8Array | Buffer} silk
 * @param {{ sampleRate?: number }} [options]
 * @returns {Promise<{ wav: Buffer, seconds: number }>}
 */
export async function silkToWav(silk, { sampleRate = 24_000 } = {}) {
  const input = Buffer.from(silk ?? []);
  if (!input.length) throw new Error("nothing to decode: the SILK buffer is empty");
  const { decode } = await loadSilk();
  const result = await decode(input, sampleRate);
  if (!result?.data?.length) throw new Error("the codec decoded nothing");
  const wav = pcmToWav(result.data, sampleRate);
  return { wav, seconds: Number(result.duration) ? Math.round(Number(result.duration) / 10) / 100 : 0 };
}

/** Read a produced voice file back (used by tests and by a caller that wants the bytes). */
export async function readVoice(path) {
  return readFile(path);
}
