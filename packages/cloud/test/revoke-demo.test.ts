/**
 * 一分钟证明：授权 → 可读；撤销 → 404。
 */
import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { createMockEnv } from "./mockBindings.js";

type MockEnv = Awaited<ReturnType<typeof createMockEnv>>;
let env: MockEnv;

beforeEach(async () => {
  env = await createMockEnv();
});

describe("撤销 demo", () => {
  it("撤销后 Agent 再拉同一条记忆为 404", async () => {
    const reg = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixed_salt: "aabbccdd11223344aabbccdd11223344",
          device_pubkey: "02" + "a".repeat(64),
        }),
      },
      env as never,
    );
    const { device_token } = (await reg.json()) as { device_token: string };
    const headers = {
      authorization: `Bearer ${device_token}`,
      "content-type": "application/json",
    };

    await app.request(
      "/api/permissions/grant",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent_id: "agent-a",
          agent_pubkey: "02" + "b".repeat(64),
          permission_mask: 2,
        }),
      },
      env as never,
    );

    await app.request(
      "/api/memory/sync",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          op: "create",
          memory_id: "m-demo",
          ciphertext: btoa("cipher"),
          wrapped_dek: btoa("dek"),
          permission_level: 2,
          updated_at: "2026-09-01T00:00:00Z",
          grants: [
            {
              grantId: "g1",
              agentId: "agent-a",
              memoryId: "m-demo",
              encDekB64: btoa("enc"),
            },
          ],
        }),
      },
      env as never,
    );

    const before = await app.request("/api/memory/read/m-demo?agent_id=agent-a", {
      headers,
    }, env as never);
    expect(before.status).toBe(200);
    console.log("revoke-demo: 授权期内 GET /api/memory/read →", before.status);

    await app.request("/api/permissions/revoke/agent-a", {
      method: "DELETE",
      headers,
    }, env as never);

    const after = await app.request("/api/memory/read/m-demo?agent_id=agent-a", {
      headers,
    }, env as never);
    expect(after.status).toBe(404);
    console.log("revoke-demo: 撤销后 GET /api/memory/read →", after.status);
  });
});
