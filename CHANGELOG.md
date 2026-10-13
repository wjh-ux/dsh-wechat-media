# Changelog

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
