/* STM32F103C8T6 · 寄存器级点灯（PC13）· 不依赖 HAL / StdPeriph / CMSIS
 * 这个工程专为验证 dsh-wechat-media 的 Keil ARM 路径而建：
 * 只要它能编过、能烧进去、LED 会闪，就说明 UV4 + ARMCLANG 那条链路是通的。 */
#include <stdint.h>

#define PERIPH_BASE   0x40000000UL
#define APB2PERIPH    (PERIPH_BASE + 0x00010000UL)
#define AHBPERIPH     (PERIPH_BASE + 0x00020000UL)
#define GPIOC_BASE    (APB2PERIPH + 0x1000UL)
#define RCC_BASE      (AHBPERIPH + 0x1000UL)
#define RCC_APB2ENR   (*(volatile uint32_t *)(RCC_BASE + 0x18))
#define GPIOC_CRH     (*(volatile uint32_t *)(GPIOC_BASE + 0x04))
#define GPIOC_ODR     (*(volatile uint32_t *)(GPIOC_BASE + 0x0C))

/* 启动文件会调用 SystemInit；这里给个空的，省掉 system_stm32f10x.c 和 CMSIS 头文件 */
void SystemInit(void) { }

int main(void) {
  RCC_APB2ENR |= (1u << 4);
  GPIOC_CRH &= ~(0xFu << 20);
  GPIOC_CRH |=  (0x2u << 20);
  for (;;) {
    GPIOC_ODR ^= (1u << 13);
    for (volatile uint32_t i = 0; i < 150000; i++) { }
  }
}
