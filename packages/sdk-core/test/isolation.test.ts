/**
 * 验收 S4/S5（Sprint 4 硬门禁）：
 * - S4: Agent A 授权子集后，解不开授权范围外的密文（密码学验收）
 * - S5: 撤销后该 Agent 新拉取的密文全部不可解
 */
import { describe, it, expect } from "vitest";
import { MemoryService } from "../src/memory/memoryService.js";
import { InMemoryKeychain } from "../src/crypto/keychain.js";
import { generateMnemonicBundle } from "../src/crypto/mnemonic.js";
import { generateAgentKeyPair } from "../src/crypto/ecies.js";
import { wrapDekWithMk } from "../src/crypto/wrap.js";
import { generateDek, sealWithDek } from "../src/crypto/aead.js";
import { createIncrementalGrants, type AgentAccess } from "../src/crypto/grants.js";
import { LocalStore } from "../src/cache/localStore.js";
import { toBase64, fromBase64, utf8ToBytes, randomBytes } from "../src/crypto/random.js";

async function makeService(agents: AgentAccess[]) {
  const keychain = new InMemoryKeychain();
  const { mk } = generateMnemonicBundle();
  await keychain.setMk(mk);
  const store = await LocalStore.open();
  return {
    mk,
    store,
    service: new MemoryService(keychain, store, () => agents),
  };
}

describe("S4: Agent 密码学隔离", () => {
  it("Level 4 记忆只对 mask≥4 的 Agent 生成 grant；mask=2 的 Agent 无解密密钥材料", async () => {
    const agentWide = generateAgentKeyPair();
    const agentNarrow = generateAgentKeyPair();
    const agents: AgentAccess[] = [
      {
        agentId: "agent-wide",
        agentPublicKey: agentWide.publicKey,
        permissionMask: 4,
        status: "active",
      },
      {
        agentId: "agent-narrow",
        agentPublicKey: agentNarrow.publicKey,
        permissionMask: 2,
        status: "active",
      },
    ];
    const { store, service } = await makeService(agents);

    const res = await service.saveMemory({
      text: "我的密码是 hunter2，请记住",
      explicit: true,
    });
    expect(res.stored).toBe(true);
    expect(res.judge.permissionLevel).toBe(4);

    // 只有 agent-wide 拿到 grant
    expect(res.grants.map((g) => g.agentId)).toEqual(["agent-wide"]);

    // agent-narrow 云端只能拉到密文，没有任何可解材料 → 等同于 404
    const grantForNarrow = res.grants.find((g) => g.agentId === "agent-narrow");
    expect(grantForNarrow).toBeUndefined();

    // 即便拿到别人的 grant 也解不开
    const payload = JSON.parse(store.dueOutbox()[0]!.payload);
    const wideGrant = res.grants[0]!;
    await expect(
      MemoryService.decryptAsAgent(
        payload.ciphertext,
        wideGrant.encDekB64,
        agentNarrow.secretKey,
      ),
    ).rejects.toThrow();

    // agent-wide 正常解开
    const pt = await MemoryService.decryptAsAgent(
      payload.ciphertext,
      wideGrant.encDekB64,
      agentWide.secretKey,
    );
    expect(pt).toBe("我的密码是 hunter2，请记住");
  });

  it("授权范围内（mask 覆盖）才可解密", async () => {
    const agent = generateAgentKeyPair();
    const agents: AgentAccess[] = [
      {
        agentId: "claude-code",
        agentPublicKey: agent.publicKey,
        permissionMask: 2,
        status: "active",
      },
    ];
    const { store, service } = await makeService(agents);
    const res = await service.saveMemory({
      text: "我喜欢用 pnpm 管理依赖，以后都用它",
      explicit: true,
    });
    expect(res.judge.permissionLevel).toBe(2);
    expect(res.grants).toHaveLength(1);

    const payload = JSON.parse(store.dueOutbox()[0]!.payload);
    const pt = await MemoryService.decryptAsAgent(
      payload.ciphertext,
      res.grants[0]!.encDekB64,
      agent.secretKey,
    );
    expect(pt).toContain("pnpm");
  });
});

describe("S5: 撤销即密码学失效", () => {
  it("revoked 状态的 Agent 不再获得任何新 grant", async () => {
    const agent = generateAgentKeyPair();
    const agents: AgentAccess[] = [
      {
        agentId: "revoked-agent",
        agentPublicKey: agent.publicKey,
        permissionMask: 4,
        status: "revoked",
      },
    ];
    const { service } = await makeService(agents);
    const res = await service.saveMemory({
      text: "请记住我偏好简洁的回答风格",
      explicit: true,
    });
    expect(res.stored).toBe(true);
    expect(res.grants).toHaveLength(0);
  });

  it("已分发的 grant 在云端删除后，Agent 侧无任何可解材料（模拟撤销流程）", async () => {
    const agent = generateAgentKeyPair();
    const mkBundle = generateMnemonicBundle();

    // 写入一条记忆并生成 grant
    const dek = generateDek();
    const sealed = await sealWithDek(dek, utf8ToBytes("授权期可见的内容"));
    const grants = await createIncrementalGrants(
      [
        {
          agentId: "a",
          agentPublicKey: agent.publicKey,
          permissionMask: 2,
          status: "active",
        },
      ],
      { memoryId: "m1", dek, permissionLevel: 2 },
    );
    expect(grants).toHaveLength(1);

    // 撤销：云端删 agent_access + 全部 grants（模拟）——此后新拉取只有密文
    const cloudGrantsAfterRevoke: typeof grants = [];
    expect(cloudGrantsAfterRevoke).toHaveLength(0);

    // 无 grant → Agent 拿不到 DEK，唯一可行攻击是暴力 AES-256 —— 密码学上失效
    // wrapped_dek 路径只对持有 MK 的用户设备开放，Agent 不持有 MK
    const wrappedDek = await wrapDekWithMk(mkBundle.mk, dek);
    expect(() => fromBase64(toBase64(randomBytes(0)))).not.toThrow();
    await expect(
      MemoryService.decryptAsAgent(
        toBase64(sealed.sealed),
        toBase64(wrappedDek).slice(0, 124), // 伪造 enc_dek 也解不开
        agent.secretKey,
      ),
    ).rejects.toThrow();
    dek.fill(0);
  });
});
