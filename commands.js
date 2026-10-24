/**
 * dsh-wechat-media - chat commands.
 *
 * A message that begins with `/` is addressed to the bridge, not to the agent: `/help`,
 * `/status`, `/new`, `/stop`. Only the parsing and the wording live here; who may use a
 * command, how the answer is delivered and what state it touches stays in index.js, so
 * this module is pure and can be tested without WeChat, a harness or a clock.
 *
 * `/new` is the reason the session id carries a *generation*: a chat's conversation must
 * be restartable without deleting the old transcript (see sessionIdFor in index.js).
 */

/** Every command, its aliases and its one-line summary. `/help` is generated from this. */
export const COMMANDS = [
  {
    name: "help",
    aliases: ["h", "?", "帮助"],
    usage: "/help",
    summary: "显示这份命令列表",
  },
  {
    name: "status",
    aliases: ["状态"],
    usage: "/status",
    summary: "桥接状态：账号、本会话、计数、企业微信长连接",
  },
  {
    name: "new",
    aliases: ["reset", "新会话"],
    usage: "/new",
    summary: "开一段新会话（清空上下文；旧会话文件保留在磁盘上）",
  },
  {
    name: "friends",
    aliases: ["friend", "好友"],
    usage: "/friends [on|off]",
    summary: "只处理好友私聊（群消息静默忽略）的开关；不带参数则切换",
  },
  {
    name: "format",
    aliases: ["格式", "清洗"],
    usage: "/format [plain|raw]",
    summary: "文本处理：plain 清洗（去掉微信不渲染的 markdown）/ raw 原样；不带参数则显示当前设置",
  },
  {
    name: "delivery",
    aliases: ["发送方式"],
    usage: "/delivery [whole|stream]",
    summary: "发送方式：整段（写完一次发）/ 逐字（企微里边写边出现）；不带参数则显示当前设置",
  },
  {
    name: "auth",
    aliases: ["授权"],
    usage: "/auth [严格|适中|完全权限|仅查看]",
    summary: "授权档位：严格（每次都问、超时即拒绝）/ 适中（问、超时转 GUI）/ 完全权限（不问）/ 仅查看（直接拒绝需授权的操作）",
  },
  {
    name: "interject",
    aliases: ["插话"],
    usage: "/interject [on|off]",
    summary: "插话开关：agent 正在回复时新消息插进当前回合（关=排队成下一轮）；不带参数则切换",
  },  {
    name: "retry",
    aliases: ["重试"],
    usage: "/retry [on|off]",
    summary: "失败自动重试：回合因传输类错误（超时/连接重置/限流/5xx）失败时自动重试一次；不带参数则切换",
  },
  {
    name: "task",
    aliases: ["定时", "任务"],
    usage: "/task [list|log [id]|rm <id>|off <id>|on <id>|command [on|off]]",
    summary: "定时任务：列表、删除、暂停/恢复；command on 才允许定时执行本机命令",
  },
  {
    name: "doctor",
    aliases: ["体检", "自检"],
    usage: "/doctor",
    summary: "一键体检：通道、Office 工具链、浏览器与代理、定时任务、密钥加密，逐项告诉你能不能跑、不能跑怎么修",
  },
  {
    name: "vscode",
    aliases: ["编辑器", "编辑器桥"],
    usage: "/vscode [status|on|off]",
    summary: "VS Code 桥：编辑器的提问走一个真实会话（同一套模型与工具）；on 开启、off 关闭编辑器请求",
  },
  {
    name: "browser",
    aliases: ["浏览器"],
    usage: "/browser [status|mode headless|headed|erp|session own|chrome|attach|extension|ext|import|launch|proxy 127.0.0.1:7897|off|bar off|on|exportdir D:\\导出|hosts add x.com]",
    summary: "浏览器：mode 管窗口形态；session 管用哪个浏览器（own 独立 profile / chrome 导入书签 / attach 接管已开的 / extension 浏览器扩展驱动你现在的 Chrome）；ext 看扩展地址与 token；import 导入；launch 起专用 Chrome；bar 隐藏自动化提示条；exportdir 导出目录",
  },
  {
    name: "office",
    aliases: ["文档", "表格", "幻灯片"],
    usage: "/office",
    summary: "Office 工具链状态：读、写、转 PDF 分别需要哪个程序，以及现在找到没有",
  },
  {
    name: "desktop",
    aliases: ["桌面"],
    usage: "/desktop [on|off|status]",
    summary: "桌面控制开关：开/关鼠标、键盘、截图、窗口聚焦工具（默认关；这是唯一能操作你屏幕的功能）",
  },
  {
    name: "clipboard",
    aliases: ["clip", "剪贴板"],
    usage: "/clipboard [on|off|status]",
    summary: "剪贴板开关：开/关 clipboard_read、clipboard_write（默认开；读剪贴板可能读到密码这类东西）",
  },
  {
    name: "multiagent",
    aliases: ["多agent", "magent"],
    usage: "/multiagent [on|off|status]",
    summary: "多 agent 开关（默认关）：开了之后每个会话可以挂自己的 agent 预设，各自独立的提示词/工具/模型接线；配置用 /agent",
  },
  {
    name: "agent",
    aliases: ["预设", "preset"],
    usage: "/agent [<预设 id>|model <p>/<m>|model list|model reset|reset|status]",
    summary: "本会话的 agent 预设：不开多 agent 时不生效；开了就按会话记住，下次建 agent 时换用",
  },
  {
    name: "name",
    aliases: ["命名", "rename"],
    usage: "/name <新名字>",
    summary: "给当前会话改个可读名字（QQ 会话的 id 是 openid，改完后列表、任务目标、白名单里都显示这个名字）",
  },
  {
    name: "qq",
    aliases: ["QQ", "qqbot"],
    usage: "/qq [on|off|status]",
    summary: "QQ 机器人开关（QQ 开放平台 · WebSocket 长连接）：appId / clientSecret / 沙箱在面板填写；开关与连接状态用这个命令",
  },
  {
    name: "scrapling",
    aliases: ["抓取", "scrape"],
    usage: "/scrapling [status|proxy <url>|stealth on|off]",
    summary: "抓取引擎 Scrapling：看解释器、改代理与 stealth 默认值；抓取本身用 scrapling_fetch 工具（浏览器指纹，普通 http 被拦的站也能读）",
  },
  {
    name: "serial",
    aliases: ["串口", "flash"],
    usage: "/serial [on|off|ports] · /serial baud 460800 · /serial port COM3",
    summary: "串口烧录开关与默认值：serial_ports 列串口、serial_flash 烧录（ESP-IDF idf.py / esptool / avrdude）、serial_monitor 读打印（默认关；会写板子 Flash、会占用串口）",
  },
  {
    name: "ssh",
    aliases: ["远程"],
    usage: "/ssh [list|on|off] · /ssh add <名字> <user@host[:port]> [identity] · /ssh remove <名字>",
    summary: "SSH 开关与主机列表：ssh_exec 执行命令、ssh_upload / ssh_download 传文件（默认关；只用密钥登录，密码不保存）",
  },
  {
    name: "feishu",
    aliases: ["飞书", "lark"],
    usage: "/feishu [test [to]]",
    summary: "飞书机器人：显示配置状态（应用机器人 / 自定义 webhook），test 发一条自测消息",
  },
  {
    name: "tokens",
    aliases: ["token", "用量"],
    usage: "/tokens [reset|1-30]",
    summary: "各账号 Token 用量：直接看、reset 清零、给天数改清零窗口（1–30 天）",
  },
  {
    name: "stop",
    aliases: ["cancel", "停止"],
    usage: "/stop",
    summary: "打断这条会话里正在跑的回合",
  },
];

