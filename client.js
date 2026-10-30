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
    /**
     * A saved Feishu block's field name, as a person reads it.
     *
     * `/state` reports field *names* on purpose (a value never leaves the host), and the card used to print them
     * verbatim - "saved from this panel: longConnection" - which reads like a leaked variable.
     */
    const FEISHU_FIELD_LABELS = {
      appId: "App ID",
      appSecret: "App Secret",
      webhookUrl: "Webhook 地址",
      secret: "签名密钥",
      verificationToken: "验证 Token",
      encryptKey: "加密 Key",
      domain: "域名",
      to: "接收人",
      tenantHost: "租户域名",
      longConnection: "长连接",
    };
    function feishuFieldLabel(field) {
      return FEISHU_FIELD_LABELS[field] ?? field;
    }

    const SLOT_BUNDLE_CONFIG = "plugins.bundle.config";
    const SLOT_ROW_CONFIG = "plugins.row.config";
    const BUNDLE_KEY = "dsh-wechat-media";
    const ROW_ID = "wechat-media";
    const LOCALE_NS = "dsh-wechat-media";
    const POLL_MS = 1000;
    /** How often a card with no live pairing refreshes; one second only buys a QR something. */
    const IDLE_POLL_MS = 10000;

    const CSS = `
.dswxCard{display:flex;flex-direction:column;gap:10px;padding:12px 0;min-width:0}
.dswxRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.dswxAccount{border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.dswxName{font-weight:600}
.dswxMeta{font-size:12px;opacity:.7}
.dswxDot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:#b26a00;vertical-align:middle}
.dswxDotOn{background:#2ea043}
.dswxDotErr{background:#d1242f}
.dswxBtn{padding:5px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit;cursor:pointer}
.dswxBtn:disabled{opacity:.5;cursor:default}
.dswxPrimary{border-color:transparent;background:rgba(46,160,67,.18)}
.dswxQr{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:12px;background:rgba(127,127,127,.04)}
.dswxQrImg{width:190px;height:190px;image-rendering:pixelated;border-radius:8px;background:#fff;padding:6px}
.dswxInput{padding:6px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit;min-width:9em;flex:1 1 15em;max-width:100%;box-sizing:border-box}
select.dswxInput{flex:0 1 auto;min-width:11em}
textarea.dswxInput{flex:1 1 100%;min-height:4.5em;resize:vertical}
.dswxMsg{margin:0;font-size:12px}
.dswxErr{color:#d1242f}
.dswxHint{margin:0;font-size:12px;opacity:.7}
.dswxSection{border:1px solid rgba(127,127,127,.2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.dswxSectionTitle{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em;opacity:.85}
.dswxCard > .dswxBtn{align-self:flex-start}
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

/**
 * The typed email values, held outside React so a re-render cannot wipe the box.
 *
 * On globalThis on purpose: the host can re-mount the card, and an object there survives that while a closure would not.
 */
function emailDraftRef() {
  const key = "__dshWechatEmailDraft";
  const scope = typeof globalThis === "object" ? globalThis : {};
  if (!scope[key]) {
    scope[key] = { user: "", smtpHost: "", smtpPort: "", imapHost: "", imapPort: "", smtpPass: "", imapPass: "", allow: "" };
  }
  return scope[key];
}
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
          clipboard: "Let the agent read and write this machine's clipboard",
          ssh: "Let the agent run commands on your SSH hosts (key-based only)",
          sshAdd: "Add host",
          sshRemove: "Remove",
          sshPlaceholder: "name user@host[:port] [identity file]",
          serial: "Let the agent flash boards and read serial output (off by default)",
          keil: "Let the agent build Keil uVision5 projects with the UV4 already installed (off by default)",
          keilProject: "Project",
          keilProjectHint: ".uvprojx path; empty = nothing remembered",
          keilTarget: "Target",
          keilTargetDefault: "(project default)",
          keilBrowse: "Browse…",
          qqTitle: "QQ bot (QQ 开放平台)",
          qqAppId: "appId",
          qqSecret: "clientSecret",
          qqSandbox: "sandbox bot",
          qqSecretSet: "clientSecret (stored; leave empty to keep it)",
          qqSave: "Save and connect",
          qqStatus: "connection",
          qqReconnect: "Reconnect now",
          emailTitle: "Email channel",
          emailEnable: "Receive mail and answer it",
          emailUser: "mailbox address",
          emailSend: "Send a test mail",
          emailCheck: "Fetch now",
          emailAllow: "allowed senders (comma separated; empty = nobody)",
          qqReconnecting: "reconnecting",
          qqRetryIn: "retry in",
          qqAttempts: "attempts",
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
          clipboard: "允许 agent 读写这台机器的剪贴板",
          ssh: "允许 agent 在你的 SSH 主机上执行命令（仅密钥登录）",
          sshAdd: "添加主机",
          sshRemove: "删除",
          sshPlaceholder: "名字 user@host[:port] [identity 文件]",
          serial: "允许 agent 烧录开发板并读取串口输出（默认关）",
          keil: "允许 agent 用本机已装的 UV4 编译 Keil 工程（默认关：flash 会写芯片）",
          keilProject: "工程",
          keilProjectHint: ".uvprojx 路径；留空表示不记",
          keilTarget: "Target",
          keilTargetDefault: "（工程默认）",
          keilBrowse: "浏览…",
          qqTitle: "QQ 机器人（QQ 开放平台）",
          qqAppId: "appId",
          qqSecret: "clientSecret",
          qqSandbox: "沙箱机器人",
          qqSecretSet: "clientSecret（已保存，留空不改）",
          qqSave: "保存并连接",
          qqStatus: "连接状态",
          qqReconnect: "重新连接",
          emailTitle: "邮件通道",
          emailEnable: "接收邮件并回复",
          emailUser: "邮箱地址",
          emailSend: "发一封自测邮件",
          emailCheck: "立即收一次",
          emailAllow: "允许的发件人（逗号分隔；空 = 谁都不回）",
          qqReconnecting: "重连中",
          qqRetryIn: "后重试",
          qqAttempts: "次",
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
        // Keil 的工程与 Target 是「草稿」：输入框里改了但没点保存，不应该顺手写进 prefs。
        const [keilDraft, setKeilDraft] = react.useState({});
        // 宿主对这只机器上 Keil 的回答：UV4 在哪、工程有哪些 Target。卡片不猜，问一次。
        const [keilInfo, setKeilInfo] = react.useState(undefined);
        // The SSH host draft: "name user@host[:port] [identity]". Empty until somebody types one.
        const [sshDraft, setSshDraft] = react.useState("");
        // QQ credentials as typed; undefined = follow /state until edited (the secret never comes back from the host).
        const [qqAppId, setQqAppId] = react.useState(undefined);
        const [qqSecret, setQqSecret] = react.useState("");
        const [qqSandbox, setQqSandbox] = react.useState(undefined);
        /**
         * Email fields as typed, kept outside React state on purpose: a re-render (the card refreshes with /state) must not wipe what is
         * in the box, and a re-mount re-creates the input with this as its default. Controlled inputs here looked "locked" - every
         * keystroke was overwritten by the next refresh.
         */
        const emailDraft = emailDraftRef();
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

        /**
         * One label, translated if the host knows the key.
         *
         * DSH's translator answers with the KEY when no dictionary has an entry (`lookup(...) ?? key`), and this card
         * registers no dictionary of its own - so `translated.length > 0` was true for every miss and the fallback was
         * never reached: 208 distinct labels rendered as raw identifiers (`browserLabel`, `officeDirHint`, ...) while the
         * handful that happened to exist in DSH's own common dictionary looked fine. An answer identical to the key is
         * the host saying "I do not know this one", so it has to be treated as a miss.
         */
        const t = (key, fallback) => {
          try {
            const translated = props?.t?.(key);
            if (typeof translated !== "string") return fallback;
            if (!translated.length || translated === key) return fallback;
            return translated;
          } catch {
            return fallback;
          }
        };

        /**
         * The next live pairing attempt, if any.
         *
         * Computed before the poll effects because both of them key off it: the slow loop runs all the time, the
         * one-second tick only while one of these exists.
         */
        const pending = snapshot?.logins?.find((login) => login.phase === "pending" || login.phase === "redirect" || login.phase === "replace");
        const pairingId = pending?.id;

        /** One request at a time: the two poll paths must not stack copies of the same /state call. */
        const inFlight = react.useRef(false);
        const refresh = react.useCallback(async () => {
          if (inFlight.current) return;
          inFlight.current = true;
          try {
            const next = await api("/state");
            setSnapshot(next);
            setError(undefined);
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            inFlight.current = false;
          }
        }, []);

        /**
         * The card's poll.
         *
         * One slow loop for the whole card, plus a one-second tick only while a QR is on screen. The slow loop
         * alone was not enough: the next delay is chosen when the tick is scheduled, so a pairing that started
         * during a ten-second sleep sat behind that sleep - the QR appeared, then the status froze for up to ten
         * seconds. The guarded `refresh` is what keeps the two from overlapping.
         */
        react.useEffect(() => {
          let stopped = false;
          let timer;
          const tick = async () => {
            if (stopped) return;
            const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
            if (!hidden) await refresh();
            if (stopped) return;
            timer = setTimeout(tick, IDLE_POLL_MS);
          };
          const onVisibility = () => {
            if (typeof document !== "undefined" && document.visibilityState === "visible") void refresh();
          };
          void tick();
          if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
          return () => {
            stopped = true;
            clearTimeout(timer);
            if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
          };
        }, [refresh]);

        // While a pairing is live the QR and its status change every second or so; poll at that pace and stop the
        // moment the attempt ends. `pairingId` is the dependency, not the record: a fresh object arrives on every
        // refresh and would restart the interval each time.
        react.useEffect(() => {
          if (!pairingId) return undefined;
          const fast = setInterval(refresh, POLL_MS);
          return () => clearInterval(fast);
        }, [pairingId, refresh]);

        // Keil 的样子要问宿主，不是猜：UV4 找没找到、当前工程声明了哪些 Target。只依赖工程路径 ——
        // 每次 refresh 都换一个新对象，用它当依赖会打成死循环。
        react.useEffect(() => {
          void loadKeilInfo();
        }, [snapshot?.prefs?.keil?.project]);

        // Safety net: every button is disabled while `busy` is true, so one stuck
        // request would make the whole card look dead. Release it automatically.
        react.useEffect(() => {
          if (!busy) return undefined;
          const timer = setTimeout(() => setBusy(false), 30000);
          return () => clearTimeout(timer);
        }, [busy]);

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
         * Save the QQ block. The host validates appId (digits) and rebuilds the gateway connection, so the card only has to
         * send what was typed - and an empty secret means "keep the stored one", because the host never sends it back.
         */
        /** The multi-agent switch: the same preference `/multiagent on` writes. Off by default. */
        async function setMultiAgent(enabled) {
          setBusy(true);
          try {
            await api("/prefs", { method: "POST", body: { multiAgent: { enabled } } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function saveEmail(patch) {
          setBusy(true);
          try {
            const current = snapshot?.prefs?.email ?? {};
            const next = {
              enabled: current.enabled === true,
              user: (emailDraft.user || current.user || "").trim(),
              smtpHost: (emailDraft.smtpHost || current.smtpHost || "").trim(),
              smtpPort: Number(emailDraft.smtpPort || current.smtpPort || 465),
              imapHost: (emailDraft.imapHost || current.imapHost || "").trim(),
              imapPort: Number(emailDraft.imapPort || current.imapPort || 993),
              folder: current.folder ?? "INBOX",
              pollSeconds: Number(current.pollSeconds ?? 60),
              allowSenders: String(emailDraft.allow || (current.allowSenders ?? []).join(",")).split(/[\s,;]+/).filter(Boolean),
              ...(emailDraft.smtpPass ? { smtpPass: emailDraft.smtpPass } : {}),
              ...(emailDraft.imapPass ? { imapPass: emailDraft.imapPass } : {}),
              ...patch,
            };
            await api("/prefs", { method: "POST", body: { email: next } });
            // The passwords must not linger in the page after a successful save.
            emailDraft.smtpPass = "";
            emailDraft.imapPass = "";
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function emailAction(action) {
          setBusy(true);
          try {
            await api("/email", { method: "POST", body: { action } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * Ask the host to rebuild the QQ connection. The credentials stay on the host (the secret never round-trips), so this is the
         * only retry the card can offer - and after a 1.5.16-style disconnect it is usually not needed at all.
         */
        async function reconnectQQ() {
          setBusy(true);
          try {
            await api("/qq", { method: "POST", body: { action: "reconnect" } });
            await refresh();
          } catch (problem) {
            // A reconnect that fails silently reads as "the button does nothing"; say what happened.
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function saveQQ() {
          setBusy(true);
          try {
            const appId = String(qqAppId ?? snapshot?.prefs?.qq?.appId ?? "").trim();
            const clientSecret = String(qqSecret ?? "").trim();
            const sandbox = qqSandbox ?? snapshot?.prefs?.qq?.sandbox === true;
            await api("/prefs", {
              method: "POST",
              body: { qq: { enabled: Boolean(appId && (clientSecret || snapshot?.prefs?.qq?.clientSecret === "***")), appId, clientSecret, sandbox } },
            });
            setQqSecret("");
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** The clipboard switch: the same preference `/clipboard on` writes, on by default. */
        async function setClipboard(clipboard) {
          setBusy(true);
          try {
            await api("/prefs", { method: "POST", body: { clipboard } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /**
         * Save the whole SSH block. The switch and the host list are one validated object on the host side, so a
         * half-written list cannot land in prefs: the route refuses it and the card shows why.
         */
        async function saveSsh(next) {
          setBusy(true);
          try {
            await api("/prefs", { method: "POST", body: { ssh: next } });
            setSshDraft("");
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function setSshEnabled(enabled) {
          const current = snapshot?.prefs?.ssh ?? { hosts: [] };
          await saveSsh({ enabled, hosts: Array.isArray(current.hosts) ? current.hosts : [] });
        }

        /**
         * The Keil block: the switch `/keil on` writes, plus the project and target it remembers. The build itself
         * runs on the host (`keil_build` with UV4) - this card only decides whether it is allowed to, and on what.
         */
        async function loadKeilInfo() {
          try {
            setKeilInfo(await api("/keil"));
          } catch {
            // 宿主没答（旧版本、或路由还没上）就当不知道，不编一个状态出来。
            setKeilInfo(undefined);
          }
        }

        async function pickKeilProject() {
          setBusy(true);
          try {
            const picked = await api("/keil-pick", { method: "POST", body: {} });
            if (picked?.ok && !picked.cancelled) {
              setKeilDraft({});
              await refresh();
              await loadKeilInfo();
            }
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function setKeil(patch) {
          setBusy(true);
          try {
            const current = snapshot?.prefs?.keil ?? {};
            await api("/prefs", { method: "POST", body: { keil: { ...current, ...patch } } });
            setKeilDraft({});
            await refresh();
            await loadKeilInfo();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        /** The serial switch: the same preference `/serial on` writes. Off by default - flashing writes a board. */
        async function setSerialEnabled(enabled) {
          setBusy(true);
          try {
            const current = snapshot?.prefs?.serial ?? {};
            await api("/prefs", { method: "POST", body: { serial: { ...current, enabled } } });
            await refresh();
          } catch (problem) {
            setError(String(problem?.message ?? problem));
          } finally {
            setBusy(false);
          }
        }

        async function addSshHost() {
          const draft = String(sshDraft ?? "").trim();
          if (!draft) return;
          const [name, spec, identity = ""] = draft.split(/\s+/);
          if (!name || !spec) {
            setError("格式：名字 user@host[:port] [identity 文件]");
            return;
          }
          const current = snapshot?.prefs?.ssh ?? { hosts: [] };
          const hosts = (Array.isArray(current.hosts) ? current.hosts : []).filter((host) => host.name !== name);
          hosts.push({ name, host: spec, ...(identity ? { identity } : {}) });
          await saveSsh({ enabled: Boolean(current.enabled), hosts });
        }

        async function removeSshHost(name) {
          const current = snapshot?.prefs?.ssh ?? { hosts: [] };
          await saveSsh({
            enabled: Boolean(current.enabled),
            hosts: (Array.isArray(current.hosts) ? current.hosts : []).filter((host) => host.name !== name),
          });
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

        /** Which browser commands go to, when Chrome and Edge are both connected. */
        async function setExtensionTarget(mode) {
          setBusy(true);
          try {
            const answer = await api(`/extension-target?mode=${encodeURIComponent(String(mode ?? "auto"))}`);
            setBrowserNotice({
              ok: true,
              text: answer.target === "auto"
                ? `目标浏览器：auto（跟随通道设置，当前 ${answer.browser || "无连接"}）`
                : `目标浏览器：${answer.target}${answer.browser === answer.target ? "（已连接）" : "（未连接）"}`,
            });
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `设置目标失败：${String(problem?.message ?? problem)}` });
          } finally {
            setBusy(false);
          }
        }

        /** Draw a cursor where clicks land: a page overlay, since Chrome exposes no cursor API. */
        async function setExtensionCursor(on) {
          setBusy(true);
          try {
            const answer = await api(`/extension-cursor?on=${on ? 1 : 0}`);
            setBrowserNotice({ ok: true, text: answer.cursor ? "已开启光标显示：每次点击会在页面上画一个红点。" : "已关闭光标显示。" });
            await refresh();
          } catch (problem) {
            setBrowserNotice({ ok: false, text: `设置光标失败：${String(problem?.message ?? problem)}` });
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

          // The QR sits directly under the button that starts it. It used to render at the very bottom of a
          // card several screens tall, so "Add an account" appeared to do nothing unless the person scrolled
          // to the end looking for it.
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
          h("div", { key: "office", className: "dswxCard dswxSection" }, [
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
          // The "pin it" hint carries the port actually in use instead of a number baked into the bundle.
          snapshot?.gui?.port
            ? h("div", { key: "gui", className: "dswxMeta" },
                `${t("guiPort", "当前界面端口")}: ${snapshot.gui.port}` +
                (snapshot.gui.previousPort && snapshot.gui.previousPort !== snapshot.gui.port ? ` · ${t("guiPortMoved", "上次")} ${snapshot.gui.previousPort}` : "") +
                ` · ${snapshot.gui.url} · gui-port.json` +
                ` · ${t("guiPortPin", "固定端口：")}dsh web --port ${snapshot.gui.port}`)
            : null,
          ]),

          // list, the pause/resume/delete buttons and the one switch that lets a task run a local command.
          h("div", { key: "tasks", className: "dswxCard dswxSection" }, [
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

          h("div", { key: "contacts", className: "dswxCard dswxSection" }, [
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
            ]),
            // The chats the bridge has actually seen, under the switches that decide what to do with them.
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
            // Capability switches: each one arms a tool or changes how a turn runs (desktop control, clipboard, SSH,
            // serial, multi-agent, retry, interjection). They shared one flex row with the allowlist, which made a wall of
            // eleven checkboxes where only two were about contacts.
            h("div", { key: "caps", className: "dswxSection" }, [
              h("p", { key: "title", className: "dswxSectionTitle" }, t("capsTitle", "能力开关 / Capabilities")),
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
            // The clipboard: on unless turned off, because a clipboard can hold a password. Same preference as
            // `/clipboard off`, read from the host rather than kept here.
            // Multi-agent: off by default. With it on, a chat may mount its own agent preset, so "each conversation has its
            // own agent" changes what gets mounted rather than merely describing the session map.
            h("label", { key: "ma", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: Boolean(snapshot?.prefs?.multiAgent?.enabled),
                disabled: busy,
                onChange: (event) => setMultiAgent(event.target.checked),
              }),
              " " + t("multiAgent", "Multi-agent: each chat may mount its own agent preset"),
            ]),
            h("label", { key: "cb", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: snapshot?.prefs?.clipboard !== false,
                disabled: busy,
                onChange: (event) => setClipboard(event.target.checked),
              }),
              " " + t("clipboard", "Let the agent read and write this machine's clipboard"),
            ]),
            // SSH: one switch plus the host list, all in the same validated prefs block `/ssh` writes. There is
            // deliberately no password field: key-based auth only.
            h("label", { key: "ss", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: Boolean(snapshot?.prefs?.ssh?.enabled),
                disabled: busy,
                onChange: (event) => setSshEnabled(event.target.checked),
              }),
              " " + t("ssh", "Let the agent run commands on your SSH hosts (key-based only)"),
            ]),
            ...(Array.isArray(snapshot?.prefs?.ssh?.hosts) ? snapshot.prefs.ssh.hosts : []).map((host) =>
              h("div", { key: `sshhost-${host.name}`, className: "dswxMeta" }, [
                `  · ${host.name} → ${host.user ? host.user + "@" : ""}${host.host}:${host.port} `,
                h("button", {
                  key: "rm",
                  type: "button",
                  className: "dswxBtn",
                  disabled: busy,
                  onClick: () => removeSshHost(host.name),
                }, t("sshRemove", "Remove")),
              ])),
            h("div", { key: "sshadd", className: "dswxRow" }, [
              h("input", {
                key: "i",
                className: "dswxInput",
                placeholder: t("sshPlaceholder", "name user@host[:port] [identity file]"),
                value: sshDraft,
                disabled: busy,
                onChange: (event) => setSshDraft(event.target.value),
              }),
              h("button", { key: "b", type: "button", className: "dswxBtn", disabled: busy, onClick: addSshHost }, t("sshAdd", "Add host")),
            ]),
            // Serial: flashing writes a board's flash, so it is off by default like desktop control. The port list and
            // the toolchain discovery live on the host (`serial_ports`), not here: the card is not the flasher.
            h("label", { key: "se", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: Boolean(snapshot?.prefs?.serial?.enabled),
                disabled: busy,
                onChange: (event) => setSerialEnabled(event.target.checked),
              }),
              " " + t("serial", "Let the agent flash boards and read serial output (off by default)"),
            ]),
            // Keil: the switch `/keil on` writes, plus the project and the target it remembers. The build itself runs
            // on the host (`keil_build` drives UV4), so nothing here fetches a target list - the card says what may be
            // touched, and the host answers with the truth about whether UV4 was found.
            h("label", { key: "kl", className: "dswxMeta" }, [
              h("input", {
                key: "c",
                type: "checkbox",
                checked: Boolean(snapshot?.prefs?.keil?.enabled),
                disabled: busy,
                onChange: (event) => setKeil({ enabled: event.target.checked }),
              }),
              " " + t("keil", "Let the agent build Keil uVision5 projects with the UV4 already installed (off by default)"),
            ]),
            // 工程路径独占一行：它是最长的那个值，和其它控件挤在一行就只能看见开头。
            h("div", { key: "klp", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, t("keilProject", "Project")),
              h("input", {
                key: "i",
                className: "dswxInput",
                style: { flex: "1 1 auto" },
                placeholder: t("keilProjectHint", ".uvprojx path; empty = nothing remembered"),
                value: keilDraft.project ?? snapshot?.prefs?.keil?.project ?? "",
                disabled: busy,
                onChange: (event) => setKeilDraft({ ...keilDraft, project: event.target.value }),
              }),
            ]),
            // 第二行放动作：路径已经占满上面一行，浏览 / Target / 保存 在这里才排得开。
            h("div", { key: "klq", className: "dswxRow" }, [
              h("button", {
                key: "b",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                title: t("keilProjectHint", ".uvprojx path; empty = nothing remembered"),
                onClick: () => pickKeilProject(),
              }, t("keilBrowse", "Browse…")),
              h("select", {
                key: "t",
                className: "dswxInput",
                style: { flex: "1 1 12em" },
                title: t("keilTarget", "Target"),
                value: keilDraft.target ?? snapshot?.prefs?.keil?.target ?? "",
                disabled: busy,
                onChange: (event) => setKeilDraft({ ...keilDraft, target: event.target.value }),
              }, [
                h("option", { key: "", value: "" }, t("keilTargetDefault", "(project default)")),
                ...((keilInfo?.targets ?? []).map((name) => h("option", { key: name, value: name }, name))),
                // 存着一个工程里已经删掉的 Target 时，仍把它列出来：静默丢掉一个设置比显示一个过期值更糟。
                ...((keilDraft.target ?? snapshot?.prefs?.keil?.target ?? "") && !(keilInfo?.targets ?? []).includes(keilDraft.target ?? snapshot?.prefs?.keil?.target ?? "")
                  ? [h("option", { key: "stale", value: keilDraft.target ?? snapshot?.prefs?.keil?.target ?? "" }, `${keilDraft.target ?? snapshot?.prefs?.keil?.target ?? ""}（工程里没有）`)]
                  : []),
              ]),
              h("button", {
                key: "s",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: () => setKeil({
                  project: keilDraft.project ?? snapshot?.prefs?.keil?.project ?? "",
                  target: keilDraft.target ?? snapshot?.prefs?.keil?.target ?? "",
                }),
              }, t("save", "Save")),
            ]),
            h("div", { key: "kls", className: "dswxMeta" }, keilInfo
              ? (keilInfo.uv4
                ? `UV4：${keilInfo.uv4.program}${keilInfo.projectError ? ` · 工程有问题：${keilInfo.projectError}` : ""}`
                : `UV4 没找到：${keilInfo.reason}`)
              : ""),
            ]),
          ]),

          // QQ, email and the delivery switches are transport concerns, not contact decisions; they used to
          // sit flat inside the contacts card, one long list with the allowlist checkboxes.
          h("div", { key: "channels", className: "dswxSection" }, [
            h("p", { key: "title", className: "dswxSectionTitle" }, t("channelsTitle", "消息通道 / Channels")),
            // QQ bot: the credentials the gateway needs, and what the connection is doing right now. The status comes
            // from /state's qq field, so a failure shows the platform's own words instead of "not connected".
            h("div", { key: "qq", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, t("qqTitle", "QQ bot (QQ 开放平台)")),
            ]),
            h("div", { key: "qq-id", className: "dswxRow" }, [
              h("input", {
                key: "i",
                className: "dswxInput",
                placeholder: t("qqAppId", "appId"),
                value: qqAppId ?? snapshot?.prefs?.qq?.appId ?? "",
                disabled: busy,
                onChange: (event) => setQqAppId(event.target.value),
              }),
              h("input", {
                key: "s",
                className: "dswxInput",
                type: "password",
                placeholder: snapshot?.prefs?.qq?.clientSecret === "***" ? t("qqSecretSet", "clientSecret（已保存，留空不改）") : t("qqSecret", "clientSecret"),
                value: qqSecret,
                disabled: busy,
                onChange: (event) => setQqSecret(event.target.value),
              }),
              h("label", { key: "sb", className: "dswxMeta" }, [
                h("input", {
                  key: "c",
                  type: "checkbox",
                  checked: qqSandbox ?? snapshot?.prefs?.qq?.sandbox === true,
                  disabled: busy,
                  onChange: (event) => setQqSandbox(event.target.checked),
                }),
                " " + t("qqSandbox", "sandbox bot"),
              ]),
              h("button", { key: "b", type: "button", className: "dswxBtn", disabled: busy, onClick: saveQQ }, t("qqSave", "Save and connect")),
            ]),
            h("div", { key: "qq-status", className: "dswxMeta" }, [
              (() => {
                const qq = snapshot?.qq;
                if (!qq) return `${t("qqStatus", "connection")}: —`;
                const state = qq.ready
                  ? `✅ 已就绪`
                  : qq.reconnecting
                    ? `⏳ ${t("qqReconnecting", "reconnecting")}`
                    : qq.connected
                      ? "⏳ 握手中"
                      : "❌ 未连接";
                // A half-dead connection is only diagnosable if it says *why* and *when it tries again*: "未连接" on its own sends
                // people looking for a bug in their credentials.
                const when = qq.reconnecting && qq.nextAttemptAt
                  ? ` · ${Math.max(0, Math.round((Number(qq.nextAttemptAt) - Date.now()) / 1000))}s ${t("qqRetryIn", "retry in")}`
                  : "";
                const attempts = qq.reconnecting && Number(qq.attempts ?? 0) > 0 ? ` · ${t("qqAttempts", "attempts")} ${qq.attempts}` : "";
                const why = qq.reconnectReason || qq.error;
                return `${t("qqStatus", "connection")}: ${state}${when}${attempts}${qq.user ? ` · ${qq.user}` : ""}${why ? ` · ${why}` : ""}`;
              })(),
              h("button", {
                key: "r",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: reconnectQQ,
                style: { marginLeft: "8px" },
              }, t("qqReconnect", "Reconnect now")),
            ]),
            h("div", { key: "email-title", className: "dswxRow" }, [h("b", { key: "t" }, t("emailTitle", "Email channel"))]),
            h("div", { key: "email-row1", className: "dswxRow" }, [
              h("input", {
                key: "u", className: "dswxInput", placeholder: t("emailUser", "mailbox address"),
                defaultValue: emailDraft.user || snapshot?.prefs?.email?.user || "", disabled: busy,
                onChange: (event) => { emailDraft.user = event.target.value; },
              }),
            ]),
            h("div", { key: "email-row2", className: "dswxRow" }, [
              h("input", {
                key: "s", className: "dswxInput", placeholder: "SMTP host",
                defaultValue: emailDraft.smtpHost || snapshot?.prefs?.email?.smtpHost || "", disabled: busy,
                onChange: (event) => { emailDraft.smtpHost = event.target.value; },
              }),
              h("input", {
                key: "sp", className: "dswxInput", style: { maxWidth: "88px" },
                defaultValue: emailDraft.smtpPort || String(snapshot?.prefs?.email?.smtpPort ?? 465), disabled: busy,
                onChange: (event) => { emailDraft.smtpPort = event.target.value; },
              }),
              h("input", {
                key: "i", className: "dswxInput", placeholder: "IMAP host",
                defaultValue: emailDraft.imapHost || snapshot?.prefs?.email?.imapHost || "", disabled: busy,
                onChange: (event) => { emailDraft.imapHost = event.target.value; },
              }),
              h("input", {
                key: "ip", className: "dswxInput", style: { maxWidth: "88px" },
                defaultValue: emailDraft.imapPort || String(snapshot?.prefs?.email?.imapPort ?? 993), disabled: busy,
                onChange: (event) => { emailDraft.imapPort = event.target.value; },
              }),
            ]),
            h("div", { key: "email-row3", className: "dswxRow" }, [
              h("input", {
                key: "sp", className: "dswxInput", type: "password", placeholder: "SMTP password",
                defaultValue: emailDraft.smtpPass, disabled: busy, onChange: (event) => { emailDraft.smtpPass = event.target.value; },
              }),
              h("input", {
                key: "ip", className: "dswxInput", type: "password", placeholder: "IMAP password",
                defaultValue: emailDraft.imapPass, disabled: busy, onChange: (event) => { emailDraft.imapPass = event.target.value; },
              }),
            ]),
            h("div", { key: "email-row4", className: "dswxRow" }, [
              h("input", {
                key: "a", className: "dswxInput", placeholder: t("emailAllow", "allowed senders (comma separated; empty = nobody)"),
                defaultValue: emailDraft.allow || (snapshot?.prefs?.email?.allowSenders ?? []).join(", "), disabled: busy,
                onChange: (event) => { emailDraft.allow = event.target.value; },
              }),
            ]),
            h("div", { key: "email-actions", className: "dswxRow" }, [
              h("label", { key: "l", className: "dswxMeta" }, [
                h("input", {
                  key: "c", type: "checkbox", checked: snapshot?.prefs?.email?.enabled === true, disabled: busy,
                  onChange: (event) => saveEmail({ enabled: event.target.checked }),
                }),
                " " + t("emailEnable", "Receive mail and answer it"),
              ]),
              h("button", { key: "s", type: "button", className: "dswxBtn", disabled: busy, onClick: () => saveEmail({}) }, t("save", "Save")),
              h("button", { key: "t", type: "button", className: "dswxBtn", disabled: busy, onClick: () => emailAction("test") }, t("emailSend", "Send a test mail")),
              h("button", { key: "k", type: "button", className: "dswxBtn", disabled: busy, onClick: () => emailAction("check") }, t("emailCheck", "Fetch now")),
            ]),
            h("div", { key: "email-status", className: "dswxMeta" }, (() => {
              const status = snapshot?.email;
              if (!status) return "";
              const on = snapshot?.prefs?.email?.enabled === true ? "✅ 开" : "⏸ 关";
              return `${on}${status.reason ? ` · ⚠️ ${status.reason}` : ""}${status.handled ? ` · 已处理 ${status.handled}` : ""}${status.skipped ? ` · 已跳过 ${status.skipped}` : ""}${status.lastError ? ` · ${status.lastError}` : ""}`;
            })()),
            // WeCom is the third channel; it belongs next to QQ and mail, not as a grey line at the bottom of the card.
            h("div", { key: "wecom", className: "dswxRow" }, [
              h("span", { key: "k", className: "dswxName" }, t("wecomLabel", "WeCom (企业微信)")),
              h("span", { key: "s", className: "dswxMeta" }, snapshot?.wecom?.bot?.authenticated
                ? t("wecomConnected", "long connection ✓")
                : snapshot?.wecom?.configured ? (snapshot.wecom.via ?? t("wecomConfigured", "configured")) : t("notConfigured", "not configured")),
              h("a", { key: "l", className: "dswxBtn", href: `${BASE}/wecom`, style: { cursor: "pointer" } }, t("configure", "配置")),
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
          ]),
          // Token usage: one row per account, over a window the user chooses (1..30 days).
          // The host keeps the ledger; this card only reads and steers it.
          h("div", { key: "tokens", className: "dswxCard dswxSection" }, [
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



          error ? h("p", { key: "err", className: "dswxMsg dswxErr" }, error) : null,
          h("div", { key: "inbox", className: "dswxSection" }, [
            h("p", { key: "title", className: "dswxSectionTitle" }, t("inboxTitle", "收件目录 / Inbound")),
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
          h("div", { key: "feishu", className: "dswxSection" }, [
            h("p", { key: "title", className: "dswxSectionTitle" }, t("integrationsTitle", "集成 / Integrations")),
            h("p", { key: "t" }, [
              `${t("feishuLabel", "Feishu (飞书 / Lark)")}: `,
              snapshot?.feishu?.configured
                ? `${snapshot.feishu.app ? `app bot${snapshot.feishu.appId ? ` (${snapshot.feishu.appId})` : ""}` : ""}${snapshot.feishu.app && snapshot.feishu.webhook ? " + " : ""}${snapshot.feishu.webhook ? "webhook" : ""}`
                : t("feishuNotConfigured", "Not configured yet"),
              ` · ${t("feishuConnection", "Long connection")}: ${snapshot?.feishu?.connection?.state ?? "?"}`,
              snapshot?.feishu?.connection?.lastError ? ` (${snapshot.feishu.connection.lastError})` : "",
            ]),
            snapshot?.feishu?.savedFields?.length
              ? h("p", { key: "saved", className: "dswxMeta" }, `${t("feishuSavedHere", "saved from this panel")}: ${snapshot.feishu.savedFields.map(feishuFieldLabel).join(", ")}`)
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
            h("p", { key: "tavilylabel", className: "dswxSectionTitle" }, t("tavilyLabel", "Tavily 联网搜索（微信 / 企业微信 / 飞书 会话可用）")),
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
            h("p", { key: "browserlabel", className: "dswxSectionTitle" }, t("browserLabel", "浏览器自动化（微信 / 企业微信 / 飞书 会话可用）")),
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
            ]),
            // How it runs: a mode, which profile it uses, and which browser the extension's commands go to.
            h("div", { key: "browsermode", className: "dswxRow" }, [
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
              // Which browser commands go to when Chrome and Edge are both connected: without this they race for every
              // command and the answer comes from whichever polled first.
              snapshot?.browser?.extension
                ? h("label", { key: "target", className: "dswxMeta" }, [
                  t("extensionTarget", " 目标浏览器 ") + " ",
                  h("select", {
                    key: "s",
                    className: "dswxInput",
                    disabled: busy,
                    value: snapshot.browser.extension.target ?? "auto",
                    onChange: (event) => setExtensionTarget(event.target.value),
                  }, [
                    h("option", { key: "a", value: "auto" }, t("targetAuto", "auto（跟随通道设置）")),
                    h("option", { key: "c", value: "chrome" }, "Chrome"),
                    h("option", { key: "e", value: "edge" }, "Edge"),
                  ]),
                ])
                : null,
            ]),
            // The extension, its buttons, the proxy and the save action: stacked, one thing per line. In one flex row
            // the proxy host label landed on top of the input next to it and the save button wrapped onto its own line
            // anyway - just without any order.
            h("div", { key: "browserextra", className: "dswxCard" }, [
              // The extension's address and token, shown so they can be pasted into it. The token is what stops any
              // local process from driving the person's browser.
              snapshot?.browser?.extension
                ? h("div", { key: "extinfo" }, [
                  h("p", { key: "s", className: "dswxMeta" },
                    `扩展：${snapshot.browser.extension.connected ? `已连接${(snapshot.browser.extension.clients ?? []).map((c) => c.browser === "edge" ? " Edge" : " Chrome").join("、")}` : "未连接"}`
                    + ` · 目标 ${snapshot.browser.extension.browser || "—"}`),
                  // The two things a person has to paste into the extension options page, together and on their own line.
                  h("p", { key: "u", className: "dswxMeta" },
                    `地址 ${snapshot.browser.extension.url} · token ${snapshot.browser.extension.token}`),
                  h("p", { key: "c", className: "dswxMeta" },
                    `最近命令 ${snapshot.browser.extension.lastDriver === "debugger" ? "调试器" : snapshot.browser.extension.lastDriver === "script" ? "脚本" : "—"}`
                    + ` · 调试器用过 ${snapshot.browser.extension.debuggerUses ?? 0} 次`
                    + ` · 目录 ${snapshot.browser.extension.dir ?? ""}`),
                ])
                : null,
              h("div", { key: "extactions", className: "dswxRow" }, [
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
              // A visible pointer for the person watching: Chrome has no cursor API, so the extension paints one.
              h("label", { key: "cursor", className: "dswxMeta" }, [
                h("input", {
                  key: "c",
                  type: "checkbox",
                  disabled: busy,
                  checked: snapshot?.browser?.extension?.cursor === true,
                  onChange: (event) => setExtensionCursor(event.target.checked),
                }),
                " " + t("extensionCursor", "显示鼠标光标（点击时在页面上画红点）"),
              ]),
              h("button", {
                key: "extinstall",
                type: "button",
                className: "dswxBtn",
                disabled: busy,
                onClick: installExtension,
                title: t("installExtensionHint", "打包扩展、打开 chrome://extensions、把 token 放进剪贴板"),
              }, t("installExtension", "一键安装扩展")),
              ]),
              h("div", { key: "proxyrow", className: "dswxRow" }, [
                h("span", { key: "k", className: "dswxName" }, t("browserProxy", "代理")),
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
              h("div", { key: "proxystate", className: "dswxRow" }, [
                h("span", { key: "pacmode", className: "dswxMeta" },
                  `${t("proxyScope", "范围")}: ${snapshot?.browser?.proxyMode === "pac" ? t("proxyScopePac", "仅列表内域名（PAC）") : snapshot?.browser?.proxyMode === "global" ? t("proxyScopeGlobal", "全部网址") : t("proxyScopeOff", "关闭")}`),
                h("span", { key: "modenow", className: "dswxMeta" },
                  `${t("browserModeNow", "当前")}: ${snapshot?.browser?.mode ?? "?"}${snapshot?.browser?.visible ? " · 👁 " + t("browserVisible", "可见") : " · " + t("browserInvisible", "无窗口")}`),
              ]),
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
            h("div", { key: "kls", className: "dswxMeta" }, keilInfo
              ? (keilInfo.uv4
                ? `UV4：${keilInfo.uv4.program}${keilInfo.projectError ? ` · 工程有问题：${keilInfo.projectError}` : ""}`
                : `UV4 没找到：${keilInfo.reason}`)
              : ""),
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