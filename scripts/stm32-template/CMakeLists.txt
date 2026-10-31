cmake_minimum_required(VERSION 3.20)
project(stm32_template C ASM)

include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/mcu.cmake)

set(CMAKE_C_STANDARD 11)
add_executable(${PROJECT_NAME}
  src/main.c
  src/startup.c
)

target_compile_definitions(${PROJECT_NAME} PRIVATE ${MCU_DEFINE})
target_compile_options(${PROJECT_NAME} PRIVATE
  -mcpu=${MCU_CPU} -mthumb -mfloat-abi=${MCU_FPU}
  -ffunction-sections -fdata-sections -O2 -Wall
)
target_link_options(${PROJECT_NAME} PRIVATE
  -mcpu=${MCU_CPU} -mthumb -mfloat-abi=${MCU_FPU}
  -T${MCU_LINKER}
  -Wl,--gc-sections -Wl,-Map=${PROJECT_NAME}.map
  --specs=nano.specs --specs=nosys.specs
)
set_target_properties(${PROJECT_NAME} PROPERTIES SUFFIX ".elf")

add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${PROJECT_NAME}> ${PROJECT_NAME}.bin
  COMMAND ${CMAKE_OBJCOPY} -O ihex   $<TARGET_FILE:${PROJECT_NAME}> ${PROJECT_NAME}.hex
  COMMAND ${CMAKE_SIZE} $<TARGET_FILE:${PROJECT_NAME}>
)
