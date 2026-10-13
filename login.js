/**
 * dsh-wechat-media - QR login sessions.
 *
 * One `WechatLoginManager` drives every pairing attempt, for every account. The
 * protocol is a QR state machine with eight statuses (see the spec in
 * clawbot/CLAWBOT-HTTP-API-SPEC.md):
 *
 *   wait                  nobody scanned yet - keep polling
 *   scaned                scanned, waiting for the phone to confirm
 *   need_verifycode       the phone demands the digits shown on it
 *   verify_code_blocked   too many wrong codes - the QR must be replaced
 *   scaned_but_redirect   continue this session against another host
 *   confirmed             credentials issued (bot_token + ilink_bot_id)
 *   expired               this QR is dead - issue a new one
 *   binded_redirect       already bound on another host: reuse the saved token
 *
 * Policies come from the platform's own client and matter for behaviour, not for
 * correctness: a QR lives 5 minutes, a human gets 8 minutes in total, polling is
 * once per second, and at most 3 QR codes are issued per attempt.
 *
 * The protocol calls are injected (`ilink`), which keeps this class unit-testable
 * without a network or a phone: the tests drive all eight statuses with a stub.
 */

import { normalizeAccountId } from "./state.js";

/** One QR code's lifetime, client-side. */
const QR_TTL_MS = 5 * 60 * 1000;
/** How long a human has to finish the whole flow. */
const LOGIN_TOTAL_MS = 480 * 1000;
/** Gap between two status polls; each poll itself long-polls on the server. */
const POLL_INTERVAL_MS = 1000;
/** How many fresh QR codes one attempt may burn. */
const MAX_QR_REFRESH = 3;

/** Terminal statuses - the attempt is over. */
const TERMINAL = new Set(["confirmed", "give_up", "cancelled", "error"]);

let sessionCounter = 0;

/**
 * Turn a platform status into a stable, user-facing phase.
 * Unknown statuses are treated as "still waiting" rather than as failures, which
 * is what the official client does with server chatter it does not recognise.
 */
function classify(status) {
  switch (status) {
    case "wait":
    case "scaned":
    case "need_verifycode":
      return "pending";
    case "scaned_but_redirect":
      return "redirect";
    case "expired":
    case "verify_code_blocked":
      return "replace";
    case "confirmed":
      return "confirmed";
    case "binded_redirect":
      return "rebind";
    default:
      return "pending";
  }
}

export class WechatLoginManager {
  /**
   * @param {object} options
   * @param {import('./state.js').WechatState} options.state   persistence
   * @param {object} options.ilink                              protocol client (injectable)
   * @param {string} [options.baseUrl]                          API host
   * @param {string} [options.botType]                          platform bot type, default "3"
   * @param {() => number} [options.now]                        clock (injectable for tests)
   * @param {(ms: number) => Promise<void>} [options.sleep]     delay (injectable for tests)
   */
  constructor({ state, ilink, baseUrl = "https://ilinkai.weixin.qq.com", botType = "3", now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.state = state;
    this.ilink = ilink;
    this.baseUrl = baseUrl;
    this.botType = botType;
    this.now = now;
    this.sleep = sleep;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }

  /** Every attempt, newest first, for the status card. */
  list() {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id) {
    return this.sessions.get(id);
  }

  /** Drop finished attempts so the card does not grow forever. */
  prune() {
    for (const [id, session] of this.sessions) {
      if (TERMINAL.has(session.status)) this.sessions.delete(id);
    }
  }

  /**
   * Ask the platform for a QR code and register a new attempt.
   * @returns {Promise<object>} the session record
   */
  async start() {
    this.prune();
    const session = {
      id: `login-${++sessionCounter}-${Math.random().toString(36).slice(2, 8)}`,
      status: "wait",
      phase: "pending",
      qrcode: undefined,
      qrPayload: undefined,
      redirectHost: undefined,
      verifyCodeNeeded: false,
      verifyCodeSubmitted: false,
      verifyCode: undefined,
      botId: undefined,
      userId: undefined,
      accountId: undefined,
      startedAt: this.now(),
      issuedAt: 0,
      refreshes: 0,
      message: undefined,
      error: undefined,
    };
    await this.#issue(session);
    this.sessions.set(session.id, session);
    return session;
  }

  /** Fetch (or refresh) the QR code for an attempt. */
  async #issue(session) {
    const qr = await this.ilink.requestQrCode({ baseUrl: this.baseUrl, botType: this.botType });
    session.qrcode = qr?.qrcode;
    // What goes INSIDE the QR code: the platform hands back a landing-page URL
    // (`qrcode_img_content`), and the official client encodes exactly that URL
    // (`displayQRCode(startResult.qrcodeUrl)`). A caller-supplied renderer may
    // already have produced a data URL, which is passed through instead.
    session.qrPayload = qr?.qrImageDataUrl ?? qr?.qrContent ?? qr?.qrImageUrl ?? qr?.raw?.qrcode_img_content ?? undefined;
    session.redirectHost = undefined;
    session.status = "wait";
    session.phase = "pending";
    session.verifyCodeNeeded = false;
    session.verifyCodeSubmitted = false;
    session.verifyCode = undefined;
    session.issuedAt = this.now();
    session.message = undefined;
  }

