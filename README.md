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

## Feishu (飞书 / Lark) / 飞书机器人

Two kinds of Feishu bot exist, and both are supported, because they solve different problems.

| | Custom webhook bot | App bot |
|---|---|---|
| Credentials | the webhook URL (and its signing secret, if set) | `app_id` + `app_secret` |
| Can send | text and rich text | text, rich text, images, files, audio |
| Can receive | no | yes - over the **long connection**, with no public URL |
| Config | `feishu.webhookUrl`, `feishu.secret` | `feishu.appId`, `feishu.appSecret` |

### Configuring it from the panel / 在面板里配置（不用 setx，不用重启）

The Web UI panel has a **Feishu** block: App ID, App Secret, the custom-webhook URL and its signing secret, the
platform (`feishu` / `lark`), a default receive id, and the long-connection switch. **Saving reconnects immediately** -
there is no `setx` and no DSH restart, which used to be the only way in.

Values are resolved in this order, so a field the panel leaves alone keeps whatever config or environment provides:

1. what the panel saved (`prefs.feishu`),
2. `config.feishu` in the plugin config,
3. the environment: `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_WEBHOOK_URL` / `FEISHU_WEBHOOK_SECRET` /
   `FEISHU_DOMAIN` / `FEISHU_TO` / `FEISHU_LONG_CONNECTION` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY`.

Two rules make that safe:

- **A blank field is never sent** by the panel's Save button, so saving something else cannot wipe a stored secret.
  Clearing is a separate, deliberate action (the Clear button sends explicit empties).
- **Secrets never come back.** `/state` and `/prefs` report *whether* a secret is set, never its value - one redaction
  helper covers every response that carries prefs (a test found the leak that made this rule necessary).

`feishu.domain` is `feishu` (mainland China) or `lark` (international); an explicit URL also works. `/state` reports
`savedFields` and, per field, whether the value in force came from the panel, the config or the environment.

Tools: `feishu_send_text` (text or markdown, `to` + `toType` optional - `chat_id` by default, `open_id`/`user_id`/`email`
also accepted) and `feishu_send_file` (`path`, `kind` = file/image/audio/video). The reply always says which channel it
used and gives the `message_id`, so "sent" is not a guess.

**A webhook-only setup cannot send files, and says exactly that** rather than reporting a success that never arrived -
the custom bot API has no file message at all. Configure `appId`/`appSecret` for that.

`/feishu` (`/飞书`, `/lark`) reports what is configured - **never the secret itself, only whether one is set** - and
`/feishu test [id] [type]` sends a self-test.

Every endpoint and algorithm here was read from the official `@larksuiteoapi/node-sdk` 1.75.0 source, not recalled:
messages are `POST /open-apis/im/v1/messages?receive_id_type=…`, the token is
`POST /open-apis/auth/v3/tenant_access_token/internal`, media is `POST /open-apis/im/v1/images` and `/files`, an event's
AES key is `sha256(encryptKey)` with the **first 16 bytes of the ciphertext as the IV**, and the event signature is
`sha256(timestamp + nonce + encryptKey + body)` in hex (`sha1` with the verification token when the event is
unencrypted). The custom-webhook signature is the trap of that API - `HMAC-SHA256(key = timestamp + "\n" + secret,
data = "")`, base64 - and it is checked against an independent implementation's published test vector.

### Receiving: the long connection / 用长连接接收（不需要公网地址）

An app bot receives events over Feishu's **long connection** - a WebSocket the bot opens itself - so **no public URL,
no tunnel and no port forwarding are needed**. The event route (POSTing events to a URL Feishu calls) is deliberately
*not* implemented: it is the option that requires a public address.

**Turn it on in the Feishu console, then restart DSH:**

| Step | Where |
|---|---|
| Enable the bot | 开发者后台 → 你的应用 → **应用功能 → 机器人 → 启用** |
| Subscribe over the long connection | 开发者后台 → **事件与回调 → 订阅方式 → 使用长连接接收事件** |
| Permissions | at least `im:message` (send and receive); add the receive scopes the console asks for |
| Publish | 创建版本并发布 - **changes do not take effect until a version is published** |

Configuration: `feishu.longConnection` (default **on**; `feishu.longConnection = false` or `FEISHU_LONG_CONNECTION=false`
turns it off). It only connects when `feishu.appId` and `feishu.appSecret` are configured - a webhook-only setup has
nothing to connect with, and says so.

What happens to an inbound message: text and rich-text messages become a prompt for the model, prefixed like the other
channels; the answer is **posted as a reply under the question** (`message_id`), falling back to an ordinary send if the
reply is refused, and long answers are chunked. Two things are refused on purpose: the bot **ignores its own messages**
(`sender_type: "app"`), because answering them would wake itself in a loop, and a **re-delivered event is answered only
once**.

The protocol facts were read from the official SDK, not recalled - the handshake is `POST {domain}/callback/ws/endpoint`
(request `{AppID, AppSecret}`, response `{code, data:{URL, ClientConfig}}`, whose keys are capitalised and whose
intervals are in **seconds**), the frames are protobuf in the `pbbp2` namespace (`Frame` 1 `SeqID` / 2 `LogID` /
3 `service` / 4 `method` / 5 `headers` / 6 `payloadEncoding` / 7 `payloadType` / 8 `payload` / 9 `LogIDNew`, `Header`
1 `key` / 2 `value`), an event is acknowledged by **sending the received frame back** with a `biz_rt` header and
`{"code":200}`, and a fragmented event is reassembled from `message_id`/`sum`/`seq`/`trace_id` with malformed metadata
**rejected** rather than silently corrupting the payload.

`GET /state` carries a `feishu` block (configuration, connection state, `lastError`, `lastEventAt` and the counters
`feishuEvents` / `feishuAnswered` / `feishuIgnored` / `feishuErrors`), and `/feishu` shows the same in a chat, including
*why* the long connection is not up when it is not.

## Scheduled tasks / 定时任务

A task is a sentence plus a chat: it fires on its own and sends its result there. Three actions, four triggers, and
one switch for the dangerous action:

```text
/task                                   # list, with next run time and last result
/task rm t3k9m2                         # delete
/task off t3k9m2                        # pause     (/task on ... resumes)
/task command on                        # allow `command` tasks to run locally (default off)
```

| Action | What happens at the fire time |
| --- | --- |
| `message` | sends fixed text - no model call, no tokens |
| `prompt` | runs one ordinary agent turn in that chat and delivers the answer |
| `command` | runs a local command and sends its output (needs `/task command on`) |

Triggers accept English and Chinese interchangeably: `daily 08:30` / `每天 08:30`, `weekly mon 09:00` / `每周一 09:00`,
`every 30m` / `每 30 分钟`, `monthly 15 09:00` / `每月15日 09:00` (clamped to short months), `once 2026-10-20 09:00`. Tasks live in `tasks.json` under `$DSH_HOME/dsh-wechat-media/`,
separate from prefs; a task that has run once never fires again for the same window, and a `once` task switches
itself off afterwards.

Ask for one in a chat - "每天 8 点提醒我喝水" - and the agent creates it with `task_add`, targeting the chat that
asked. The Web UI card lists them with Pause / Resume / Delete
buttons and the `command` switch; creation stays in the chat, because a schedule is a sentence rather than a form. `/state` reports `tasks: { count, enabled, nextAt, commandEnabled, ran, failed }`.

## Desktop control (mouse, keyboard, screen) / 桌面控制

Seven tools can drive this machine's own mouse and keyboard, read the screen and manage windows. They are
**off by default** and every one of them refuses until you arm the switch, because they are the only tools here
that act on your screen instead of on the bridge:

```text
/desktop on        # arm  (also: POST /dsh-wechat-media/prefs?desktopControl=true)
/desktop off       # disarm
/desktop           # toggle
```

| Tool | What it does |
| --- | --- |
| `desktop_screen` | virtual screen origin/size in physical pixels, monitor count, pointer position - call it first so coordinates are real pixels |
| `desktop_windows` | visible top-level windows: title, pid, rectangle, minimised |
| `desktop_focus` | bring the first window whose title contains a string to the front, restoring it if minimised |
| `desktop_screenshot` | PNG of the whole screen or a region into the shared inbox, path returned so it can be sent to the chat |
| `desktop_mouse` | `move` / `click` / `double_click` / `right_click` / `middle_click` / `drag` / `scroll` at physical pixels |
| `desktop_type` | type literal text (Unicode scan codes, so Chinese arrives as typed) |
| `desktop_key` | press a chord such as `ctrl+s`, `alt+tab`, `up` |

Three things are deliberate:

- **Off unless armed.** The switch is checked in one wrapper (`desktopTool`) that is the only way to define one
  of these tools, so a new desktop tool cannot forget it. `/state` reports
  `desktop: { enabled, supported, reason }`.
- **Nothing is interpolated into PowerShell.** Coordinates are integers; text and window titles travel as
  base64 and are decoded by PowerShell, so a window title containing `'; Remove-Item …` is data, not code.
