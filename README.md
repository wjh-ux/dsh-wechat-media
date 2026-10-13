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

## Diagnostics / 排障

- The host logs one line per inbound message with the envelope's identifying fields:
  `inbound group chat=… session_id=… group_id=… room=… from=… type=…` — for a group that settles which id the
  platform expects as the send target.
- `node scripts/probe-group-send.mjs "<chatId>"` sends a labelled test message to one chat, prints the
  platform's `ret` for each addressing variant, and then lists the chats the bridge already knows.
- `GET /dsh-wechat-media/state` (loopback only) returns accounts, monitors, preferences, peers and live
  pairing attempts.

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