/**
 * Read a token window (1..30 days) out of a command's arguments.
 *
 * @returns {number|undefined} the requested number of days, or undefined when the argument
 *   is not a number at all (so the caller can answer with the usage instead of guessing).
 */
export function parseWindowDays(args) {
  const text = String(args ?? "").trim();
  if (!/^\d{1,3}\s*(天|d|day|days)?$/i.test(text)) return undefined;
  const days = Number.parseInt(text, 10);
  return Number.isFinite(days) ? days : undefined;
}

/**
 * Read a switch out of a command's arguments.
 *
 * `/friends on`, `/friends 开` and `/friends true` all mean on. Anything else is
 * `undefined`, which the command reads as "toggle" - so a bare `/friends` and a
 * `/friends nonsense` both flip the switch instead of silently doing nothing.
 *
 * @returns {boolean|undefined}
 */
export function parseSwitch(args) {
  const word = String(args ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "开", "开启", "打开"].includes(word)) return true;
  if (["off", "false", "0", "no", "关", "关闭", "关掉"].includes(word)) return false;
  return undefined;
}

/**
 * The error text `/stop` uses as its cancellation cause, so both reply paths can recognise
 * a stop the user asked for (and not dress it up as an agent failure).
 */
export const STOP_REASON = "已按聊天里的 /stop 打断本轮";

