# 安装说明书

> 这份文档有 PDF 版：[`docs/deploy.pdf`](deploy.pdf)（6 页，方便带进虚拟机照着做）。
> **它是生成的**：改了本文件之后重新跑 `python scripts/md-to-docx.py docs/deploy.md x.docx` 再导出 PDF，别直接改 PDF。

一句话：**在 Windows 上跑一条命令**，它把环境、插件、VS Code 扩展装好，然后自检。

```powershell
.\scripts\deploy-windows.ps1
```

这份文档说明它到底做了什么、什么时候不该用它、以及出问题怎么查。命令只对 Windows 有效（插件本身不挑平台，但脚本用的 winget、junction、注册表 PATH 都是 Windows 的东西）。

---

## 一、先决条件

| 需要 | 为什么 | 谁负责 |
|---|---|---|
| **Windows 10 1809+ / 11** | 脚本用 winget、目录联接、注册表 PATH | 你（装系统） |
| **DSH 本身（DeepSeek Harness）** | 插件是 DSH 的扩展，不是独立程序 | 你（装 DSH 并启动一次） |
| Node.js 18+ | DSH 与插件工具链都要它 | **脚本会装**（有 winget 用 winget，没有就下官方 msi） |
| Python 3.12 | 串口烧录依赖它 | **脚本会装**（官方安装包，当前用户，带 pip） |
| VS Code + Python 扩展 | 面板/编辑器那条路 | **脚本会装**（官方 User 安装包） |

也就是说：一台**装了 Windows 的空机器**，只要再装好 DSH 并启动一次，剩下的脚本全包。

**DSH 必须先启动过一次**——它会生成 `%USERPROFILE%\.dsh\profiles\desktop\`，插件要装进那个 profile。
脚本会检查这两点，缺了会明确报 `✖` 而不是继续往下装。

> 顺序永远是：装 DSH → 启动一次 → 再跑这个脚本。

---

## 二、一条命令做的十件事

```
[1/10] 前置条件        Windows / Node.js（缺则装）/ DSH 本体 / ~/.dsh / profile
[2/10] Python 本体     没有就用 winget 装 Python 3.12
[3/10] Python 包       pyserial / stcgal / stm32loader（串口烧录用）
[4/10] VS Code         没有就用 winget 装 VS Code，再装 ms-python.python 扩展
[5/10] Arduino         arduino-cli + arduino:avr 核心（-WithEsp32Core 才装 esp32 核心）
[6/10] ARM 工具链       arm-none-eabi-gcc / cmake / ninja / openocd（xpack 便携版）
[7/10] Keil / ESP-IDF  只检测，不安装
[8/10] 插件部署         源码 → profile 的目录联接 + package.json
[9/10] 自带 VS Code 扩展 仓库里的 dsh-wechat-media-vscode-*.vsix
[10/10] 自检            用插件自己的解析器 + 冒烟测试
```

每一步都是**先检查、再动手、最后用真命令验证**：装完 `winget` 的包会再问一次 `python --version`，
装完扩展会再 `code --list-extensions --show-versions` 查一遍。文件在不在不等于能用。

### 没有 winget 的机器（Win10 1809 以下、精简版、部分 VM）

脚本会**退回官方安装包**，三条直链都不经过 winget：

| 组件 | 来源 | 静默参数 |
|---|---|---|
| Node.js LTS | `nodejs.org/dist/<版本>/node-<版本>-x64.msi` | `msiexec /i … /qn` |
| Python 3.12 | `python.org/ftp/python/<版本>/python-<版本>-amd64.exe` | `/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1` |
| VS Code | `update.code.visualstudio.com/latest/win32-x64-user/stable`（302 到真实文件） | `/VERYSILENT /NORESTART /MERGETASKS=!runcode` |

先确认这台机器能连上这三个域名，用 `-ResolveOnly`（只解析地址，不下载、不安装）：

```powershell
.\deploy.ps1 -ResolveOnly
```

```
✔ Node.js v26.13.0
  https://nodejs.org/dist/v26.13.0/node-v26.13.0-x64.msi
