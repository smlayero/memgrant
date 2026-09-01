/**
 * Claude Code 适配器测试：
 * - setup 幂等写入 settings.json（保留其他 hook）
 * - transcript 提取用户消息
 * - SessionStart 注入按权限掩码过滤
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.join(HERE, "..", "claude-code");
const SDK_DIST = path.join(HERE, "..", "..", "sdk-core", "dist", "index.js");

describe("Claude Code hooks", () => {
  beforeAll(async () => {
    await fs.access(SDK_DIST); // 需要 sdk-core 先构建
  });

  it("setup 幂等写入且不破坏已有 hooks", async () => {
    const tmpClaude = await fs.mkdtemp(path.join(os.tmpdir(), "mb-claude-"));
    // 预置一个其他 hook
    await fs.writeFile(
      path.join(tmpClaude, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", "command": "other-tool --flag" }] }],
        },
      }),
    );
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tmpClaude };
    await execFileAsync(process.execPath, [path.join(ADAPTER_DIR, "setup.mjs")], { env });
    await execFileAsync(process.execPath, [path.join(ADAPTER_DIR, "setup.mjs")], { env }); // 第二次，幂等

    const settings = JSON.parse(
      await fs.readFile(path.join(tmpClaude, "settings.json"), "utf8"),
    );
    for (const event of ["SessionStart", "Stop", "PreCompact"]) {
      const ours = settings.hooks[event]
        .flatMap((g) => g.hooks)
        .filter((h) => h.command.includes("memory-backbone"));
      expect(ours).toHaveLength(1); // 幂等：只有一个我们的 hook
    }
    // 其他 hook 保留
    const others = settings.hooks.Stop
      .flatMap((g) => g.hooks)
      .filter((h) => h.command.includes("other-tool"));
    expect(others).toHaveLength(1);
  });

  it("transcript 用户消息提取", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mb-tr-"));
    const transcript = path.join(tmp, "session.jsonl");
    await fs.writeFile(
      transcript,
      [
        JSON.stringify({ type: "user", message: { content: "请记住我偏好简洁回答" } }),
        JSON.stringify({ type: "assistant", message: { content: "好的" } }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "我喜欢用 pnpm 管理依赖" }] },
        }),
        "not-json-line",
      ].join("\n"),
    );
    const { extractUserMessages } = await import(
      path.join(ADAPTER_DIR, "stop.mjs")
    );
    const texts = await extractUserMessages(transcript);
    expect(texts).toContain("请记住我偏好简洁回答");
    expect(texts).toContain("我喜欢用 pnpm 管理依赖");
    expect(texts).not.toContain("好的");
  });

  it("SessionStart 按权限掩码过滤注入", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mb-home-"));
    const sdk = await import(SDK_DIST);

    // 造一个含 Level 2 与 Level 4 记忆的缓存
    const store = await sdk.LocalStore.open(path.join(tmpHome, "cache.db"));
    store.putMemory({
      memoryId: "m2",
      plaintext: "我喜欢用 pnpm",
      type: "preference",
      tags: ["tech"],
      permissionLevel: 2,
      importance: 0.8,
      sourceAgent: null,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
      deleted: false,
    });
    store.putMemory({
      memoryId: "m4",
      plaintext: "我的密码是 hunter2",
      type: "profile",
      tags: [],
      permissionLevel: 4,
      importance: 0.9,
      sourceAgent: null,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
      deleted: false,
    });
    await store.persist();
    store.close();

    await fs.writeFile(
      path.join(tmpHome, "config.json"),
      JSON.stringify({ endpoint: "http://localhost", agent_id: "claude-code" }),
    );
    // 该 Agent 掩码 = 2 → Level 4 不应注入
    await fs.writeFile(
      path.join(tmpHome, "paired-agents.json"),
      JSON.stringify([
        { agentId: "claude-code", agentPublicKeyB64: "AA==", permissionMask: 2, status: "active" },
      ]),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(ADAPTER_DIR, "sessionStart.mjs")],
      { env: { ...process.env, MB_HOME: tmpHome } },
    );
    expect(stdout).toContain("pnpm");
    expect(stdout).not.toContain("hunter2");
  });
});
