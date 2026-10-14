# dsh-wechat-media

**Personal WeChat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** — scan a QR
code once, then talk to your agent from WeChat: one DSH conversation per contact or group, and two-way
text, images, video, documents and archives. Several WeChat accounts can be paired side by side.

**给 DeepSeek Harness 的个人微信桥**：扫一次码，之后就能在微信里和 agent 对话 —— 每个联系人/群各自
一个独立会话，文字、图片、视频、文档、压缩包**双向**互通，支持**多个微信号同时在线**（小号 + 大号）。

---

## What it gives you / 它能做什么

| Capability | Detail |
|---|---|
| QR pairing | Cards in the Plugins panel. The login token is stored under `$DSH_HOME`, so **restarting dsh does not need a new scan**; re-pairing is one click. |
| One conversation per chat | Every WeChat contact (and group) gets its own DSH session with its own context, created or resumed automatically. |
| Text both ways | Your message becomes a turn; the answer is chunked back to WeChat. |
| Media both ways | Images, video, documents and archives. Inbound files are downloaded and decrypted to `$DSH_HOME/wechat-inbox/<date>/<chat>/`; the agent gets the path, so a text model can read images through `read_image`. Outbound files are uploaded and sent by the agent through its tools. |
| Multiple accounts | Pair a spare account and your main account; each keeps its own token, cursor and session map. |
| Persistence | Accounts, receive cursor, per-peer context tokens, chat→session routes, allowlist and preferences all live under `$DSH_HOME/dsh-wechat-media/`. |

## Requirements / 环境要求

- **dsh 0.2.0-rc.2 or newer** with the standard agent loop and tools (the shipped `dsh web` / desktop
  profiles qualify), Node.js >= 22 (Node 24 tested), Windows / macOS / Linux.
- **A WeChat account that can scan a QR code.** A spare account is strongly recommended: personal WeChat
  automation is against WeChat's terms of service and carries a ban risk, whichever library you use.
- Outbound access to `ilinkai.weixin.qq.com` and `novac2c.cdn.weixin.qq.com`.

## Install / 安装

```sh
# from GitHub
dsh plugin --profile web add github:wjh-ux/dsh-wechat-media

# or from a checkout
dsh plugin --profile web add link:/absolute/path/to/dsh-wechat-media
```

Restart `dsh`, then open **Plugins → `dsh-wechat-media`** and press **Add an account (QR code)**.

重启 dsh，然后在 **插件 → `dsh-wechat-media`** 点「**添加账号（扫码）**」。

## Pairing / 配对

1. The card shows a QR code (it polls its own status and refreshes an expired code automatically).
2. Scan it with WeChat on the phone, confirm on the phone.
3. If WeChat asks for digits, type them into the card and submit.
4. The account appears with a status dot: `monitoring` means the long poll is running.
5. **Add an account (QR code)** stays available at all times — scanning a *different* WeChat account
   adds it as another account, so a spare and your main account can run side by side. Scanning the account
   you already have simply refreshes its login. Each row also has **Pair again** and **Unpair**.
6. Opened the QR by mistake? Press **Cancel** — the attempt disappears immediately instead of waiting for
   the code to expire. (A QR lives five minutes; an attempt gives up after eight, and at most three QR codes
   are issued per attempt.)

The QR encodes the landing-page URL the platform hands out — scanning it is what completes the binding.
Each account is stored under its normalized `ilink_bot_id` (`b0f5860fdecb@im.bot` → `b0f5860fdecb-im-bot`),
with `0600` permissions on the files that hold a token; accounts, cursors and conversation routes are keyed
per account, so several can poll at the same time.

## Where inbound files go / 收件目录

By default inbound media is decrypted into `$DSH_HOME/wechat-inbox/<date>/<chat>/`. That directory is
configurable, and the change takes effect without a restart:

1. **From the card** - the field under *Inbound files are saved in* submits a plain GET form (a navigation, not a
   fetch), so it works even in browsers where the card's requests never reach the plugin.
2. **From the control panel** - `/dsh-wechat-media/panel` has the same field and a *restore default* button.
3. **With the system folder dialog** - *Browse… / 浏览…* (card and control panel) or
   `GET /dsh-wechat-media/pick-folder` opens Windows' own picker on the desktop and saves the choice. A browser
   cannot hand over an absolute path (a directory input only exposes relative names), which is why the dialog is
   opened by the host (`powershell -STA`) rather than in the page.