✔ Python 3.12.16
  https://www.python.org/ftp/python/3.12.16/python-3.12.16-amd64.exe
✔ VS Code 1.144.0
  https://vscode.download.prss.microsoft.com/…/VSCodeUserSetup-x64-1.144.0.exe
```

三个都 `✔` 就直接去掉 `-ResolveOnly` 跑；有 `✖` 说明那台机器网络到不了那个域名，把失败项的行贴出来。

### 装到哪

| 东西 | 位置 |
|---|---|
| 便携工具链 | `%USERPROFILE%\tools\`（armgcc / cmake / ninja / openocd / arduino-cli） |
| 插件源码 | `%USERPROFILE%\dsh-wechat-media\`（或用 `-LocalPath` 指定已有检出） |
| 进 profile 的方式 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-wechat-media` 目录联接 |
| profile 记账 | `…\profiles\desktop\package.json`：`dependencies` 加 `link:`，`dsh.profile.bundles` 加名字 |

改 `package.json` 之前会先备份成 `package.json.bak-<时间戳>`。

---

## 三、常用写法

```powershell
# 只体检，不改任何东西（第一次装之前建议先跑这个）
.\scripts\deploy-windows.ps1 -CheckOnly

# 完整安装
.\scripts\deploy-windows.ps1

# 只部署插件，环境已经就绪
.\scripts\deploy-windows.ps1 -SkipTools

# 用已有的检出，而不是 clone 一份
.\scripts\deploy-windows.ps1 -LocalPath D:\src\dsh-wechat-media

# 装到另一个 profile（不影响正在用的 desktop）
.\scripts\deploy-windows.ps1 -Profile staging

# 不装 Arduino（省 70 MB；只做 STC / STM32 的人可以这样）
.\scripts\deploy-windows.ps1 -SkipArduino

# 连 ESP32 的 Arduino 核心一起装（多 1.2 GB）
.\scripts\deploy-windows.ps1 -WithEsp32Core

# 离线：不下载、只检测并把已有东西接进 profile
.\scripts\deploy-windows.ps1 -Offline -LocalPath D:\dsh-wechat-media

# 跳过最后的冒烟测试
.\scripts\deploy-windows.ps1 -NoSelfTest
```

---

## 四、虚拟机里怎么装

VM 的问题是"什么都没有，而且网络可能慢"。两种做法：

### A. 联网装（最简单）

```powershell
# 1. 装 Node.js 18+ 和 DSH，启动 DSH 一次，然后关掉它
# 2. 拿脚本
irm https://raw.githubusercontent.com/wjh-ux/dsh-wechat-media/main/scripts/deploy-windows.ps1 -OutFile deploy.ps1
# 3. 体检
.\deploy.ps1 -CheckOnly
# 4. 安装
.\deploy.ps1
```

默认全套约 **570 MB 下载、10~20 分钟**（大头是 arm-none-eabi-gcc 320 MB）。

### B. 离线装（网络差，或 VM 不许联外网）

```powershell
# 宿主机上：把 checkout 和已经装好的工具目录一起拷进 VM
#   C:\dsh-wechat-media            ← git clone 或解压 zip
#   C:\Users\<你>\tools\           ← 宿主机上跑过一次 deploy 后的产物
# VM 里：
.\deploy-windows.ps1 -Offline -LocalPath C:\dsh-wechat-media
```

`-Offline` 的含义是：**不 clone、不 winget、不下载 zip、不装核心**。已经有的照常验证并接进 profile，
缺的逐条报出来（`–` 行），不会卡在下载上。

---

## 五、装完做什么

1. **重启 DSH**（插件在启动时加载）
2. 确认在线：打开 `http://127.0.0.1:19387/dsh-wechat-media/state`，应返回带 `version` 的 JSON
3. **危险能力默认关**，用到再开：
   ```
   /serial on      串口（烧录 STC / STM32）
   /keil on        Keil 编译与烧录
   /ssh on         远程执行
   /task command on 定时任务里的本地命令
   ```

