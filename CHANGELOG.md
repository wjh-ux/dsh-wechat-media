# Changelog

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