/** Look a command up by name or alias (case-insensitive). */
export function findCommand(name) {
  const wanted = String(name ?? "").toLowerCase();
  return COMMANDS.find((command) => command.name === wanted || command.aliases.includes(wanted));
}

/**
 * Parse a message into a command.
 *
 * @returns {undefined|{ name: string, known: boolean, args: string, raw: string }}
 *   undefined when the message is not a command at all (a bare "/" is a message, and so
 *   is anything whose first character is not "/").
 */
export function parseCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) return undefined;
  const [head, ...rest] = raw.slice(1).split(/\s+/);
  // A bare "/" and "//" are messages, not commands: people type them, and answering with
  // a command list would be a surprise.
  if (!head || head.includes("/")) return undefined;
  const command = findCommand(head);
  return {
    name: command ? command.name : head.toLowerCase(),
    known: Boolean(command),
    args: rest.join(" ").trim(),
    raw,
  };
}

/**
 * What each command is *for*, so 26 of them can be read in six groups instead of one wall.
 *
 * A separate table rather than a field on every entry: the entries stay a list of names and summaries, and a command missing
 * from here still appears (under 其它), so forgetting to classify something degrades the order, never the completeness.
 */
export const COMMAND_GROUPS = Object.freeze([
  ["会话", ["help", "status", "new", "stop"]],
  ["发送", ["format", "delivery", "interject", "retry"]],
  ["授权与联系人", ["auth", "friends", "name"]],
  ["工具", ["desktop", "clipboard", "ssh", "serial", "scrapling"]],
  ["通道", ["feishu", "qq", "vscode", "browser", "office"]],
  ["多 agent", ["multiagent", "agent"]],
  ["运维", ["doctor", "task", "tokens"]],
]);

/** `/clip`, `/剪贴板` - the aliases, inline, so they are discoverable instead of folklore. */
export function aliasText(command) {
  const aliases = Array.isArray(command?.aliases) ? command.aliases.filter(Boolean) : [];
  return aliases.length ? `（${aliases.map((alias) => `/${alias}`).join("、")}）` : "";
}

/** The grouped `/help` body. */
export function helpText() {
  const placed = new Set();
  const lines = [`dsh-wechat-media 命令（${COMMANDS.length} 个）：`];
  for (const [title, names] of COMMAND_GROUPS) {
    const rows = [];
    for (const name of names) {
      const command = findCommand(name);
      if (!command) continue;
      placed.add(command.name);
      rows.push(`${command.usage}${aliasText(command)} — ${command.summary}`);
    }
    if (!rows.length) continue;
    lines.push("", `—— ${title} ——`, ...rows);
  }
  const rest = COMMANDS.filter((command) => !placed.has(command.name));
  if (rest.length) {
    lines.push("", "—— 其它 ——", ...rest.map((command) => `${command.usage}${aliasText(command)} — ${command.summary}`));
  }
  lines.push("", "看单个命令：/help <命令名>（例如 /help agent）", "直接发消息（不以 / 开头）就是和 agent 对话。");
  return lines.join("\n");
}

