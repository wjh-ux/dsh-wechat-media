# dsh-wechat-media

**Personal WeChat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** — scan a QR
code once, then talk to your agent from WeChat: one DSH conversation per contact or group, and two-way
text, images, video, documents and archives. Several WeChat accounts can be paired side by side.

**给 DeepSeek Harness 的个人微信桥**：扫一次码，之后就能在微信里和 agent 对话 —— 每个联系人/群各自
一个独立会话，文字、图片、视频、文档、压缩包**双向**互通，支持**多个微信号同时在线**（小号 + 大号）。

**Current release: v1.16.10** · 50 test suites / 807 cases · every capability below has been exercised against a real
service or real hardware at least once (see *What was actually verified*).

---

## What it gives you / 它能做什么

| Capability | Detail |
|---|---|
| QR pairing | Cards in the Plugins panel. The login token is stored under `$DSH_HOME`, so **restarting dsh does not need a new scan**; re-pairing is one click. |
| One conversation per chat | Every WeChat contact (and group) gets its own DSH session with its own context, created or resumed automatically. The same holds for a WeCom or Feishu chat. |
| Text both ways | Your message becomes a turn; the answer is chunked back to WeChat. |
| Media both ways | Images, video, documents and archives. Inbound files are downloaded and decrypted to `$DSH_HOME/wechat-inbox/<date>/<chat>/`; the agent gets the path, so a text model can read images through `read_image`. Outbound files are uploaded and sent by the agent through its tools. |
| Multiple accounts | Pair a spare account and your main account; each keeps its own token, cursor and session map. |
| WeCom (企业微信) | Group-robot webhook, a self-built app, or the intelligent-robot **long connection** (receiving without a public address); streaming previews work on this channel. |
| Feishu (飞书 / Lark) | Custom webhook bot or app bot with a long connection; documents, spreadsheets and bitables through tools - and, as **you**, knowledge bases (知识库) plus the official CLI's whole 200+ command surface (calendar, mail, tasks, meetings, OKR, approval…), because an app is a member of nothing. |
| Editor bridge | A VS Code extension: ask from the panel, stream the answer, let the **AI edit the folder you have open** (`/dsh-vscode/*`, with a 可写 switch) - and **flash the board from the editor**, because the turn runs in that folder and the serial tools take it from there. |
| Automation tools | Browser automation over the DevTools protocol (own profile, your Chrome, or the extension), Office read/write/convert, desktop control, **clipboard**, **SSH**, **serial flashing** (ESP-IDF / esptool / avrdude / STC via stcgal), web search, scheduled tasks, and an RPA-style flow runner. |
| Scraping | **Scrapling**: browser-shaped TLS fingerprint and headers, so a page that rejects a plain `fetch` (`403`, a Cloudflare challenge, a UA check) can still be read - CSS selectors, link extraction, per-call proxy, and a **real-browser mode that drives the Chrome you already have** (no 1.25 GB download) with Cloudflare solving. |
| Lead collection & outreach | **`collect_leads`** turns a goal and a market (`de`, `us`, `ae`…) into a scored, de-duplicated list with contacts, reading the page rather than trusting the search snippet, and telling a buyer from a seller. **`outreach_plan` / `outreach_send`** turn that list into messages over email, WeChat or WeCom - with a cooldown per address, a human confirmation slot, and a stop at the first hard channel failure. |
| Embedded build | **Keil uVision5** through the UV4.exe already installed: `keil_build` runs build / rebuild / clean / flash, and returns every error as `file(line): error C141: message` plus the Program Size and the .hex - so a failed build says *where*. The same module also installs a Tools-menu entry, so the same build is one click inside uVision. |
| Firmware: any board | **`project_build`** reads the folder and picks the toolchain: `.uvprojx` → Keil (C51 through UV4, or MDK-ARM), `sdkconfig` → `idf.py`, `CMakeLists.txt` / `Makefile` → `cmake --build` / `make` with `arm-none-eabi-gcc`. Flashing follows the same logic: stcgal for an STC part, `UV4 -f` for an MDK project, `openocd` / `st-flash` for an ELF, and **`flasher="uart"` (`stm32loader`) for a board with no debugger at all**. `toolchain` and `flasher` override the guess. |
| Multi-agent | With one switch, **each conversation can mount its own agent preset** - its own prompt, tools and model wiring - instead of every chat sharing the host default. Off by default; `/multiagent on`, then `/agent <preset>` per chat. |
| Integrations | `POST /inbound` lets a NAS/CI/monitor speak into a conversation, an outbound **webhook** posts every finished turn (HMAC-signed), and `/dashboard` shows sessions, failures and token spend. |
| Persistence | Accounts, receive cursor, per-peer context tokens, chat→session routes, allowlist and preferences all live under `$DSH_HOME/dsh-wechat-media/`. |

## Requirements / 环境要求

- **dsh 0.2.0-rc.2 or newer** with the standard agent loop and tools (the shipped `dsh web` / desktop
  profiles qualify), Node.js >= 22 (Node 24 tested), Windows / macOS / Linux.
- **A WeChat account that can scan a QR code.** A spare account is strongly recommended: personal WeChat
  automation is against WeChat's terms of service and carries a ban risk, whichever library you use.
- Outbound access to `ilinkai.weixin.qq.com` and `novac2c.cdn.weixin.qq.com`.
- **Optional, for firmware work:** Keil (C51 and/or MDK-ARM) for `.uvprojx` projects; ESP-IDF for `sdkconfig` ones;
  `arm-none-eabi-gcc` + `cmake` + `ninja` for CMake/Make projects; `openocd` or `st-flash` to download them over SWD;
  and `python` with `pyserial` + `stm32loader` for a board that only has a UART. Each one is detected by path, so a
  portable install under `%USERPROFILE%\tools\<pkg>\bin` is found even by a long-running process that never re-read the
  PATH.
- **Optional, for the "act as you" half of Feishu:** the official `lark-cli` (`npx @larksuite/cli@latest install`,
  then `lark-cli config init --new` and `lark-cli auth login --recommend` once). Without it the app-identity tools
  (messaging, docs, sheets, bitables) work normally, and the knowledge-base tools and `feishu_cli` say what is
  missing instead of failing obscurely.

## Install

**On a fresh Windows machine, one script does the environment and the plugin:**

```powershell
# 体检：只看缺什么，不改任何东西
.\scripts\deploy-windows.ps1 -CheckOnly

# 部署：九步依次是
#   1 前置（node / DSH profile）        2 Python 本体（缺了用 winget 装）
#   3 Python 包（pyserial/stcgal/stm32loader）  4 VS Code + ms-python.python 扩展
#   5 arduino-cli + 核心                6 arm-none-eabi-gcc / cmake / ninja / openocd
#   7 Keil 与 ESP-IDF（只检测）          8 插件装进 profile
#   9 插件自带的 VS Code 扩展（vsix）     10 自检（插件自己的解析器 + 冒烟测试）
.\scripts\deploy-windows.ps1

# 只要插件（环境已就绪）
.\scripts\deploy-windows.ps1 -SkipTools -LocalPath D:\src\dsh-wechat-media
```

It is safe to re-run: installed tools are skipped, an existing `package.json` is backed up before it is merged, and a
`node_modules` link that points somewhere else is replaced while a real directory is refused rather than deleted.
Verification is never "the file exists" - every tool is run (`--version`), and the last step asks **the plugin itself**
(`scripts/probe-tools.mjs` calls the same `which()` / `serialSupport()` the plugin uses at runtime) what it can actually
reach, then runs the smoke test.

完整说明（先决条件、十步各做什么、虚拟机怎么装、离线模式、卸载、排错）：**[docs/deploy.md](docs/deploy.md)**。
想要一份能带进虚拟机看的 PDF：

```powershell
python scripts/md-to-docx.py docs/deploy.md deploy.docx   # 需要 python-docx
# 再用 Word / LibreOffice 导出 PDF，或 office_convert deploy.docx
```

What it cannot install for you, and why:

| | 原因 |
|---|---|
| **Keil (C51 / MDK-ARM)** | 要注册账号下载，且许可按商业/非商业区分 - 见 [docs/keil-arm-install.md](docs/keil-arm-install.md)（含直链、SHA256、四个坑） |
| **ESP-IDF** | Espressif 的安装器要选目标芯片与组件；检测已有安装，缺了只提示 |
| **DSH 本身** | 插件是 DSH 的扩展，不是独立程序 |

Machine without the script? The three things it does are small enough to do by hand: put the plugin's checkout on disk,
link it as `<profile>\node_modules\dsh-wechat-media`, and add `"dsh-wechat-media": "link:<path>"` to the profile's
`package.json` plus `dsh-wechat-media` to `dsh.profile.bundles`.
## Install / 安装

```sh
# from GitHub
dsh plugin --profile web add github:wjh-ux/dsh-wechat-media

# or from a checkout
dsh plugin --profile web add link:/absolute/path/to/dsh-wechat-media
```

Restart `dsh`, then open **Plugins → `dsh-wechat-media`** and press **Add an account (QR code)**.

重启 dsh，然后在 **插件 → `dsh-wechat-media`** 点「**添加账号（扫码）**」。

**`Host key verification failed` / `Could not read from remote repository` on install.** pnpm resolves a `github:` spec
over **SSH** (`git+ssh://git@github.com/...`), so a machine without GitHub's host key in `known_hosts` — and without an
SSH key that can read the repo — cannot install it, even though the repository is public. Two ways out:

```sh
# 1. make git rewrite GitHub SSH URLs to HTTPS (no SSH key needed; the repo is public)
git config --global url."https://github.com/".insteadOf "git@github.com:"

# 2. or install a release tarball instead of the shorthand
dsh plugin --profile web add https://codeload.github.com/wjh-ux/dsh-wechat-media/tar.gz/refs/tags/v0.67.3
```

装不上、报 `Host key verification failed`？因为 pnpm 把 `github:` 解析成 **SSH** 地址，而这台机器既没有 GitHub 的主机密钥
也没有能读这个仓库的 SSH key —— 仓库其实是公开的。两条路：把 GitHub 的 SSH 地址重写成 HTTPS（上面第 1 条），或者直接装
release 的 tarball（第 2 条，把版本号换成你要的那一版）。

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

Feishu shows up in three layers, and the layer decides what a tool can reach:

| Layer | Identity | Reaches |
|---|---|---|
| `feishu_send_*`, `feishu_doc_*`, `feishu_sheet_*`, `feishu_bitable_*` | the app (`tenant_access_token`) | messages, its own documents/sheets/bitables |
| `feishu_wiki_*` | the person (`user_access_token` via `lark-cli`) | your knowledge bases, written as you |
| `feishu_cli` | the person | everything else the official CLI can do - 200+ commands, 18 domains |

The first layer needs nothing but an app; the last two need `lark-cli` authorised once (see *Requirements*).

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

