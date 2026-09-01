#!/usr/bin/env node
/**
 * 桌面管理 App 服务器（方案 §6.1 sdk-desktop，Sprint 5）。
 *
 * 本地 Web UI：只绑 127.0.0.1，不暴露局域网。
 * Electron 壳在发布版直接包裹本服务（同一前端代码零改动）。
 *
 * 功能：记忆列表 / 权限管理（掩码调整、撤销）/ 密钥状态 / 审计日志。
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const sdk = await import(
  new URL("../sdk-core/dist/index.js", import.meta.url).href
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MB_DESKTOP_PORT ?? 4787);
const HOST = "127.0.0.1"; // 安全边界：仅本机回环

function mbHome() {
  return process.env.MB_HOME ?? path.join(os.homedir(), ".memory-backbone");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function audit(action, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, detail }) + "\n";
  await fs.mkdir(mbHome(), { recursive: true });
  await fs.appendFile(path.join(mbHome(), "audit.jsonl"), line);
}

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    try {
      // —— 静态页 ——
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await fs.readFile(path.join(HERE, "public", "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // —— 记忆列表（本地缓存，含权限级别与来源） ——
      if (url.pathname === "/api/memories" && req.method === "GET") {
        const store = await sdk.LocalStore.open(path.join(mbHome(), "cache.db"));
        const q = url.searchParams.get("q");
        let items;
        if (q) {
          items = store.searchMemories(q, 100);
        } else {
          items = store.listMemories(500);
        }
        const count = store.countMemories();
        store.close();
        return json(res, { total: count, items });
      }

      // —— 删除记忆 ——
      const delMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
      if (delMatch && req.method === "DELETE") {
        const store = await sdk.LocalStore.open(path.join(mbHome(), "cache.db"));
        store.markDeleted(delMatch[1], new Date().toISOString());
        store.enqueue("delete", delMatch[1], JSON.stringify({
          op: "delete",
          memory_id: delMatch[1],
          updated_at: new Date().toISOString(),
        }));
        await store.persist();
        store.close();
        await audit("memory.delete", { memoryId: delMatch[1] });
        return json(res, { ok: true });
      }

      // —— Agent 权限列表 ——
      if (url.pathname === "/api/agents" && req.method === "GET") {
        const agents = await readJson(path.join(mbHome(), "paired-agents.json"), []);
        return json(res, { items: agents });
      }

      // —— 调整权限掩码（触发该 Agent grants 重算 → 由下次同步批量任务执行） ——
      const maskMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/mask$/);
      if (maskMatch && req.method === "POST") {
        const { mask } = await readBody(req);
        if (typeof mask !== "number" || mask < 0 || mask > 4) {
          return json(res, { error: "mask must be 0-4" }, 400);
        }
        const file = path.join(mbHome(), "paired-agents.json");
        const agents = await readJson(file, []);
        const agent = agents.find((a) => a.agentId === maskMatch[1]);
        if (!agent) return json(res, { error: "agent not found" }, 404);
        agent.permissionMask = mask;
        agent.grantsStale = true; // 标记需重算（方案 §4.3 步骤 6）
        await writeJson(file, agents);
        await audit("agent.mask.update", { agentId: agent.agentId, mask });
        return json(res, { ok: true, grantsStale: true });
      }

      // —— 撤销 Agent（本地状态 + 云端删除 grants 由同步执行） ——
      const revokeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/revoke$/);
      if (revokeMatch && req.method === "POST") {
        const file = path.join(mbHome(), "paired-agents.json");
        const agents = await readJson(file, []);
        const agent = agents.find((a) => a.agentId === revokeMatch[1]);
        if (!agent) return json(res, { error: "agent not found" }, 404);
        agent.status = "revoked";
        agent.revokedAt = new Date().toISOString();
        await writeJson(file, agents);
        await audit("agent.revoke", { agentId: agent.agentId });
        return json(res, { ok: true });
      }

      // —— 密钥状态（不暴露任何密钥材料，只报状态） ——
      if (url.pathname === "/api/key-status" && req.method === "GET") {
        const kc = sdk.createPlatformKeychain();
        const mk = await kc.getMk();
        const config = await readJson(path.join(mbHome(), "config.json"), {});
        return json(res, {
          backend: kc.id,
          initialized: mk !== null,
          agentId: config.agent_id ?? null,
          endpoint: config.endpoint ?? null,
        });
      }

      // —— 审计日志 ——
      if (url.pathname === "/api/audit" && req.method === "GET") {
        let lines = [];
        try {
          const raw = await fs.readFile(path.join(mbHome(), "audit.jsonl"), "utf8");
          lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        } catch {
          /* empty */
        }
        return json(res, { items: lines.slice(-200).reverse() });
      }

      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: String(err?.message ?? err) }, 500);
    }
  });
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  createServer().listen(PORT, HOST, () => {
    console.log(`memory-backbone 桌面管理: http://${HOST}:${PORT}`);
  });
}
