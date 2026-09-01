#!/usr/bin/env node
/**
 * PreCompact hook：上下文压缩前抢救性保存（与 Stop 共用提取逻辑）。
 */
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [new URL("./stop.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