Tools, in one place: `feishu_send_text` (text or markdown, `to` + `toType` optional - `chat_id` by default,
`open_id`/`user_id`/`email` also accepted) and `feishu_send_file` (`path`, `kind` = file/image/audio/video) for talking;
`feishu_doc_create` / `feishu_doc_read` / `feishu_doc_append` for documents; `feishu_sheet_create` / `feishu_sheet_read` /
`feishu_sheet_write` for spreadsheets; `feishu_bitable_create` / `feishu_bitable_write` / `feishu_bitable_read` for
bitables; `feishu_wiki_spaces` / `feishu_wiki_new` / `feishu_wiki_upload` for knowledge bases (see below - those three
speak as *you*, the rest speak as the app); and `feishu_cli` / `feishu_cli_help`, which reach the entire official CLI -
every other Feishu feature, as you. A send always says which channel it used and gives the `message_id`, so "sent" is
not a guess.

**A webhook-only setup cannot send files, and says exactly that** rather than reporting a success that never arrived -
the custom bot API has no file message at all. Configure `appId`/`appSecret` for that.

`/feishu` (`/飞书`, `/lark`) reports what is configured - **never the secret itself, only whether one is set** - and
`/feishu test [id] [type]` sends a self-test.

### Knowledge base (知识库): written as you, not as the app / 知识库：以「你本人」的身份写入

Every `feishu_*` tool speaks with a `tenant_access_token`, which is the **application's** identity. Feishu treats an app as a principal of its own: it owns its own cloud space, it is a member of no knowledge base, and nothing of a person's is visible to it. Measured on a real tenant:

- a document created with the app token lands in the app's private drive space, where no person can open it;
- a 知识库 refuses writes from a non-member, so `move_docs_to_wiki` cannot work at all;
- adding an app to a space is an administrator action most individuals cannot perform.

