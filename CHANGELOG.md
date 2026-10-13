# Changelog

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
