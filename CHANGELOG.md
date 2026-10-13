# Changelog

## 0.2.6

- **Control-route log.** `/state` reports `recentRoutes` (the last 20 calls to `/test-approval`,
  `/approvals/cancel` and `/debug/inbound` with their result), so "I clicked the button and nothing happened" can
  be answered from the server: did the request arrive at all, and what did it do? Prompted by a report that the
  card's Test-approval button sent no message while the same route worked when called directly.

## 0.2.5

- **The self-test says what actually happened.** `POST /dsh-wechat-media/test-approval` now waits for the *send*
  and reports it (`sent: true`, or the delivery error) instead of claiming success before the prompt had left the
  process - a failed send used to look like a silent success. A click while a question is already waiting answers
  `{ok:false, reason:"pending"}` with HTTP 200 rather than a bare 409, and the card explains all three outcomes:
  sent / already waiting / could not be sent.
- One more test (91 total).

## 0.2.4

- **The approval self-test no longer looks dead.** `POST /dsh-wechat-media/test-approval` used to hold the HTTP
  request open for the whole wait (up to two minutes), so clicking the card's button froze it with no visible
  progress - reported from real use. The route now sends the prompt and returns at once; the card reports that
  the prompt went out, shows the waiting question from `/state.approvals`, and displays the outcome from the new
  `/state.lastApproval` (`allowed-once` / `rejected` / `cancelled` / `timeout`) once it is answered.
- One more test (90 total).

## 0.2.3

- **A waiting approval is visible in the card and can be cancelled from DSH.** `/state` reports the pending
  questions (chat, tool, how long it has waited) and `POST /dsh-wechat-media/approvals/cancel` gives up on one,
  which hands the request back to the GUI instead of making the user wait out the timeout.
- **Only a real timeout says "no answer".** Cancelling in DSH and aborting a turn no longer also send
  "⌛ 微信里没等到批复…" right after their own notice - two contradictory messages for one event (caught by the
  new test). Two more tests (89 total).

## 0.2.2

- **Approval answers are confirmed in the chat.** Reported from real use: answering `1` or `2` was consumed
  silently, which is indistinguishable from being ignored. The bridge now replies in the same chat -
  "✅ 已批准，本次操作继续。" or "🚫 已拒绝，本次操作已取消。" - while the timeout notice stays as it was. One more
  test (88 total).

## 0.2.1

- **Dropped messages are counted.** When the allowlist ignores a chat the drop is recorded
  (`blockedCount` / `blockedAt` on that chat) and the card shows "已拦截 N 条 / N blocked", so a muted
  conversation is visible instead of looking like a broken bridge. One more test (73 total).
- The approval bridge was extracted into `createApprovalBridge` with its dependencies injected, so every
  decision — who gets asked, what "1"/"2" mean, the timeout, an aborted turn, one question per chat, and the
  rule that an undeliverable prompt must fall back to the GUI — is covered by tests. Twelve new tests
  (85 total).- `GET /dsh-wechat-media/state` now also reports `counters` (received / forwarded / blocked / answered) and the
  last inbound message per account, so checking a live run means one request instead of log archaeology.- `POST /dsh-wechat-media/debug/inbound` (loopback only) feeds the receive path an envelope shaped like the
  platform's, so the inbound pipeline can be exercised and read back through `peers.json`, the route table and
  the counters without a phone.- **Fixed a bug the live run found.** The approval pending key used `account.accountId ?? account.botId` while
  the inbound path used the monitor's account id. Real account records carry `botId`, so the two differed and a
  "1"/"2" reply never matched: it reached the agent as an ordinary message instead of answering the approval.
  The key is now passed explicitly from the sender side, with a regression test that names the account record
  differently (87 tests total).- A message that carries neither text nor downloadable media (a sticker, an unknown item type) is now counted as
  `counters.unusable` and logged with its item types instead of disappearing without a trace. A live run showed
  exactly that: the peer's `seenAt` advanced while no session turn was produced.- Group addressing now records all three candidate ids per chat (`groupId`, `sessionChat`, `fromUserId`) and
  `/state` exposes them, so the field that actually addresses a group is read off the platform instead of
  guessed. Still awaiting a live group message; the v0.2.0 release notes say so.

## 0.2.0

- **Remote approval.** A WeChat-driven session's approval request is asked in the same WeChat chat, with the
  tool, the reason **and a preview of the arguments** (truncated at 400 characters), because "工具：pwsh" alone
  does not tell anyone what they are about to allow. Answer "回 1 = 批准一次 · 回 2 = 拒绝". Answers are consumed — they never become a new turn — and
  anything unanswered within `approvalTimeoutSec` (default 120 s), undeliverable, or aborted falls back to the
  GUI, so an approval is never silently dropped. Set `approval: "ignore"` to keep approvals in the GUI.
- **Contact allowlist panel.** Every chat that writes is remembered and listed in the card with
  *Allow / Ignore / Clear* per row and an *Only accept allowlisted chats* switch (off by default, so a freshly
  paired account never looks broken). Decisions apply immediately and live in `peers.json`.
- **Group groundwork.** Every chat records all three candidate addressing ids (`groupId`, `sessionChat`,
  `fromUserId`) and `/state` exposes them, so the field that actually addresses a group is read off the
  platform instead of guessed. Inbound messages also log the envelope's identifying fields
  (`session_id` / `group_id` / `room_id` / `from_user_id`) so a group's send target is confirmed against the
  platform rather than guessed, and the tools document `12345678@chatroom` group ids.
- `scripts/probe-group-send.mjs` sends a labelled test message to one chat and prints the platform's `ret` per
  addressing variant — the diagnostic used for the group work.
- Group addressing was cross-checked against three implementations (the official client,
  `daemon365/weixin-clawbot` and `SiverKing/weixin-ClawBot-API`): all address a chat through `to_user_id` alone,
  and none has a group-specific send branch, so `ChatType` does not gate group delivery. The README limitation
  was rewritten accordingly; the only open question is which inbound field carries a group's id, which the
  diagnostic line answers on the group's first message.
- The inbound pipeline was split into `describeEnvelope` and `classifyInbound`, so envelope identification,
  allowlist enforcement and approval-answer consumption are decided by injectable, testable functions instead
  of living inside the poll loop.
- **Twenty-two more tests (71 total)**: approval-reply parsing, approval-prompt formatting (argument preview
  and truncation), allowlist decisions, chunking, the panel wiring,
  and twelve offline integration tests that drive the real pipeline against a real state store (direct vs
  group addressing, allowed / blocked / undecided chats, consumed approval answers, and the rule that a
  blocked chat cannot answer approvals).

## 0.1.1

Card fixes reported from real use:

- **Adding a second account is now obvious.** The primary button always reads
  *Add an account (QR code)* instead of switching to *Pair again* once one account
  existed — that label made a second account look impossible. Each account row keeps
  its own *Pair again* and *Unpair*.
- **A pairing attempt can be cancelled.** Clicking the QR button by mistake used to
  leave a live QR code with no way out but waiting for it to expire; the card now
  offers *Cancel*, and the cancelled attempt disappears from the card immediately.
- The account count reads *N 个账号 / account(s)*, and the scan hint explains that
  scanning a different WeChat account adds another one while the same account merely
  refreshes its login.
- Two regression tests cover both behaviours (49 tests total).

## 0.1.0

First release: QR pairing for one or more personal WeChat accounts, one DSH
conversation per contact or group, two-way text / image / video / document / archive
transfer, media decrypted into `$DSH_HOME/wechat-inbox`, persistent accounts and
routes, and the `wechat_send_text` / `wechat_send_file` / `wechat_status` tools.
