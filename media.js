/**
 * dsh-wechat-media - media helpers.
 *
 * Inbound: WeChat hands over a `media` reference (a CDN URL plus an AES key);
 * `ilink.downloadMedia` turns it into bytes and this module lands them on disk so
 * the agent can read them. Images go to a directory the model can open with a
 * path, which is what works with a text-only model plus a vision plugin (ModLens
 * and friends read images by path). Documents, archives and video are simply
 * handed over the same way.
 *
 * Outbound: a local path is classified by extension into the three payload kinds
 * the protocol supports (image / video / file), with size limits applied before
 * anything is encrypted and uploaded.
 */
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";

/** Directory under $DSH_HOME where inbound media is written. */
const INBOX_NAME = "wechat-inbox";

/** Extensions the protocol can send as an image payload. */
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
/** Extensions the protocol can send as a video payload. */
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);
/** Everything else travels as a generic file payload (documents, archives, ...). */
const MIME_EXT = new Map([
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".7z", "application/x-7z-compressed"],
  [".rar", "application/vnd.rar"],
  [".gz", "application/gzip"],
  [".tar", "application/x-tar"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"],
]);

/** Which payload kind a local file should be sent as. */
export function outboundKind(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "file";
}

/**
 * The internal kind of an inbound item.
 *
 * Do not use the protocol client's `getMediaLabel` here: that one returns a
 * display label like `[图片]`, which would silently never match the `image`
 * branch below.
 */
export function mediaKindOf(protocol, item) {
  const types = protocol?.messageItemTypes ?? {};
  if (item?.type === types.IMAGE) return "image";
  if (item?.type === types.VIDEO) return "video";
  if (item?.type === types.VOICE) return "voice";
  if (item?.type === types.FILE) return "file";
  return "file";
}

/** A best-effort MIME type for an outbound file payload. */
export function outboundMime(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  return MIME_EXT.get(ext) ?? "application/octet-stream";
}

/** File name (without directories) of a path, for both inbound and outbound. */
export function baseName(filePath) {
  const parts = String(filePath ?? "").split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

/**
 * Magic bytes -> extension. Images and videos arrive without a usable file name,
 * so the protocol client can only fall back to `.bin`; the model's read_image /
 * preview path does care about the extension, so sniff the real type and fix it.
 */
const MAGIC_EXT = [
  { bytes: [0xff, 0xd8, 0xff], ext: ".jpg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: ".png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: ".gif" },
  { bytes: [0x25, 0x50, 0x44, 0x46], ext: ".pdf" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], ext: ".zip" },
  { bytes: [0x52, 0x61, 0x72, 0x21], ext: ".rar" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf], ext: ".7z" },
  { bytes: [0x1f, 0x8b], ext: ".gz" },
];

/** Read the first bytes of a file to guess its real extension. */
async function sniffExtension(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    for (const candidate of MAGIC_EXT) {
      if (candidate.bytes.every((byte, index) => head[index] === byte)) return candidate.ext;
    }
    // ISO base media (mp4/mov/m4v) carries `ftyp` at offset 4.
    if (head.length >= 12 && head.subarray(4, 8).toString("ascii") === "ftyp") return ".mp4";
    if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Give a downloaded file the extension its bytes actually imply. */
export async function ensureMediaExtension(filePath) {
  const detected = await sniffExtension(filePath);
  if (!detected) return filePath;
  const current = extname(filePath).toLowerCase();
  if (current === detected) return filePath;
  // `.bin` and other placeholders are replaced; a meaningful name is kept and
  // only corrected when it disagrees with the bytes.
  const stem = filePath.slice(0, filePath.length - current.length);
  const target = `${stem}${detected}`;
  await rename(filePath, target);
  return target;
}

/** Root of the inbound media tree: `$DSH_HOME/wechat-inbox`. */
export function inboxRoot(dshHome) {
  return join(dshHome, INBOX_NAME);
}

/** A per-day, per-chat directory so a busy group does not flatten into one folder. */
function inboxDir(dshHome, chatId, when) {
  const day = new Date(when ?? Date.now()).toISOString().slice(0, 10);
  const safeChat = String(chatId ?? "unknown").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48);
  return join(inboxRoot(dshHome), day, safeChat);
}

/**
 * Download one inbound media item into the inbox.
 *
 * The protocol client owns the download (CDN URL plus AES-128-ECB decrypt), so it
 * also picks the file name; this wrapper supplies the destination, enforces the
 * size cap, and describes the result for the model.
 *
 * @param {object} options
 * @param {object} options.ilink     protocol client
 * @param {string} options.chatId    peer the message came from
 * @param {object} options.item      the raw inbound item (item_list entry)
 * @param {string} options.dshHome   $DSH_HOME
 * @param {number} [options.maxBytes] inbound cap, default 100 MiB
 * @param {number} [options.now]     clock, injectable for tests
 * @param {string} [options.fileName] force a file name
 * @returns {Promise<{ path: string, kind: string, bytes: number, name: string }>}
 */
export async function saveInboundMedia({ ilink, chatId, item, dshHome, maxBytes = 100 * 1024 * 1024, now, fileName }) {
  const dir = inboxDir(dshHome, chatId, now);
  await mkdir(dir, { recursive: true });
  const savedPath = await ilink.downloadMedia({
    item,
    destDir: dir,
    ...(fileName ? { fileName } : {}),
  });
  const renamed = await ensureMediaExtension(savedPath);
  const info = await stat(renamed);
  if (info.size > maxBytes) {
    await rm(renamed, { force: true });
    throw new Error(`inbound media is ${info.size} bytes, over the ${maxBytes} byte cap`);
  }
  const kind = mediaKindOf(ilink, item);
  return { path: renamed, kind, bytes: info.size, name: baseName(renamed) };
}

/**
 * Check an outbound path before the protocol gets involved: it must exist, be a
 * file, and fit the configured cap. Returns the kind to send it as.
 */
export async function prepareOutbound(filePath, { maxBytes = 100 * 1024 * 1024 } = {}) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${filePath} is not a regular file`);
  if (info.size === 0) throw new Error(`${filePath} is empty`);
  if (info.size > maxBytes) {
    throw new Error(`${filePath} is ${info.size} bytes, over the ${maxBytes} byte cap`);
  }
  return {
    path: filePath,
    kind: outboundKind(filePath),
    mime: outboundMime(filePath),
    name: baseName(filePath),
    bytes: info.size,
  };
}

/**
 * Render an inbound media item as the text handed to the model. A path plus the
 * facts a text-only model can use beats silently dropping the attachment.
 */
export function describeForModel({ kind, path, name, bytes }) {
  const label = kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "voice" ? "语音" : "文件";
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (kind === "image") {
    return `[微信图片] ${path}\n（文件名 ${name}，${size}）用 read_image 工具查看这张图片后再回答。`;
  }
  return `[微信${label}] ${path}\n（文件名 ${name}，${size}）需要时直接读取这个路径。`;
}
