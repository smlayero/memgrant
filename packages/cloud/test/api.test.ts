/**
 * 云端 API 测试：使用 mock Cloudflare 绑定（D1/R2/KV/DO）验证全链路。
 * 重点验证安全属性：grants 服务端校验、用户隔离、撤销即时失效。
 */
import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { createMockEnv } from "./mockBindings.js";

type MockEnv = Awaited<ReturnType<typeof createMockEnv>>;

let env: MockEnv;

beforeEach(async () => {
  env = await createMockEnv();
});

/** 注册用户并返回设备 token。 */
async function setupUser(): Promise<string> {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fixed_salt: "aabbccdd11223344",
      device_pubkey: "02" + "a".repeat(64),
    }),
  }, env as never);
  const body = (await res.json()) as { device_token: string };
  return body.device_token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

/** 授权 Agent。 */
async function grantAgent(token: string, agentId: string, mask: number): Promise<void> {
  await app.request("/api/permissions/grant", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      agent_id: agentId,
      agent_pubkey: "02" + agentId.padEnd(64, "0").slice(0, 64),
      permission_mask: mask,
    }),
  }, env as never);
}

/** 同步记忆（含可选 grants）。 */
async function syncMemory(
  token: string,
  memoryId: string,
  permissionLevel: number,
  grants?: Array<{ grantId: string; agentId: string; memoryId: string; encDekB64: string }>,
): Promise<Response> {
  const body: Record<string, unknown> = {
    op: "create",
    memory_id: memoryId,
    ciphertext: btoa("cipher-" + memoryId),
    wrapped_dek: btoa("dek-" + memoryId),
    permission_level: permissionLevel,
    updated_at: "2026-01-01T00:00:00Z",
  };
  if (grants) body.grants = grants;
  return app.request("/api/memory/sync", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }, env as never);
}

/** Agent 读取记忆（返回状态码）。 */
async function readAsAgent(token: string, memoryId: string, agentId: string): Promise<number> {
  const res = await app.request(`/api/memory/read/${memoryId}?agent_id=${agentId}`, {
    headers: authHeaders(token),
  }, env as never);
  return res.status;
}

// ---- Tests ----