4. **From the plugin config** - `inboxDir: "D:\\wechat-files"` in the plugin options, used when no runtime
   preference is set.

The order is preference (card/panel) → config → `$DSH_HOME/wechat-inbox`. Only an absolute path is accepted: a
relative one is refused with a message instead of being resolved against the process working directory, because a
silently different directory is worse than the documented default. `GET /dsh-wechat-media/state` reports the
effective value as `inboxRoot`, with `inboxRootDefault` and `inboxRootConfig` for comparison.
## Using it / 使用

Just message the bot from WeChat. A few things the agent can do from inside the conversation:

- answer through the normal reply channel (the bridge relays its final text automatically);
- send **extra** messages or **files** with its tools:

| Tool | Purpose |
|---|---|
| `wechat_send_text` | An extra text message, or a message to a different chat (`to`), pre-empting the automatic relay for that turn. |
| `wechat_send_file` | Send a local file back to WeChat. Images (`.jpg/.png/.webp/.gif`) travel as pictures, videos (`.mp4/.mov`) as videos, everything else (pdf, docx, xlsx, zip, 7z, …) as a file attachment. |
| `wechat_status` | Which accounts are paired and which conversations exist. |

Every incoming message is prefixed with `[微信 <name> <wxid>]` so the agent can pass the right `to` when it
answers a specific chat. Group ids look like `12345678@chatroom`.

## Remote approval / 微信里远程审批

When a WeChat-driven session asks for approval — a tool call the permission preset wants confirmed — the prompt
goes to the same WeChat chat, not only to the GUI:

```
⚠️ 需要你批准一次操作（远程审批）
工具：pwsh
原因：write outside the workspace

回 1 = 批准一次 · 回 2 = 拒绝
```

Answer `1` / `y` / `同意` / `批准` / `/approve` to allow that one call, or `2` / `n` / `拒绝` / `/reject` to
refuse it. The answer is **consumed** — it never becomes a new turn. If nothing arrives within
`approvalTimeoutSec` (default 120 s), or the prompt cannot be delivered, or the turn is aborted, the request is
handed back to the GUI, so an approval is never silently dropped. Set `approval: "ignore"` in the plugin config
to keep approvals in the GUI only.

## Contact allowlist / 联系人白名单

Every chat that writes to the bot is remembered, and the card lists them under **Contacts & groups / 联系人 /
群**, with **Allow / Ignore / Clear** per row and an **Only accept allowlisted chats** switch.

- The switch is **off by default** — otherwise a freshly paired account would look broken to everyone who writes.
- With it on, only chats marked *Allow* reach the agent; *Ignore* and undecided chats are dropped and logged.
- A decision takes effect immediately (no restart) and is stored in `peers.json` beside the accounts.

## Friends only / 只处理好友私聊

**Only answer friends (1:1 chats)** — the card's second checkbox, or `/friends on` from a chat. The protocol
carries no "is a friend" flag, so *friends* means **1:1 chats**: when the switch is on, every **group** message
is dropped, whatever the allowlist says about that group. Direct chats are unaffected.

- **Off by default**: an upgrade must not change who the bot answers.
- Group messages are **ignored silently** (that is the point) but never invisibly: each one bumps
  `counters.groupsSkipped`, `/status` prints `已静默忽略群消息 N 条`, and the card shows the same number.
- It is one preference (`prefs.json`), so the checkbox and `/friends` can never disagree, and it applies to
  personal WeChat and WeCom alike.
- Switching it on **while a group is waiting** answers once in that group to explain the coming silence. Turning
  it off works from a 1:1 chat or the card — a group message is skipped before it could be read as a command,
  which is the honest consequence of "silent".

## WeCom (企业微信) / 企业微信

WeCom works alongside the personal-WeChat bridge, outbound through two paths and **inbound through a third**:

| Path | What you need | Direction |
|---|---|---|
| **Group robot webhook** | one webhook URL from a WeCom group (*群设置 → 群机器人 → 添加*) | out: text, markdown, images |
| **Self-built app** | corpid + corpsecret + agentid of an app (*应用管理 → 自建*) | out: text, markdown, image, file, voice, video |
| **Intelligent robot, long connection** | the robot's BotID + Secret (*智能机器人 → API 模式 → 长连接*) | **both**: messages in, answers back in the same chat |

