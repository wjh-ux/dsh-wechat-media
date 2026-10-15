/**
 * Tests for the automatic retry after a failed turn.
 *
 * `shouldRetryTurn` is the whole policy, and it is pure: which failures are worth a second call, how
 * many attempts are allowed, and what the switch does. The behaviour around it (a fresh user message,
 * the notice in the chat, the counters) is asserted in wiring.test.mjs.
 *
 * Run: node test/retry.test.mjs
 */
import assert from "node:assert/strict";

import { shouldRetryTurn } from "../index.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

await test("a transport failure is retried exactly once", () => {
  assert.equal(shouldRetryTurn({ error: "DeepSeek Messages transport failed", attempt: 1, enabled: true }), true);
  // The second failure is reported, not retried again: a loop would bill tokens and never tell the truth.
  assert.equal(shouldRetryTurn({ error: "DeepSeek Messages transport failed", attempt: 2, enabled: true }), false);
});

await test("the transient causes are recognised, not guessed", () => {
  const transient = [
    "TRANSPORT",
    "fetch failed",
    "ECONNRESET",
    "socket hang up",
    "ETIMEDOUT",
    "request timed out",
    "429 Too Many Requests",
    "rate limit exceeded",
    "HTTP 502",
    "503 Service Unavailable",
    "504 gateway timeout",
    "model is overloaded",
  ];
  for (const error of transient) assert.equal(shouldRetryTurn({ error, attempt: 1, enabled: true }), true, error);
});

await test("a deterministic failure is not retried", () => {
  // Retrying these would spend a second call to fail the same way, and hide the real problem.
  const deterministic = [
    "invalid model id",
    "context length exceeded",
    "authentication failed",
    "400 Bad Request",
    "the request was rejected by policy",
    "",
    undefined,
    null,
  ];
  for (const error of deterministic) assert.equal(shouldRetryTurn({ error, attempt: 1, enabled: true }), false, String(error));
});

await test("the switch off means no retry, whatever the cause", () => {
  assert.equal(shouldRetryTurn({ error: "TRANSPORT", attempt: 1, enabled: false }), false);
  assert.equal(shouldRetryTurn({ error: "", attempt: 1, enabled: false }), false);
});

await test("the defaults are the safe ones", () => {
  // Called with nothing at all it must not claim a retry is warranted...
  assert.equal(shouldRetryTurn(), false);
  // ...and enabled defaults to true, so a caller that forgets the switch still gets the common case.
  assert.equal(shouldRetryTurn({ error: "TRANSPORT" }), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
