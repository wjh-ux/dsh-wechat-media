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
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

/**
 * The formats a chat accepts, best first.
 *
 * `mp3` is the safe default: both platforms take it and it plays everywhere. `amr` is what WeCom's
 * voice messages are specified in, and it is far smaller, but only some ffmpeg builds can write it -
 * so it is offered rather than assumed. `wav` needs no conversion at all and is the fallback that
 * works whenever SAPI does.
 */
export const VOICE_FORMATS = Object.freeze({
  mp3: { extension: ".mp3", args: ["-ar", "44100", "-ac", "1", "-b:a", "64k"] },
  amr: { extension: ".amr", args: ["-ar", "8000", "-ac", "1", "-ab", "12.2k", "-f", "amr"] },
  wav: { extension: ".wav", args: ["-ar", "16000", "-ac", "1"] },
});

/** Every format name this module can produce. */
export const VOICE_FORMAT_NAMES = Object.freeze(Object.keys(VOICE_FORMATS));

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
  try {
    const probe = "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Dispose(); 'ok'";
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", probe], { timeout: 30_000, windowsHide: true });
    hasSpeech = String(stdout).includes("ok");
  } catch {
    hasSpeech = false;
  }
  const missing = [];
  if (!hasSpeech) missing.push("windows speech (System.Speech)");
  if (!hasFfmpeg) missing.push("ffmpeg");
  return {
    ok: missing.length === 0,
    missing,
    ffmpeg: hasFfmpeg,
    speech: hasSpeech,
    // Without ffmpeg, SAPI's own WAV is still a usable voice file - so the capability is not all-or-nothing.
    formats: hasSpeech ? (hasFfmpeg ? [...VOICE_FORMAT_NAMES] : ["wav"]) : [],
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
  if (!wavBytes) {
    await cleanup();
    throw new Error("text-to-speech produced no audio (the text may be unspeakable)");
  }
  if (wanted === "wav") {
    return { path: wavPath, format: "wav", bytes: wavBytes, wavBytes, cleanup: keepWav ? async () => {} : cleanup, dir };
  }
  const target = join(dir, `speech${VOICE_FORMATS[wanted].extension}`);
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
  return { path: target, format: wanted, bytes, wavBytes, cleanup: keepWav ? async () => {} : cleanup, dir };
}

/** Read a produced voice file back (used by tests and by a caller that wants the bytes). */
export async function readVoice(path) {
  return readFile(path);
}
