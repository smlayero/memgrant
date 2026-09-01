/**
 * 自托管闭环：双设备写入 → 对端拉回解密可读。
 * 使用 mock Cloudflare 绑定，不依赖真实账号。
 */
import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { createMockEnv } from "./mockBindings.js";
import {
  generateMnemonicBundle,
  recoveryVerifier,
  generateAgentKeyPair,
  InMemoryKeychain,
  LocalStore,
  MemoryService,
  SyncClient,
  toBase64,
  HttpPairingChannel,
  PairingInitiator,
  PairingJoiner,
} from "../../sdk-core/src/index.js";

type MockEnv = Awaited<ReturnType<typeof createMockEnv>>;
let env: MockEnv;

beforeEach(async () => {
  env = await createMockEnv();
});

function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, "http://mb.test");
  return app.request(u.pathname + u.search, init ?? {}, env as never);
}

describe("自托管双设备闭环", () => {
  it("设备 A 写入后，设备 B 经助记词恢复能拉回明文", async () => {
    const bundle = generateMnemonicBundle();
    const deviceA = generateAgentKeyPair();
    const reg = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixed_salt: bundle.fixedSaltHex,
          device_pubkey: toBase64(deviceA.publicKey),
          recovery_verifier: recoveryVerifier(bundle.mk),
        }),
      },
      env as never,
    );
    const credA = (await reg.json()) as { user_id: string; device_token: string };
    expect(reg.status).toBe(200);

    const kcA = new InMemoryKeychain();
    await kcA.setMk(bundle.mk);
    const storeA = await LocalStore.open();
    const svcA = new MemoryService(kcA, storeA, () => []);
    const saved = await svcA.saveMemory({
      text: "我喜欢用 pnpm 管理依赖，所有项目统一",
      explicit: true,
      sourceAgent: "claude-code",
    });
    expect(saved.stored).toBe(true);

    const syncA = new SyncClient({
      endpoint: "http://mb.test",
      token: credA.device_token,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const push = await syncA.pushOutbox(storeA);
    expect(push.pushed).toBe(1);

    const recover = await app.request(
      "/api/auth/recover",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: credA.user_id,
          recovery_verifier: recoveryVerifier(bundle.mk),
          device_pubkey: toBase64(generateAgentKeyPair().publicKey),
        }),
      },
      env as never,
    );
    expect(recover.status).toBe(200);
    const credB = (await recover.json()) as { device_token: string };

    const kcB = new InMemoryKeychain();
    await kcB.setMk(bundle.mk);
    const storeB = await LocalStore.open();
    const svcB = new MemoryService(kcB, storeB, () => []);
    const syncB = new SyncClient({
      endpoint: "http://mb.test",
      token: credB.device_token,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const applied = await syncB.pullAndApply(storeB, (id, fetched) => svcB.applyFetched(id, fetched));
    expect(applied.applied).toBe(1);
    const local = svcB.readMemoryLocal(saved.memoryId);
    expect(local?.plaintext).toContain("pnpm");
  });

  it("SPAKE2 HTTP 通道可把 MK 和新 device_token 交给加入方", async () => {
    const bundle = generateMnemonicBundle();
    const reg = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixed_salt: bundle.fixedSaltHex,
          device_pubkey: toBase64(generateAgentKeyPair().publicKey),
          recovery_verifier: recoveryVerifier(bundle.mk),
        }),
      },
      env as never,
    );
    const credA = (await reg.json()) as { user_id: string; device_token: string };
    const channel = new HttpPairingChannel("http://mb.test", fetchImpl as typeof fetch);
    const initiator = new PairingInitiator(channel);
    const joiner = new PairingJoiner(channel, initiator.code);
    const joinerKeys = generateAgentKeyPair();

    const sideA = (async () => {
      await initiator.start();
      await initiator.acceptShare();
      const ok = await initiator.verify();
      if (!ok) throw new Error("verify A failed");
      await initiator.sendMk(bundle.mk);
      const pub = await initiator.receiveDevicePubkey();
      const add = await app.request(
        "/api/auth/devices",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credA.device_token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ device_pubkey: toBase64(pub), paired_via: "pake" }),
        },
        env as never,
      );
      const cred = (await add.json()) as {
        user_id: string;
        device_id: string;
        device_token: string;
      };
      await initiator.sendDeviceCred({
        userId: cred.user_id,
        deviceId: cred.device_id,
        deviceToken: cred.device_token,
      });
      return cred;
    })();
    const sideB = (async () => {
      await joiner.join();
      const ok = await joiner.verify();
      if (!ok) throw new Error("verify B failed");
      const mk = await joiner.receiveMk();
      await joiner.sendDevicePubkey(joinerKeys.publicKey);
      const cred = await joiner.receiveDeviceCred();
      return { mk, cred };
    })();

    const [fromA, fromB] = await Promise.all([sideA, sideB]);
    expect(fromB.cred.deviceToken).toBe(fromA.device_token);
    expect(fromB.mk.length).toBe(32);
  });
});