/**
 * `/help <名字>`: one command in full, including the sub-forms that are easy to get wrong.
 *
 * The examples are here rather than in the summary because the list must stay readable; this is the page you get when you
 * have already decided which command you need.
 */
export function commandHelpText(name, options = {}) {
  const command = findCommand(String(name ?? "").replace(/^\/+/, ""));
  if (!command) return `没有这个命令：/${String(name ?? "").replace(/^\/+/, "")}\n\n${helpText()}`;
  const lines = [
    `/${command.name}${aliasText(command)}`,
    `  用法：${command.usage}`,
    `  作用：${command.summary}`,
  ];
  const meta = COMMAND_META[command.name];
  if (meta?.default) lines.push(`  默认：${meta.default}`);
  if (meta?.restart) lines.push(`  生效：${meta.restart}`);
  const values = COMMAND_VALUES[command.name];
  if (Array.isArray(values) && values.length) {
    lines.push("  可用值：");
    for (const value of values) lines.push(`    · ${value}`);
  }
  // "现状" is computed by the caller: this module has no state, and inventing a cache here is how a help page starts lying.
  const live = Array.isArray(options.live) ? options.live.filter(Boolean) : [];
  if (live.length) {
    lines.push("  现状：");
    for (const line of live) lines.push(`    · ${line}`);
  }
  const examples = COMMAND_EXAMPLES[command.name];
  if (Array.isArray(examples) && examples.length) {
    lines.push("  例：");
    for (const example of examples) lines.push(`    ${example}`);
  }
  lines.push("", "（/help 看全部命令）");
  return lines.join("\n");
}

/**
 * The values a command accepts, when the set is fixed.
 *
 * Printed on the detail page because "on|off" in a usage line does not say whether `/delivery` also takes `stream`, or which
 * four authorization levels exist.
 */
export const COMMAND_VALUES = Object.freeze({
  delivery: ["whole（整段，写完一次发）", "stream（逐字，仅企业微信）"],
  format: ["plain（清洗 markdown）", "raw（原样）"],
  auth: ["严格", "适中", "完全权限", "仅查看"],
  friends: ["on", "off", "（不带参数 = 切换）"],
  interject: ["on", "off", "（不带参数 = 切换）"],
  retry: ["on", "off", "（不带参数 = 切换）"],
  desktop: ["on", "off", "status"],
  clipboard: ["on", "off", "status"],
  ssh: ["on", "off", "list", "add <名字> <user@host[:port]> [identity]", "remove <名字>"],
  serial: ["on", "off", "status", "baud <数值>", "port <COMx>"],
  scrapling: ["status", "proxy <地址>", "proxy off", "stealth on|off"],
  qq: ["on", "off", "status"],
  multiagent: ["on", "off", "status"],
  agent: ["<预设 id>", "model <provider>/<model>", "model list [provider]", "model reset", "reset", "status"],
  tokens: ["reset", "1-30（清零窗口天数）"],
});

/**
 * Per-command facts that a summary cannot hold: the default value, and when a change takes effect.
 *
 * `restart` is the one that prevents surprises: a WeChat-side switch is live immediately, a `/agent` preset only applies when a
 * session next creates an agent, and an edited credential means reconnecting a long connection rather than waiting.
 */
