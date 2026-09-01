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

const sdk = await import("@memory-backbone/sdk-core");

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

async function loadConfigFile() {
  return readJson(path.join(mbHome(), "config.json"), {});
}

async function requireCloud() {
  const config = await loadConfigFile();
  if (!config.endpoint || !config.device_token) {
    const err = new Error("需要 endpoint 与 device_token，拒绝只改本地状态假装撤销/改权");
    err.status = 401;
    throw err;
  }
  return config;
}

async function cloudFetch(config, pathname, init = {}) {
  const res = await fetch(`${String(config.endpoint).replace(/\/$/, "")}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.device_token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function rebuildGrants(config, agent) {
  const keysRes = await cloudFetch(config, "/api/memories/keys");
  if (!keysRes.ok) return { rebuilt: 0, error: `keys HTTP ${keysRes.status}` };
  const { items } = await keysRes.json();
  const kc = sdk.createBestKeychain(mbHome());
  const mk = await kc.getMk();
  if (!mk) return { rebuilt: 0, error: "MK unavailable" };
  const pub = Uint8Array.from(atob(agent.agentPublicKeyB64 ?? "AA=="), (ch) => ch.charCodeAt(0));
  const grants = [];
  for (const item of items ?? []) {
    if (item.permission_level > agent.permissionMask) continue;
    const dek = await sdk.unwrapDekWithMk(mk, sdk.fromBase64(item.wrapped_dek));
    try {
      const g = await sdk.createGrant(
        {
          agentId: agent.agentId,
          agentPublicKey: pub,
          permissionMask: agent.permissionMask,
          status: "active",
        },
        { memoryId: item.memory_id, dek, permissionLevel: item.permission_level },
      );
      if (g) {
        grants.push({
          grant_id: g.grantId,
          agent_id: g.agentId,
          memory_id: g.memoryId,
          enc_dek: g.encDekB64,
        });
      }
    } finally {
      dek.fill(0);
    }
  }
  const syncRes = await cloudFetch(config, "/api/grants/sync", {
    method: "POST",
    body: JSON.stringify({ grants }),
  });
  if (!syncRes.ok) return { rebuilt: 0, error: `grants HTTP ${syncRes.status}` };
  const body = await syncRes.json();
  return { rebuilt: body.accepted ?? grants.length };
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
          const config = await loadConfigFile();
          const embedder = sdk.createEmbedderFromConfig(config.embedder);
          let vec = null;
          try {
            vec = await embedder.embed(q);
          } catch {
            vec = null;
          }
          items = store.searchHybrid(q, vec, 100).map((h) => h.memory);
        } else {
          items = store.listMemories(500);
        }
        const count = store.countMemories();
        store.close();
        return json(res, { total: count, items });
      }

      if (url.pathname === "/api/sync/pull" && req.method === "POST") {
        let config;
        try {
          config = await requireCloud();
        } catch (e) {
          return json(res, { error: e.message }, e.status ?? 401);
        }
        const home = mbHome();
        const store = await sdk.LocalStore.open(path.join(home, "cache.db"));
        const kc = sdk.createBestKeychain(home);
        const deviceSk = await sdk.loadDeviceSk(home);
        const service = new sdk.MemoryService(
          kc,
          store,
          () => [],
          sdk.createEmbedderFromConfig(config.embedder),
          sdk.createJudgeFromConfig(config.judge),
        );
        const sync = new sdk.SyncClient({
          endpoint: String(config.endpoint).replace(/\/$/, ""),
          ...(config.device_token ? { token: config.device_token } : {}),
          ...(config.device_id && deviceSk
            ? { deviceId: config.device_id, deviceSk }
            : {}),
        });
        try {
          const result = await sync.pullAndApply(store, (id, body) =>
            service.applyFetched(id, body),
          );
          await store.persist();
          await audit("sync.pull", result);
          return json(res, { ok: true, ...result });
        } catch (e) {
          return json(res, { error: String(e.message ?? e) }, 502);
        } finally {
          store.close();
        }
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

      // —— 调整权限掩码：必须打到自托管节点，禁止只改本地 json ——
      const maskMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/mask$/);
      if (maskMatch && req.method === "POST") {
        const { mask } = await readBody(req);
        if (typeof mask !== "number" || mask < 0 || mask > 4) {
          return json(res, { error: "mask must be 0-4" }, 400);
        }
        let config;
        try {
          config = await requireCloud();
        } catch (e) {
          return json(res, { error: e.message }, e.status ?? 401);
        }
        const cloudRes = await cloudFetch(config, `/api/permissions/update/${encodeURIComponent(maskMatch[1])}`, {
          method: "PUT",
          body: JSON.stringify({ permission_mask: mask }),
        });
        if (!cloudRes.ok) {
          return json(res, { error: `cloud update failed: HTTP ${cloudRes.status}` }, 502);
        }
        const file = path.join(mbHome(), "paired-agents.json");
        const agents = await readJson(file, []);
        const agent = agents.find((a) => a.agentId === maskMatch[1]);
        if (!agent) return json(res, { error: "agent not found" }, 404);
        agent.permissionMask = mask;
        const rebuilt = await rebuildGrants(config, agent);
        agent.grantsStale = Boolean(rebuilt.error);
        await writeJson(file, agents);
        await audit("agent.mask.update", { agentId: agent.agentId, mask, rebuilt });
        return json(res, { ok: true, grantsStale: agent.grantsStale, rebuilt });
      }

      // —— 撤销 Agent：必须先删云端 grants ——
      const revokeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/revoke$/);
      if (revokeMatch && req.method === "POST") {
        let config;
        try {
          config = await requireCloud();
        } catch (e) {
          return json(res, { error: e.message }, e.status ?? 401);
        }
        const cloudRes = await cloudFetch(
          config,
          `/api/permissions/revoke/${encodeURIComponent(revokeMatch[1])}`,
          { method: "DELETE" },
        );
        if (!cloudRes.ok) {
          return json(res, { error: `cloud revoke failed: HTTP ${cloudRes.status}` }, 502);
        }
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
        const kc = sdk.createBestKeychain(mbHome());
        const mk = await kc.getMk();
        const config = await readJson(path.join(mbHome(), "config.json"), {});
        return json(res, {
          backend: kc.id,
          initialized: mk !== null,
          agentId: config.agent_id ?? null,
          endpoint: config.endpoint ?? null,
          judge: config.judge?.l1?.baseUrl && config.judge?.l1?.model
            ? {
                engine: "l0+l1",
                model: config.judge.l1.model,
                baseUrl: config.judge.l1.baseUrl,
              }
            : { engine: "l0" },
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
      json(res, { error: String(err?.message ?? err) }, err.status ?? 500);
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
