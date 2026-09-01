/**
 * 桌面管理 App API 测试：记忆列表/删除、Agent 掩码与撤销、审计落盘、回环绑定。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let server;
let cloud;
let base;
let home;

async function api(p, opts) {
  const res = await fetch(`${base}${p}`, opts);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mb-desktop-"));
  process.env.MB_HOME = home;
  process.env.MB_DESKTOP_PORT = "0"; // 随机端口

  // 造数据
  const sdk = await import(
    path.join(HERE, "..", "..", "sdk-core", "dist", "index.js")
  );
  const store = await sdk.LocalStore.open(path.join(home, "cache.db"));
  store.putMemory({
    memoryId: "m1",
    plaintext: "我喜欢用 pnpm 管理依赖",
    type: "preference",
    tags: ["tech"],
    permissionLevel: 2,
    importance: 0.8,
    sourceAgent: "claude-code",
    createdAt: "2026-08-04T00:00:00Z",
    updatedAt: "2026-08-04T00:00:00Z",
    deleted: false,
  });
  await store.persist();
  store.close();
  await fs.writeFile(
    path.join(home, "paired-agents.json"),
    JSON.stringify([
      { agentId: "claude-code", agentPublicKeyB64: "AA==", permissionMask: 2, status: "active" },
    ]),
  );

  cloud = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").includes("/memories/keys")) {
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if ((req.url ?? "").includes("/sync/changes")) {
      res.end(JSON.stringify({ changes: [], cursor: "0" }));
      return;
    }
    res.end(JSON.stringify({ ok: true, accepted: 0 }));
  });
  await new Promise((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      endpoint: `http://127.0.0.1:${cloud.address().port}`,
      device_token: "test-token",
      agent_id: "claude-code",
    }),
  );

  const { createServer } = await import(path.join(HERE, "..", "server.mjs"));
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server?.close();
  cloud?.close();
});

describe("桌面管理 API", () => {
  it("记忆列表返回本地缓存", async () => {
    const r = await api("/api/memories");
    expect(r.body.total).toBe(1);
    expect(r.body.items[0].plaintext).toContain("pnpm");
  });

  it("搜索过滤", async () => {
    const r = await api("/api/memories?q=不存在的关键词xyz");
    expect(r.body.items).toHaveLength(0);
  });

  it("删除记忆并写入审计", async () => {
    const r = await api("/api/memories/m1", { method: "DELETE" });
    expect(r.body.ok).toBe(true);
    const audit = await api("/api/audit");
    expect(audit.body.items.some((a) => a.action === "memory.delete")).toBe(true);
  });

  it("无 token 拒绝假装撤销", async () => {
    const cfg = path.join(home, "config.json");
    const prev = await fs.readFile(cfg, "utf8");
    await fs.writeFile(cfg, "{}");
    const r = await api("/api/agents/claude-code/revoke", { method: "POST" });
    expect(r.status).toBe(401);
    await fs.writeFile(cfg, prev);
  });

  it("调整 Agent 掩码并打到云端", async () => {
    const r = await api("/api/agents/claude-code/mask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mask: 4 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const agents = await api("/api/agents");
    expect(agents.body.items[0].permissionMask).toBe(4);
  });

  it("撤销 Agent 打到云端", async () => {
    const r = await api("/api/agents/claude-code/revoke", { method: "POST" });
    expect(r.body.ok).toBe(true);
    const agents = await api("/api/agents");
    expect(agents.body.items[0].status).toBe("revoked");
  });

  it("密钥状态不暴露密钥材料", async () => {
    const r = await api("/api/key-status");
    expect(r.body).toHaveProperty("backend");
    expect(r.body).toHaveProperty("initialized");
    expect(JSON.stringify(r.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("从云端拉同步", async () => {
    const r = await api("/api/sync/pull", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.applied).toBe(0);
  });

  it("非法掩码被拒绝", async () => {
    const r = await api("/api/agents/claude-code/mask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mask: 9 }),
    });
    expect(r.status).toBe(400);
  });
});
