/**
 * Cursor MCP 写入：默认 npx，不写死仓库 dist；可选用本地入口。
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cursorMcpLaunch, writeCursorMcp } from "../install-clients.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("Cursor MCP install", () => {
  it("默认启动方式走 npx，不带仓库路径", () => {
    const launch = cursorMcpLaunch();
    expect(launch.env.MB_AGENT_ID).toBe("cursor");
    const blob = `${launch.command} ${launch.args.join(" ")}`;
    expect(blob).toContain("@memgrant/mcp-server");
    expect(blob).not.toMatch(/packages[/\\]mcp-server/);
    if (process.platform === "win32") {
      expect(launch.command).toBe("cmd");
      expect(launch.args).toEqual(["/c", "npx", "-y", "@memgrant/mcp-server"]);
    } else {
      expect(launch.command).toBe("npx");
      expect(launch.args).toEqual(["-y", "@memgrant/mcp-server"]);
    }
  });

  it("写入 mcp.json 时合并已有 server，去掉 memory-backbone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-cursor-"));
    await fs.writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "echo" },
          "memory-backbone": { command: "node", args: ["/old/repo/dist/index.js"] },
        },
      }),
    );
    const mcpPath = await writeCursorMcp({ cursorDir: dir });
    const cfg = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(cfg.mcpServers.other).toEqual({ command: "echo" });
    expect(cfg.mcpServers["memory-backbone"]).toBeUndefined();
    expect(cfg.mcpServers.memgrant.args.join(" ")).toContain("@memgrant/mcp-server");
    expect(JSON.stringify(cfg)).not.toMatch(/packages[/\\]mcp-server/);
  });

  it("MB 本地入口时才写绝对路径", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-cursor-local-"));
    const local = path.join(dir, "fake-mcp.js");
    await writeCursorMcp({ cursorDir: dir, localEntry: local });
    const cfg = JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8"));
    expect(cfg.mcpServers.memgrant.command).toBe(process.execPath);
    expect(cfg.mcpServers.memgrant.args).toEqual([local]);
  });

  it("npx @memgrant/adapters 入口会写 Cursor MCP", async () => {
    const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-cursor-bin-"));
    const claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-claude-bin-"));
    await execFileAsync(process.execPath, [path.join(HERE, "..", "install.mjs")], {
      env: {
        ...process.env,
        CURSOR_CONFIG_DIR: cursorDir,
        CLAUDE_CONFIG_DIR: claudeDir,
      },
    });
    const cfg = JSON.parse(await fs.readFile(path.join(cursorDir, "mcp.json"), "utf8"));
    expect(cfg.mcpServers.memgrant.args.join(" ")).toContain("@memgrant/mcp-server");
    const settings = JSON.parse(
      await fs.readFile(path.join(claudeDir, "settings.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart.length).toBeGreaterThan(0);
  });
});