Configure any of them on the plain page `http://127.0.0.1:19387/dsh-wechat-media/wecom` (also linked from the card
and the control panel), which is where you send a test message from as well. The long connection needs no public
address: the plugin opens a WebSocket to `wss://openws.work.weixin.qq.com` and answers each message through the
frame the platform sent, so a WeCom chat becomes an ordinary DSH conversation - the same session machinery,
allowlist, approvals and reply relay as personal WeChat. Approval requests reach a WeCom chat as a proactive
long-connection message and are answered there with `1` (allow once) or `2` (reject); anything else stays in the GUI,
exactly as on the personal-WeChat side. The agent gets two extra tools:

| Tool | Purpose |
|---|---|
| `wecom_send_text` | Send text or markdown through the configured robot, long connection or app (`to` overrides the recipients). |
| `wecom_send_file` | Send a local file as image / file / voice / video. Over the long connection (or through a self-built app) any type works; with only a group-robot webhook, images do. |

Files travel the other way too: a file sent to the robot is uploaded as a temporary WeCom asset over the long
connection (init -> 512 KiB chunks -> finish -> `media_id`) and then sent, so no app credentials are needed. Uploads
are capped at 100 chunks (~50 MB) and each chunk is retried twice, which is what the platform tolerates; a failure is
reported back instead of being swallowed.

Settings live in `$DSH_HOME/dsh-wechat-media/wecom.json` with mode `0600` - they contain a webhook key, a corpsecret
and the robot secret, so they never go into `prefs.json` or a cordis patch. `GET /dsh-wechat-media/state` reports
whether a secret is set, never its value.

**What stays impossible is the callback API.** It insists on a public HTTPS URL that the enterprise registers, so a
bridge running on your own machine cannot receive that way; the long connection above is what makes two-way WeCom
possible without one.

**Media arrives too.** Images, files and videos sent to the robot are downloaded, decrypted and written to the same
inbox the WeChat side uses (`$DSH_HOME/wechat-inbox/<date>/<chat>/`), then handed to the model as a path plus a
`[企业微信图片] …用 read_image 查看` hint, so a text-only model with a vision plugin can actually look at them. The
scheme is the official one for the long connection (`@wecom/aibot-node-sdk`): `aeskey` is base64 of a 32-byte AES-256
key, the bytes are AES-256-CBC with the `iv` taken from the key's first 16 bytes, PKCS#7 padded to 32 bytes, and the
file name comes from `Content-Disposition` because the payload carries none. Note this is *not* the personal-WeChat CDN
scheme (AES-128-ECB). A download that fails says so in the chat instead of dropping the attachment silently, and
`/state` counts both outcomes (`counters.mediaDownloaded` / `counters.mediaFailed`).

## Chat commands / 聊天里的命令

A message that starts with `/` is addressed to the bridge, not to the agent - it is answered immediately and
never becomes a turn. This works in personal WeChat and in WeCom, and only in chats your allowlist lets
through (a blocked chat cannot run commands either).

| Command | Aliases | What it does |
|---|---|---|
| `/help` | `/h`, `/?`, `/帮助` | Lists the commands. |
| `/status` | `/状态` | Transport, account, chat, DSH session (and how many times `/new` restarted it), the WeCom long connection's state *including its last error*, the counters, approvals waiting, the last message time and the media directory. |
| `/new` | `/reset`, `/新会话` | Starts a new conversation: the chat moves to a new session id, so the old history is neither resumed nor carried over (the transcript stays on disk). The reply says which segment you are on. |
| `/friends` | `/friend`, `/好友` | Turns **only answer friends** (1:1 chats) on or off: `/friends on`, `/friends off`, or no argument to toggle. Group messages are then dropped silently and counted. |
| `/tokens` | `/token`, `/用量` | Token usage per account (and per chat inside it). `/tokens reset` zeroes it; `/tokens 7` sets the clearing window to 1-30 days. |
| `/stop` | `/cancel`, `/停止` | Interrupts the turn running in this chat's session, and says so honestly when nothing is running. |

Anything else starting with `/` gets the command list back rather than a guess; a bare `/` or `//` is an
ordinary message. Commands are counted (`counters.commands`) and recorded in `/state.recentRoutes`.

## Token usage / Token 统计

The bridge records what each **account** spends, per model call, from the `usage` the harness reports on the
`assistant/message` session event - the numbers the model adapter returned, so nothing is estimated. Inside an
account the spend is also split per chat.