---

## 六、脚本装不了、要你自己装的两件事

| | 为什么 | 文档 |
|---|---|---|
| **Keil（C51 / MDK-ARM）** | 要注册账号下载，许可分商业/非商业 | [docs/keil-arm-install.md](keil-arm-install.md)：下载直链、852 MB 安装包的 SHA256、器件包、四个坑 |
| **ESP-IDF** | Espressif 安装器要选目标芯片与组件，交互式 | 脚本只检测 `export.ps1`，缺了会提示 |

没有它们也能用：Keil 工程之外的四种（CMake/Make、Arduino、ESP-IDF 若已装、以及纯串口烧录）照常。

---

## 七、出问题怎么查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `✖ 没找到 DSH 本体` | DSH 没装，或装到了非默认位置 | 装 DSH 并启动一次；非默认位置见下面"改路径" |
| `– 还没有 profiles\` | DSH 装了但没启动过 | 启动一次再关掉 |
| `✖ winget 装完但命令还是找不到` | PATH 没刷新，或安装被取消 | 重新登录一次，或手动 `winget install Python.Python.3.12` |
| `– 缺 pip 包` 且装不上 | python 的 `--user` 目录不可写 | 用 `python -m pip install --user pyserial stcgal stm32loader` 手动装看报错 |
| `✖ 那是真实目录，不是联接` | `node_modules\dsh-wechat-media` 是真目录（以前手动拷过） | 确认没用了再移走；脚本不会替你删 |
| 自检里 `stcgal：插件找不到` | 装到别的 python 环境且不在 PATH | 不影响插件启动；要烧 STC 就 `pip install --user stcgal`，或把它的 exe 放进 PATH |
| 冒烟测试失败 | 插件代码问题 | 把输出的最后十几行发出来；`node test/smoke.test.mjs` 可单独跑 |

### 改路径

```powershell
# 工具链装到别处
.\scripts\deploy-windows.ps1 -ToolsRoot D:\tools
# 插件源码放别处
.\scripts\deploy-windows.ps1 -LocalPath D:\work\dsh-wechat-media
# 装到别的 profile
.\scripts\deploy-windows.ps1 -Profile staging
```

---

## 八、卸载

插件是"一条联接 + 两行配置"，卸起来就是反过来：

```powershell
# 1. 删联接（不要删目标目录！）
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-wechat-media" -Force

# 2. 从 profile 的 package.json 里去掉
#    dependencies."dsh-wechat-media" 和 dsh.profile.bundles 里的 "dsh-wechat-media"
#    改完重启 DSH
```

工具链（`%USERPROFILE%\tools`）和 pip 包留着不影响 DSH，不需要可以自行删除。
VS Code 扩展：`code --uninstall-extension wjh-ux.dsh-wechat-media-vscode`。

---

## 九、为什么脚本把「验证」写得很啰嗦

这个脚本第一版在三处栽过跟头，全部是"看起来装好了其实没用"：

1. **`Read-Version` 的第二个参数叫 `$args`** —— 那是 PowerShell 的自动变量，于是 `--version` 从来没传进去，
   每个工具的"版本"都显示成 `Usage` 或 `fatal error: no input files`。
2. **新建 profile 时只放了自己的插件** —— `bundles` 里缺 `@deepseek-ai/dsh-base` 和 `dsh-web-app`，DSH 起不来。
3. **`stcgal` 判断错** —— 它装在某台机器的 ESP-IDF python 环境里，是个独立 exe；用系统 python `import stcgal`
   会误报缺失，而实际烧录一切正常。

所以现在的判断标准是：**用插件自己的解析器（`scripts/probe-tools.mjs` 调 `which()` / `serialSupport()`）
回答它能看到什么**，而不是脚本猜 PATH。跑一遍比读十遍代码可靠。