- **Windows only, for now.** The scripts use `user32.dll`, `System.Windows.Forms` and `System.Drawing`;
  on any other platform the tools refuse and say which platform they found.

`desktop_screen` also reports the size of the `INPUT` struct the C# compiled, so a wrong layout (which makes
`SendInput` silently do nothing) is visible rather than guessed at.

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
| `/delivery` | `/发送方式` | How a reply is sent: `whole` (the finished answer, once) or `stream` (**word by word**, WeCom only - personal WeChat cannot edit a sent message). No argument shows the current mode. |
| `/auth` | `/授权` | Authorization level for approvals: `/auth 严格` / `适中` / `完全权限` / `仅查看` (also `strict`, `moderate`, `full`, `readonly`). No argument lists them. |
| `/interject` | `/插话` | Turns **interjection** on or off: with it on, a message sent while the agent is still answering joins *that* turn instead of queueing its own. No argument toggles. |
| `/feishu` | `/飞书` `/lark` | Reports the Feishu channels that are configured (**never the secret itself** - only whether one is set), and `/feishu test [id] [type]` sends a self-test through the available channel. |
| `/retry` | `/重试` | Retries a turn **once** when it fails in the transport (a timeout, a reset connection, a rate limit, a 5xx). A deterministic failure is never retried - that would only spend a second call to fail the same way. On by default, and the same switch is a checkbox in the Web UI panel. |
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