describe("Health & Auth", () => {
  it("GET /health", async () => {
    const res = await app.request("/health", {}, env as never);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("注册返回 device_token", async () => {
    const token = await setupUser();
    expect(token).toBeTruthy();
  });

  it("无 token → 401", async () => {
    const res = await app.request("/api/memory/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, env as never);
    expect(res.status).toBe(401);
  });
});

describe("Memory sync · grants 服务端校验", () => {
  it("活跃 Agent + 权限覆盖 → grant 被接受", async () => {
    const token = await setupUser();
    await grantAgent(token, "agent-1", 2);
    await syncMemory(token, "m1", 2, [
      { grantId: "g1", agentId: "agent-1", memoryId: "m1", encDekB64: btoa("enc-dek") },
    ]);
    expect(await readAsAgent(token, "m1", "agent-1")).toBe(200);
  });

  it("未注册 Agent → grant 被拒绝", async () => {
    const token = await setupUser();
    await syncMemory(token, "m2", 2, [
      { grantId: "g2", agentId: "ghost", memoryId: "m2", encDekB64: btoa("enc-dek") },
    ]);
    expect(await readAsAgent(token, "m2", "ghost")).toBe(404);
  });

  it("已撤销 Agent → grant 被拒绝", async () => {
    const token = await setupUser();
    await grantAgent(token, "agent-2", 2);
    await app.request("/api/permissions/revoke/agent-2", {
      method: "DELETE",
      headers: authHeaders(token),
    }, env as never);
    await syncMemory(token, "m3", 2, [
      { grantId: "g3", agentId: "agent-2", memoryId: "m3", encDekB64: btoa("enc-dek") },
    ]);
    expect(await readAsAgent(token, "m3", "agent-2")).toBe(404);
  });

  it("权限不足（mask < level）→ grant 被拒绝", async () => {
    const token = await setupUser();
    await grantAgent(token, "agent-3", 1);
    await syncMemory(token, "m4", 2, [
      { grantId: "g4", agentId: "agent-3", memoryId: "m4", encDekB64: btoa("enc-dek") },
    ]);
    expect(await readAsAgent(token, "m4", "agent-3")).toBe(404);
  });
});

describe("Grants 批量同步", () => {
  it("有效接受、无效拒绝", async () => {
    const token = await setupUser();
    await grantAgent(token, "agent-1", 2);
    await syncMemory(token, "m1", 2); // 创建 memory 行

    const res = await app.request("/api/grants/sync", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        grants: [
          { grant_id: "g1", agent_id: "agent-1", memory_id: "m1", enc_dek: btoa("dek1") },
          { grant_id: "g2", agent_id: "unknown", memory_id: "m1", enc_dek: btoa("dek2") },
        ],
      }),
    }, env as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(1);
  });
});

describe("撤销", () => {
  it("撤销 Agent → grants 即时删除", async () => {
    const token = await setupUser();
    await grantAgent(token, "agent-1", 2);
    await syncMemory(token, "m1", 2, [
      { grantId: "g1", agentId: "agent-1", memoryId: "m1", encDekB64: btoa("dek") },
    ]);
    expect(await readAsAgent(token, "m1", "agent-1")).toBe(200);

    await app.request("/api/permissions/revoke/agent-1", {
      method: "DELETE",
      headers: authHeaders(token),
    }, env as never);

    expect(await readAsAgent(token, "m1", "agent-1")).toBe(404);
  });
});

describe("同步变更", () => {
  it("记录变更并返回游标", async () => {
    const token = await setupUser();
    await syncMemory(token, "m1", 2);

    const res = await app.request("/api/sync/changes", {
      headers: authHeaders(token),
    }, env as never);
    const body = await res.json();
    expect(body.changes.length).toBe(1);
    expect(body.changes[0].memoryId).toBe("m1");
    expect(body.cursor).toBeTruthy();
  });

  it("清理旧变更", async () => {
    const token = await setupUser();
    await syncMemory(token, "m1", 2);

    const changesRes = await app.request("/api/sync/changes", {
      headers: authHeaders(token),
    }, env as never);
    const { cursor } = await changesRes.json();

    const res = await app.request(`/api/sync/changes?before=${cursor}`, {
      method: "DELETE",
      headers: authHeaders(token),
    }, env as never);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBeGreaterThan(0);

    const after = await app.request("/api/sync/changes", {
      headers: authHeaders(token),
    }, env as never);
    expect((await after.json()).changes.length).toBe(0);
  });
});

describe("WS 鉴权", () => {
  it("无 protocol token → 401", async () => {
    const res = await app.request("/api/sync/ws", {}, env as never);
    expect(res.status).toBe(401);
  });
});

describe("新设备与恢复", () => {
  it("已有设备可登记新 device_token", async () => {
    const token = await setupUser();
    const res = await app.request("/api/auth/devices", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ device_pubkey: "02" + "c".repeat(64), paired_via: "pake" }),
    }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device_token: string; user_id: string };
    expect(body.device_token).toBeTruthy();
    expect(body.device_token).not.toBe(token);
  });

  it("配对会话无需登录", async () => {
    const res = await app.request("/api/pairing/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "123456",
        message: { from: "A", type: "share-a", body: "YQ==" },
      }),
    }, env as never);
    expect(res.status).toBe(200);
    const got = await app.request("/api/pairing/session/123456", {}, env as never);
    expect(got.status).toBe(200);
  });

  it("PUT 权限下调后超出掩码的 grant 被删", async () => {
    const token = await setupUser();
    await grantAgent(token, "agent-1", 4);
    await syncMemory(token, "m-l4", 4, [
      { grantId: "g4", agentId: "agent-1", memoryId: "m-l4", encDekB64: btoa("dek") },
    ]);
    expect(await readAsAgent(token, "m-l4", "agent-1")).toBe(200);
    const upd = await app.request("/api/permissions/update/agent-1", {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ permission_mask: 2 }),
    }, env as never);
    expect(upd.status).toBe(200);
    expect(await readAsAgent(token, "m-l4", "agent-1")).toBe(404);
  });

  it("助记词恢复：正确 verifier 发新 token，错误则 403", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixed_salt: "aabbccdd11223344",
        device_pubkey: "02" + "a".repeat(64),
        recovery_verifier: "ab".repeat(32),
      }),
    }, env as never);
    const { user_id } = (await res.json()) as { user_id: string };

    const bad = await app.request("/api/auth/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id,
        recovery_verifier: "cd".repeat(32),
        device_pubkey: "02" + "e".repeat(64),
      }),
    }, env as never);
    expect(bad.status).toBe(403);

    const ok = await app.request("/api/auth/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id,
        recovery_verifier: "ab".repeat(32),
        device_pubkey: "02" + "f".repeat(64),
      }),
    }, env as never);
    expect(ok.status).toBe(200);
    expect((await ok.json() as { device_token: string }).device_token).toBeTruthy();
  });
});
