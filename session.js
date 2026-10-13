/**
 * dsh-wechat-media - opening the DSH conversation that owns one chat.
 *
 * Both transports (personal WeChat and the WeCom intelligent robot) reach the same
 * problem: given a stable session id for a chat, hand back a live agent - resuming
 * the stored history when there is one, creating it when there is not.
 *
 * The naive `try resume, catch -> create` is not enough, and real use proved it:
 * when a stored session cannot be resumed (an interrupted create that never
 * materialized, a log another handle still owns, a session the persistence layer
 * refuses), `create` answers `SessionAlreadyExistsError` - the id *is* taken - and
 * every later message to that chat dies in the same wedge. Observed live on the
 * WeCom long connection: `inboundError: session "wechat-…" already exists`, and no
 * turn ever ran again for that chat.
 *
 * So the ladder is: resume, create, resume again (a concurrent create may have
 * materialized the log in the meantime), and only then a fresh id - which at least
 * lets the chat work again instead of staying dead. Every failure is recorded in
 * an issue object the caller can surface; nothing is swallowed silently, because
 * "why did the bot stop answering" must be answerable from the host's own state.
 *
 * Pure logic with everything injected, so the whole ladder is unit-testable
 * without a harness or a network.
 */

/** Does this error mean "the session id is already taken"? */
export function isSessionExistsError(error) {
  const text = `${error?.name ?? ""} ${error?.message ?? error ?? ""}`;
  return /already\s*exists|already\s*owned|SessionAlreadyExists|SessionAlreadyOwned/i.test(text);
}

/** A one-line, log-safe description of a thrown value. */
export function describeError(error) {
  if (error === undefined || error === null) return "unknown error";
  const message = String(error.message ?? "").trim();
  if (message !== "") return message;
  const name = String(error.name ?? "").trim();
  if (name !== "") return name;
  const text = String(error).trim();
  return text === "" || text === "[object Object]" ? "unknown error" : text;
}

/**
 * Open (resume or create) the agent for one session id.
 *
 * @param {object} options
 * @param {object} options.agents - the harness `ctx.agents` service.
 * @param {string} options.sessionId - the stable id for this chat.
 * @param {object} [options.meta] - session metadata (cwd, agentPreset, …).
 * @param {object} [options.agentOptions] - provider/model/reasoning selection.
 * @param {Function} [options.setup] - the per-agent composition hook.
 * @param {object} [options.logger] - anything with an optional `warn`.
 * @param {Function} [options.freshId] - build the fallback id from the base id.
 * @returns {Promise<{ handle: object, sessionId: string, issue: object|undefined }>}
 *   `issue` is undefined for the clean "resumed an existing session" path, and
 *   otherwise names exactly which step failed and what was done about it.
 */
export async function openSessionAgent({
  agents,
  sessionId,
  meta,
  agentOptions,
  setup,
  logger,
  freshId = (base) => `${base}-r${Date.now().toString(36)}`,
} = {}) {
  if (!agents || typeof agents.resume !== "function" || typeof agents.create !== "function") {
    throw new Error("openSessionAgent: ctx.agents.resume/create are required");
  }
  if (!sessionId) throw new Error("openSessionAgent: a session id is required");

  const common = { meta, ...(agentOptions ? { agentOptions } : {}), ...(setup ? { setup } : {}) };
  /** Every step's failure, so the caller never has to guess. */
  const issue = { requested: sessionId, resume: null, create: null, retryResume: null, freshId: null };

  try {
    const handle = await agents.resume({ resumeSessionId: sessionId, ...common });
    return { handle, sessionId, issue: undefined };
  } catch (error) {
    issue.resume = describeError(error);
  }

  try {
    const handle = await agents.create({ sessionId, ...common });
    return { handle, sessionId, issue };
  } catch (error) {
    issue.create = describeError(error);
    if (!isSessionExistsError(error)) {
      // A real failure (bad metadata, no persistence backend, …). A fresh id would
      // not fix it, and silently retrying would hide the cause.
      const failure = new Error(
        `cannot open session "${sessionId}": create failed (${issue.create}) and resume failed (${issue.resume})`,
      );
      failure.issue = issue;
      failure.cause = error;
      throw failure;
    }
  }

  // The id is taken but could not be resumed a moment ago: a concurrent create may
  // have materialized the log since, and that history is worth keeping.
  try {
    const handle = await agents.resume({ resumeSessionId: sessionId, ...common });
    issue.retryResume = "resumed on the second attempt";
    logger?.warn?.(
      "[dsh-wechat-media] session %s was not resumable at first (%s) but is now; history kept",
      sessionId,
      issue.resume,
    );
    return { handle, sessionId, issue };
  } catch (error) {
    issue.retryResume = describeError(error);
  }

  // Last resort: the chat must not stay dead. A new id starts an empty history.
  const fresh = freshId(sessionId);
  logger?.warn?.(
    "[dsh-wechat-media] session %s is unusable (resume: %s; create: %s; resume again: %s); starting %s so this chat keeps working",
    sessionId,
    issue.resume,
    issue.create,
    issue.retryResume,
    fresh,
  );
  try {
    const handle = await agents.create({ sessionId: fresh, ...common });
    issue.freshId = fresh;
    return { handle, sessionId: fresh, issue };
  } catch (error) {
    issue.freshId = `${fresh} (failed: ${describeError(error)})`;
    const failure = new Error(
      `cannot open session "${sessionId}" (resume: ${issue.resume}; create: ${issue.create}; fresh "${fresh}": ${describeError(error)})`,
    );
    failure.issue = issue;
    failure.cause = error;
    throw failure;
  }
}
