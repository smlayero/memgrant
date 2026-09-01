#!/usr/bin/env node
/**
 * 记忆骨干 MCP Server（方案 §6.1 mcp-server/，Phase 1 显式接入阶段）。
 *
 * 对任何 MCP 客户端（Claude Code / Cursor / 113+ 客户端）暴露三个工具：
 *   save_memory     显式保存（L0 规则 + 可选本机 L1，明文不出设备）
 *   search_memories 本地缓存检索（本地优先，断网可用）
 *   delete_memory   删除（本地标记 + 云端删密文/grants）
 *
 * 配置：~/.memory-backbone/config.json（见技术方案附录 A）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createBestKeychain,
  createJudgeFromConfig,
  createEmbedderFromConfig,
  loadDeviceSk,
  LocalStore,
  MemoryService,
  SyncClient,
  type AgentAccess,
  type JudgeConfig,
  type EmbedderConfig,
} from "@memory-backbone/sdk-core";

interface Config {
  endpoint: string;
  device_token?: string;
  agent_id: string;
  cache: { dir: string };
  judge?: JudgeConfig;
  embedder?: EmbedderConfig;
  device_id?: string;
}

async function loadConfig(): Promise<Config> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const dir =
    process.env.MB_HOME ?? path.join(home, ".memory-backbone");
  const configPath = path.join(dir, "config.json");
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  if (!parsed.endpoint || !parsed.agent_id) {
    throw new Error(`config missing endpoint/agent_id: ${configPath}`);
  }
  const config: Config = {
    endpoint: parsed.endpoint.replace(/\/$/, ""),
    agent_id: parsed.agent_id,
    cache: { dir: parsed.cache?.dir ?? dir },
  };
  if (parsed.device_token) config.device_token = parsed.device_token;
  if (parsed.judge) config.judge = parsed.judge as JudgeConfig;
  if (parsed.embedder) config.embedder = parsed.embedder as EmbedderConfig;
  if (parsed.device_id) config.device_id = parsed.device_id;
  return config;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const keychain = createBestKeychain(config.cache.dir);
  const store = await LocalStore.open(path.join(config.cache.dir, "cache.db"));
  // Phase 1：MCP 侧是"用户设备"角色，Agent 授权列表由桌面 App/配对流程维护；
  // 本进程启动时从本地缓存目录读取已配对 Agent（paired-agents.json，由配对流程写入）。
  let agents: AgentAccess[] = [];
  try {
    const raw = await fs.readFile(
      path.join(config.cache.dir, "paired-agents.json"),
      "utf8",
    );
    agents = (JSON.parse(raw) as Array<{
      agentId: string;
      agentPublicKeyB64: string;
      permissionMask: number;
      status: "active" | "revoked";
    }>).map((a) => ({
      agentId: a.agentId,
      agentPublicKey: Uint8Array.from(atob(a.agentPublicKeyB64), (ch) =>
        ch.charCodeAt(0),
      ),
      permissionMask: a.permissionMask,
      status: a.status,
    }));
  } catch {
    // 尚无配对 Agent：保存仍可用（用户路径），仅不生成 grants
  }

  const deviceSk = await loadDeviceSk(config.cache.dir);
  const service = new MemoryService(
    keychain,
    store,
    () => agents,
    createEmbedderFromConfig(config.embedder),
    createJudgeFromConfig(config.judge),
  );
  const sync =
    config.device_token || (config.device_id && deviceSk)
      ? new SyncClient({
          endpoint: config.endpoint,
          ...(config.device_token ? { token: config.device_token } : {}),
          ...(config.device_id && deviceSk
            ? { deviceId: config.device_id, deviceSk }
            : {}),
        })
      : null;

  const server = new McpServer({
    name: "memory-backbone",
    version: "0.1.0",
  });

  // 打断 McpServer 链式注册的类型累积（TS2589 已知问题），用结构化注册器
  type TextResult = { content: Array<{ type: "text"; text: string }> };
  type Registrar = {
    tool(
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (args: Record<string, unknown>) => Promise<TextResult>,
    ): void;
  };
  const reg = server as unknown as Registrar;

  reg.tool(
    "save_memory",
    "保存一条跨 Agent 长期记忆（本地判断+加密，明文不出设备）",
    { content: z.string().describe("要记住的内容") },
    async (args) => {
      const content = String(args.content);
      const result = await service.saveMemory({
        text: content,
        explicit: true,
        sourceAgent: config.agent_id,
      });
      await store.persist();
      if (result.stored && sync) {
        // 尽力推送，失败留离线队列
        await sync.pushOutbox(store).catch(() => undefined);
        await store.persist();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: result.stored
              ? `已保存（type=${result.judge.type}, level=${result.judge.permissionLevel}, grants=${result.grants.length}）`
              : `未保存（${result.judge.reason}）`,
          },
        ],
      };
    },
  );

  reg.tool(
    "search_memories",
    "检索长期记忆（本地优先）",
    {
      query: z.string().describe("检索关键词"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const query = String(args.query);
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const me = agents.find((a) => a.agentId === config.agent_id && a.status === "active");
      const mask = me?.permissionMask ?? 2;
      const embedder = createEmbedderFromConfig(config.embedder);
      let vec = null;
      try {
        vec = await embedder.embed(query);
      } catch {
        vec = null;
      }
      const hits = store
        .searchHybrid(query, vec, limit)
        .map((h) => h.memory)
        .filter((h) => h.permissionLevel <= mask);
      if (hits.length === 0) {
        return { content: [{ type: "text" as const, text: "无匹配记忆" }] };
      }
      const text = hits
        .map(
          (h, i) =>
            `${i + 1}. [${h.type}/L${h.permissionLevel}] ${h.plaintext}（${h.updatedAt}）`,
        )
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  reg.tool(
    "delete_memory",
    "删除一条记忆（云端密文与全部授权凭据一并删除）",
    { memory_id: z.string().describe("记忆 ID") },
    async (args) => {
      const memory_id = String(args.memory_id);
      await service.deleteMemory(memory_id);
      await store.persist();
      if (sync) {
        await sync.pushOutbox(store).catch(() => undefined);
        await store.persist();
      }
      return { content: [{ type: "text" as const, text: `已删除 ${memory_id}` }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("memory-backbone mcp server failed:", err);
  process.exit(1);
});
