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

    /**
     * Token counts and remaining time, formatted for the card.
     *
     * A deliberate duplicate of the host's `formatTokens`/`formatRemaining`: this bundle is a
     * lazy-CJS module that only `require`s react, so it cannot import the host module, and
     * shipping pre-formatted strings from the host would freeze the card into one language.
     * Deliberately locale-neutral (`12.3k`, `3d`) - the same reading in both languages.
     */
    function formatCount(value) {
      const n = Math.max(0, Math.round(Number(value) || 0));
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(n);
    }

    function formatLeft(ms) {
      const hours = Math.ceil(Math.max(0, Number(ms) || 0) / 3600000);
      if (hours <= 1) return "<1h";
      if (hours < 48) return `${hours}h`;
      return `${Math.round(hours / 24)}d`;
    }

    const BASE = "/dsh-wechat-media";
    const SLOT_BUNDLE_CONFIG = "plugins.bundle.config";
    const SLOT_ROW_CONFIG = "plugins.row.config";
    const BUNDLE_KEY = "dsh-wechat-media";
    const ROW_ID = "wechat-media";
    const LOCALE_NS = "dsh-wechat-media";
    const POLL_MS = 1000;

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
          friendOnly: "Only answer friends (1:1 chats; group messages are ignored silently)",
          friendOnlyOn: "Friends only is on: group messages are ignored silently",
          groupsSkipped: "skipped",
          interject: "Let a new message interject while it is still answering",
  retry: "Retry once when a turn fails in the transport",
          desktop: "Let the agent drive this machine's mouse, keyboard and screen",
          desktopUnsupported: "not available on this platform",
          tasks: "Scheduled tasks",
          tasksUnit: "",
          tasksEmpty: "No scheduled tasks yet. Say \u201cevery day at 8:00 remind me\u201d in a chat and one is created.",
          office: "Office documents",
          officeRead: "read/write",
          officeConvert: "PDF",
          officeDir: "Save to",
          officeDirHint: "absolute folder; empty = the bridge's own directory",
          officeDirSet: "using the folder above",
          officeDirDefault: "default: the bridge's own directory",
          officeHint: "relative paths from the four office tools land here",
          missing: "not found",
          save: "Save",
          useDefault: "Default",
          wizard: "Getting started",
          wizardHint: "four steps; skippable at any point",
          wizardSkip: "Skip (I know this)",
          wizardPrev: "Back",
          wizardNext: "Next",
          wizardFinish: "Done",
          wizardStep1: "WeCom and Feishu take credentials in the cards below; WeChat is one scan, right here.",
          wizardScan: "Pair WeChat (QR)",
          copyScopes: "Copy scope JSON",
          scopesHint: "only the 8 scopes this plugin calls",
          scopesCopied: "scopes copied",
          scopesCopyFailed: "the browser refused; read them from /feishu-scopes",
          needsRestart: "the plugin may need a dsh restart for this route",
          wizardTest: "Send a test message",
          wizardTestHint: "goes to the chat that last wrote, through the real delivery path",
          wizardStep2a: "Only accept allowlisted chats (off by default)",
          wizardStep2b: "Answer 1:1 chats only, ignore groups (off by default)",
          wizardStep3a: "Desktop control: mouse, keyboard, screenshots (off by default)",
          wizardStep3b: "Let scheduled tasks run local commands (off by default)",
          wizardStep4: "Generated documents can be sent straight to a chat; this directory decides where relative paths land.",
          taskCommand: "Let command tasks run local commands",
          taskAdd: "Add",
          taskText: "text / prompt / command",
          taskCreated: "created",
          taskNeedBoth: "both the schedule and the content are required",
          nextRun: "next",
          lastRun: "last",
          paused: "paused",
          finished: "done",
          finishedHint: "a one-off cannot be paused",
          runAgain: "Run again",
          stepDay: "+1 day",
          stepWeek: "+1 week",
          stepMonth: "+1 month",
          autoRearm: "re-arm after each run",
          pause: "Pause",
          resume: "Resume",
          remove: "Delete",
          failed: "failed",
          interjectOn: "Interjection is on: a message sent while the agent is working joins that turn",
          interjected: "interjected",
          formatLabel: "Text",
          formatPlain: "Cleaned (drop markdown WeChat cannot render)",
          formatRaw: "Raw (send the model's markdown as-is)",
          formatHint: "Bold markers, headings, code fences, table rules and math delimiters are stripped; ordinary sentences are untouched.",
          deliveryLabel: "Sending",
          deliveryWhole: "Whole answer, sent once",
          deliveryStream: "Word by word (WeCom only)",
          deliveryHint: "Word by word streams the answer while it is written; personal WeChat always receives whole answers.",
          authLabel: "Approvals",
          authStrict: "Strict - always ask, silence means no",
          authModerate: "Moderate - ask, fall back to the GUI",
          authFull: "Full - never ask here",
          authReadonly: "View only - refuse anything that asks",
          authHint: "Decides only how this plugin handles an approval request; DSH's own session policy is set in DSH.",
          tokensTitle: "Token usage",
          tokenNextReset: "clears in",
          tokenResets: "cleared",
          tokenNoUsage: "no usage yet",
          tokenWindowLabel: "Clear every",
          tokenReset: "Clear now",
          tokenEmpty: "No account has used any tokens in this window.",
          tokenIn: "in",
          tokenOut: "out",
          tokenCache: "cache",
          calls: "call(s)",
          days: "days",
          allowlistWarning: "The allowlist is on: any chat that is not set to Allowed — including your own — is ignored silently.",
          approvalHint: "Sensitive operations are asked here: reply 1 to approve once, 2 to reject.",
          inboxLabel: "Inbound files are saved in",
          wecomLabel: "WeCom (企业微信)",
  feishuLabel: "Feishu (飞书 / Lark)",
  feishuAppId: "App ID (cli_…)",
  feishuAppSecret: "App Secret (leave blank to keep the saved one)",
  feishuWebhookUrl: "Custom webhook URL",
  feishuWebhookSecret: "Webhook signing secret (optional)",
  feishuDomainLabel: "Platform",
  feishuTo: "Default receive id (chat_id / open_id)",
  feishuLong: "Receive over the long connection (no public URL needed)",
  feishuSave: "Save Feishu settings",
  feishuClear: "Clear saved Feishu settings",
  feishuSavedHere: "saved from this panel",
  feishuFromConfig: "from the plugin config or the environment",
  feishuConnection: "Long connection",
  feishuNotConfigured: "Not configured yet",
  feishuFormHint: "Saving takes effect immediately - no DSH restart, no setx.",
          notConfigured: "not configured",
          configure: "Configure",
          inboxPlaceholder: "absolute path, e.g. D:\\wechat-files",
          save: "Save",
          browse: "Browse…",
          inboxFormHint: "Saving opens the control panel; use the back button there to return.",
          blockedCount: "blocked",
          testApproval: "Test approval",
          testApprovalUrl: "or open this URL",
          openPanel: "Control panel",
          testApprovalHint: "Opens a small page that sends the approval prompt (this browser does not deliver the card's POST).",
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
          friendOnly: "只处理好友私聊（群消息静默忽略）",
          friendOnlyOn: "只处理好友私聊已开启：群消息被静默忽略",
          groupsSkipped: "已跳过",
          interject: "允许插话（正在回复时新消息加入当前回合）",
  retry: "失败自动重试（传输类错误重试一次）",
          desktop: "允许操作本机鼠标 / 键盘 / 屏幕",
          desktopUnsupported: "本机不支持（仅 Windows）",
          tasks: "定时任务",
          tasksUnit: "",
          tasksEmpty: "还没有定时任务。在聊天里说「每天 8 点提醒我喝水」就会建一个。",
          office: "办公文档",
          officeRead: "读写",
          officeConvert: "转 PDF",
          officeDir: "保存到",
          officeDirHint: "绝对路径；留空 = 桥接进程自己的目录",
          officeDirSet: "使用上面的目录",
          officeDirDefault: "默认：桥接进程自己的目录",
          officeHint: "四个 office 工具的相对路径都落在这里",
          missing: "未找到",
          save: "保存",
          useDefault: "用默认",
          wizard: "新手向导",
          wizardHint: "四步，随时可以跳过",
          wizardSkip: "跳过（我熟）",
          wizardPrev: "上一步",
          wizardNext: "下一步",
          wizardFinish: "完成",
          wizardStep1: "企业微信 / 飞书在下面的卡片里填凭据；微信在这里直接扫码。",
          wizardScan: "扫码接微信",
          copyScopes: "复制权限 JSON",
          scopesHint: "只含本插件用到的 8 项，不是全部权限",
          scopesCopied: "项已复制",
          scopesCopyFailed: "浏览器拒绝了，可从 /feishu-scopes 取",
          needsRestart: "可能需要重启 dsh 让插件路由生效",
          wizardTest: "发一条测试消息",
          wizardTestHint: "发到最近有消息的那个会话，走真实的发送路径",
          wizardStep2a: "只接受白名单里的会话（默认关）",
          wizardStep2b: "只回答一对一，忽略群（默认关）",
          wizardStep3a: "桌面控制：鼠标、键盘、截图（默认关）",
          wizardStep3b: "允许定时任务执行本机命令（默认关）",
          wizardStep4: "做完文档可以直接发到聊天里；这里的目录决定相对路径落在哪。",
          taskCommand: "允许 command 任务执行本机命令",
          taskAdd: "添加",
          taskText: "内容 / 提示词 / 命令",
          taskCreated: "已创建",
          taskNeedBoth: "时间和内容都要填",
          nextRun: "下次",
          lastRun: "上次",
          paused: "已暂停",
          finished: "已跑完",
          finishedHint: "一次性任务，不能暂停",
          runAgain: "再次运行",
          stepDay: "+1 天",
          stepWeek: "+1 周",
          stepMonth: "+1 月",
          autoRearm: "完成后再排一次",
          pause: "暂停",
          resume: "恢复",
          remove: "删除",
          failed: "失败",
          interjectOn: "插话已开启：agent 还在回复时发来的消息会加入当前回合",
          interjected: "已插话",
          formatLabel: "文本处理",
          formatPlain: "清洗（去掉微信不渲染的标记）",
          formatRaw: "原样（保留 markdown）",
          formatHint: "加粗星号、标题井号、代码围栏、表格分隔行、公式 $$ 都会被去掉；普通句子逐字不变。",
          deliveryLabel: "发送方式",
          deliveryWhole: "整段（写完一次发）",
          deliveryStream: "逐字（仅企微生效）",
          deliveryHint: "逐字＝边写边出现（企业微信）；个人微信没有编辑已发消息的接口，始终一次发完整答案。",
          authLabel: "授权档位",
          authStrict: "严格 — 每次都问，超时即拒绝",
          authModerate: "适中 — 问，超时转 GUI",
          authFull: "完全权限 — 不在这里问",
          authReadonly: "仅查看 — 需要授权的操作直接拒绝",
          authHint: "只决定本插件如何处理审批请求；DSH 自己的会话策略请在 DSH 里设置。",
          tokensTitle: "Token 用量",
          tokenNextReset: "距清零",
          tokenResets: "已清零",
          tokenNoUsage: "还没有用量",
          tokenWindowLabel: "清零周期",
          tokenReset: "立即清零",
          tokenEmpty: "这个窗口内还没有任何账号产生用量。",
          tokenIn: "输入",
          tokenOut: "输出",
          tokenCache: "缓存",
          calls: "次调用",
          days: "天",
          allowlistWarning: "白名单已开启：任何未设为「允许」的联系人/群（包括你自己）发来的消息都会被静默忽略。",
          approvalHint: "敏感操作会在微信里问你：回 1 批准一次，回 2 拒绝。",
          inboxLabel: "微信收到的文件保存在",
          wecomLabel: "企业微信",
  feishuLabel: "飞书（飞书 / Lark）",
  feishuAppId: "App ID（cli_…）",
  feishuAppSecret: "App Secret（留空则保留已保存的值）",
  feishuWebhookUrl: "自定义机器人 Webhook 地址",
  feishuWebhookSecret: "Webhook 签名密钥（可选）",
  feishuDomainLabel: "平台",
  feishuTo: "默认接收方 id（chat_id / open_id）",
  feishuLong: "用长连接接收（不需要公网地址）",
  feishuSave: "保存飞书配置",
  feishuClear: "清除面板保存的飞书配置",
  feishuSavedHere: "由面板保存",
  feishuFromConfig: "来自插件配置或环境变量",
  feishuConnection: "长连接",
  feishuNotConfigured: "尚未配置",
  feishuFormHint: "保存后立即生效 —— 不需要重启 DSH，也不需要 setx。",
          notConfigured: "未配置",
          configure: "配置",
          inboxPlaceholder: "绝对路径，例如 D:\\wechat-files",
          save: "保存",
          browse: "浏览…",
          inboxFormHint: "保存会打开控制面板页面，保存完用那里的「返回 DSH」按钮回来。",
          blockedCount: "已拦截",
          testApproval: "测试审批",
          testApprovalUrl: "或直接打开这个网址",
          openPanel: "控制面板",
          testApprovalHint: "会打开一个小页面来发送审批提示（这个浏览器不会把卡片的 POST 送到插件）。",
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
      // The Feishu form is controlled: only the fields the person actually filled are sent, so a blank
      // input can never clear a saved secret by accident (an empty value *does* clear when it is sent
      // deliberately - that is what the Clear button does).
      const [feishuDraft, setFeishuDraft] = react.useState({});
      // The block reports its own outcome: a page-level banner is easy to miss, and "did my Save do
      // anything?" is exactly the question this panel exists to answer.
      const [feishuNotice, setFeishuNotice] = react.useState(undefined);
      // The document/spreadsheet operations area keeps its own scratch state: none of it is a preference, so it must
      // not ride along with the settings draft that Save submits.
      const [feishuOps, setFeishuOps] = react.useState({ action: "create", link: "", range: "", text: "", result: "", ok: null });
      const [feishuOpsBusy, setFeishuOpsBusy] = react.useState(false);
      // Tavily keeps its own draft and notice, for the same reason: none of it is a Feishu preference either.
      const [tavilyDraft, setTavilyDraft] = react.useState({});
      const [tavilyNotice, setTavilyNotice] = react.useState(undefined);
      // The browser block does the same: channel/port/profile/headless are its own, not Feishu's.
        const [browserDraft, setBrowserDraft] = react.useState({});
        // The PAC host list: undefined until edited, so the field follows /state the rest of the time.
        const [proxyHostsDraft, setProxyHostsDraft] = react.useState(undefined);
        const [exportDirDraft, setExportDirDraft] = react.useState(undefined);
        // The tasks form: one schedule line, one action and one payload. Creation from a chat stays the
        // normal path; this is for "I am already looking at the list".
        // undefined = "not edited yet", so the field follows /state until somebody types in it.
        const [officeDirInput, setOfficeDirInput] = react.useState(undefined);
        // The wizard is a client-side step counter; whether it exists at all is the host's `wizardDone`.
        const [wizardStep, setWizardStep] = react.useState(0);
        // The result of the wizard's test message: undefined = not tried yet.
        const [wizardTest, setWizardTest] = react.useState(undefined);
        // The result of "copy the Feishu scopes": undefined = not tried yet.
        const [scopeCopy, setScopeCopy] = react.useState(undefined);
        const [taskDraft, setTaskDraft] = react.useState({ when: "", kind: "message", text: "" });
        const [taskNotice, setTaskNotice] = react.useState(undefined);
        // Which step each "run again" button will take: a day, a week or a month. Kept per row so
        // changing one task's step does not change another's.
        const [taskSteps, setTaskSteps] = react.useState({});
      const [browserNotice, setBrowserNotice] = react.useState(undefined);
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
            await api("/login");
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
            await api(`/logout${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`);
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
            await api(`/login/${encodeURIComponent(pending.id)}/verify?code=${encodeURIComponent(code)}`);
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
            await api(`/login/${encodeURIComponent(loginId)}/cancel`);
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
            await api(`/peers?accountId=${encodeURIComponent(accountId)}&chatId=${encodeURIComponent(chatId)}&allowed=${allowed === null || allowed === undefined ? "null" : String(allowed)}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * Send the approval prompt through the GET route and report what happened.
         * POST never reaches the plugin in the reporter's browser, so the card does
         * not rely on it.
         */
        async function runApprovalSelfTest() {
          setBusy(true);
          setFailed(false);
          setMessage(t("testApprovalSending", "Sending the approval prompt…"));
          try {
            const result = await api("/test-approval");
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

        /** Give up on a question that is waiting in WeChat. */
        async function cancelApproval(entry) {
          setBusy(true);
          try {
            await api(`/approvals/cancel?accountId=${encodeURIComponent(entry?.accountId ?? "")}&chatId=${encodeURIComponent(entry?.chatId ?? "")}`);
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
            await api(`/prefs?requireAllowlist=${requireAllowlist ? "true" : "false"}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * "Only answer friends" - the same switch `/friends` toggles from a chat. It lives
         * in prefs, so the card and the command cannot disagree.
         */
        async function setFriendOnly(friendOnly) {
          setBusy(true);
          try {
            await api(`/prefs?friendOnly=${friendOnly ? "true" : "false"}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** The text mode: cleaned for a chat window, or the model's markdown untouched. */
        async function setFormat(mode) {
          setBusy(true);
          try {
            await api(`/prefs?format=${encodeURIComponent(String(mode))}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** The delivery mode: send the whole answer, or show it while it is written. */
        async function setDelivery(mode) {
          setBusy(true);
          try {
            await api(`/prefs?delivery=${encodeURIComponent(String(mode))}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** The authorization level: how this plugin handles an approval request. */
        async function setAuthorization(level) {
          setBusy(true);
          try {
            await api(`/prefs?authorization=${encodeURIComponent(String(level))}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * The interjection switch: whether a message that arrives while the agent is still
         * answering joins that turn (`agent.steer`) or queues its own (`agent.followup`).
         * Same preference as `/interject`, stored by the host.
         */
        async function setInterject(interject) {
          setBusy(true);
          try {
            await api(`/prefs?interject=${interject ? "true" : "false"}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }
        /**
         * Save the Feishu settings from the panel.
         *
         * `mode: "filled"` sends only what the person typed (so blanks never wipe a stored secret);
         * `mode: "clear"` sends explicit empties for exactly the named fields. Both go to `/prefs`,
         * which is the route the panel writes to - the card route is handled by the host as well, so
         * the two cannot disagree.
         */
        async function setFeishu(patch, mode = "filled") {
          const params = new URLSearchParams();
          for (const [field, value] of Object.entries(patch ?? {})) {
            if (mode === "filled" && (value === undefined || value === null || String(value).trim() === "")) continue;
            params.set(field, String(value ?? ""));
          }
          if ([...params.keys()].length === 0) return;
          setBusy(true);
          try {
            const applied = await api(`/prefs?${params.toString()}`);
            const state = applied?.feishu?.connection?.state ?? "?";
            const changed = Array.isArray(applied?.feishuChanged) && applied.feishuChanged.length ? ` (${applied.feishuChanged.join(", ")})` : "";
            setFeishuNotice({ ok: true, text: `已保存${changed} · 连接状态：${state}` });
            setFeishuDraft({});
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
            setFeishuNotice({ ok: false, text: `保存失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /**
         * The retry switch: whether a turn that fails with a transport error (a timeout, a reset
         * connection, a rate limit, a 5xx) is attempted once more. Same preference as `/retry`.
         */
        async function setRetry(retry) {
          setBusy(true);
          try {
            await api(`/prefs?retry=${retry ? "true" : "false"}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * The desktop control switch: the one preference that arms tools able to click on the user's own
         * screen. Same preference as `/desktop on`, and off unless the host actually stored `true` - the
         * checkbox is a convenience over that switch, never a second source of truth.
         */
        async function setDesktop(desktopControl) {
          setBusy(true);
          try {
            await api(`/prefs?desktopControl=${desktopControl ? "true" : "false"}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * Scheduled tasks: pause, resume, delete - and the one switch that lets a task run a local command.
         *
         * All of it goes through `/tasks`, which is the same three operations the `/task` command exposes;
         * creation stays in the chat, because a schedule is a sentence ("每天 8 点"), not a form.
         */
        /**
         * Copy the minimum Feishu scope payload.
         *
         * `navigator.clipboard` needs a secure context; the panel is served over http on loopback, where
         * some browsers refuse it. So there is a textarea fallback - a copy button that silently does
         * nothing on half the machines is worse than no button.
         */
        async function copyFeishuScopes() {
          setBusy(true);
          try {
            const payload = await api("/feishu-scopes");
            const text = String(payload?.json ?? "");
            let copied = false;
            try {
              await navigator.clipboard.writeText(text);
              copied = true;
            } catch {
              const area = document.createElement("textarea");
              area.value = text;
              area.style.position = "fixed";
              area.style.opacity = "0";
              document.body.appendChild(area);
              area.select();
              try {
                copied = document.execCommand("copy");
              } finally {
                document.body.removeChild(area);
              }
            }
            setScopeCopy({ ok: copied, text: `${payload?.count ?? 0} ${t("scopesCopied", "scopes copied")}${copied ? "" : " · " + t("scopesCopyFailed", "the browser refused, so copy it from /feishu-scopes")}` });
          } catch (problem) {
            // A 4xx here almost always means the host half is older than this bundle: routes register at
            // plugin load, so a refreshed page can show a button whose route does not exist yet. Saying so is
            // the difference between "restart once" and "this feature is broken".
            const text = String(problem?.message ?? problem);
            const hint = /HTTP (400|404|405)/.test(text) ? ` · ${t("needsRestart", "可能需要重启 dsh 让插件路由生效")}` : "";
            setScopeCopy({ ok: false, text: text + hint });
          } finally {
            setBusy(false);
          }
        }

        /** Send one real message through the bridge, from the wizard's second step. */
        async function sendWizardTest() {
          setBusy(true);
          try {
            const answer = await api("/test-send");
            setWizardTest({ ok: true, text: `${answer?.transport ?? ""} · ${answer?.chatId ?? ""}` });
          } catch (problem) {
            // The host's sentence is the useful one ("企业微信长连接没有连上"), so show it as-is.
            setWizardTest({ ok: false, text: String(problem?.message ?? problem) });
          } finally {
            setBusy(false);
          }
        }

        /** Finish or skip the wizard: both just record that it is done. */
        async function endWizard() {
          setBusy(true);
          try {
            await api("/prefs?wizardDone=true");
            setWizardStep(0);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** Save the list of domains that should go through the proxy. Empty means "all of them". */        async function saveProxyHosts(text) {
          setBusy(true);
          try {
            await api(`/proxy-hosts?action=set&hosts=${encodeURIComponent(String(text ?? ""))}`);
            setProxyHostsDraft(undefined);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * Ask the machine for a folder.
         *
         * A page cannot learn an absolute path on its own - `showDirectoryPicker()` hides it and `webkitdirectory`
         * only reports relative names - so the host opens the ordinary Windows dialog and answers with the path.
         * `cancelled` is a normal answer: closing the dialog is not an error.
         */
        async function browseExportDir() {
          setBusy(true);
          try {
            const answer = await api("/export-dir?action=browse");
            if (answer?.cancelled) {
              setBrowserNotice({ ok: true, text: "没有选择文件夹（保持原样）" });
            } else if (answer?.dir) {
              setExportDirDraft(undefined);
              setBrowserNotice({ ok: true, text: `导出目录已设为：${answer.dir}` });
            }
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `打开文件夹选择框失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /**
         * One click toward a loaded extension.
         *
         * Chrome does not let a page install an extension silently, so this does the three things a page *can* do:
         * pack the folder into a zip, open `chrome://extensions` focused, and put the token on the clipboard - then
         * say the two remaining steps in one sentence.
         */
        async function installExtension() {
          setBusy(true);
          try {
            const answer = await api("/extension-install");
            let copied = false;
            try { await navigator.clipboard.writeText(answer.token); copied = true; } catch { /* clipboard may be blocked */ }
            setBrowserNotice({
              ok: true,
              text: `已打包到 ${answer.zip}${answer.opened ? `，并打开 ${answer.opened}` : ""}。`
                + `${copied ? "token 已复制到剪贴板。" : `token：${answer.token}。`}`
                + `装法：开发者模式 → 加载已解压的扩展程序 → 选 ${answer.dir} → 扩展选项里填 ${answer.url} 和 token。`,
            });
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `安装助手失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /**
         * Switch the extension's transport.
         *
         * `debugger` is capable but Chrome draws its own "已开始调试此浏览器" banner, which no extension may hide;
         * `script` never attaches the debugger, so no banner appears; `hybrid` tries script first and reaches for the
         * debugger only on the commands scripting cannot do. A real trade-off, so it is a visible switch.
         */
        async function setExtensionDriver(mode) {
          setBusy(true);
          try {
            const answer = await api(`/extension-driver?mode=${encodeURIComponent(String(mode ?? ""))}`);
            setBrowserNotice({
              ok: true,
              text: answer.driver === "script"
                ? "已切到脚本注入：不会再出现「已开始调试此浏览器」，截图只能截可见区域。"
                : answer.driver === "hybrid"
                  ? "已切到混合模式：默认走脚本注入，只有脚本办不到的那一步才临时用调试器（横幅只在必要时出现）。"
                  : "已切到调试器：能力完整，Chrome 会显示「已开始调试此浏览器」（这是浏览器自己的提示，扩展关不掉）。",
            });
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `切换失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /** Pull cookies / bookmarks out of the real Chrome into the profile the tools launch (Chrome must be closed). */
        async function importChromeLogin() {
          setBusy(true);
          try {
            const answer = await api("/import-profile");
            setBrowserNotice({ ok: true, text: `已导入 ${answer?.copied?.length ?? 0} 个文件到插件 profile（下次打开浏览器就能带上登录）` });
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `导入失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /** Save the directory a bare `save` lands in; empty restores $DSH_HOME/exports. */
        async function saveExportDir(text) {
          setBusy(true);
          try {
            const answer = await api(`/export-dir?action=set&dir=${encodeURIComponent(String(text ?? ""))}`);
            setExportDirDraft(undefined);
            setBrowserNotice({ ok: true, text: `导出目录：${answer?.dir ?? "默认"}` });
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `保存失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /** Save the office directory. An empty value means "back to the bridge's own directory". */
        async function setOfficeDir(value) {
          setBusy(true);
          try {
            await api(`/prefs?officeDir=${encodeURIComponent(String(value ?? ""))}`);
            setOfficeDirInput(undefined);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function taskAction(params) {
          setBusy(true);
          try {
            await api(`/tasks?${new URLSearchParams(params).toString()}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }
        const removeTask = (id) => taskAction({ action: "remove", id });
        /** Create a task from the card. The host parses the schedule and answers with the id it made. */
        async function addTask() {
          const when = String(taskDraft.when ?? "").trim();
          const text = String(taskDraft.text ?? "").trim();
          if (!when || !text) {
            setTaskNotice({ ok: false, text: t("taskNeedBoth", "时间和内容都要填") });
            return;
          }
          setBusy(true);
          try {
            const query = new URLSearchParams({ action: "add", when, kind: taskDraft.kind || "message", text });
            const answer = await api(`/tasks?${query.toString()}`);
            if (answer?.ok === false) throw new Error(answer.error || "create failed");
            setTaskNotice({ ok: true, text: `${t("taskCreated", "已创建")} ${answer?.created ?? ""}` });
            setTaskDraft({ when: "", kind: taskDraft.kind || "message", text: "" });
            await refresh();
          } catch (problem) {
            // The host's message is the schedule parser's own sentence; show it rather than a generic one.
            setTaskNotice({ ok: false, text: String(problem?.message ?? problem) });
          } finally {
            setBusy(false);
          }
        }
        const toggleTask = (id, enabled) => taskAction({ action: "toggle", id, enabled: enabled ? "true" : "false" });
        const setTaskCommand = (enabled) => taskAction({ action: "command", enabled: enabled ? "true" : "false" });
        /** "Run again": the same clock time, pushed a day forward by the host, re-enabled. */
        const rearmTask = (id, step = "day") => taskAction({ action: "rearm", id, step });
        /** The switch behind it: keep re-arming this one-off after each run. */
        const setTaskAutoRearm = (id, enabled) => taskAction({ action: "auto", id, enabled: enabled ? "true" : "false" });

        /**
         * Token ledger controls. The window length (1..30 days) and a manual reset live in
         * the host's ledger file, which `/tokens` also drives - one source of truth.
         */
        async function setTokenWindow(days) {
          setBusy(true);
          try {
            await api(`/tokens?windowDays=${encodeURIComponent(String(days))}`);
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function resetTokens() {
          setBusy(true);
          try {
            await api("/tokens?reset=true");
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
          // Onboarding: four screens that end in the same place as the config below, so a first run has an
          // order and a second run has a button that makes it stop.
          snapshot?.prefs?.wizardDone !== true ? h("div", { key: "wizard", className: "dswxCard dswxWizard" }, [
            h("div", { key: "head", className: "dswxRow" }, [
              h("strong", { key: "t" }, `${t("wizard", "新手向导")} ${wizardStep + 1}/5`),
              h("span", { key: "m", className: "dswxMeta" }, t("wizardHint", "四步，随时可以跳过")),
              h("button", { key: "skip", type: "button", className: "dswxBtn", disabled: busy, onClick: endWizard },
                t("wizardSkip", "跳过（我熟）")),
            ]),
            // Step 1: which transports are alive right now.
            wizardStep === 0 ? h("div", { key: "s1" }, [
              h("div", { key: "a", className: "dswxMeta" },
                `微信：${(snapshot?.accounts ?? []).length} 个账号 · 企业微信：${snapshot?.wecom?.bot?.connected ? "✅" : "❌"} · 飞书：${snapshot?.feishu?.connection?.connected ? "✅" : "❌"}`),
              h("div", { key: "b", className: "dswxRow" }, [
                h("button", { key: "q", type: "button", className: "dswxBtn dswxPrimary", disabled: busy || Boolean(pending), onClick: startPairing },
                  pending ? t("pairingNow", "Waiting for the scan…") : t("wizardScan", "扫码接微信")),
                h("span", { key: "h", className: "dswxMeta" }, t("wizardStep1", "企业微信 / 飞书在下面的卡片里填凭据；微信在这里直接扫码。")),
              ]),
            ]) : null,
            // Step 2: one real message, because "configured" and "working" are different states.
            wizardStep === 1 ? h("div", { key: "stest" }, [
              h("div", { key: "a", className: "dswxRow" }, [
                h("button", { key: "b", type: "button", className: "dswxBtn dswxPrimary", disabled: busy, onClick: sendWizardTest }, t("wizardTest", "发一条测试消息")),
                h("span", { key: "h", className: "dswxMeta" }, t("wizardTestHint", "发到最近有消息的那个会话，走的是真实的发送路径")),
              ]),
              wizardTest ? h("div", { key: "r", className: "dswxMeta" }, `${wizardTest.ok ? "✅" : "❌"} ${wizardTest.text}`) : null,
            ]) : null,
            // Step 3: who may talk to it.
            wizardStep === 2 ? h("div", { key: "s2" }, [
              h("label", { key: "a", className: "dswxMeta" }, [
                h("input", { key: "c", type: "checkbox", checked: Boolean(snapshot?.prefs?.requireAllowlist), disabled: busy, onChange: (event) => setAllowlist(event.target.checked) }),
                " " + t("wizardStep2a", "只接受白名单里的会话（默认关）"),
              ]),
              h("label", { key: "b", className: "dswxMeta" }, [
                h("input", { key: "c", type: "checkbox", checked: Boolean(snapshot?.prefs?.friendOnly), disabled: busy, onChange: (event) => setFriendOnly(event.target.checked) }),
                " " + t("wizardStep2b", "只回答一对一，忽略群（默认关）"),
              ]),
            ]) : null,
            // Step 4: the two capabilities that touch this machine.
            wizardStep === 3 ? h("div", { key: "s3" }, [
              h("label", { key: "a", className: "dswxMeta" }, [
                h("input", { key: "c", type: "checkbox", checked: Boolean(snapshot?.prefs?.desktopControl), disabled: busy, onChange: (event) => setDesktop(event.target.checked) }),
                " " + t("wizardStep3a", "桌面控制：鼠标、键盘、截图（默认关）"),
              ]),
              h("label", { key: "b", className: "dswxMeta" }, [
                h("input", { key: "c", type: "checkbox", checked: Boolean(snapshot?.tasks?.commandEnabled), disabled: busy, onChange: (event) => setTaskCommand(event.target.checked) }),
                " " + t("wizardStep3b", "允许定时任务执行本机命令（默认关）"),
              ]),
            ]) : null,
            // Step 5: where generated documents go.
            wizardStep === 4 ? h("div", { key: "s4" }, [
              h("div", { key: "a", className: "dswxRow" }, [
                h("span", { key: "k", className: "dswxName" }, t("officeDir", "保存到")),
                h("input", {
                  key: "i",
                  className: "dswxInput",
                  placeholder: t("officeDirHint", "absolute folder; empty = the bridge's own directory"),
                  value: officeDirInput ?? snapshot?.office?.dir ?? "",
                  disabled: busy,
                  onChange: (event) => setOfficeDirInput(event.target.value),
                }),
                h("button", { key: "s", type: "button", className: "dswxBtn", disabled: busy, onClick: () => setOfficeDir(officeDirInput ?? snapshot?.office?.dir ?? "") }, t("save", "Save")),
              ]),
              h("div", { key: "b", className: "dswxMeta" }, t("wizardStep4", "做完文档可以直接发到聊天里；这里的目录决定相对路径落在哪。")),
            ]) : null,
            h("div", { key: "nav", className: "dswxRow" }, [
              h("button", { key: "p", type: "button", className: "dswxBtn", disabled: busy || wizardStep === 0, onClick: () => setWizardStep(Math.max(0, wizardStep - 1)) }, t("wizardPrev", "上一步")),
              wizardStep < 4
                ? h("button", { key: "n", type: "button", className: "dswxBtn dswxPrimary", disabled: busy, onClick: () => setWizardStep(Math.min(4, wizardStep + 1)) }, t("wizardNext", "下一步"))
                : h("button", { key: "f", type: "button", className: "dswxBtn dswxPrimary", disabled: busy, onClick: endWizard }, t("wizardFinish", "完成")),
            ]),
          ]) : null,

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

          // Scheduled tasks. Creation stays in the chat (a schedule is a sentence, not a form); this is the
          // Office: whether the two programs are there, and where relative paths land. The card is the
          // management half of `/office`; the tools themselves are used from a chat.
          h("div", { key: "office", className: "dswxCard" }, [
            h("div", { key: "head", className: "dswxRow" }, [
              h("strong", { key: "t" }, t("office", "Office documents")),
              h("span", { key: "m", className: "dswxMeta" },
                `${t("officeRead", "read/write")} ${snapshot?.office?.canRead ? "✅" : "❌"}` +
                ` · ${t("officeConvert", "PDF")} ${snapshot?.office?.canConvert ? "✅" : "❌"}`),
            ]),
            h("div", { key: "py", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, "Python"),
              h("span", { key: "v", className: "dswxMeta" }, snapshot?.office?.python ?? t("missing", "not found")),
            ]),
            h("div", { key: "kit", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, "LibreOffice"),
              h("span", { key: "v", className: "dswxMeta" }, snapshot?.office?.kit ?? t("missing", "not found")),
            ]),
            h("div", { key: "dir", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, t("officeDir", "Save to")),
              h("input", {
                key: "i",
                className: "dswxInput",
                placeholder: t("officeDirHint", "absolute folder; empty = the bridge's own directory"),
                value: officeDirInput ?? snapshot?.office?.dir ?? "",
                disabled: busy,
                onChange: (event) => setOfficeDirInput(event.target.value),
              }),
              h("button", {
                key: "s",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: () => setOfficeDir(officeDirInput ?? snapshot?.office?.dir ?? ""),
              }, t("save", "Save")),
              h("button", {
                key: "d",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: () => setOfficeDir(""),
              }, t("useDefault", "Default")),
            ]),
            h("div", { key: "note", className: "dswxMeta" },
              (snapshot?.office?.dirConfigured ? `✔ ${t("officeDirSet", "using the folder above")}` : `(${t("officeDirDefault", "default: the bridge's own directory")})`) +
              ` · ${t("officeHint", "relative paths from the four office tools land here")}`),
          // The GUI port changes on every restart; showing it here (and where it is written) ends the guessing.
          snapshot?.gui?.port
            ? h("div", { key: "gui", className: "dswxMeta" },
                `${t("guiPort", "当前界面端口")}: ${snapshot.gui.port}` +
                (snapshot.gui.previousPort && snapshot.gui.previousPort !== snapshot.gui.port ? ` · ${t("guiPortMoved", "上次")} ${snapshot.gui.previousPort}` : "") +
                ` · ${snapshot.gui.url} · gui-port.json` +
                ` · ${t("guiPortPin", "固定端口：dsh web --port 19387")}`)
            : null,
          ]),

          // list, the pause/resume/delete buttons and the one switch that lets a task run a local command.
          h("div", { key: "tasks", className: "dswxCard" }, [
            h("div", { key: "head", className: "dswxRow" }, [
              h("strong", { key: "t" }, t("tasks", "Scheduled tasks")),
              h("span", { key: "m", className: "dswxMeta" },
                `${snapshot?.tasks?.count ?? 0} ${t("tasksUnit", "")}` +
                (snapshot?.tasks?.nextAt ? ` · ${t("nextRun", "next")} ${new Date(snapshot.tasks.nextAt).toLocaleString()}` : "") +
                (snapshot?.tasks?.failed ? ` · ⚠️ ${snapshot.tasks.failed} ${t("failed", "failed")}` : "")),
              h("label", { key: "c", className: "dswxMeta" }, [
                h("input", {
                  key: "chk",
                  type: "checkbox",
                  checked: Boolean(snapshot?.tasks?.commandEnabled),
                  disabled: busy,
                  onChange: (event) => setTaskCommand(event.target.checked),
                }),
                " " + t("taskCommand", "允许 command 任务执行本机命令"),
              ]),
            ]),
            h("div", { key: "add", className: "dswxRow" }, [
              h("input", {
                key: "w",
                className: "dswxInput",
                placeholder: "daily 08:30 / weekly mon 09:00 / every 30m / once 2026-10-20 09:00",
                value: taskDraft.when ?? "",
                disabled: busy,
                onChange: (event) => setTaskDraft({ ...taskDraft, when: event.target.value }),
              }),
              h("select", {
                key: "k",
                className: "dswxInput",
                value: taskDraft.kind ?? "message",
                disabled: busy,
                onChange: (event) => setTaskDraft({ ...taskDraft, kind: event.target.value }),
              }, [
                h("option", { key: "m", value: "message" }, "message"),
                h("option", { key: "p", value: "prompt" }, "prompt"),
                h("option", { key: "c", value: "command" }, "command"),
              ]),
              h("input", {
                key: "x",
                className: "dswxInput",
                placeholder: t("taskText", "内容 / 提示词 / 命令"),
                value: taskDraft.text ?? "",
                disabled: busy,
                onChange: (event) => setTaskDraft({ ...taskDraft, text: event.target.value }),
              }),
              h("button", { key: "b", type: "button", className: "dswxBtn", disabled: busy, onClick: addTask }, t("taskAdd", "添加")),
            ]),
            taskNotice ? h("div", { key: "notice", className: "dswxMeta" }, `${taskNotice.ok ? "✅ " : "❌ "}${taskNotice.text}`) : null,
            (snapshot?.tasks?.items ?? []).length === 0
              ? h("div", { key: "empty", className: "dswxMeta" }, t("tasksEmpty", "还没有定时任务。在聊天里说「每天 8 点提醒我喝水」就会建一个。"))
              : h("div", { key: "rows" }, (snapshot?.tasks?.items ?? []).map((task) => h("div", { key: task.id, className: "dswxRow" }, [
                h("span", { key: "id", className: "dswxName" }, task.id),
                h("span", { key: "w", className: "dswxMeta" },
                  `${task.when} · ${task.action} · ${task.transport}` +
                  (task.finished ? ` · ✅ ${t("finished", "已跑完")}（${t("finishedHint", "一次性任务，不能暂停")}）`
                    : task.enabled === false ? ` · ⏸ ${t("paused", "已暂停")}`
                      : task.nextLocal ? ` · ${t("nextRun", "next")} ${task.nextLocal}` : "") +
                  (task.lastLocal ? ` · ${t("lastRun", "上次")} ${task.lastLocal} ${task.lastResult === "ok" ? "✅" : `❌ ${task.lastResult ?? ""}`}` : "")),
                // A finished one-off gets "run again" instead of pause: the host pushes the same clock time a day
                // forward and re-enables it, which is the only thing "resume" could sensibly mean here.
                task.finished ? h("select", {
                  key: "step",
                  className: "dswxInput",
                  value: taskSteps[task.id] ?? "day",
                  disabled: busy,
                  onChange: (event) => setTaskSteps({ ...taskSteps, [task.id]: event.target.value }),
                }, [
                  h("option", { key: "d", value: "day" }, t("stepDay", "+1 天")),
                  h("option", { key: "w", value: "week" }, t("stepWeek", "+1 周")),
                  h("option", { key: "m", value: "month" }, t("stepMonth", "+1 月")),
                ]) : null,
                task.finished ? h("button", {
                  key: "again",
                  type: "button",
                  className: "dswxBtn",
                  disabled: busy,
                  onClick: () => rearmTask(task.id, taskSteps[task.id] ?? "day"),
                }, t("runAgain", "再次运行")) : null,
                // The switch behind that button: re-arm automatically after every run.
                task.once ? h("label", { key: "auto", className: "dswxMeta" }, [
                  h("input", {
                    key: "c",
                    type: "checkbox",
                    checked: Boolean(task.autoRearm),
                    disabled: busy,
                    onChange: (event) => setTaskAutoRearm(task.id, event.target.checked),
                  }),
                  " " + t("autoRearm", "完成后再排一次"),
                ]) : null,
                // No toggle for a finished one-off: `dueTasks` ignores a `once` task that has already run,
                // so "resume" would flip a flag and change nothing - a button that lies is worse than no button.
                task.finished ? null : h("button", {
                  key: "t",
                  type: "button",
                  className: "dswxBtn",
                  disabled: busy,
                  onClick: () => toggleTask(task.id, task.enabled === false),
                }, task.enabled === false ? t("resume", "恢复") : t("pause", "暂停")),
                h("button", {
                  key: "d",
                  type: "button",
                  className: "dswxBtn",
                  disabled: busy,
                  onClick: () => removeTask(task.id),
                }, t("remove", "删除")),
              ]))),
          ]),

          h("div", { key: "contacts", className: "dswxCard" }, [
            h("div", { key: "head", className: "dswxRow" }, [
              h("strong", { key: "t" }, t("contacts", "Contacts & groups")),
              // Fetched as GET on purpose: in the reporter's browser every POST from
              // the card was swallowed before reaching the plugin, while GETs always
              // worked. The route answers JSON for GET now, so no new tab is needed.
              // Plain links on purpose: in the reporter's browser the card's fetch
              // never reached the plugin, while navigation did. Same window, so no
              // popup blocker can interfere; use the browser's back button to return.
              h("a", { key: "test", className: "dswxBtn", href: `${BASE}/send-test-approval`, style: { cursor: "pointer" } },
                t("testApproval", "Test approval")),
              h("a", { key: "panel", className: "dswxBtn", href: `${BASE}/panel`, style: { cursor: "pointer" } },
                t("openPanel", "Control panel")),
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
              h("label", { key: "f", className: "dswxMeta" }, [
                h("input", {
                  key: "c",
                  type: "checkbox",
                  checked: Boolean(snapshot?.prefs?.friendOnly),
                  disabled: busy,
                  onChange: (event) => setFriendOnly(event.target.checked),
                }),
                " " + t("friendOnly", "Only answer friends (1:1 chats; group messages are ignored silently)"),
              ]),
              h("label", { key: "i", className: "dswxMeta" }, [
                h("input", {
                  key: "c",
                  type: "checkbox",
                  checked: Boolean(snapshot?.prefs?.interject),
                  disabled: busy,
                  onChange: (event) => setInterject(event.target.checked),
                }),
                " " + t("interject", "Let a new message interject while it is still answering"),
              ]),
            h("label", { key: "r", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: snapshot?.prefs?.retry !== false,
                disabled: busy,
                onChange: (event) => setRetry(event.target.checked),
              }),
              " " + t("retry", "Retry once when a turn fails in the transport"),
            ]),
            // The one switch that arms tools which can click on this machine. It mirrors `/desktop on`
            // and reads the stored preference, never its own copy; on a platform that cannot do it the
            // box is disabled and says why, rather than looking like it failed.
            h("label", { key: "dt", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: Boolean(snapshot?.prefs?.desktopControl),
                disabled: busy || snapshot?.desktop?.supported === false,
                onChange: (event) => setDesktop(event.target.checked),
              }),
              " " + t("desktop", "Let the agent drive this machine's mouse, keyboard and screen") +
                (snapshot?.desktop?.supported === false
                  ? `（${t("desktopUnsupported", "not available on this platform")}：${snapshot.desktop.reason ?? ""}）`
                  : ""),
            ]),
            ]),
            // Delivery: whole answers, or shown while they are written. Only WeCom can do the
            // latter - personal WeChat has no way to edit a message that was already sent - and the
            // hint says so rather than letting the option look broken.
            h("div", { key: "delivery", className: "dswxRow" }, [
              h("label", { key: "l", className: "dswxMeta" }, [
                `${t("deliveryLabel", "Sending")} `,
                h("select", {
                  key: "s",
                  className: "dswxInput",
                  value: String(snapshot?.prefs?.delivery ?? "whole"),
                  disabled: busy,
                  onChange: (event) => setDelivery(event.target.value),
                }, [
                  h("option", { key: "whole", value: "whole" }, t("deliveryWhole", "Whole answer, sent once")),
                  h("option", { key: "stream", value: "stream" }, t("deliveryStream", "Word by word (WeCom only)")),
                ]),
              ]),
              h("span", { key: "h", className: "dswxMeta" }, t("deliveryHint", "Word by word streams the answer while it is written; personal WeChat always receives whole answers.")),
            ]),
            // Text handling: WeChat and WeCom render no markdown, so the default strips it.
            h("div", { key: "format", className: "dswxRow" }, [
              h("label", { key: "l", className: "dswxMeta" }, [
                `${t("formatLabel", "Text")} `,
                h("select", {
                  key: "s",
                  className: "dswxInput",
                  value: String(snapshot?.prefs?.format ?? "plain"),
                  disabled: busy,
                  onChange: (event) => setFormat(event.target.value),
                }, [
                  h("option", { key: "plain", value: "plain" }, t("formatPlain", "Cleaned (drop markdown WeChat cannot render)")),
                  h("option", { key: "raw", value: "raw" }, t("formatRaw", "Raw (send the model's markdown as-is)")),
                ]),
              ]),
              h("span", { key: "h", className: "dswxMeta" }, t("formatHint", "Bold markers, headings, code fences, table rules and math delimiters are stripped; ordinary sentences are untouched.")),
            ]),
            // The switch drops group messages without a word (that is the point), so the
            // count is the only place the silence can be seen.
            snapshot?.prefs?.friendOnly
              ? h("p", { key: "friendNote", className: "dswxMeta" },
                  `${t("friendOnlyOn", "Friends only is on: group messages are ignored silently")} · ${t("groupsSkipped", "skipped")} ${snapshot?.counters?.groupsSkipped ?? 0}`)
              : null,
            snapshot?.prefs?.interject
              ? h("p", { key: "interjectNote", className: "dswxMeta" },
                  `${t("interjectOn", "Interjection is on: a message sent while the agent is working joins that turn")} · ${t("interjected", "interjected")} ${snapshot?.counters?.interjected ?? 0}`)
              : null,
            // Authorization: what this plugin does with an approval request it receives. DSH's own
            // session policy (the file sandbox, whether approvals are asked at all) is a client
            // setting, not a plugin's - the hint says so rather than pretending otherwise.
            h("div", { key: "auth", className: "dswxRow" }, [
              h("label", { key: "l", className: "dswxMeta" }, [
                `${t("authLabel", "Approvals")} `,
                h("select", {
                  key: "s",
                  className: "dswxInput",
                  value: String(snapshot?.prefs?.authorization ?? "moderate"),
                  disabled: busy,
                  onChange: (event) => setAuthorization(event.target.value),
                }, [
                  h("option", { key: "strict", value: "strict" }, t("authStrict", "Strict - always ask, silence means no")),
                  h("option", { key: "moderate", value: "moderate" }, t("authModerate", "Moderate - ask, fall back to the GUI")),
                  h("option", { key: "full", value: "full" }, t("authFull", "Full - never ask here")),
                  h("option", { key: "readonly", value: "readonly" }, t("authReadonly", "View only - refuse anything that asks")),
                ]),
              ]),
              h("span", { key: "h", className: "dswxMeta" }, t("authHint", "Decides only how this plugin handles an approval request; DSH's own session policy is set in DSH.")),
            ]),
            (snapshot?.approvals ?? []).length > 0
              ? h("div", { key: "waiting", className: "dswxRow" }, [
                  h("span", { key: "t", className: "dswxMeta" },
                    `${t("waitingApproval", "Waiting for your approval in WeChat")}: ${(snapshot.approvals ?? []).map((item) => item.toolName ?? "?").join(", ")}`),
                  h("button", { key: "c", type: "button", className: "dswxBtn", disabled: busy, onClick: () => cancelApproval(snapshot.approvals[0]) },
                    t("cancelWaiting", "Cancel")),
                ])
              : null,
            // Token usage: one row per account, over a window the user chooses (1..30 days).
            // The host keeps the ledger; this card only reads and steers it.
            h("div", { key: "tokens", className: "dswxCard" }, [
              h("div", { key: "head", className: "dswxRow" }, [
                h("strong", { key: "t" }, t("tokensTitle", "Token usage")),
                h("span", { key: "u", className: "dswxMeta" },
                  snapshot?.tokens
                    ? `${t("tokenNextReset", "clears in")} ${formatLeft(snapshot.tokens.msUntilReset)}${snapshot.tokens.resets ? ` · ${t("tokenResets", "cleared")} ${snapshot.tokens.resets}×` : ""}`
                    : t("tokenNoUsage", "no usage yet")),
              ]),
              h("div", { key: "controls", className: "dswxRow" }, [
                h("label", { key: "l", className: "dswxMeta" }, [
                  `${t("tokenWindowLabel", "Clear every")} `,
                  h("select", {
                    key: "s",
                    className: "dswxInput",
                    value: String(snapshot?.tokens?.windowDays ?? 30),
                    disabled: busy,
                    onChange: (event) => setTokenWindow(Number(event.target.value)),
                  }, [1, 3, 7, 14, 30].map((days) => h("option", { key: days, value: String(days) }, `${days} ${t("days", "days")}`))),
                ]),
                h("button", { key: "r", type: "button", className: "dswxBtn", disabled: busy, onClick: () => resetTokens() },
                  t("tokenReset", "Clear now")),
              ]),
              (snapshot?.tokens?.accounts ?? []).length === 0
                ? h("p", { key: "none", className: "dswxMeta" }, t("tokenEmpty", "No account has used any tokens in this window."))
                : h("div", { key: "rows", className: "dswxCard" }, (snapshot.tokens.accounts ?? []).map((row) => h("div", { key: row.accountId, className: "dswxRow" }, [
                    h("span", { key: "n", className: "dswxName" }, row.accountId),
                    h("span", { key: "v", className: "dswxMeta" },
                      `${formatCount(row.totalTokens)} · ${t("tokenIn", "in")} ${formatCount(row.inputTokens)} / ${t("tokenOut", "out")} ${formatCount(row.outputTokens)}${row.cachedTokens ? ` / ${t("tokenCache", "cache")} ${formatCount(row.cachedTokens)}` : ""} · ${row.calls} ${t("calls", "call(s)")}`),
                  ]))),
            ]),
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
          h("div", { key: "inbox", className: "dswxHint" }, [
            h("p", { key: "t" }, `${t("inboxLabel", "Inbound files are saved in")}: ${snapshot?.inboxRoot ?? "…"}`),
            // A real form submit (a navigation) rather than a fetch, so it works even
            // in browsers where the card's requests never reach the plugin.
            h("form", { key: "f", action: `${BASE}/panel`, method: "get", className: "dswxRow" }, [
              h("input", { key: "i", className: "dswxInput", name: "inboxDir", placeholder: t("inboxPlaceholder", "absolute path, e.g. D:\\wechat-files") }),
              h("button", { key: "b", type: "submit", className: "dswxBtn" }, t("save", "Save")),
              h("a", { key: "p", className: "dswxBtn", href: `${BASE}/pick-folder`, style: { cursor: "pointer" } }, t("browse", "Browse…")),
            ]),
            h("p", { key: "h", className: "dswxMeta" }, t("inboxFormHint", "Saving opens the control panel; use the back button there to return.")),
          ]),
          // Feishu: configurable from here, and saving reconnects at once. The whole point of this block
          // is that trying a bot no longer costs a `setx` and a DSH restart.
          h("div", { key: "feishu", className: "dswxHint" }, [
            h("p", { key: "t" }, [
              `${t("feishuLabel", "Feishu (飞书 / Lark)")}: `,
              snapshot?.feishu?.configured
                ? `${snapshot.feishu.app ? `app bot${snapshot.feishu.appId ? ` (${snapshot.feishu.appId})` : ""}` : ""}${snapshot.feishu.app && snapshot.feishu.webhook ? " + " : ""}${snapshot.feishu.webhook ? "webhook" : ""}`
                : t("feishuNotConfigured", "Not configured yet"),
              ` · ${t("feishuConnection", "Long connection")}: ${snapshot?.feishu?.connection?.state ?? "?"}`,
              snapshot?.feishu?.connection?.lastError ? ` (${snapshot.feishu.connection.lastError})` : "",
            ]),
            snapshot?.feishu?.savedFields?.length
              ? h("p", { key: "saved", className: "dswxMeta" }, `${t("feishuSavedHere", "saved from this panel")}: ${snapshot.feishu.savedFields.join(", ")}`)
              : null,
            h("div", { key: "scopes", className: "dswxRow" }, [
              h("button", { key: "b", type: "button", className: "dswxBtn", disabled: busy, onClick: copyFeishuScopes },
                t("copyScopes", "复制权限 JSON")),
              h("span", { key: "h", className: "dswxMeta" }, t("scopesHint", "只含本插件用到的 8 项，不是全部权限")),
              scopeCopy ? h("span", { key: "r", className: "dswxMeta" }, `${scopeCopy.ok ? "✅ " : "❌ "}${scopeCopy.text}`) : null,
            ]),
            h("p", { key: "counters", className: "dswxMeta" }, [
              `events ${snapshot?.feishu?.counters?.events ?? 0} · answered ${snapshot?.feishu?.counters?.answered ?? 0}`,
              ` · ignored ${snapshot?.feishu?.counters?.ignored ?? 0} · errors ${snapshot?.feishu?.counters?.errors ?? 0}`,
            ]),
            h("div", { key: "row1", className: "dswxRow" }, [
              h("input", {
                key: "id",
                className: "dswxInput",
                placeholder: t("feishuAppId", "App ID (cli_…)"),
                // Non-secret identifiers come back from /state, so a refresh shows what is saved instead
                // of an empty box; a draft still wins while the person is typing.
                value: feishuDraft.feishuAppId ?? snapshot?.feishu?.appId ?? "",
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuAppId: event.target.value })),
              }),
              h("input", {
                key: "sec",
                className: "dswxInput",
                type: "password",
                autoComplete: "new-password",
                placeholder: snapshot?.feishu?.secretSet
                  ? t("feishuAppSecretSaved", "App Secret: saved (leave blank to keep it)")
                  : t("feishuAppSecretUnset", "App Secret: not set yet"),
                value: feishuDraft.feishuAppSecret ?? "",
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuAppSecret: event.target.value })),
              }),
            ]),
            h("div", { key: "row2", className: "dswxRow" }, [
              h("input", {
                key: "wh",
                className: "dswxInput",
                // /state exposes only a truncated prefix of the stored URL, so it is shown as a hint - never
                // as a value, which would save the ellipsis back into the setting.
                placeholder: snapshot?.feishu?.webhookUrlPrefix
                  ? t("feishuWebhookSaved", `Saved: ${snapshot.feishu.webhookUrlPrefix} (leave blank to keep it)`)
                  : t("feishuWebhookUrl", "Custom webhook URL"),
                value: feishuDraft.feishuWebhookUrl ?? "",
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuWebhookUrl: event.target.value })),
              }),
              h("input", {
                key: "whs",
                className: "dswxInput",
                type: "password",
                autoComplete: "new-password",
                placeholder: t("feishuWebhookSecret", "Webhook signing secret (optional)"),
                value: feishuDraft.feishuWebhookSecret ?? "",
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuWebhookSecret: event.target.value })),
              }),
            ]),
            h("div", { key: "row3", className: "dswxRow" }, [
              h("select", {
                key: "d",
                className: "dswxInput",
                value: feishuDraft.feishuDomain ?? (snapshot?.feishu?.domain === "https://open.larksuite.com" ? "lark" : "feishu"),
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuDomain: event.target.value })),
              }, [
                h("option", { key: "f", value: "feishu" }, "feishu (open.feishu.cn)"),
                h("option", { key: "l", value: "lark" }, "lark (open.larksuite.com)"),
              ]),
              h("input", {
                key: "to",
                className: "dswxInput",
                placeholder: t("feishuTo", "Default receive id (chat_id / open_id)"),
                value: feishuDraft.feishuTo ?? "",
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuTo: event.target.value })),
              }),
              h("input", {
                key: "tenantHost",
                className: "dswxInput",
                // The host a person opens documents on. Without it a created document comes back as an id with an
                // explanation, because a link built from the API host opens a generic page rather than the document.
                placeholder: t("feishuTenantHost", "Tenant host, e.g. ccnje3t5tkro.feishu.cn (needed for document links)"),
                value: feishuDraft.feishuTenantHost ?? snapshot?.feishu?.tenantHost ?? "",
                disabled: busy,
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuTenantHost: event.target.value })),
              }),
            ]),
            h("label", { key: "lc", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                disabled: busy,
                checked: (feishuDraft.feishuLongConnection ?? (snapshot?.feishu?.longConnectionWanted !== false ? "true" : "false")) === "true",
                onChange: (event) => setFeishuDraft((draft) => ({ ...draft, feishuLongConnection: event.target.checked ? "true" : "false" })),
              }),
              ` ${t("feishuLong", "Receive over the long connection (no public URL needed)")}`,
            ]),
            h("div", { key: "btns", className: "dswxRow" }, [
              h("button", {
                key: "s",
                type: "button",
                className: "dswxBtn dswxPrimary",
                disabled: busy,
                // Only what was typed is sent, so a blank field cannot wipe a saved secret.
                onClick: () => setFeishu({
                  ...feishuDraft,
                  feishuLongConnection: feishuDraft.feishuLongConnection ?? (snapshot?.feishu?.longConnectionWanted !== false ? "true" : "false"),
                }),
              }, t("feishuSave", "Save Feishu settings")),
              h("button", {
                key: "c",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                // Deliberate empties: this is the only path that clears a stored field.
                onClick: () => setFeishu({
                  feishuAppId: "",
                  feishuAppSecret: "",
                  feishuWebhookUrl: "",
                  feishuWebhookSecret: "",
                  feishuTo: "",
                }, "clear"),
              }, t("feishuClear", "Clear saved Feishu settings")),
            ]),
            // Documents, spreadsheets and bitables, driven from here. The panel holds no credentials, so every action
            // runs on the host through the same helpers the tools use; one dropdown keeps all of them reachable
            // without a wall of buttons, and the result line shows the outcome or the reason it failed.
            h("div", { key: "docinputs", className: "dswxRow" }, [
              h("input", {
                key: "title",
                className: "dswxInput",
                placeholder: t("feishuOpsTitle", "文档标题（写成文档时用）"),
                value: feishuOps.title ?? "",
                disabled: feishuOpsBusy,
                onChange: (event) => setFeishuOps((ops) => ({ ...ops, title: event.target.value })),
              }),
              h("input", {
                key: "link",
                className: "dswxInput",
                placeholder: t("feishuOpsLink", "文档/表格/多维表格链接或 id"),
                value: feishuOps.link,
                disabled: feishuOpsBusy,
                onChange: (event) => setFeishuOps((ops) => ({ ...ops, link: event.target.value })),
              }),
              h("input", {
                key: "range",
                className: "dswxInput",
                placeholder: t("feishuOpsRange", "范围，如 A1:C5（表格用）"),
                value: feishuOps.range,
                disabled: feishuOpsBusy,
                onChange: (event) => setFeishuOps((ops) => ({ ...ops, range: event.target.value })),
              }),
            ]),
            h("div", { key: "docops", className: "dswxRow" }, [
              h("select", {
                key: "action",
                className: "dswxInput",
                value: feishuOps.action,
                disabled: feishuOpsBusy,
                onChange: (event) => setFeishuOps((ops) => ({ ...ops, action: event.target.value })),
              }, [
                h("option", { key: "create", value: "create" }, "写成飞书文档"),
                h("option", { key: "read", value: "read" }, "读文档"),
                h("option", { key: "append", value: "append" }, "追加到文档"),
                h("option", { key: "sheet-read", value: "sheet-read" }, "读表格范围"),
                h("option", { key: "sheet-write", value: "sheet-write" }, "写表格范围"),
                h("option", { key: "bitable-read", value: "bitable-read" }, "读多维表格"),
                h("option", { key: "bitable-write", value: "bitable-write" }, "写多维表格"),
                h("option", { key: "session", value: "create-from-session" }, "导出当前会话（读宿主会话记录写成文档）"),
              ]),
              h("button", {
                key: "run",
                type: "button",
                className: "dswxBtn dswxPrimary",
                disabled: feishuOpsBusy,
                onClick: async () => {
                  setFeishuOpsBusy(true);
                  try {
                    const out = await api("/feishu-doc", {
                      method: "POST",
                      body: { action: feishuOps.action, link: feishuOps.link, range: feishuOps.range, text: feishuOps.text, title: feishuOps.title ?? "" },
                    });
                    const summary = !out?.ok
                      ? `失败：${out?.error ?? "未知错误"}`
                      : out.url
                        ? `已创建 → ${out.url}（写入 ${out.blocks} 段）`
                        : out.action === "create"
                          ? `已创建（id ${out.documentId}）✓ 写入 ${out.blocks} 段 ✓ ${out.note ?? ""}`
                          : JSON.stringify(out).slice(0, 600);
                    setFeishuOps((ops) => ({ ...ops, ok: Boolean(out?.ok), result: summary }));
                  } catch (problem) {
                    setFeishuOps((ops) => ({ ...ops, ok: false, result: `请求失败：${String(problem?.message ?? problem)}` }));
                  } finally {
                    setFeishuOpsBusy(false);
                  }
                },
              }, t("feishuOpsRun", "执行")),
            ]),
            h("textarea", {
              key: "text",
              className: "dswxInput",
              rows: 4,
              placeholder: t("feishuOpsText", "正文 / 行 JSON（表格写 [[\"a\",\"b\"]]，多维表格写 {\"字段\":\"值\"}）"),
              value: feishuOps.text,
              disabled: feishuOpsBusy,
              onChange: (event) => setFeishuOps((ops) => ({ ...ops, text: event.target.value })),
            }),
            feishuOps.result
              ? h("p", { key: "opsresult", className: "dswxMsg" }, feishuOps.result)
              : null,
            feishuNotice
              ? h("p", { key: "notice", className: "dswxMsg" }, feishuNotice.text)
              : null,
            // Tavily: web search for the chat channels. The key is never echoed back - the panel can say whether one is
            // set and nothing more - and a blank field is never submitted, so a saved key cannot be wiped by accident.
            h("p", { key: "tavilylabel", className: "dswxMeta" }, t("tavilyLabel", "Tavily 联网搜索（微信 / 企业微信 / 飞书 会话可用）")),
            h("div", { key: "tavilyrow", className: "dswxRow" }, [
              h("input", {
                key: "key",
                type: "password",
                className: "dswxInput",
                placeholder: snapshot?.tavily?.keySet
                  ? t("tavilyKeySet", "已设置（留空则不修改）")
                  : t("tavilyKey", "Tavily API Key（tvly-…；留空则用免密钥模式）"),
                disabled: busy,
                onChange: (event) => setTavilyDraft((draft) => ({ ...draft, tavilyApiKey: event.target.value })),
              }),
              h("input", {
                key: "max",
                className: "dswxInput",
                placeholder: t("tavilyMax", "结果条数（默认 5）"),
                defaultValue: String(snapshot?.tavily?.maxResults ?? ""),
                disabled: busy,
                onChange: (event) => setTavilyDraft((draft) => ({ ...draft, tavilyMaxResults: event.target.value })),
              }),
              h("input", {
                key: "depth",
                className: "dswxInput",
                placeholder: t("tavilyDepth", "搜索深度 basic / advanced / fast"),
                defaultValue: String(snapshot?.tavily?.searchDepth ?? ""),
                disabled: busy,
                onChange: (event) => setTavilyDraft((draft) => ({ ...draft, tavilySearchDepth: event.target.value })),
              }),
              h("button", {
                key: "save",
                type: "button",
                className: "dswxBtn dswxPrimary",
                disabled: busy,
                onClick: async () => {
                  const params = new URLSearchParams();
                  for (const [field, value] of Object.entries(tavilyDraft)) {
                    if (String(value ?? "").trim()) params.set(field, String(value));
                  }
                  if (![...params.keys()].length) {
                    setTavilyNotice({ ok: false, text: "没有要保存的内容（留空不会覆盖已存的 key ✓）" });
                    return;
                  }
                  setBusy(true);
                  try {
                    const applied = await api(`/prefs?${params.toString()}`);
                    setTavilyDraft({});
                    setTavilyNotice({ ok: true, text: `已保存（${(applied?.tavilyChanged ?? []).join("、") || "无变化"}）✓ 下一次搜索即生效，不用重启 ✓` });
                    await refresh();
                  } catch (problem) {
                    setTavilyNotice({ ok: false, text: `保存失败：${String(problem?.message ?? problem)}` });
                  } finally {
                    setBusy(false);
                  }
                },
              }, t("tavilySave", "保存 Tavily 设置")),
            ]),
            tavilyNotice ? h("p", { key: "tavilynotice", className: "dswxMsg" }, tavilyNotice.text) : null,
            h("p", { key: "tavilystate", className: "dswxMeta" }, snapshot?.tavily
              ? `Tavily：${snapshot.tavily.keySet ? "已设置 key" : "免密钥模式"} · 结果条数 ${snapshot.tavily.maxResults} · 深度 ${snapshot.tavily.searchDepth}`
              : "Tavily：状态未知"),
            // Browser automation: the machine's own Chrome or Edge, driven over CDP. No download, no npm install, and a
            // profile of its own under $DSH_HOME so the browser a person actually uses is never touched.
            h("p", { key: "browserlabel", className: "dswxMeta" }, t("browserLabel", "浏览器自动化（微信 / 企业微信 / 飞书 会话可用）")),
            h("div", { key: "browserrow", className: "dswxRow" }, [
              h("select", {
                key: "channel",
                className: "dswxInput",
                value: browserDraft.browserChannel ?? snapshot?.browser?.channel ?? "chrome",
                disabled: busy,
                onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserChannel: event.target.value })),
              }, [
                h("option", { key: "chrome", value: "chrome" }, "Chrome"),
                h("option", { key: "edge", value: "edge" }, "Edge"),
              ]),
              h("input", {
                key: "port",
                className: "dswxInput",
                placeholder: t("browserPort", "调试端口（默认 9222）"),
                defaultValue: String(snapshot?.browser?.port ?? ""),
                disabled: busy,
                onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserPort: event.target.value })),
              }),
              h("input", {
                key: "profile",
                className: "dswxInput",
                placeholder: t("browserProfile", "配置目录（默认 $DSH_HOME/browser-profile）"),
                defaultValue: String(snapshot?.browser?.profileDir ?? ""),
                disabled: busy,
                onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserProfileDir: event.target.value })),
              }),
              // A mode, not a checkbox: `erp` is not "not headless", it is a visible window with its own
              // persistent profile - a boolean cannot express that, and guessing made the difference invisible.
              h("label", { key: "mode", className: "dswxMeta" }, [
                t("browserMode", " 模式 ") + " ",
                h("select", {
                  key: "s",
                  className: "dswxInput",
                  disabled: busy,
                  value: browserDraft.browserMode ?? snapshot?.browser?.mode ?? "headless",
                  onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserMode: event.target.value })),
                }, [
                  h("option", { key: "h", value: "headless" }, t("browserModeHeadless", "无头（不弹窗口）")),
                  h("option", { key: "v", value: "headed" }, t("browserModeHeaded", "可见窗口")),
                  h("option", { key: "e", value: "erp" }, t("browserModeErp", "ERP 操作（可见 + 独立 profile）")),
                ]),
              ]),
              // Which browser the tools drive. "我的 Chrome" is the answer to "why is this a different Chrome than mine?":
              // it launches the real profile, so the person's logins and bookmarks are there.
              h("label", { key: "session", className: "dswxMeta" }, [
                t("browserSession", " 会话 ") + " ",
                h("select", {
                  key: "s",
                  className: "dswxInput",
                  disabled: busy,
                  value: browserDraft.browserProfileMode ?? snapshot?.browser?.profileMode ?? "own",
                  onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserProfileMode: event.target.value })),
                }, [
                  h("option", { key: "o", value: "own" }, t("browserSessionOwn", "独立 profile（默认）")),
                  h("option", { key: "c", value: "chrome" }, t("browserSessionChrome", "我的 Chrome（共用登录）")),
                  h("option", { key: "a", value: "attach" }, t("browserSessionAttach", "接管已开的 Chrome")),
                  h("option", { key: "e", value: "extension" }, t("browserSessionExtension", "浏览器扩展（驱动你现在的 Chrome）")),
                ]),
              ]),
              // The extension's address and token, shown so they can be pasted into it. The token is what stops any
              // local process from driving the person's browser.
              snapshot?.browser?.extension
                ? h("p", { key: "extinfo", className: "dswxMeta" },
                  `扩展：${snapshot.browser.extension.connected ? `已连接（${snapshot.browser.extension.tabs} 个标签页）` : "未连接"}`
                  + ` · 地址 ${snapshot.browser.extension.url}`
                  + ` · token ${snapshot.browser.extension.token}`
                  + ` · 最近命令 ${snapshot.browser.extension.lastDriver === "debugger" ? "调试器" : snapshot.browser.extension.lastDriver === "script" ? "脚本" : "—"}`
                  + ` · 调试器用过 ${snapshot.browser.extension.debuggerUses ?? 0} 次`
                  + ` · 目录 ${snapshot.browser.extension.dir ?? ""}`)
                : null,
              h("button", {
                key: "imp",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: importChromeLogin,
                title: t("importLoginHint", "把 Chrome 的 Cookie、书签、已存密码复制进插件 profile；需要先完全退出 Chrome"),
              }, t("importLogin", "导入登录")),
              // The trade-off Chrome forces: a capable debugger (and its banner) or no banner (and script-only reach).
              h("label", { key: "driver", className: "dswxMeta" }, [
                t("extensionDriver", " 扩展驱动 ") + " ",
                h("select", {
                  key: "s",
                  className: "dswxInput",
                  disabled: busy,
                  value: snapshot?.browser?.extension?.driver ?? "debugger",
                  onChange: (event) => setExtensionDriver(event.target.value),
                }, [
                  h("option", { key: "d", value: "debugger" }, t("driverDebugger", "调试器（能力全，会出现调试提示）")),
                  h("option", { key: "s", value: "script" }, t("driverScript", "脚本注入（无提示，截图仅可见区域）")),
                  h("option", { key: "h", value: "hybrid" }, t("driverHybrid", "混合（脚本优先，必要时才用调试器）")),
                ]),
              ]),
              h("button", {
                key: "extinstall",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: installExtension,
                title: t("installExtensionHint", "打包扩展、打开 chrome://extensions、把 token 放进剪贴板"),
              }, t("installExtension", "一键安装扩展")),
              h("label", { key: "proxy", className: "dswxMeta" }, [
                t("browserProxy", " 代理 ") + " ",
                h("input", {
                  key: "i",
                  className: "dswxInput",
                  placeholder: t("browserProxyHint", "127.0.0.1:7897（留空 = 直连）"),
                  disabled: busy,
                  value: browserDraft.browserProxy ?? snapshot?.browser?.proxy ?? "",
                  onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserProxy: event.target.value })),
                }),
              ]),
              // Which sites use the proxy. A file, a command and this field are the same list.
              h("div", { key: "hosts", className: "dswxRow" }, [
                h("span", { key: "k", className: "dswxName" }, t("proxyHosts", "走代理的域名")),
                h("input", {
                  key: "i",
                  className: "dswxInput",
                  placeholder: t("proxyHostsHint", "x.com, *.google.com（留空 = 全部网址走代理）"),
                  disabled: busy,
                  value: proxyHostsDraft ?? (snapshot?.browser?.proxyHosts ?? []).join(", "),
                  onChange: (event) => setProxyHostsDraft(event.target.value),
                }),
                h("button", {
                  key: "s",
                  type: "button",
                  className: "dswxBtn",
                  disabled: busy,
                  onClick: () => saveProxyHosts(proxyHostsDraft ?? (snapshot?.browser?.proxyHosts ?? []).join(", ")),
                }, t("save", "Save")),
              ]),
              h("span", { key: "pacmode", className: "dswxMeta" },
                `${t("proxyScope", "范围")}: ${snapshot?.browser?.proxyMode === "pac" ? t("proxyScopePac", "仅列表内域名（PAC）") : snapshot?.browser?.proxyMode === "global" ? t("proxyScopeGlobal", "全部网址") : t("proxyScopeOff", "关闭")}`),
              h("span", { key: "modenow", className: "dswxMeta" },
                `${t("browserModeNow", "当前")}: ${snapshot?.browser?.mode ?? "?"}${snapshot?.browser?.visible ? " · 👁 " + t("browserVisible", "可见") : " · " + t("browserInvisible", "无窗口")}`),
              h("button", {
                key: "save",
                type: "button",
                className: "dswxBtn dswxPrimary",
                disabled: busy,
                onClick: async () => {
                  const params = new URLSearchParams();
                  for (const [field, value] of Object.entries(browserDraft)) {
                    if (String(value ?? "").trim()) params.set(field, String(value));
                  }
                  if (![...params.keys()].length) {
                    setBrowserNotice({ ok: false, text: "没有要保存的内容" });
                    return;
                  }
                  setBusy(true);
                  try {
                    const applied = await api(`/prefs?${params.toString()}`);
                    setBrowserDraft({});
                    setBrowserNotice({ ok: true, text: `已保存（${(applied?.browserChanged ?? []).join("、") || "无变化"}）✓ 下一次浏览器动作即生效，不用重启 ✓` });
                    await refresh();
                  } catch (problem) {
                    setBrowserNotice({ ok: false, text: `保存失败：${String(problem?.message ?? problem)}` });
                  } finally {
                    setBusy(false);
                  }
                },
              }, t("browserSave", "保存浏览器设置")),
            ]),
            // Its own row, not one more item in the crowded line above: a box squeezed between four inputs is a box
            // nobody finds, which is exactly how this setting went missing the first time.
            h("div", { key: "autobar", className: "dswxRow" }, [
              h("label", { key: "l", className: "dswxMeta" }, [
                h("input", {
                  key: "c",
                  type: "checkbox",
                  disabled: busy,
                  checked: browserDraft.browserHideAutomationBar ?? snapshot?.browser?.hideAutomationBar ?? true,
                  onChange: (event) => setBrowserDraft((draft) => ({ ...draft, browserHideAutomationBar: event.target.checked })),
                }),
                " " + t("browserHideAutomationBar", "隐藏「自动测试软件正在控制 Chrome」提示条（下次打开浏览器生效）"),
              ]),
              h("span", { key: "now", className: "dswxMeta" },
                `${t("browserBarNow", "当前")}: ${snapshot?.browser?.hideAutomationBar === false ? "显示" : "隐藏"}`),
            ]),
            // Where a bare `save: "out.csv"` lands, with a real Windows folder dialog behind 浏览…: the page cannot
            // know an absolute path, so the host asks the machine.
            h("div", { key: "exportdir", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, t("flowExportDir", "流程导出目录")),
              h("input", {
                key: "i",
                className: "dswxInput",
                placeholder: t("flowExportDirHint", "默认 $DSH_HOME/exports"),
                disabled: busy,
                value: exportDirDraft ?? (snapshot?.browser?.exportDir ?? ""),
                onChange: (event) => setExportDirDraft(event.target.value),
              }),
              h("button", { key: "b", type: "button", className: "dswxBtn", disabled: busy, onClick: browseExportDir }, t("browse", "浏览…")),
              h("button", {
                key: "s",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: () => saveExportDir(exportDirDraft ?? snapshot?.browser?.exportDir ?? ""),
              }, t("save", "Save")),
            ]),
            browserNotice ? h("p", { key: "browsernotice", className: "dswxMsg" }, browserNotice.text) : null,
            h("p", { key: "browserstate", className: "dswxMeta" }, snapshot?.browser
              ? `浏览器：${snapshot.browser.channel} · 端口 ${snapshot.browser.port} · ${snapshot.browser.headless ? "无头" : "有窗口"} · 配置目录 ${snapshot.browser.profileDir}`
              : "浏览器：状态未知（重启后可见）"),
            Object.keys(feishuDraft).length
              ? h("p", { key: "unsaved", className: "dswxMeta" }, t("feishuUnsaved", "有未保存的改动 - 点 Save 才生效"))
              : null,
            snapshot?.feishu?.sources
              ? h("p", { key: "sources", className: "dswxMeta" }, `${t("feishuSources", "来源")}: ${Object.entries(snapshot.feishu.sources).map(([field, from]) => `${field}=${from}`).join(" · ")}`)
              : null,
            h("p", { key: "hint", className: "dswxMeta" }, t("feishuFormHint", "Saving takes effect immediately - no DSH restart, no setx.")),
          ]),
          h("p", { key: "wecom", className: "dswxHint" }, [
            `${t("wecomLabel", "WeCom (企业微信)")}: ${snapshot?.wecom?.bot?.authenticated ? "long connection ✓" : snapshot?.wecom?.configured ? (snapshot.wecom.via ?? "configured") : t("notConfigured", "not configured")} · `,
            h("a", { key: "l", href: `${BASE}/wecom`, style: { cursor: "pointer" } }, t("configure", "Configure")),
          ]),
          snapshot?.inboxRoot
            ? null
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
