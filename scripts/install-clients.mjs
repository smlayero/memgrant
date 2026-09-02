#!/usr/bin/env node
/**
 * 一键写入 Cursor MCP 与 Claude Code hooks。不替换助记词，不强制 Ollama。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const mcpEntry = path.join(ROOT, "packages", "mcp-server", "dist", "index.js");

async function mergeCursorMcp() {
  const cursorDir = path.join(os.homedir(), ".cursor");
  const mcpPath = path.join(cursorDir, "mcp.json");
  await fs.mkdir(cursorDir, { recursive: true });
  let existing = { mcpServers: {} };
  try {
    existing = JSON.parse(await fs.readFile(mcpPath, "utf8"));
  } catch {
    /* first time */
  }
  existing.mcpServers = existing.mcpServers ?? {};
  existing.mcpServers["memgrant"] = {
    command: "node",
    args: [mcpEntry],
  };
  delete existing.mcpServers["memory-backbone"];
  await fs.writeFile(mcpPath, JSON.stringify(existing, null, 2));
  console.log("已写入 Cursor MCP:", mcpPath);
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}`))));
  });
}

await mergeCursorMcp();
try {
  await run(process.execPath, [path.join(ROOT, "packages", "adapters", "claude-code", "setup.mjs")], ROOT);
} catch (err) {
  console.warn("Claude Code hooks 未写入（可稍后 npx @memgrant/adapters）：", err.message);
}
console.log("请在 Cursor 里重载 MCP。助记词仍是主密钥，不要用模型替换。");