So writes that must land in *your* space go through the official [`larksuite/cli`](https://github.com/larksuite/cli) instead, which holds a `user_access_token` - the same calls run as you, with your knowledge bases, folders and permissions already in scope. It is a different principal, not a different API.

| Tool | What it does |
|---|---|
| `feishu_wiki_spaces` | What this account can write to, and whether the user identity is authorised yet |
| `feishu_wiki_new` | Create a knowledge base |
| `feishu_wiki_upload` | One file, or a whole local folder tree: one node per top-level folder, skipping nodes and files already present, so a retry never duplicates |

One-time setup. The plugin stores no Feishu credentials of its own - `lark-cli` keeps them in the OS keychain, and `lark.js` only locates the binary, runs one command and parses the JSON it prints:

```bash
npx @larksuite/cli@latest install
lark-cli config init --new       # creates a CLI-only app in your tenant; two clicks in the browser
lark-cli auth login --recommend  # scan once - this is the "as you" identity
```

Uploads are idempotent by design: re-running `feishu_wiki_upload` over the same folder adds only what is missing, so a half-finished run is retried rather than duplicated. Lesson folders are flattened into their chapter on purpose - a course download of 5 chapter folders / 14 lessons / 49 documents becomes five nodes you can open, not a three-level tree you have to click through.

These tools complement the rest rather than replace them: sending messages, reading documents and editing sheets work fine as the app. Anything that must be **owned by a person** goes through the three above.
### The whole lark-cli surface / 全部 lark-cli 能力

The dedicated `feishu_*` tools are the common paths, not the ceiling. The official CLI ships **200+ commands across 18 domains** - messaging, docs, base, sheets, slides, calendar, mail, tasks, meetings, minutes, wiki, OKR, approval, attendance, contacts, drive, apps, markdown - and two tools make all of it reachable:

| Tool | What it does |
|---|---|
| `feishu_cli_help` | Prints the CLI's own help: no argument for the domain list, `docs` for a domain, `wiki +node-create` for one command's flags. This is how a command is discovered rather than guessed. |
| `feishu_cli` | Runs any command as the person who authorised the CLI, e.g. `args="calendar +agenda"` or `args="docs +search --query 周报"` or `args="task +get-my-tasks"`. `--json` is added automatically; `raw=true` returns text. |

Why a bridge and not 200 tools: 200 schemas would ride in every prompt, and the list would be wrong the first time lark-cli ships a domain. The CLI stays the authority on what exists; the plugin only adds the identity, the error envelope and the guard rails.

Three behaviours worth knowing:

- **No shell anywhere.** The command line is tokenised in-process and passed as argv, so a title with a space, an `&` or an empty string reaches the CLI exactly as typed.
- **Interactive commands are refused**, not run: `auth login`, `config init`/`remove` and friends wait on a browser round-trip, which inside a tool call is a hang until the timeout. Run those once in a terminal.
- **Destructive commands need a second word.** Anything carrying `--yes` (deletes) is refused unless `confirmDanger: true` is passed, because a model that types `--yes` is not the same thing as a person who agreed to it.

Every endpoint and algorithm here was read from the official `@larksuiteoapi/node-sdk` 1.75.0 source, not recalled:
messages are `POST /open-apis/im/v1/messages?receive_id_type=…`, the token is
`POST /open-apis/auth/v3/tenant_access_token/internal`, media is `POST /open-apis/im/v1/images` and `/files`, an event's
AES key is `sha256(encryptKey)` with the **first 16 bytes of the ciphertext as the IV**, and the event signature is
`sha256(timestamp + nonce + encryptKey + body)` in hex (`sha1` with the verification token when the event is
unencrypted). The custom-webhook signature is the trap of that API - `HMAC-SHA256(key = timestamp + "\n" + secret,
data = "")`, base64 - and it is checked against an independent implementation's published test vector.

## QQ bot (QQ 开放平台) / QQ 机器人

An official QQ bot, over the open platform's **WebSocket gateway** - outbound only, so it works from a plugin on your own
machine with no public URL, exactly like the WeCom and Feishu long connections.

```text
/qq                     # switch, credentials presence, connection state, last error
/qq on | off            # connect / disconnect
```

Credentials go in the card's QQ block (or `POST /prefs` with `{"qq":{...}}`): `appId`, `clientSecret`, and `sandbox` for a
sandbox bot (which also uses a different API host). The secret is stored, never echoed back.

Three details that decide whether a QQ bot works at all, all handled here:

- **The reply must quote the message it answers.** `sendMessage` sends the inbound `id` as `msg_id` (plus a `msg_seq`), or the
  platform treats it as a *proactive* message - a different permission, usually a rejection.
- **C2C and group chats are different endpoints**: `/v2/users/{user_openid}/messages` vs
  `/v2/groups/{group_openid}/messages`, and the openid comes from the event, not from anything you can guess.
- **The intent matters**: group and C2C messages are gated behind `1 << 25`; asking for more than the bot was granted is
  what makes an identify fail with 4014.

**Verified against a live bot** (appId `1903374412`, display name *PawDesk*): the gateway answered `READY`, a private
chat message produced an answer through `/v2/users/{openid}/messages`, and an @ in a real group produced one through
`/v2/groups/{group_openid}/messages`. The allowlist blocked both the first private message and the first group message until
the chat was allowed - which is what it is for, and it is visible in the counters (`blocked`) rather than silent.

## Multi-agent: one agent per conversation / 多 agent

Every conversation already had its own session *and its own agent object*; what this switch changes is **what that agent
mounts**. With it on, a chat can mount its own agent preset - its own prompt, tools and model wiring - remembered on the peer
record. With it off (the default) every chat mounts the host default, exactly as before.

```text
/multiagent                # the switch and this chat's preset
/multiagent on | off       # off by default
/agent                     # the presets the host exposes, and which one this chat uses
/agent <preset id>         # set it for this chat
/agent reset               # back to the default
```

`/agent model <provider>/<model>` pins the model for that one conversation, and `/agent model reset` clears it.
**With nothing set, the chat uses the host's own selection** - there is no built-in default override, because one would move
every conversation onto a model nobody chose and show up as a billing surprise rather than a setting. The override obeys the
same switch as the presets, and `/state`'s `conversations[].agentModel` proves which model a chat actually asked for.

\`/agent model\` with no argument prints the host's own selection, because that value is known to work - change the model half
and keep the provider half. Switching provider is warned about when it is set, since the new route needs its own API key.

`/agent model list` asks the host's `llm` service and prints what is actually selectable. On this machine it reports two
providers with the same two models:

```text
deepseek-official            deepseek-account · 宿主在用
 · deepseek-flash             · deepseek-flash   ← 宿主默认
 · deepseek-v4-pro            · deepseek-v4-pro
```

So the safe edit is a model name inside the provider the host already uses (`deepseek-account/deepseek-v4-pro`); the other
provider route needs its own `DEEPSEEK_API_KEY`.

On this machine the host's own selection is `deepseek-account/deepseek-flash`, and that is the value to copy: the provider
half is the part that carries credentials. Pinning `deepseek-official/deepseek-chat` instead fails with
`no API key for provider route "deepseek-official"` - a different provider route is a different account, not a different
model name. `/agent model` prints the host's value for exactly that reason, and switching provider is warned about when it is
set.

\`/agent model list\` asks the host's own \`llm\` service for every provider and its models and marks the one in use, so a
model name never has to be copied from the Models page or guessed; \`/agent model list <provider>\` narrows it.

Three statements the commands make rather than hide:

- **A preset change is not a live swap.** It applies when the session next creates an agent, and the reply says so.
- **With the switch off, `/agent <id>` refuses to look like it worked.** It names the switch that is off, because storing a
  value that will never be read is worse than declining.
- **The preset list is read defensively** (`list` or `all`, ids or names). If a host exposes neither, setting by id still
  works but stays unverified until an agent is built - and the command prints that sentence itself.

The card carries the matching checkbox: **每个会话可挂自己的 agent 预设**.

On this machine the host declares four presets - `standard`, `ptc`, `minimal`, `cordis` - and `/agent minimal` followed by
`/new` put `"minimal"` into `GET /state`'s `conversations[].agentPreset` once the next message created the agent. That is the
whole point of the switch: two conversations can be running **different presets at the same time**, and the selection
survives restarts because it lives on the peer record.

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
asked. The three tools are the same three operations the `/task` commands type: `task_add` (trigger + action + text),
`task_list` (next run time and last result), `task_remove` (add `disableOnly` to pause instead of delete); `/state`
reports `tasks: { count, enabled, nextAt, commandEnabled, ran, failed, items }`.

### What people actually schedule / 实际用法

| You want | The schedule | Action |
| --- | --- | --- |
| A weather line before work | `每天 07:30` | `prompt`: "用一句话说今天厦门天气，再给一句提醒" |
| A digest of a group at noon | `daily 12:00` | `prompt`: "总结今天群里值得看的消息，五条以内" |
| A weekly report on Monday | `每周一 09:00` | `prompt`: "汇总上周完成的事，写成三条" |
| A monthly reminder | `每月1日 10:00` | `message`: "该交房租了" |
| A one-off, then again next week | `once 2026-10-20 09:00` + `[+1周] [再次运行]` | any |
| Watch a folder every half hour | `every 30m` | `command` (needs `/task command on`) |

`prompt` is the interesting one: it runs a **normal agent turn**, so every tool the agent has is available to it -
web search, files, Feishu. A scheduled prompt is therefore "ask me this every morning and do the work", not a
canned message.

### The card / 面板

The Web UI card is the management half; creation works both there and in a chat.

| Control | When it appears | What it does |
| --- | --- | --- |
| time + action + text + `添加` | always | create a task targeting the chat that last wrote |
| `[暂停]` / `[恢复]` | recurring tasks | stop and restart the schedule |
| `[+1 天 ▾] [再次运行]` | finished one-offs | move it forward one day / week / month and re-enable |
| `☐ 完成后再排一次` | one-offs | re-arm automatically after each run (same clock time, next day) |
| `[删除]` | always | remove it |
| `☐ 允许 command 任务执行本机命令` | always | the switch behind `command` tasks (default off) |

A finished one-off shows `✅ 已跑完（一次性任务，不能暂停）` rather than a pause button that would do nothing: `dueTasks`
compares the last run against **that occurrence's** `atMs`, so re-arming is meaningful and a plain resume is not.

Two more behaviours worth knowing:

- **Missed runs are skipped, not replayed.** A task more than 60 minutes late (a laptop that slept, a bridge that was
  stopped) is recorded as missed and the schedule moves on - the alternative is every missed `prompt` task firing in
  the same second when the machine wakes. `taskGraceMinutes` in prefs tunes it; `0` means "always run, however late".
  `/state` shows `tasks.skipped` next to `ran` and `failed`.
- **Any chat can be targeted.** `task_add` takes `transport` (`wechat` / `wecom` / `feishu`) with `to`, so a task can
  be created for a group you have not just spoken to; without it, the default is still "the chat that asked".

## Office documents / 办公文档

Four tools read, create and convert `.docx` / `.xlsx` / `.pptx`, and export PDF or page images. They are a thin,
honest surface over two programs already on this machine - the runtime's own Python (`python-docx`, `openpyxl`,
`python-pptx`) and the LibreOffice Kit CLI - so nothing is bundled here and nothing is installed at run time:

| Tool | Does |
| --- | --- |
| `office_read` | text and structure: paragraphs, tables, sheets with rows, slide texts |
| `office_write` | create from a JSON spec (below) |
| `office_convert` | `.docx/.xlsx/.pptx` → PDF, source untouched |
| `office_render` | pages (or a sheet range) → PNG, for a visual check or to send as a picture |

```jsonc
// .docx
{"title": "季度报告", "blocks": [
  {"type": "heading", "level": 1, "text": "一、概述"},
  {"type": "paragraph", "text": "正文"},
  {"type": "bullets", "items": ["要点一", "要点二"]},
  {"type": "table", "rows": [["项目", "数值"], ["收入", "120"]], "header": true}
]}

// .xlsx
{"sheets": [{"name": "报表", "rows": [["月份", "收入"], ["1月", 120]], "widths": [12, 10], "header": true}]}

// .pptx
{"slides": [{"title": "第一页", "bullets": ["背景", "结论"]}]}
```

`/office` prints which program each capability needs and whether it was found; `/state.office` carries the same
answer for a script. A missing program is named (`找不到 Python（设置 officePython…）`) rather than reported as a
broken document - the toolchain and the file are different problems and must not look alike.

Create a file, then send it: the bridge already has `send_file` for WeChat, WeCom and Feishu, so "做个 Excel 发我"
is `office_write` then `send_file`.

Relative paths land in **`officeDir`**, printed by `/office`:

```text
/office                      # toolchain + the directory relative paths use
/office dir D:\报表\2026     # set it (also /prefs?officeDir=…, or DSH_OFFICE_DIR)
```

Empty means "the bridge's working directory" - workable, but forgettable, which is why `/office` always prints the
effective path instead of expecting anyone to remember it.

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

## Clipboard / 剪贴板

Two tools move things through the clipboard, which is how "我复制了一段…" becomes something the model can read, and how
a result ends up where the next `Ctrl+V` will find it:

| Tool | What it does |
| --- | --- |
| `clipboard_read` | the copied text (capped at 200k characters) and the file list currently on the clipboard |
| `clipboard_write` | put `text` on the clipboard, or `paths` (comma / newline separated) as a **file-drop list** (Explorer pastes those as files) |

```text
/clipboard on|off|status     # on by default; /clip 也行
```

- **On by default, with an off switch.** A clipboard can hold a password, so `/clipboard off` is one command away and
  both tools refuse immediately once it is set. The switch is checked in one place, before any script runs.
- **Files win over text** when both are given: a clipboard holds one thing, and a file has no other way to be pasted.
- **Windows goes through WinForms on an STA thread** (`powershell.exe -STA`), which is what makes `SetText`/`GetText`
  reliable from a service-like process. macOS uses `pbcopy`/`pbpaste`, Linux `wl-copy`/`wl-paste`; a file list is
  Windows-only and the other platforms say so instead of silently copying nothing.
- **The protocol is base64, and that is not decoration.** The first version printed JSON straight to stdout and every
  Chinese character came back as `?`, because `powershell.exe` writes stdout in the console codepage. Each script now
  emits the base64 of its UTF-8 JSON and the runner decodes it - `剪贴板自检` round-trips unchanged, and a test drives the
  fake runner with exactly that string.
- The size cap is applied **inside** the PowerShell script, so a 20 MB clipboard never travels through stdout to then be
  thrown away.

## SSH / 远程命令

Three tools drive the platform's own OpenSSH client - the binaries ship with Windows 10/11, honour `~/.ssh/config` and
`known_hosts`, and keep the private key exactly where it already is. Nothing here reads a key's contents; only its path.

| Tool | What it does |
| --- | --- |
| `ssh_exec` | run one command on a host, return exit code + stdout + stderr + timing |
| `ssh_upload` | copy a local file (or directory, `recursive`) to the host, via `scp` |
| `ssh_download` | copy a file (or directory) from the host |

```text
/ssh                      # status: switch + host list
/ssh on | off             # arm / disarm  (off by default)
/ssh add nas root@192.168.1.10:22 [C:\Users\me\.ssh\id_ed25519]
/ssh remove nas
```

Hosts live in one prefs block (`prefs.ssh`), so the card, `/state` and the tools read the same list; a tool also accepts
an ad-hoc `user@host[:port]` without saving it.

Three decisions, each because the alternative fails silently:

- **Key-based only, always `BatchMode=yes`.** A password cannot be typed into a service-like process, so an auth problem
  must fail immediately with the client's own message instead of hanging the turn. No password is ever stored.
- **`StrictHostKeyChecking=accept-new`.** A new host key is learned once and a **changed** one is refused: `no` would
  accept a man-in-the-middle, `yes` would make the first connection impossible.
- **Off until `/ssh on`.** Running commands on someone's servers is not a default-on capability, and the gate is checked
  before any process starts.

`scp` gets `-P` for the port (its `-p` means "preserve times"), the command is placed after `--` so a remote command
starting with `-` is not read as an option, and captured output is capped at 40k characters with an explicit
"已截断" marker rather than a silent cut.

## Serial: flash a board and read it back / 串口烧录

Three tools drive the toolchain people already have - ESP-IDF's `idf.py`/`esptool`, or `avrdude` for AVR - instead of
reimplementing a bootloader protocol, because that is how a tool ends up bricking a board.

| Tool | What it does |
| --- | --- |
| `serial_ports` | the COM ports with the device name behind each (COM3 vs COM4 means nothing without "Silicon Labs CP210x"), plus which flashers were found |
| `serial_flash` | flash: `flasher=idf` runs `idf.py -p COMx flash` in an ESP-IDF project (offsets come from its sdkconfig); `esptool` writes one `.bin` at an offset; `avrdude` flashes a `.hex` |
| `serial_monitor` | read what the board prints for N seconds (default 8) and return it |

An **STC (8051)** board uses `flasher=stcgal`: STC speaks its own ISP protocol, so `esptool` cannot touch it. Pass
`chip=stc8g` (or leave it `auto`); `stcgal` passes `-A dtr`, which cold-starts the MCU over DTR - measured on an STC8H1K08,
it handshakes without unplugging the board. `stcgal` is found on PATH **or** inside any ESP-IDF python env, because that is
where `pip install stcgal` puts it on a machine that already has ESP-IDF. AVR boards use
`flasher=avrdude`, and an ESP-IDF project uses `flasher=idf` - which runs inside `export.ps1`, because `idf.py` cannot see
cmake otherwise.

```text
/serial                 # switch, baud, default port, ports, toolchain
/serial on | off        # off by default: flashing writes a board's flash
/serial baud 460800
/serial port COM3
```

Then, from the **VS Code panel** with the project open: *"把这个项目烧到 COM3"* - the turn runs in the open folder, so
`serial_flash` with `flasher=idf` and `projectDir` set to that folder flashes the project's own build.

From the **VS Code panel**, with the project open:

```text
COM3 上插的是什么板子？                 -> serial_ports
把这个项目烧到 COM3                     -> serial_flash (flasher=idf, projectDir = the open folder)
把 Objects\app.hex 烧到 COM3           -> serial_flash (flasher=stcgal / avrdude, by file type)
读 10 秒串口看看它在打印什么              -> serial_monitor
```

Four rules, each because the alternative is silent damage:

- **Off until `/serial on`** - writing a board's flash is not a default-on capability.
- **Never guess the port**: a port must be named, or there must be exactly one. Two ports and no answer is "say which
  one", not "pick the first" - and a named port that is not plugged in is refused with the list of the ones that are.
- **The exact command is echoed** with every result, so a failed flash can be repeated by hand instead of guessed at.
- **One owner per port**: the monitor opens the port exclusively, so a flash and a monitor cannot overlap - the second
  one fails with a reason rather than stealing the port mid-flash.

A board answers on real hardware, and that is where the interesting bugs were. On an STC8H1K08 behind a CH340, `serial_ports` reported `COM3 — USB-SERIAL CH340 (COM3)`; `serial_monitor` read `TEMP:28.1C` twice a second; `serial_flash` wrote `DS18B20_TM1650.hex` (3129 bytes, `Target UID: F734C3FC31F408`) and the board printed `TEMP:27.6C` straight afterwards. Three fixes came out of that test rather than out of reading the docs: `/prefs` dropped the `serial` block silently, `idf.py` could not see cmake without `export.ps1`, and stcgal's tqdm bar arrived as mojibake and hid the verdict.

The flasher's verdict lives in its last lines ("Hash of data verified", "avrdude done"), so output is *tailed* rather
than capped from the start. Discovery is real: on this machine it found `D:\Espressif\frameworks\esp-idf-v4.4.8` with
its `python_env` interpreter - and reported "no serial ports" when no board was plugged in, rather than inventing one.

## Firmware: Keil, ESP-IDF or CMake — pick by folder, override when you disagree / 固件编译与烧录

`project_build` is the one entry for three families. It reads what is actually in the folder and prints what it found;
`toolchain` and `flasher` override the guess, because detection is a default and not a verdict.

| Folder says | Build | Flash |
|---|---|---|
| `.uvprojx` + `<Vendor>STC</Vendor>` | `UV4 -b` | **stcgal** (serial ISP - uVision has no driver for it) |
| `.uvprojx` + ARM (MDK installed) | `UV4 -b` | `UV4 -f` through the project's own ST-Link/J-Link |
| `sdkconfig` (or `CMakeLists.txt` + `main/`) | `idf.py -C <dir> build` | `idf.py -C <dir> -p COMx flash` (builds first) |
| `CMakeLists.txt` | `cmake --build build` | `openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -c "program x.elf verify reset exit"` |
| `Makefile` | `make -C <dir> -j` | same as CMake; `st-flash write x.bin 0x8000000` when stlink-tools is what is installed |
| any of the above, **no debugger at all** | as above | `flasher="uart"` → `python -m stm32loader -p COMx -b 115200 -f F1 -e -w x.bin -v`, with `BOOT0=1` and a reset first |
| `.ino` (Arduino sketch) | `arduino-cli compile --fqbn arduino:avr:uno <dir>` | `arduino-cli compile --fqbn … --upload -p COMx <dir>` (one command: a bare `upload` needs a sketch compiled first) |

```text
project_build(dir="D:\\work\\my_f4", action="build")
project_build(action="flash", flasher="openocd", target="stm32f4")
project_build(dir="D:\\work\\my_esp32", action="flash", port="COM3")
```

`/prefs` takes a `build` block (`{"toolchain":"idf","flasher":"openocd","dir":"…"}`) and an unknown value is refused
rather than silently stored as `auto`, so "which compiler does this use" has one answer a script can read.

**Arduino is the fourth family, and it needs one fact the others do not: the board.** `arduino-cli` names a board with an
FQBN (`arduino:avr:uno`), and which FQBN applies is read from, in order: `sketch.yaml` (`default_fqbn:`, which is what
`arduino-cli sketch new` writes), the `board` argument, or `arduino-cli board list --format json` - the last one only
answers for a board that is actually plugged in, which is exactly right for `upload` and useless for `compile`. A sketch
is recognised the way arduino-cli recognises one: a folder containing a `.ino` of the same name.

Verified here without any board: the same Blink sketch compiled for **two** boards - `arduino:avr:uno` → `Sketch uses
924 bytes (2%)` and `esp32:esp32:esp32` → `Sketch uses 282984 bytes (21%)` - with the AVR core (`arduino:avr@1.8.8`)
installed by this README's instructions and the ESP32 core that was already on the machine. The upload leg is the same
`arduino-cli upload` call and needs a board on a COM port.

**Install notes are in [docs/keil-arm-install.md](docs/keil-arm-install.md)**: the download page and its direct link, the
installer's size and SHA256, the device pack URL, the licence activation, and the four traps this install produced.

**ESP-IDF, on the same board (v1.19.6):** an unmodified `examples/get-started/hello_world`, copied out of the IDF tree.
`project_build(action="build")` → `Project build complete` in 162 s; `action="flash", port="COM6", baud=115200` →
`Hash of data verified` three times, `Hard resetting via RTS pin`. The board then printed its own banner:

```
Hello world!
This is esp32 chip with 2 CPU core(s), WiFi/BT/BLE, silicon revision v3.1, 2MB external flash
Minimum free heap size: 300936 bytes
```

Four things this cost, all now handled in `idfWrap()`:

- **`idf.py` cannot be spawned at all** - it is a `.py` file, so `spawn` fails with `EFTYPE`. It also needs cmake, ninja and
  the xtensa toolchain on PATH, which only ESP-IDF's `export.ps1` provides, so the command runs inside one PowerShell
  session that sources it first.
- **The script must be the interpreter's first argument.** `python -C dir build` makes python read `-C` as its own option
  (`Unknown option: -C`); it has to be `python <idf.py> -C dir build`.
- **Do not clear PATH to get rid of the "Not using an unsupported version of tool cmake found in PATH" lines.**
  `export.ps1` calls `python` itself, so emptying PATH makes the export fail and then idf.py says
  `'cmake' must be available on the PATH`. Those warnings are harmless: export.ps1 prepends ESP-IDF's own tools.
- **460800 baud is too fast for this CP210x board.** The first flash wrote the app and failed on the next image with
  `Invalid head of packet (0x78): Possible serial noise or corruption`; `-b 115200` completed. The very first attempt also
  hit `Wrong boot mode detected (0x13)` and simply needed a retry.

**ESP32, on the real board (v1.19.5):** a CP210x board on COM6, `project_build(action="flash", port="COM6")` →
`arduino-cli compile --upload` → `Wrote 298160 bytes (158774 compressed) at 0x00010000 in 2.4 seconds`,
`Hash of data verified`, `Hard resetting via RTS pin`. The sketch printed its own evidence over the same port:

```
ESP32 alive #15  (uptime 14s)
ESP32 alive #26  (uptime 25s)
```

Three things that board taught:

- **`arduino-cli board list` cannot identify a CP210x ESP32.** The port reports only `vid 0x10C4 pid 0xEA60` and no
  `matching_boards`, so the FQBN has to come from `sketch.yaml` - which is why that is consulted before the port scan.
- **Opening the port resets the board** (`rst:0x1 (POWERON_RESET)`), and the banner is in the first 300 ms - read
  immediately, do not discard the buffer. `DtrEnable = false; RtsEnable = false` keeps the auto-reset circuit quiet.
- **`arduino-cli upload` alone fails** with `Compiled sketch not found in ...sketches\<hash>`; `compile --upload` is the
  command that means "flash this project".

**Verified with Keil MDK-ARM itself (v1.19.0):** MDK-ARM 5.43a was installed next to the existing C51 install, and the
project in `scripts/arm-keil-template/` built through `keil_build` in 1.9 s:
`Program Size: Code=444 RO-data=252 RW-data=0 ZI-data=1632`, `.axf` and `.hex` produced, `0 Error(s)`. Deliberately
breaking one line gave exit code 2 and `main.c(19): error: use of undeclared identifier 'notDeclared'` - the ARMCC6
dialect parsed with a file and a line, not a wall of log. Three things that only a real install could teach:

- **A machine can hold two Keil installs and they do not share toolchains.** C51 lives in `D:\Keil_v5`, MDK-ARM in
  `%LOCALAPPDATA%\Keil_v5` (the 5.43 installer's default). Handing an ARM project to the C51 `UV4.exe` is not a warning,
  it is a build that fails saying the toolchain is missing - so `uv4ForFamily()` now picks by the project's device
  family and the answer names the `UV4.exe` it used.
- **The scatter file must be explicit.** A hand-written minimal project failed with `*** Scatter Error: no default
  'Read/Write' range selected` and then `L6031U: Could not open .sct`; the fix is a checked-in `.sct`, not a dialog.
- **Do not copy a pack example.** The STM32F1 pack's `Blinky` uses Keil RTX, so uVision aborts the build with "uses RTOS
  support that is part of a Legacy Pack" - a download unrelated to what the example was being used for.

**Verified on a real board (STM32F103C8T6 clone, no ST-Link):** wired PA9/PA10 to the CH340 that was already on COM3,
`BOOT0=1` + reset, `flasher="uart"` wrote 212 bytes, `Verification OK`, the 212 bytes were read back and hashed
identical, and the LED blinked after `BOOT0=0` + reset. Two things that board taught that no datasheet would have:

- **The silkscreen lied about the memory.** `C8T6` means 64 KiB flash / 20 KiB RAM, but the chip reports
  `Chip id 0x412` (low density) with `Flash size: 32 KiB` — a clone. A 20 KiB stack top (`0x20005000`) is past the end
  of 10 KiB RAM, so the firmware flashed cleanly, verified, and then hard-faulted in a reset loop with no LED. The linker
  script must be sized from what the chip *says* (`0x412` → 32K/10K), not from what is printed on it.
- **A cloned bootloader needs the reset, not just the jumper.** Moving BOOT0 to 1 does nothing until the chip is reset;
  `stm32loader` reports `Can't init into bootloader` during that window, which reads like a wiring fault and is not one.

`scripts/stm32-template/` is that project: a 212-byte bare-metal blink (C vector table, register-level GPIO, 32K/10K
linker script) with `cmake/mcu.cmake` holding the three things a different chip needs.

**What this machine can do right now** is part of the answer, not something to discover by failing: this box has
ESP-IDF v4.4.8 and Keil **C51 only** (no `ARM/` folder), and no `arm-none-eabi-gcc`, `openocd` or `st-flash` - so an
STM32 project needs one of those installed first, and the tool says which.

## Keil uVision5: build from the chat, and from uVision itself / Keil 编译

`keil_build` drives the **UV4.exe already installed** - C51 or MDK - and reads the log it writes, because that log is
the only place a uVision build says *which file, which line*. It does not reimplement a compiler, for the same reason
`serial_flash` does not reimplement a bootloader.

```text
/keil                                        # status: is UV4 found, which project, which target
/keil on                                     # arm it (default off)
/keil project D:\work\blinky.uvprojx         # remember the project (its targets are listed back)
/keil target "MCBx51: 8xC51Rx"               # pick a target, or leave it to the project default
/keil build                                  # build; rebuild / clean / flash as well
```

On the card (Plugins → `dsh-wechat-media`) the same switch sits next to the serial one: a checkbox for `/keil on`, a
**Project** field with a **Browse…** button (the native file dialog, because a page cannot learn an absolute path), a
**Target** dropdown filled from the project's own `<TargetName>` entries, and one line saying which `UV4.exe` was found
- or why none was. Everything saves through `/prefs`, so the panel, a script and a chat command are three ways to write
one preference rather than three sources of truth.

The tool is the same four actions: `keil_build(project?, action?, target?, timeoutMs?)` with
`action = build | rebuild | clean | flash`. `flash` is `UV4 -f`, which downloads through the project's own debugger
settings - it writes the chip, which is why the whole thing is off until `/keil on`.

What comes back is a verdict, not a wall of log:

```text
❌ 编译失败（退出码 2，1714ms）
工程：D:\work\blinky.uvprojx
Target：MCBx51: 8xC51Rx
  ✖ BLINKY.C(38): error C141: syntax error near '{', expected 'bit'
（Target not created：没有产出可下载的文件）
UV4 退出码 2：有错误
```

Both dialects are parsed, because one uVision ships both: `.\main.c(12): error C141: ...` (C51 / ARMCC5) and
`../src/main.c:23:5: error: ...` (ARMCC6 / GCC), plus the tools' own `*** ERROR: ...`. A **warning-only** build exits 1
and is reported as a success; a log that says `Target not created` is a failure even when the counts read
`0 Error(s)` - both facts are in the text, so both are read.

### The same code, from inside uVision

Two entry points, one module (`keil.js`): if the chat and the IDE disagreed about what a build was, one of them would be
lying. For the IDE side there is a Tools-menu entry, and a script that writes it:

```powershell
# adds "Keil: 编译 (DSH)" and "Keil: 编译+下载 (DSH)" to Tools → Customize Tools Menu
powershell -ExecutionPolicy Bypass -File scripts\keil\install-tools-menu.ps1 -WithFlash

# and to take them back out
powershell -ExecutionPolicy Bypass -File scripts\keil\install-tools-menu.ps1 -Remove
```

uVision stores those entries in `HKCU\Software\Keil\<product key>\ToolM` as five values per entry - `Mtx` (name), `Mex`
(command), `Mag` (arguments), `Mid` (initial folder), `Mfg` (option bits, `0x900` = run independent). The installer
writes exactly that, so it is idempotent and reversible: it exports the key to a `.reg` under
`$DSH_HOME\dsh-wechat-media\` first, and `-Remove` deletes only the entries it created.

The arguments are `cmd.exe /c "<plugin>\scripts\keil\dsh-keil.cmd" "#P"` - `#P` is uVision's own substitution for the
open project, so one menu item works on every project without per-project setup. Exit codes are meant for scripts:
`0` built (warnings fine), `2` build failed, `3` could not run at all. The log of each run goes to `<project folder>\.dsh-logs\<output>.<action>.log`: `Objects\` belongs to Keil and the folder beside `main.c` belongs to you, so the tool keeps its own evidence somewhere it can be found without pretending to be part of the build.

**What was actually verified.** Against a copy of Keil's own `BLINKY` example (`MCBx51: 8xC51Rx`, C51 V9.61): the chat
tool ran `UV4 -b` and got `Program Size: data=9.0 xdata=0 code=82` in 3.8s, and the same build through
`scripts\keil\dsh-keil.cmd` exited 0. Adding one broken line to `BLINKY.C` produced
`BLINKY.C(38): error C141: syntax error near '{', expected 'bit'` and exit code 2 on both paths, with
`Target not created` reported as a failure. Pointing the CLI at a `.c` file instead of a project exited 3 with
`不是 uVision 工程文件`. The Tools-menu entries were written to the registry and read back intact.

**`action=flash` picks the tool the chip actually needs.** For an STC part - detected from the project's
`<Vendor>STC</Vendor>`, which is the only thing that decides it - `UV4 -f` is skipped entirely and the same hex is
written by `stcgal` over the serial ISP protocol (the protocol comes from the device name: `STC8x` → `stc8g`,
`STC89` → `stc89`, and so on). Anything else still goes through uVision's own download. In one session:

```text
keil_build(action=build)   → code=3129, 0 Error(s), hex beside the project
keil_build(action=flash)   → stcgal, COM3, 3129 bytes, UID F734C3FC31F408
serial_monitor(port=COM3)  → TEMP:27.2C
```

**`action=flash` is honest about doing nothing.** `UV4 -f` exits 0 having programmed nothing when the project has no
download driver configured - the log is 0 bytes and Keil is content. That is exactly what happened on a real STC
project whose chip was untouched, so the verdict now requires evidence in the log (`Erase Done` / `Programming Done` /
`Flash Load finished`), and says so when there is none: STC parts are normally programmed through STC-ISP or `stcgal`
over the serial ISP protocol, and `serial_flash(flasher=stcgal, chip=stc8g, …)` is the path that works.

**Limits.** Keil Lite caps a build at 32K of code and says so through exit code 20 - the message is passed through
rather than guessed at. Only the C51 toolchain was exercised on this machine; the parsing for ARMCC5/AC6 logs is
written against their documented formats and covered by tests, but has not been run against an MDK install here.

## Scrapling: fetch what a plain client cannot / 抓取引擎

Scrapling is a python scraping library with a browser-shaped TLS fingerprint, real-browser headers and adaptive selectors,
so it reads pages that reject a plain `fetch` (`403`, Cloudflare's challenge, a UA check). `scrapling_fetch` exposes it as
one tool:

| Argument | What it does |
| --- | --- |
| `url` | the http(s) page (http and https only - a `file://` path is refused) |
| `selector` | CSS selector; **each match becomes one item** with its text (`span.text`, `h2 a::text`) |
| `links` | also return the page's anchors |
| `mode` | `text` (default) or `html` |
| `limit` / `textLimit` | caps (items, characters) - a page can be megabytes, the transcript should not be |
| `stealth` | run a real browser; it drives the **Chrome you already have** (no 1.25 GB download) |
| `cloudflare` | stealth only: solve a Cloudflare challenge first (~11 s on a protected page) |
| `exe` | stealth only: which browser binary to drive |
| `proxy` | per-call proxy, or set a default with `/scrapling proxy …` |

```text
/scrapling                        # which python has scrapling, the proxy and stealth defaults
/scrapling proxy http://127.0.0.1:7897
/scrapling stealth on|off         # off by default: a real browser is slow and needs its deps
```

Measured on this machine (scrapling 0.5, python 3.11), four cases worth keeping apart:

| Case | Result |
| --- | --- |
| `https://example.com`, no selector | 200, body in 2.4 s |
| `https://quotes.toscrape.com/` with `selector: "span.text"` | 200, three quotes as separate items in 1.7 s |
| `https://www.baidu.com`, `links: true` | 200, the page text plus eight anchors in 0.9 s |
| `https://news.ycombinator.com/` **without** a proxy | hard failure after 21 s: `curl: (28) Failed to connect` |
| the same URL **with** `proxy: "http://127.0.0.1:7897"` | 200 in 1.8 s, five headlines |

The last two are the point: an unreachable host is reported with curl's own words after a bounded wait, rather than
looking like a hang - and the same call answers in under two seconds once a proxy is given. Two more failure modes are
reported rather than guessed: a selector that matches nothing still returns the page text **and** a warning, and a missing
dependency comes back as the exception's own words (`ModuleNotFoundError: No module named 'msgspec'` was the real one
here, fixed by installing it).

