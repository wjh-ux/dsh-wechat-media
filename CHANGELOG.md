# Changelog

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