- **A window you choose, 1 to 30 days** (default 30). The counters clear themselves at the end of the window.
  The reset is applied lazily whenever the ledger is read or written, so a host that was switched off for a week
  starts a fresh window on its next breath instead of reporting a stale one - and `resets` / `lastResetAt` only
  move when there was actually something to zero.
- **Three ways to see it**: the card's **Token usage** section (one row per account, a window picker and
  *Clear now*), `/tokens` in a chat, and a single line inside `/status`.
- **Where it lives**: `$DSH_HOME/dsh-wechat-media/tokens.json`. Only counters are stored - no prompts, no
  replies, nothing the model said.

## Diagnostics / 排障

- The host logs one line per inbound message with the envelope's identifying fields:
  `inbound group chat=… session_id=… group_id=… room=… from=… type=…` — for a group that settles which id the
  platform expects as the send target.
- `node scripts/probe-group-send.mjs "<chatId>"` sends a labelled test message to one chat, prints the
  platform's `ret` for each addressing variant, and then lists the chats the bridge already knows.
- `GET /dsh-wechat-media/state` (loopback only) returns accounts, monitors, preferences, peers and live
  pairing attempts. `state.wecom.inboundError` and `state.wecom.sessionIssue` answer "why did the bot stop
  answering this chat?": the first is the last failure while handling an inbound WeCom message, the second records
  what had to be done when a stored conversation could not simply be resumed (`resume`, `create`, `retryResume` and
  any replacement id). Both are also shown on the `/dsh-wechat-media/wecom` page.
- `GET /dsh-wechat-media/wecom/inbound-test?chatId=…&text=…&chatType=group` pushes one synthetic callback through
  the **real** inbound path (allowlist, `friends only`, `/commands`, media, the agent). `chatType` defaults to
  `single`; `group` is how a group-only rule is checked without a second person in a real group. The JSON answer
  echoes the `chatType` it used, plus `inboundError` when handling failed. The personal-WeChat twin is
  `GET /dsh-wechat-media/debug/inbound?chatId=…&text=…`, where a chat id ending in `@chatroom` means a group and a
  paired account is required.

## Where things live / 文件位置

```
$DSH_HOME/dsh-wechat-media/            accounts.json, prefs.json, routes.json, peers.json
$DSH_HOME/dsh-wechat-media/accounts/   <account>.json (token, 0600) · <account>.sync.json (cursor)
                                       <account>.context-tokens.json (proactive-send windows)
$DSH_HOME/wechat-inbox/<date>/<chat>/  inbound media, decrypted, with the real extension
$DSH_HOME/wechat-inbox/frames/         frame grabs and other working files the agent creates
```

## Delivery semantics / 发送语义

- The agent's final answer is relayed automatically, chunked at ~2000 characters with a short delay
  between parts. If the turn already used `wechat_send_text` or `wechat_send_file`, the relay stands down,
  so an answer is never delivered twice.
- Replies settle on **that turn's** `turn/end`, not on whole-agent idle: a session shared with the GUI never
  goes idle, which is the classic way a bridge "loses" replies it actually received.
- Messages are deduplicated per account by `message_id`, and the bot's own messages (`message_type: 2`) are
  ignored.

## Implementation notes / 实现要点

Everything here was learned against the live platform; each item broke something first.

1. **`qrcode_img_content` is a landing-page URL, not an image.** The QR has to be rendered locally from that
   URL — which is exactly what the official client encodes. This package vendors
   [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) (MIT, © Kazuhiko Arase) to emit an SVG.
2. **The media key has two encodings.** Outbound `aes_key` is `base64(32-character hex text)` — base64 of the
   hex *string*, not of the 16 raw bytes. Inbound accepts both that and `base64(16 raw bytes)`, so a client
   must handle both.
3. **The upload is AES-128-ECB ciphertext in the body** (`Content-Type: application/octet-stream`), and the
   result is the **`x-encrypted-param` response header**. The reported `filesize` is the *padded ciphertext*
   size (`ceil((rawsize + 1) / 16) * 16`), while `file_item.len` is the plaintext size as a decimal string.
4. **A `getupdates` client-side timeout is normal control flow**, not a failure: the server holds the request
   for its full window. Only real errors back off. `-14` in `ret` or `errcode` means the token is stale:
   re-pair. `HTTP 403` means a second poller is using the same token — one consumer per token.