Stealth needs a browser, and it uses the one you already have: the session is handed the machine's own Chrome (then
Edge) through `executable_path`, because camoufox's bundled browser is a **1.25 GB** download (measured ~150 KB/s
single-stream, ~620 KB/s with eight ranges - which stalls in practice). If no browser is found the tool says so instead of
quietly falling back to the plain fetcher: a silent downgrade would make an anti-bot failure look like a selector problem.

`cloudflare: true` lets the browser solve a challenge before reading - measured on `https://nowsecure.nl`: **200 in 11 s**.

Behind it, the python side is one self-contained script embedded in `scrapling.js` - not a second file, because a plugin
that installs and then fails on a missing helper is worse than one that does not install.

## Web search (Tavily) / 联网搜索

A `tavily_search` tool lets a WeChat, WeCom or Feishu conversation ask about something current and get real titles,
links and snippets. The shapes were copied from the user's own working plugin (`wjh-ux/dsh-mcp-tavily`, cited line by
line in `tavily.js`) rather than guessed, and the live API was called to check them: with a key, three results came
back in about three seconds - and **keyless mode works too**, so search functions before a key is configured.

The key is set in the panel's Tavily block and takes effect on the next search with no restart, because the tool
re-reads the saved settings before every call. It is never echoed back: `/state` reports `keySet` and nothing more,
including for the case that used to leak - a Tavily-only prefs object with no Feishu block. A failure states its
reason (`Tavily 搜索失败：…`) instead of returning an empty answer.

