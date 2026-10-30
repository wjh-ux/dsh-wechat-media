# Changelog

## 1.16.8

- **The VS Code panel was unusable in the sidebar it lives in.** A textarea, `项目`, `＋文件` and `发送` shared one row in
  a ~300px view, which left the input about 90px wide - the placeholder was cut mid-sentence in the screenshot that
  reported it. The panel is now a full-height column: the log scrolls, the composer is pinned, the input has its own row
  and grows, Enter sends / Shift+Enter breaks the line, and the buttons sit underneath.
- **编译 and 烧录 are in the panel.** Both call a new loopback route `/dsh-wechat-media/keil-run`, which runs the same
  `keil_build` the chat runs - one HTTP call, no model turn, no tokens, and the plugin's own gates still apply. There are
  palette commands for them too (`DSH: 编译当前 Keil 工程`, `DSH: 烧录到板子`). The result lands as a monospace bubble with
  the errors, the size and the exit code.
- The footer gained `Keil：<project> · <target>`, clickable, opening `main.c` beside the `.uvprojx` - editing the file you
  actually change should not require finding it. Extension version 0.6.0 (`dsh-wechat-media-vscode-0.6.0.vsix`).
## 1.16.7

- **Every build left a `.build.log` in the project folder, next to `main.c`.** Nobody asked for that file to be there -
  `Objects\` is Keil's and the folder beside the sources is the person's, so the tool now writes its own evidence to
  `<project>\.dsh-logs\<output>.<action>.log`. The folder is created by `runUv4` itself (UV4 does not create the folder
  it is told to write into, the same trap `Compress-Archive` set for the extension installer), so both the chat tool and
  the Keil-side CLI get it for free. The two logs the old version left in a real project were moved and the empty one
  deleted.
## 1.16.6

- **`action=flash` on an STC project now flashes instead of quietly doing nothing.** v1.16.5 taught the tool to admit
  `UV4 -f` had written nothing; this release stops asking the wrong tool. When the project says `<Vendor>STC</Vendor>`,
  the flash goes straight to `stcgal` over the serial ISP protocol, with the protocol picked from the device name
  (`STC8H1K08` → `stc8g`, and `STC89` is checked before `STC8` because an STC89 starts with "STC8" and would otherwise
  get the wrong protocol). The hex is found where the project says it writes it, then in `Objects\`, then beside the
  project - and if none exists the answer names those paths instead of opening a port. Everything else still uses
  uVision's download. Verified on the real STC8H1K08 board: `action=flash` built nothing new and still wrote 3129 bytes
  to COM3, then the board printed `TEMP:27.2C`.
## 1.16.5

- **`action=flash` reported success on a chip that was never touched.** `UV4 -f` exits 0 and writes a 0-byte log when
  the project has no download driver configured - and the first real test of this feature printed
  "⚡ 下载到芯片完成" for exactly that, on an STC project whose flash had not been erased. The verdict now needs
  evidence in the log (`Erase Done` / `Programming Done` / `Flash Load finished`, and none of `Flash Download failed` /
  `No ULINK` / `cannot access target`); otherwise it says UV4 wrote nothing and names the tool that can - `stcgal` over
  the serial ISP protocol, which is how the same board was actually programmed afterwards.
- Verified end to end on a real STC8H1K08 project (`DS18B20_TM1650`): rebuild produced `code=3129`, `stcgal` wrote
  3129 bytes to `COM3` (`Target UID F734C3FC31F408`), and the board then printed `TEMP:27.2C` on the same port.
## 1.16.4

- **"Browse…" always opened in Documents, never where the project was.** The remembered value is a `.uvprojx`, and
  `OpenFileDialog.InitialDirectory` takes a folder: handed a file path it silently falls back - so the picker started
  in the wrong place for every project, which is the one thing a picker exists to avoid. It now passes
  `dirname(remembered)`, and the filter stays as it was.
## 1.16.3

- **One inbound test was a bet on how fast the machine is, and a shared CI runner lost that bet.** "The same message
  delivered twice becomes one turn" asserted `queued.length === 1` after a fixed 40ms sleep; on node 22 it read 0,
  because the first delivery had not been queued yet - the duplicate was never the problem. `settle()` is now a
  condition wait (`until()`, which this suite already grew for the same flake) followed by a 300ms silence check, and
  the failure path waits for the reply instead of sleeping 120ms. Eight consecutive runs of the suite, and the CI
  rerun, are green; the failure is not reproducible by making the machine faster, only by making the assertion honest.
## 1.16.2

- **The file picker kept listing every file, and the Target box said "(project default)" in a Chinese panel.**
  `pickFile` accepted a `filter` and never passed it to the generated script, so the option existed and did nothing -
  the dialog is WinForms, so "no filter" means every file in the folder looks like a candidate project. It now forwards
  it, and a test asserts the `$d.Filter` line rather than the parameter, because the parameter was already right.
- The Keil labels were inserted into both dictionaries and then inserted again with the other language's values, so
  each key existed twice and the last one won: English in a Chinese panel. One pair per dictionary now.
## 1.16.1

- **The path field still cut off the path, and the picker listed everything.** Four controls on one row meant an
  absolute path showed as `…\default-w`; the project field now has the row to itself and **Browse… / Target / Save**
  sit under it, which is a layout the window width cannot undo. And "选择 Keil 工程" opened with no file type filter, so
  a folder with fifty files looked like fifty candidate projects - `dialogs.fileDialogScript` grew an optional `filter`,
  and this picker asks for `*.uvprojx;*.uvproj` first.
## 1.16.0

- **The Keil row made you type things the machine already knew.** The project path had to be pasted by hand and the
  Target had to be typed from memory, so the two fields most likely to be wrong were the two nobody could check.
  **Browse…** opens the native file dialog (`/keil-pick`, loopback only - a page cannot learn an absolute path), the
  Target is now a dropdown filled from the project's own `<TargetName>` entries via a new `/keil` route, and one line
  under the row names the `UV4.exe` that was found - or the reason none was. A target saved earlier that the project no
  longer declares is still listed, marked as such: silently dropping a setting is worse than showing a stale one.
## 1.15.3

- **The card worked but read badly.** The Keil project field shared the row with the Target field, so an absolute path
  showed as `C:\Users\Administrator\Documents\deepseek-har` - the one thing that must be readable at a glance was the
  thing truncated. The project box now takes four shares of the row and the Target box one, because a path is long and
  a target name is not. And the SSH host list had been pushed below the serial and Keil switches by the 1.15.2 insert,
  separating "add host" from the switch that owns it; it sits back under its own switch.
## 1.15.2

- **The switch existed everywhere except where people look for switches.** `/keil on` worked and `/prefs` worked after
  1.15.1, but the card in the Plugins panel - where every other capability has its checkbox, right next to serial -
  said nothing about Keil, so "can it build?" was unanswerable without reading the README. The card now has the
  checkbox plus the **Project** and **Target** fields, all through the same `keil` preference block: a field is a draft
  until Saved, so a half-typed path never lands in prefs.
## 1.15.1

- **`/keil on` was the only way to arm the feature, and the panel and `/prefs` route could not save the switch.** Every
  other switch in this plugin is reachable both ways, so a build tool whose state only existed if you typed a command
  was the odd one out - and `POST /dsh-wechat-media/prefs` answered `{"keil": ...}` by silently ignoring it. The block
  is now a first-class preference (`keil.enabled` / `project` / `target`, validated by `normalizeKeilPrefs`), so the
  panel, a script and `/keil on` all write the same thing.
## 1.15.0

- **The plugin could flash a 51 board but could not build the program it flashed.** Keil uVision5 is where that program
  comes from, and a build that fails only says so inside the log UV4 writes - `.\main.c(31): error C141: syntax error
  near 'return'` is the useful sentence, and it never reaches a console. `keil_build` drives the UV4.exe already
  installed (C51 or MDK) with `-b / -r / -c / -f`, reads that log, and answers with every error as
  `file(line): error C141: message`, the `Program Size` line and the `.hex` it produced. Warning-only builds are a
  success (UV4 exits 1); `Target not created` is a failure even when the counts read `0 Error(s)`. Off until
  `/keil on`, because `flash` writes a chip.
- **The same build is one click inside uVision.** `scripts\keil\install-tools-menu.ps1` writes the Tools menu entries
  in the format uVision reads (`HKCU\Software\Keil\<product key>\ToolM`: `Mtx` / `Mex` / `Mag` / `Mid` / `Mfg`), with
  the current project passed by uVision's own `#P`, and backs the key up to a `.reg` before touching it. Both entry
  points call the same `keil.js`, so the chat and the IDE cannot disagree about what a build was.
## 1.14.1

- **The one-click extension install failed on a fresh machine with `cannot find path …\.dsh\exports`, although nothing
  was wrong with the extension.** `Compress-Archive` does not create the destination folder, and a new `$DSH_HOME` has
  no `exports` directory under it. The pack helper now creates that folder itself — and names the path it could not
  create instead of surfacing a zip error — so every caller gets the fix; a test covers the nested-path case.

## 1.14.0

