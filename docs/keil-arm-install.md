# 装 Keil MDK-ARM（让 `project_build` 能编 ARM 工程）

这份文档记的是**真机走过一遍**的流程：2026-10-31 在 `wjh` 这台机器上装好 MDK-ARM 5.43a，
`scripts/arm-keil-template/` 编出 `Code=444 RO-data=252 RW-data=0 ZI-data=1632`。
每一步都写了"怎么判断它成了"，以及我们实际踩到的坑。

C51（8051）那条路不需要这个——`D:\Keil_v5` 里已有的 UV4 就够，装 MDK 不会影响它。

## 1. 下载

**入口页**：<https://www.keil.com/demo/eval/arm.htm>
必须填一张联系信息表（姓名 / 邮箱 / 公司 / 职位 / 国家 / 电话），提交后才出现下载链接。
表单没有隐藏直链——提交前后 DOM 里都没有 `.exe`，链接是 POST 之后由服务端给出的。

**直链**（2026-10-31 实测 200，`application/x-msdownload`）：

```
https://www.keil.com/fid/tix4w9w320dj1wm4rg91k9103m3osy2wvo3fd1/files/eval/mdk543a.exe
```

`/fid/<令牌>/` 这一段是表单提交时分配的，**不保证长期有效**。失效就重新走一次表单，
或者把 URL 里的文件名换成当时的版本（比如 `mdk544.exe`）。

**校验**（这笔账要能对上，不能只看"下载完成"）：

| 项 | 值 |
|---|---|
| 文件名 | `MDK543a.exe`（浏览器重名时会存成 `MDK543a (1).exe`） |
| 大小 | **852.1 MB (893,488,656 字节)** |
| 版本信息 | `uVision 1.39.0.7 · uVision Setup` |
| SHA256 | `5702ED2093680932DA3466134885B2141297099DF106E5090C38F65A9510B7CA` |
| 数字签名 | **没有签名** |

未签名是**正常现象**——Keil 自己在下载页写着 "these installers do not include protection against tampering"，
建议在只放安装包的目录里执行。所以大小和 SHA256 比签名更值得核对。

## 2. 安装

GUI 安装，三步：

1. **Folder Selection**：安装器默认装到 `C:\Users\<你>\AppData\Local\Keil_v5`。
   想和已有 C51 合并到一个根就点 Core 那栏的 `Browse` 改成 `D:\Keil_v5`——**但两个根也能正常工作**（见第 5 节）。
2. **Customer Information**：姓名 / 公司 / 邮箱，装完写进 `TOOLS.INI` 的 `[UV2]` 段（`NAME` / `ORGANIZATION` / `EMAIL`）。
3. **Setup Status**：准备 10~15 分钟，2G 以上磁盘（本机实测写入约 3.1 GB）。

装完判断标准：

```
<安装根>\UV4\UV4.exe                      ← uVision 本体（5.43 是 12.2 MB）
<安装根>\ARM\ARMCLANG\bin\armclang.exe    ← Arm Compiler for Embedded 6.x
<安装根>\TOOLS.INI                        ← 里面 TOOL_VARIANT=mdk_lite
```

**MDK 5.43 只带 AC6（ARMCLANG），不带 AC5（ARMCC）。** 老工程若写着 `<uAC6>0</uAC6>` 会报
"Arm Compiler 5 not installed"，要么在 `Options → Target` 里切到 v6，要么另装 Arm Compiler 5。

## 3. 器件包（不装这个，uVision 不认识 STM32）

直链（47.9 MB，实测 200）：

```
https://www.keil.com/pack/Keil.STM32F1xx_DFP.2.4.1.pack
```

`.pack` 就是个 zip，里面有 `Keil.STM32F1xx_DFP.pdsc`（器件描述）和各容量的 Flash 算法
（`Flash/STM32F10x_128.FLM` 等）。装法是解压到 CMSIS pack 根目录，目录名必须是
`<包供应商>\<包名>\<版本>`：

```powershell
$rte = "$env:LOCALAPPDATA\Arm\Packs"
$dest = Join-Path $rte 'Keil\STM32F1xx_DFP\2.4.1'
New-Item -ItemType Directory -Force $dest | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory("Keil.STM32F1xx_DFP.2.4.1.pack", $dest)
```

pack 根目录从 `TOOLS.INI` 的 `RTEPATH=` 读（本机是 `%LOCALAPPDATA%\Arm\Packs`，注意**不是** `ArmPacks`）。

也可以用 MDK 自带的包管理器（更规范，会写好自己的索引）：

```
%LOCALAPPDATA%\Keil_v5\ARM\cmsis-toolbox\bin\cpackget.exe
```

