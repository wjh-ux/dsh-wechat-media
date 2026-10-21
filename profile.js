/**
 * Import the person's real Chrome state into the profile this plugin launches.
 *
 * Why a copy at all: Chrome 136+ refuses to open `--remote-debugging-port` on the **default** profile directory - the
 * flag is accepted and silently ignored - so a CDP client can never drive the instance a person browses with. The
 * closest honest thing is to bring their state to a profile we are allowed to debug: cookies (which carry the logins),
 * saved passwords, bookmarks and preferences. It is a snapshot, not a sync: whatever happens in one of the two
 * browsers afterwards stays there until the import is run again.
 *
 * What is deliberately **not** copied: the whole `User Data` tree (gigabytes, extension state, caches), `History`
 * (large and of no use to an automation profile), and `Local State`'s sibling files. `Local State` itself is copied
 * because Chrome encrypts cookies with the key stored in it - without that file the copied cookies are unreadable.
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The files that carry "who is logged in", relative to a Chrome profile directory.
 *
 * `Default/Network/Cookies` is Chrome's current location; `Default/Cookies` is the pre-96 one, still present on
 * machines that upgraded. `-journal` files are SQLite's write-ahead log and travel with their database or the copy
 * can open on a half-written table.
 */
export const CHROME_PROFILE_FILES = Object.freeze([
  "Local State",
  "Default/Network/Cookies",
  "Default/Network/Cookies-journal",
  "Default/Cookies",
  "Default/Cookies-journal",
  "Default/Login Data",
  "Default/Login Data-journal",
  "Default/Bookmarks",
  "Default/Bookmarks.bak",
  "Default/Preferences",
]);

/**
 * Copy `files` from one profile directory to another.
 *
 * Missing source files are reported, not fatal: an old Chrome has no `Default/Network/Cookies`, and refusing the
 * whole import over one absent journal file would be the wrong answer. A file that exists but cannot be read (Chrome
 * still holding it open) **is** fatal, because that means the browser was not really closed.
 */
export async function importChromeProfile({
  from,
  to,
  files = CHROME_PROFILE_FILES,
  copyFileImpl = copyFile,
  mkdirImpl = mkdir,
  statImpl = stat,
} = {}) {
  const source = String(from ?? "").trim();
  const target = String(to ?? "").trim();
  if (!source) throw new Error("不知道从哪里导入：找不到你 Chrome 的配置目录");
  if (!target) throw new Error("不知道导入到哪里：插件的浏览器配置目录是空的");
  if (source.toLowerCase() === target.toLowerCase()) {
    throw new Error("源目录和目标目录是同一个，导入会把文件复制给自己");
  }
  const copied = [];
  const missing = [];
  let bytes = 0;
  for (const relative of files) {
    const fromPath = join(source, relative);
    let info;
    try {
      info = await statImpl(fromPath);
    } catch {
      missing.push(relative);
      continue;
    }
    if (!info.isFile()) {
      missing.push(relative);
      continue;
    }
    const toPath = join(target, relative);
    await mkdirImpl(dirname(toPath), { recursive: true });
    await copyFileImpl(fromPath, toPath);
    copied.push(relative);
    bytes += Number(info.size) || 0;
  }
  return { from: source, to: target, copied, missing, bytes };
}