## Interjection / 插话

A message that arrives **while the agent is still answering** can either join that turn or wait for its own.

- **Off by default** - the message queues as its own turn, which is what every chat already does.
- **On** (the card's checkbox, or `/interject on`): the message is handed to the running turn with the harness's
  own `agent.steer()`, so it lands in that turn's `next-step` inbox and the model sees it at its next step rather
  than after the answer. (`followup()` - the queueing path - puts it in `next-turn` instead.)
- The switch only steers when there really *is* a turn in flight for that chat and a live agent to steer;
  otherwise the message queues, because "interject" must never mean "dropped on the floor". `/status` shows the
  state and how many messages have been interjected so far.
- Personal WeChat and WeCom behave identically, and the relay keeps a **queue of waiters per session** - a second
  message can no longer replace the first message's waiter (which is what used to lose a reply).

## Authorization / 授权档位

What this plugin does with an **approval request** it receives is a plugin decision, and it has four levels - the
card's menu, or `/auth`:

| Level | What the plugin does |
|---|---|
| **严格** `strict` | Ask in the chat for **every** request, and treat silence as **no** - it never silently falls back to the GUI. |
| **适中** `moderate` *(default)* | Ask in the chat; if nobody answers, the GUI's own prompt stays in charge. This is exactly what earlier releases did. |
| **完全权限** `full` | Never ask here: approvals are left to DSH (with a session policy that asks nothing, that means actions simply proceed). |
| **仅查看** `readonly` | Ask nobody and **refuse** everything that needs an approval - fail closed. |

**Honest scope.** DSH's own session policy - the file sandbox (`read-only` / `workspace-write` / `danger-full-access`) and whether approvals are asked *at all* - belongs to the DSH client, not to a plugin. A plugin can only decide what it does with a request it is given. So with a session policy that never asks, `仅查看` has nothing to refuse: the card and this table say so plainly, and the real read-only switch lives in DSH's own session settings.

## Delivery / 发送方式

How an answer leaves the bridge - the card's **Sending** menu, or `/delivery`:

| Mode | What the chat sees |
|---|---|
| **整段** `whole` *(default)* | The finished answer, sent once. What every earlier release did. |
| **逐字** `stream` | The answer **as it is written**: WeCom's `stream` message is incremental, so the same `req_id` is sent repeatedly with `finish: false` and the final send (which carries the whole answer) closes it with `finish: true`. |

**Only WeCom gets the preview**, and that is a platform fact rather than a shortcut: personal WeChat has no way to edit a
message that was already sent, so a WeChat chat keeps receiving whole answers whatever the setting says - `/delivery`
and the card both say so instead of leaving the option looking broken. Deltas are throttled (roughly 24 characters or
600 ms, whichever comes first) because one message per token would be absurd; a preview that no longer fits a single
stream body is skipped rather than truncated, so the final answer is never cut short. `counters.streamChunks` counts
what was sent, and `/status` shows the current mode.
## Voice / 语音

**Understanding a voice message.** Both platforms transcribe voice themselves, and it is their transcript that reaches
the model - labelled, so the model knows it is reading *speech* rather than something typed:

```
[微信语音（平台转写）] 帮我把这周的日程整理一下
[企业微信语音（平台转写）] 明天上午十点提醒我开会
```

When the platform sends no transcript, that is said plainly (`（平台未提供转写）`) instead of being papered over.
Personal WeChat's audio is saved as well, raw `.silk` - that is the format the protocol hands over, and nothing on a
normal machine can decode it.

**Speaking.** Two tools, one per platform:

| Tool | What it does |
|---|---|
| `wechat_send_voice` | Sends audio through personal WeChat - a **voice bubble** only when the file is SILK, otherwise an **audio file** (see the rule below). |
| `wecom_send_voice` | Sends a **voice bubble** through WeCom (uploaded over the long connection, or the self-built app). |

Either tool takes `text` - which is **spoken on this machine** - or `path` to an audio file that already exists. The
speech is made locally: the system's own engine (SAPI on Windows) writes a WAV, and `ffmpeg` converts it to a chat
format (`mp3` by default, `amr` which is what WeCom specifies for voice, or `wav` which needs no conversion at all).
**No cloud service, no API key, nothing leaves the machine.** If either piece is missing the tool names it
(`windows speech (System.Speech)` or `ffmpeg`) rather than failing silently, and a message it delivered counts as the
answer being delivered (`DELIVERY_TOOLS`), so the relay does not repeat it.

### A voice bubble needs SILK on WeChat - so the rule is explicit

WeChat renders a voice **bubble** only for Tencent's **SILK** codec, and its API additionally requires
`voice_item.playtime` (the duration in seconds). An mp3/amr/wav item is accepted by the API and then **dropped by the
client** - measured here (the text arrived, the voice never did), and corroborated by an independent implementation
with the same symptom ([hermes-agent#9971](https://github.com/NousResearch/hermes-agent/issues/9971)). ffmpeg cannot
encode SILK at all, and this plugin deliberately bundles no dependencies - so `voiceDeliveryFor()` promises only what
the platform can actually show:

| Target | Audio | What arrives |
|---|---|---|
| WeCom | `amr` (default), mp3, wav | a **voice bubble** (verified by ear) |
| personal WeChat | anything | an **audio file** - it arrives and it plays |

**A voice bubble is not deliverable on personal WeChat, and that is measured rather than assumed:** Tencent's own
OpenClaw WeChat channel never sends the `VOICE` media type at all (image/video/file only), the equivalent issue in
another implementation has been open and labelled `blocked` for months, and two live attempts here - mp3 inside an
open conversation window, then SILK with `playtime` - were each accepted by the API and then dropped by the client.
So the tool says what actually happens instead of promising a bubble.

The vendored codec is used for the **other** direction, which does work: WeChat *sends* voice as SILK, and nothing
else on a normal machine can play it, so an incoming voice message is decoded to a **playable WAV** in the inbox
(`silkToWav()`, falling back to the raw `.silk` if decoding fails). That is the same use Tencent's own channel makes
of [`silk-wasm`](https://www.npmjs.com/package/silk-wasm) 3.7.1 (MIT), vendored under `vendor/silk-wasm/` with its
licence and the hash it was verified against; see [THIRD-PARTY.md](./THIRD-PARTY.md).

`playtime` is read from the finished file with `ffprobe` (0 when it cannot be read, and the item then falls back to
its minimum - never an invented number). The tool's reply says which of the two happened, so "sent" never quietly
means "dropped".

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

### Feishu / 飞书

Nine additional tools work with Feishu documents, spreadsheets and bitables. All of them were built against shapes
measured from the live API:

| Tool | Does |
|---|---|
| `feishu_doc_create` | Creates a document **and writes the body**, then returns a link you can open |
| `feishu_doc_read` | Reads a document's text from a `/docx/<id>` link (or a bare id) |
| `feishu_doc_append` | Appends paragraphs to an existing document |
| `feishu_sheet_create` / `_read` / `_write` | Creates a spreadsheet, reads a range, writes a range |
| `feishu_bitable_create` / `_write` / `_read` | Creates a bitable, writes a record, reads records (by id to confirm a write) |

**Document links need your tenant host.** `https://open.feishu.cn/docx/<id>` is the API host and answers a generic
page, so the tools will not build a link from it. Set `tenantHost` (panel or `/prefs?feishuTenantHost=…`) or the
`FEISHU_TENANT_HOST` environment variable to the host you see in any of your own Feishu document URLs, e.g.
`ccnje3t5tkro.feishu.cn`. Without it the tool returns the document id and says why there is no link.

- **Attachments are downloaded into the same inbox as the other two transports.** An image, file, audio or video
  message is fetched with `GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image|file` and lands
  beside the WeChat and WeCom arrivals, so the model gets a path it can open. The `type` parameter is required - the
  live API answers `400 code 99992402` without it - and that was settled against the API rather than guessed. A fetch
  that fails says so in the prompt (`[飞书image未保存] …`) instead of leaving the model to assume there was no
  attachment.
- **`delivery=stream` sends in whole parts on Feishu.** Word-by-word preview is a WeCom feature and is not implemented
  here. `/feishu` states this instead of leaving the setting looking effective.
- **Group messages are not filtered by whether the bot was mentioned**, because the bot's own `open_id` is not
  readable from the SDK source either. Groups behave like WeCom: messages in an allowlisted chat are handled.
- **A long connection that cannot start does not break the plugin.** The reason is recorded and shown by `/state` and
  `/feishu`; the plugin keeps working for every other channel.
- **The long connection has not been verified against the live platform yet.** The endpoint, the request shape and the
  error path were exercised for real (Feishu answered a handshake attempt with `code 1000040345`, and the message did
  not leak the secret), and the protocol is pinned by tests against the official `Frame`/`Header` field numbers - but a
  real inbound message still needs the console switched to "使用长连接接收事件", a published version and a valid App
  Secret. Until that first message arrives, treat this as built and tested, **not** as proven in production.

## Security / 安全

- No secret is stored in this repository, and none is written into a cordis patch. The bot token lives in
  `$DSH_HOME/dsh-wechat-media/accounts/` (mode `0600` where the OS supports it).
- The plugin never puts the token in a URL. Traffic goes to the two WeChat hosts above and nowhere else.
- The card's HTTP routes refuse anything that does not arrive over loopback.
- **Use a spare WeChat account if you can.** Personal-account automation is at your own risk.

## Cookbook / 实战文档

- **[Turning a Word question bank into a Feishu bitable](./docs/build-a-knowledge-base.md)** — the whole pipeline
  behind one real job: a 997-paragraph Word question bank (312 questions, no tables) parsed into structured data,
  deduplicated to 285, corrected in 64 places against the law and the ministries' own wording, uploaded to a
  Feishu bitable, verified field by field, and then used to answer questions inside the chat. It records the
  mistakes as well as the method: soft line breaks that shift paragraph numbers, short-answer blocks that defeat a
  "ends with ？" test, a bitable that ships with four default fields and no tool to add more, and absolute wording
  ("all", "only", "every") as the best detector of a question whose premise does not hold.

  一份 Word 题库从解析、查重、并行事实复核、写入飞书多维表格到逐字段回读校验的完整记录，附带 9 个可复用的
  脚本骨架和这次踩过的坑。

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