判断装好：`<pack 根>\Keil\STM32F1xx_DFP\2.4.1\Keil.STM32F1xx_DFP.pdsc` 存在，且里面能搜到
`Dname="STM32F103C8"`。

## 4. 编译验证

```
project_build(dir="<工程目录>", action="rebuild")
```

期望（本机实测 2.4 秒）：

```
✅ 编译通过（".\Objects\blink.axf" - 0 Error(s), 0 Warning(s).，2447ms）
Target：STM32F103C8
程序大小：Code=444 RO-data=252 RW-data=0 ZI-data=1632
HEX：.\Objects\blink.hex
```

`Program Size` 里出现 `Code= / RO-data= / RW-data= / ZI-data=` 就是 ARM 方言（C51 是 `data= / xdata= / code=`），
插件两种都解析，所以光看回复就能分清走的是哪个编译器。

## 5. 一台机器两份 Keil：正常，但要分清楚

C51 和 MDK-ARM 是分开安装的产品，各有自己的 `UV4.exe`：

| 安装位置 | 能编 |
|---|---|
| `D:\Keil_v5` | C51（8051） |
| `%LOCALAPPDATA%\Keil_v5` | ARM（ARMCLANG） |

`keil.js` 的 `uv4ForFamily(family)` 读工程 XML 里的器件家族（`<Vendor>` / `<Device>` / `Cpu`），
再挑装对应编译器的那个 UV4。**把 ARM 工程交给 C51 的 UV4 不是警告，是直接报工具链没装。**

## 6. 许可

安装器默认给 `TOOL_VARIANT=mdk_lite`：**代码上限 32 KB**，够点灯和小工程。

非商业用途可以激活 Community（免费、无 32 KB 限制）：

```
uVision → File → License Management → User-Based License
→ Activate / Deactivate… → 弹窗右上角 License Server…
→ 地址 https://mdk-preview.keil.arm.com → Query
→ 选 "Keil MDK Community" → Activate → Close 两次
```

## 7. 烧录

**没有调试器也能烧：Keil 的 hex 走 UART 引导。** 2026-10-31 实测：`blink.hex` → `stm32loader` 写进芯片，
`Verification OK`，读回 696 字节 SHA256 与源文件一致。

中间有两个硬限制，插件已经替你处理掉：

1. `stm32loader` 读 `.hex` 需要 `intelhex` 包——**现在不需要装**，插件自己把 hex 转成 bin
2. 就算装了也不行：`stm32loader/hexfile.py:27` 有 `assert addresses[0] == 0`，而 Keil 的 hex 从 `0x08000000` 起

所以插件在烧之前做一次 `hexToBin()`，并检查两件事：

```
起始地址必须是 0x08000000（不是就拒绝，说明这不是能直接烧的 STM32 固件）
字节数应等于 Program Size 的 Code + RO-data（本机 696 = 444 + 252）
```

**这条对账最值得看**：scatter 文件或链接脚本写错时，灯不闪只是"没反应"，而这行数字会立刻对不上。

```powershell
# 有 ST-Link 时
project_build(action="flash")                      # → UV4 -f
# 没有调试器时（BOOT0=1 + 复位）
project_build(action="flash", flasher="uart", port="COM3")
```

`UV4 -f` 用的是工程里 `Options → Debug` 配的调试器（ST-Link / J-Link / ULINK）。
没配调试器时 `UV4 -f` 会**退出 0 但什么都没写**——插件因此要求日志里出现
`Erase Done` / `Programming Done` 才算成功（这条规则是 STC 8061 那次假成功换来的）。

没有调试器也能烧 STM32：走 UART 引导（`flasher="uart"`，`stm32loader`），见 `scripts/stm32-template/README.md`。

## 踩过的坑（都在这次安装里真实发生过）

1. **别拿器件包里的示例工程当模板。** `Boards\Keil\MCBSTM32C\Blinky` 用了 Keil RTX，uVision 直接
   `Build aborted: uses RTOS support that is part of a Legacy Pack`，还要额外装 Legacy Pack。
2. **别依赖 uVision 自动生成散射文件。** 手写最小工程第一次链接报
   `*** Scatter Error: no default 'Read/Write' range selected`，接着 `L6031U: Could not open ... .sct`。
   签入一份显式 `.sct`（工程里 `<useFile>1</useFile>` + `<ScatterFile>`）就不依赖它的生成逻辑。
3. **`UV4.exe` 是 GUI 程序。** PowerShell 里 `& UV4.exe -b ...` 不会等它结束（拿不到退出码、日志也可能是空的），
   要用 `Start-Process -Wait -PassThru`；插件用的是 `child_process.execFile`，本身会等。
4. **下载中断的文件会静静躺在那儿。** 浏览器超时留下 608 MB 的残片和完整的 852 MB 并存，
   按大小 + SHA256 分辨，不要按文件名。
