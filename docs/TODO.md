# 待办 / TODO

这份清单只放**已知的债**，不放"想做的功能"。每一条都写清了为什么、以及怎么验证做完了。
做完的条目直接删掉，不留在文件里当纪念。

## 结构

- [ ] **`index.js` 拆开（1.2 万行 / 665 KB）**
  - 原因：路由、工具定义、回合处理、面板 HTML、命令解析全在一个文件里。2026-10-30 那天三个 bug 都长在这：
    路由与工具定义在两个嵌套作用域，于是 `keilBuildTool is not defined`；`project_build` 拿占位符 `"uv4"` 当
    可执行文件；`UV4 -b` 不带 `-o` 时"成功"了什么都没做。拆成 `routes/`、`tools/`、`turn.js` 之后这三种不可能发生。
  - 验收：`wc -l index.js` 降到 2000 行以内，测试全绿，`/state` 与所有路由行为不变。

- [ ] **路由层冒烟测试**（**已经咬人三次**，见下面的证据）
  - 2026-10-31 三次同形状的故障，全都是"工具自己走一遍"才暴露、手写验证不会暴露：
    1. `keilBuildTool is not defined` —— 路由与工具定义在两个嵌套作用域
    2. `uv4 is not defined` —— 烧录分支引用了编译分支里的变量
    3. `idfInfo is not defined` —— plan 对象漏传了一个字段（`firmwarePlan` 里声明、`execute` 里使用）
  - 共同点：`index.js` 里的数据要穿过「firmwarePlan → return 对象 → execute 解构」三道手，漏一个就炸，
    而语法检查（`node --check`）看不见、纯函数测试也覆盖不到
  - 原因：824 个用例全在决策层（纯函数 + 注入的 exec/fs），**没有一条验证"起插件 → 打路由 → 断言响应"**。
    上面那三个 bug 里至少两个会被这种测试抓住。
  - 验收：一条测试起一个真实的 loopback 服务，逐个打 `/keil`、`/keil-run`、`/project`、`/prefs`，断言状态码与
    关键字段；故意让某个处理函数引用未定义变量时，这条测试必须变红。

## 文档

- [ ] **README 拆到 `docs/`（117 KB / 1595 行）**
  - 原因：`## Keil` 那一节在 700 行之后，想知道"能不能烧 STM32"要先滚过半篇 README —— 这正是 1.17.7 补能力总表的原因。
  - 建议：`docs/keil.md`、`docs/stm32.md`、`docs/esp32.md`、`docs/channels.md`、`docs/troubleshooting.md`；
    README 只留"它能做什么 + 去哪找 + 真机验证表"。
  - 验收：README 缩到 300 行以内，每一节都有一个"详见 docs/xxx.md"的入口。

## 发布流程

- [ ] **deploy key 失效（运维，不是代码）**
  - 现状：本机 `~/.ssh/id_ed25519_dsh` 仍被 GitHub 拒绝（`Permission denied (publickey)`），所有推送靠
    HTTPS + 一次性 token header（不落盘）。公钥指纹 `SHA256:HmOAf8ekq+Td7izBOkU8aUPDw31TffE0ZzD9WTpOQ7o`。
  - 处理：`Settings → Deploy keys` 加回公钥，或改用 Git Credential Manager 登录一次。

- [x] ~~tag 与 release 的顺序~~ —— 2026-10-30 踩过两次：先建 release 会让 GitHub 按当时的 `main` 自动打 tag，
  指向旧提交；删 tag 又会把 release 变成孤儿草稿。**正确顺序：commit → push main → tag → push tag → 建 release。**

## 已经验证过、别再"修"回去的

- `flash` 只在日志里出现 `Erase Done` / `Programming Done` 时才算成功（`UV4 -f` 会退出 0 却什么都不做）。
- 空输出 + 退出码 0 **不是**成功（GUI 程序拒绝启动就长这样）。
- STC 器件走 stcgal，不走 `UV4 -f`；判定依据是工程 XML 里的 `<Vendor>STC</Vendor>`。
- 链接脚本按**芯片自报**的容量配，不按丝印（那块 C8T6 克隆片：标 64K/20K，实际 `0x412` → 32K/10K）。
- `~/.dsh/profiles/desktop` 用 `link:` 指向工作区那份检出，改完必须重启 DSH 才生效。