| Parameter | Meaning |
|---|---|
| `query` | what to search for (required) |
| `maxResults` | 1-20; defaults to the configured value |
| `searchDepth` | `basic` (default), `advanced` or `fast` |
| `includeDomains` / `excludeDomains` | comma-separated domains to restrict to, or leave out |

## Browser automation / 浏览器自动化

Nine tools drive a **real browser** - the Chrome or Edge already on the machine, over the Chrome DevTools
Protocol - with **no third-party dependency**: Node's own global `WebSocket` carries CDP. There is nothing to
install: no npx, no npm install, no config file. The panel chooses the channel, the debugging port and whether it
runs headless.

| Tool | Does |
|---|---|
| `browser_open` | open a URL and return the page title |
| `browser_text` | the page's title, URL and visible text |
| `browser_click` | click an element by CSS selector (a real mouse event) |
| `browser_type` | type into an element by CSS selector (real key input) |
| `browser_screenshot` | PNG of the page into the shared inbox, path returned so it can be sent to the chat |
| `browser_eval` | run JavaScript in the page and return its value (the escape hatch when selectors are not enough) |
| `browser_flow` | replay a list of steps and return the rows they collected (see below) |
| `browser_record` | record the person's own clicks/typing/Enter into a replayable flow |
| `browser_close` | close the browser this plugin started |

It starts its own instance with a profile under `$DSH_HOME/browser-profile`, so **the browser a person actually
browses with is never touched**; a browser already listening on the port is attached to instead of duplicated.
The "自动测试软件正在控制 Chrome" bar is **hidden by default**: `--enable-automation` is passed only when the
panel's `browserHideAutomationBar` box is unticked, and the single CDP call that required the flag
(`Browser.getBrowserCommandLine`) is no longer used - a leftover browser is found by port, not by its command line.
Verified live against Chrome 155: a page received typed input (17 and 25) and a real mouse click and computed 42 by
itself, and a screenshot came back as a 68,561-byte PNG and was delivered to Feishu. Every failure states its reason
(`browser_click 失败：nothing on the page matches the selector "…"`).

**Which browser? (`会话` / `browserProfileMode`)** - four answers, because "same Chrome as mine" has four readings:

- `own` (default) - the plugin's own profile above;
- `chrome` - import bookmarks and preferences from the real Chrome. Cookies and saved passwords **cannot** be brought
  across: Chrome 127+ encrypts them with an app-bound key that dies with the profile (measured: 114 cookie rows in, 29
  after one start). Kept for the files that do survive;
- `attach` - drive a Chrome **you** started with `--remote-debugging-port=9222` and never close it. `/browser launch`
  starts such a Chrome on its own profile and switches to this mode;
