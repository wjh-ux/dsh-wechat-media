#include <stdint.h>

/* 寄存器基址：所有 STM32 一样；换系列时外设偏移可能不同，查参考手册 */
#define PERIPH_BASE   0x40000000UL
#define APB2PERIPH    (PERIPH_BASE + 0x00010000UL)
#define AHBPERIPH     (PERIPH_BASE + 0x00020000UL)
#define GPIOC_BASE    (APB2PERIPH + 0x1000UL)
#define RCC_BASE      (AHBPERIPH + 0x1000UL)
#define RCC_APB2ENR   (*(volatile uint32_t *)(RCC_BASE + 0x18))
#define GPIOC_CRH     (*(volatile uint32_t *)(GPIOC_BASE + 0x04))
#define GPIOC_ODR     (*(volatile uint32_t *)(GPIOC_BASE + 0x0C))

/* 粗略延时：400000 次空转约半秒（HSI 8MHz、-O2），只用于肉眼可见的闪烁 */
static void spin(volatile uint32_t n) { while (n--) __asm__("nop"); }

int main(void) {
  RCC_APB2ENR |= (1u << 4);             /* 打开 GPIOC 时钟 */
  GPIOC_CRH &= ~(0xFu << 20);           /* PC13：推挽输出，2 MHz */
  GPIOC_CRH |=  (0x2u << 20);
  for (;;) {
    GPIOC_ODR ^= (1u << 13);            /* 翻转 PC13：蓝药丸的板载 LED 接在这里，低电平点亮 */
    spin(150000);
  }
}
