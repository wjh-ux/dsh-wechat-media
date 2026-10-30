#!/usr/bin/env node
/**
 * The Keil side of the bridge: the *same* module the chat tool runs (`../../keil.js`), reachable from uVision's
 * Tools menu or from a terminal. Nothing here re-implements a build - if the chat and the IDE disagreed about what
 * a build was, one of them would be lying, and this file exists so they cannot.
 *
 * Usage:
 *   node keil-cli.mjs <project.uvprojx> [build|rebuild|clean|flash] [target]
 *   node keil-cli.mjs --list-targets <project.uvprojx>
 *
 * Exit code: 0 = ok (warnings are ok), 2 = build failed, 3 = could not run at all (no UV4, bad path, bad action).
 * That is deliberate: a script that calls this can use `if errorlevel 2 ...` without parsing Chinese text.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  ACTIONS,
  assertProject,
  defaultLogPath,
  formatDiagnostic,
  inspectProject,
  keilSupport,
  runUv4,
} from "../../keil.js";

const argv = process.argv.slice(2).filter((arg) => arg && arg !== "--pause");

if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
  console.log("用法: node keil-cli.mjs <project.uvprojx> [build|rebuild|clean|flash] [target]");
  console.log("      node keil-cli.mjs --list-targets <project.uvprojx>");
  process.exit(0);
}

const listTargets = argv[0] === "--list-targets";
const positional = listTargets ? argv.slice(1) : argv;
const [projectArg, actionArg = "build", targetArg = ""] = positional;

const support = keilSupport({ exists: existsSync, readFile: readFileSync });
if (!support.ok) {
  console.error(`✖ ${support.reason}`);
  process.exit(3);
}

let project;
try {
  project = assertProject(projectArg, { exists: existsSync });
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`);
  process.exit(3);
}

if (listTargets) {
  const info = inspectProject(project, { exists: existsSync, readFile: readFileSync });
  console.log(info.targets.length ? info.targets.join("\n") : "（工程里没有 TargetName）");
  process.exit(0);
}

const action = String(actionArg).toLowerCase();
if (!ACTIONS[action]) {
  console.error(`✖ 未知动作：${actionArg}（可用：${Object.keys(ACTIONS).join(" / ")}）`);
  process.exit(3);
}

const logPath = defaultLogPath(project, action);
const result = await runUv4({
  uv4: support.uv4.program,
  project,
  action,
  target: targetArg,
  logPath,
});

// The console gets what Keil's own output window would have shown, and the file/line lines are repeated compactly
// because that is the part a person scrolls for.
const { parsed } = result;
console.log(`UV4 ${support.uv4.program}`);
console.log(`$ UV4 ${result.args.join(" ")}`);
console.log(`工程：${project}`);
if (targetArg) console.log(`Target：${targetArg}`);
console.log(parsed.summary || `退出码 ${result.code}`);
for (const item of parsed.errors) console.log(`  ✖ ${formatDiagnostic(item)}`);
for (const item of parsed.warnings) console.log(`  ⚠ ${formatDiagnostic(item)}`);
if (parsed.size) console.log(`程序大小：${parsed.size}`);
if (parsed.hex) console.log(`HEX：${parsed.hex}`);
console.log(`日志：${logPath}`);
console.log(parsed.ok ? "✅ 编译通过" : "❌ 编译失败");

process.exit(parsed.ok ? 0 : 2);
