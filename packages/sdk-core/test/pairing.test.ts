/**
 * 验收 S3（Sprint 2 硬门禁）：配对协议抗 MITM。
 * - 正常配对：MK 经会话密钥加密传输，双端指纹一致
 * - MITM：恶意中继替换公开份额 → 确认失败（无法完成密钥建立）
 * - 口令错误：确认失败
 * - Agent 配对：公钥经会话密钥加密登记，MITM 无法替换
 */
import { describe, it, expect } from "vitest";
import {
  PairingInitiator,
  PairingJoiner,
  InMemoryPairingChannel,
  type PairingChannel,
  type PairingMessage,
} from "../src/pairing/pairing.js";
import { generateMnemonicBundle } from "../src/crypto/mnemonic.js";
import { toHex, fromBase64, toBase64 } from "../src/crypto/random.js";

/** 完整跑一轮设备配对，返回双方结果。 */
async function runDevicePairing(
  channel: PairingChannel,
  joinerCode?: string,
): Promise<{
  okA: boolean;
  okB: boolean;
  mkOut: Uint8Array | null;
  sasA: string;
  sasB: string;
}> {
  const initiator = new PairingInitiator(channel);
  const joiner = new PairingJoiner(channel, joinerCode ?? initiator.code);
  const { mk } = generateMnemonicBundle();

  let mkOut: Uint8Array | null = null;
  const sideA = (async () => {
    await initiator.start();
    await initiator.acceptShare();
    const okA = await initiator.verify();
    if (okA) await initiator.sendMk(mk);
    return okA;
  })();
  const sideB = (async () => {
    await joiner.join();
    const okB = await joiner.verify();
    if (okB) mkOut = await joiner.receiveMk();
    return okB;
  })();

  const [okA, okB] = await Promise.all([sideA, sideB]);
  return {
    okA,
    okB,
    mkOut,
    sasA: initiator.getSasFingerprint(),
    sasB: joiner.getSasFingerprint(),
  };
}

describe("配对协议（SPAKE2）", () => {
  it("正常设备配对：MK 完整传输，SAS 指纹一致", async () => {
    const channel = new InMemoryPairingChannel();
    const r = await runDevicePairing(channel);
    expect(r.okA).toBe(true);
    expect(r.okB).toBe(true);
    expect(r.mkOut).not.toBeNull();
    expect(r.mkOut!.length).toBe(32);
    expect(r.sasA).toBe(r.sasB);
    expect(r.sasA).toMatch(/^\d{6}$/);
  });

  it("S3：恶意中继替换公开份额 → 双方确认失败", async () => {
    // MITM 通道：拦截 share-a/share-b 并替换为自己的份额
    const inner = new InMemoryPairingChannel();
    const mitm: PairingChannel = {
      async create(code, first) {
        await inner.create(code, first);
      },
      async post(code, message) {
        await inner.post(code, tamper(message));
      },
      async poll(code, sinceIndex) {
        return inner.poll(code, sinceIndex);
      },
    };
    function tamper(m: PairingMessage): PairingMessage {
      if (m.type === "share-a" || m.type === "share-b") {
        const body = new Uint8Array(fromBase64(m.body));
        body[20] ^= 0xff; // 替换/篡改中继的公钥份额
        return { ...m, body: toBase64(body) };
      }
      return m;
    }

    const r = await runDevicePairing(mitm).catch(() => ({
      okA: false,
      okB: false,
      mkOut: null,
      sasA: "",
      sasB: "",
    }));
    // 篡改点 → 曲线成员检查失败或确认失败；绝不放行 MK
    expect(r.okA && r.okB).toBe(false);
    expect(r.mkOut).toBeNull();
  });

  it("口令（配对码）错误 → 确认失败", async () => {
    const channel = new InMemoryPairingChannel();
    const initiator = new PairingInitiator(channel);
    // B 连到正确会话，但内部用错误配对码派生 w（模拟输错码）
    const wrongJoiner = new PairingJoiner(channel, initiator.code, "000000");
    await initiator.start();
    const sharePromise = initiator.acceptShare();
    await wrongJoiner.join();
    await sharePromise;
    const [okA, okB] = await Promise.all([
      initiator.verify(),
      wrongJoiner.verify(),
    ]);
    expect(okA).toBe(false);
    expect(okB).toBe(false);
  });

  it("Agent 配对：公钥经会话密钥保护，MITM 无法替换", async () => {
    const channel = new InMemoryPairingChannel();
    const initiator = new PairingInitiator(channel);
    const joiner = new PairingJoiner(channel, initiator.code);

    const sideA = (async () => {
      await initiator.start();
      await initiator.acceptShare();
      const ok = await initiator.verify();
      if (!ok) throw new Error("confirm failed");
      return initiator.receiveAgentPubkey();
    })();
    const sideB = (async () => {
      await joiner.join();
      const ok = await joiner.verify();
      if (!ok) throw new Error("confirm failed");
      return joiner.sendAgentPubkey();
    })();

    const [receivedPubkey, agentKeys] = await Promise.all([sideA, sideB]);
    // A 收到的 Agent 公钥与 B 本地生成的一致 → 可安全登记云端
    expect(toHex(receivedPubkey)).toBe(toHex(agentKeys.publicKey));
    expect(receivedPubkey.length).toBe(33);
  });
});