5. **`ctx.webServer` prefix routes must be registered without a trailing slash.** Its matcher tests
   `pathname.startsWith(prefix + "/")`, so `/x/` would look for a double slash and never match.
6. **Tool parameters must not carry `required: false`.** The harness rejects the schema and the whole plugin
   fails to load; an optional parameter simply omits the field.
7. **A `link:`-installed plugin cannot `import "@deepseek-ai/…"`.** Node resolves from the plugin's own
   directory, which has no such dependency; the Cordis loader can resolve it against the harness root
   (`ctx.loader.internal.import(name, baseUrl, {})`).
8. **A session created by a plugin needs `agentPresets.mount` *and* `meta.agentPreset`.** Without the mount
   the agent publishes against the empty global layer: no tools, no prompt, nothing it could act with.
9. **The plugin-panel card needs a client module that registers the slots itself** (`plugins.bundle.config`
   keyed by package name, `plugins.row.config` keyed `<package>#<row id>`), wrapped in
   `window.__ModuleLoader__.load({ id, factory })`. Exporting a schema is not enough, and a missing wrapper
   fails the web boot.

## Limitations / 已知限制

- **Group sending is unverified but well-founded.** Receiving from a group works today. Every reference
  implementation addresses a chat through `to_user_id` alone — the official client, the Go library
  (`daemon365/weixin-clawbot`, whose `Target` holds only `ToUserID` and whose `ChatType` is inbound metadata
  hardcoded to `direct`) and the Python port (`SiverKing/weixin-ClawBot-API`, which has no `chat_type` field at
  all). This package sends the same way. What is *not* confirmed against the platform is which inbound field
  carries a group's addressable id — `group_id` or `session_id`; the host logs
  `inbound group chat=… session_id=… group_id=… room=…` when a group first writes, which settles it, and if the
  answer is `session_id` the fix is one line in `describeEnvelope`.
- **Stickers and unknown item types are dropped, but visibly.** A message that carries neither text nor a
  downloadable file is counted (`counters.unusable` in `/dsh-wechat-media/state`) and logged with its item
  types instead of vanishing silently.
- **Voice is not bridged as audio.** WeChat's own transcript rides along as text when present; the `.silk`
  payload is downloaded but not transcoded.
- **Proactive sends need an open conversation window.** Without a stored context token for that peer the
  server answers `ret=-2`; write to the bot first and the window opens.
- **One poller per account token.** Two processes using the same token get `HTTP 403`.
- **No message history API** exists on this platform; only live messages are seen.
- Media is capped at 100 MiB inbound by default (`maxMediaMiB`).

## Security / 安全

- No secret is stored in this repository, and none is written into a cordis patch. The bot token lives in
  `$DSH_HOME/dsh-wechat-media/accounts/` (mode `0600` where the OS supports it).
- The plugin never puts the token in a URL. Traffic goes to the two WeChat hosts above and nowhere else.
- The card's HTTP routes refuse anything that does not arrive over loopback.
- **Use a spare WeChat account if you can.** Personal-account automation is at your own risk.

## Prior art / 相关工作

This is not the first WeChat bridge for dsh, and the protocol work stands on Tencent's own MIT-licensed
client. Credit where it is due:

- **`@tencent-weixin/openclaw-weixin`** (MIT, Tencent) — the authoritative implementation of the iLink bot
  protocol this package's `ilink.js` was ported from.
- **[`BiBoyang/dsh-im-bridge`](https://github.com/BiBoyang/dsh-im-bridge)** — turn/approval push, in-chat
  approval, persistent dedup.
- **[`Jesse-njx/dsh-chatnode-wechat`](https://github.com/Jesse-njx/dsh-chatnode-wechat)** — conversation-node
  routing and inbound image handling.
- **[`zhengjy01/dsh-wechat-clawbot`](https://github.com/zhengjy01/dsh-wechat-clawbot)** (and its upstream
  `lubaiUwU/DSH-WeChatClawBot`) — the floating-ball QR panel and the gateway split.

Compared with those, this package concentrates on **media**: the others move text (one of them images) and
none send video, documents or archives. Pick one bridge and stay with it — two of them polling the same bot
token will collide.

## License / 许可

MIT — see [LICENSE](./LICENSE). The vendored QR encoder and the ported protocol client keep their own
notices, listed in [THIRD-PARTY.md](./THIRD-PARTY.md).

WeChat and Weixin are trademarks of Tencent. This project is unofficial and is not affiliated with Tencent
or DeepSeek.
