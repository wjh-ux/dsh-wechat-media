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

/** The `/help` body: every command the dispatcher answers, with its summary. */
export function helpText() {
  const lines = ["dsh-wechat-media 命令："];
  for (const command of COMMANDS) {
    lines.push(`${command.usage} — ${command.summary}`);
  }
  lines.push("", "直接发消息（不以 / 开头）就是和 agent 对话。");
  return lines.join("\n");
}

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
 * @param {string} [input.tokenLine] the one-line token summary (see tokens.js)
 * @param {string} [input.lastInboundAt] ISO time of the last inbound message
 * @param {string} [input.inbox] where inbound media lands
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
  authLine,
  deliveryLine,
  tokenLine,
  lastInboundAt,
  inbox,
} = {}) {
  const lines = [
    "dsh-wechat-media 状态",
    `通道：${transport === "wecom" ? "企业微信长连接" : "个人微信"}`,
    `账号：${accountId || "?"}`,
    `会话：${chatId || "?"}`,
    `DSH 会话：${sessionId || "?"}${generation > 0 ? `（第 ${generation + 1} 段，/new 过的）` : ""}`,
  ];
  const botState = bot
    ? `${bot.authenticated ? "已认证" : bot.connected ? "已连接未认证" : "未连接"}${bot.error ? `（${bot.error}）` : ""}`
    : "未配置";
  lines.push(`企业微信长连接：${botState}`);
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
  if (authLine) lines.push(authLine);
  if (deliveryLine) lines.push(deliveryLine);
  if (tokenLine) lines.push(tokenLine);
  lines.push("", "命令：/help · /status · /new · /stop · /friends · /interject · /auth · /delivery · /tokens");
  return lines.join("\n");
}