  /**
   * Poll once and advance the state machine.
   * @returns {Promise<object>} the same session record
   */
  async tick(session) {
    if (TERMINAL.has(session.status)) return session;

    const now = this.now();
    if (now - session.startedAt > LOGIN_TOTAL_MS) {
      session.status = "give_up";
      session.phase = "give_up";
      session.message = "login-timeout";
      return session;
    }
    if (session.issuedAt && now - session.issuedAt > QR_TTL_MS) {
      session.status = "expired";
      session.phase = "replace";
    }

    if (session.phase !== "replace") {
      let result;
      try {
        result = await this.ilink.pollQrStatus({
          baseUrl: session.redirectHost ? `https://${session.redirectHost}` : this.baseUrl,
          qrcode: session.qrcode,
          verifyCode: session.verifyCodeSubmitted ? session.verifyCode : undefined,
        });
      } catch (error) {
        // Network hiccups and server-side 524s are part of normal long-polling:
        // stay in `wait` and poll again, exactly like the official client.
        session.message = `poll-failed: ${error?.message ?? error}`;
        return session;
      }
      const status = result?.status ?? "wait";
      session.status = status;
      session.phase = classify(status);
      session.message = status;
      if (status === "scaned_but_redirect" && result?.redirectHost) {
        session.redirectHost = result.redirectHost;
      }
      if (status === "need_verifycode") {
        session.verifyCodeNeeded = true;
        session.verifyCodeSubmitted = false;
      }
      if (status === "scaned" && session.verifyCodeSubmitted) {
        // The phone accepted the digits it was given.
        session.verifyCodeSubmitted = false;
        session.verifyCodeNeeded = false;
      }
      if (status === "confirmed") {
        await this.#adoptConfirmed(session, result);
        return session;
      }
      if (status === "binded_redirect") {
        // Not an error: this phone is already bound. Reuse the stored token of
        // whichever account we already hold; without one there is nothing to do.
        const accounts = await this.state.loadAccounts();
        const reusable = accounts.find((account) => account.token);
        if (reusable) {
          session.accountId = reusable.accountId;
          session.botId = reusable.botId;
          session.userId = reusable.userId;
          session.status = "confirmed";
          session.phase = "confirmed";
          session.message = "reused-existing-binding";
          return session;
        }
        session.status = "give_up";
        session.phase = "give_up";
        session.message = "binded-without-stored-token";
        return session;
      }
    }

    if (session.phase === "replace") {
      if (session.refreshes >= MAX_QR_REFRESH) {
        session.status = "give_up";
        session.phase = "give_up";
        session.message = "too-many-qr-refreshes";
        return session;
      }
      session.refreshes += 1;
      try {
        await this.#issue(session);
      } catch (error) {
        session.status = "error";
        session.phase = "error";
        session.error = String(error?.message ?? error);
      }
    }
    return session;
  }

  /** Persist the credential the platform just issued. */
  async #adoptConfirmed(session, result) {
    const botId = result?.botId ?? result?.ilink_bot_id;
    if (!botId) {
      // A `confirmed` without an id is a failure, not a success.
      session.status = "error";
      session.phase = "error";
      session.error = "confirmed-without-bot-id";
      return;
    }
    const baseUrl = result?.baseUrl ?? result?.baseurl ?? this.baseUrl;
    const userId = result?.wxid ?? result?.userId ?? result?.ilink_user_id;
    await this.state.saveAccount(botId, {
      token: result?.token ?? result?.bot_token,
      baseUrl,
      userId,
      botId,
    });
    session.accountId = normalizeAccountId(botId);
    session.botId = botId;
    session.userId = userId;
    session.status = "confirmed";
    session.phase = "confirmed";
    session.message = "paired";
  }

  /** Hand the digits from the phone's screen to the next poll. */
  submitVerifyCode(session, code) {
    const trimmed = String(code ?? "").trim();
    if (!trimmed) return false;
    session.verifyCode = trimmed;
    session.verifyCodeSubmitted = true;
    return true;
  }

  /**
   * Run an attempt to completion, one poll per second.
   * @returns {Promise<object>} the finished session record
   */
  async run(session, { signal } = {}) {
    while (!TERMINAL.has(session.status)) {
      if (signal?.aborted) {
        session.status = "cancelled";
        session.phase = "cancelled";
        session.message = "cancelled";
        break;
      }
      await this.tick(session);
      if (TERMINAL.has(session.status)) break;
      await this.sleep(POLL_INTERVAL_MS);
    }
    return session;
  }

  /** Give up on an attempt (the user pressed cancel, or dsh is shutting down). */
  cancel(session) {
    if (!session) return;
    if (!TERMINAL.has(session.status)) {
      session.status = "cancelled";
      session.phase = "cancelled";
      session.message = "cancelled";
    }
  }

  /** Forget a session entirely (after the card has shown the outcome). */
  forget(id) {
    this.sessions.delete(id);
  }
}
