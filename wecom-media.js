/**
 * dsh-wechat-media - WeCom (企业微信) inbound media.
 *
 * The intelligent robot's long connection hands over `{ url, aeskey }` for image, file
 * and video messages (`src/types/message.ts` of the official `@wecom/aibot-node-sdk`):
 * a plain download URL that is valid for five minutes, and the bytes behind it are
 * encrypted. Taken from that SDK's own implementation (v1.0.7, `src/crypto.ts` and
 * `src/api.ts`), not guessed:
 *
 *   key = base64(aeskey)                     // 32 bytes -> AES-256
 *   iv  = key[0..16]
 *   AES-256-CBC, PKCS#7 padded to a 32-byte multiple, padding removed by hand
 *   file name: parsed from `Content-Disposition` (the payload carries none)
 *
 * Two details are easy to get wrong and are the reason this is its own module:
 *
 *   * it is NOT the personal-WeChat CDN scheme. iLink uses AES-128-ECB with a base64
 *     32-hex-character key (`ilink.js`); WeCom uses AES-256-CBC with the IV taken from
 *     the key. Same field name `aeskey`, different cipher.
 *   * WeCom pads to a **32**-byte multiple. Node's built-in padding removal works in
 *     16-byte blocks, so `decipher.final()` throws `bad decrypt` on payloads whose
 *     length is a multiple of 16. `setAutoPadding(false)` plus manual removal is what
 *     the SDK does, and what this does.
 */
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

/** WeCom's documented lifetime for a media URL. */
export const MEDIA_URL_TTL_MS = 5 * 60 * 1000;
/** WeCom's PKCS#7 block size for these payloads. */
const PADDING_BLOCK = 32;
/** Content types worth naming a file after, when neither header nor caller says. */
const MIME_EXT = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["video/mp4", ".mp4"],
  ["audio/amr", ".amr"],
  ["audio/mpeg", ".mp3"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
]);

/**
 * Decode the base64 `aeskey` of a media payload into the 32-byte AES-256 key.
 * @throws when the key is missing or not 32 bytes after decoding.
 */
export function wecomMediaKey(aesKeyBase64) {
  const raw = String(aesKeyBase64 ?? "").trim();
  if (!raw) throw new Error("aeskey is missing");
  // Node tolerates missing padding, but be explicit about what we expect.
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`aeskey must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

/**
 * Decrypt one WeCom media payload.
 * @param {Buffer} encrypted bytes as downloaded
 * @param {string} aesKeyBase64 the `aeskey` from the message
 * @returns {Buffer} the plaintext
 */
export function decryptWecomMedia(encrypted, aesKeyBase64) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error("nothing to decrypt (empty download)");
  }
  const key = wecomMediaKey(aesKeyBase64);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  // WeCom pads to 32 bytes; Node would strip padding in 16-byte blocks and fail.
  decipher.setAutoPadding(false);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (error) {
    throw new Error(`decryption failed (${error?.message ?? error}) - wrong aeskey or corrupted data`);
  }
  const padLength = plaintext[plaintext.length - 1];
  if (padLength < 1 || padLength > PADDING_BLOCK || padLength > plaintext.length) {
    throw new Error(`invalid PKCS#7 padding (${padLength}) - wrong aeskey or corrupted data`);
  }
  for (let index = plaintext.length - padLength; index < plaintext.length; index += 1) {
    if (plaintext[index] !== padLength) throw new Error("invalid PKCS#7 padding - not a uniform pad");
  }
  return plaintext.subarray(0, plaintext.length - padLength);
}

/**
 * A usable file name from `Content-Disposition`: RFC 5987 `filename*=UTF-8''…` first,
 * then the quoted/plain `filename=` form (this is what the official SDK does).
 */
export function fileNameFromDisposition(header) {
  const value = String(header ?? "");
  if (!value) return undefined;
  const utf8 = /filename\*=UTF-8''([^;\s]+)/i.exec(value);
  const plain = /filename="?([^";\s]+)"?/i.exec(value);
  const picked = utf8?.[1] ?? plain?.[1];
  if (!picked) return undefined;
  try {
    return decodeURIComponent(picked);
  } catch {
    return picked;
  }
}

/** Strip anything a file name may not contain, and never keep a path. */
function safeFileName(name) {
  const base = basename(String(name ?? "").trim()).replace(/[\\/:*?"<>|]+/g, "_");
  return base === "" || base === "." || base === ".." ? undefined : base;
}

/**
 * Download and decrypt one inbound media item into `destDir`.
 *
 * The signature is deliberately the same shape as `ilink.downloadMedia`, so
 * `media.saveInboundMedia` (inbox layout, size cap, extension sniffing) can drive
 * either transport.
 *
 * @param {object} options
 * @param {{ type: string, url: string, aesKey?: string }} options.item
 * @param {string} options.destDir directory to write into
 * @param {string} [options.fileName] force a name (else Content-Disposition, else made up)
 * @param {number} [options.maxBytes] refuse anything larger
 * @param {number} [options.timeoutMs] download timeout
 * @param {Function} [options.fetchImpl] injectable for tests
 * @returns {Promise<string>} absolute path of the written file
 */
export async function downloadWecomMedia({
  item,
  destDir,
  fileName,
  maxBytes = 100 * 1024 * 1024,
  timeoutMs = 60000,
  fetchImpl = fetch,
} = {}) {
  if (!destDir || !isAbsolute(destDir)) throw new Error("downloadWecomMedia: destDir must be an absolute directory");
  const url = String(item?.url ?? "").trim();
  if (!url) throw new Error(`a ${item?.type ?? "media"} message carried no download url`);
  const kind = String(item?.type ?? "file");

  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", ...(signal ? { signal } : {}) });
  } catch (error) {
    throw new Error(`download failed (${error?.message ?? error}) - the url is only valid for five minutes`);
  }
  if (!response?.ok) {
    throw new Error(`download failed: HTTP ${response?.status ?? "?"} ${response?.statusText ?? ""}`.trim());
  }

  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`media is ${declared} bytes, over the ${maxBytes} byte cap`);
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (downloaded.length > maxBytes) {
    throw new Error(`media is ${downloaded.length} bytes, over the ${maxBytes} byte cap`);
  }

  const contentType = String(response.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = item?.aesKey ? decryptWecomMedia(downloaded, item.aesKey) : downloaded;

  const fromHeader = safeFileName(fileNameFromDisposition(response.headers?.get?.("content-disposition")));
  const requested = safeFileName(fileName);
  const named = requested ?? fromHeader;
  const extension = (named ? extname(named) : "") || MIME_EXT.get(contentType) || ".bin";
  const stem = named ? named.slice(0, named.length - extname(named).length) : `wecom-${kind}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const finalName = `${stem}${extension}`;

  await mkdir(destDir, { recursive: true });
  const filePath = join(destDir, finalName);
  await writeFile(filePath, bytes);
  return filePath;
}
