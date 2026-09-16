/**
 * 写入 Cursor MCP。默认 npx @memgrant/mcp-server，不依赖仓库 dist 路径。
 * 本机已有 ~/.memory-backbone/config.json 时，MCP 和 desktop 都会去读它。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function cursorConfigDir() {
  return process.env.CURSOR_CONFIG_DIR ?? path.join(os.homedir(), ".cursor");
}

export function cursorMcpLaunch(localEntry) {
  const env = { MB_AGENT_ID: "cursor" };
  if (localEntry) {
    return { command: process.execPath, args: [localEntry], env };
  }
  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "npx", "-y", "@memgrant/mcp-server"],
      env,
    };
  }
  return { command: "npx", args: ["-y", "@memgrant/mcp-server"], env };
}

export async function writeCursorMcp(opts = {}) {
  const localEntry =
    opts.localEntry ??
    (process.env.MB_MCP_LOCAL === "1" ? process.env.MB_MCP_LOCAL_ENTRY : undefined);
  const cursorDir = opts.cursorDir ?? cursorConfigDir();
  const mcpPath = path.join(cursorDir, "mcp.json");
  await fs.mkdir(cursorDir, { recursive: true });
  let existing = { mcpServers: {} };
  try {
    existing = JSON.parse(await fs.readFile(mcpPath, "utf8"));
  } catch {
    /* first time */
  }
  existing.mcpServers = existing.mcpServers ?? {};
  existing.mcpServers.memgrant = cursorMcpLaunch(localEntry);
  delete existing.mcpServers["memory-backbone"];
  await fs.writeFile(mcpPath, JSON.stringify(existing, null, 2));
  return mcpPath;
}

const isMain =
  process.argv[1] &&
  path.normalize(fileURLToPath(import.meta.url)) === path.normalize(process.argv[1]);

if (isMain) {
  const mcpPath = await writeCursorMcp();
  console.log("已写入 Cursor MCP:", mcpPath);
}