export const COMMAND_META = Object.freeze({
  new: { restart: "立即（旧会话文件保留）" },
  stop: { restart: "立即" },
  friends: { default: "关（群消息也处理）", restart: "立即" },
  retry: { default: "开（失败重试一次）", restart: "立即" },
  interject: { default: "关（新消息排队成下一轮）", restart: "立即" },
  format: { default: "plain（清洗 markdown）", restart: "立即" },
  delivery: { default: "whole（整段）", restart: "立即" },
  auth: { default: "适中（询问，超时转 GUI）", restart: "立即" },
  name: { default: "（未命名时显示 id）", restart: "立即" },
  desktop: { default: "关", restart: "立即" },
  clipboard: { default: "开", restart: "立即" },
  ssh: { default: "关（且主机列表为空）", restart: "立即" },
  serial: { default: "关 · 波特率 115200 · 无默认端口", restart: "立即" },
  scrapling: { default: "直连 · stealth 关", restart: "立即" },
  qq: { default: "关", restart: "保存凭据后立即重连网关" },
  vscode: { default: "开", restart: "立即（编辑器侧自动发现）" },
  browser: { default: "own 独立 profile · 窗口可见", restart: "立即" },
  office: { default: "保存到桥接进程自己的目录", restart: "立即" },
  task: { default: "允许本机命令：关", restart: "立即" },
  tokens: { default: "30 天清零窗口", restart: "立即" },
  multiagent: { default: "关", restart: "立即；已有会话在下次建 agent 时才换" },
  agent: { default: "跟随宿主默认（预设与模型都不覆盖）", restart: "下次新建 agent 时生效" },
  feishu: { default: "应用机器人 / webhook 未配置", restart: "保存凭据后立即重连" },
});

/** The forms worth spelling out per command - the ones a summary cannot hold. */
export const COMMAND_EXAMPLES = Object.freeze({
  help: ["/help", "/help agent"],
  new: ["/new", "/stop（打断正在跑的回合）"],
  friends: ["/friends", "/friends off"],
  format: ["/format plain", "/format raw"],
  delivery: ["/delivery whole", "/delivery stream（仅企业微信）"],
  auth: ["/auth 适中", "/auth 完全权限", "/auth 仅查看"],
  name: ["/name 老板的群"],
  desktop: ["/desktop on", "/desktop off", "/desktop status"],
  clipboard: ["/clipboard on", "/clipboard off", "/clipboard status"],
  ssh: ["/ssh", "/ssh on", "/ssh add nas root@192.168.1.10:22", "/ssh remove nas"],
  serial: ["/serial", "/serial on", "/serial baud 460800", "/serial port COM3"],
  scrapling: ["/scrapling", "/scrapling proxy http://127.0.0.1:7897", "/scrapling stealth on"],
  qq: ["/qq", "/qq on", "/qq off（凭据在面板里填）"],
  vscode: ["/vscode status", "/vscode on", "/vscode off"],
  browser: ["/browser status", "/browser mode headed", "/browser hosts add x.com", "/browser proxy 127.0.0.1:7897"],
  office: ["/office"],
  doctor: ["/doctor"],
  task: ["/task list", "/task rm <id>", "/task command on"],
  tokens: ["/tokens", "/tokens reset", "/tokens 30"],
  multiagent: ["/multiagent", "/multiagent on", "/multiagent off"],
  agent: ["/agent", "/agent minimal", "/agent model deepseek-account/deepseek-v4-pro", "/agent model list", "/agent model reset", "/agent reset"],
});

/** Answers for an unknown command: name what was typed, then the list. */
export function unknownCommandText(name) {
  return `未知命令 /${String(name ?? "").replace(/^\/+/, "")}\n\n${helpText()}`;
}

