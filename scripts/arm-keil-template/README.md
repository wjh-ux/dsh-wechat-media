# Keil MDK-ARM 最小工程（STM32F103C8T6 / ARMCLANG）

这个工程是**真机验证过**的：在装了 MDK-ARM 5.43a（Arm Compiler for Embedded 6.24）的机器上
`UV4 -r` 编出 `Program Size: Code=444 RO-data=252 RW-data=0 ZI-data=1632`，`.axf` 与 `.hex` 都生成。

它是 `dsh-wechat-media` 的 Keil **ARM** 路径（区别于 C51 那条）的验证工件，也可以直接当新工程骨架用。

## 结构

```
blink.uvprojx             uVision5 工程（器件 STM32F103C8，pack Keil.STM32F1xx_DFP.2.4.1）
blink.sct                 显式散射文件：32K Flash / 10K RAM，向量表排 0x08000000 最前
main.c                    寄存器级点灯（PC13）+ 空的 SystemInit，不依赖 HAL/CMSIS
startup_stm32f10x_md.s    从器件包拷来的启动文件（工程自包含，换机器也能编）
```

## 两条踩过的坑，别重走

**1. 不要用 uVision 自动生成散射文件。** 手写的最小工程第一次链接就报
`*** Scatter Error: no default 'Read/Write' range selected`，然后 `L6031U: Could not open ... .sct`。
原因是内存区没在 Target 对话框里勾选。给一份显式 `blink.sct`（工程里 `<useFile>1</useFile>`）就彻底不依赖它的生成逻辑。

**2. 别拿 pack 里的现成示例当模板。** `Boards\Keil\MCBSTM32C\Blinky` 用了 Keil RTX，uVision 会直接
`Build aborted: uses RTOS support that is part of a Legacy Pack` —— 要装 Legacy Pack 才能编，跟本工程的目的一点关系没有。

## 一台机器两份 Keil 是常态

C51 与 MDK-ARM 是分开安装的，各自带着自己的 UV4.exe：

| 安装位置 | 能编什么 |
|---|---|
| `D:\Keil_v5` | C51（8051） |
| `%LOCALAPPDATA%\Keil_v5` | ARM（ARMCLANG / ARMCC） |

`keil.js` 的 `uv4ForFamily(family)` 按工程 XML 里的器件家族挑对应的那个 UV4 ——
把 ARM 工程交给 C51 的 UV4，它不是警告，是直接报工具链没装。

## 许可

MDK-Community（非商业免费，**代码 ≤ 32KB**）或 30 天评估。激活在
`File → License Management → User-Based License → Activate → License Server → https://mdk-preview.keil.arm.com`。
本工程编出来 444 字节，Lite 版足够。

## 烧录

`UV4 -f` 走工程里 `Options → Debug` 配的调试器（ST-Link / J-Link / ULINK）。
没有调试器时，STM32 可以走 UART 引导：见仓库 `scripts/stm32-template/` 和 `flasher="uart"`。
