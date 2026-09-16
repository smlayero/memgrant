#!/usr/bin/env node
/**
 * 一键写入 Cursor MCP 与 Claude Code hooks。不替换助记词，不强制 Ollama。
 * 默认写入 npx @memgrant/mcp-server，删掉仓库后 Cursor 仍能拉起 MCP。
 * 本地改 mcp-server 时：MB_MCP_LOCAL=1 npm run clients
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { writeCursorMcp } from "../packages/adapters/install-clients.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const mcpDist = path.join(ROOT, "packages", "mcp-server", "dist", "index.js");

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`))));
  });
}

let localEntry;
if (process.env.MB_MCP_LOCAL === "1") {
  try {
    await fs.access(mcpDist);
    localEntry = mcpDist;
  } catch {
    console.warn("MB_MCP_LOCAL=1 但找不到", mcpDist, "，改写 npx。");
  }
}

const mcpPath = await writeCursorMcp({ localEntry });
console.log("已写入 Cursor MCP:", mcpPath);
try {
  await run(process.execPath, [path.join(ROOT, "packages", "adapters", "claude-code", "setup.mjs")], ROOT);
} catch (err) {
  console.warn("Claude Code hooks 未写入（可稍后 npx @memgrant/adapters）：", err.message);
}
console.log("请在 Cursor 里重载 MCP。助记词仍是主密钥，不要用模型替换。");
console.log("管理台：npx @memgrant/desktop 或 npm run desktop");
