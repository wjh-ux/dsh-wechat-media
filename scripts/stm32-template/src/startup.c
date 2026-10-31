#include <stdint.h>

extern uint32_t _estack, _sdata, _edata, _sbss, _ebss, _etext;
int main(void);
void Reset_Handler(void);
void Default_Handler(void) { for (;;) { } }

__attribute__((section(".isr_vector"), used))
void (*const vector_table[])(void) = {
  (void (*)(void))(&_estack),
  Reset_Handler,
  Default_Handler,
};

void Reset_Handler(void) {
  uint32_t *src = &_etext;
  uint32_t *dst = &_sdata;
  while (dst < &_edata) *dst++ = *src++;
  for (dst = &_sbss; dst < &_ebss; dst++) *dst = 0;
  main();
  for (;;) { }
}