- **The plan greeted a recipient with "您好 Lounge garden furniture directly from the designer，".** A page headline is
  not a company name, and the first line of a cold email is where a person decides whether it was written for them.
  When the title reads like a sentence (>= 7 words, or a slogan's punctuation), the name comes from the domain instead:
  `april-furniture.com` → "April Furniture".
- **A Danish webshop stayed in a German plan** because the phone table only covered the nine markets the collector
  knew, so `0045` read as "unknown market". Twenty countries now, longest prefix first, and any *known* country that
  is not the target is a hard mismatch (`strictMarket`). Also fixed a real bug found on the way: the leading `00`
  of an international prefix was never stripped, so `0045…` matched nothing at all.
- **Some messages should not go out without a human looking.** The plan now flags the shapes that read as automated -
  a greeting addressed to a headline, a first email to `info@`, a company whose role is still unclear, a website
  missing - and `outreach_send` **holds those back by default** (`includeReview: true` to override). A score says
  "worth contacting"; this says "read this one before you do".
- 49 suites / 781 cases.
## 1.13.1

- **`market` only scored leads; it never constrained the search.** A run for `de` returned a US direct-to-consumer
  brand and a Chinese supply-chain company, both real companies and neither a German buyer. The market now goes into
  the queries **in the language people there use** (`Deutschland`, not `德国` - the Chinese label found Chinese pages
  about Germany), and a lead whose phone belongs to another market is dropped (`strictMarket`, default on) rather
  than merely penalised.
- **A supplier directory was classified as a buyer**, because describing its members fills the page with buyer
  vocabulary ("Händler", "Einkäufer", "Großhändler"). Directories are now decided by **structure** before scoring: a
  company site links to its own pages and a few socials, a directory links to dozens of other domains. Verified:
  `Lieferanten.de` → directory (30 outbound domains), `Möbel Süd GmbH` → not.
- Two bugs the new tests caught while writing them: `marketFit` used `find` and tested only the *first* other
  market's phone pattern (a US lead against `de` came back "unknown" because the loop checked `uk` first), and the
  market-aware query builder crashed on an undefined `where` - the literal `\n` from the patch had landed inside a
  `//` comment.
- Measured after the change: queries become `outdoor furniture importeur Deutschland`, and a run returns
  `april-furniture.de` (German, target) instead of a US brand.
- 49 suites / 779 cases.
## 1.13.0

- **A lead list had nowhere to go.** The collector could find companies; the plugin could send messages; nothing joined
  them, and the join is where the damage happens - the same company twice, a template that goes out with
  `{{company}}` still in it, or a "3 ready" that quietly dropped the ones it could not address.
- Two tools now do it in two steps: `outreach_plan` builds the plan (who, on which channel, with exactly what text,
  and why each skipped target was skipped) and `outreach_send` sends it - only with `confirm: true`, one message at
  a time, with a delay, stopping at the first hard channel failure.
- **All three channels, honestly differentiated.** Email is the only one that can reach a stranger, because the
  address is on the company's own site. WeChat and WeCom reach *existing conversations* only - a contact who wrote to
  the bot - and the plan says so instead of inventing an id.
- A delivered message starts a 30-day cooldown per address; a **bounced** one does not, because a bounce is a reason
  to try again tomorrow, not to lock the address out for a month. The plan never repeats an address inside one batch,
  and the cap (10 per call by default) exists because a runaway loop is worse than a slow campaign.
- 49 suites / 775 cases.
## 1.12.2

- **A casting agency came back as an outdoor-furniture shop.** The map query also asked for `office=company` to catch
  wholesalers; it caught an office. Only `shop` categories are queried now - a shop tag is a fact about what a place
  sells, an office tag is only a fact about it having an office. Munich: 120 places, 82 with a website (up from 73).
- **`Lieferanten.de - Die clevere Lieferantensuche` survived the directory filter** because the filter only saw the
  search-result title ("Lieferanten.de") while the page calls itself something else. The visited page's own title is
  checked too now - the page is the authority on what it is.
- 48 suites / 768 cases.
## 1.12.1

- **The map half of a combined run died with `minScore is not defined`** - after the search half had already reported
  its results, so it read like a network problem in a run that had in fact collected nothing from the map. The value was
  inlined at one call site instead of being a variable; it now is one, used by both halves.
- **The result table printed the email under the 角色 heading**, because the header gained a column that the print line
  did not. A table whose columns are off by one is worse than no table: it silently misattributes every value.
- **`Lieferanten.de - Die clevere Lieferantensuche` came back as a lead at score 62** - a supplier *directory*, which
  the title filter did not know because it only spoke English. German directory words (Lieferantensuche,
  Lieferantenverzeichnis) and 供应商搜索/供应商目录 are in the filter now.
- 48 suites / 766 cases.
## 1.12.0

- **A third of the market was invisible: shops that never rank for a query but sell the product at an address.** The
  map source is now real: `sources: "maps"` (or `"both"`) with a `city` reads OpenStreetMap places - name,
  website, phone, address - and runs them through the same contact extraction, role check and scoring as search hits.
- **No geocoder, and no browser.** The obvious route (Nominatim: city -> bounding box) is unreachable from this
  network - measured, `UND_ERR_CONNECT_TIMEOUT` after 10 s - while Overpass resolves the city itself with
  `area["name"="München"]`. One fewer service to be blocked, and the map half keeps working when the extension
  bridge does not.
- Measured on Munich: **119 places, 73 with a website**, in one query - companies a search for "outdoor furniture
  importeur" never surfaces.
- 48 suites / 766 cases.
## 1.11.1

- **Two kinds of junk still reached the list.** A run for German outdoor furniture returned "Top Global B2B
  Marketplace" (score 10) and "Global Import Export Trade Data Provider of 100+ Countries" (score 0). Both are
  directories, and host blocklists lose that fight because aggregators rotate domains - but the *title* says exactly
  what the page is, so it is now filtered on that ("marketplace", "b2b", "trade data", "directory", "黄页", "名录").
- **A lead with no contact and no role evidence is not worth a row**, so there is a score floor (`minScore`, default
  20, `0` disables). Measured after both changes: 15 seconds, 2 leads, no marketplaces - down from 5 rows of which
  3 were noise.
- 48 suites / 763 cases.
## 1.11.0

- **A perfect score told you nothing about whether the company buys or sells.** Measured on a live run: a Chinese
  outdoor-furniture *exporter* came first with every box ticked (email, phone, contact page, product words) - it
  satisfies all of them, because the signals were about reachability, not about the role. The same run also surfaced a
  Swiss *manufacturer* and a Dutch wholesaler in the same shape.
- `classifyRole` now reads the page for role evidence - in both directions. A buyer says "we are an importer",
  "Großhandel", "Einkauf", "procurement", "private label"; a seller says "we are a manufacturer", "our factory",
  "OEM/ODM", "exporter", "Hersteller", "production capacity". Weighted, so "we are a manufacturer" is not the same
  statement as the noun appearing in a footer, and the verdict is `buyer` / `seller` / `unclear` - "unclear" is
  a legitimate answer and far better than a confident wrong one.
- The verdict moves the score (+15 / -25) **and** travels with the lead (`role` + `roleEvidence`), so a person can
  see why. `buyerOnly: true` drops the sellers entirely, because a competitor in a customer list is worse than a
  gap.
- Verified against the three real sites from the bad run: `nbymoutdoor.com` → seller (ODM / MANUFACTURER),
  `denova-gartenmoebel.ch` → seller (Hersteller), `tica.nl` → buyer (Groothandel). Two of three were never
  prospects.
- 48 suites / 761 cases.
## 1.10.0

- **Discovery no longer scrapes a search-results page.** Measured on this machine: Bing, asked for "outdoor furniture
  importeur" from a Chinese IP, answered with dictionary entries, JD.com listings and a Baidu Zhidao thread; the
  market-forcing parameters returned either nothing or off-topic German pages. Tavily answered the same question with
  GO IN GmbH and siebensee.com - actual outdoor-furniture sellers in Germany. Search now goes through the plugin's
  existing Tavily module, which also means one fewer moving part.
- **The browser is now a fallback, not a requirement.** Pages are fetched as plain HTTP and parsed with four small
  functions (`parseBingSerp`, `htmlToText`, `htmlLinks`, `pageFromHtml`) instead of a renderer. That matters
  because the extension bridge, measured mid-run, took 45 s per command and then returned nothing - the collector
  reported "0 results, no error" while the bridge was stuck. A site that refuses a plain client still falls back to
  the browser when one is connected.
- Measured end to end: **26 seconds for 5 leads** on a live run (`outdoor furniture` / `de`), where the previous
  architecture took 20+ minutes and was killed by the tool timeout.
- 48 suites / 758 cases.
## 1.9.2

- **The collector's budgets were only reachable by editing code.** They are the difference between "two minutes" and
  "twenty-five minutes, then killed", so they now live in prefs and are settable from two places a person already uses:
  `/collect step 12` in the chat (and `deadline 3`, `limit 10`, `searches 4`), and a 获客采集 block in the control
  panel. `/collect` with no arguments prints the effective values; `/state` reports the same numbers, so a card and
  a command can never disagree with what the tool actually uses.
- Resolution order is preference-then-argument: a tool call can still override per run, but the saved value is what an
  unadorned `collect_leads` uses. Each value is clamped to a sane range (3 s..120 s per step, 30 s..60 min per run,
  1..50 leads, 1..20 searches), because a typo of `120` seconds for a step is how a run silently becomes useless.
- 48 suites / 758 cases.
## 1.9.1

- **A live run took 25 minutes and was killed by the tool timeout.** Five leads, ~5 minutes each: a page that never
  finishes loading leaves the transport's own ceiling (45 s navigate + 30 s evaluate) to fire on *every* call, and
  nothing in the collector was willing to give up on it. Each step now runs under its own budget (12 s by default), the
  overall run under a deadline (3 min), and three timeouts in a row stop the run with `stopped: "bridge"` - because
  at that point the browser bridge is the problem, not the sites.
- **The deadline almost never fired, because the timer was `unref()`-ed.** An unref'd timer does not keep the event
  loop alive, so with a hung promise nothing else pending the process simply idles - the "timeout" is never reached.
  Found by the test that hangs a fake page on purpose, which is why that test now exists.
- **Directory filtering missed the Chinese B2B aggregators.** `10100.com`, `beiei.com` and the portal/news sites
  came back as leads at score 10-22; adding them (and the usual export portals) is what keeps a "lead" a company.
- 48 suites / 758 cases.
## 1.9.0

- **The plugin could drive a browser and send messages, but it could not turn "找德国做户外家具的进口商" into a list.**
  Doing that as a prompt loop works once and then drifts: the same company arrives twice under two spellings, a
  directory outranks every real company, and "found it" gets confused with "it is a buyer".
- `collect_leads` now runs the pipeline natively: generated query terms (role words in the market's own language) ->
  paged search -> directory filtering -> de-duplication on two axes -> homepage **and contact page** -> email / phone /
  WhatsApp extraction -> a score with the reasons that produced it -> the local lead store plus an optional CSV.
- The method is the valuable part, and it is deliberately narrow: a role word is a **recall hint, not proof** (the
  verdict comes from the site itself); a single SERP is dominated by directories so pages are walked until the budget
  or the hit target; `ACME GmbH`, `acme gmbh co kg` and `www.acme.de` all collapse to one lead; and no lead is
  ever reported with a bare score.
- `collect.js` is pure - no browser, no network, no filesystem - and takes the browser as an injected adapter. That is
  why the whole pipeline is tested against fixtures (10 cases: request building, directory filtering, both de-dup
  axes, asset-name and template-placeholder rejection, postcode-vs-phone, evidence-weighted scoring, idempotent merge).
- 48 suites / 756 cases.
## 1.8.2

- **An upload from a path outside the CLI's allowlist failed with `unsafe file path`.** lark-cli only accepts a
  `--file` inside the process working directory, the account's temp directory, or `~/files` - a sensible guard for
  a command a person types, and a wall for a plugin that is told to upload a file wherever it happens to live. Measured
  on a 1.79 MB archive in the workspace: rejected, and the node it had already created was left empty.
- The CLI is now spawned *from the file's own directory*, which puts the argument inside the allowlist without copying
  anything; a temp-dir copy remains as the fallback for paths the CLI resolves differently (a network path, for
  instance). The failure is also no longer silent: the tool reports the per-file error instead of `uploaded 0`.
- 47 suites / 746 cases.
## 1.8.1

- **The examples in the bridge's description named flags that do not exist** - `calendar +agenda --date today` (the
  real flags are `--start`/`--end`), `	asks +list` (the domain is `	ask`, and the shortcut is
  `+get-my-tasks`) and `im +send` (`im +messages-send`). An example is the first thing a model copies, so a
  wrong one is worse than none: it produces a validation error that looks like a broken bridge.
- Corrected in the tool description, the README and the inline hint. Verified against `lark-cli <domain> --help`
  rather than assumed.
## 1.8.0

- **The plugin only exposed the Feishu features somebody had already wrapped.** The official CLI ships 200+ commands
  across 18 domains - messaging, docs, base, sheets, slides, calendar, mail, tasks, meetings, wiki, okr, approval,
  attendance, contacts, minutes, drive, apps, markdown - and every one of them was reachable from a terminal and from
  nowhere else.
- Two tools now cover that surface instead of 200 hand-written schemas: `feishu_cli` runs any command as the person
  who authorised the CLI, and `feishu_cli_help` prints the CLI's own help so the exact flags are known before the
  first attempt. A tool per command would have been 200 schemas in every prompt and would be wrong the first time
  lark-cli ships a new domain; the CLI stays the authority on what exists.
- The command line is tokenised locally and passed as argv - no shell is involved anywhere - so a Chinese title with a
  space, an `&` or an empty string reaches the CLI byte for byte. Two guards exist because a tool call is not a
  terminal: commands that wait on a human (`auth login`, `config init`/`remove`) are refused instead of hanging
  until the timeout, and anything carrying `--yes` needs `confirmDanger` first.
- `--json` is added automatically, and an omitted flag is not an error: a command that fails returns the error, its
  hint and its scope-apply URL instead of a bare `ok: false`.
## 1.7.1

- **The knowledge-base links pointed at `www.feishu.cn`, not at the tenant.** A link a person clicks has to carry their
  own domain: `www.feishu.cn/wiki/space/<id>` only lands after a redirect round-trip, and pasted into a chat it reads
  as a generic page rather than "your knowledge base".
- `lark.js` now learns the tenant host from whichever URL the CLI hands back - node creation, file upload - and, so
  that the very first listing already has links, from one read-only document search keyed on a knowledge base's own
  name. The shortcuts that look like they would answer this do not: `whoami`, `spaces get` and `node get` all omit
  the domain, and `tenant/v2/tenant/query` needs a bot scope this app does not hold.
- An account with no searchable documents still gets the generic link rather than an empty line.
## 1.7.0

- **The whole `feishu_*` family speaks as the application, and an application is a member of nothing.** Measured on a
  real tenant: a document created with `tenant_access_token` lands in the app's own drive space, where no person can
  open it; a 知识库 refuses writes from a non-member, so `move_docs_to_wiki` cannot work at all; and adding the app to
  a space is an administrator action most individual users simply cannot perform.
- Three tools now speak as **the person**, through the official [`larksuite/cli`](https://github.com/larksuite/cli)
  (`user_access_token`): `feishu_wiki_spaces` (what this account can write to, plus whether the user identity is
  authorised yet), `feishu_wiki_new` (create a space) and `feishu_wiki_upload` (one file, or a whole local folder
  tree - one node per top-level folder, skipping nodes and files already present, so a retry never duplicates).
- New `lark.js`, dependency-free: locate the CLI, run one command, parse its `{ok, data}` envelope. No Feishu
  credentials are stored here - `lark-cli config init` and `auth login` own those, in the OS keychain.
- 46 suites / 739 cases.

## 1.6.12

- **The one-click extension install failed with "cannot find path …\\.dsh\\exports".** `packExtension` handed
  `Compress-Archive` a destination in `$DSH_HOME/exports`, which `Compress-Archive` does not create - a machine that had
  never produced an export has no such directory, so the install died before Chrome's page was even opened. The directory
  is created first now (where every caller gets it), and a directory that genuinely cannot be created names its path
  instead of surfacing the PowerShell line.
- A test pins it: packing into a nested directory that does not exist leaves the directory behind.
- 46 suites / 739 cases.

## 1.6.11

- **WeCom was a grey hint line at the very bottom of the card** - outside every section, below the integrations block,
  reading `企业微信: 未配置 · 配置` where the second half looked like a label rather than something to click. Its two
  sibling channels (QQ, mail) sit inside 消息通道 with a name, a status and an action; WeCom now does too:
  **企业微信** · `未配置` · [配置] right under the mail block, and the link is button-shaped.
- The line was the only channel whose state was printed as prose in a hint, so "is 企业微信 broken?" had no answer on
  the card. The row says the same three states the backend does: `long connection ✓` when the intelligent robot is
  authenticated, the configured transport when credentials exist, `not configured` otherwise.
- 46 suites / 738 cases.

## 1.6.10

- **The browser-automation block was one flex row with everything in it** - which is why the 代理 field's label landed on
  top of the input next to it, 走代理的域名 wrapped into a second line with its 保存 button below, and 保存浏览器设置 sat
  alone on a line of its own. It is now: which browser (频道 / 端口 / 配置目录), how it runs (模式 / 会话 / 目标), one row
  for the extension controls (导入登录 / 扩展驱动 / 光标 / 一键安装扩展), then the proxy field, the proxy host list with its
  save, the scope line, and the save action - each on its own line, in that order.
- **A button that is a direct child of a column-flex card stretched to the full width** and read as a banner rather than
  a button; `.dswxCard > .dswxBtn { align-self: flex-start }` fixes every stacked block at once.
- **The extension status was one run-on line**: status, paste-able address and token, then the counters. It is three
  lines now - the address and token together, because those are the two things a person copies into the extension.
- Tavily and 浏览器自动化 were grey hint lines inside 集成; they are section titles now, so the block has a hierarchy
  instead of three unrelated paragraphs.
- 46 suites / 738 cases.

## 1.6.9

- **The contacts card was still one mixed bag.** 1.6.8 gave every block a frame, but this one kept its contents: the
  allowlist switches (which decide who may talk to the bot) shared a single flex row with seven capability switches
  that have nothing to do with contacts - desktop control, the clipboard, SSH, serial, multi-agent, retry, interjection -
  and with the SSH "add host" form, which wrapped onto its own line. Eleven checkboxes and a text box where only two
  controls were about contacts.
- The capability switches now live in a titled **能力开关 / Capabilities** section inside the same card, one per line,
  and the SSH host form takes the full width with its button beside it.
- The chats the bridge has actually seen sit directly under the switches that decide what to do with them; they used to
  render after the token ledger, three blocks further down. The transport sections (channels, token usage) are siblings
  of the contacts card again instead of nesting inside it.
- A test pins the shape: the capability section is nested in contacts, peers come before the token ledger, and each peer
  keeps its allow action.
- 46 suites / 738 cases.

## 1.6.8

- **The pairing QR rendered at the bottom of the card.** The `.dswxQr` block sat after the token ledger and the peer list, at the end of a
  card ~3,000px tall, while the button that starts it sits at the top: "Add an account (QR code)" looked dead unless the person scrolled
  three screens looking for the code. It renders directly under the button now (measured `qrTop=509`, first screen).
- **Cancel did not stick.** `cancel()` wrote `cancelled`, but a poll that was already in flight wrote the platform's `wait` back over it -
  and `#issue()` reset the record to `pending` while re-fetching a code - so the attempt came back to life, kept issuing QR codes and
  reported `pending` again. Both write paths now check `TERMINAL` first; a test drives a cancel through an in-flight poll.
- **A blocked chat never got the one notice it is meant to get.** `handleInbound()` called `explainBlockedOnce({ ..., reply, verdict })`,
  and `reply` is not in that scope: the argument object threw `ReferenceError` before the helper ran, so the allowlist silently dropped
  messages while the explanation - the only visible evidence of the drop - was never sent. It passes the account's own sender now
  (`sendText(account, chatId, ...)`). Verified in WeChat: the 🔒 notice arrives, `blocked` increments, `forwarded` does not.
- **The card reported the wrong GUI port.** `noteGuiPort()` preferred `$DSH_WEB_URL` and persisted it at boot, but that variable is
  inherited by every shell the GUI spawns: a server on 19503 advertised (and wrote to `gui-port.json`) 19387, which the card, `/doctor`
  and the VS Code bridge then repeated. The request's own `Host` wins now, the environment is only a fallback, and boot no longer persists
  it.
- **The card polled `/state` once a second, forever, hidden or not.** One slow loop now runs at 10s; a second tick at 1s exists only while
  a QR is on screen, released the moment the attempt ends; a hidden tab does not ask, coming back refreshes immediately, and the two paths
  share an in-flight guard. Measured: 25s idle -> 2 requests (was 25); with a live QR -> 10 in 10s.
- **Every input was a fixed 110px**, so a save directory, a webhook URL, an App ID or a token showed its first few characters and nothing
  else, and the selects cut their own options ("整段（写完…"). Inputs have a minimum and grow with the row, selects size to content, the
  textarea takes the full width.
- **The card was one undivided wall of controls.** Added `.dswxSection` / `.dswxSectionTitle` and framed the blocks that are their own
  subject: message channels (QQ / mail / delivery / approvals), inbound directory, integrations (Feishu / Tavily / browser), office,
  scheduled tasks, contacts, token usage.
- **`runApprovalSelfTest()` called `setFailed()` and `setMessage()`, which this component never declared** - dead code left behind when
  the self-test became a link to `/send-test-approval`, waiting to throw `ReferenceError` at whoever re-wired it. Removed.
- **QQ "Reconnect now" failed silently**: `reconnectQQ()` had no `catch`, so a failed POST became an unhandled rejection and the button
  looked inert. The reason is shown on the card now.
- **Any web page could drive the loopback routes.** Every mutation is a plain GET (that is what keeps the card usable where POSTs never
  arrive), so `<img src="http://127.0.0.1:<port>/dsh-wechat-media/logout">` on any site could unpair an account or flip a preference.
  One guard wraps the whole route table: `Sec-Fetch-Site: cross-site` or a foreign `Origin` gets 403 (same-origin 200, no header 200).
- The `save` label was defined twice in each dictionary (the second silently won), and "saved from this panel: longConnection" printed the
  internal field name; field names map to labels now.
- **A machine with System.Speech but no voice produced a 44-byte "voice message".** SAPI wrote the RIFF header and
  nothing else; the guard only refused a zero-length file, so a chat would have received an unplayable voice message.
  `voiceSupport()` reports the installed voice count now, `synthesizeVoice()` refuses a header-only WAV with a sentence
  that names the cause, and the real-synthesis test skips where there is no voice to synthesise with.
- 46 suites / 737 cases (7 new, covering the poll cadence, the undefined setters, the QR placement, the input width, the sections, the
  cross-site guard, the cancel race and the blocked-chat notice).

## 1.6.7

- **The email channel can trust a specific CA (`email.caFile`), because this machine's TLS is being decrypted.** The diagnosis:
  `imap.qq.com:993` presents a certificate issued by **"AO Kaspersky Lab"** while `smtp.qq.com:465` presents DigiCert - Kaspersky's
  encrypted-connection scanning intercepts IMAP. Browsers accept it from the Windows store; Node does not read that store, so verification
  failed and the channel could not receive at all.
- Proven before building it: passing that root as `ca` makes the same connection report `authorized: true`.
- A certificate refusal now says what it means - "本机可能有杀毒软件/代理在解密 TLS，把根证书导出为 PEM 填到 email.caFile" - instead of leaving
  the OpenSSL line as the whole story.
- Verification stays **on**: disabling it would hand the mailbox password to whatever is in the middle, which is a worse deal than a CA file.
- 46 suites / 730 cases.

## 1.6.6

- **The mask helper un-masked what the previous line had just masked.** `maskSecretPrefs` copied `{ ...source }` from the *original*
  prefs on every iteration, so a block holding two secrets had its first field restored to plaintext by the second: email's `smtpPass`
  came back in the clear from `/state` while `imapPass` was `***`. One secret per block had hidden this since the first release.
- Each iteration copies from the accumulating result now, and a test pins the two-secrets case explicitly (both masked, nothing else
  touched, no plaintext anywhere in the payload).
- 46 suites / 730 cases.

## 1.6.5

- **`GET /state` echoed both email passwords in the clear.** `publicPrefs` masked secrets with a **hand-written list per channel**
  (feishu, tavily, qq, the webhook); the email block was added without one, so the two passwords came back verbatim - the 1.1.7 mistake,
  for a new field. On disk they *were* sealed (`secrets.js` already listed them), which is exactly why the leak was easy to miss: the
  store knew, the redaction did not.
- The masking now reads the store's own `SECRET_PATHS` through `maskSecretPrefs` in `secrets.js`, so a new field is masked by being listed
  once. A test walks that list and asserts every entry comes back as `***` and appears nowhere in the payload.
- 46 suites / 729 cases.

## 1.6.4

- **The email fields could not be typed into.** They were controlled inputs (alue from useState) inside the card, and the card
  re-renders whenever /state refreshes - so every keystroke was overwritten by the next render and the boxes looked locked. They are
  uncontrolled now, writing into a draft held on globalThis (which also survives a re-mount), and saveEmail reads that draft. The
  passwords are cleared from it once a save succeeds.
- 46 suites / 728 cases.

## 1.6.3

- **The email channel is in the Web UI dashboard too.** /dashboard (the script-free page the card links to) listed every channel
except email: it now has a 邮件通道 row - state (关闭 / 已开启 / 已开启但不可用 + reason), mailbox, SMTP and IMAP hosts, how many senders are
allowed, handled / replies / skipped, and the last error - plus a 邮件处理失败 line in the failure table.
- The card remains the place to edit hosts and passwords (the secrets never travel back to the browser); the dashboard is read-only by
design, and /email plus POST /dsh-wechat-media/email are the actions.
- 46 suites / 728 cases.

## 1.6.2

- **`handled` counted the wrong thing.** A diagnostic run reported `failed: 1` with an OpenSSL `WRONG_VERSION_NUMBER`, which was the
  **reply delivery** failing against a plaintext fake server (correctly refused: no TLS) *after* the turn had run. Because `handled` only
  incremented once the whole function finished, a delivery problem read as "the turn did not run". Split now: `handled` = a turn ran,
  `replies` = a reply was delivered, `lastReplyError` = why delivery failed.
- A delivery failure names the host and port (`发信失败（SMTP host:port）：…`); the bare OpenSSL line named neither.
- 46 suites / 727 cases.

## 1.6.1

- **`/state` did not expose the email status.** The patch landed on the wrong `qq: qqStatus` (there are two in the file), so the card's
  status line had nothing to read even though `/email` returned it.
- **A failed email turn was invisible**: log only, so the card said "handled: 0" with no reason. Failures are counted and the reason is kept
  in `emailStatus.lastError`, which `/email` and `/state` both return.
- 46 suites / 727 cases.

## 1.6.0

- **A new channel: email.** SMTP out, IMAP in, open source. One session per sender, the same collector and commands; `/email` shows the
  state, toggles it, fetches once, sends a self-test and maintains the allowlist, and the card carries the same controls.
- **No new dependencies**: both protocols are written against `node:tls` / `node:net` in `email-wire.js` and tested against fake SMTP and
  IMAP servers. That is how two real defects were caught before release: `smtpSend` wrote nothing but `QUIT` (its helper only read
  replies), and a non-ASCII subject stayed RFC 2047 encoded so the model saw base64 instead of 备份说明.
- **Inbound is closed by default**: an empty `allowSenders` means nobody (addresses are spoofable), `*@example.com` wildcards work,
  fetching uses `BODY.PEEK[]` and marking read happens only after the turn.
- **STARTTLS or nothing**: a server without it is refused rather than sent a password in the clear.
- Attachments are named, never downloaded; multipart / base64 / quoted-printable / UTF-8 / GB decode with fallbacks.
- 46 suites / 727 cases.

## 1.5.17

- **The QQ reconnect state is on the card**, with a button that retries on demand: `重连中 · 8s 后重试 · 次 3 · socket closed`, read from
  `nextAttemptAt`, `attempts` and `reconnectReason`.
- New route `POST /dsh-wechat-media/qq` (`status` | `reconnect`); the credentials are already in prefs, so the button rebuilds the
  gateway connection without them round-tripping through the browser. An unknown action is a 400.
- 44 suites / 702 cases.

## 1.5.16

- **The QQ bot never came back after a disconnect.** `closed`, `error` and op 7 `reconnect` were logged and forgotten, so a network blip or
  gateway restart left the bot silent until the app restarted. Now: server-initiated op 7 returns in 300 ms, a dead socket backs off
  1s → 2s → 4s … capped at 60s, `ready` resets the count, an explicit stop cancels the timer, and a failed handshake retries too.
- The approval bridge was fuzzed and is sound: a second question in one chat is refused instead of overwriting the first (which would leave
  a tool call waiting for its full timeout), a timeout clears the map, `onTimeout: "decline"` resolves `rejected`, cancel releases once.
- 44 suites / 700 cases.

## 1.5.15

- **`/new` during a running turn killed that turn**: it disposes the old conversation handle, so the answer came back empty and the phone
  showed a reply cut off mid-sentence. It now refuses while a turn is answering and says what to do instead.
- **A chat that is not on the allowlist got complete silence**, not even `/help` - which is how a whole test run was lost. A blocked direct
  chat now gets one explanation, remembered per chat for 24 hours.
- **Interjection verified**: with interject on and a turn streaming, an injected message was steered into that turn (`interjected +1`,
  decision `steer`), the turn returned its full answer, and nothing failed over.
- 44 suites / 700 cases.

## 1.5.14

- **A security pass over the access-control surface**, clean: account ids collapse to `[A-Za-z0-9_-]`, so `../escape`, `..\\escape`,
  `/abs/path` and `C:\\absolute` cannot produce a separator or a traversal; `allowed: null` reads as *not listed*; `allowed: "true"` does
  not count as allowed.
- One hardening: an id written entirely in another script (`长号`) normalised to the empty string, so its file would be `accounts/.json`,
  shared by every such id. Empty and over-long ids get a stable digest suffix.
- 44 suites / 699 cases.

## 1.5.13

- **`chunkText` could cut a surrogate pair in half**, leaving an invalid character on the wire; the cut now steps back one unit.
- **A cut could land inside a code fence**, so a chunk showed an opening ``` with no closing one; the seam closes and reopens it.
- **A one-word timeout was never retried** although `/retry` promises it: the pattern required `timed out`, while the messages that arrive
  are `timeout after 60000ms` and `request time-out`.
- 44 suites / 699 cases.

## 1.5.12

- **`{multiAgent:{enabled:"true"}}` returned 200 and stored `false`** - a caller turning the feature on switched it off, because the route
  compared `=== true`. Booleans now read through `asBool`, and a value that is neither a boolean nor a boolean word is a 400.
- **An unknown field name returned 200 and was dropped**, so `{"multiagent":…}` looked like success. A near-miss is a 400 naming the
  suggestion, and a genuinely extra key comes back in `ignored`.
- 44 suites / 699 cases.

## 1.5.11

- **A failed `POST /inbound` became permanently "duplicate"**, so a retry was dropped: the id was recorded before the turn ran, and a throw
  left it marked. Recorded after the turn now, and released on failure.
- **`describeTask` threw on a record without `payload`**, which would take out `/task list`, the panel and the `/tasks` route; the row
  degrades instead.
- The past-`once` behaviour was checked and is correct: a late one-off fires once, immediately, and is not fired twice.
- 44 suites / 698 cases.

## 1.5.10

- The scheduler fuzz found `describeTask` throwing on a half-built record (fixed in the same area as 1.5.11) and confirmed the rest of the
  arithmetic: `daily` is exactly 24h, `every 30m` exactly 30 minutes, `weekly mon` lands on Monday, invalid times are refused with a reason.
- 44 suites / 697 cases.

## 1.5.9

- **Concurrent `/prefs` writes lost each other.** `savePrefs` is a read-modify-write over one JSON file, so two calls in flight both read
  the old file and the later write discarded the earlier field - measured with ten parallel requests: **seven of ten fields ended up at
  their previous values**. Saves are chained through a queue now, and a temp-root test proves ten concurrent patches all survive.
- The same round checked and cleared: 500-character names truncated to 80, emoji paths accepted, 1 MB and 200 KB payloads refused, `/tokens`
  clamping, and nonsense schedules and task actions refused.
- 44 suites / 697 cases.

## 1.5.8

- **`scripts/` now ships with the package.** 1.5.7 put the acceptance scripts in the repository but not in `files[]`, so an installed copy
  had no `scripts/bug-hunt.mjs` - and the release verifier did not notice, because it only checks what `files[]` claims.
- 44 suites / 696 cases.

## 1.5.7

- **The acceptance scripts now ship**: `scripts/bug-hunt.mjs` (offline fuzz plus, with `--live`, hostile HTTP against the running plugin;
  every live check is a read or an expected 4xx) and `scripts/verify-release.mjs` (work tree vs GitHub `main` vs the installed copy,
  restricted to `files[]`). Exit code 1 gates a release.
- 44 suites / 696 cases.

## 1.5.9

- **Concurrent `/prefs` writes lost each other.** `savePrefs` is a read-modify-write over one JSON file, so two calls in flight
  both read the old file and the later write discarded the earlier call's field. Measured with ten parallel `POST /prefs`:
  one answered 400 and **seven of ten fields ended up at their previous values**. The card sends one field per request, so this
  needs two tabs, a script, or a retry landing at the same instant - which is exactly when nobody is watching. Saves are now
  chained through a queue, and a temp-root test proves ten concurrent patches all survive.
- What this round also checked, with a clean result: a 500-character name is truncated to 80, an emoji path is accepted, a 1 MB
  and a 200 KB payload are refused with 400, `/tokens windowDays=999` clamps to 30, and a nonsense schedule or task action is a
  400.
- One alarm was mine, not the plugin's: I expected chat names on `/dashboard`, and XSS-escaped them there. The dashboard does not
  render peer names at all (4013 bytes of counters and accounts), so the escaping test proved nothing either way. The card
  renders names through React text nodes, which escape by construction.
- 44 suites / 697 cases.

## 1.5.8

- **`scripts/` now ships with the package.** 1.5.7 put the acceptance scripts in the repository but not in `files[]`, so an
  installed copy had no `scripts/bug-hunt.mjs` - and the release verifier did not notice, because it only checks what `files[]`
  claims. Anyone who installed the plugin could not run the check that is supposed to gate a release.
- 44 suites / 696 cases.

## 1.5.7

- **The acceptance scripts now ship**, as `scripts/bug-hunt.mjs` and `scripts/verify-release.mjs`, with a short
  `scripts/README.md`. They are the checks that found five defects no suite caught in the 1.5.x line.
- `bug-hunt.mjs` runs the offline fuzz (parser, every help page by name and alias, three pref normalisers, QQ payloads,
  scrapling validator) and, with `--live`, hostile HTTP against the running plugin. Every live check is a read or an expected 4xx,
  so it cannot damage an installation. Exit code 1 gates a release.
- `verify-release.mjs` compares the work tree, GitHub `main` and the installed copy - the last one restricted to `files[]`, with
  a note about why tests are not expected there (that miscount was the first version's false alarm).
- 44 suites / 696 cases.

## 1.5.6

- **Every `POST /peers` answered 400 with an empty body.** The known-account check added in 1.5.5 called `wecomConfig()` - a helper
  that **does not exist in this file** (the WeCom bot id lives in `state.loadWecom()`). The ReferenceError was caught by the
  dispatcher, which answers 400 with no body, so renaming a chat simply stopped working with nothing to read.
- **The same phantom call was already there, latent, in `targetByTransport`**: a task that targeted WeCom by transport would have
  thrown the moment it ran. Both call sites read the store now, and a test forbids `wecomConfig(` from coming back.
- Worth recording because it is the fourth variant of one root cause in this session: **a helper referenced from new code has to be
  looked up, not assumed** - `feishuConfig()` does exist, `wecomConfig()` never did, and at a call site the two look identical.
- 44 suites / 696 cases.

## 1.5.5

A deliberate bug hunt on the live plugin (hostile HTTP input plus a fuzz of every pure function) found four real defects. All
four are fixed, each with a test.

- **`POST /peers {"allowed":"maybe"}` stored `allowed: null`** and silently **un-allowed** a chat that had been allowed: `null` is
  not `true`, so the next message was blocked. The 1.1.4 guard covered "the field was absent", not "the field was unreadable";
  a non-boolean is now a 400.
- **`POST /peers` created a peer for an account that does not exist** (`no-such-account/x` then appeared in every list). Known
  ids are now derived from pairing, the WeCom bot id, the QQ appId, the Feishu app id and existing buckets; anything else is a
  400 - an allowlist entry for a non-existent account is a typo, not a decision.
- **A manual chat name was overwritten by the next inbound message**: `/name` and `POST /peers {name}` wrote a readable name,
  then every inbound message wrote `name: peerName` over it. Measured: the QQ chat renamed to "PawDesk 私聊" was showing its
  openid again. Names set by hand are marked `nameSource: "manual"` and inbound traffic only fills blanks.
- **`normalizePort("COM0")` was accepted.** Windows starts at COM1, so `COM0` (and `COM03`) are typos - and accepting them made
  the failure surface later as "no such port", which teaches nothing. They are refused with the expected shape.
- What the hunt also confirmed, so it stays confirmed: 113 offline assertions over the parser, the help renderers, the three
  pref normalisers, the QQ payload builders and the scrapling validator; and 23 hostile HTTP calls that all answer 4xx with a
  readable reason and never a 500.
- 44 suites / 695 cases.

## 1.5.4

- **`/help <命令>` answers "what is the default?" and "when does it take effect?"** - two lines per command from a single
  `COMMAND_META` table, e.g. `默认：whole（整段）` / `生效：立即`, and for `/agent`: `默认：跟随宿主默认（预设与模型都不覆盖）` /
  `生效：下次新建 agent 时生效`. That last pair is the difference between a feature that looks broken and one that is waiting
  for the next agent.
- **The coverage test earned its keep on its first run.** It requires an entry for every state-changing command and refuses
  entries for names that are not commands, and it immediately exposed **three phantom names** I had introduced in the help
  tables: `allowlist`, and `wecom` twice - there is no `/allowlist` and no `/wecom` command (both are panel features).
  `helpText` had been skipping unresolvable names silently, which is why a group could list a command that never existed.
- The group table is now asserted to contain only real commands, so a typo in it fails the suite instead of quietly shrinking
  a section.
- 44 suites / 694 cases.

## 1.5.3

- **`test/commands.test.mjs` was missing from the repository** since 1.5.0, while three releases shipped without anyone
  noticing. Cause: each publish script carried a hand-maintained list of files, assembled by string replacement, and one of
  those replacements matched nothing - so the test file was simply never uploaded. A release that names a version while a
  file it changed is absent is the same class of failure as 1.0.0 shipping four files.
- **The list is gone.** `publish-diff.cjs` compares the work tree against `main` and uploads exactly what differs or is new,
  then reads every uploaded file back and compares hashes. There is no list to keep in sync, so it cannot drift again.
- Verified after this release: `main` matches the work tree file for file (98 identical, 0 different, 0 missing).
- 44 suites / 693 cases.

## 1.5.2

- **`/help agent` threw `accountId is not defined`.** The live-state helper was moved above `runChatCommand` in 1.5.1 (a nested
  declaration truncates the dispatcher slice another test scans), and moving it out of the dispatcher removed its access to
  `accountId`/`chatId` - which the per-chat lookups need. They are passed in a context object now.
- A test pins the shape: the helper takes `(name, context)`, unpacks both ids, and the call site supplies them. The general
  lesson, written down because it has now cost two releases: **a helper moved out of a function is a helper whose free
  variables need re-checking**, not just re-indenting.
- 44 suites / 693 cases.

## 1.5.1

- **多 agent has its own group in `/help`.** It was filed under 运维 next to `/doctor` and `/tokens`, which is the one place a
  reader looking for the newest pair would never look. The groups are now 会话 / 发送 / 授权与联系人 / 工具 / 通道 / **多 agent** /
  运维.
- **Detail pages carry values and current state.** `/help <command>` now shows `可用值` (the fixed set a command accepts -
  `/delivery` really does take `stream`, `/auth` really has four levels) and `现状` (what this install is set to right now:
  the multi-agent switch, this chat's preset and model, the host default model, serial baud and port, the QQ connection, the
  delivery and format modes…).
- The split is deliberate: static enumerations live in `commands.js` (`COMMAND_VALUES`), and the live lines are computed in
  `index.js` where the state already is - a help page that caches state is a help page that starts lying.
- `/help <alias>` resolves too (`/help /clip`, `/help 预设`), which is what makes printing aliases worth anything.
- Same lesson, twice in two releases: **a helper inserted inside `runChatCommand` truncates the dispatcher slice the wiring test
  scans**, and the test caught it again (`/new must bump the generation` failed). Both helpers live above the dispatcher now.
- 44 suites / 695 cases.

## 1.5.0

- **`/help` was a wall of 26 flat lines** with no aliases and no way to ask about one command. It is now **grouped** (会话 /
  发送 / 授权与联系人 / 工具 / 通道 / 运维), each row shows its **aliases inline** (`/clipboard（/clip、/剪贴板）`), and a command that
  is not in the grouping table still appears under 其它 - so forgetting to classify one degrades the order, never the
  completeness.
- **`/help <命令>`** answers about one command: usage, aliases, summary, and the sub-forms that a summary cannot hold. That is
  where `/agent model list` / `/agent model reset` are documented now, and where `/ssh add`, `/serial baud`, `/browser hosts`
  and friends stop being folklore.
- `/agent`'s usage line now names its sub-commands (`model <p>/<m>`, `model list`, `model reset`), which the old line omitted
  entirely.
- The suite gained a test for the detail page: an alias resolves to the same page, an unknown name falls back to the list
  instead of silence, and every command has exactly one row. That last assertion originally counted substrings and failed on
  `/help` itself, because the footer hint mentions it - a row check is what the help actually promises.
- 44 suites / 693 cases.

## 1.4.5

README only, recording what the last two live runs established:

- **The model catalog this host actually has** is now in the multi-agent section: two providers (`deepseek-official`,
  `deepseek-account`) offering `deepseek-flash` and `deepseek-v4-pro`, with the default marked. That answers "what may I
  put there?" without asking anyone to open the Models page.
- **The verified swap** went in the table: `/agent model deepseek-account/deepseek-v4-pro` then `/new`, and `GET /state`
  reported `conversations[].agentModel = "deepseek-account/deepseek-v4-pro"` - not the default - with the turn answering.
  So the override does not merely get stored; a different model runs.
- The rule stays where it was learned: a model name inside the host's provider needs nothing extra, a different provider route
  needs its own API key.
- 44 suites / 692 cases.

## 1.4.4

- **`/agent model list` threw `Cannot access 'hostProvider' before initialization`.** The listing block referenced a variable that
  belongs to the *set* path further down, so it hit the temporal dead zone - a mistake that only shows up when the command is
  actually used, which is why the first release of it shipped broken.
- The provider is now derived inside the listing block from `hostModel` (already in scope there) instead of reaching for a
  variable that is not initialised yet. Not hoisting it on purpose: `hostProvider` means "the provider being switched to" in
  the set path, and reusing the name for two meanings is how this happened.
- 44 suites / 692 cases.

## 1.4.3

- **`/agent model list`** lists every provider the host's `llm` service knows, with its models, and marks the one the host is
  currently using. `/agent model list <provider>` narrows it to one. The point is that a model name no longer has to be copied
  from the app's Models page, or guessed - the plugin asks the same registry the app asks.
- It reads the shape defensively: `listProviders()` may hand back strings or objects, `listModels(provider)` may be async, a
  provider may have no models, and a failure prints the reason instead of an empty list that looks like "none exist".
- The output repeats the rule the earlier versions learned the hard way: **changing provider needs that provider's API key;
  changing only the model name does not.**
- 44 suites / 692 cases.

## 1.4.2

README only, recording the two results the live runs produced:

- The verification table gained **Multi-agent: model** - `/agent model deepseek-account/deepseek-flash`, then `/new`, then a
  message: `GET /state` reported `conversations[].agentModel = "deepseek-account/deepseek-flash"` and the answer arrived. The
  same row records the trap that made the value worth writing down: `deepseek-official/deepseek-chat` fails with
  `no API key for provider route "deepseek-official"`.
- The multi-agent section now says why: **the provider half is the part that carries credentials**, so copying the host's
  `provider/model` and changing only the model name is the safe edit, and switching provider is a different account rather
  than a different model.
- 44 suites / 691 cases.

## 1.4.1

- **The per-chat model worked, and then taught the lesson it needed to teach.** `/agent model deepseek-official/deepseek-chat`
  was applied - the turn really did switch provider routes - and failed with `llm-deepseek: no API key for provider route
  "deepseek-official"`. The error is correct and well placed, but nobody should have to discover which routes have credentials
  by breaking their chat.
- **`/agent model` with no argument now prints the host's own selection** (`provider/model`), which is the value known to work
  because the host is already using it: change the model half, keep the provider half, and nothing new has to be authorised.
- **Switching provider is warned about at the moment it is set**, not at the next failed turn: the reply says the new route
  needs its own API key and names the host's current value for comparison.
- The override itself is unchanged - it is opt-in, so it remains the caller's decision.
- 44 suites / 691 cases.

## 1.4.0

- **A model per conversation, and only when you ask for one.** `/agent model <provider>/<model>` pins that chat's model;
  `/agent model reset` clears it. With nothing set, the chat keeps using the host's own selection - **no implicit override**,
  because a default here would move every conversation onto a model nobody chose and surface as a billing surprise rather
  than a setting.
- Same gate as the presets: the override only applies with `/multiagent on`, and with the switch off `/agent model …` says so
  instead of storing a value that will never be read.
- A malformed value is refused with the shape it wanted (`provider/model`), and an unreadable value found later is logged and
  ignored rather than breaking the turn - the host's selection stays in charge.
- `/agent` now shows both lines (预设 / 模型) and `/state`'s `conversations[]` carries `agentModel` next to `agentPreset`, so an
  override is verifiable from outside the chat the same way the preset is.
- A wiring test pins the opt-in rule: the model is read only when the switch is on, and `const effective = peerModel ?? selection`
  is what keeps the default behaviour intact.
- 44 suites / 691 cases.

## 1.3.3

README only, recording what the live test showed:

- The multi-agent section now names the four presets this host declares (`standard`, `ptc`, `minimal`, `cordis`) and states
  what the switch is *for*: two conversations can run different presets at the same time, and the choice survives a restart
  because it lives on the peer record.
- The verification table gained the row from the actual run: `/agent minimal` then `/new`, and after the next message
  `GET /state` reported `conversations[].agentPreset = "minimal"` `-` with the reply arriving, so the preset is applied when
  the agent is created rather than merely stored.
- A correction worth recording: an earlier reading of `counters.answered = 0` as "the reply failed" was wrong - that counter
  tracks consumed approval answers, not WeCom turns. The reply had arrived.

## 1.3.2

- **"跟随默认" now has a name.** `/agent` prints the host's default preset id and marks it in the list. A chat that follows the
  default used to say so without saying *what* it was following.
- **`/state` reports which preset each live conversation mounted.** The agent is created lazily, so after `/agent <preset>` the
  only proof was a log line; `GET /state` now carries `conversations[].agentPreset`, which makes the effect verifiable from
  outside the chat.
- The live result that prompted this: `/agent` lists four presets on this machine - `standard`, `ptc`, `minimal`, `cordis` -
  and none was marked default, which is exactly the ambiguity the first point removes.
- 44 suites / 690 cases.

## 1.3.1

- **/agent could not list the presets, and said so wrongly.** The first version checked Array.isArray(presets.list) - but
  list is a **method**: sync list() returns { presets: [{ id, isDefault, name?, description?, broken? }] }. That is what
  the packed app bundle's schema says (read from pp.asar, not guessed), and it means the reply '宿主没有暴露预设列表' was
  false: the host does expose them, the plugin was looking at the wrong shape.
- The listing now shows the id, the display name when it differs, a 默认 marker, and **加载失败：<diagnostic>** for a preset whose
  definition is broken - choosing one of those would mount nothing, so hiding it is the one thing that would mislead.
- /agent <id> validates against that list when it is available, so a typo is refused immediately instead of at agent-build
  time.
- 44 suites / 690 cases.

## 1.3.0


- **Multi-agent: one independent agent per conversation.** Every session already held its own agent object, so the feature is
  about *what that agent mounts*: with the option on, a chat may mount **its own agent preset** - its own prompt, tools and
  model wiring - and the choice is remembered on the peer record. Off (the default) every chat mounts the host default
  exactly as before.
- **`/multiagent on|off`** is the switch, **`/agent`** lists the presets and shows this chat's choice, `/agent <preset>` sets
  it, `/agent reset` goes back to the default. A preset change takes effect when the session next creates an agent - the
  command says that instead of implying a live swap.
- **With the switch off, `/agent` refuses to look like it worked**: it names the switch that is off and why the setting has no
  effect, the same rule the other opt-in capabilities follow.
- The card gained the checkbox, and `prefs.multiAgent` is validated on the way in (only the literal `true` enables it).
- Honest limit: the host's preset list is read defensively (`list` or `all`, ids or names). If a host exposes neither, setting
  a preset by id still works but stays unverified until an agent is built - and that sentence is in the command's own output.
- 44 suites / 690 cases.

## 1.2.1

README only, and it was overdue in two places:

- **The version line said v1.0.3** while 1.2.0 was current - three releases stale. It now says v1.2.0 with the real test count
  (44 suites / 690 cases).
- **The Security section never mentioned sealing.** It explained the token file, the loopback-only routes and the spare-account
  advice, but not the fact that every other credential is `dpapi:` ciphertext bound to the Windows account. It does now,
  including what happens to a path added later (`sealExistingSecrets`) and to a value that cannot be opened (reported, not
  silently absent).
- The verification table gained a **Secrets at rest** row with the numbers from the live check: 32 characters of secret became
  a 358-character `dpapi:` value, `/state` returned `***`, and the QQ bot stayed `ready`.

## 1.2.0

- **Every secret is now sealed at rest, including the two that arrived late.** `secrets.js` has had a DPAPI-sealed
  `SECRET_PATHS` table since 0.32 - but a path only gets sealed if it is *in* that table, and QQ's `clientSecret` and the
  top-level `webhookSecret` were never added, so both sat in `prefs.json` in the clear. They are in the table now, and
  `prefs.json` holds `dpapi:…` ciphertext bound to this Windows account instead.
- **Top-level secrets are a real case, not a hack**: `webhookSecret` has no section, so `mapSecrets`, `plaintextSecrets`,
  `savePrefs` and read-back all learned about a `TOP_LEVEL_SECRETS` list rather than pretending it lives in a block.
- **A prefs file written before a path existed is sealed on activation.** Waiting for the next preference change would make
  "encrypted at rest" a claim about the future; `sealExistingSecrets()` runs once, logs what it sealed, and does nothing when
  there is nothing to do. Unreadable ciphertext (another account or machine) still reports itself instead of pretending the
  credential is absent.
- 44 suites / 690 cases.

## 1.1.7

- **`/state` returned the QQ `clientSecret` in the clear.** Feishu's `appSecret`, Tavily's `apiKey` and the webhook secret are
  all masked as `***`; QQ's was not, which made it the only stored secret readable from a page. Loopback-only or not, a
  readable page is still a credential when it does not have to be. It is masked now, and a source-level test asserts **all
  four** blocks so the next newly-stored secret cannot slip through the same way.
- A note on how this went: the first attempt tried to move `publicPrefs` out of `apply` so a test could call it, and the
  brace matching that extracted the function was fooled by braces inside its template literals - leaving `index.js`
  syntactically broken. Restored from the installed package, redaction added in place, guarantee checked by the guard test
  plus a live `GET /state`.
- 44 suites / 689 cases.

## 1.1.6

- **The QQ block is on the card.** The labels were added with the first QQ release but the block itself never was, so the only
  way to enter appId / clientSecret was `POST /prefs` - which is not what "add it to the panel" means. The card now has the
  two fields, a sandbox checkbox, **Save and connect**, and a live status line from `/state` (`✅ 已就绪` / `⏳ 握手中` /
  `❌ 未连接`, the bot name, and the platform's own error when there is one).
- The secret input starts empty with "stored; leave empty to keep it": the host masks the stored secret as `***` and only
  overwrites it when a non-empty value arrives, so opening the card cannot wipe a working credential.
- 44 suites / 688 cases.

## 1.1.5

README only: a **Release history** section. 0.1.0 to 1.1.4 is 198 releases, which is too many to list - so the table
groups them by era (the bridge, secrets at rest, Office, the browser and its proxy, flow automation and the extension, the
VS Code bridge, the network layer, integrations, SSH, serial, Scrapling, 1.0 as the stability statement, 1.1 QQ) and
names the releases that mattered.

The section ends with the discipline the numbers came from: a release goes out after the suite passes, and a claim goes
into the README only after something real produced it.

## 1.1.4


- **A rename no longer clears the allow flag.** `/peers` ran every call through `asBool(body.allowed)`, so a request that
  only carried `name` stored `allowed: null` - and `null` is not `true`, which put both renamed QQ chats back to
  "unlisted". Measured immediately after the rename: `allowed=null` on both. The route now distinguishes "not sent" from
  "sent as false", and a source-level test pins it.
- 44 suites / 687 cases.

## 1.1.3

- **Readable chat names.** `/name 老板的群` renames the chat the command came from, and `POST /peers` accepts a `name` for any
  chat, so the panel can do the same for one you are not talking in. This matters most on QQ, where a chat's identity is an
  openid (`A32A7C20732D…`) and every list - peers, task targets, the allowlist panel - shows the name.
- Scoped on purpose: the command only renames *the chat it was sent in*, because a bridge serving six channels must not have
  a command that quietly renames another one.
- 44 suites / 686 cases.

## 1.1.2

- **`GET /peers` without ids answered 400**, so a caller could ask about one chat but never list them. The panel always
  passes both ids, which is why it went unnoticed until the QQ chats needed to be found. The listing flattens the stored
  `{ accountId: { chatId: peer } }` shape and keeps **both ids on every row** - without that, a `qq-<appId>` peer is
  indistinguishable from any other channel's.
- **The README's verification table gained the QQ rows**, with the numbers the live bot produced: private chat
  `received 2 / forwarded 1 / answered 1`, group @ `received 4 / forwarded 2 / answered 2`, and the allowlist blocking the
  first attempt on each channel. The QQ section no longer says "not verified on a live bot".
- 44 suites / 686 cases.

## 1.1.1

- **The QQ callbacks were passed to the constructor and ignored.** `index.js` wires every transport the same way -
  `new QQLongConnection({ appId, clientSecret, onMessage, onStatus })` - but this class only initialised those two fields to
  no-ops, so a connected bot received events and dropped all of them: `counters.received` stayed at 0 while the platform
  was delivering perfectly well. Measured with a hand-held socket on the same bot: `C2C_MESSAGE_CREATE text="你好"` arrived;
  the plugin counted nothing. The constructor now takes both callbacks, and a test asserts it (the failure mode was silent,
  which is exactly why it needs a test rather than a comment).
- **`/state` exposes the QQ connection** (`ready`, `sessionId`, `user`, last `error`) next to the other live fields. The
  first two attempts anchored on strings that also appear in the dashboard text, so the field kept landing in the wrong
  object - the third anchors on a block only the `/state` handler has.
- 44 suites / 686 cases.

## 1.1.0

- **QQ bot, over the open platform's WebSocket gateway.** `qq-bot.js` speaks QQ Bot API v2: app access token
  (`bots.qq.com/app/getAppAccessToken`), gateway discovery (`/gateway`), identify/heartbeat/resume, and replies to
  `/v2/users/{openid}/messages` or `/v2/groups/{group_openid}/messages`. Outbound only - no public URL, like the WeCom and
  Feishu long connections.
- **`/qq on|off|status`**, credentials in the card, and the connection is rebuilt when they change (the same rule the WeCom
  long connection follows). `sandbox` selects the sandbox API host.
- **Three details that decide whether a QQ bot works**, all handled: a reply must quote the inbound message id as
  `msg_id`/`msg_seq` or it counts as a *proactive* message (different permission, usually rejected); C2C and group chats are
  different endpoints and the openid comes from the event; group/C2C events are gated behind intent `1 << 25` - asking for
  more than the bot was granted is what makes identify fail with 4014.
- **Honest about what was tested.** No appId/clientSecret was available, so no live bot was connected. What is verified: the
  token endpoint answers in its own words for bad credentials (`机器人不存在`), and every payload - identify, reply body,
  both endpoints, event flattening, heartbeat/resume bookkeeping - is asserted by 9 tests, including a fake socket that
  drives the whole connect → identify → message flow.
- The transport-dispatch guard in the test suite demanded its fourth transport (a new channel that forwards `/stop` to the
  model instead of answering it is the bug it exists to catch), and `qq-bot.js` was added to `files[]` before the check
  could fail for the reason 0.67.1 exists.
- 44 suites / 685 cases.

## 1.0.3

- The README's version line said **v1.0.1** on a page shipped inside 1.0.2 - an artefact of writing the line before choosing
  the tag. It now names the release it is part of, so a reader can tell whether the page is stale at a glance.
- Nothing else changed.

## 1.0.2

README only:

- the page now states **which release it documents** (v1.0.1, 43 suites / 676 cases) instead of leaving the reader to guess;
- the Scraping row says the real-browser mode **drives the Chrome already installed** - the 1.25 GB download is the
  alternative that was avoided, not a requirement;
- a new **What was actually verified** table replaces general confidence with the numbers that came back: 46 delta frames
  for the VS Code edit, 1721 ms for a WeCom reply, Target UID: F734C3FC31F408 for the STC flash, 11 s for a Cloudflare
  challenge, 21 s failure then 1.8 s success for the same URL with and without a proxy.

## 1.0.1

- **1.0.0 shipped only four files.** The release script still carried an older file list, so index.js, scrapling.js and
  README.md reached GitHub as the 0.72.1 versions while the version number said 1.0.0. 1.0.1 uploads the whole set; the
  verification step (a per-file read-back against the blob hash) now covers every file in the list rather than the four
  that happened to be in it.

## 1.0.0

The feature set is where it should be, so this is the version that says so - not a rewrite, a statement that the surface
is stable: five channels, twenty-odd tool families, 43 suites / 675 cases, every capability exercised against real
hardware or a real service at least once.

- **`which` now searches winget's packages directory.** Measured: avrdude 8.3 installed cleanly with winget, its directory
  was appended to the *user* PATH, and `serial_ports` still said "没找到" - a process keeps the PATH it started with, and a
  tool that is installed but invisible is the worst of both. AVR boards therefore work on a fresh install with no manual
  PATH editing.
- **AVR flashing is now actually available** on this machine: `avrdude 8.3` (winget), found by `serial_support` and used by
  `flasher=avrdude` (`-c arduino -p <mcu> -P COMx -b 115200 -U flash:w:<hex>:i`). No AVR board was plugged in, so the argv
  is covered by tests rather than by a write - the same distinction the serial section makes explicit.
- **Stealth scraping works, and it cost no download.** camoufox's own browser is a 1.25 GB zip - measured at ~150 KB/s
  single-stream and ~620 KB/s across eight ranges, still stalling in practice. The way out was already installed:
  `StealthyFetcher` takes an `executable_path`, so the stealth session now drives the machine's own Chrome (then Edge),
  which returned 200 with a real Chrome UA. `cloudflare: true` additionally solves a Cloudflare challenge -
  `https://nowsecure.nl` came back 200 in 11 s.
- **scrapling 0.5's two fetchers have different APIs** and the first build assumed one: `Fetcher.get` takes `headers`,
  `timeout` in seconds; `StealthyFetcher` has no `.get` at all - it is `.fetch`, with `extra_headers`, `wait`,
  `solve_cloudflare`, `executable_path` and a timeout in milliseconds. Sharing one kwargs object across both produced
  `AttributeError: type object 'StealthyFetcher' has no attribute 'get'` even though the library was importable.
- **Nothing else changed**: no serialisation, no API, no preference key. An upgrade from 0.72.1 is a rename of the version.

## 0.72.1

README only - the Scrapling work is documented as measured, not as claimed:

- **Scraping is its own capability row** (browser-shaped TLS fingerprint and headers), not a footnote under automation;
- the section now keeps four cases apart: example.com 200 in 2.4 s, quotes.toscrape.com with span.text returning three
  items, baidu with links returning eight anchors, and the pair that matters - news.ycombinator.com failing hard after
  21 s with curl's own words, then answering 200 in 1.8 s with proxy: http://127.0.0.1:7897;
- **stealth is stated honestly**: camoufox/playwright are not installed here, so stealth: true fails loudly instead of
  quietly falling back - a silent downgrade would make an anti-bot failure look like a selector problem.

## 0.72.0


- **Scrapling, as one tool.** `scrapling_fetch` drives the Scrapling scraping library (browser-shaped TLS fingerprint and
  headers), so pages that reject a plain HTTP client can be read: pass `selector` and each match comes back as an item,
  `links` to list anchors, `mode=html` for the markup, `stealth` for a real browser, `proxy` per call.
- **`/scrapling`** shows which python has the library and manages the two defaults: `proxy <url>` and `stealth on|off`.
- **Failures are reported, not guessed.** A selector that matches nothing still returns the page text **and** a warning;
  a missing dependency comes back as the exception's own words. Both were needed while wiring this up: scrapling 0.5
  wanted `curl_cffi`, then `patchright`, then `browserforge`, then `msgspec`, and each one first appeared as a traceback.
- **The python side is embedded**, not a second file - `files[]` is a list, and a plugin that installs and then fails on a
  missing helper is worse than one that does not install.
- Measured here: `https://example.com` -> 200 + body; `https://quotes.toscrape.com/` with `selector: "span.text"` -> the
  three quotes as separate items.
- 43 suites / 676 cases.

## 0.71.5

- **`projectDir` reached the tool's schema but not `idf.py`.** The parameter was documented and passed by
  `serial_flash`, and `flashFirmware` silently dropped it, so the flash ran in the plugin's own working directory - which
  is why "flash the folder I have open in VS Code" would have failed with "not an ESP-IDF project" even with a board
  plugged in. `buildIdfArgs` now emits `-C <projectDir>`, the child process runs in that directory as well, and a test
  pins the exact argv (including the case where no project is given, which must stay `-p COMx flash`).
- **Validated without a board**: `hello_world` from ESP-IDF 4.4.8 was built through the *same* wrapper the plugin uses
  (`export.ps1` -> the env's python -> `idf.py -C <project> build`), which is the part that used to fail with
  `'cmake' must be available on the PATH`. The flash step itself needs the board; everything up to producing an image does
  not.
- 42 suites / 665 cases.

## 0.71.4

README only - the page now describes what the plugin actually does after the serial work:

- the capability table names **SSH** and **serial flashing**, and the editor row says the board can be flashed from the
  VS Code panel (the turn runs in the open folder, which is where `idf.py` finds the project);
- the serial section carries the **measured** session instead of generic advice (CH340 on COM3, `TEMP:28.1C`, a real
  `DS18B20_TM1650.hex` flash with `Target UID: F734C3FC31F408`), and says why three fixes came out of testing on hardware
  rather than out of reading the docs;
- the STC note explains the `-A dtr` cold start (no unplugging) and that stcgal is found on PATH **or** inside any ESP-IDF
  python env;
- a short recipe box: "COM3 上插的是什么板子？" / "把这个项目烧到 COM3" / "读 10 秒串口";
- the `/serial` row in the command table now mentions the status output;
- a new **Flashing from the editor** subsection next to the VS Code bridge.

## 0.71.3

- **A flasher's report no longer ends in a mojibake progress bar.** stcgal's tqdm bar is written with carriage returns, and
  the Windows console codepage turned it into `Writing flash: 18%|????` - pushing the actual verdict (`Target UID: ...`)
  out of the tail. Two changes: child processes now get `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`, and `tail` splits on
  `\r` as well as `\n` and drops tqdm-shaped lines. A bar that reached 100% is not a result.
- Measured on the real flash that produced this report: `DS18B20_TM1650.hex`, STC8H1K08 over COM3 - 3129 bytes loaded,
  3648 bytes written, `Target UID: F734C3FC31F408`, and the new firmware printed `TEMP:27.7C` straight afterwards.
- 42 suites / 664 cases.

## 0.71.2

- **`serial_ports` now lists stcgal.** It reported ESP-IDF, esptool and avrdude but not the tool the STC board had just
  been flashed with - the one line a person needs in order to know they can flash an STC chip.
- **A missing firmware path is refused before the flasher starts.** Passing a non-existent `.hex` to stcgal produced its
  entire `usage:` text, which reads like a broken tool rather than a wrong path; `assertFile` answers
  `固件文件不存在：<path>` in one line, and `flasher=idf` (which takes no file) is unaffected. The check is injectable
  (`exists`), so tests can name a fictional file without creating one.
- 42 suites / 662 cases.

## 0.71.1

- **STC (8051) boards flash too, through `stcgal`.** `flasher=stcgal` speaks STC's own ISP protocol (ESP-IDF's toolchain
  cannot), takes the protocol from `chip` (`auto` by default, or `stc89`/`stc12`/`stc15`/`stc8`/`stc8g`), and passes
  `-A dtr` so the MCU is cold-started over DTR instead of asking the person to unplug the board. Measured on the
  CH340/STC8H1K08 that was actually plugged in: `Protocol detected: stc8g · Target model: STC8H1K08 · Code flash 8.0 KB ·
  EEPROM 4.0 KB · BSL 7.3.13U`.
- **`idf.py` now runs inside ESP-IDF's own environment.** Calling it directly failed with `'cmake' must be available on the
  PATH` - the toolchain lives in `D:\\Espressif\\tools` and only `export.ps1` puts it on PATH. The flash therefore runs one
  PowerShell session that sources `export.ps1` first, and the echoed command says so.
- **`/prefs` accepts the `serial` block.** It answered 200 and dropped the value, so the card's checkbox flipped straight
  back and only the `/serial on` command could change anything. The block is validated by `normalizeSerialPrefs` (only the
  literal `true` arms flashing; an absurd baud is dropped; a non-COM port is refused).
- **`findStcgal` searches every ESP-IDF python env**, not just the newest one: stcgal had been installed into `py3.11`
  while the newest env by name was `py3.8`, and the first version reported "no stcgal" on a machine that had it.
- Testing this on real hardware is what produced all three fixes; the suite grew to 12 serial cases (argv per flasher,
  prefs validation, discovery with a fake filesystem, the export-script wrapper, the STC route).
- 42 suites / 661 cases.

## 0.71.0

- **Serial, flashing and a monitor.** Three tools: `serial_ports` (the COM ports with the device name behind each, plus
  which flashers were found), `serial_flash` (`idf.py -p COMx flash` inside an ESP-IDF project, `esptool` for a plain
  `.bin` at an offset, `avrdude` for a `.hex`), and `serial_monitor` (read what the board prints for N seconds).
  They drive the toolchain that is already installed instead of reimplementing a bootloader protocol - that is how a tool
  ends up bricking a board.
- **From Visual Studio Code**: the panel's turn runs in the open folder, so *"把这个项目烧到 COM3"* becomes
  `serial_flash` with `flasher=idf` and that folder as `projectDir` - the project's own sdkconfig supplies the offsets.
- **`/serial`** manages the switch and the defaults: `/serial on|off`, `/serial baud 460800`, `/serial port COM3`, and
  with no argument it reports the switch, the baud, the ESP-IDF/avrdude it found and the ports that are actually plugged
  in. The card gained the matching checkbox (`允许 agent 烧录开发板并读取串口输出（默认关）`).
- **Four rules that prevent silent damage**: off until `/serial on`; the port is never guessed (one port is a decision,
  two are a question, and a named port that is absent is refused with the list of the present ones); the exact command is
  echoed with every result; and the monitor opens the port exclusively, so a flash and a monitor cannot overlap.
- **Discovery is real, not assumed.** On the development machine it found `D:\\Espressif\\frameworks\\esp-idf-v4.4.8`
  and its `python_env` interpreter, refused to flash with "没有找到任何串口" while no board was plugged in, and every
  argv builder is covered by a test that needs no hardware (11 cases).
- The command-catalogue test from 0.70.1 earned its keep again: `/serial` was handled in the dispatcher but missing from
  the catalogue, which is exactly the "未知命令" bug - it failed the suite before the release.
- 42 suites / 660 cases.

## 0.70.1

- **`/ssh` answered "未知命令" even though the dispatcher handled it.** `parseCommand` resolves a name through the
  catalogue, and anything it cannot find is marked unknown - the dispatcher returns right there, so the branch below it
  was unreachable code and the help list did not mention the command either. The catalogue now has `ssh` (aliases
  `/远程`), and a test walks every `command.name === "…"` branch in `index.js` and fails if the catalogue does not list
  it. That test immediately found a second one: `/clip` was matched in a branch although it is already an alias that
  arrives as `clipboard`; the dead half is gone.
- **The Web UI card now carries both switches.** Under the desktop switch there is the clipboard checkbox (on by
  default, same preference as `/clipboard`) and the SSH switch with its host list: each saved host is shown with a
  remove button, and a field plus **Add host** writes the same validated `prefs.ssh` block the `/ssh add` command writes.
  Labels are in both languages, and there is deliberately no password field - key-based auth only.
- **The help text was losing its backticks.** `/clipboard`'s summary listed `clipboardread` and `clipboardwrite`,
  because `/help` strips markdown and the tool names were written in backticks. The summary no longer uses them, and a
  test keeps `summary` strings free of backticks.
- 41 suites / 647 cases.

## 0.70.0

- **Three SSH tools.** `ssh_exec` runs one command on another machine and returns exit code, stdout, stderr and timing;
  `ssh_upload` / `ssh_download` move a file (or a directory) through the platform `scp`. They drive the OpenSSH client
  that ships with Windows 10/11 (and `ssh`/`scp` on macOS and Linux), so `~/.ssh/config` and `known_hosts` keep working
  and no key material ever passes through the plugin - only its path.
- **`/ssh` manages the host list**: `/ssh add nas root@192.168.1.10:22 [identityFile]`, `/ssh remove nas`, `/ssh on|off`.
  The list is one validated prefs block (`prefs.ssh`), shared by the card, `/state` and the tools; an ad-hoc
  `user@host[:port]` works without saving anything.
- **Off until armed**, like desktop control: these tools execute commands on other machines, so `/ssh on` is the switch
  and it is checked before any process starts.
- **Key-based auth only, always `BatchMode=yes`.** A password cannot be typed into a service-like process, so an auth
  problem fails immediately with the client's message instead of hanging the turn; no password is ever stored.
- **`StrictHostKeyChecking=accept-new`**: a new host key is learned once, a *changed* one is refused. `no` would accept a
  man-in-the-middle; `yes` would make a first connection impossible.
- Details that bite: `scp` gets `-P` (its `-p` means preserve times), the remote command sits after `--` so a command
  starting with `-` is not parsed as an option, and captured output is capped at 40k characters **with a 已截断 marker**.
- Measured on this machine: OpenSSH `OpenSSH_for_Windows_9.5p2` answered `ssh -V` in 56 ms, and the argv/prefs rules are
  covered by 12 tests that need no network.
- 41 suites / 645 cases.

## 0.69.1

- **The README now describes the whole plugin, not only the WeChat half.** The capability table gained WeCom, Feishu, the
  VS Code editor bridge, the automation tools (browser / Office / desktop / **clipboard** / search / tasks / flows) and
  the integrations (inbound trigger, outbound webhook, dashboard); the command table gained /desktop and
  /clipboard, which were documented in their own sections but missing from the list a person scans for commands.
- Docs only: no behaviour change, and the release exists so the published README matches what the code does.
- 40 suites / 631 cases.

## 0.69.0

- **The clipboard, as two tools.** clipboard_read returns the copied text (capped at 200k characters) and the file
  list currently on the clipboard; clipboard_write puts 	ext there, or paths as a **file-drop list** so Explorer
  pastes actual files. On by default with an off switch (/clipboard on|off), because a clipboard can hold a password
  and the switch is checked in one place before any script runs.
- **The protocol is base64, and that was a real bug, not a preference.** The first version printed its JSON straight to
  stdout and 剪贴板自检 came back as ?????? - powershell.exe writes stdout in the console codepage. Each script now
  emits the base64 of its UTF-8 JSON and the runner decodes it; the test drives the fake runner with that exact string,
  which is the assertion that would have caught the first version.
- **Windows goes through WinForms on an STA thread** (-STA), the only way SetText/GetText behave from a
  service-like process; macOS uses pbcopy/pbpaste, Linux wl-copy/wl-paste, and a file list is Windows-only with
  the other platforms saying so instead of copying nothing.
- The 200k cap is applied **inside** the script: a 20 MB clipboard never travels through stdout to be discarded.
- Verified on this machine: 写 40 字符 → 读回同一串中文 and a file path round-tripped through the file-drop list.
- 40 suites / 631 cases.

## 0.68.0

- **`POST /dsh-wechat-media/inbound`: another system can speak into a conversation.** Body is `{peer, text, id?, reply?,
  transport?, accountId?}`; `peer` is the platform chat id (a wxid, a group id, a WeCom chat id, a Feishu receive id) and
  `reply` decides whether the answer also goes to that chat or only back over HTTP. The turn is the same machinery a chat
  uses - same agent, tools and history - so a NAS, a CI job or a monitor triggers the same assistant people talk to. It is
  the one route that does **not** require a loopback source, because that is its purpose; the token is the gate, it is
  compared with `timingSafeEqual` rather than `===` (a prefix comparison leaks through timing), and an `id` makes a retry
  idempotent. Measured: `reply:false` answers in the response, `reply:true` delivers through the paired WeChat account;
  WeCom/Feishu return the answer over HTTP and say so instead of pretending to deliver.
- **The outbound webhook fires once per finished turn, not once per transport.** The hook sits in `ReplyCollector.#settle`,
  which every transport funnels through, so a turn started in WeChat, WeCom, Feishu, VS Code or by `/inbound` produces
  exactly one POST. The payload carries `sessionId`, `accountId`, `chatId`, `peerName`, `transport`, `answer`,
  `stopReason`, `error` and the version. With `webhookSecret` set the body is signed as `x-dsh-signature: sha256=<hmac>` -
  **HMAC-SHA256**, not a digest of body-plus-secret, because the latter is forgeable by length extension. Delivery retries
  3 times on a network failure or a 5xx and never on a 4xx (a wrong URL does not improve with repetition), times out after
  10 s, and is fire-and-forget: a broken receiver must not delay or fail an answer. `POST /webhook {"action":"test"}`
  proves a receiver before a real turn depends on it.
- **`GET /dsh-wechat-media/dashboard`**: one script-free page (30 s refresh, loopback only) with the session count,
  total failures broken down by cause, token spend per account and chat, the last inbound and the last webhook delivery,
  the recent routes, the inbound token and the webhook configuration. The failure card counts `retryFailed`,
  `unusable`, `mediaFailed`, `feishuErrors`, `interjectFailed`, `inboundFailed` and `webhookFailed`, so "something is
  wrong" has a number instead of a feeling. Every printed value is escaped - display names come from other people.
- **New counters**, all visible in `/state` and on the dashboard: `inboundRequests`, `inboundFailed`,
  `inboundDuplicates`, `webhookSent`, `webhookFailed`.
- Docs: a new README section with the three routes, the field table, the webhook payload and the exact signature rule.
- 39 suites / 619 cases.

## 0.67.4

- **The Feishu inbound suite was flaky, and the reason was a comparison across two moments.** `builtAt` was asserted
  *exactly equal* to a maximum computed a few lines later, so anything that touched a shipped file in between - an
  editor saving, a publish or a `pnpm add` running beside the suite, the profile being rewritten - moved one side and
  not the other. It failed roughly one run in four under `node --test`, passed standalone, and cost a re-run each time.
  The comparison is now a 2 s window, which still fails everything the test exists for (reporting `loadedAt`, only the
  manifest's mtime, or a constant are minutes away), while the deterministic version of the same question stays in the
  next test: it moves one file to a known timestamp and expects `builtAt` to follow it exactly.
- **`waitFor`'s default budget went from 2 s to 8 s.** The loop returns the moment its condition holds, so a fast run
  pays nothing, and a machine grading beside an install no longer turns a slow token fetch into a failed suite.
- **The `github:` install failure is now documented.** pnpm resolves a `github:` spec over **SSH**
  (`git+ssh://git@github.com/...`), so a machine without GitHub's host key cannot install a *public* repository:
  `Host key verification failed`. The README's install section now names both ways out - rewrite GitHub SSH URLs to
  HTTPS with `git config --global url."https://github.com/".insteadOf "git@github.com:"`, or install the release
  tarball URL directly.
- Verified: the suite ran three times at `--test-concurrency=2` and the Feishu file four times under deliberate CPU
  load with no failure; `github:wjh-ux/dsh-wechat-media` installs again and reports 0.67.4, and
  `POST /proxy-hosts {"action":"preset"}` answers 200 with 26 hosts on the live plugin.
- 38 suites / 597 cases.

## 0.67.3

- **"Which domains go through the proxy" is now a list you can apply instead of retype.** `browser.js` carries
  `COMMON_PROXY_HOSTS` - 26 bare hosts covering Google, YouTube, GitHub and the package CDNs, the social set, Wikipedia
  and the AI services - and two entry points apply it: `/browser hosts preset` in a chat, and
  `POST /dsh-wechat-media/proxy-hosts {"action":"preset"}` for the panel and scripts. Bare hosts are enough because the
  PAC rule is a suffix match (`google.com` covers `maps.google.com`), so the list stays readable.
- **It is a preset, not a default.** A host list nobody asked for silently routes traffic through a proxy, and "why is
  this slow / why does this fail" is a bad first impression; choosing the preset is a different act from receiving it.
- **`docs/proxy-and-domains.md`** documents the list, the commands to add/remove/replace it, and the two boundaries that
  cost real time: a PAC only governs a browser *the plugin launched* (an `extension` session drives your own Chrome, so
  that browser's proxy settings decide), and an empty list with a proxy address means **everything** goes through the
  proxy, while no proxy address means direct.
- Two tests keep the preset honest: one normalises it and renders a PAC from it, the other derives the list from
  `browser.js` and fails if the documentation stops naming a domain - and it asserts the document is in `files[]` and
  linked from the README, because a doc nobody ships is a doc nobody reads.
- 38 suites / 597 cases.

## 0.67.2

- **61 labels in the panel rendered as raw identifiers.** The card asks the host for 208 labels and registers its own
  dictionary for 147 of them; for the rest - `browserLabel`, the whole Tavily block, the browser block, the flow-export
  field, the GUI-port line - no dictionary has an entry, and DSH's translator then answers with **the key itself**
  (`lookup(...) ?? key`). The helper only replaced an *empty* answer with its fallback, so the identifiers went straight
  onto the screen: `browserLabel`, `tavilyLabel`, `browserModeHeadless`, `feishuOpsTitle`, `flowExportDir` ...
  Measured by counting the gap: 208 keys used, 61 never defined. Fixed by treating an answer identical to the key as a
  miss, so each call falls back to the text it was already carrying.
- **A regression test renders the card with a translator that echoes keys** - the exact host behaviour that leaked -
  and asserts that none of the raw keys appears in the rendered text and that the browser section shows its own words.
- **Honest limit.** Those 61 fallbacks are Chinese, so an English UI now shows Chinese in those sections instead of
  identifiers. Adding the English half of those keys is the remaining work; the test only guarantees no key leaks.
- 38 suites / 595 cases.

## 0.67.1

- **A GitHub install could not load at all: `files[]` was missing `modelguard.js`.** Installing with
  `dsh plugin --profile desktop add github:wjh-ux/dsh-wechat-media` fetched a tarball whose whitelist did not include
  the module `index.js` imports on its second line, so importing the package died with
  `Cannot find module .../modelguard.js` and the plugin never mounted - the panel, the routes and every tool were
  simply absent, with nothing on screen saying why. Found by importing the installed copy directly instead of trusting
  "install succeeded": the same command that printed `+ dsh-wechat-media` left a package that cannot be imported.
  A link-installed checkout never shows this, because the whole directory is there - which is why every earlier release
  passed its tests and still shipped broken.
- **`vendor/silk-wasm/{index.mjs,silk.wasm,LICENSE,README.md}` had the same problem**: the SILK encoder is loaded by
  path at runtime, so a missing wasm makes every voice message silently unsendable in an installed copy. Published now.
- **A test so this cannot come back.** `test/package.test.mjs` walks every published module's relative imports and
  fails when a target is not in `files[]`, and asserts the SILK assets are both listed and present. It is written
  against the manifest rather than a fixed list, so a new module that forgets the whitelist fails here instead of in
  somebody's install.
- Verified by packing (`dsh-wechat-media-0.67.1.tgz`, 49 files) and importing the extracted copy: `import ok`,
  `apply` is a function. 38 suites / 594 cases.

## 0.67.0

- **The editor's AI now edits the project it was opened on.** A panel request carries the folder (`cwd`) and a *可写*
  switch; the plugin runs that conversation *in* the folder and gives it the narrowest sandbox that lets an edit happen:
  `workspace-write` with the folder as the boundary, or `read-only` when the switch is off. Approval is `never`, because
  there is nobody in an editor panel to answer a prompt - an editor request must fail closed and fast, never hang.
  Measured against the real GUI process: "新建 note.txt" produced a 31-byte UTF-8 file inside the project; with the
  switch off, the follow-up edit of the same file was refused by the sandbox
  (`[sandbox: file access denied under read-only mode]`), the file stayed byte-identical, and the answer said so
  instead of claiming success.
- **One project, one session.** The conversation id becomes `project:<folder>`, so two open folders never share a
  history, and the streaming route keeps filtering deltas by session id (46 delta frames, 8.5 s, in the same run).
- **A policy-order bug: a project session was put back on `ask`.** Right after creating a session the code set the
  `ask` approval policy - overwriting the `never` that `enforceProjectMode` had just recorded - so the first write that
  needed an approval would have waited for a person who cannot answer from the editor. Project sessions now skip that
  block, and the read-only/writable state is re-asserted on **every** request, since a grant that cannot be revoked is
  not a switch.
- **The route does not trust the folder it is handed.** `editorProject` accepts an absolute path only; a relative or
  empty one is treated as "no project open" rather than resolved against the process's cwd - guessing there means an
  edit landing in a directory the person never opened.
- **The panel shows which project it is about** (`项目：<folder>（可改 / 只读）`, or a sentence when no folder is open),
  and the 可写 switch is a visible checkbox, not a hidden setting.
- **Chrome capture no longer forgets itself after ~30 s.** MV3 suspends the service worker, which loses the `capture`
  module variable and stops `chrome.debugger.onEvent`; the recorded symptom was 8 responses on the first capture of a
  session and 0 on the next one with the debugger still attached. Capturing now holds a `chrome.alarms` keep-alive plus
  a 20 s no-op API call, both cleared on stop.
- The extension ships as `dsh-wechat-media-vscode-0.5.0.vsix`; the installed copy is byte-identical to
  `vscode-extension/extension.js`.
- 38 suites / 593 cases.

## 0.66.1

- **The extension's own version never moved, so two releases were never installed.** `vscode-extension/package.json` sat
  at `0.1.0` while the commands changed; `code --install-extension` printed "successfully installed" for the 0.2.0 and
  0.3.0 packages and changed nothing, because VS Code saw the same version already present. Found by reading the
  extension's detail page: version `0.1.0`, and its manifest came out of that first package with mojibake titles.
  Fixed to **0.4.0**, uninstalled the stale folder, reinstalled, and verified by parsing the installed manifest
  (`DSH: 提问… | DSH: 用选中内容提问 | DSH: 读取当前项目 | …`) rather than trusting the CLI's message.
- **The project snapshot was verified end to end** by sending the same payload the extension builds (`@项目` + a 99-line
  tree + `package.json` / `README.md`, 8178 chars) to `/dsh-vscode/stream`: 607 delta frames, and an answer that named
  `index.js` as the entry point and grouped the other 27 modules correctly.
- 38 suites / 603 cases.

## 0.66.0

- **The open project can be sent as context.** `@file` only answers about a file you already know about; "what is this
  project" needs the shape. Three ways to ask it:
  - **项目** button in the panel (inserts `@项目`),
  - `@项目` (or `@project`) typed directly,
  - command palette: **DSH: 读取当前项目**, pre-filled with "总结这个项目的结构、技术栈和入口文件，并指出我该先看哪几个文件".
  The snapshot is the folder name, a file tree (depth 4, 300 entries), and the files that explain a project
  (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `README.md`, …), capped at 24 KB total. `node_modules`,
  `.git`, `dist`, `build`, `target`, `.venv`, `__pycache__` and friends are skipped - a tree that includes dependencies is
  not context, it is a denial of service on the prompt budget. No workspace open gives a sentence, not a crash.
- 38 suites / 603 cases.

## 0.65.1

- **Streaming had no chunks, because it listened to the wrong event.** First live probe of `/dsh-vscode/stream`: `status
  200`, then a single `done` frame at `+7111ms` and nothing in between - "200 text/event-stream" is not streaming.
  Live tokens travel as `agent/assistant-stream` frames, whose payload carries `{ agent, frame }`, so they can be filtered
  by session exactly (WeChat or the GUI may be mid-turn at the same time). After the fix, the same probe shows
  **346 delta frames** arriving between `+3366ms` and `+3842ms`, then `done` - the answer lands in 3.9 s where the
  non-streaming path took 7-14 s.
- 38 suites / 602 cases.

## 0.65.0

- **The editor sees the answer being written.** `POST /dsh-vscode/stream` runs the same turn as `/ask` but writes
  `text/event-stream`: `{"type":"delta","text":…}` as each chunk arrives, then `{"type":"done","text":…,"stopReason":…}`.
  Deltas are filtered by **session id**, because more than one conversation can be running a turn at once (WeChat,
  Feishu, the GUI) - an unfiltered stream would paint someone else's reply into the editor.
  The panel grows a single bubble from the first chunk (with a blinking caret) instead of showing "思考中…" until the end.
- **`@file` references.** `@path/to/file` (or `@"a path with spaces"`) is expanded before sending: the file is read from
  the workspace, fenced and labelled with its path, capped at **60 KB**, and a missing or oversized file is reported in
  the panel instead of being silently dropped. A **＋文件** button opens the picker and inserts the reference, because
  nobody types a path they cannot see.
- 38 suites / 602 cases.

## 0.64.1

- **The editor finds DSH again after a restart.** `gui-port.json` said port 1826 while the GUI had moved to 63295, so the
  VS Code status bar sat on a bare `DSH` forever - measured by installing it and reading the status bar. Two fixes:
  - the plugin refreshes that file from the two routes the extension actually calls (`/dsh-vscode/status`, `/ask`);
  - the extension tries the file's `port`, then `previousPort`, then its `history`, and remembers whichever answers.
  When nothing answers it now says `DSH 未连接` with a warning background instead of an ambiguous label.
- **A `.vsix` is built and installed for real.** `code --install-extension <folder>` does not work (the CLI answers "not
  found"), and a folder dropped into `~/.vscode/extensions` is never loaded because `extensions.json` is the registry -
  both verified. The extension is packaged by hand (`[Content_Types].xml` + `extension.vsixmanifest` + `extension/`) and
  installed with the CLI; the status bar then reads `DSH · 微信 1 · 飞书 · 浏览器 chrome · 任务 4`.
- 38 suites / 600 cases.

## 0.64.0

- **The VS Code bridge works, and the earlier `not-claimed` was not the bridge.** With an opt-in trace
  (`{"prompt": "…", "trace": "1"}`) the inbox timeline for the editor's session is now visible:
  `inserted → status: running → claimed (turn 2)` in **2 ms**, and the answer comes back with `stopReason: completed`.
  `只回答四个字符：ABC9` returned exactly `ABC9`.
- **A request whose Chinese arrived as question marks is refused, not answered.** Measured during that same session:
  `只回答四个字符：ABC9` sent by an ANSI client reached the plugin as `????????:ABC9`, and the model then spent a whole
  answer discussing mojibake instead of answering - a real cost, paid twice. The route now answers `400` with the actual
  fix ("请求体不是 UTF-8：先 chcp 65001，或用 --data-binary 传字节"), and the editor client states
  `application/json; charset=utf-8`.
- 38 suites / 600 cases.

## 0.63.0

- **The Maps card reader recognises fields by shape, not by position.** The 220-row export exposed two defects that the
  row count hid: **53 rows had no rating** and the 地址 column was full of opening hours. Live cards, three in three:
  `["4.6(14)", "咖啡店 · 淮海中路1856号"]`, `["5.0(1)", "咖啡馆 … 正在营业 · 结束营业时间：23:00"]`, and cards with no
  rating at all. So now: the address is the `·`-separated block that is *not* about opening hours, and the rating falls
  back to the `4.6(14)` text when there is no labelled image. A card with neither stays empty rather than inheriting
  someone else's text.
- 220 rows from eight searches, 220 unique links, 171 unique names - the duplicate names are different branches, which
  is why the link is the key.
- 38 suites / 599 cases.

## 0.62.2

- **A search gets two minutes, not ninety seconds.** First merged live run reported 112 places from three searches, but
  each search had only produced 47-51 - the in-page deadline (90 s) ran out before the feed did, and the earlier 83-row
  run proved the same page yields more. Deadline is now 240 s, the transport ceiling 300 s per search, and the tool
  ceiling 25 minutes so several searches fit inside one call.
- 38 suites / 599 cases.

## 0.62.1

- **A command may now ask for more time.** First live run of the merged Maps tool died with
  `扩展 30s 内没有回应 Runtime.evaluate` - the transport's ceiling was a fixed 30 s, and an expression that scrolls a
  feed for a minute is a legitimate command, not a hung one. `extensionSession.send` takes `options.timeoutMs`,
  `browserEvaluate` passes it through, and the Maps patch asks for 150 s. Clicks keep the old ceiling.
- 38 suites / 599 cases.

## 0.62.0

- **`browser_maps_places` takes several searches.** Measured: one Google Maps search stops at about 90-100 places - the
  feed ends with "查看更多", which did nothing when clicked - so "200 shops" cannot be a longer scroll. It is a merge:
  `queries: "[\"上海 咖啡店\",\"上海 咖啡馆\"]"` (JSON array, or comma-separated) runs each search, unions the results by
  place link, and reports what each one added (`徐汇 咖啡店：94 家，新增 37`). `limit` applies to the union.
- **The waiting defaults are the measured ones now.** 900 ms / 3 quiet rounds collected 54 places; 1600 ms / 5 rounds
  reached 83 of ~94. A lazy list that loads a screen every 1-2 s reads "finished" far too early with a short wait.
- A tool parameter typed `array` is rejected by this plugin's own contract (it knows string / number / boolean), caught
  by `wiring.test.mjs` before release; the list travels as a JSON string instead.
- 38 suites / 599 cases.

## 0.61.1

- **The Maps patch now waits for the list, and scrolls the list.** First live run returned 7 places and claimed it had
  settled: the feed is rendered a moment after navigation, so every scroll was aimed at a list that did not exist yet,
  and scrolling `body` never reached it. It now polls for `div[role="feed"]` for up to 15 s, scrolls the **last card**
  into view (which is what actually loads more), and re-queries the feed each round because Maps replaces the node.
  Verified with the same logic inline before touching the patch: 31 places from one search instead of 7.
- A stray backtick inside the template string made `maps.js` a syntax error; caught by `node --check` before release.
- 38 suites / 598 cases.

## 0.61.0

- **谷歌地图专用补丁：`browser_maps_places`.** Maps is not like the sites the other tools are built for, and the
  measurements say why: its first result page is **not an XHR** (capture saw only the HTML document), and
  `window.APP_INITIALIZATION_STATE` is 167 KB of compressed coordinate arrays - the biggest array of objects in it is
  the state itself. Parsing that would be fragile guesswork dressed up as a feature.
  So the patch drives the DOM properly instead: **one async run inside the page** scrolls the feed until it stops
  growing (three quiet rounds), collects every card on the way, de-duplicates by place link, and returns
  名称 / 评分 / 地址 / 链接 - optionally saved through the same export path as everything else.
  - The old ceiling of "60 rows and a cut" was not a limit of Maps. It was three scrolls, each costing a round trip.
  - A deadline inside the loop means a page that never stops loading cannot hang the tool; `limit` (default 200) and
    `stallRounds` are both explicit.
- 38 suites / 598 cases.

## 0.60.0

- **`browser_json` - the last step from data to a file.** Give it a JS expression that returns an array (or a payload
  containing one), an optional `fields` map, and a `save` path, and it writes the CSV/JSON itself. Before this, a
  `browser_eval` result came back as chat text, and anything past a few dozen rows was stuck in a message.
  - It accepts what a page actually gives: an array of objects, an object whose largest array is the list, or a **JSON
    string** (a document read back as text, or an expression that stringified itself).
  - `limit` bounds what is written (default 500); field paths are the same dotted form `browser_flow` uses.
- Measured while writing this: capture saw **28 responses (6 JSON)** on bilibili after the keep-alive fix (0 before), and
  `extract` turned bilibili's `playurl` payload into 5 rows with the right columns. A URL that *is* JSON is still not
  captured by the Network domain - `browser_text` reads it - which is why `browser_json` parses a string payload too.
- 37 suites / 594 cases.

## 0.59.0

- **`browser_capture action=extract` - the last mile of "the data is in the request".** Capturing a payload is only half
  the job; turning it into a table is the half a person wants. `path` names the array (`data.list`, `items[0]`),
  `fields` maps columns to paths (`{"名称":"name","评分":"rating.value"}`), and `save` writes CSV/JSON with the same path
  rules `browser_flow` already uses. With neither, the **largest array of objects** in the payload wins - the right
  guess for an API whose shape has not been seen yet.
- Three pure helpers in `flow.js` (`pickPath`, `flattenRows`, `biggestObjectArray`) so the rules are stated by tests
  rather than discovered in production: a missing path is `undefined`, a nested value is stringified, an empty array at
  a named path is not silently replaced by some other array.
- Measured while writing this: Google Maps does **not** use XHR for its first result page - the data is embedded in
  `window.APP_INITIALIZATION_STATE` (167 KB) and a 157 KB inline script, which is why capture saw only the HTML document.
  Sites whose lists come from `/api/...` are the ones this tool is for.
- 37 suites / 594 cases.

## 0.58.1

- **`browser_capture` now keeps what it captured.** First live run: `stop` reported 8 responses and `list` answered
  "没有捕获到内容" - because `list` called `__netStop` a second time, and the bridge had already cleared its buffer. The
  entries outlive the command now, and `list` only asks the browser when it has nothing yet.
- Everything else in the network layer was verified live, not assumed: 8 responses (4 JSON) on bilibili, 14 cookies for
  `www.bilibili.com`, a 6 KB JSON downloaded to `Downloads` through the browser's own cookie jar, 2 tabs listed, and a
  `waitIdle` step that stepped over a settled page.
- 37 suites / 593 cases.

## 0.58.0

- **网络层 (the network layer).** Until now a page was only what it rendered: scrolling a feed, counting cards, parsing
  `innerText`, and hitting a ceiling at whatever the DOM happened to paint. The data is in the requests, so:
  - `browser_capture` (start / stop / list) - `Network.responseReceived` + `Network.getResponseBody` while the debugger
    is attached. Bodies are capped (1 MB default) and images/fonts skipped, `pattern` keeps only the API calls worth
    reading, `limit` bounds memory;
  - `browser_cookies` - the login state for one URL or the whole browser;
  - `browser_download` - downloads through the browser (its cookie jar applies), waits for completion, reports the path;
  - `browser_tabs` - list / open / select, so a second tab is a choice rather than a hope;
  - flow step `waitIdle` - no request in flight and nothing new for `idleMs`, which is "the page has settled" instead of
    "sleep two seconds and hope".
  All four need the extension transport (a page cannot see its own traffic or cookie store) and say so in one sentence
  when it is not in use.
- The extension gains `cookies` + `downloads` permissions and moves to 1.2.0; reload it and accept the new permissions
  once.
- 37 suites / 593 cases.

## 0.57.0

- **VS Code bridge.** Three ways into the same agent: a chat panel in the activity bar, two commands
  (`DSH: 提问…`, `DSH: 用选中内容提问`), and a status-bar item that says whether the plugin is reachable and what is
  connected (WeChat accounts, Feishu, browser extension + target, scheduled tasks).
  - Plugin side: `/dsh-vscode/ask` and `/dsh-vscode/status`. The ask handler is a **real turn** -
    `ensureAgent("vscode", "vscode", "VS Code")`, `collectors.wait`, `agent.followup` - so the editor uses the same
    model, tools and session machinery a chat does, not a second, weaker path. `/vscode on|off` gates it, and the route
    is loopback-only.
  - Editor side: `vscode-extension/` - plain CommonJS, no bundler, no TypeScript, no dependencies. The endpoint is
    discovered from `gui-port.json` in the plugin's state directory: that port changes on every DSH restart, so a
    hard-coded one would mean "reconfigure after every restart".
- 37 suites / 592 cases.

## 0.56.1

- **An explicit target that is not connected is refused, not swapped.** Picking Edge while Edge's extension is off used
  to fall back to whichever browser was polling - the click landed in Chrome, which is precisely the confusion the target
  setting exists to remove. Now the command fails with the browser's name and where to enable the extension; `auto`
  still resolves to whatever is connected.
- `browser_open`'s note now names the browser that actually ran it (Chrome / Edge), asked at call time so it follows a
  target switch instead of a value cached at session start.
- 36 suites / 590 cases.

## 0.56.0

- **两个浏览器同时开着，命令现在有明确的目标.** With the extension loaded in both Chrome and Edge, both poll the same
  queue and a command went to whichever asked first - so the same click could land in a window the person was not
  talking about. Now:
  - every poll carries `browser` (chrome/edge) and a per-install `id`, and the bridge tracks all connected browsers;
  - `target` is `auto` / `chrome` / `edge`. `auto` follows the channel setting (`browserChannel`), falling back to the
    first connected browser;
  - a non-target browser only gets a 4 s **standby** poll and never receives work, and waking a waiter skips non-target
    ones;
  - switching the target **drops queued business commands** (the `__driver` / `__cursor` settings survive), so a command
    queued a moment ago cannot land in the window just ruled out;
  - panel: a 目标浏览器 select plus the list of connected browsers; chat: `/browser ext target auto|chrome|edge`, and
    `/browser ext` now names each connected browser and marks the one in use.
- 36 suites / 589 cases.

## 0.55.2

- **The pointer stays for 2.5 s instead of 1 s.** The dot is a debugging aid: a person has to notice it, and a
  one-second flash is easy to miss - measured by trying to screenshot it, which missed every time. The ripple now runs
  0.9 s (was 0.65 s) so both are visible together.
- 36 suites / 588 cases.

## 0.55.1

- **The cursor flag now rides the click instead of a stored setting.** 0.55.0 kept `cursor` in extension storage, delivered
  by a poll handshake - and the first live test showed no dot at all, because a setting has to be synchronised and the
  handshake can lag behind the click (a held poll waits up to 25 s). The flag is now part of every
  `Input.dispatchMouseEvent`: nothing to synchronise, nothing to go stale, and the worker strips `__cursor` before the
  command reaches Chrome (which rejects unknown parameters).
  - Setting changes also **wake a held poll** now, so switching the driver or the cursor in the panel takes effect at
    once rather than at the next natural poll.
- 36 suites / 588 cases.

## 0.55.0

- **显示鼠标光标 - see where each click lands.** Chrome exposes no cursor API, so the extension paints one: a red dot
  and a ripple at the click point, drawn from an isolated world (cannot collide with the page's variables) and removed
  on a timer (a failed click leaves nothing behind). It works on **both** transports - the script path never touches
  the debugger and the debugger path has no cursor to turn on - so turning it on does not change which driver runs.
  - Panel: a **显示鼠标光标** checkbox beside 扩展驱动; chat: `/browser cursor on|off`.
  - Off by default: a pointer appearing on a page somebody is reading is a surprise, not a feature.
  - Route `GET/POST /dsh-wechat-media/extension-cursor?on=1|0`; the setting rides the same pre-work poll handshake as
    the driver, so it is in force before the next click rather than one click later.
- 36 suites / 587 cases.

## 0.54.1

- **每一条命令都会报出它实际走了哪条通道.** Hybrid decides per command, so "did the banner flash?" used to be a guess.
  The worker now returns `driver` with every answer; the bridge keeps `lastDriver` and a `debuggerUses` counter, and
  the panel shows both (`最近命令 脚本/调试器 · 调试器用过 N 次`).
- Measured while writing this: Baidu **does** accept a synthetic `keydown` Enter (the title changed to the search
  result), but that is not a safe general assumption - a site that checks `isTrusted` would silently do nothing. So key
  presses keep falling back to the debugger in hybrid mode instead of being switched to script on the strength of one
  site.
- 36 suites / 586 cases.

## 0.54.0

- **混合模式 (hybrid) - the banner only when it is actually needed.** The third choice in 扩展驱动: every command goes
  through `chrome.scripting` first, and only the commands that path cannot finish fall back to `chrome.debugger` for
  that one command:
  - a click whose `elementFromPoint` found nothing now **throws** instead of returning quietly, which is what hands it
    to the real mouse event (an overlay, a frame, a canvas the DOM lookup cannot see);
  - an unsupported method (`Page.captureScreenshot` full-page work, frame-scoped commands) raises the same way;
  - everything else - navigation, reading, scrolling, typing, visible-viewport screenshots - stays on the script path,
    so the banner does not appear at all.
  The result: routine work leaves no trace in Chrome's UI, and the debugger appears exactly on the operations that
  need it.
- `driver` accepts `debugger` / `script` / `hybrid` everywhere (bridge, route, panel); an unknown value still falls back
  to `debugger`.
- 36 suites / 585 cases.

## 0.53.1

- **Script mode is stronger than its first description claimed, and its navigation was one step behind.**
  - `Page.navigate` in script mode now waits for the tab to report `status: "complete"` before answering. Measured
    before the fix: `goto` returned in ~250 ms with the *previous* page's title, because `tabs.update` resolves before
    the load and the plugin reads the title immediately after. After it: the new title, first try.
  - A screenshot **does** work without the debugger - `chrome.tabs.captureVisibleTab` returns the visible viewport of
    the active tab, verified on a live page. The earlier note said screenshots were unavailable; that was wrong, and
    the docs now say what is actually true: script mode gives up native input (clicks are `element.click()`), full-page
    capture, and per-frame control - not screenshots.
- 36 suites / 585 cases.

## 0.53.0

- **Chrome's "已开始调试此浏览器" banner is now a choice, not a side effect.** The banner is drawn by the browser
  whenever `chrome.debugger` attaches, and no extension can hide it - so the panel's **扩展驱动** switch picks the
  transport instead:
  - `debugger` (default) - real mouse events, screenshots, any frame. The banner appears while a command runs and goes
    away when the worker detaches (it detaches after every command);
  - `script` - `chrome.scripting` in the page's own world: read, click, type, navigate. Never attaches the debugger, so
    **no banner ever appears**; a screenshot or a native input event is refused with a sentence naming the trade-off.
  - The switch rides the **next poll, before any command**, so nothing ever runs with the wrong driver; it is stored as
    a pref (`extensionDriver`), so a machine that must avoid the banner keeps avoiding it after a restart.
  - Route: `/dsh-wechat-media/extension-driver?mode=debugger|script`.
- The extension manifest gains `scripting` and `<all_urls>` (required to inject into pages), version 1.1.0; loading the
  reloaded folder asks Chrome to accept the new permission once.
- 36 suites / 585 cases.

## 0.52.1

- **Edge is a first-class browser for the extension too.** The companion extension is plain MV3 plus
  `chrome.debugger`, which Edge implements identically, so the same `extension/` folder loads unchanged from
  `edge://extensions` - no second build, no manifest fork. Only the settings URL differs, and the install button now
  opens the one for the configured channel (`browserChannel = edge` → `edge://extensions`) instead of always Chrome's.
  The host side was already Edge-aware: `msedge.exe` lookup, `%LOCALAPPDATA%\Microsoft\Edge\User Data`, and
  `msedge.exe` in the process check.
- 36 suites / 584 cases.

## 0.52.0

- **一键安装扩展 (one click toward a loaded extension).** Chrome will not let a page install an extension silently -
  that is a security rule, not a gap this plugin can close - so the panel now does the three things a page *can*:
  pack `extension/` into `$DSH_HOME/exports/dsh-bridge-extension.zip` (`Compress-Archive`), open
  `chrome://extensions` focused through the desktop (`cmd /c start`, because a page cannot navigate to `chrome://`),
  and put the token on the clipboard. The remaining two steps - developer mode, "load unpacked", then paste - are
  printed in one sentence in the panel.
  - `POST /dsh-wechat-media/extension-install` returns the zip, the folder, the address and the token, so the button
    is also usable from a script.
  - `packExtension` / `openExtensionsPage` live in `extension.js` with an injectable `execFile`, so the command they
    build is asserted without opening anything - including the doubled quote a path like `C:\it's here` needs.
- 36 suites / 584 cases.

## 0.51.1

- **Two failures from the first live run of the extension transport.**
  - `Cannot access a chrome:// URL`: the worker drove the active tab, which was the `chrome://extensions` page a person
    had just used to install it, and `chrome.debugger` refuses browser UI. It now prefers an `http(s)` or
    `about:blank` tab - creating a blank one when the window is all browser UI.
  - A command handed to a poll whose service worker had been suspended went into a response nobody read, and the
    caller timed out 30 s later with no clue. A command with no answer is now **re-queued once** before failing, so
    the restarted worker's next poll picks it up. A test states it: the first deadline passes with nobody polling, and
    the command still arrives - and is answered - on the next poll.
- 36 suites / 583 cases.

## 0.51.0

- **Browser-extension transport: drive the Chrome you are already using.** Two Chrome changes closed the earlier roads:
  136+ ignores `--remote-debugging-port` on the default profile, and 127+ drops cookies copied between profiles
  (measured here: 114 rows in, 29 after one start). An extension runs *inside* that browser, and `chrome.debugger`
  speaks the same DevTools protocol the tools already speak - so `browser_*` and `browser_flow` work unchanged, with
  the person's real logins.
  - `extension.js` - an HTTP long-poll bridge (Node ships a WebSocket client but no server, and this package has no
    dependencies), bound to 127.0.0.1 and gated by a 32-hex token minted once and saved, so an extension configured
    yesterday still connects after a restart. A long poll holds 25 s, so a command sent while one is open arrives at
    once; a silent extension times out with a sentence instead of hanging the tool.
  - `extension/` - MV3 manifest, a service worker that polls and executes through `chrome.debugger` (attaching,
    retrying once when another debugger holds the tab, detaching after every command so a later attach cannot fail),
    and an options page for the address and token.
  - `browserProfileMode = "extension"`, `/browser session extension`, `/browser ext` (status + address + token +
    directory), and the panel gains the fourth session option and the address/token line to copy from.
- The session adapter hands the existing tools a CDP-shaped object whose `once` rejects immediately: the extension
  returns results but not protocol events, and that rejection is what keeps `browser_open` from waiting 20 s for a
  `Page.loadEventFired` that will never come.
- 36 suites / 582 cases.

## 0.50.0

- **"Same Chrome as mine", done the only way Chrome allows.** Chrome 136+ silently ignores `--remote-debugging-port`
  when `--user-data-dir` is the default profile - measured here on Chrome 155: the process started, the window
  appeared, the port never listened. So `浏览器会话` / `browserProfileMode` now means three things, all reachable from
  the panel **and** the chat:
  - `own` - the plugin's own profile, unchanged;
  - `chrome` - **import** the state that carries a login (`Local State`, `Cookies`, `Login Data`, `Bookmarks`,
    `Preferences`) into the plugin's profile, then launch that. Refuses while Chrome is running: a half-written cookie
    database is worse than none. `/browser import` re-runs it at any time;
  - `attach` - drive a Chrome the person started with `--remote-debugging-port`, and never close it.
    `/browser launch` starts such a Chrome on its own profile and switches to this mode, which is the "one browser for
    everything" answer.
- `profile.js` owns the copy and reports what moved: copied files, skipped files (an old Chrome has no
  `Default/Network/Cookies`), and the bytes. History and extensions are deliberately left behind.
- The panel gains a **导入登录** button beside the session select; the copy is a snapshot, not a sync, and the docs say
  so.
- 35 suites / 576 cases.

## 0.49.0

- **"Why is this a different Chrome than mine?" - three named sessions.** The plugin always launched its own profile,
  so "open Chrome" produced a second, empty browser beside the one the person actually uses. `browserProfileMode`
  now says which browser a tool drives:
  - `own` (default) - the plugin's own profile under `$DSH_HOME`, exactly as before;
  - `chrome` - **the person's real Chrome profile** (`%LOCALAPPDATA%\Google\Chrome\User Data`, overridable with
    `browserChromeProfileDir`), so logins, bookmarks and extensions are there. Chrome refuses a second instance on a
    live profile, so a running Chrome is detected first (`tasklist`) and reported as a sentence - "quit Chrome, then
    try again" - instead of a launch that times out saying nothing;
  - `attach` - take over a Chrome the person started with `--remote-debugging-port=9222`, and **never close it**.
    This is the one mode where a port that already answers is a success rather than a leftover to replace.
  Reachable from a panel select (`会话`), from `/browser session own|chrome|attach`, and reported by `/browser`
  status and `/state`.
- `browser_open` now says which of the three happened - launched, replaced a stale window, or "接管的是你自己打开的
  浏览器，我不会关它".
- 34 suites / 573 cases.

## 0.48.3

- **The folder dialog is started with a window.** 0.48.2 ran it through `runDesktopScript`, which launches
  `powershell.exe` with `windowsHide: true` - and a child without a usable window can show no dialog at all. The
  lesson was already written down in this plugin (the inbox folder picker uses `windowsHide: false` for exactly this
  reason), so `dialogs.js` now runs its own `-STA` process with `windowsHide: false` instead of borrowing the
  screenshot helper. The last-JSON-line parsing is unchanged and still has its own test.
- 34 suites / 572 cases.

## 0.48.2

- **Browse for the export folder instead of typing it.** The panel's 流程导出目录 row now carries 浏览…, which opens the
  ordinary Windows folder dialog on this machine (`-STA`, seeded with the current folder) and saves what was chosen.
  It has to run in the host: a page cannot learn an absolute path - `showDirectoryPicker()` deliberately hides it and
  `webkitdirectory` reports only relative names - so `dialogs.js` builds the PowerShell script and
  `/dsh-wechat-media/export-dir` serves `get` / `set` / `browse`. Cancelling is a normal answer (`cancelled: true`),
  not an error.
- `pickFile` / `OpenFileDialog` are there for the same dialog over a file, so a flow can be pointed at an existing
  `.csv` later without another round of plumbing.
- 34 suites / 570 cases.

## 0.48.1

- **`save` now means a place, not "next to the installer".** A relative path resolved against `process.cwd()`, which
  in a packaged app is the install directory - so `save: "out.csv"` wrote a file nobody could find. Three shapes are
  understood now: a file (`D:\导出\门店.csv`), a folder (`D:\导出` - existing, trailing separator, or no extension,
  where `<flow>-<time>.csv` names the file), and a bare name (`out.csv`) that lands in the export directory. `~`
  expands, Chinese paths pass through, the parent folder is created, and the **absolute** path is what the tool
  reports back.
- The export directory is `$DSH_HOME/exports` until somebody sets one: `/browser exportdir D:\导出` (with
  `default`/`reset` to go back), and `/browser` status prints the directory in force.
- `expandHome` / `exportFileName` / `resolveExportPath` are pure functions in `flow.js`, so the rules are stated by a
  test rather than discovered by a file appearing in the wrong folder. 33 suites / 562 cases.

## 0.48.0

- **Flow automation: the 影刀-shaped half of the browser.** A task is written once as JSON and replayed on demand.
  Three tools, one new module (`flow.js`) and no new dependency:
  - `browser_flow` runs a step list - `goto` / `click` / `type` / `press` / `wait` / `waitFor` / `scroll` /
    `extract` / `each` / `eval` / `assert` - and returns a per-step report (✓/✗, timing, what was read) plus the
    rows the steps collected. `save: "out.csv"` writes them as UTF-8 with a BOM, so Excel opens Chinese correctly.
  - `browser_record` records the person's own clicks, typed values, Enter presses and debounced scrolls into steps,
    choosing selectors by `#id`, then `data-*`, then a short `tag:nth-of-type` path - never a generated class name,
    which changes between two loads of the same app.
  - `browser_eval` is the escape hatch: JavaScript in the page, value returned.
  - Measured on Google Maps, not assumed: `scroll` × 3 then `each` over `div[role=feed] div[role=article]` returned
    12 cafés with name, rating, address and link in 4.6 s, and the CSV opened with the addresses intact.
  - A failing step stops the run, names its number and type, and keeps the rows collected before it - "it broke
    after 12 rows" is the useful report, an empty error is not.
- **The "自动测试软件正在控制 Chrome" bar is gone by default.** It came from `--enable-automation`, which existed
  only so `Browser.getBrowserCommandLine` could answer - and nothing calls that any more: a leftover browser is found
  by port. `browserLaunch({ automation })` now takes the flag as an option, `browserHideAutomationBar` decides it
  (default: hidden), and it is reachable from a panel checkbox **and** from `/browser bar off|on`, because a switch
  nobody can find is the same as no switch. Verified twice: a throwaway Chrome started without the flag has no bar,
  and the plugin's own ERP window after the change has none either.
- 33 suites / 560 cases.

## 0.47.1

- **WeCom replies work again.** `replyWecomInParts` called `textBody(...)`, an identifier defined nowhere, so every
  reply that could not close its stream - the ordinary case when the platform refuses the closing frame - threw
  `ReferenceError: textBody is not defined` and the answer never went out. It now sends the same body the passive
  branch does. Found by pushing a synthetic inbound through the real path and reading the JSON it returned, not by
  reading the code.
- A guard pins it: the reply path may not call `textBody`, and its proactive branch must send the same body. Falsified
  by putting `textBody` back, which fails it.
- 32 suites / 549 cases.

- **The README documents Tavily web search and browser automation.** Both shipped earlier - `tavily_search` in 0.23.22
  and the six `browser_*` tools in 0.23.23 - but neither was ever written into the README, so a reader of the plugin's
  documentation could not find out that either existed. Two sections now cover them, including what was verified
  against the live systems rather than assumed: keyless Tavily mode, the dedicated `$DSH_HOME/browser-profile`, the
  real click and type that computed 42 on a test page, and the 68,561-byte screenshot delivered to Feishu.
- No behaviour changed. 26 suites / 440 cases.

- **Fixed: the repair gave up where it could have acted, and did not say which profile it meant.** This machine has two
  profiles - `desktop` (with the block) and `web` (without) - so `/doctor` reported
  `还不知道哪个 provider/model 可用，暂时不写` and named neither. A missing block now **borrows the selection another
  profile already declares** (evidence from this machine, not a hard-coded provider name), and the row names every
  profile: `desktop 完好 · 已补回 web（沿用 desktop 已声明的 deepseek-account/deepseek-flash，下次重启生效）`.
- `parseModelBlock` reads a declared selection back out of a patch file: it stops at the next top-level entry, so a
  `provider:` belonging to a neighbouring block is never stolen, and a trailing comment is not part of the value.
- 31 suites / 548 cases.

## 0.46.0

- **A deleted `agent-default-model` block can no longer silence the chats.** It disappeared twice (2026-10-17, and again
  after the crash on 2026-10-18), and each time every reply failed with
  `no API key for provider route "deepseek-official"` - the fallback route needs `DEEPSEEK_API_KEY`, while the account
  provider needs only the stored login. Two independent defences:
  - the plugin **remembers the provider/model that last opened a session** (`model-selection.json`) and uses it when the
    host reports no default. This is the half that works *in* the affected run;
  - at startup the profile patch is **repaired** - the block is inserted, or nothing happens if it is already there -
    with a timestamped backup beside it. This is the half that fixes the next start, and the main chat, which cannot use
    the plugin's fallback.
- `/doctor` gains a `model` row: `完好`, `已补回 N 个 profile（下次重启生效）`, or why it could not write. It also reports
  when a run has fallen back to the remembered selection.
- The repair refuses to invent a provider: with nothing remembered yet it writes nothing and says so, rather than
  guessing a name that may not exist on another machine.
- 31 suites / 545 cases.

## 0.45.0

- **One owner per plugin run.** Any browser still answering the port at the first browser action of a run belongs to the
  *previous* run, and the PAC URL it was launched with points at a server that died with that run - so adopting it means
  a window whose host list can never work. It is now **closed**, the port is waited out, and this run starts its own.
- **The argument comparison is gone from the launch path.** Five releases (0.43.2 -> 0.44.3) tried to decide "is this
  window current?" by reading and comparing its command line, and every variant raced the process it was inspecting: a
  browser that cannot report its args, a PAC URL that changes with every run, a close that has not finished yet. The
  rule that replaced it is one a check can actually keep: nothing on the port at the start of a run, one browser during
  it.
- The message says which of the two happened (`关闭了上次运行遗留的浏览器` vs `接管了…设置一致`) instead of naming a
  difference no reader could act on.
- 30 suites / 540 cases.

## 0.44.3

- **Fixed: the stale browser was replaced over and over.** Closing is asynchronous - Chrome keeps answering port 9222
  for a moment - so launching immediately after the close attached to the **dying** window, which then looked stale
  again on the next open. Same message, same difference, forever. A replacement now waits for the port to stop
  answering (up to 8 s) before starting the new browser.
- The diagnostic from 0.44.2 is what made this visible: `代理 …:47718 → 期望 …:60212` repeated after a replacement that
  had actually succeeded, which pointed at the timing rather than the comparison.
- 30 suites / 540 cases.

## 0.44.2

- **A mismatch now says what differs.** `检测到旧配置的浏览器，已关闭并按当前设置重新打开` was true but useless: it appeared on
  every open during the PAC work, and neither the person nor the log could tell which of the three comparisons
  (visibility, profile, proxy/PAC) failed. The message now ends with the difference, e.g.
  `代理 http://127.0.0.1:4402/proxy.pac → 期望 http://127.0.0.1:47718/proxy.pac`.
- **An unreadable command line attaches again instead of rebuilding the window.** 0.43.3 treated "cannot inspect" as
  "not a match" to break a deadlock: windows launched before `--enable-automation` could never be verified. Every
  launch carries the flag since 0.44, so that deadlock is gone - and rebuilding on every open is the worse failure
  (it discards the window the person is looking at).
- 30 suites / 540 cases.

## 0.44.1

- **Fixed a flaky test: a fixed `settle(40)` sleep where the inbound pipeline is asynchronous.** It failed once on a
  loaded CI runner (`exactly one turn was queued: 0 !== 1`) and never reproduced locally, because 40 ms is enough on an
  idle machine and not always enough on a busy one. The test now waits **for the condition** (up to 4 s), which is
  faster when the work is quick and honest when it is not.
- No production code changed. Eight consecutive runs of that suite are clean.
- 30 suites / 540 cases.

## 0.44.0

- **Fixed: the PAC never loaded, because Chrome will not read a `file://` PAC.** Measured twice: a PAC containing
  nothing but `return 'DIRECT'` produced `ERR_CONNECTION_REFUSED` on every request when passed as `--proxy-pac-url=file:///…`,
  and the identical script worked when served over `http://127.0.0.1`. So a configured host list broke all browsing
  instead of routing two sites - `x.com` timed out while `example.com` (DIRECT) also failed the same way.
- The plugin now runs a **loopback-only http server** that answers exactly `/proxy.pac` with the current script, keeps
  the script in memory (it changes with the list), and hands Chrome `http://127.0.0.1:<port>/proxy.pac`.
- The server is unref'd and closed on dispose; an empty host list still means "no PAC", i.e. the fixed proxy.
- 30 suites / 540 cases.

## 0.43.4

- **CRITICAL: a browser timeout could take the whole app down.** `browserOpen` created its `Page.loadEventFired` waiter
  **before** awaiting `Page.navigate`, and only attached a `.catch` afterwards. When the navigation timed out first (a
  slow page under a proxy), the waiter was never reached - so its own 20-second rejection became an **unhandled promise
  rejection**, which DSH escalates to `fatal load failure` and closes the GUI. The catch is now attached at creation, and
  a behavioural test drives exactly that order (navigate rejects, waiter rejects later) and asserts zero unhandled
  rejections.
- Found in production: `browser_open 失败：CDP Page.navigate timed out` followed by the app's fatal error screen quoting
  `browser.js:491`.
- 30 suites / 540 cases.

## 0.43.3

- **Fixed the deadlock 0.43.2 could not break.** A window started before `--enable-automation` exists cannot report its
  own command line, so the check had nothing to compare and fell back to attaching - which is exactly the old window
  that ignores the settings. "Cannot inspect" is now treated as **not a match**: the first open after an upgrade closes
  that window once and launches a fresh one, and every launch from then on is inspectable.
- The fallback is still deliberate and narrower than "never trust anything": a browser that *can* report its arguments
  and agrees with the settings is reused, so no restart loop.
- 30 suites / 539 cases.

## 0.43.2

- **Fixed: the stale-browser check could never run.** Chrome answers `Browser.getBrowserCommandLine` with
  `-32000 Command line not returned because --enable-automation not set` - so the plugin could not read the running
  instance's arguments, took the "cannot inspect, attach anyway" branch, and reused windows started with older
  settings. A configured host list then had no effect while the tool reported `设置一致`. The launcher now passes
  `--enable-automation`, which is what makes the check possible at all; the cost is Chrome's automation infobar.
- The profile comparison is lenient (normalised path or final segment): Chrome reports the same directory with a
  trailing separator or different casing depending on how it was started, and a strict comparison would have restarted
  the browser on every open.
- Verified live: a browser started with the flag reports 11 arguments including `--enable-automation`; without it the
  CDP call fails.
- 30 suites / 539 cases.

## 0.43.1

- **Fixed: a browser that has no PAC was treated as "settings match" once a host list existed.** 0.43.0 compared the
  running instance against the fixed proxy only, so a window started before the list (with `--proxy-server`) counted as
  current and was reused - the host list then had no effect at all while the tool said `设置一致`. The comparison now
  treats a PAC and a fixed proxy as **alternatives**: with a list configured, the running `--proxy-pac-url` must match;
  without one, the running `--proxy-server` must match and no PAC may be present.
- Measured live: `pid 24520 · pac=(无) · proxy=127.0.0.1:7897` attached as a match, with `x.com` in the list - exactly
  the silent no-op the stale check exists to prevent.
- 30 suites / 538 cases.

## 0.43.0

- **A proxy host list: only the sites you name go through the proxy.** `proxy-hosts.json` (one pattern per line), edited
  from the card, `/browser hosts add x.com` (also `remove` / `set` / `clear` / no argument to list), or the
  `/dsh-wechat-media/proxy-hosts` route. The plugin writes a **PAC** file and launches Chrome with `--proxy-pac-url`, so
  the **browser** decides per request: listed hosts through `127.0.0.1:7897`, everything else `DIRECT`.
- Patterns are what people type: `https://x.com/home` becomes `x.com`, `*.google.com` is subdomains only, a bare host
  covers itself **and** its subdomains (`api.x.com` matches `x.com`). An empty list keeps the old behaviour - the proxy
  applies to everything.
- The PAC uses `dnsDomainIs` only, never `dnsResolve`: a PAC that resolves names blocks page loads on a slow resolver.
- `/state.browser` reports `proxyHosts` and `proxyMode` (`pac` / `global` / `off`), `/doctor` says the scope in words.
- 30 suites / 538 cases.

## 0.42.1

- **Fixed: `/doctor` lost where the GUI port came from.** On the unchanged-port path the recording returned early
  without a source, so the report showed a bare URL with `source: null`. It now says `来自请求头` /
  `来自 DSH_WEB_URL` / `来自记录文件` every time.
- **Corrected a claim from 0.42.0.** `DSH_WEB_URL` is set for the shells DSH spawns, **not** for the plugin's own
  process - measured, not assumed: `source` came back `request` while the variable was set in a tool shell. The request
  header is the practical primary source, the environment helps in CLI runs, and `gui-port.json` is what a third party
  reads.
- 30 suites / 535 cases.

## 0.42.0

- **The GUI port is reported, not guessed.** The plugin now reads `DSH_WEB_URL` (the host prints it before any request),
  records the port in `gui-port.json` under the state directory, and reports it in `/state.gui` and `/doctor` as a
  `界面` row. A restart that moves the port is visible there (`上次 19387`), and the card shows the current address and
  where it is written.
- **The file is the stable entry point.** Anything that needs to reach this plugin - a script, another agent, a
  bookmark - can read `$DSH_HOME/dsh-wechat-media/gui-port.json` instead of scraping a runtime log or probing ports.
  The recorded port survives a restart, and the next request or the environment corrects it.
- **A fixed port is a host flag, not a plugin setting**: `dsh web --port 19387` (the harness supports `--port`; `0`
  means "let the OS pick", which is what the desktop app does). That hint is on the card next to the current port.
- 30 suites / 535 cases.

## 0.41.1

- **Fixed: `/doctor` reported `❌ ECONNREFUSED` for a proxy that works.** Clash Verge listens on `127.0.0.1` only; a
  probe that resolves `localhost` to `::1` is refused, and the row said the proxy was down while `--proxy-server=127.0.0.1:7897`
  was loading pages fine. The probe now tries the configured address, then `127.0.0.1`, then `localhost`, and names the
  one that answered: `✅ （127.0.0.1 应答）`.
- Every attempt is recorded, so a real failure still shows which addresses were tried and why each refused.
- 30 suites / 534 cases.

## 0.41.0

- **`/doctor`: one command that answers "why did that not work?"** It reports, from the plugin's own state, whether the
  three transports are alive, whether the Office toolchain was found, whether the browser's proxy port is listening,
  how the scheduled tasks are doing, and whether secrets are still plaintext - each row `✅` or `⚠️` with the one thing
  to fix. `/dsh-wechat-media/doctor` serves the same as JSON.
- **Task history + auto-disable.** Every run, failure and skip is appended to `task-history.json` (bounded to 200),
  `/task log [id]` shows the last runs with duration, `/state.tasks.recent` carries ten for a panel. **Three failures in
  a row disables the task** and says so in the chat - a broken `prompt` task used to fail silently every day. A skip
  does not count: the task may be healthy and the machine asleep.
- **A browser is only reused if it matches the settings.** The plugin asks the running instance for its own command
  line (`Browser.getBrowserCommandLine`) and compares window visibility, profile directory and proxy before attaching.
  A mismatch closes it, launches a fresh one, and says `检测到旧配置的浏览器，已关闭并按当前设置重新打开`. If the command
  line cannot be read it attaches anyway - refusing to use a browser it cannot inspect would break working setups.
- 30 suites / 533 cases.

## 0.40.2

- **Fixed: saving the browser proxy wiped the browser mode.** `browserPrefsPatch` returns only the changed keys, and
  `savePrefs` merges at the top level - so `savePrefs({ browser: patch })` replaced the whole block. Setting
  `127.0.0.1:7897` therefore dropped `mode: erp`, and the next launch silently opened a headless window.
- The browser save now merges over the saved block (`saveBrowserPrefs`). **Feishu and Tavily deliberately do not**:
  their patches are built from the saved block and delete cleared keys, so merging those would resurrect a credential
  someone just cleared - which an existing test caught when the first version of this fix was too wide.
- Guard: the merge for the browser, and the "write the complete block as-is" shape for the other two, with the reason.
- 30 suites / 529 cases.

## 0.40.1

- **Documentation repair**: the 0.40.0 changelog entry never made it into the file (a quoting accident in the release
  script exited before writing it), so the release notes described work the changelog did not. It is written below, in
  its own section, rather than folded into this one - two releases happened and the history says so.

## 0.40.0

- **Browser proxy: `127.0.0.1:7897` and friends.** Set it on the card, with `/browser proxy 127.0.0.1:7897`, or via
  `DSH_BROWSER_PROXY`; `/browser proxy off` clears it, `/browser proxy` shows it. Addresses are accepted the way people
  write them (`host:port`, `http://`, `socks5://`, `off`, empty) and normalised to what Chrome's `--proxy-server` wants.
- **The port is probed** when the setting changes: a proxy nothing listens on makes every page fail with an unrelated
  error, so the command answers `端口在监听 ✅` or `但端口现在没响应：ECONNREFUSED`.
- The scheme is validated **before** the port, because `new URL` hides a protocol's default port - `ftp://host:21` used
  to be reported as "missing a port", which points at the wrong thing.
- `browserProxy` is a string field in `BROWSER_PREF_FIELDS`, so `/prefs` forwards it and `/state.browser.prefFields`
  advertises it - the list v0.39.0 forgot, which the guard now checks.
- 30 suites / 528 cases.

## 0.39.2

- **Fixed: rowser_close reported a close it did not perform.** It killed the pid spawn returned, but Chrome hands
  the profile to a second process and the launcher can exit - so the pid was already dead, the window stayed open, and
  the tool answered success. It now sends Browser.close over the browser-level CDP socket and then checks that the
  port stopped answering; if it still answers, the tool says the close failed.
- Tested without a browser: a fake /json/version and a fake socket assert the command is sent, and a browser that
  ignores it is an error rather than a success message.
- 30 suites / 526 cases.

## 0.39.1

- **Fixed: the mode select saved nothing.** `browserMode` was handled by `browserPrefsPatch`, but `/prefs` builds the
  browser arguments from `BROWSER_PREF_FIELDS` and `BROWSER_PREF_SWITCHES` only - so the field never reached the
  handler, the mode stayed `headless`, and the card would have reported "无变化" for a setting the person had just
  changed. `/state.browser.prefFields` also omitted it, so nothing else could have noticed.
- An invalid mode name is now a **400 with the three valid names**, not a thrown error inside the route.
- Guards: the `/prefs` field list, `prefFields`, and the try/catch - three places that all have to know a field exists,
  which is exactly how one of them got forgotten.
- 30 suites / 524 cases.

## 0.39.0

- **A visible browser mode for operating a system a human is watching.** `headless` / `headed` / **`erp`**, set from
  the card's mode select or `/browser mode erp`. `erp` is not "not headless": it is **a visible window with its own
  persistent profile** (`browser-profile-erp`), a bigger viewport (1600×1000) and no auto-close, so an ERP login
  survives a restart and the person can take over the mouse at any moment.
- The old `headless` checkbox became a mode select - two controls for one setting is how a panel starts disagreeing
  with itself. A legacy `headless: false` preference still means "show me a window" (`headed`), so nobody's saved
  setting silently changed meaning.
- `/state.browser` reports `mode`, `visible` and `keepOpen`; `/browser` prints the mode, the profile path and the
  channel, and `applyBrowserPrefs` validates the mode name (an unknown one is refused, never guessed).
- 30 suites / 524 cases.

## 0.38.1

- **Fixed: the scope-copy route answered 400 with an empty body.** `feishuScopePayload` was called in the handler but
  never added to the import list from `feishu.js`, so the first click threw a `ReferenceError` and the framework turned
  it into a 400. The unit test imported the helper directly and passed; the wiring guard checked that the host *calls*
  it - and calling is not importing. The guard now requires the import line as well.
- **A 4xx in the card says what fixes it.** Routes register when the plugin loads, while the bundle is read per
  request, so a refreshed page can show a button whose route does not exist yet - exactly what happened here. The card
  now appends "可能需要重启 dsh 让插件路由生效" to a 400/404/405 instead of leaving a bare status code.
- 30 suites / 522 cases.

## 0.38.0

- **One-click copy of the Feishu scopes, from the card.** A `复制权限 JSON` button next to the Feishu block copies the
  minimal set - **8 scopes**, derived from the endpoints this plugin actually calls (messages, media, documents,
  spreadsheets, bitables, wiki lookup) - in the API's own `{ scopes: { tenant: [...] } }` shape, so it can be pasted
  into a request body unchanged. A second form (one scope per line) is served by the same route for consoles that take
  a list.
- **Deliberately not the full grant.** The list an existing app reports holds ~150 tenant scopes; copying that to a new
  app would work and would hand over access this plugin never exercises (org contacts, other apps' documents, chat
  administration). The minimum is the honest answer to "let someone else set this up".
- The copy falls back to `execCommand("copy")` when the clipboard API refuses - the panel is served over plain http on
  loopback, where some browsers refuse it, and a button that silently does nothing is worse than no button.
- Guard: the route, the single declaration, the API shape, the button and both copy paths.
- 30 suites / 522 cases.

## 0.37.0

- **The wizard is five steps now, and two of them are actions rather than explanations.** Step 1 has the WeChat QR
  button inline (the same `startPairing` the header uses), so the first thing a new user does is in front of them.
  Step 2 sends **one real message** through the bridge and reports what happened - "configured" and "working" are
  different states, and only the second one is worth showing.
- The test message goes through `deliverTo`, the same function a scheduled task uses, to the same default target
  (the chat that last wrote). A green tick here therefore means the real path works, not that a flag is set.
- `/dsh-wechat-media/test-send` is the route behind it; a failure is reported with the host's own sentence
  ("企业微信长连接没有连上"), never a generic "failed".
- Guard: all five steps exist, step 1 calls `startPairing`, step 2 calls `/test-send`, and the route calls `deliverTo`.
- 30 suites / 521 cases.

## 0.36.0

- **A four-step wizard on the card, with a one-click skip.** Step 1 asks which transport is alive (it reads the
  current state rather than asking you to retype it), step 2 covers who may talk to the bot, step 3 the two
  capabilities that touch this machine (desktop control, command tasks), step 4 the office save directory. Every
  control **reuses the same handler as the full card** - a wizard with its own copies of the switches would drift from
  the panel within a release.
- **`wizardDone` is stored, not remembered in the browser**: finishing and skipping write the same preference, so
  closing a tab halfway does not ask again, and a reinstall is a new user who should be asked.
- Guard: the card is gated on that preference, every step exists, and each step's control is the shared handler.
- 30 suites / 521 cases.

## 0.35.0

- **The Web UI card has an Office section.** It shows whether the two programs were found (Python for docx/xlsx/pptx,
  LibreOffice Kit for PDF and images), the exact paths, and the save directory with an input to change it and a button
  to go back to the default. The card and `/office dir` write the same preference, so the panel and a chat cannot
  disagree about where files go.
- The directory field starts following `/state` and stops as soon as it is edited, so it never shows a stale path
  while claiming to be the current one.
- Guard: the card must show both capability flags and must write through `/prefs?officeDir=`, next to the assertion
  that the command does the same.
- 30 suites / 520 cases.

## 0.34.1

- **Fixed the office test on Linux, which was green here and red on CI.** The new `officeDir` case wrote its paths as
  `C:\\bridge\\cwd` and `C:\\Users\\me\\Desktop`; on POSIX those are *relative* paths, so the code resolved
  them against the working directory and the assertion compared two different things. The case now builds its paths
  with `join` + `tmpdir`, so it asserts the rule rather than a platform's path syntax.
- No behaviour change: `resolveBaseDir` was correct on both platforms; the test was not.
- 30 suites / 520 cases.

## 0.34.0

- **`officeDir`: the office tools' files go where you say.** Relative paths from `office_read` / `office_write` /
  `office_convert` / `office_render` now resolve against a configurable directory instead of "wherever the bridge
  happens to run". Set it from a chat with `/office dir <路径>`, from `/prefs?officeDir=…`, or with
  `DSH_OFFICE_DIR`; `/office` and `/state.office` both print the effective directory and whether it was configured.
- **The tool descriptions stopped claiming a workspace.** They said "relative to the workspace" while the code
  resolved against the bridge's working directory - the file appeared, just not where the description promised. The
  description now names `officeDir`, and the setting behind that name actually exists.
- A relative `officeDir` is resolved against the bridge's directory rather than against `process.cwd()`, which put a
  setting like `officeDir: "out"` somewhere else entirely. Caught by the test that names both cases.
- 30 suites / 520 cases.

## 0.33.0

- **Office documents: read, create, convert.** Four tools (`office_read`, `office_write`, `office_convert`,
  `office_render`) over `.docx` / `.xlsx` / `.pptx`, plus PDF export and page images. They drive the runtime's own
  Python (`python-docx`, `openpyxl`, `python-pptx`) and the LibreOffice Kit CLI - no new dependency, nothing installed
  at run time, and `/office` prints which program each capability needs and whether it was found.
- **The payload reaches Python as base64 on argv**, never through a shell, so a Chinese path or a cell containing a
  quote is just data. **Python's answer is pinned to UTF-8**: on Windows a piped stdout otherwise uses the locale code
  page (cp936 here) and every Chinese string came back as mojibake while the document itself was correct - the exact
  shape of the PowerShell bug in 0.25.3, and caught the same way, by a live round trip asserting the text.
- A missing toolchain is named, not disguised: `找不到 Python（设置 officePython 或 DSH_OFFICE_PYTHON）` and
  `找不到 LibreOffice Kit（…）`, because "the program is absent" and "the document is broken" must not look alike.
- `/state.office` reports `{ python, kit, canRead, canConvert }`; `/office` says the same in a chat.
- 30 suites / 519 cases, including live round trips for all three kinds and a real PDF (`%PDF-`, source untouched).

## 0.32.0

- **Secrets are encrypted at rest.** `prefs.json` held the Feishu app secret and the Tavily key in plain text - a file
  anyone who can read it could take the credentials out of. Both are now sealed with **DPAPI** (`CurrentUser` scope):
  the key belongs to the logged-on Windows account and is held by the OS, so a copy of the file is worthless on
  another machine or under another account, and there is no passphrase to lose. Sealing happens on every save, and a
  startup migration seals a file written by an earlier version.
- **It never pretends.** Off Windows there is no equivalent in the box, so the values stay plain *and*
  `/state.secrets` says `atRest: "plaintext"` with the list of what is exposed - the one thing that must not happen is
  a file that claims to be protected while it is not. A sealed value that cannot be opened (copied from another
  account) degrades to "empty and reported", not to a crash.
- `secrets.js` is dependency-free: the pure parts (which fields are secret, wrap/unwrap, never double-wrap, never
  invent a block) are tested with fakes, and the DPAPI call is verified live - round trip, tamper rejection, and two
  encryptions of the same plaintext producing different ciphertext.
- 29 suites / 505 cases.

## 0.31.0

- **Missed runs have a policy now: a grace window (default 60 minutes).** A machine that slept through the night used
  to fire every missed occurrence on the first tick after waking - five `prompt` tasks meant five agent turns and five
  messages, all at the same second, all about yesterday. An occurrence older than the window is recorded as
  `错过（晚 N 分钟，超过宽限窗口）`, counted in `tasks.skipped` (separate from `failed`, because "did not run" and
  "failed" are different answers), and the schedule moves on. `taskGraceMinutes` in prefs changes or disables it;
  `0` means "run every occurrence, however late".
- **`task_add` can target a WeCom or Feishu chat explicitly.** It took `to` (a chat id) but resolved it against WeChat
  accounts only, so the other two transports could be addressed solely as "the chat that just asked". A `transport`
  parameter (`wechat` / `wecom` / `feishu`) now resolves the account the way the inbound paths build it, so a task
  created for a Feishu group is indistinguishable from one created by a message in that group. The card's add route
  accepts the same pair.
- Pure logic in `tasks.js` (`occurrenceAt`, `classifyOccurrence`, `DEFAULT_GRACE_MS`) with tests that name the awkward
  cases: exactly at the window edge (inside), one millisecond past (missed), a window of 0 (never skip), and an
  unreadable schedule (idle, never a crash in the tick).
- 28 suites / 496 cases.

## 0.30.2

- **README: what people actually schedule**, six real examples (weather line, group digest, weekly report, monthly
  reminder, a one-off re-armed by a week, a folder watch), and the card's controls in a table with *when each one
  appears* - because "where is pause?" was a fair question about a row that only shows it for recurring tasks.
- No code changes. 28 suites / 495 cases.

## 0.30.1

- **Re-arming a task that was already scheduled is no longer a silent no-op.** `rearmOnce` used a
  `while (past) { advance }` loop, so for a task whose time was already in the future it advanced zero times and still
  answered `ok: true` - the same "reports success, changes nothing" shape this feature has now been fixed for five
  times. It is a `do { advance } while (past)` loop: every call moves the task one step in the chosen direction.
- A one-off far in the past still lands in the future rather than a single step past its starting point, and the
  runaway guard stays.
- Guard: the `do/while` shape is asserted, because the difference between the two loops is exactly the bug.
- 28 suites / 495 cases.

## 0.30.0

- **`monthly` trigger**: `monthly 15 09:00` / `每月15日 09:00` / `每月 1 日 08:00`. The day is clamped to the month
  it lands in, so a "31 号" reminder fires on 30 November and 28 February instead of skipping those months - a
  reminder that silently misses a month is worse than one that arrives a day early.
- **`[再次运行]` takes a step**: `+1 天 / +1 周 / +1 月`, remembered per row. A day keeps the clock time, a week keeps
  the weekday, a month keeps the day of the month - and the month step clamps as well, because `setMonth(+1)` on
  31 January rolls into 3 March.
- Both were pure-logic changes with tests that name the awkward case: 31 in February, a weekly re-arm landing on the
  same weekday, a month step over a 28-day February.
- 28 suites / 495 cases.

## 0.29.0

- **A finished one-off can be run again, and can re-arm itself.** `[再次运行]` pushes the task's *own clock time* a
  day forward until it is in the future, keeps its history and re-enables it; a `完成后再排一次` switch on every
  one-off does the same automatically after each run. `rearmOnce` walks a day at a time rather than adding 24h, so
  "下周一 9 点" comes back at 9:00 instead of drifting to whenever it was last clicked.
- **`dueTasks` now compares a one-off's last run against *its own* `atMs`**, not against the mere presence of a
  `lastRunAt`. Without that change a re-armed task was permanently dead - it had a history entry, so the old guard
  said "already ran" forever.
- The route grew `rearm` and `auto`; a plain `toggle` on a finished one-off is still refused, now pointing at
  `rearm` as the operation the person actually wanted.
- Guards: both scheduler branches (plain end / re-arm), the two new route actions, the card's button and switch, and
  the due-list rule for a re-armed task.
- 28 suites / 493 cases.

## 0.28.3

- **A finished one-off says why it has no pause button**: the row now reads
  `✅ 已跑完（一次性任务，不能暂停）` instead of leaving the missing control unexplained. The question "where is pause?"
  was a fair one to ask about a row that showed neither a next run nor a toggle.
- 28 suites / 491 cases.

## 0.28.2

- **Resuming a finished one-off is now refused, not silently accepted.** v0.28.1 hid the button on the card, but the
  `/tasks?action=toggle&enabled=true` route still answered `ok: true` and flipped the flag - a flag that can never do
  anything, since `dueTasks` ignores a `once` task with a `lastRunAt`. Both the route and `/task on` now answer with
  the reason instead ("这是一个已经跑完的一次性任务，无法恢复——要再跑一次请新建一个"), because a hidden button is not
  the only door.
- Guard: the route and the chat command must both carry the refusal, next to the assertion that the card hides the
  toggle - three doors, one rule.
- 28 suites / 491 cases.

## 0.28.1

- **Fixed: a finished one-off looked paused, and offered a Resume button that did nothing.** A `once` task that has run
  is stored `enabled: false`, exactly like a paused task - but `dueTasks` ignores a `once` task that carries a
  `lastRunAt`, so toggling it back on flipped a flag and changed nothing. The card now distinguishes the two states:
  `✅ 已跑完` versus `⏸ 已暂停`, and a finished one-off gets no toggle at all - only Delete.
- `/state.tasks.items` gained `finished`, so a script sees the same distinction the card shows.
- Guard: the host must mark finished one-offs and the card must hide the toggle for them.
- 28 suites / 491 cases.

## 0.28.0

- **The tasks card can create a task.** A schedule line, an action (`message` / `prompt` / `command`), the payload and
  an Add button - all posting to the same `/tasks` route the other buttons use, and answered with the parser's own
  sentence when the schedule is wrong (shown verbatim, not replaced by "failed").
- The form refuses an empty schedule or an empty payload *before* calling the host: a round trip that can only fail is
  a round trip not worth making.
- The new task targets the same chat the chat-created ones do (most recent inbound, else the newest persisted route),
  so the two creation paths differ in nothing but the input device.
- Guard: the card's `addTask` must post `action: "add"` with `when`/`kind`/`text`, and must surface a host refusal
  (`ok === false`) instead of reporting success.
- 28 suites / 491 cases.

## 0.27.0

- **The Web UI card has a scheduled-tasks section.** One row per task - id, schedule, action, transport, next run,
  last run with its result - plus Pause / Resume and Delete buttons and the `command` switch. Creation stays in the
  chat, because a schedule is a sentence ("每天 8 点"), not a form.
- One route (`/dsh-wechat-media/tasks`) serves list / toggle / remove / command, and it answers with the same
  `taskSummary()` `/state` uses, so the card, the chat command and `/state` cannot disagree about what exists.
- `/state.tasks` gained the rows themselves (`items`) with both a local stamp and the ISO one: the card is read by a
  person, a script compares ISO, and both come from one place.
- Guard: the card's `taskAction` must call that route, for toggle and for remove, and the route must reuse
  `taskSummary` - the v0.20.0 lesson (a checkbox wired to nothing) applied to a button.
- 28 suites / 491 cases.

## 0.26.3

- **Fixed: every WeCom task was labelled WeChat and tried to send through the personal-WeChat path.** Account ids are
  built as `wecom:<id>` but stored normalised as `wecom-<id>`, and `transportOf` matched only the colon form - so a
  task created for a WeCom chat counted as a WeChat target and failed at delivery with
  `账号 wecom-… 不在了（可能被解绑）`, which points at the wrong thing entirely.
- Both spellings are now recognised (the same for `feishu:` / `feishu-`), the helper moved into `tasks.js` where it
  can be unit-tested, and the suite covers all six shapes: both prefixes in both spellings, an unprefixed WeChat id,
  an empty one and a missing one.
- The wiring suite's cross-check caught its own comment again: it reads `tasks.name(...)` calls in the host, and the
  phrase `tasks.js (` in an explanatory comment parsed as a call to a helper called `js`. Reworded, not weakened.
- Found live: the scheduler fired on time, recorded `runs: 1`, self-disabled the one-off and stored the delivery
  failure - the scheduling half was correct throughout, only the transport label was wrong.
- 28 suites / 491 cases.

## 0.26.2

- **A task can name its target after a restart again.** Only `lastInbound` was consulted, and that map lives in
  memory - so after every restart `task_add` refused with "还没有收到过任何消息" until somebody sent a message first,
  which is precisely the step a scheduled task must not depend on. It now falls back to the newest entry in
  `routes.json`, which is written on every inbound and survives restarts (`tasks.newestRouteTarget`, pure and tested
  against an empty map, a missing file and a route with no timestamp).
- The fallback is a fallback: the in-memory last inbound still wins, because it is the chat that just asked.
- 28 suites / 490 cases.

## 0.26.1

- **Fixed: `task_add` threw a TypeError on the very first task anyone created.** Two target shapes reach it -
  `{ transport, accountId }` from the default target (the chat that just asked) and `{ account: { accountId } }`
  from an explicit `to` - and it read the nested form first, so the first shape threw
  `Cannot read properties of undefined (reading 'accountId')`. One optional chain (`target.accountId ??
  target.account?.accountId`), plus an explicit refusal when neither yields an account. Found live, not by reading
  the code, which is the third time in this feature that running it beat reading it.
- Guard: the wiring suite now requires that optional chain and forbids dereferencing the shape that may not exist.
- Still open, deliberately not smuggled into a bug-fix release: an explicit `to` resolves against WeChat accounts
  only, so a WeCom or Feishu chat can be targeted only as "the chat that just asked". Persistent last-inbound and an
  explicit transport on `task_add` are the follow-up.
- 28 suites / 489 cases.

## 0.26.0

- **Scheduled tasks, with three actions and four triggers.** `task_add` / `task_list` / `task_remove` plus a `/task`
  command manage tasks that run on their own: `message` sends fixed text (no model, no tokens), `prompt` runs one
  ordinary turn in that chat and delivers the answer, `command` runs a local command and sends its output. Triggers:
  `daily 08:30`, `weekly mon 09:00` (also `每周一 09:00`), `every 30m`, `once 2026-10-20 09:00`. Everything is stored
  in `tasks.json`, separate from prefs so a firing task never rewrites settings someone is editing.
- **A task's due-ness is derived, never stored.** It comes from `lastRunAt` (or `createdAt`) and the schedule, so a
  machine that slept, or a hand-edited file, cannot make a task fire twice or never again; a 20-second tick cannot
  re-run the same minute. A one-off disables itself after it runs.
- **The scheduler cannot overlap itself.** One tick at a time, results written back per task, every outcome logged and
  both sides counted (`tasksRun` / `tasksFailed` in `/state.tasks`), so "it stopped running" is answerable from state
  rather than from a log hunt.
- **`command` tasks are behind their own switch** - `/task command on`, default off - because it is the only thing in
  this plugin that executes code. Off, the task still runs but reports `命令任务没开启` instead of silently skipping.
- Pure schedule logic lives in `tasks.js` (parse → next-run → due) with 14 tests that pass their own `now`, so "next
  Monday at 09:00" is a fact rather than a wait.
- 28 suites / 489 cases.

## 0.25.4

- **The desktop switch is on the panel now.** A checkbox next to the retry and interjection toggles, reading the same
  stored preference and writing through the same /prefs route as /desktop on - so the two can never disagree.
- On a platform that cannot drive a mouse it is disabled and says so (仅 Windows), reading /state's
  desktop.supported / desktop.reason rather than looking like a toggle that silently fails.
- Guard: the /desktop command, the host handler, the /prefs route and the panel's setDesktop must all line up -
  a checkbox wired to a route that ignores it is exactly what v0.20.0 shipped.
- 27 suites / 472 cases.

## 0.25.3

- **Fixed: Chinese window titles came back as mojibake.** powershell.exe -Command writes stdout in the console's
  ANSI codepage (CP936 here) and Node decodes the pipe as UTF-8, so every title in desktop_windows arrived as
  ????.... A title nobody can read is a title nobody can click, so the shared prelude now sets
  [Console]::OutputEncoding and $OutputEncoding to UTF-8 before anything is written. Found by running the tool
  for real, not by reading it.
- The guard asserts it for **every** script that can produce text, and that the encoding is set before the first
  write. Falsified by deleting the two lines: the suite goes red, then the file is restored byte-identical.
- 27 suites / 472 cases.

## 0.25.2

- **Fixed: a tool definition with an unsupported parameter type took the whole plugin down.** v0.25.0's
  `desktop_screenshot` declared a nested object parameter (`region`). The real `defineTool` throws while
  *defining* such a tool, the tools section's async block rejected, and because the HTTP routes are registered later
  in that same block they never ran - every `/dsh-wechat-media/*` endpoint answered **404** and the card looked
  uninstalled. The region is now four number fields (`regionX` / `regionY` / `regionWidth` / `regionHeight`), which
  is the kind of parameter the registry actually knows.
- **The blast radius is bounded.** That block now has a `.catch` that logs `tools section failed: …`, so a future
  tools failure costs the tools and nothing else - the routes and the reply relay survive.
- **Why 27 green suites did not catch it.** Without the harness the plugin falls back to
  `(definition) => definition`, which accepts any schema at all, so the local suites exercised a `defineTool` that
  never validated anything. The wiring suite now asserts the thin part directly: no tool parameter uses an object or
  array type, the screenshot region is four numbers, and the tools section catches its own rejection.
- 27 suites / 470 cases.

## 0.25.1

- **The desktop suite now passes on a machine that is not Windows.** Two of its tests drive the whole tool path
  through an injected `exec`, but `runDesktopScript` checked `process.platform` first - so on the Linux runner the
  platform guard refused before the fake executor was ever called, and the suite went red while every suite passed
  here. `platform` is now injectable next to `exec`, and the tests state `win32` explicitly for the fake runs.
- **The refusal has a test of its own now**, and a sharper one: with `platform: "darwin"` injected, the call must
  reject with the platform named *and* the executor must never be touched - "unsupported here" may not still spawn a
  PowerShell that cannot exist. Falsified by dropping the injected platform: the test goes red here, which is the
  only place it can.
- Found by reading the failing job log rather than by guessing - the local run was green in all 27 suites, and the
  difference was the platform, not the code under test.
- 27 suites / 469 cases.

## 0.25.0

- **Desktop control: the mouse, the keyboard, the screen and the windows.** Seven tools - `desktop_screen`,
  `desktop_windows`, `desktop_focus`, `desktop_screenshot`, `desktop_mouse` (move / click / double / right / middle /
  drag / scroll), `desktop_type` (Unicode scan codes, so Chinese arrives as typed) and `desktop_key` (chords such as
  `ctrl+s`) - drive this machine over `user32.dll` through a C# blob compiled per call with `Add-Type`. No
  dependency, no helper binary, and the same pattern the folder picker already used.
- **Off by default, armed with `/desktop on`.** These are the only tools here that act on the user's own screen
  rather than on the bridge, so the gate lives in one `desktopTool` wrapper that is the only way to define one - a
  new desktop tool cannot forget it. `/state` reports `desktop: { enabled, supported, reason }`, and `/prefs` accepts
  `desktopControl`, so the panel and a plain link can arm it too.
- **No argument is ever interpolated into PowerShell.** Coordinates are integers; typed text and window titles travel
  as base64 and are decoded by PowerShell, so a window title containing `'; Remove-Item …` is data, not code.
- **The struct layout is verified rather than assumed.** A wrong `INPUT` layout makes `SendInput` return zero with no
  error, which looks exactly like "nothing happened" - so `desktop_screen` reports `Marshal.SizeOf`, and the live run
  on this machine reports 40, the value x64 Windows validates. DPI awareness is claimed before anything is measured,
  so a pixel taken from a screenshot means the same thing to a click.
- Guards, all falsifiable: the suite builds every script and asserts the exact PowerShell (one button-down and one
  button-up per click; the press held across the whole drag with the release after the last move; wheel notches as
  `amount × 120`; modifiers released in reverse); it parses the hostile-title and hostile-text cases and asserts the
  raw text never reaches the command line; it drives the whole tool path through an injected `exec`, so no test moves
  a real mouse; and the wiring suite asserts that all seven tools go through the wrapper, that the default is off,
  and that `/desktop`, `/prefs` and `/state` all agree about the switch.
- One real bug the suite caught while adding this: `builtAt` measured only `files[]`, which npm's whitelist does not
  include `package.json` in - so the field could report a build time *older* than the version it was reporting. The
  manifest is now counted with the rest.
- 27 suites / 469 cases.

## 0.24.2

- **`builtAt` is computed when it is asked for, not remembered from the first request.** v0.24.0 memoised the
  whole build identity, so a process that started at 20:04 kept answering "the build is from 20:02" after the files
  were replaced at 20:15 - it reported the disk as it looked the first time anyone asked, which is the one moment
  the answer is guaranteed to be uninteresting. `builtAt` now stats the shipped files on every `/state` request, so
  `builtAt > loadedAt` really does mean "the files are newer than this process".
- **`version` is read at import time instead of on first use**, for the opposite reason: it has to describe the code
  that is running. It is the file's only synchronous read, because a top-level `await` would make the whole plugin
  module async. `loadedAt` stays fixed for the same reason as before.
- Guards: the Feishu inbound suite now moves a shipped file's mtime forward, reads `/state` again, and asserts
  `builtAt` followed it while `version` and `loadedAt` did not - then puts the original mtime back. A memoised
  `builtAt` turns that red; so does reporting `loadedAt` in its place. Six guards in total were falsified for this
  feature, each restored byte-identical afterwards.
- 26 suites / 445 cases.

## 0.24.1

- **The `/status` build line renders its two timestamps in local time.** v0.24.0 sliced the ISO string, so on a
  UTC+8 machine it printed `构建 2026-10-16 12:02` for a build written at 20:02 by the reader's own clock - and a
  timestamp that looks wrong is worse than no timestamp. `/state` still carries ISO UTC, which is what a program
  wants; only the human-facing line converts.
- The test recomputes the expected stamp from the same instant rather than comparing against a literal, because CI
  runs in UTC where the naive version and the correct one agree - so the assertion has to be written in a way that
  only a non-zero offset can distinguish.
- Falsified: putting the ISO slice back turns the suite red on this machine (and only here, which is exactly why
  the test is written the way it is).
- 26 suites / 444 cases.

## 0.24.0

- **`/state` and `/status` now say which build is answering.** A `link:`-installed plugin is edited in place, so
  "the files on disk" and "the code this process loaded" are two different things - and the version number alone
  cannot tell them apart. `/state` gained `version`, `builtAt`, `loadedAt` and `pluginRoot`; the chat `/status`
  command prints the first three as one line, and adds a warning when the files are newer than the process
  (`磁盘上的文件比本进程新，重启后才生效`). Until now that question could only be answered by comparing file mtimes
  against process start times by hand.
- The version comes from this package's own `package.json` - never a literal, so it cannot drift from what was
  published - and `builtAt` is the newest mtime among the files the manifest ships. `builtAt` earlier than
  `loadedAt` means the running code *is* the build on disk; later means a restart is owed.
- Guards, on the record because half of this feature is easy to wire up wrong: the wiring suite asserts the field
  is declared, rendered and fed at the call site (the v0.19.5 lesson - a parameter `statusText` does not declare is
  dropped silently), that the version is read from the manifest rather than typed in, and that no
  `version: "x.y.z"` literal exists in the host. The Feishu inbound suite reads `/state` through the registered
  route and recomputes `builtAt` from the manifest, so reporting `loadedAt` instead, or only the manifest's own
  mtime, or a constant, each fail. The warning case has its own test through the exported pure
  `buildLineText`: a stale build is called out, an up-to-date one is not, and missing timestamps read
  as unknown rather than as 1970.
- 26 suites / 444 cases, none skipped. (The four voice cases skip where a machine has no speech engine and no
  ffmpeg; in the environment this release was tested in they run, which is the whole of the difference from the
  437/439 figures earlier entries recorded.)

## 0.23.27

- **A cookbook for the Feishu half: `docs/build-a-knowledge-base.md`.** One real job, written down end to end - a
  997-paragraph Chinese Word question bank (312 questions, no tables) parsed into structured data, deduplicated to
  285, corrected in 64 places against the laws and the ministries' own wording, uploaded to a Feishu bitable, then
  verified field by field (285/285) and used to answer questions inside the chat. It ships with the plugin and the
  README links to it.
- The parts worth reusing are spelled out rather than implied: a parser state machine for a short-answer block that
  alternates question and answer (an "ends with ？" test silently swallowed three questions), self-checks that turn a
  wrong answer key into a symptom you can trace, exact **and** near-duplicate detection with the human decision kept
  in one file, six parallel review passes that report only what is not `ok`, and a bitable that arrives with four
  default fields and no tool to add a fifth - so the fields are extended over the REST API before the first row is
  written.
- **Uploads are idempotent and verified.** The uploader purges existing records before writing, and a second script
  pulls the remote table back and diffs it against the local data field by field; "code: 0" is treated as a request
  that was accepted, not as a check.
- A packaging test keeps the document honest: it must be listed in `files[]` and linked from the README. Falsified
  both ways (removing it from `files[]`, and removing the link) before being kept.
- 26 suites / 441 cases (437 passed, 4 skipped on that machine: no speech engine, no ffmpeg).

## 0.23.26

- **The launch test no longer needs a browser to be installed.** It asked the machine for Chrome, which passed here and
  failed on the CI runner, where `browserLaunch` correctly refuses to start nothing. The executable is now injectable
  (`browserLaunch({ executable })`), the test injects one, and a second test covers the refusal with a profile
  directory that cannot be created on any machine - so neither depends on what the runner happens to have.
- 26 suites / 439 cases.

- **The browser suite no longer assumes it can write to the root of `C:`.** One test passed a hard-coded `C:\tmp\...`
  as the browser profile, which this machine's user can create and the CI runner's user cannot - so `Run every suite`
  failed on CI while passing locally. The profile now comes from the system temp directory and the assertion compares
  against the path actually used, so the test checks the code instead of the environment.
- 26 suites / 439 cases.

- **`/state` reports a saved Tavily key from startup.** Only the Feishu cache was warmed when the plugin started, so
  `/state` reported `keySet: false` - and appeared to have lost the key - until the first search happened to refresh the
  cache. The saved key was never lost; the reported state was stale. Startup now warms every cache `/state` reads, in
  one chain, each refresh before the long connection starts.
- The two guards that pinned the old startup *adjacency* were rewritten as properties ("the saved settings are refreshed
  before the connection starts"), and a new guard asserts that all three caches are warmed at startup. Both falsified:
  moving the connection first, or warming only Feishu, fails them.
- 26 suites / 439 cases.

- **Browser automation for the chat channels.** Six tools - `browser_open`, `browser_text`, `browser_click`,
  `browser_type`, `browser_screenshot`, `browser_close` - drive a real browser over the Chrome DevTools Protocol, with
  **no third-party dependency**: Node's own global WebSocket carries CDP. Verified live against Chrome 155: a page of
  its own received typed input (17 and 25) and a real mouse click, and computed 42 by itself.
- It uses the Chrome or Edge already on the machine and a **profile of its own** under `$DSH_HOME/browser-profile`, so
  the browser a person actually browses with is never touched. Nothing to install: no npx, no npm install, no config
  file - the panel picks the channel, the port and whether it runs headless.
- `browser_screenshot` saves the PNG into the shared inbox and returns its path, so the picture can be sent straight to
  WeChat, WeCom or Feishu: verified end to end (68,561-byte PNG delivered).
- Every failure states its reason (`browser_click 失败：nothing on the page matches the selector "…"`) and is recorded
  on the `/browser` route log.
- Guards for the shared session, the inbox path and the reason in every failure - each falsified.
- 26 suites / 438 cases.

- **Tavily web search for the chat channels.** A `tavily_search` tool lets a WeChat / WeCom / Feishu conversation ask
  about something current and get real titles, links and snippets back. Every shape was copied from the user's own
  working plugin (`wjh-ux/dsh-mcp-tavily`, cited line by line in `tavily.js`) rather than guessed, and the live API was
  called to check it: with a key, 3 results in ~3s; **keyless mode works too**, so search still functions before a key
  is configured.
- **The key is configured without a restart** and never echoed back: it lives in prefs (panel → `config.tavily` →
  `TAVILY_API_KEY`), `publicPrefs` masks it - including the case that used to leak, a Tavily-only prefs object with no
  Feishu block - and the panel can only say whether one is set.
- Failures state their reason (`Tavily 搜索失败：…`) instead of returning an empty answer, and the tool re-reads the
  saved settings before every call, so saving is enough.
- Guards for all of it, each falsified: the mask, the registration, the reason in the message, and the panel's key
  field (a text field, or a field pre-filled from state, both fail the guard).
- 25 suites / 429 cases.

- **The readable export was dropping the conversation.** 0.23.20 shortened 25 lines from 94,566 characters to 803 - by
  losing the spoken text and leaving type tags. The harvest walked `block/delta/chunk/data/message` but not `content`,
  and only took `content` when it was a string; in the real records it is an array
  (`data.content = [{ type: "text", text }]`), so the words were skipped.
- Fixed by reading the actual records instead of assuming them: one full line per record type was printed from a live
  transcript, which showed the four shapes. `content`, `inserted` and `elements` are now walked too, records that carry
  no conversation (including `request/header`, which embeds the whole system prompt) are skipped **by an explicit list**,
  duplicates are dropped, and user/assistant messages are labelled. Measured offline against the same transcript:
  135,012 characters of raw lines become 13,819 readable ones, with one type-tag left instead of nearly all of them.
- 24 suites / 420 cases.

- **The session export writes something a person can read.** Each transcript line is a record in the host's own shape;
  they are now turned into paragraphs and tool-call summaries (`[工具 edit] …`) instead of raw JSON. Recognition is
  shape-agnostic - it looks for `text`/`content` and descends through `block`/`delta`/`chunk`/`data`/`message` - and a
  line it does not recognise is kept verbatim, because a document that quietly omits things is worse than a verbose one.
- `format: "raw"` still exports every line verbatim for archiving.
- 24 suites / 420 cases.

- **The driver-level success path for Feishu attachments is tested, and passes.** When the download first shipped, its
  one driver test pinned the *failure* path, because the tools had no token and a success could never happen. With that
  fixed, the test now boots the harness with `resources: "bytes"`, asserts the resource endpoint was called with
  `type=image`, and asserts the prompt hands the model a path on disk. It ran 5 times without a flake.
- Falsified: pointing the stub back at JSON makes it fail. The failure path stays pinned by the guards in
  `wiring.test.mjs`, which assert the honest note is still in the code.
- 24 suites / 420 cases.

- **The session export could not find the transcript.** It assumed `sessions/<one-level>/session.v4.jsonl.zstd`; the
  host nests it deeper, so the first real call answered "没有在 …\sessions 找到会话记录" against a directory that does
  contain one. It now walks down (depth 4) and, when it still finds nothing, reports how many candidates it examined.
- The layout is the host's, not ours - which is why it is discovered by walking rather than assumed.
- 24 suites / 420 cases.

- **The panel can export the conversation.** A new action, `create-from-session`, reads the transcript the host already
  writes under `$DSH_HOME/sessions/<newest>/session.v4.jsonl.zstd`, takes the last N lines (default 40, capped at 500)
  and writes them into a new document - the same file-reading approach this work's own checks used, so no host-internal
  API is assumed. The modules it needs are imported inside the branch, keeping the change self-contained.
- The panel's action dropdown gained "导出当前会话（读宿主会话记录写成文档）".
- A missing `tenantHost` is still reported rather than turned into a link built from the API host.
- 24 suites / 420 cases.

- **The panel's spreadsheet and bitable actions failed with "feishuSheetTokenFrom is not defined".** The parsers live
  inside the tools' registration callback, and the route is registered in a different callback, so it could not see
  them - the same scope trap that the panel's Save button hit earlier in this work. The route now defines its own, with
  the same names, so it does not depend on where the tools happen to be registered.
- Found by calling the panel's route the way the panel does: `create` and `read` worked, `sheet-read` and
  `bitable-read` answered `ok:false` with that message. The first pass at this check printed neither error - the
  failures were invisible until the reason was printed, which is its own lesson.
- 24 suites / 420 cases.

- **The Web UI can drive Feishu documents, spreadsheets and bitables.** The Feishu block now has an operations area:
  title, link, range and body fields, a dropdown covering all seven actions (`create`, `read`, `append`,
  `sheet-read`, `sheet-write`, `bitable-read`, `bitable-write`), a run button, and a result line.
- Creating a document shows the link when a tenant host is configured, and otherwise shows the id plus the reason
  there is no link - the same rule the tools follow, so the panel never hands over a link that opens a generic page.
- Every failure is printed with its reason; the area keeps its own state so nothing in it rides along with Save.
- 24 suites / 420 cases.

- **A host route for the Web UI's document actions**: `POST /dsh-wechat-media/feishu-doc` with
  `action=create|read|append|sheet-read|sheet-write|bitable-read|bitable-write`. The panel holds no credentials, so
  every action it will offer runs here, through the same helpers the tools use - no second implementation to drift.
- The route reports a missing `tenantHost` instead of returning a link built from the API host, which opens a generic
  page rather than the document.
- The token guard was rebuilt: instead of a fixed count (which went stale the moment this route added call sites) each
  helper is compared against itself, so a call site that skips the token fails with a precise message. Falsified by
  removing one token from the route.
- **Still outstanding:** the panel UI itself (the export button and the operations area). The route is usable from the
  command line meanwhile.
- 24 suites / 420 cases.

- **The Web UI can set the tenant host.** A field in the Feishu block fills `feishuTenantHost`; Save submits it, and the
  value comes back from `/state` after a reload. This is what makes a created document return as a link you can open
  instead of an id with an explanation.
- Added with a precise edit rather than a generated insertion: the previous attempt built the same change with a script,
  landed inside an element, broke `client.js` and was rolled back. The same change as two exact string replacements
  took one attempt.
- The guard now covers the panel field as well as `/state` and the preference chain.
- 24 suites / 420 cases.

- **`/state` reports `feishu.tenantHost`.** Until now the setting existed in the config chain (saved → config →
  `FEISHU_TENANT_HOST`) but was invisible from the outside, so the Web UI could not show the saved value and a reload
  would have looked empty. This is the prerequisite for a panel field; the field itself is still outstanding.
- The guard for this asserts what actually exists rather than what was intended: `/state` reports it, the preference
  route accepts `feishuTenantHost`, and the chain is saved → config → env. A panel field was attempted in the same
  round, broke `client.js` during insertion, and was rolled back - the guard says so instead of pretending.
- 24 suites / 420 cases.

- **One of the fourteen call sites still had no token, so `feishu_doc_create` failed while its siblings worked.**
  The fix in 0.23.10 covered thirteen of them; the append inside the create tool used a different target variable and
  was missed. Found the same way as the first one - by calling the tools, not the helpers: `feishu_doc_read`,
  `feishu_sheet_read` and `feishu_bitable_write` all worked, and create answered
  "appending to a document needs a tenant_access_token".
- The guard for this is now an exact count (14) rather than a floor, and it is falsified: removing that one token
  makes both this guard and the create test fail.
- 24 suites / 419 cases.

- **The nine document tools did not fetch a Feishu token, so every one of them failed.** They passed no `token` to the
  helpers, which correctly refuse to guess one: the first real call answered "reading a document needs a
  tenant_access_token". The helpers had always been tested **with** an explicit token, so only calling the tools
  themselves could show it - which is exactly what happened, one turn after they shipped.
- Each of the 13 call sites now fetches its own token (`token: await feishuToken()`, the same cache the send path uses),
  and a guard asserts that floor so the tool path cannot lose it again.
- 24 suites / 419 cases.

Nine new tools, so the bridge can work with Feishu documents, spreadsheets and bitables - all of them built against
shapes measured from the live API rather than read off the documentation:

- **Documents**: `feishu_doc_create` (writes the body too), `feishu_doc_read`, `feishu_doc_append`.
- **Spreadsheets**: `feishu_sheet_create`, `feishu_sheet_read`, `feishu_sheet_write`.
- **Bitable (多维表格)**: `feishu_bitable_create`, `feishu_bitable_write`, `feishu_bitable_read`.

What the live API settled that guessing would have got wrong:

- **A reader-facing document link needs the tenant host.** `https://open.feishu.cn/docx/<id>` answers
  `200 text/html` - a generic page, not the document - while `https://<tenant>.feishu.cn/docx/<id>` answers `302` to
  the login page. The URL builder now requires a tenant host (`tenantHost`, or `FEISHU_TENANT_HOST`) and returns
  **nothing** rather than a link that looks right and opens the wrong page; the tool says so and tells you what to set.
- **The spreadsheet values API is v2 and is not in the official SDK at all** - all 17 sheet endpoints it ships are
  metadata or styling. `GET/PUT /sheets/v2/spreadsheets/:token/values/...` was settled by calling it.
- **The bitable write has to be confirmed by reading that exact record.** Listing records showed the field as `null`,
  because those were other, empty records; reading the written `record_id` returned the text. Status 200 is not proof.

Also fixed: `test/feishu-inbound.test.mjs` could fail about one run in three. That test's path now fetches a token and
then a resource, so a fixed sleep was a race; it waits for the condition and passed 5/5 runs afterwards.

24 suites / 417 cases.

- **The Feishu attachment download never got a token, and the prompt said so.** `feishuToken()` returns the token
  **string** (`return fresh.token`); the downloader destructured it (`const { token } = await feishuToken()`), which
  yields `undefined` for a string, so the fetch was refused before any request was made. The live prompt reported it
  verbatim - `[飞书image未保存] downloading a resource needs a tenant_access_token` - which is exactly what the honest
  failure path exists for. Fixed to take the string, with a guard that asserts the correct form **and** rejects the
  destructuring one.
- This also explains the unresolved driver-level test from 0.23.6: the harness's token call returned no token for the
  same reason, so no `/resources/` request was ever visible.
- 24 suites / 406 cases.

- **Feishu attachments are downloaded, not merely described.** An image, file, audio or video message is fetched with
  `GET /open-apis/im/v1/messages/:message_id/resources/:file_key` and saved into the same inbox the WeChat and WeCom
  paths use, so the model gets a path it can open. A fetch that fails is reported in the prompt
  (`[飞书image未保存] …`) rather than leaving the model to assume there was no attachment.
- **The required `type` parameter was settled against the live API, not guessed.** The official docs are
  client-rendered and the SDK's type declarations did not expose it: `?type=image` answers `200 image/jpeg` with exactly
  the bytes that were sent (1,100,583 for a 1,074.8 KB image), `?type=file` answers `200 application/octet-stream` for
  the same resource, and **no parameter** answers `400 code 99992402 "field validation failed"`.
- **A file name, found by running it for real.** The first live download landed as `undefined.jpg`, because Feishu sends
  no `name` for an image, audio or video attachment and the inbox sink derived the name from that missing field. The
  name is now built from the kind and the key (`image-3e41a3a970dg`) and the extension is sniffed from the bytes - the
  same live run then produced `image-3e41a3a970dg.jpg`, 1,100,583 bytes, header `ffd8ff`, matching the bytes the API
  returned. A guard asserts the fallback and that the name is never literally `undefined`.
- 24 suites / 404 cases; the download helper is unit-tested against a stub that returns real bytes, and a guard asserts
  it is **imported** as well as written - the mistake made twice while building this.

- **The Web UI's Feishu Save button did nothing, and the cause was a single missing brace.** When the Feishu block was
  added to `client.js`, the closing brace of `setInterject` was consumed, so `setFeishu` ended up **nested inside
  `setInterject`** - invisible to the render code that calls it. Clicking Save threw `ReferenceError: setFeishu is not
  defined`: no request, no message, nothing. Every source-level assertion passed, because the source *looks* right.
- Found with an **oracle**: the client module is loaded the way DSH loads it (`window.__ModuleLoader__`), the card is
  rendered, the Save button is found in the tree and **clicked** against a recording `fetch`. That reproduced the
  `ReferenceError` and, after the fix, showed the request the button actually makes.
- That oracle is now a **regression test** (render → find the button → click → a `/prefs` request must happen), and it
  was falsified by restoring the missing brace, which fails it with the original error.
- `/prefs` also logs the **field names** it was asked to change (never values), so "did the panel's Save reach the
  plugin?" is answerable from `/state` rather than guessed.
- 24 suites / 402 cases.

## 0.23.4

- **`/state` reported the Feishu frame counters from connect time, so a working connection looked dead.** The status
  object was cached and only rewritten when the connection *changed*; the counters inside it change with every frame.
  `feishuState()` now re-reads the live snapshot - **but only its counters**: copying the whole snapshot overwrote a
  recorded `failed` with a stale `connecting` and hid the very failure that state exists to report. That regression
  was caught by `test/feishu-inbound.test.mjs` before this shipped, and both directions are now asserted (the
  counters are refreshed; the recorded failure state is not).
- 24 suites / 399 cases.

## 0.23.3

- **The first real Feishu frames were thrown away, and only production showed it.** Node's global `WebSocket` hands
  binary frames over as a **Blob**; the decoder did `Buffer.from(raw)`, which throws `Received an instance of
  Blob`. Every test fed Buffers to a fake socket, so the whole suite passed while the live connection reported
  `feishuErrors` growing and `stats.received` staying at zero. `frameBytes()` now accepts Buffer, ArrayBuffer,
  typed-array views and Blob (the socket also asks for `arraybuffer`), and a regression test covers all four shapes
  **plus the throwing form**, so the trap itself is pinned.
- Found by reading the running plugin after the credentials were fixed - the long connection had connected, and the
  error the plugin reported named the Blob.
- 24 suites / 399 cases.

## 0.23.2

- **The panel now shows what is saved, and says so when it saves.** The Feishu fields read only their local draft, so
  after a refresh every box looked empty even when the value was stored - the person could not tell whether anything
  had been saved, and the write path was in fact fine (`/prefs?feishuAppId=…` stores it; the test asserted it against
  the running plugin). App ID now falls back to the saved value, the domain keeps its derived fallback, and the secret
  boxes stay empty but say whether a secret is already set. Saving reports `已保存(…字段) · 连接状态：…` **inside the
  Feishu block**, failures show the real error there too, and unsaved edits are called out.
- Webhook URL is deliberately **never** pre-filled: `/state` only carries a truncated prefix, and writing that back
  would store an ellipsis.
- `/state.feishu` gained `webhookSecretSet` and `to` (neither is a secret), because the panel could not say
  whether a webhook signing secret was configured without them.
- 24 suites / 398 cases. The App ID fallback is guarded, and the guard was falsified (removing the fallback fails it).
- Still unverified by me: how the panel renders in a browser. That needs the person looking at it.

## 0.23.1

- **The panel's Feishu checkbox could not be cleared without reloading the page.** `Boolean(feishuDraft.feishuLongConnection ?? (…) === "true")` parses as `draft ?? ((…) === "true")`, so a draft holding the string `"false"` - non-empty, therefore truthy - rendered as **checked**. The comparison now sits outside the nullish coalescing, and a guard asserts both that the broken form is gone and that the fixed one is present; reverting the fix makes that guard fail (verified by doing exactly that).
- Found by using the panel, which is the same lesson as the rest of this feature: the source looked right, the browser said otherwise.
- 24 suites / 397 cases.

## 0.23.0

- **Feishu can be configured from the Web UI panel, and saving takes effect immediately.** Until now the only ways in
  were the plugin config file and environment variables - a `setx` plus a DSH restart just to try a bot. The panel now
  has a Feishu block (App ID, App Secret, custom-webhook URL and signing secret, platform, default receive id, and the
  long-connection switch), values resolve **panel → config → environment** field by field, and saving restarts the long
  connection with the new settings. Both routes accept the fields - `/prefs` (what the panel writes) and `/panel`
  (what the cards write), which is the mistake v0.20.0 made with a different switch.
- **A leak, found by the test written for this change.** Feishu secrets are now stored in prefs, and both `/state` and
  `/prefs` returned the whole prefs object - so saving a secret sent it straight back in the response, over plain HTTP.
  One `publicPrefs()` helper redacts every response that carries prefs, and the test asserts the secret never appears.
  Verified by **breaking the redaction and watching the assertion fail**, then restoring the file byte for byte.
- Two safety rules the panel depends on: its Save button sends **only** the fields that were typed (so a blank input can
  never wipe a stored secret), and clearing is a separate action that sends explicit empties. The route still treats an
  empty string as a clear.
- `/state.feishu` gained `savedFields` (names only) and `sources` (which half each value came from), so the panel
  can say "saved here" instead of guessing.
- Tests: **24 suites / 396 cases**, including two that boot the plugin, drive the real `/prefs` route and read the real
  `/state` route back.

## 0.22.0

- **Feishu, second half: receiving - over the long connection, so no public URL is needed.** Feishu offers two ways to
  get events; this takes the WebSocket one (the way OpenClaw's channel does it) and deliberately skips the event route,
  because that is the option that needs a tunnel or a public address. `feishu-ws.js` (693 lines) is dependency-free:
  Node 24's own `WebSocket` plus a minimal protobuf codec written here.
- **Every protocol fact came from the official `@larksuiteoapi/node-sdk` 1.75.0** (MIT, download verified against its
  registry hash) rather than from memory: the handshake is `POST {domain}/callback/ws/endpoint` with
  `{AppID, AppSecret}` answering `{code, data:{URL, ClientConfig}}` (capitalised keys, intervals in **seconds**); the
  frames are protobuf in the `pbbp2` namespace with `Frame` 1 `SeqID`(uint64) / 2 `LogID`(uint64) / 3 `service`(int32) /
  4 `method`(int32) / 5 `headers`(repeated `Header`) / 6 `payloadEncoding` / 7 `payloadType` / 8 `payload`(bytes) /
  9 `LogIDNew`, and `Header` 1 `key` / 2 `value`; `FrameType` is `{control: 0, data: 1}`; an event is acknowledged by
  **sending the received frame back** with a `biz_rt` header and `{"code":200}`; and a fragmented event is reassembled
  from `message_id`/`sum`/`seq`/`trace_id` with malformed metadata **rejected** - the official implementation guards the
  same case and cites its own issue #201 for it. The field numbers were re-checked against the SDK's
  `Frame.encode`/`Header.encode` by hand, not taken from a summary.
- **Inbound messages become turns.** `im.message.receive_v1` text and rich text are turned into a prompt (prefixed like
  the other channels), routed to a stable session per `chat_id`, and the answer is **posted as a reply under the
  question** (`message_id`), falling back to an ordinary send when the reply is refused; long answers are chunked. Two
  refusals are deliberate and tested: the bot **ignores its own messages** (`sender_type: "app"`), because answering
  them would wake itself in a loop, and a **re-delivered event is answered only once**.
- Configuration: `feishu.longConnection` (default **on**; `feishu.longConnection = false` or
  `FEISHU_LONG_CONNECTION=false` turns it off). It only connects when `feishu.appId` and `feishu.appSecret` are set, and
  a connection that cannot start **never breaks the plugin** - the reason is recorded for `/state` and `/feishu`.
- Where to look: `GET /state` gained a `feishu` block (configuration, connection state, `lastError`, `lastEventAt`) and
  `counters.feishuEvents` / `feishuAnswered` / `feishuIgnored` / `feishuErrors`; `/feishu` shows the same in a chat,
  including *why* the long connection is down when it is.
- **A real bug the tests caught, and it is the same mistake this project keeps making.** `feishuWsEnabled()` used to
  answer "is the long connection up?" by checking whether a handle existed - but the handle is assigned *before*
  `await start()` resolves, so a **refused handshake still reported "connected"**. It now reports the connection
  **state**. Claiming a success that was never measured is exactly what the voice bubble, the missing `playtime` and the
  Web UI checkbox each did; this one was caught by a test instead of by the user.
- Attachments are **described, not downloaded**: the endpoint
  (`GET /open-apis/im/v1/messages/:message_id/resources/:file_key`) is visible in the official source, but **which query
  parameter selects the resource type is not readable there**, so it is not guessed - the model is told an attachment of
  that type exists, and the README says so under Limitations.
- Tests: **24 suites / 393 cases**. The new `test/feishu-inbound.test.mjs` does not read source text - it feeds events
  into a real `apply()` as **real protobuf frames** over a fake WebSocket and reads the counters back through the
  **registered `/state` route**. Feishu also has `test/feishu.test.mjs` (19) and `test/feishu-ws.test.mjs` (34), whose
  assertions were falsified on purpose (a changed field number, a missing seconds→milliseconds conversion, an ack
  without `biz_rt`, a removed fragment bound) and each failed as it should.
- **Not yet verified against the live platform.** The handshake endpoint, request shape and error path were exercised
  for real (Feishu answered `code 1000040345`, and the error did not leak the secret), and the protocol is pinned by
  tests - but the first real inbound message still needs the console switched to 使用长连接接收事件, a published version
  and a valid App Secret. Until then this is built and tested, not proven.

## 0.21.0

- **Feishu (飞书 / Lark) support, first half: sending.** A new `feishu.js` speaks to both kinds of Feishu bot, and every
  endpoint, field and algorithm in it was read from the official `@larksuiteoapi/node-sdk` 1.75.0 (MIT) source rather
  than recalled - the download was verified against its registry hash before it was opened.
  - **Custom webhook bot** (`feishu.webhookUrl`, optional `secret`): text and rich text. Its signature is the trap of
    this API - `HMAC-SHA256(key = timestamp + "\n" + secret, data = "")`, base64 - confirmed against an independent
    Rust implementation (`lark-webhook-notify`, Apache-2.0) **and its published test vector**, and an interactive card
    goes under `card` while everything else goes under `content`.
  - **App bot** (`feishu.appId` / `feishu.appSecret`): `tenant_access_token` with caching, messages, replies,
    image/file upload (multipart built by hand - the plugin stays dependency-free), and `file_type` mapping.
  - Inbound event verification and decryption are implemented and tested, ready for the receive half: the AES layout is
    `sha256(encryptKey)` with the **first 16 bytes of the ciphertext as the IV**, and the signature is
    `sha256(timestamp + nonce + encryptKey + body)` (`sha1` with the verification token when unencrypted).
- Tools `feishu_send_text` and `feishu_send_file`, both in `DELIVERY_TOOLS`, plus a `/feishu` command
  (`/飞书`, `/lark`) that reports the configured channels - **never echoing a secret, only whether one is set** - and
  can send a self-test. A webhook-only setup **refuses** to pretend it can send files, and says why.
- `package.json.files` was missing `feishu.js`, `voice.js` and `plain-text.js`: `package.test.mjs` enumerates
  host modules from that field, so it had never imported them, and an `npm publish` would have shipped without them.
  **(GitHub releases were never affected - they carry the whole tree.)**
- `DELIVERY_TOOLS` listed `wecom_send_voice` but not `wecom_send_text`/`wecom_send_file`: a WeCom answer sent with
  those tools was relayed a second time as text. Both are listed now, and a guard asserts the set is symmetric across
  platforms.
- Tests: **22 suites / 345 cases**, including a new `test/feishu-wiring.test.mjs` that does not inspect source text but
  **calls `apply()` with a fake context and executes the tools against a stubbed fetch** (33 assertions: the webhook
  signature, the `post` shape, "webhook-only cannot send files and sends nothing", one token fetch for two sends,
  `oc_`/`ou_` inference, three upload paths, and that no secret ever reaches a request body).

## 0.20.1

- **The Web UI checkbox from v0.20.0 did nothing, and this makes it work.** The retry switch was wired into the
  `/panel` route (which the cards in a chat use) but **not** into `/prefs`, which is the endpoint the Web UI
  actually writes to - so ticking the box saved nothing, silently. Both routes accept it now.
- Found by **toggling it against the running plugin** rather than by reading the diff: `/prefs?retry=false` left the
  preference at `true`. The guard test now asserts **both** routes, because one of them was enough to pass before.
- 292 tests across 20 suites.

## 0.20.0

- **A turn that dies in the transport is retried once, and you can switch that off.** Those failures are real here -
  seven of them are recorded in this project's own session log, each one ending with `DeepSeek Messages transport
  failed` and leaving the chat with nothing but an error line. `shouldRetryTurn()` now decides: exactly **one**
  retry, and only for a cause that looks transient (`TRANSPORT`, `ECONNRESET`/`EPIPE`/`ETIMEDOUT`, `fetch
  failed`, `socket hang up`, timeouts, `429`/rate limits, `502`/`503`/`504`, overload). A deterministic
  failure - a rejected request, a bad model id, a context overflow - is **not** retried, because a second call would
  fail the same way and hide the cause.
- The retry is visible rather than silent: the chat is told (`⚠️ 上一轮失败：… 正在重试一次…`), `counters.retried`
  counts the attempts and `counters.retryFailed` the ones that failed again, and a **fresh** user message is created
  for the retry (handing the same object back could be taken as already seen).
- **The switch is reachable three ways**, and a guard test asserts all three: `/retry [on|off]` in a chat (aliases
  `/重试`), the checkbox in the Web UI panel (`/prefs?retry=…`), and the preference the host reads before each turn.
  Default **on**.
- `test/retry.test.mjs` unit-tests the policy itself - the transient list, the deterministic list, the one-attempt
  ceiling, the switch, and the safe defaults. 292 tests across 20 suites.
- While building this, two edits landed in the wrong place (a command handler at the first `return true;` in the file,
  and a helper outside module scope). The syntax checker and the context-printing steps caught both before publishing,
  which is the practice this project adopted after three earlier "changed, reported, but not actually reachable"
  misses.

## 0.19.6

- **v0.19.5's `/state` claim was not true, and this release makes it true.** The field it added was passed to
  `statusText()` - the `/status` **chat command** builder - which destructures only the parameters it knows, so the
  value was silently dropped and showed up nowhere. The record is now where the changelog said it was:
  `GET /state` returns `interjections` (the last ten) from the route that actually serves it, and `/status`
  renders `最近一次判定：…` from an explicitly declared `lastInterjection` parameter.
- The guard test is rewritten to assert **reachability** rather than the presence of a string: it checks the state
  route, the call site, the declared parameter and the rendering. The previous version passed while the feature was
  invisible - the third time this project has shipped a claim an assertion could not see.
- 287 tests across 19 suites.

## 0.19.5

- **"Did interjection ever fire?" is now answerable across restarts.** The counters are in-memory, so after a restart
  "`interjected` stayed 0" proves nothing - and that gap produced a wrong conclusion about this feature (the switch
  was called useless on evidence that could not support it). Every decision is now written down: a durable JSONL line
  under ``/dsh-wechat-media/log/interjections.jsonl`` plus the last ten in `GET /state` as
  `interjections`, each carrying the **reason** - `interjection is off`, `no turn was running for this chat at
  that moment`, `this harness exposes no agent.steer`, or `steered into the running turn`.
- `interjectReason()` is a named function so the wording itself can be asserted, and a guard test checks the recorder,
  the durable file, all four call sites (two decisions, two steer failures) and the `/state` exposure.
- 286 tests across 19 suites.

## 0.19.4

- **Interjection can no longer lose a message.** `await agent.steer(message); return;` was unguarded on both
  inbound paths: a steer that raced the end of a turn - or that the harness refused - left the message neither
  joined to the running turn nor queued, which is exactly the failure "interject" must never have. A failed steer now
  **falls through to the queue** (`followup` plus a waiter, the same path as when interjection is off), and
  `counters.interjectFailed` counts it so it is visible in `/state` rather than silent.
- `counters.interjected` now increments **after** the steer succeeds, so a failure can no longer be counted as an
  interjection.
- A guard test asserts both paths are wrapped, that the fallback counter exists, and that nothing is counted before it
  succeeds.
- 285 tests across 19 suites.

## 0.19.3

- **v0.19.2's changelog described a change its code did not contain, and this release makes it true.** The edit
  missed its anchor (the wording it searched for had already been replaced in the previous release), the release was
  published anyway, and the notes claimed a conversation-window caveat that the tool's reply did not have. The reply
  now really carries it: *iLink delivers only inside a window opened by a recent inbound message, so a send made
  outside one is accepted by the platform and then dropped without an error - if it did not arrive, ask them to write
  to the bot first.*
- Worth recording as a process failure rather than a wording fix: **a publish must fail when an intended edit did not
  apply.** Two anchors have now silently missed this way (v0.19.2 here, and the `playtime` field earlier). The
  publish script verifies the tree, not the intent.
- Documentation and one reply string; 284 tests across 19 suites.

## 0.19.2

- **The voice tool's reply now says what is actually true.** It still blamed a missing SILK encoder - which this
  plugin has had since v0.19.0 - for a limitation that is a platform rule. It now states the real reason (personal
  WeChat does not accept voice-type messages, which is why Tencent's own WeChat channel never sends one) and adds the
  **conversation-window caveat**: iLink delivers only inside a window opened by a recent inbound message, so a send
  made outside one is accepted by the API and then dropped, invisible. "If it did not arrive, ask them to write to the
  bot first" is the actionable half of that.
- Documentation only; no behaviour changed. 284 tests across 19 suites.

## 0.19.1

- **Correction: v0.19.0 claimed a personal-WeChat voice bubble, and that is not deliverable.** The claim was wrong and
  is withdrawn. Three pieces of evidence, gathered rather than assumed:
  - **Tencent's own** OpenClaw WeChat channel (`@tencent-weixin/openclaw-weixin` 2.4.10, tarball hash verified)
    contains **zero** occurrences of the `VOICE` upload/send type - it sends image, video and file only, and uses
    `silk-wasm` solely to **decode incoming** voice;
  - the equivalent issue in another implementation (`NousResearch/hermes-agent#9971`) is still open and labelled
    **`blocked`**;
  - two live attempts here - mp3 inside an open conversation window, then SILK with `playtime` - were each accepted
    by the API and then dropped by the client.
  `voiceDeliveryFor()` therefore sends audio as a **file** on personal WeChat (it arrives and it plays; verified),
  and the tool says so instead of promising a bubble. What was already true stays true: WeCom really does show a voice
  bubble, verified by ear.
- **The vendored codec now earns its place in the other direction.** An incoming voice message is SILK, which nothing
  on a normal machine can play, so it is decoded to a **playable WAV** in the inbox (`silkToWav()`, with a pure
  `pcmToWav()` header writer), falling back to the raw `.silk` when decoding fails - exactly the use Tencent's own
  channel makes of the same module. `counters.voiceDecoded` records it.
- 286 tests across 19 suites, including a SILK round trip (encode, then decode back to a WAV whose header is asserted)
  and the corrected delivery rule.

## 0.19.0

- **Personal WeChat can now send a real voice bubble.** A WeChat voice bubble requires Tencent's **SILK** codec and
  ffmpeg cannot encode SILK, so until now the audio went as a file. The plugin now carries a SILK encoder:
  [`silk-wasm`](https://www.npmjs.com/package/silk-wasm) 3.7.1 (**MIT**) is vendored under `vendor/silk-wasm/` -
  bundle, `silk.wasm`, upstream `LICENSE` and a `README.md` recording the registry hash the download was verified
  against (`sha512-mXPwLRtZxrYV3TZx41jMAeKc80wvmyrcXIcs8HctFxK15Ahz2OJQENYhNgEPeCEOdI6Mbx1NxQsqxzwc3DKerw==`) - and
  recorded in `THIRD-PARTY.md`. Vendored rather than declared as a dependency, because this plugin is installed as a
  directory and `npm install` never runs.
- `voice.js` gained a `silk` format: SAPI speaks into a WAV, ffmpeg resamples it to 24 kHz mono, and the vendored
  encoder produces `#!SILK_V3`. `voiceSupport()` reports `silk` separately, and `wechat_send_voice` now
  **defaults to SILK** when the encoder is present, falling back to mp3 - which the delivery rule sends as a file that
  still plays - when it is not.
- The rule itself is unchanged and now usually resolves to a bubble: `voiceDeliveryFor()` still promises a bubble
  only where the platform can decode it.
- 284 tests across 19 suites, including a real SILK round trip (header `#!SILK_V3`) and a test that the vendored
  encoder's provenance is recorded.

## 0.18.4

- **Documentation only: the README no longer over-promises a personal-WeChat voice bubble.** It said
  `wechat_send_voice` "sends a voice message through personal WeChat", while the truth - a bubble needs SILK, which
  ffmpeg cannot encode and this plugin does not bundle - meant the audio actually arrives as a **file**. The README now
  carries the rule (oiceDeliveryFor()): a bubble on WeCom (amr, verified by ear) and for a genuine `.silk` file on
  WeChat; an **audio file** for anything else, which arrives and plays. The same rule was already in v0.18.3's
  changelog and release notes; this release puts it where a reader actually starts.
- Also fixed in the same file: a missing blank line before the Diagnostics heading, which had glued two sections
  together.
- No code changed. 280 tests across 19 suites still pass, and the three copies (working copy / release / installed)
  are byte-identical again after the drift this replaces.

## 0.18.3

- **A personal-WeChat voice message no longer disappears.** Two things were wrong, and both are now settled by
  evidence rather than guesswork:
  - the voice item never carried `playtime` (the duration in seconds that iLink requires); it is now read from the
    finished file with `ffprobe` and sent as `voice_item.playtime`;
  - **WeChat only renders a voice *bubble* for SILK**, and ffmpeg cannot encode SILK at all - so an mp3/amr/wav item
    is accepted by the API and then dropped by the client. That is the published finding of an independent
    implementation with the identical symptom (`NousResearch/hermes-agent` issue #9971, which also names
    `playtime` and SILK as the requirements).
- **The rule is now explicit instead of hopeful** (`voiceDeliveryFor()`): a bubble is only attempted where the
  platform can decode it - WeCom (AMR, verified by ear) and a genuine `.silk` file on WeChat. Anything else on
  personal WeChat is delivered as an **audio file**, which arrives and plays, and the tool says so in its reply
  rather than reporting a success that never arrived.
- 280 tests across 19 suites.

## 0.18.2

- **Fixed: every personal-WeChat send was missing the conversation's `context_token`, so the platform accepted
  the message and then dropped it.** The token was already being saved on every inbound message
  (`state.saveContextToken`) and the send helpers already accepted it - it was simply **never read back**
  (`loadContextTokens` appeared only in `state.js`). `contextTokenFor()` now loads it for the target chat and all
  three send paths use it: text, media (image/video/file) and voice.
  - What this looked like from outside: the tool reported `✅ sent` and **nothing arrived** - for plain text just as
    much as for a voice message, which is exactly the control that ruled the audio format out and pointed at the send
    entry itself.
  - It is the same shape of lesson as the WeCom `846605` one: **a success from the platform's API is not a
    delivery.** Only the receiving end can say that.
- A guard test asserts that each send path carries the token, so this cannot silently regress.
- 278 tests across 19 suites.

## 0.18.1

- **A send failure now says what to do about it.** iLink answers with a bare code - `sendMessage ret=-2
  errmsg=prepare failed` - which tells a user nothing. `explainSendFailure()` turns the documented codes into one
  actionable sentence and the thrown error carries it: `-2 prepare failed` becomes *"the WeChat conversation window
  is closed: iLink sends only with a fresh context token from a recent inbound message, so ask them to write to the
  bot first"*, `-2 unknown error` and `-14` become *"needs a new QR scan"*, `-3` says the request itself was
  rejected (which means the window is open), and an unrecognised code explains **nothing** rather than guessing.
- This came out of trying to verify the personal-WeChat voice path: the send was refused, and a control experiment -
  sending *text* to the same chat - failed with the identical code, proving it was the closed conversation window
  rather than the audio format. WeCom's long connection has no such window, which is why the same voice message sent
  there cold works.
- 277 tests across 19 suites.

## 0.18.0

- **Voice messages can now be sent, and are spoken here.** Two tools - `wechat_send_voice` (personal WeChat,
  iLink's VOICE media type) and `wecom_send_voice` (WeCom, uploaded over the long connection or the app) - take
  either `text`, which is **synthesized on this machine**, or `path` to an audio file. New `voice.js` does the
  speaking: the system's own engine (SAPI through `System.Speech` on Windows) writes a WAV and `ffmpeg` converts
  it to a chat format (`mp3` default, `amr` which is what WeCom specifies, or `wav`). **No cloud service and no
  key**: nothing leaves the machine. A missing piece is named (`windows speech (System.Speech)` / `ffmpeg`)
  instead of failing quietly, and the text is passed as a PowerShell *single-quoted literal* with every `'` doubled -
  that property has its own tests, because it is the one place this feature could be dangerous.
- **Understanding voice is now explicit.** Both platforms transcribe voice themselves and that transcript reaches the
  model, but it used to arrive bare - so a transcript looked like something the user typed. It is now labelled
  (`[微信语音（平台转写）] …` / `[企业微信语音（平台转写）] …`), and a voice message the platform could not
  transcribe says so. Personal WeChat's audio is still saved raw as `.silk`, which is what the protocol provides.
- Both voice tools count as delivery tools, so a spoken answer is not repeated as text.
- 276 tests across 19 suites.

## 0.17.0

- **The v0.16.0 fallback could not work, and the trace finally said why.** With the closing frame
  acknowledged, the live run reported `finalizeFailed: 6, fallback: 2` and `lastFinalizeError: WeCom bot
  846605 - invalid req_id`: **every** closing frame was refused, for the command reply as well as the answer -
  so this was never about a slow turn. Two corrections:
  - **The fallback now uses the proactive path** (`aibot_send_msg` via `sendMessage`), which needs no reply id
    at all. v0.16.0's "fallback" re-sent the same passive reply that had just been refused, which could not
    possibly work - a fallback that shares the failure mode of the thing it falls back from is not a fallback.
  - **A dead reply id is no longer retried.** `846605` (`invalid req_id`) means the correlation id is gone -
    expired, or bound to a socket session that has ended - so the code stops retrying and goes straight to the
    proactive send; `6000` (`more than one caller at the same time`) is a transient race and is still retried
    with the 250/500/750 ms backoff. `isStaleReplyError` is the one place that decides, with its own tests.
- `/state.stream.finalizeErrors` keeps the last few closing-frame failures **in order**: the sequence says more
  than the last one, and the sequence is what identified this bug.
- 267 tests across 18 suites.

## 0.16.0

- **Fixed the streamed answer that shrank to its opening characters once the chat was reopened.** Live it looked
  right; in the chat history only the first fragment remained. Two defects, both in how the stream is *closed*:
  - **The closing frame was fire-and-forget**, so a refusal by the platform was invisible. WeCom refuses the closing
    frame with `errcode 6000` ("more than one caller at the same time") when it races the last preview, and a stream
    that never closes is what leaves an early fragment in the history. The closing frame now goes through the bot's
    acknowledged `replyAndWait` path, is retried with a 250/500/750 ms backoff, and reports itself in
    `/state.stream` as `finalized` / `finalizeFailed` / `lastFinalizeError`. If every attempt is refused, the
    answer is delivered as its own message (`counters.streamFallback`) rather than leaving the fragment behind.
  - **The first preview could be two characters.** The flush throttle measured time from the streamer's *creation* -
    before the model had produced anything - so the first delta arrived "600 ms late" and opened the bubble at once.
    The clock now starts at the first delta, and the first preview waits for at least 16 characters.
- The tool-answered path closes its stream through the same acknowledged helper instead of a bare send.
- Protocol notes that came out of an independent implementation (`NousResearch/hermes-agent`): one `stream_id`
  per answer, `content` is the **full accumulated text** rather than a delta, intermediate frames are fire-and-forget
  because the platform does not answer each one - and the closing frame races the previous one, which is exactly why
  it has to be acknowledged.
- 266 tests across 18 suites.

## 0.15.0

- **Formulas become text a person can read.** `\$\$\frac{a}{b}\$\$` used to arrive as noise with the delimiters removed
  and the backslashes left behind. The math is now rendered: `\frac{a}{b}` -> `a/b` (compound parts keep brackets:
  `(x+1)/(y-2)`), `\sqrt{x^2+y^2}` -> `√(x²+y²)`, `x^2` -> `x²`, `a_1` -> `a₁`,
  `\sum_{i=1}^{n}` -> `Σᵢ₌₁ⁿ`, `\int_0^1` -> `∫₀¹`, `\alpha + \beta \times \gamma` -> `α + β × γ`,
  `\le`/`\ne` -> `≤`/`≠`, `90^\circ` -> `90°`, `\text{cm}` -> `cm`. Fractions resolve repeatedly
  (a `\frac` inside a `\frac` still comes out right), a subscript or exponent whose characters all have Unicode
  forms loses its brackets while the others keep them (`a^{n+1}` -> `aⁿ⁺¹` but `e^{i\pi}` -> `e^(iπ)`), and an
  unknown command keeps its name instead of a stray backslash.
- **A two-column table reads as labelled lines**: `| 条件 | 说明 |` rows become `· 条件：说明` instead of two words
  with whitespace between them; wider tables keep their spacing, still marked as a row.
- **A Windows path is never treated as LaTeX** - the one way this could do real damage. The math pass runs only inside
  math delimiters, so `C:\Users\Administrator\.dsh\plugins`, `my_file_name.txt`, a bare `\d+` and a `\frac`
  outside delimiters all survive byte-for-byte. Asserted explicitly.
- Fixed while testing: the fallback bracket form (`^(...)`) had one of its own brackets eaten by the single-character
  exponent rule, so `e^{i\pi}` came out as `e⁽iπ)`.
- 264 tests across 18 suites.

## 0.14.0

- **New: outbound text cleaning.** WeChat and WeCom render no markdown at all, so `**bold**` arrived with its
  asterisks, `## heading` with its hashes and `\$\^2\$\$` with the dollars. Everything that leaves for a chat now
  goes through `toPlainText` (`plain-text.js`): emphasis markers, heading hashes, code fences, block-quote
  markers, table separator rows, math delimiters, reasoning tags and HTML tags are removed, links become
  `label（url）`, bullets become a middot, and images are dropped. **An ordinary sentence comes out byte-for-byte
  identical** - the property with the most tests behind it, because a sanitiser that rewrites prose is worse than
  none.
- A switch, not a fait accompli: `/format plain|raw` (alias `/格式`, also accepting 清洗/原样), a **Text** menu on
  the card, a `format` field on the prefs route (validated), and a line in `/status`. `plain` is the default,
  `raw` sends the model's markdown untouched. The live preview is cleaned on every flush, so a marker split across
  two frames cannot leak.
- **Fixed a flaky test that could have failed a release for no reason.** `test/wecom-media.test.mjs` asserted that a
  wrong key throws - but with a random key the PKCS#7 check passes roughly **1 time in 256**, so it failed
  intermittently (it did, once, during this work). The deterministic property is now asserted instead: a wrong key
  must **never reveal the plaintext**, tried against 24 fresh keys, plus deterministic damage cases (truncated
  ciphertext, empty input).
- Suite: 261 tests across 18 suites.

## 0.13.5

- **Fixed the duplicate the user saw on v0.13.4: the live preview and the final answer used different
  `req_id`s.** To the platform those are two messages - a preview that is never finished, plus the answer - so a
  streamed reply arrived twice, the first copy frozen mid-sentence. `wecomStreamer` now registers its `req_id` for
  the inbound frame (`liveFrames`), and `replyWecomInParts` looks it up and sends the **first** part on that same
  id, which is what closes the stream. Later parts of an over-long answer still get their own ids, because one stream
  body holds 20480 bytes and reusing one id would replace instead of append.
- Every reply path now closes the stream, so no half-finished preview can be left behind: the answer, the error
  notice and the empty-turn notice all go through `replyWecomInParts`, and the one path that replies through a
  **tool** instead (`outcome.deliveredByTool`) calls `closeLiveStream(frame)` explicitly.
- `/delivery` was switched back to `whole` while this was being fixed; streaming stays opt-in and is safe to
  re-enable with `/delivery stream`.
- 247 tests across 17 suites.

## 0.13.4

- **Found why no streaming preview ever appeared: the live frames were being discarded by shape.** The adapter's
  bare `{ type: "text-delta", text }` is not the shape that arrives once the harness has batched the stream for the
  session record - it arrives as `{ type: "chunk", chunk: { type: "text-delta", text } }` and as
  `{ type: "text-chunks", texts: [...] }` (both visible in the stored `assistant/message.stream`). The collector
  accepted only the bare shape, and counted frames *after* the filter, so "frames arrive in a shape we do not know"
  and "no frames arrive at all" left exactly the same evidence (`deltas: 0`). `liveTextOf()` now reads every
  shape - never a reasoning one, which must not reach a chat - and every frame is counted before any decision to
  display it.
- Two facts came out of the same investigation and are worth keeping: the harness **does** stream (the session's own
  `assistant/message.stream` holds `text-chunks` with per-delta texts, inter-arrival `dt` and a `time0`), and
  v0.12.0's `setApprovalPolicy(session, "ask")` really took effect (`approval/policy` appears in the session's
  events).
- 246 tests across 17 suites.

## 0.13.3

- **Correction: v0.13.2 was published with red guards, and this release fixes them.** The two-channel diagnostic
  changed the collector callback's signature (`onDelta` also reports the frame's shape) and lengthened the collector
  wiring, which pushed three fixed-width slices in the tests past the lines they assert on. The slices and the
  signature expectation were updated; the suite is green again at 245.
- Recorded as a process failure rather than a quiet fix: the publish ran in the same command as the test run, and the
  `FAIL` lines went past unread. Publishing now happens only when the suite reports zero failures.

## 0.13.2

- **Streaming diagnostics now watch both channels.** The adapter provably emits `type: "text-delta"` with a `text` field (`dsh-llm-deepseek/lib/index.js`), so the filter is not the problem; either the frames never reach a plugin listener, or live text travels as a **session event** that this collector was silently ignoring. The collector now:
  - accepts a delta-shaped session event (never a reasoning one) and feeds it to the streamer, so streaming starts working if that is where the text is;
  - records every event type it does not handle in a bounded ring, exposed as `/state.stream.unknownEvents` - so a live-text event under an unknown name becomes visible instead of vanishing.
- `/state.stream` also reports the current `delivery` mode next to `deltas`/`chunks`/`refused`/`lastFrame`.
- 245 tests across 17 suites.

## 0.13.1

- **The streaming preview still does not appear, and this release makes that diagnosable instead of mysterious.**
  Measured live on v0.13.0: `/delivery stream` ran a turn in 4543 ms and `counters.streamChunks` stayed 0, while
  `/delivery whole` correctly sent nothing extra - so the mode gating works, but no preview frame is produced. The
  newest session transcript contains **no incremental event at all** (`assistant/message` carries a `stream`
  field written when the step settles), which rules out sourcing deltas from `session/event`; the live source has to
  be the harness's `agent/assistant-stream` frame, and whether those frames reach a plugin listener is exactly what
  was unproven.
- `/state.stream` now reports `{ deltas, chunks, refused, lastFrame }`: deltas seen from the adapter, previews
  actually sent, previews the streamer refused (an over-long preview or an unwritable socket), and the shape of the
  last frame received. The next run says in one line where the chain stops - no more guessing.
- `splitForStream`'s body limit (20480 bytes) was verified not to be the cause: a 24-character preview is a single
  part, so the "skip rather than truncate" guard cannot be swallowing every preview.
- 245 tests across 17 suites.

## 0.13.0

- **New: delivery mode - whole answers or word by word.** A menu in the card and `/delivery whole|stream` in the
  chat (`/发送方式`, also accepting 整段/逐字).
  - **整段 whole** *(default)*: the finished answer, sent once - what every earlier release did.
  - **逐字 stream**: the answer **as it is written**. WeCom's `stream` message is incremental, so the plugin sends
    the accumulating text repeatedly with `finish: false` on one `req_id`, and the existing final send (which
    carries the whole answer) closes it with `finish: true`. The adapter's live deltas come from the harness's
    `agent/assistant-stream` frames.
  - **Personal WeChat is deliberately unchanged**: it has no way to edit a message already sent, so it keeps
    receiving whole answers, and both the card hint and the command reply say exactly that instead of leaving the
    option looking broken.
- Deltas are throttled to roughly 24 characters or 600 ms (`shouldFlush`, a pure function with its own tests)
  because a message per token would be absurd, and a preview that would no longer fit one stream body is **skipped
  rather than truncated** - so the invariant "a reply is never cut to its first part" still holds for the answer
  that matters. `counters.streamChunks` counts the previews, and `/status` shows the mode.
- 245 tests across 17 suites.

## 0.12.0

- **完全权限 now really grants: the plugin approves without asking.** It used to hand the request to the GUI, which could still refuse it - not what the level says. This plugin *is* an answerer, so it returns `allowed-once` on the spot. The session is put on the `ask` approval policy when it is opened, because with DSH's own `never` policy a request is rejected before any answerer is consulted and the level could never decide.
- **Corrected understanding, recorded in the code**: DSH's `APPROVAL_POLICIES` are `["ask", "never"]`, and `never` means *actions that require approval are rejected automatically* - it is not a "allow everything" switch. What makes an action need approval at all is the session's file sandbox (`read-only` / `workspace-write` / `danger-full-access`). The mapping is therefore: 严格/适中 ask in the chat (silence = no / GUI), 完全权限 grants on the spot, 仅查看 refuses on the spot.
- **The approval self-test can ask through the WeCom long connection.** It demanded a WeChat account with a usable token, so on a bot-only setup it failed at the channel level (`sendMessage ret=-3`, measured live) and could not verify anything. It now picks whichever channel can reach the chat and says which one it used.
- 242 tests across 17 suites.

## 0.11.1

- **The approval self-test now obeys the authorization level.** It used to send the prompt no matter what, which
  contradicted the setting it sits beside: with 仅查看 a request is refused without asking, and with 完全权限
  this plugin never asks, so a self-test that prompted anyway was the one code path that could be mistaken for
  proof of the level's behaviour. It now reports *which level skipped it* (skipped: "readonly" | "full") and
  records the refusal as an outcome instead of sending anything.
- A wiring guard asserts the route reads the level and refuses/skips when the level does not ask.
- 242 tests across 17 suites.

## 0.11.0

- **New: four authorization levels for approvals** - a menu in the card's authorization area and `/auth` in the
  chat (`/授权` too), with Chinese level names accepted: `/auth 严格|适中|完全权限|仅查看`.
  - **严格 `strict`**: every approval is asked in the chat, and **silence means no** - it never silently falls
    back to the GUI.
  - **适中 `moderate`** *(default)*: ask in the chat, and if nobody answers the GUI takes over. Exactly the
    behaviour of every earlier release.
  - **完全权限 `full`**: never ask here; approvals stay with DSH (with a session policy that asks nothing, that
    means actions proceed).
  - **仅查看 `readonly`**: ask nobody and **refuse** whatever needs an approval (fail closed).
- **What a plugin can and cannot do is stated, not implied.** DSH's own session policy - the file sandbox
  (`read-only` / `workspace-write` / `danger-full-access`) and whether approvals are asked at all - belongs to
  the DSH client; a plugin only decides what to do with a request it receives. With a session policy that never
  asks, `仅查看` has nothing to refuse, and the card, `/auth` and the README all say so instead of implying a
  guarantee the plugin cannot make.
- An unknown level falls back to `moderate`, never to `full` (failing open on a typo is how a permission switch
  becomes a hole), and the level is read per request, so `/auth` applies immediately without a restart.
- 241 tests across 17 suites.

## 0.10.0

- **New: interjection (插话) - a message sent while the agent is answering can join that turn.** A switch on the
  card and `/interject on|off` in the chat (alias `/插话`). With it **on**, an inbound message is handed to the
  running turn with the harness's own `agent.steer()`, so it lands in that turn's `next-step` inbox and the model
  sees it at its next step; with it **off** (the default, and what every existing chat does) the message queues
  as its own turn via `agent.followup()`. It only steers when a turn really is in flight for that chat and a live
  agent exists to steer - otherwise the message queues, because "interject" must never mean "dropped". `/status`
  reports the switch and how many messages have been interjected (`counters.interjected`).
- **Fixed a latent reply-loss bug the feature made routine: the collector kept one waiter per session.** A second
  message arriving while the first was still being answered *replaced* the pending record, so the first reply
  could never be relayed and the replacement was settled by the wrong turn. Waiters are now a **queue per
  session**, matched to the turn that was claimed for their message, and a turn nobody asked for no longer
  consumes a waiter. Covered by a new `test/collector.test.mjs` (five cases, including the delivery-tool flag
  reaching every waiter of a turn and a throwing usage callback not taking a reply down with it).
- The counter `counters.interjected`, the `/status` line and the card's note make the switch's effect visible;
  the plain control panel accepts `interject` beside `friendOnly`.
- 235 tests across 17 suites.

## 0.9.4

- **Fixed: the WeCom debug route reported the wrong session id.** `GET /dsh-wechat-media/wecom/inbound-test`
  echoed `sessionIdFor(accountId, chatId)` - the **generation-0** id - while the router runs the chat on the
  generation its `/new` history left it on. A chat restarted with `/new` therefore answered with an id no
  longer in use, which sent this session's own diagnosis chasing a transcript that had been idle for hours.
  The echo now resolves the generation exactly like `ensureAgent` does and reports `generation` alongside the
  id. (The personal-WeChat route was already correct: it echoes the stored route entry, which carries the real
  id.) A wiring guard keeps both honest.
- 225 tests across 16 suites.

## 0.9.3

- **Fixed a lost update: token-ledger writes are now serialised.** Reconciling the ledger against the session
  transcript found six `assistant/message` calls on disk and only five in the ledger - one turn's 8651 tokens
  (267 in / 64 out / 8320 cached) had silently vanished. `addTokens` is called fire-and-forget from the
  collector and every call is a read-modify-write of `tokens.json`, so two overlapping cycles lose the earlier
  one; a turn that reports several model calls, or two turns close together, is all it takes. All three ledger
  writers now run through one chain, and a test fires **twenty concurrent** accounting writes and insists all
  twenty survive - counters, cache and per-chat rows alike.
- **A failed accounting write can no longer hide**: `/state.tokenAccountingError` records it (with the account
  and chat it belonged to), beside `inboundError`, and clears on the next successful write. Accounting stays
  fire-and-forget so a slow disk cannot delay a reply - but "counted nothing" and "failed to count" are now
  distinguishable.
- The acceptance test for this feature is the reconciliation itself: the sum of the `usage` in the session
  transcript must equal the ledger. That is what caught both this and the two arithmetic bugs before it.
- 224 tests across 16 suites.

## 0.9.2

- **Fixed the second-order version of the same mistake: the total is now derived from the parts, never stored
  beside them.** The next live turn after v0.9.1 reported `total 8548` against parts that added up to `17013`:
  the row had been written by v0.9.0 (parts, no total), was *displayed* by falling back to its parts, and then a
  v0.9.1 call added its own total to a field that had never been filled in - so the stored total covered only
  the newer call while the parts covered both. `totalTokens` is now computed as
  `input + output + cacheRead + cacheWrite` on every read, the way the harness computes it, which makes "the
  parts add up to the total" true by construction. A stale stored total from the affected versions is dropped
  when the row is next written.
- **An adapter whose own total disagrees with its parts is now reported** (`usageDisagreement`), so a provider
  with a different convention shows up in the log instead of silently changing what the number means.
- The regression test reproduces the live case with the measured figures - a legacy row continued by a new
  call - and asserts the invariant that had broken.
- 223 tests across 16 suites.

## 0.9.1

- **Fixed: token totals understated the real spend by up to four times.** The first live turn reported
  `inputTokens: 2191`, `outputTokens: 2` and `cacheReadTokens: 6272` - and the plugin summed only input and
  output, printing `共 2.2k` for a turn that really cost **8.5k**. Cached prompt tokens are *not* part of
  `inputTokens` for these adapters; the harness computes its own total as
  `input + output + cacheRead + cacheWrite` (`@deepseek-ai/dsh-llm-deepseek`, `lib/index.js`), which is now
  what the ledger stores per call and what every view prints. An adapter that reports its own `totalTokens`
  still wins.
- The displayed parts now **add up to the total** (`共 8.5k（输入 2.2k / 输出 2 / 缓存命中 6.3k）`), on the card,
  in `/tokens` and in the `/status` line, and the per-chat rows carry the same total.
- The regression test uses the measured numbers, so the definition cannot drift again: it asserts both that
  the total includes the cache and that the parts sum to it.
- 222 tests across 16 suites.

## 0.9.0

- **Per-account token accounting.** The bridge now records what each WeChat/WeCom account spends, per **model
  call**, from the `usage` the harness reports on the `assistant/message` session event (the numbers the model
  adapter returned - nothing is estimated): input, output, cached and reasoning tokens plus a call count, per
  account and per chat inside it, in `$DSH_HOME/dsh-wechat-media/tokens.json`. Only counters are stored; no
  prompt and no reply ever lands in that file.
- **A self-clearing window of 1 to 30 days** (default 30). The reset is applied lazily whenever the ledger is
  read or written, so a host that was switched off for a week opens a fresh window instead of reporting a stale
  one - and `resets`/`lastResetAt` only move when there was something to zero, so the numbers never claim a
  reset that did not happen.
- **Three ways to look at it**: the card's new **Token usage** section (one row per account, a window picker of
  1/3/7/14/30 days and *Clear now*), `/tokens` in a chat (`/tokens reset`, `/tokens 7` - clamped to 1..30 with
  an honest message when it has to clamp), and one line inside `/status`. The card and the command drive the
  same file through the same route, so they cannot disagree.
- New module `tokens.js` (pure: window arithmetic, accumulation, formatting) with 14 of its own tests, and a
  wiring guard that fails if the collector stops feeding usage or if the snapshot loses the ledger.
- 222 tests across 16 suites.

## 0.8.1

- **The WeCom debug route can now synthesise a group message.** `GET /dsh-wechat-media/wecom/inbound-test?chatId=…&text=…&chatType=group`
  pushes a callback with `chattype: "group"` through the **real** inbound path (allowlist, friends-only, `/commands`,
  media, the agent) and echoes the `chatType` it used in its JSON answer; it defaults to `single` as before. This
  exists because the group-only rules are otherwise untestable against the live platform without a second person in
  a real group - which is exactly the gap the "only answer friends" switch left behind. The README's diagnostics
  section documents both debug routes, and a wiring guard keeps the parameter from quietly disappearing.
- 203 tests across 15 suites.

## 0.8.0

- **New: "Only answer friends" / 只处理好友私聊.** A second checkbox on the card (and `/friends on|off`, with
  `/friend` and `/好友` as aliases) makes the bridge serve **1:1 chats only**: every group message is dropped,
  whatever the allowlist says about that group, in personal WeChat and in WeCom alike. The protocol carries no
  "is a friend" flag, so *friends* means direct chats, and that is what the docs and the code say.
  - **Off by default** - an upgrade must not change who the bot answers.
  - Group messages are ignored **silently** (that is the point) but never invisibly: each one bumps
    `counters.groupsSkipped`, `/status` prints `已静默忽略群消息 N 条`, and the card shows the same number.
  - One preference in `prefs.json`, so the checkbox and the command cannot disagree; the prefs routes (card JSON
    API and the plain panel) both accept `friendOnly`.
  - Switching it on from inside a group answers once there to explain the coming silence, because the next
    message from that group would get no reply at all. Turning it off has to come from a 1:1 chat or the card -
    a group message is skipped before it can be read as a command, which is the honest consequence of "silent".
- The rule is applied in `classifyInbound` / `classifyWecomInbound` **before** the allowlist (an allowlisted
  group is still skipped) and before approval answers are consumed, so the switch cannot look broken in the
  panel it is configured from. Both paths are covered by tests, as is the card, the prefs routes and `/friends`.
- 202 tests across 15 suites.

## 0.7.1

- **Fixed a silent truncation on every WeCom reply path.** One `stream` body holds 20480 *bytes*, so a longer
  answer has to be split - and three call sites sent only the first part, dropping the rest without a trace.
  All of them (the command answer, the agent's reply, the error notice, the empty-turn notice) now go through
  one `replyWecomInParts` helper that sends every part and raises when the socket cannot be written, so a
  dropped reply is no longer indistinguishable from a delivered one. Found while reviewing the `/help` answer,
  which fits in one part: the bug was waiting for the first long answer.
- **The personal-WeChat error notice is chunked instead of sliced.** `❌ agent 出错：…` used to be cut at 2000
  characters and its delivery failure was swallowed; it is now chunked like every other reply, and a failure to
  deliver it is logged.
- `test/wiring.test.mjs` grew a guard for the whole class: no reply path may send `splitForStream(...)[0]`, the
  WeChat error notice may not be sliced, and the helper must have exactly its four call sites. 193 tests.

## 0.7.0

- **Chat commands.** A message that starts with `/` is now handled by the bridge instead of being
  forwarded to the agent: `/help` (`/h`, `/?`, `/帮助`), `/status` (`/状态`), `/new` (`/reset`, `/新会话`) and
  `/stop` (`/cancel`, `/停止`). An unknown command answers with the list rather than guessing, a bare `/` and
  `//` stay ordinary messages, and both transports dispatch *after* the allowlist decision, so a blocked
  chat cannot run commands either. Every command is counted (`counters.commands`) and appears in
  `/state.recentRoutes`.
- **`/new` really starts a new conversation.** A chat's session id now carries a *generation*: the route
  table remembers it, so it survives a restart, and resuming the previous history is impossible by
  construction. `/new` disposes the live agent, forgets the in-memory conversation and answers with which
  segment the chat is on; the old transcript stays on disk. Generation 0 hashes exactly what 0.6.0 hashed,
  so conversations that exist today keep resolving to their session.
- **`/stop` interrupts the turn running in this chat's session** - and says so honestly when there is
  nothing running, or when the session has no live agent yet. The cancellation carries a readable cause, so
  both reply paths report a stop the user asked for instead of an agent failure.
- **`/status`** answers with the transport, account, chat, DSH session id (and the `/new` generation), the
  WeCom long connection's state *including its last error*, the counters, how many approvals are waiting,
  the last inbound time and the media directory - the same facts `/state` exposes, without opening the GUI.
- **Fixed: the personal-WeChat media loop never touched the counters.** A failed WeChat download was only
  visible in the transcript, and `counters.mediaDownloaded`/`mediaFailed` only ever moved for WeCom. Both
  transports now count saved/failed media and the bytes they add up to, which is what `/status` prints.
- 192 tests across 15 suites (`test/commands.test.mjs` is new; `session.test.mjs` covers the generations,
  and `wiring.test.mjs` checks that both inbound paths dispatch commands and that `/new` and `/stop` are
  wired to the pieces they claim to use).

## 0.6.0

- **WeCom media now travels both ways.** `wecom_send_file` can upload a local file as a temporary WeCom asset and
  send it as image / file / voice / video over the intelligent-robot **long connection** - no corpid/corpsecret/
  agentid needed, which is what makes the tool work on a bot-only setup. The three-step handshake is the official
  one (`@wecom/aibot-node-sdk` v1.0.7, `client.ts`): `aibot_upload_media_init` (`type`, `filename`, `total_size`,
  `total_chunks`, `md5`) -> one `aibot_upload_media_chunk` per 512 KiB slice, base64 - up to 100 chunks (~50 MB),
  sent with the same bounded concurrency the SDK uses because the platform answers `system error` to a burst, each
  chunk retried twice -> `aibot_upload_media_finish` -> `media_id` -> `aibot_send_msg` (or `aibot_respond_msg` for a
  passive reply) with the media body. Path preference is now long connection -> self-built app -> group-robot webhook
  (images only), and a failure is reported to the caller instead of being swallowed.
- **Fixed the request/response correlation the upload depends on.** The client matched answers through a guessed
  `headers.reply_to`, which the platform never sends back for our own commands; it now matches the `req_id` we
  invent, exactly as the SDK does. New `WecomBot#request()` rejects on a non-zero `errcode`, on a socket that is not
  writable, and on silence after a timeout - so `uploadMedia` can actually obtain its `upload_id` and `media_id`.
- **Fixed two awaited timers that were `unref()`ed** (the request timeout and the chunk-retry backoff). An unref'd
  timer is not guaranteed to fire once nothing else keeps the event loop alive, so a request could hang forever
  instead of timing out and a scheduled retry could never happen. A test that awaited them in isolation found it.
- `test/wecom-bot.test.mjs` grew to 18 tests: the whole upload handshake against a fake server (frame shapes, the
  md5 the platform checks, chunks reassembling to the file byte for byte, the 100-chunk cap, a refused chunk being
  retried, a chunk that never succeeds, and the media reply/send bodies), plus the three failure modes of `request`.
  176 tests total.

## 0.5.0

- **WeCom images, files and videos are downloaded and decrypted now.** Until this release an inbound WeCom
  attachment only reached the model as a label (`[企业微信图片：暂未下载（媒体支持待补）]`), because the long
  connection's scheme is not the one the personal-WeChat side already had. It is implemented in the new
  `wecom-media.js` from the official SDK's own code (`@wecom/aibot-node-sdk` v1.0.7, `src/crypto.ts` +
  `src/api.ts`), not from guesswork:
  - the payload's `aeskey` is **base64 of a 32-byte key**, and the bytes are **AES-256-CBC** with `iv = key[0..16]`
    - *not* the iLink scheme (AES-128-ECB with a base64 32-hex-character key) that a reader of `ilink.js` would
    naturally reach for;
  - WeCom pads PKCS#7 to a **32**-byte multiple, so Node's own padding removal (16-byte blocks) throws `bad decrypt`
    on payloads whose length is a multiple of 16: `setAutoPadding(false)` plus manual removal is required;
  - the file name can only come from `Content-Disposition` (`filename*=UTF-8''…` first, then `filename=`), because the
    payload carries none, and the real type is then settled by magic bytes.
  Downloaded files land in the same inbox layout as the WeChat side (`$DSH_HOME/wechat-inbox/<date>/<chat>/`), honour
  the same `maxMediaMiB` cap, and reach the model as a path plus a `[企业微信图片] …用 read_image 查看` hint. A failed
  download says why (`[企业微信图片未保存] …`) instead of pretending no attachment was sent, and
  `counters.mediaDownloaded` / `counters.mediaFailed` make both countable from `/state`.
- **Two inbound shapes that were dropped silently are handled**: 图文混排 (`mixed.msg_item`) - a text message *with* an
  image - carried neither text nor media to the plugin and was counted as `unusable`, and media the user **quoted**
  (`quote.image` / `quote.file` / `quote.video`) was ignored entirely. Both are collected now; quoted *text* stays out
  of the prompt, as on the WeChat side.
- `media.js`'s `saveInboundMedia` drives either transport (`download` + `kind`, not just `ilink`), and
  `describeForModel` names the app the media came from. New suite `test/wecom-media.test.mjs` (11 tests) pins the
  cipher against a locally encrypted payload - including the 32-byte padding boundary - plus the file-name rules, the
  size cap and every failure message. 169 tests total.
- **Verified against real messages** before release, not only against the fixtures above: a 2880×2160 JPEG (1.05 MB)
  arrived as a readable image (the model opened it with `read_image` and transcribed the slide in it), and a document
  sent as `大学生心理健康教育活动方案.zip` kept its Chinese name through the RFC 5987 `filename*=UTF-8''…` branch and
  unzipped cleanly. Counters after both: `mediaDownloaded=2 mediaFailed=0`.

## 0.4.0

- **Fixed: every chat of a WeCom bot shared one DSH conversation.** `sessionIdFor()` kept the first 40 base64url
  characters of `${accountId}\0${chatId}` - about 30 bytes - while a WeCom pseudo account id (`wecom:` + BotID) is 41
  characters on its own, so the chat id never entered the digest: a direct message, a work group and a debug chat all
  resolved to the *same* session, with one shared context, and each of their route entries pointing at it. Measured
  live before the fix (four different chat ids → one id); two personal-WeChat chats whose ids share a long prefix
  could merge the same way. The id is now a SHA-256 over the full identity (`wechat-` + 32 url-safe characters):
  stable across restarts, 192 bits, still short enough to be a directory name. Sessions created under the old rule are
  orphaned, and each chat opens a fresh conversation on its next message.
- **Fixed: the WeCom bot received messages and then never answered.** `index.js` sent every long-connection reply
  through `wecom.streamBody(...)`, `wecom.generateReqId(...)`, `wecom.splitForStream(...)` and
  `wecom.markdownBody(...)` - but those four helpers live in **wecom-bot.js**, not in wecom.js, so each call was a
  `TypeError` raised inside the reply's own try/catch: logged nothing useful, delivered nothing, and the chat simply
  stayed silent. The proactive long-connection send (`wecom_send_text`, and the test button on the WeCom page) failed
  the same way. The helpers are now imported from the module that owns them, and `test/wiring.test.mjs` cross-checks
  every `namespace.name(...)` call in the host against the exports of the module that namespace came from - the class
  of bug, not just this instance.
- **A send that did not happen is no longer reported as success.** `WecomBot#reply`/`sendMessage` answer `false` when
  the socket is not writable (reconnecting, closed); both call sites now check, so a dropped reply is logged and a
  dropped proactive send raises a readable error instead of claiming delivery.
- **Remote approval now works in a WeCom chat as well.** It could not before, in both directions, and the failure was
  invisible: the approval bridge demanded an account record that holds a WeChat token, and a WeCom chat's pseudo
  account (`wecom-…`) has no account file at all - so every request was quietly handed to the GUI while the person in
  WeCom saw nothing. The long connection also skipped the "is this a 1/2 answer?" step, so an answer would have
  started a turn instead of answering. Now: `approvalTarget()` decides which record may be asked (a WeChat account
  needs its token, a WeCom chat needs an authenticated socket, otherwise the GUI keeps the request), the prompt and
  its confirmation go out as a proactive long-connection message, and the WeCom inbound path classifies with
  `classifyWecomInbound()` - the same rule, in the same order (allowlist, then approval answer, then a turn) as
  `classifyInbound()` for personal WeChat.
- Two suites that create and delete a temp directory now retry that cleanup (`maxRetries`): Windows occasionally held
  the directory for a moment, which reported a passing suite as failed.
- **Two-way WeCom: the intelligent robot's long connection.** A robot configured as *API 模式 → 长连接*
  (BotID + Secret) needs no public URL, so the plugin opens the WebSocket itself (`wecom-bot.js`), turns every
  `aibot_msg_callback` into an ordinary DSH conversation through the same machinery as personal WeChat (pseudo
  account `wecom:<botId>`, peers, allowlist, approvals, reply relay), and answers each inbound frame with a `stream`
  body - the only passive reply type WeCom accepts.
- **The "bot stopped answering this chat" bug is fixed at its root too.** A stored session that cannot be resumed made
  `create` answer `SessionAlreadyExistsError` (the id *is* taken), so every later message died the same way - seen
  live as `inboundError: session "wechat-…" already exists`, with no turn ever running again. Opening a conversation
  is now an explicit ladder in the new `session.js`: **resume → create → resume again → fresh id**, with a non-clash
  create failure reported instead of papered over. The second resume matters because the id can be occupied by a log
  that a concurrent create just materialized - keeping that chat's history is worth one retry. A fresh id is the last
  resort, so a chat keeps working instead of staying silent forever.
- **Nothing about it is silent.** The outcome is recorded as `wecom.sessionIssue` (`requested`, `resume`, `create`,
  `retryResume`, `freshId`) in `GET /state` and `GET /state`-style debug replies, logged once at warn level, and shown
  on the `/dsh-wechat-media/wecom` page together with the last inbound failure - that page is where someone actually
  goes to ask why the bot is quiet.
- `GET /state.wecom.configured`/`via` now count the long connection, which the first version forgot (a bot-only setup
  reported "not configured" while it was in fact working). The test-send note on the WeCom page no longer labels a
  long-connection send as "自建应用", and it names the chat a proactive send went to.
- The page, the README and the `wecom_send_text` tool description no longer claim WeCom is outbound-only: inbound is
  the long connection, and only the *callback* API remains impossible. Long-connection media is still not downloaded -
  an image or file arrives labelled as an undownloaded attachment rather than being dropped.
- New suites `test/session.test.mjs` (the recovery ladder, driven by a scripted `ctx.agents` double) and
  `test/wiring.test.mjs` (helper/namespace wiring). `test/package.test.mjs` now import-checks and
  harness-import-checks every host module the manifest publishes, instead of a hand-written list that had already
  fallen behind. 157 tests total.

## 0.3.0

- **WeCom (企业微信) support, outbound.** Two ways out: a **group robot webhook** (one URL; text / markdown /
  image) and a **self-built app** (corpid + corpsecret + agentid; text / markdown plus image / file / voice /
  video through a media upload). Both are configured on a plain page at `/dsh-wechat-media/wecom`, which is also
  where the test message is sent from; the card shows the current state and links to it.
- Two tools: `wecom_send_text` (text or markdown, webhook or app) and `wecom_send_file` (app: upload + send as
  image/file/video/voice; webhook: images only, and anything else is refused with an explanation).
- **No inbound path, deliberately.** WeCom delivers messages by calling a public HTTPS URL registered with the
  enterprise, which a plugin running on someone's own machine cannot offer; claiming otherwise would produce a
  dead feature. Personal WeChat keeps its two-way bridge.
- Secrets live in their own `wecom.json` (mode `0600`), never in `prefs.json` and never in a cordis patch; `/state`
  reports only whether a secret is set.
- New `wecom.js` transport and suite `test/wecom.test.mjs`: payload shapes (including the image base64 + md5 pair),
  error mapping (the platform's wording is not repeated when the hint already contains it), token caching with an
  early refresh, and the exact requests the client sends - all with fetch injected, so no network. 14 new tests
  (114 total).

## 0.2.10

- **The system folder picker actually appears now.** v0.2.8 spawned PowerShell with `windowsHide: true`, which
  left the process without a usable window: the dialog returned "cancelled" about two seconds later without ever
  being shown (verified against the running plugin: three calls, `picked: null, elapsedMs ≈ 2100`). The spawn no
  longer hides the window, and the dialog is shown against a **topmost owner form** - the documented fix for a
  dialog that never comes to the front. Run directly on the same machine, the same script does show the dialog and
  returns the chosen directory.
- **A failure is never ambiguous.** The route now reports how long the dialog took, so the page distinguishes
  "you cancelled" from "the system never showed it" and tells you to type the absolute path in that case.

## 0.2.9

- **The test suite is platform-neutral again.** `test/inbox.test.mjs` asserted on a Windows drive path
  (`D:\wechat-files`), which is not absolute on Linux, so CI failed for v0.2.7 and v0.2.8 even though the code was
  fine. The assertions now build their absolute paths with `path.join(tmpdir(), …)` and the one Windows-only case
  is guarded by `process.platform === "win32"`. No runtime change (100 tests, green on Linux and Windows).

## 0.2.8

- **Pick the inbox directory with the system folder dialog.** A new *Browse… / 浏览…* action (card and control
  panel) and the route `GET /dsh-wechat-media/pick-folder` open Windows' own folder picker on the user's desktop
  and save the choice. A browser cannot hand over an absolute path (a directory `<input>` only exposes relative
  names), so the host opens the dialog through `powershell -STA`; the typed input stays as a fallback, and a
  cancelled or failed dialog says so on the page instead of failing silently. `FOLDER_PICK_SCRIPT` and
  `parsePickedPath` are exported and tested - a relative or empty answer is refused. Two more tests (100 total).

## 0.2.7

- **The inbox directory is configurable.** Inbound media used to always land in `$DSH_HOME/wechat-inbox`; now a
  runtime preference wins over the plugin config (`inboxDir`), which wins over that default. Set it from the card
  (a plain GET form, so it works even where the card's fetches do not reach the plugin) or from the control panel
  (`/dsh-wechat-media/panel`). An absolute path is required; an empty value restores the default. `resolveInboxDir`
  is exported and tested: a relative path is refused rather than resolved somewhere surprising, and the day/chat
  layout and the size cap are unchanged. `/state` reports `inboxRoot` plus `inboxRootDefault` and
  `inboxRootConfig`, so the effective value is always visible.
- New suite `test/inbox.test.mjs` (98 tests total).

## 0.2.6

Fixes and diagnostics that all came out of real use.

- **Every card action works over GET.** In one reporter's browser every `fetch` from the plugin card was
  swallowed before reaching the plugin - `POST` *and* `GET` - while plain navigation worked. All control routes
  (`/login`, `/login/<id>/verify|cancel`, `/logout`, `/peers`, `/prefs`, `/test-approval`, `/approvals/cancel`,
  `/debug/inbound`) now accept **GET with query parameters** as well as POST, and the card uses GET exclusively.
- **A no-JavaScript control panel.** `GET /dsh-wechat-media/panel` (loopback only) offers the same actions as
  links: send a test approval, cancel a waiting one, toggle the allowlist, and allow / ignore / clear each
  contact. It exists because in that browser the card could not reach the plugin at all.
- **`GET /dsh-wechat-media/send-test-approval`** sends the approval prompt and answers a small HTML page saying
  whether it went out (and why not) - reachable by pasting a URL, no JavaScript involved. Both plain pages carry
  a "← 返回 DSH" button (`history.back()`; the GUI's own `/` needs a token).
- **A control-route log.** `/state` reports `recentRoutes` - the last 20 calls to `/test-approval`,
  `/approvals/cancel`, `/debug/inbound`, `/panel` and `/send-test-approval` with their result - so "I clicked and
  nothing happened" is answered from the server: did the request arrive, and what did it do?
- **A stuck request can no longer freeze a route.** `readBody` gives up after two seconds instead of holding a
  handler (and the card's button) open forever on a body that never arrives.
- **The card polls every second** (was two), and `busy` is released automatically after 30 seconds so one bad
  request cannot leave every button disabled.
- **The self-test reports what actually happened**: the route waits for the *send* and answers `sent: true` or the
  delivery error, instead of claiming success before the prompt had left the process.
- **No message vanishes silently**: a message that carries neither text nor downloadable media is counted as
  `counters.unusable` and logged with its item types.
- `POST /dsh-wechat-media/debug/inbound` (loopback only) feeds the receive path an envelope shaped like the
  platform's, so the inbound pipeline can be exercised without a phone.

## 0.2.5

- The approval self-test reports the real send result, and a click while a question is already waiting answers
  `{ok:false, reason:"pending"}` with HTTP 200 rather than a bare 409.

## 0.2.4

- The self-test no longer blocks the HTTP request for the whole wait (up to two minutes), which made the card's
  button look dead; it sends and returns, and the card polls `/state` instead.

## 0.2.3

- A waiting approval is visible in the card (`/state.approvals`) and can be cancelled from DSH
  (`/dsh-wechat-media/approvals/cancel`), handing the request back to the GUI.
- Only a real timeout says "no answer"; cancelling and aborting no longer send a contradictory second notice.

## 0.2.2

- Approval answers are confirmed in the chat ("✅ 已批准…" / "🚫 已拒绝…"), reported from real use: a consumed
  answer that produced no reply was indistinguishable from being ignored.

## 0.2.1

- **Fixed an approval-key mismatch found by a live run**: the pending key used `account.accountId ?? account.botId`
  while the inbound path used the monitor's account id. Real account records carry `botId`, so the two differed
  and a `1`/`2` reply reached the agent as an ordinary message instead of answering the approval. The key is now
  passed explicitly from the sender side, with a regression test that names the account record differently.
- Dropped messages are counted per chat (`blockedCount` / `blockedAt`) and shown in the card.
- All three candidate addressing ids per chat (`groupId` / `sessionChat` / `fromUserId`) are recorded and exposed
  through `/state`, so which field addresses a group is read off the platform rather than guessed.
- `scripts/probe-group-send.mjs` sends a labelled test message to one chat and prints the platform's `ret` per
  addressing variant.
- Group addressing was cross-checked against three implementations (the official client, `daemon365/weixin-clawbot`
  and `SiverKing/weixin-ClawBot-API`): all address a chat through `to_user_id` alone, and none has a
  group-specific send branch.
- The approval bridge was extracted into `createApprovalBridge` with its dependencies injected, so who gets asked,
  what `1`/`2` mean, the timeout, an aborted turn, one question per chat and the fail-safe fallback to the GUI are
  all covered by tests.

## 0.2.0

- **Remote approval.** A WeChat-driven session's approval request is asked in the same WeChat chat, with the tool,
  the reason and a preview of the arguments (truncated at 400 characters). Answers are consumed and never become a
  turn; anything unanswered within `approvalTimeoutSec` (default 120 s), undeliverable or aborted falls back to
  the GUI. `approval: "ignore"` keeps approvals in the GUI.
- **Contact allowlist panel.** Every chat that writes is remembered and listed with Allow / Ignore / Clear and an
  *Only accept allowlisted chats* switch (off by default). Decisions apply immediately and live in `peers.json`;
  a blocked chat cannot answer approvals either.
- **Group groundwork.** Inbound messages log the envelope's identifying fields so a group's send target is
  confirmed against the platform, and the tools document `12345678@chatroom` group ids.
- `describeEnvelope`, `classifyInbound`, `formatApprovalPrompt`, `noteBlocked` and `syntheticInbound` are exported
  and tested.

## 0.1.1

- **Adding a second account is now obvious.** The primary button always reads *Add an account (QR code)* instead
  of switching to *Pair again* once one account existed. Each account row keeps its own *Pair again* and *Unpair*.
- **A pairing attempt can be cancelled**, so a QR opened by mistake disappears immediately instead of waiting for
  the code to expire.

## 0.1.0

First release: QR pairing for one or more personal WeChat accounts, one DSH conversation per contact or group,
two-way text / image / video / document / archive transfer, media decrypted into `$DSH_HOME/wechat-inbox`,
persistent accounts and routes, and the `wechat_send_text` / `wechat_send_file` / `wechat_status` tools.
