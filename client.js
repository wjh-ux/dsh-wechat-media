/**
 * dsh-wechat-media - client half: the pairing card.
 *
 * Renders on the bundle's page in the Plugins panel (`plugins.bundle.config`,
 * keyed by the package name) and on the row's own page (`plugins.row.config`,
 * keyed `<package>#<row id>`). It talks only to the host half's own loopback
 * routes, so no remote service is needed:
 *
 *   GET  /dsh-wechat-media/state              accounts, monitors, live logins
 *   POST /dsh-wechat-media/login              start a pairing attempt
 *   GET  /dsh-wechat-media/login/<id>[/...]   poll, verify, cancel
 *   GET  /dsh-wechat-media/qr/<id>            the QR image (proxied by the host)
 *   POST /dsh-wechat-media/logout             forget one account
 *
 * The wrapper below is mandatory: dsh's browser half is a lazy-CJS module table,
 * and a file that merely exports a factory fails the web boot with
 * "1 entry did not activate".
 */
window.__ModuleLoader__.load({
  id: "dsh-wechat-media",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    const BASE = "/dsh-wechat-media";
    const SLOT_BUNDLE_CONFIG = "plugins.bundle.config";
    const SLOT_ROW_CONFIG = "plugins.row.config";
    const BUNDLE_KEY = "dsh-wechat-media";
    const ROW_ID = "wechat-media";
    const LOCALE_NS = "dsh-wechat-media";
    const POLL_MS = 2000;

    const CSS = `
.dswxCard{display:flex;flex-direction:column;gap:10px;padding:12px 0}
.dswxRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dswxAccount{border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.dswxName{font-weight:600}
.dswxMeta{font-size:12px;opacity:.7}
.dswxDot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:#b26a00;vertical-align:middle}
.dswxDotOn{background:#2ea043}
.dswxDotErr{background:#d1242f}
.dswxBtn{padding:5px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit;cursor:pointer}
.dswxBtn:disabled{opacity:.5;cursor:default}
.dswxPrimary{border-color:transparent;background:rgba(46,160,67,.18)}
.dswxQr{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.dswxQrImg{width:190px;height:190px;image-rendering:pixelated;border-radius:8px;background:#fff;padding:6px}
.dswxInput{padding:6px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit;width:110px}
.dswxMsg{margin:0;font-size:12px}
.dswxErr{color:#d1242f}
.dswxHint{margin:0;font-size:12px;opacity:.7}
`;

    function injectCss() {
      const id = `${LOCALE_NS}/card.css`;
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = LOCALE_NS;
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** One JSON request against the host half. */
    async function api(path, { method = "GET", body } = {}) {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { error: text };
      }
      if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`);
      return parsed;
    }

    /**
     * Service names this client module consumes - NOT package names.
     *
     * The packages that must load first are listed in package.json under
     * `dsh.client.inject`; putting package names here makes cordis look for
     * services with those names, which fails the client module load and takes the
     * web UI down with it.
     */
    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(() => injectCss(), "dsh-wechat-media css");
      ctx.effect(() => ctx.locale.register(LOCALE_NS, {
        en: {
          title: "WeChat bridge",
          empty: "No WeChat account is paired yet.",
          addAccount: "Add an account (QR code)",
          rescanAccount: "Pair again",
          pairingNow: "Waiting for the scan…",
          logout: "Unpair",
          scanning: "Waiting for the scan…",
          scanned: "Scanned - confirm on your phone",
          needCode: "Enter the digits shown on your phone",
          submitCode: "Submit",
          cancel: "Cancel",
          cancelled: "Cancelled",
          expired: "QR expired - a fresh one is coming",
          paired: "Paired",
          pairFailed: "Pairing failed",
          online: "monitoring",
          offline: "not running",
          error: "error",
          chats: "conversations",
          contacts: "Contacts & groups",
          contactsEmpty: "Nobody has written to it yet.",
          allowed: "Allowed",
          blocked: "Ignored",
          undecided: "Undecided",
          allow: "Allow",
          block: "Ignore",
          clearDecision: "Clear",
          requireAllowlist: "Only accept allowlisted chats",
          allowlistWarning: "The allowlist is on: any chat that is not set to Allowed — including your own — is ignored silently.",
          approvalHint: "Sensitive operations are asked here: reply 1 to approve once, 2 to reject.",
          blockedCount: "blocked",
          testApproval: "Test approval",
          working: "Working…",
          testApprovalSending: "Sending the approval prompt…",
          testApprovalSent: "Approval prompt sent to WeChat - reply 1 to allow, 2 to reject (or cancel it here).",
          lastApproval: "Last approval",
          testApprovalPending: "An approval is already waiting in this chat - answer it in WeChat, or cancel it here.",
          testApprovalFailed: "The prompt could not be sent",
          approvalAnswer: "Answer received",
          approvalNoAnswer: "No answer within the timeout - a real request would fall back to the GUI the same way.",
          scanHint: "Scan with WeChat on your phone. Scanning a different WeChat account adds it as another account; the same account just refreshes its login. Credentials stay on this machine, so restarting dsh needs no new scan.",
          refresh: "Refresh",
        },
        zh: {
          title: "微信桥接",
          empty: "还没有配对的微信账号。",
          addAccount: "添加账号（扫码）",
          rescanAccount: "重新扫码",
          pairingNow: "等待扫码…",
          logout: "解除绑定",
          scanning: "等待扫码…",
          scanned: "已扫码 —— 请在手机上确认",
          needCode: "请输入手机上显示的数字",
          submitCode: "提交",
          cancel: "取消",
          cancelled: "已取消",
          expired: "二维码过期，正在换新的",
          paired: "配对成功",
          pairFailed: "配对失败",
          online: "监听中",
          offline: "未运行",
          error: "异常",
          chats: "个会话",
          contacts: "联系人 / 群",
          contactsEmpty: "还没有人给它发过消息。",
          allowed: "已允许",
          blocked: "已忽略",
          undecided: "未决定",
          allow: "允许",
          block: "忽略",
          clearDecision: "清除",
          requireAllowlist: "只接收白名单内的联系人与群",
          allowlistWarning: "白名单已开启：任何未设为「允许」的联系人/群（包括你自己）发来的消息都会被静默忽略。",
          approvalHint: "敏感操作会在微信里问你：回 1 批准一次，回 2 拒绝。",
          blockedCount: "已拦截",
          testApproval: "测试审批",
          working: "处理中…",
          testApprovalSending: "正在发送审批提示…",
          testApprovalSent: "已把审批提示发到微信 —— 回 1 批准、回 2 拒绝（也可以在卡片上取消）。",
          lastApproval: "最近一次审批",
          testApprovalPending: "这条对话已有一条审批在等待 —— 请在微信回 1/2，或在卡片上取消。",
          testApprovalFailed: "审批提示发送失败",
          approvalAnswer: "已收到答复",
          approvalNoAnswer: "超时没等到答复 —— 真实审批也会这样回落到 GUI。",
          scanHint: "用手机微信扫码。扫**不同的微信号**就是再加一个账号；扫同一个号只是刷新登录。凭证保存在本机，重启 dsh 不需要重扫。",
          refresh: "刷新",
        },
      }), "dsh-wechat-media locale");

      function WechatCard(props) {
        const [snapshot, setSnapshot] = react.useState(undefined);
        const [error, setError] = react.useState(undefined);
        const [busy, setBusy] = react.useState(false);
        const [code, setCode] = react.useState("");

        const t = (key, fallback) => {
          try {
            const translated = props?.t?.(key);
            return typeof translated === "string" && translated.length > 0 ? translated : fallback;
          } catch {
            return fallback;
          }
        };

        const refresh = react.useCallback(async () => {
          try {
            const next = await api("/state");
            setSnapshot(next);
            setError(undefined);
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          }
        }, []);

        react.useEffect(() => {
          refresh();
          const timer = setInterval(refresh, POLL_MS);
          return () => clearInterval(timer);
        }, [refresh]);

        // Safety net: every button is disabled while `busy` is true, so one stuck
        // request would make the whole card look dead. Release it automatically.
        react.useEffect(() => {
          if (!busy) return undefined;
          const timer = setTimeout(() => setBusy(false), 30000);
          return () => clearTimeout(timer);
        }, [busy]);

        const pending = snapshot?.logins?.find((login) => login.phase === "pending" || login.phase === "redirect" || login.phase === "replace");

        async function startPairing() {
          setBusy(true);
          try {
            await api("/login", { method: "POST", body: {} });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function unpair(accountId) {
          setBusy(true);
          try {
            await api("/logout", { method: "POST", body: { accountId } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function submitCode() {
          if (!pending) return;
          setBusy(true);
          try {
            await api(`/login/${pending.id}/verify`, { method: "POST", body: { code } });
            setCode("");
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** Stop a pairing attempt the user did not mean to start. */
        async function cancelPairing(loginId) {
          setBusy(true);
          try {
            await api(`/login/${loginId}/cancel`, { method: "POST", body: {} });
            setCode("");
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** Allow, ignore, or clear the decision for one chat. */
        async function decide(accountId, chatId, allowed) {
          setBusy(true);
          try {
            await api("/peers", { method: "POST", body: { accountId, chatId, allowed } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** Give up on a question that is waiting in WeChat. */
        async function cancelApproval(entry) {
          setBusy(true);
          try {
            await api("/approvals/cancel", { method: "POST", body: { accountId: entry?.accountId, chatId: entry?.chatId } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function setAllowlist(requireAllowlist) {
          setBusy(true);
          try {
            await api("/prefs", { method: "POST", body: { requireAllowlist } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }
        /**
         * Send the approval prompt to WeChat and wait for the 1/2 answer. This is
         * the same path a real approval takes on the WeChat side, so it verifies
         * the round trip without needing a sensitive tool call first.
         */
        async function runApprovalSelfTest() {
          setBusy(true);
          setFailed(false);
          setMessage(t("testApprovalSending", "Sending the approval prompt…"));
          try {
            const result = await api("/test-approval", { method: "POST", body: {} });
            if (result.sent) {
              setMessage(t("testApprovalSent", "Approval prompt sent to WeChat - reply 1 to allow, 2 to reject (or cancel it here)."));
            } else if (result.reason === "pending") {
              setMessage(t("testApprovalPending", "An approval is already waiting in this chat - answer it in WeChat, or cancel it here."));
            } else {
              setFailed(true);
              setMessage(`${t("testApprovalFailed", "The prompt could not be sent")}: ${result.error ?? "?"}`);
            }
          } catch (problem) {
            setFailed(true);
            setMessage(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        const accounts = snapshot?.accounts ?? [];
        const pairedCount = accounts.length;

        /** Every chat the bridge has seen, flattened for the allowlist panel. */
        const peerRows = [];
        for (const [accountId, chats] of Object.entries(snapshot?.peers ?? {})) {
          for (const [chatId, peer] of Object.entries(chats ?? {})) {
            peerRows.push({ accountId, chatId, ...peer });
          }
        }
        const decisionLabel = (peer) =>
          peer?.allowed === true ? t("allowed", "Allowed")
            : peer?.allowed === false ? t("blocked", "Ignored")
              : t("undecided", "Undecided");

        const status = pairedCount === 0
          ? t("empty", "No WeChat account is paired yet.")
          : `${pairedCount} 个账号 / account(s)`;

        if (props?.view === "summary") return h("span", null, status);

        const loginText = (login) => {
          switch (login.phase) {
            case "pending":
              return login.status === "scaned" ? t("scanned", "Scanned - confirm on your phone") : t("scanning", "Waiting for the scan…");
            case "replace":
              return t("expired", "QR expired - a fresh one is coming");
            case "confirmed":
              return t("paired", "Paired");
            case "give_up":
              return login.message === "login-timeout" ? t("expired", "QR expired") : t("cancelled", "Cancelled");
            case "error":
              return `${t("pairFailed", "Pairing failed")}: ${login.error ?? ""}`;
            default:
              return login.status ?? "";
          }
        };

        return h("div", { className: "dswxCard" }, [
          h("div", { key: "head", className: "dswxRow" }, [
            h("strong", { key: "t" }, t("title", "WeChat bridge")),
            h("span", { key: "s", className: "dswxMeta" }, status),
            h("button", { key: "add", type: "button", className: "dswxBtn dswxPrimary", disabled: busy || Boolean(pending), onClick: startPairing },
              pending ? t("pairingNow", "Waiting for the scan…") : t("addAccount", "Add an account (QR code)")),
            h("button", { key: "r", type: "button", className: "dswxBtn", disabled: busy, onClick: refresh }, t("refresh", "Refresh")),
          ]),

          ...accounts.map((account) => h("div", { key: account.accountId, className: "dswxAccount" }, [
            h("div", { className: "dswxRow" }, [
              h("span", {
                className: account.lastError ? "dswxDot dswxDotErr" : account.running ? "dswxDot dswxDotOn" : "dswxDot",
                "aria-hidden": true,
              }),
              h("span", { className: "dswxName" }, account.userId ?? account.botId ?? account.accountId),
              h("span", { className: "dswxMeta" }, account.running ? t("online", "monitoring") : t("offline", "not running")),
              account.lastError ? h("span", { className: "dswxMeta dswxErr" }, `${t("error", "error")}: ${account.lastError}`) : null,
            ]),
            h("div", { className: "dswxMeta" }, `${account.accountId} · ${(account.chats ?? []).length} ${t("chats", "conversations")}`),
            h("div", { className: "dswxRow" }, [
              h("button", { type: "button", className: "dswxBtn", disabled: busy || Boolean(pending), onClick: startPairing }, t("rescanAccount", "Pair again")),
              h("button", { type: "button", className: "dswxBtn", disabled: busy, onClick: () => unpair(account.accountId) }, t("logout", "Unpair")),
            ]),
          ])),

          h("div", { key: "contacts", className: "dswxCard" }, [
            h("div", { key: "head", className: "dswxRow" }, [
              h("strong", { key: "t" }, t("contacts", "Contacts & groups")),
              h("button", { key: "test", type: "button", className: "dswxBtn", disabled: busy, onClick: runApprovalSelfTest },
                busy ? t("working", "Working…")
                  : (snapshot?.approvals ?? []).length > 0 ? t("testApproval", "Test approval") + " ⏳"
                    : t("testApproval", "Test approval")),
              h("label", { key: "l", className: "dswxMeta" }, [
                h("input", {
                  key: "c",
                  type: "checkbox",
                  checked: Boolean(snapshot?.prefs?.requireAllowlist),
                  disabled: busy,
                  onChange: (event) => setAllowlist(event.target.checked),
                }),
                " " + t("requireAllowlist", "Only accept allowlisted chats"),
              ]),
            ]),
            (snapshot?.approvals ?? []).length > 0
              ? h("div", { key: "waiting", className: "dswxRow" }, [
                  h("span", { key: "t", className: "dswxMeta" },
                    `${t("waitingApproval", "Waiting for your approval in WeChat")}: ${(snapshot.approvals ?? []).map((item) => item.toolName ?? "?").join(", ")}`),
                  h("button", { key: "c", type: "button", className: "dswxBtn", disabled: busy, onClick: () => cancelApproval(snapshot.approvals[0]) },
                    t("cancelWaiting", "Cancel")),
                ])
              : null,
            snapshot?.lastApproval
              ? h("p", { key: "lastApproval", className: "dswxMeta" },
                  `${t("lastApproval", "Last approval")}: ${snapshot.lastApproval.outcome} · ${snapshot.lastApproval.chatId}`)
              : null,
            peerRows.length === 0
              ? h("p", { key: "none", className: "dswxMeta" }, t("contactsEmpty", "Nobody has written to it yet."))
              : null,
            // Turning the switch on while no chat is allowed mutes everyone,
            // including the person holding the phone - say so instead of letting
            // them wonder why the bot went quiet.
            snapshot?.prefs?.requireAllowlist && peerRows.every((peer) => peer.allowed !== true)
              ? h("p", { key: "warn", className: "dswxMsg dswxErr" }, t("allowlistWarning", "The allowlist is on: any chat that is not set to Allowed - including your own - is ignored silently."))
              : null,
            ...peerRows.map((peer) => h("div", { key: `${peer.accountId}|${peer.chatId}`, className: "dswxAccount" }, [
              h("div", { key: "l1", className: "dswxRow" }, [
                h("span", { key: "n", className: "dswxName" }, peer.name ?? peer.chatId),
                h("span", { key: "k", className: "dswxMeta" }, peer.kind === "group" ? "群 / group" : "私聊 / direct"),
                h("span", { key: "d", className: "dswxMeta" }, decisionLabel(peer)),
                Number(peer.blockedCount) > 0
                  ? h("span", { key: "b", className: "dswxMeta dswxErr" }, `${t("blockedCount", "blocked")} ${peer.blockedCount}`)
                  : null,
              ]),
              h("div", { key: "l2", className: "dswxMeta" }, peer.chatId),
              h("div", { key: "l3", className: "dswxRow" }, [
                h("button", { key: "a", type: "button", className: "dswxBtn", disabled: busy, onClick: () => decide(peer.accountId, peer.chatId, true) }, t("allow", "Allow")),
                h("button", { key: "b", type: "button", className: "dswxBtn", disabled: busy, onClick: () => decide(peer.accountId, peer.chatId, false) }, t("block", "Ignore")),
                h("button", { key: "c", type: "button", className: "dswxBtn", disabled: busy, onClick: () => decide(peer.accountId, peer.chatId, null) }, t("clearDecision", "Clear")),
              ]),
            ])),
            h("p", { key: "approval", className: "dswxHint" }, t("approvalHint", "Sensitive operations are asked here: reply 1 to approve once, 2 to reject.")),
          ]),

          pending ? h("div", { key: "qr", className: "dswxQr" }, [
            pending.hasQr
              ? h("img", { key: "img", className: "dswxQrImg", alt: "WeChat login QR", src: `${BASE}/qr/${pending.id}` })
              : h("div", { key: "noimg", className: "dswxMeta" }, t("scanning", "Waiting for the scan…")),
            h("div", { key: "side", className: "dswxCard" }, [
              h("p", { key: "state", className: "dswxMsg" }, loginText(pending)),
              h("div", { key: "actions", className: "dswxRow" }, [
                h("button", { key: "cancel", type: "button", className: "dswxBtn", disabled: busy, onClick: () => cancelPairing(pending.id) },
                  t("cancel", "Cancel")),
              ]),
              pending.verifyCodeNeeded
                ? h("div", { key: "code", className: "dswxRow" }, [
                    h("input", {
                      key: "i",
                      className: "dswxInput",
                      value: code,
                      inputMode: "numeric",
                      placeholder: t("needCode", "digits"),
                      onChange: (event) => setCode(event.target.value),
                      onKeyDown: (event) => { if (event.key === "Enter") submitCode(); },
                    }),
                    h("button", { key: "b", type: "button", className: "dswxBtn dswxPrimary", disabled: busy || code.trim().length === 0, onClick: submitCode },
                      t("submitCode", "Submit")),
                  ])
                : null,
              h("p", { key: "hint", className: "dswxHint" }, t("scanHint", "Scan with WeChat on your phone.")),
            ]),
          ]) : null,

          error ? h("p", { key: "err", className: "dswxMsg dswxErr" }, error) : null,
          snapshot?.inboxRoot
            ? h("p", { key: "inbox", className: "dswxHint" }, `微信收到的文件保存在 ${snapshot.inboxRoot}`)
            : null,
        ]);
      }

      const definition = (name, key) => ({
        name,
        key,
        locale: LOCALE_NS,
        inject: () => ({ hooks: {} }),
      });

      const registerCard = (slot, key) => {
        ctx.slots.inject(slot, () => {
          try {
            const dispose = ctx.slots.register(definition(slot, key), WechatCard);
            console.info("[dsh-wechat-media] card registered into", slot, "with key", key);
            return dispose;
          } catch (problem) {
            console.error("[dsh-wechat-media] card registration failed", problem);
            return undefined;
          }
        });
      };

      registerCard(SLOT_BUNDLE_CONFIG, BUNDLE_KEY);
      registerCard(SLOT_ROW_CONFIG, `${BUNDLE_KEY}#${ROW_ID}`);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
