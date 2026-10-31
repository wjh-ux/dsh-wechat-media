/**
 * 用插件自己的解析器报告"这台机器上能用什么"。
 *
 * 为什么不是脚本里猜：`serialSupport()` 和 `which()` 就是插件运行时用的那两个函数，所以这里输出的
 * 就是插件待会儿看到的。踩过的坑——stcgal 装在某台机器的 ESP-IDF python 环境里，是个独立 exe，
 * 用系统 python `import stcgal` 会误报缺失，而实际烧录一切正常。
 *
 * 输出每行一种格式：
 *   <名字>|<ok|miss>|<路径或原因>
 * 这样 PowerShell 侧只需按 | 切开，不用解析人话。
 */
import { which, serialSupport, findEspIdf } from "../serial.js";

const support = serialSupport();
const idf = findEspIdf();

const rows = [
  ["arm-none-eabi-gcc", which("arm-none-eabi-gcc")],
  ["cmake", which("cmake")],
  ["ninja", which("ninja")],
  ["openocd", which("openocd")],
  ["arduino-cli", which("arduino-cli")],
  ["python", which("python") || which("python3")],
  ["stcgal", support.stcgal?.program ?? ""],
  ["esptool", support.esptool?.python ?? ""],
  ["avrdude", support.avrdude ?? ""],
  ["idf.py", idf?.idfPy ?? ""],
];

for (const [name, hit] of rows) {
  const value = String(hit ?? "").trim();
  console.log(`${name}|${value ? "ok" : "miss"}|${value}`);
}