/** A human size for the status block. */
function size(bytes) {
  const value = Number(bytes) || 0;
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(value / 1024))} KB`;
}

/**
 * Render the `/status` answer.
 *
 * @param {object} input
 * @param {"wechat"|"wecom"} input.transport which bridge carried this command
 * @param {string} input.accountId
 * @param {string} input.chatId
 * @param {string} input.sessionId the session this chat resolves to right now
 * @param {number} [input.generation] how many times /new has restarted this chat
 * @param {object} [input.counters] the plugin's counters
 * @param {object} [input.bot] the WeCom bot's status (`authenticated` / `connected`)
 * @param {number} [input.pendingApprovals] questions waiting for a 1/2 answer
 * @param {boolean} [input.friendOnly] the "only answer friends" switch
 * @param {number} [input.groupsSkipped] how many group messages that switch has dropped
 * @param {boolean} [input.interject] the interjection switch
 * @param {number} [input.interjected] how many messages were steered into a running turn
 * @param {string} [input.authLine] the one-line authorization level (see index.js)
 * @param {string} [input.deliveryLine] the one-line delivery mode (see index.js)
 * @param {string} [input.formatLine] the one-line text format mode (see index.js)
 * @param {string} [input.tokenLine] the one-line token summary (see tokens.js)
 * @param {string} [input.lastInboundAt] ISO time of the last inbound message
 * @param {string} [input.inbox] where inbound media lands
 * @param {string} [input.feishuLine] the one-line Feishu status (see index.js)
 * @param {string} [input.buildLine] which build is answering - version, built and loaded times (see index.js)
 */
export function statusText({
  transport,
  accountId,
  chatId,
  sessionId,
  generation = 0,
  counters = {},
  bot,
  pendingApprovals = 0,
  friendOnly = false,
  interject = false,
  lastInterjection = null,
  retry = true,
  feishuLine,
  buildLine,
  authLine,
  deliveryLine,
  formatLine,
  tokenLine,
  lastInboundAt,
  inbox,
} = {}) {
  const lines = [
    "dsh-wechat-media 状态",
    `通道：${transport === "wecom" ? "企业微信长连接" : transport === "feishu" ? "飞书应用机器人（长连接）" : "个人微信"}`,
    `账号：${accountId || "?"}`,
    `会话：${chatId || "?"}`,
    `DSH 会话：${sessionId || "?"}${generation > 0 ? `（第 ${generation + 1} 段，/new 过的）` : ""}`,
  ];
  // First question anyone asks about a bridge that is misbehaving: which build is this, and is it
  // the build on disk? Answered before the counters, because a stale process explains all of them.
  if (buildLine) lines.push(buildLine);
  const botState = bot
    ? `${bot.authenticated ? "已认证" : bot.connected ? "已连接未认证" : "未连接"}${bot.error ? `（${bot.error}）` : ""}`
    : "未配置";
  // The bot line belongs to WeCom: a Feishu chat has no WeCom bot, and printing "企业微信长连接：未配置"
  // there reads like a fault rather than an unrelated transport.
  if (transport !== "feishu") lines.push(`企业微信长连接：${botState}`);
  lines.push(
    `计数：收到 ${counters.received ?? 0} · 转发 ${counters.forwarded ?? 0} · 拦截 ${counters.blocked ?? 0} · 审批答复 ${counters.answered ?? 0}`,
    `媒体：保存 ${counters.mediaDownloaded ?? 0} · 失败 ${counters.mediaFailed ?? 0}${counters.mediaBytes ? ` · 共 ${size(counters.mediaBytes)}` : ""}`,
  );
  if (pendingApprovals > 0) lines.push(`待审批：${pendingApprovals} 个（回 1 批准 / 2 拒绝）`);
  lines.push(
    `只处理好友私聊：${friendOnly ? "开" : "关"}` +
      (friendOnly ? `（已静默忽略群消息 ${counters.groupsSkipped ?? 0} 条；/friends off 可关）` : "（/friends on 可开）"),
  );
  if (lastInboundAt) lines.push(`最近一条消息：${lastInboundAt}`);
  if (inbox) lines.push(`媒体目录：${inbox}`);
  lines.push(
    `插话：${interject ? "开" : "关"}` + (interject ? `（已插话 ${counters.interjected ?? 0} 次）` : "（/interject on 可开）"),
  );
  lines.push(`失败自动重试：${retry ? "开" : "关"}（传输类错误自动重试一次）`);
  if (lastInterjection) lines.push(`  最近一次判定：${lastInterjection.decision === "steer" ? "已插进当前回合" : "排队"}（${lastInterjection.reason}）`);
  if (feishuLine) lines.push(feishuLine);
  if (authLine) lines.push(authLine);
  if (deliveryLine) lines.push(deliveryLine);
  if (formatLine) lines.push(formatLine);
  if (tokenLine) lines.push(tokenLine);
  lines.push("", "命令：/help · /status · /new · /stop · /friends · /interject · /retry · /feishu · /auth · /delivery · /format · /tokens");
  return lines.join("\n");
}