- `extension` - **the one that reaches your real Chrome.** Load `extension/` as an unpacked extension
  (chrome://extensions → developer mode), put the address and token from the panel (or `/browser ext`) into its
  options, and every `browser_*` tool runs through `chrome.debugger` inside your own browser - your logins, your tabs,
  no debugging port. **Edge works the same way**: the folder loads unchanged from `edge://extensions`. The panel's
  **一键安装扩展** button packs the folder into `$DSH_HOME/exports`, opens the settings page of the configured channel
  (`chrome://extensions` or `edge://extensions`) and puts the token on the clipboard; Chrome does not allow a page to
  install an extension silently, so those last two clicks stay yours.

  **扩展驱动 (the debugging banner).** Chrome draws "已开始调试此浏览器" whenever `chrome.debugger` attaches, and no
  extension can hide it - so the panel offers the choice instead: `debugger` (real input, full-page captures, any
  frame; the banner flashes while a command runs) or `script` (`chrome.scripting` in the page, **no banner ever**, and
  `captureVisibleTab` still gives you a screenshot of the visible viewport - what it gives up is native input and
  full-page capture), or `hybrid` (script first, and the debugger only for the command that scripting cannot finish -
  a click that found nothing, a frame-scoped operation - so routine work leaves no trace in Chrome's UI). The switch is
  stored and delivered before the next command runs.

  **两个浏览器同时开着.** Every poll names its browser (`chrome` / `edge`) and installation, so the bridge knows both.
  `目标浏览器` (`/browser ext target auto|chrome|edge`) picks which one receives commands; `auto` follows the channel
  setting. The other browser keeps a standby poll and never gets work - without that, two open browsers race for every
  command and the answer comes from whichever asked first.

### 网络层 / The network layer

A rendered list is the last copy of the data, and the smallest. Four tools reach the source instead - all of them on the
extension transport, because a page cannot see its own traffic or its own cookie store:

| Tool | Does |
|---|---|
| `browser_capture` | `start` / `stop` / `list`: `Network.responseReceived` + `Network.getResponseBody`, so the JSON the page fetched comes back whole. `pattern` keeps only the API, `limit` bounds memory, bodies cap at 1 MB, images/fonts are skipped |
| `browser_cookies` | the login state, for one URL or the whole browser |
| `browser_download` | download through the browser (its cookie jar applies), wait for completion, report the path |
| `browser_tabs` | list / open / select - a second tab becomes a choice, not a hope |

Flow step `waitIdle` uses the same machinery: it resolves when nothing is in flight and nothing new has happened for
`idleMs`, which is what "the page has settled" actually means.

Typical shape: `browser_capture start pattern=/api/` → drive the page → `waitIdle` → `browser_capture stop`.

Why not simply drive the real profile? Chrome 136+ silently ignores `--remote-debugging-port` when `--user-data-dir` is
the default one - measured on Chrome 155: process up, window visible, port never listening. That is also why the
extension exists.

### VS Code / 编辑器桥

`vscode-extension/` is a small editor extension - plain CommonJS, no build step - with the panel in the activity bar,
`DSH: 提问…` / `DSH: 用选中内容提问`, `DSH: 编译当前 Keil 工程` / `DSH: 烧录到板子`, and a status-bar item.

**The panel is laid out for a sidebar.** It is ~300px wide and often short, and the first version put a textarea, two
attach buttons and Send on one line - which left the input about 90px wide and unreadable. Now the log takes every pixel
that is left and scrolls, the composer is pinned to the bottom, the input has its own row and grows up to 40% of the
window height, Enter sends (Shift+Enter breaks the line), and the buttons sit underneath: `项目` `＋文件` `编译` `烧录`
… and `发送` on a full-width row of its own. The footer shows 可写, the project, and a clickable `Keil：<project> · <target>` chip that opens `main.c` next
to the `.uvprojx` - "edit" starts with getting to the file you actually change.

**编译 / 烧录 are one HTTP call, not a model turn.** Both post to `/dsh-wechat-media/keil-run`, which runs the same
`keil_build` the chat uses - so pressing 编译 spends no tokens, and the plugin's gates still decide (`/keil on`,
`/serial on`). An STC project is flashed by `stcgal` (see above); the result appears as a monospace bubble with the
exit code, the file/line errors, and the size of what was built.

It talks to three loopback routes: `/dsh-vscode/status`, `/dsh-vscode/ask` and `/dsh-vscode/stream`. All of them are a
**real agent turn** - the same `ensureAgent` + collector path a chat uses - so the editor gets the same model, tools and
context rather than a second, weaker implementation. `/vscode on|off` gates it.

**The AI edits the project you have open.** The request carries the workspace folder and the 可写 switch under the input
box, and the plugin runs the turn *in* that folder with `workspace-write` as its boundary - so `edit`/`write` land in
your project, and anything wider still fails closed (approval is `never`, because nobody in an editor panel can answer a
prompt). Turn 可写 off and the same session runs `read-only` on the next request: the switch is re-applied every time,
not remembered from the first turn. One folder is one conversation (`project:<folder>`), so two open projects never
share a history. The panel prints the project it is talking about, `项目：<folder>（可改 / 只读）`.

Verified end to end: "新建 note.txt" created a 31-byte UTF-8 file in the open folder; with 可写 off, the follow-up edit
was refused by the sandbox (`[sandbox: file access denied under read-only mode]`) and the file was left untouched.

The endpoint is discovered from `gui-port.json` in the plugin's state directory, because the GUI port changes on every
DSH restart. Install: Extensions → `...` → **Install from VSIX** (`dsh-wechat-media-vscode-0.6.1.vsix` in this repo), or
`code --install-extension vscode-extension/`. The extension's own version is what VS Code uses to decide whether to
replace it - a frozen version makes an install a no-op that still prints "successfully installed".

### Flashing from the editor / 在编辑器里烧板子

The editor bridge sends the folder you have open as the turn's working directory, which is exactly what a flash needs:
`idf.py` finds the project's `sdkconfig` (and therefore the offsets, flash size and partition table), and a plain
`.hex`/`.bin` is resolved relative to that folder. So "烧一下" from the panel is one sentence, not a terminal session
with the right environment - and the answer comes back in the same panel, with the exact command that ran.

### Flow automation / 流程自动化（影刀式）

`browser_flow` is the RPA part: a task is written **once** as JSON, and replayed on demand - open, search, click,
scroll, read the list, loop over the rows, export. The same shape a 影刀 flow has, without the recorder UI: the steps
are a text file, so they can be reviewed, edited and handed to somebody else.

| Step | Fields | Does |
|---|---|---|
| `goto` | `url`, `ms?` | open a page and wait for load |
| `click` | `selector` | a real mouse click on the element's centre |
| `type` | `selector`, `text`, `clear?` | focus and type (clears first unless `clear: false`) |
| `press` | `key` | `Enter`, `Tab`, `Escape`, `ArrowDown`, `PageDown`, `Space` |
| `wait` | `ms` | a fixed pause (default 500) |
| `waitFor` | `selector`, `ms?` | poll until the element appears (default 15 s), fail if it never does |
| `scroll` | `to`, `times?`, `selector?`, `pauseMs?` | scroll a container or the window to bottom/top |
| `extract` | `fields`, `selector?`, `single?`, `into?` | read one row (or the page) into a table |
| `each` | `selector`, `fields`, `limit?`, `pauseMs?` | walk the matched elements, one row each, scrolled into view |
| `eval` | `expression`, `into?` | run JavaScript and keep the value |
| `assert` | `selector`, `text?` | stop the flow unless the page shows what was promised |

A field value is `".title"` (that element's text inside the row), `".link@href"` (an attribute), or `"@text"` (the
row's own text). A column that matches nothing is `""`, never a missing key.

```json
{
  "name": "google-maps-cafes",
  "url": "https://www.google.com/maps/search/coffee",
  "steps": [
    { "type": "waitFor", "selector": "[role=feed]" },
    { "type": "scroll", "to": "bottom", "times": 3, "pauseMs": 800 },
    { "type": "each", "selector": "[role=feed] > div", "limit": 20,
      "fields": { "name": "h3", "rating": "span[role=img]@aria-label", "href": "a@href" } }
  ]
}
```

`browser_flow({ flow: "<the JSON>", save: "out.csv" })` returns a per-step report (✓/✗, timing, what was read) plus
the rows; `save` writes them as `.csv` (UTF-8 with a BOM, so Excel opens Chinese correctly) or `.json`. A failing
step stops the run and says which step it was - and the rows collected before it are kept.

`save` is a place, not just a name: a full path (`D:\导出\门店.csv`) is written as given, a folder
(`D:\导出`, or a path with no extension) gets `<flow>-<time>.csv` inside it, and a bare name lands in the export
directory, `$DSH_HOME/exports` unless `/browser exportdir D:\导出` says otherwise. `~` expands and the folder is
created; the report always shows the absolute path that was written.

The panel's 流程导出目录 row has **浏览…**, which opens the real Windows folder dialog on this machine and saves the
choice as soon as it is made. The dialog runs in the host, not the page, because a browser cannot learn an absolute
path: `showDirectoryPicker()` hides it and `webkitdirectory` reports only relative names.

To build a flow without writing selectors by hand, `browser_record({action:"start"})`, do the task once, then
`browser_record({action:"stop"})` returns the steps as JSON. The recorder captures clicks on links/buttons/inputs,
value changes, Enter, and a debounced scroll (one step per pause, not one per pixel), and picks selectors by `#id`,
then `data-*`, then a short `tag:nth-of-type` path - never a generated class name, which changes between two loads.


## Lead collection / 获客采集

`collect_leads` turns a goal into a scored list instead of a page of results. Give it `goal="户外家具 进口商"`（或
`outdoor furniture importer`）and a `market`; it searches, opens each company's site **and its contact page**, extracts
emails / phones / WhatsApp, scores every lead, merges into a local lead store, and writes a CSV on request.

The method is the part worth reading, because each rule exists to kill a specific kind of junk:

| Rule | Why |
|---|---|
| A role word is a **recall hint, not proof** | `importer` / `distributor` / `进口商` widen the net; the verdict comes later from the site's own contacts and evidence |
| Search terms are generated **in the market's language** | `importeur`/`großhandel` for `de`, `importateur` for `fr` - an English-only query finds exporters, not local buyers |
| **Directories are filtered out by host** | Alibaba, Amazon, LinkedIn, Europages, company registers: high in results, never the company |
| **Two de-duplication axes** | `ACME GmbH` = `acme gmbh co kg` (name normalised) and `acme.de` = `www.acme.de` (registrable host) |
| **The contact page is fetched, not just linked** | half the emails on a site live at `/kontakt`, `/impressum`, `/contact` |
| **Noise is filtered from contacts** | `logo@2x.png`, `name@example.com`, `@wixpress.com` and HTML-entity artefacts all look exactly like a mailbox |
| **Every score carries its reasons** | a lead at 60 with "has email, no contact page" is actionable; a bare 60 is a mystery nobody can audit |

The budgets are settings, not constants - a page that never finishes loading used to cost five minutes because the
transport's own ceilings fired on every call:

| Setting | Default | Meaning |
|---|---|---|
| `step` | 12 s | how long one page gets before it is abandoned |
| `search` | 15 s | how long one search page gets |
| `deadline` | 3 min | the whole run; reaching it stops cleanly and keeps what it has |
| `limit` | 10 | how many companies an unadorned run keeps |
| `searches` | 4 | how many queries are tried |

Change them with `/collect step 12` in the chat, or in the control panel's 获客采集 block. `/collect` alone prints the
effective values, and `/state` reports the same numbers the tool actually uses.
### Two discovery sources / 两条发现路线

| `sources` | Where the companies come from | Needs |
|---|---|---|
| `search` (default) | Tavily, queried with the market's own role words | nothing |
| `maps` | OpenStreetMap places around a `city` - name, website, phone, address | a city name |
| `both` | the two lists merged, de-duplicated on the same two axes | a city name |

They find different companies. A search asks "who writes about outdoor furniture in German"; a map asks "who sells it
at an address". Measured on Munich: 119 places, 73 with a website, from one Overpass query - shops that never rank for
the query. No geocoder is involved: Nominatim is unreachable from this network (`UND_ERR_CONNECT_TIMEOUT`), while
Overpass resolves the city itself with `area["name"="München"]`.
### Buyer or competitor? / 买家还是同行

Every lead carries a **role verdict** - `buyer` / `seller` / `unclear` - read from the company's own words, in both
directions:

| Reads like a buyer | Reads like a seller |
|---|---|
| "we are an importer", Großhandel, Einkauf, procurement, private label | "we are a manufacturer", our factory, OEM/ODM, exporter, Hersteller |

It is weighted, not a keyword count: "we are a manufacturer" is not the same statement as the noun appearing in a
footer. The verdict moves the score (+15 / −25) and is stored with the lead, so a person sees why. `buyerOnly: true`
drops sellers entirely - a competitor in a customer list is worse than a gap in it.

Measured on a live run: the top result was a Chinese exporter with a perfect score, because every signal the scorer
had (email, phone, contact page, product words) is satisfied by a seller too. After the check: `nbymoutdoor.com` →
seller (ODM / MANUFACTURER), `denova-gartenmoebel.ch` → seller (Hersteller), `tica.nl` → buyer (Groothandel). Two out
of three were never prospects.
The lead store lives at `$DSH_HOME/dsh-wechat-media/leads.json` and is merged, not overwritten - running the same goal
twice adds only what is new. Exports go through the same save rules as `browser_flow`.

Two things it deliberately does **not** do: it never treats a search hit as a qualified buyer, and it stops instead of
retrying when the engine shows a captcha - burning the address for a few more rows is the worse trade.
## Outreach / 触达

`outreach_plan` then `outreach_send`. Two steps because the plan is the thing worth reviewing: it lists every recipient,
the exact text, and **why each skipped target was skipped**.

| Channel | Can reach | Note |
|---|---|---|
| `email` | a stranger | the address is on the company's own website - the only genuinely cold channel |
| `wechat` | an existing conversation | a contact who wrote to the bot; there is no "message this phone number" API |
| `wecom` | an existing conversation | same, via the intelligent robot |

Rules that protect the account and the reader:

- **A delivered message starts a 30-day cooldown** per address; a bounced one does not - a bounce is a reason to try
  again tomorrow, not to lock the address out for a month.
- **No address is repeated inside one batch**, and the plan refuses a template whose placeholders it cannot fill
  (`{{contact}}` stays visible in the preview rather than going out blank).
- **`outreach_send` needs `confirm: true`**, sends one at a time with a delay, caps at 10 per call, and stops at the
  first hard channel failure instead of hammering a broken transport.
- History lives in `$DSH_HOME/dsh-wechat-media/outreach.json`; the pending plan in `outreach-plan.json`.
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
| `/help` | `/h`, `/?`, `/帮助` | `/help` lists every command **grouped by purpose** (会话 / 发送 / 授权与联系人 / 工具 / 通道 / 多 agent / 运维) with its aliases; `/help <命令>` (or an alias, e.g. `/help 预设`) shows one command's usage, aliases, summary, **可用值** and **现状** - the current switch, preset, model, baud, connection - plus the sub-forms worth knowing. |
| `/desktop` | `/桌面` | Arms or disarms the desktop tools (mouse, keyboard, screenshot, windows). **Off by default** - they act on your own screen. |
| `/clipboard` | `/clip`, `/剪贴板` | Arms or disarms the clipboard tools. **On by default**: a clipboard can hold a password, so one command turns reading off. |
| `/multiagent` | `/多agent` | The switch for one agent per conversation: `/multiagent on|off`, or no argument for the switch and this chat's preset. **Off by default.** |
| `/agent` | `/预设` | Lists the agent presets the host exposes, shows which one this chat mounts, `/agent <id>` sets it and `/agent reset` returns to the default. Only takes effect with `/multiagent on`. |
| `/name` | `/命名` | Renames the chat you are talking in: `/name 老板的群`. A QQ chat's identity is an openid (`A32A7C20…`), so this is the only way a list of chats reads like something a person recognises. `POST /peers` takes the same `name` for any chat. |

### Email

Two directions, two protocols, both written out in `email-wire.js` - the plugin still has **no runtime dependencies**, because adding
a mail sender and an IMAP client to a process that already holds chat credentials is a large trade for one channel. The clients are
tested against fake SMTP and IMAP servers in the suite.

- **Receive**: every `pollSeconds` (15–600, default 60) an `IMAP UID SEARCH UNSEEN` plus `BODY.PEEK[]`; the decision is made first and
  the message is marked read **after** the turn, so a crash leaves it unread and it comes back next round instead of vanishing.
- **Send**: `SMTP` with `AUTH LOGIN`; a server that does not offer `STARTTLS` is refused rather than handed a password in the clear.
  Replies carry `In-Reply-To`/`References`, so they land in the same thread.
- **Who may write**: `allowSenders` empty means **nobody**, not everybody. `*@example.com` domain wildcards work.
- **Attachments**: named, never downloaded - writing a stranger's file to disk is not this module's decision.
- **Decoding**: multipart / base64 / quoted-printable / UTF-8 and GB charsets, each with a fallback, so a malformed mail cannot take a
  turn down.

Passwords are sealed like every other credential (DPAPI on Windows) and never travel back to the card.
| `/email` | `/邮件`, `/mail` | SMTP sends, IMAP receives. `/email` prints the state, `on`/`off` toggles it, `check` fetches once, `test [address]` sends a self-test mail, `allow <address>` / `remove <address>` maintain the allowed senders. **An empty list means nobody is answered** (email addresses are spoofable, so the default is closed). The card holds SMTP/IMAP hosts, both passwords and the list. |
| `/qq` | `/QQ` | The QQ bot's switch and status: `/qq on|off`, or no argument for credentials presence, connection state and the last error. Credentials live in the card. |
| `/scrapling` | `/抓取`, `/scrape` | Scrapling's defaults: `/scrapling proxy <url>`, `/scrapling stealth on|off`, or no argument for the interpreter, proxy and stealth status. The fetching itself is the `scrapling_fetch` tool. |
| `/serial` | `/串口`, `/flash` | Arms or disarms the serial tools and sets their defaults: `/serial on|off`, `/serial baud 460800`, `/serial port COM3`, and with no argument it reports the switch, the toolchain it found and the ports that are plugged in. **Off by default** - flashing writes a board's flash. |
| `/ssh` | `/远程` | Arms or disarms the SSH tools and manages the host list: `/ssh on|off`, `/ssh add <name> <user@host[:port]> [identity]`, `/ssh remove <name>`. **Off by default** - these run commands on other machines. |
| `/stop` | `/cancel`, `/停止` | Interrupts the turn running in this chat's session, and says so honestly when nothing is running. |

Anything else starting with `/` gets the command list back rather than a guess; a bare `/` or `//` is an
ordinary message. Commands are counted (`counters.commands`) and recorded in `/state.recentRoutes`.

## Integrations: in, out, and a dashboard / 集成：进、出、看板

Three routes turn the bridge into something other systems can drive and watch. All of them live on the same loopback
server as the rest of the panel; the inbound one is the exception that is *meant* to be reachable from another machine.

### 1. Inbound: `POST /dsh-wechat-media/inbound` — let a NAS, CI or a monitor "shout at" the agent

```sh
curl -s http://127.0.0.1:19387/dsh-wechat-media/inbound \
  -H 'content-type: application/json' \
  -H "x-dsh-token: <面板/看板上的入站 token>" \
  -d '{"peer":"<wxid 或群 id>","text":"把今天的备份报告整理成三句话","id":"ci-2026-10-23-1","reply":true}'
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `peer` | 是 | 要说话的会话 id：微信 wxid / 群 id、企微会话 id、飞书 receive id。**不是**昵称 —— 昵称会重名，会话 id 不会 |
| `text` | 是 | 触发这一轮的话；上限 8000 字符 |
| `id` | 否 | 幂等键。同一个 `id` 再发一次不会重跑（CI 重试安全） |
| `reply` | 否 | `true`（默认）= 回答也发到那个会话；`false` = 只在 HTTP 响应里返回 |
| `transport` | 否 | `wechat`（默认）/ `wecom` / `feishu`；后两者目前只能把回答放进 HTTP 响应 |
| `accountId` | 否 | 多个微信账号时指定用哪个；默认第一个已配对的 |

响应里带 `sessionId`、`answer`、`stopReason`、`delivered` 和 `ms`，所以 CI 不需要再去微信里看结果。token 是唯一的门 ——
这条路由**不要求来源是本机**（否则它就没有意义），所以 token 泄露等于接口泄露：面板/看板上可以一键换一个。

### 2. Outbound webhook — every finished turn, POSTed to your address

```sh
curl -s -X POST http://127.0.0.1:19387/dsh-wechat-media/prefs \
  -H 'content-type: application/json' \
  -d '{"webhookUrl":"https://example.com/dsh-hook","webhookSecret":"<随便一段足够长的随机串>"}'

# 先证明接收端是对的，再让真实轮次依赖它
curl -s -X POST http://127.0.0.1:19387/dsh-wechat-media/webhook \
  -H 'content-type: application/json' -d '{"action":"test"}'
```

每轮结束（微信 / 企微 / 飞书 / VS Code / 入站触发的都算）POST 一份 JSON：

```json
{"event":"turn.end","at":"…","sessionId":"…","accountId":"…","chatId":"…","peerName":"…",
 "transport":"wechat","answer":"…","answerChars":123,"stopReason":"end_turn","error":null,"version":"0.68.0"}
```

- 配了 `webhookSecret` 时带 `x-dsh-signature: sha256=<hex>`，是对**原始 body** 的 **HMAC-SHA256**（不是拼接哈希），
  接收端算一遍比对即可；
- 失败重试 3 次（300/600ms 退避），4xx 不重试 —— 那是「地址错了」，再发两次也没用；
- 接收端挂了、慢了、超时（10s）都不会拖慢或影响聊天里的回答：发送是 fire-and-forget，结果记在
  `/dsh-wechat-media/webhook` 的 `last` 和看板上；
- `webhookUrl` 置空 = 关闭。

### 3. Dashboard — `GET /dsh-wechat-media/dashboard`

浏览器打开 `http://127.0.0.1:19387/dsh-wechat-media/dashboard`（30 秒自动刷新，无脚本，仅本机可访问）：

- **卡片**：会话数、失败合计、token 总量、入站请求数、webhook 已发数；
- **失败与丢弃**：重试失败、无法使用的消息、媒体失败、被白名单/群规则拦下的、飞书错误、入站失败、webhook 失败、
  token 记账失败（如果记账本身坏了，这一项会红）；
- **Token 用量**：按账号/会话拆开，带清零窗口；
- **最近活动**：最后入站、webhook 的最后一次投递（成功/失败 + HTTP 状态）、最近路由、最后一帧流式数据；
- **配置**：入站 token、webhook 地址、签名是否已设置。

排障时先看这一页，比翻会话记录快。

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

## What was actually verified / 真机验证过什么

A plugin README can claim anything; this is the list of things that were *run* while building it, with the numbers that
came back. Anything not on this list is covered by tests but not by a real device.

| Capability | How it was verified |
| --- | --- |
| WeChat text, files, images | Live account, two-way messages and file transfers into `$DSH_HOME/wechat-inbox` |
| WeCom / Feishu | Long connection connected; a real message answered (`answer:"收到"`, 1721 ms) |
| VS Code editor bridge | An edit applied in the open folder: 46 delta frames over 8.5 s, `app.js` became `你好，世界` |
| Desktop control | Focus, click, screenshots of the DSH window on this machine |
| Clipboard | Chinese round-trip (`剪贴板自检 中文 ✔`), plus the file-list shape |
| SSH | `ssh -V` 56 ms; a named-but-absent port refused with the list of the present ones |
| Serial: STC | `DS18B20_TM1650.hex` written to an STC8H1K08 over COM3 - 3129 bytes loaded, 3648 written, `Target UID: F734C3FC31F408` - then `TEMP:27.6C` read back |
| Serial: ESP-IDF | `hello_world` built through the same `export.ps1` wrapper the flash uses (`hello_world.bin`, 175 kB, 83% partition free). The write itself needs the board |
| Keil: real project | `DS18B20_TM1650` (STC8H1K08, C51 V9.61) rebuilt: `data=76.2 xdata=0 code=3129`, 1.5 s, `creating hex file from ".\Objects\…"`; one broken line produced `BLINKY.C(38): error C141` with exit code 2 on both the chat tool and the Keil-side CLI |
| Keil: flash honesty | `UV4 -f` on that STC project exits 0 in 1.4 s with a **0-byte log** and touches nothing - which is why the verdict now requires `Erase Done` / `Programming Done` in the log, and why an STC part is sent to `stcgal` instead |
| STM32: build | `arm-none-eabi-gcc` 15.2.1 + CMake + Ninja built `scripts/stm32-template` to `text 212 B` (`Chip id 0x412`, 32 KiB flash, 10 KiB RAM) |
| STM32: flash over UART | No ST-Link. PA9/PA10 wired to the CH340, `BOOT0=1` + reset, `stm32loader` wrote 212 bytes at `0x8000000`, `Verification OK`, and the bytes read back hashed identical to the source. `BOOT0=0` + reset → the PC13 LED blinked |
| STM32: the cost of no debugger | Moving BOOT0 to 1 does nothing until the chip is reset (`Can't init into bootloader` during that window); sized from the silkscreen (64K/20K) instead of the chip's own report, the firmware flashed, verified, and hard-faulted in a silent reset loop |
| Scrapling | `example.com` 200; `quotes.toscrape.com` + `span.text` -> three items; `baidu.com` + `links` -> eight anchors; HN fails in 21 s without a proxy and answers in 1.8 s with one |
| Scrapling stealth | Real Chrome UA; `nowsecure.nl` (Cloudflare) -> 200 in 11 s with `cloudflare: true` |
| Office | Word/Excel/PowerPoint written, converted to PDF, rendered to PNG |
| Integrations | `/inbound` 401 without the token and 200 with it; webhook `turn.end` HMAC verified; dashboard screenshot |
| Multi-agent | `/agent minimal` on a WeCom chat, then `/new`: after the next message, `GET /state` reported `conversations[].agentPreset = "minimal"` and the reply arrived - the preset is applied when the agent is created, not just stored |
| Multi-agent: model | `/agent model deepseek-account/deepseek-flash` then `/new`: `GET /state` reported `conversations[].agentModel = "deepseek-account/deepseek-flash"` and the turn answered - and `deepseek-official/deepseek-chat` was shown to fail with `no API key`, which is why `/agent model` prints the host's own value |
| Multi-agent: swap model | `/agent model deepseek-account/deepseek-v4-pro`, then `/new`: `GET /state` reported `conversations[].agentModel = "deepseek-account/deepseek-v4-pro"` (not the default `deepseek-flash`) and the turn answered |
| Secrets at rest | A 32-character QQ secret became a 358-character `dpapi:…` value on disk, `/state` returned `***`, and the bot stayed `ready` - so the seal neither breaks the connection nor leaks the value |
| QQ bot: private chat | Live bot **PawDesk** (appId 1903374412): `C2C_MESSAGE_CREATE` -> session -> reply through `/v2/users/{openid}/messages`; `received 2 / forwarded 1 / answered 1` |
| QQ bot: group @ | `GROUP_AT_MESSAGE_CREATE` from a real group -> reply through `/v2/groups/{group_openid}/messages`; `received 4 / forwarded 2 / answered 2`, and the first two attempts were correctly blocked by the allowlist |

## Release history / 版本历程

`0.1.0` to `1.14.1` is **260 releases** - this plugin was built in public, one verified change at a time. Grouped by what
each era added, with the releases that mattered most:

| Era | What it added |
| --- | --- |
| 0.1 – 0.29 | The bridge itself: QR pairing, one session per chat, media both ways, multiple accounts, the command set, and the card in the Plugins panel |
| 0.30 – 0.32 | Reliability and secrets: retries, monthly token accounting, and credentials on disk that are no longer readable credentials |
| 0.33 – 0.38 | Office documents from the chat, an office output folder, the first-run wizard, and Feishu scopes copied as the minimum payload |
| 0.39 – 0.47 | A browser a person can watch, a proxy for it, `/doctor`, proxy host lists, and a long run of crash fixes (a slow page could take the app down) |
| 0.48 – 0.56 | Flow automation, three browser sessions, the Chrome extension (own Chrome / attach / Edge), the debugging banner as a choice, and a visible click cursor |
| 0.57 – 0.67 | The VS Code bridge: ask from the editor, streaming answers, the open project as context, and finally the AI editing the folder it was opened on |
| 0.58 – 0.63 | The network layer: capture the JSON behind a page, turn it into rows, save it, and a Maps place collector that scrolls past the first screen |
| 0.68 – 0.69 | Integrations: `POST /inbound`, a signed outbound webhook, the dashboard - and the clipboard as two tools |
| 0.70 | SSH: `ssh_exec`, `ssh_upload`, `ssh_download`, key-based only, host key learnt once, off until `/ssh on` |
| 0.71 | Serial: list ports, flash (ESP-IDF \`idf.py\`, `esptool`, `avrdude`, STC via `stcgal`), and read the board back - verified on an STC8H1K08 |
| 0.72 | Scrapling, including a real-browser mode that drives the Chrome you already have |
| 1.0 | The stability statement: same features, winget-installed tools found, `projectDir` reaching `idf.py`, and the README's verification table |
| 1.1 | QQ bot over the open platform's WebSocket gateway - private chats and group @, verified against a live bot |
| 1.2 | Every secret sealed at rest, including the two that arrived late |
| 1.3 – 1.4 | Multi-agent: a preset per conversation, and a model per conversation when you ask for one |
| 1.5 | `/help` as groups instead of 26 flat lines, and a security pass over the whole access-control surface |
| 1.6 | A fourth channel: email (IMAP in, SMTP out), on the card and in the dashboard, with a CA override for this machine's TLS |
| 1.7 – 1.8 | Feishu as you: knowledge bases, docs/sheets/bitable tools, and the official CLI's 200+ commands - an app is a member of nothing |
| 1.9 – 1.12 | Lead collection: a sentence into a scored list, buyers told apart from sellers, budgets as preferences, shops that never rank (maps), and a `market` that constrains the search instead of only scoring it |
| 1.13 | Outreach: `outreach_plan` / `outreach_send` over three channels, with cooldown, a confirmation step, and a stop at the first hard failure |
| 1.14 | Lead quality: a company name from the domain when the headline is a sentence, a twenty-country phone prefix table, and one human confirmation slot before a cold email leaves |
| 1.15 | Keil uVision5: `keil_build` drives the installed UV4 (build / rebuild / clean / flash) and answers with `file(line): error`, plus a Tools-menu entry so the same module is one click inside uVision |
| 1.16 | The same build from VS Code: Browse for the project, Target as a dropdown read from the `.uvprojx`, one line naming the `UV4.exe` that was found - and a sidebar layout that works at 300 px |
| 1.17 | `project_build`: one entry for Keil / ESP-IDF / CMake+Make, with `toolchain` and `flasher` overrides. Verified on a real STM32F103C8T6 clone flashed over its UART bootloader with no debugger attached |

Each era ended with the same discipline: a release only goes out after the suite passes, and a claim only goes in the README
after something real produced the number.

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
- **Secrets are sealed at rest.** Everything sensitive in `prefs.json` - the Feishu app secret, the Tavily key, the WeCom
  bot secret, the QQ client secret and the outbound webhook secret - is stored as `dpapi:…`, DPAPI ciphertext bound to the
  Windows account that wrote it. A copy of the file is worthless on another machine or account, and `/state` returns `***`
  for all of them rather than the value. A path added after a file was written is sealed on the next activation
  (`sealExistingSecrets`), and a value that cannot be opened says so instead of pretending the credential is gone.
- The card's HTTP routes refuse anything that does not arrive over loopback.
- **Use a spare WeChat account if you can.** Personal-account automation is at your own risk.

## Cookbook / 实战文档

- **[Proxy and the host list / 代理与「走代理的域名」](./docs/proxy-and-domains.md)** — the 26-domain preset that says
  which sites go through a local proxy and which stay direct, applied with `/browser hosts preset` or one POST, plus
  the two boundaries people trip on: a PAC only governs a browser the plugin launched itself (an `extension` session
  uses your own Chrome's proxy), and an empty list means *everything* goes through the proxy rather than nothing.

  哪些网站走代理、哪些直连：一份 26 个域名的预设，一条命令套用；顺带说明两个边界 —— PAC 只对插件自己拉起的浏览器生效，
  列表为空其实是「全部走代理」而不是关闭。

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
