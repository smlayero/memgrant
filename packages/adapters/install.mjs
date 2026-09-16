#!/usr/bin/env node
/**
 * npx @memgrant/adapters：写入 Cursor MCP（npx mcp-server）+ Claude Code hooks。
 * 不 clone 仓库。MCP / desktop 从 ~/.memory-backbone/config.json 找本机节点。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCursorMcp } from "./install-clients.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`)),
    );
  });
}

const mcpPath = await writeCursorMcp();
console.log("已写入 Cursor MCP:", mcpPath);
try {
  await run(process.execPath, [path.join(HERE, "claude-code", "setup.mjs")]);
} catch (err) {
  console.warn("Claude Code hooks 未写入：", err.message);
}
console.log("");
console.log("MCP 与管理台读取 ~/.memory-backbone/config.json（可用 MB_HOME 覆盖），不依赖仓库路径。");
console.log("请在 Cursor 里重载 MCP。管理台：npx @memgrant/desktop");
console.log("若还没有 config.json，需要先在有仓库的机器上 npm run init，或自托管同步节点后再 setup。");
