# 换芯片只改这个文件的两行，加上链接脚本里的内存大小 ────────────────────────
# 实测于 STM32F103C8T6（克隆片：Chip ID 0x412 / 32K Flash / 20K RAM）

# CPU 内核：F0/F1/F2/F3 = cortex-m3 · F4 = cortex-m4f · F7 = cortex-m7
#           G0/G4/L4 = cortex-m4 · L0 = cortex-m0plus
set(MCU_CPU    cortex-m3)

# 浮点 ABI：没有 FPU 就是 soft；有硬件浮点用 fpv4-sp-d16（并且要加 -mfpu=fpv4-sp-d16）
set(MCU_FPU    soft)

# 链接脚本：内存大小写在它里面，换芯片要一起改
set(MCU_LINKER ${CMAKE_CURRENT_SOURCE_DIR}/stm32f103c8.ld)

# 器件宏：低密度 32K = STM32F103x6 · 中密度 64/128K = STM32F103xB · F407 = STM32F407xx
set(MCU_DEFINE STM32F103x6)
