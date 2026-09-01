/**
 * 验收 S2：ECIES 加解密单测 —— grant 只能被目标 agent_sk 解开。
 */
import { describe, it, expect } from "vitest";
import {
  generateAgentKeyPair,
  eciesEncryptDek,
  eciesDecryptDek,
  ENC_DEK_BYTES,
} from "../src/crypto/ecies.js";
import { generateDek } from "../src/crypto/aead.js";
import { toHex } from "../src/crypto/random.js";

describe("S2: ECIES per-agent 授权", () => {
  it("enc_dek 可被目标 Agent 私钥解开", async () => {
    const agent = generateAgentKeyPair();
    const dek = generateDek();
    const encDek = await eciesEncryptDek(agent.publicKey, dek);
    expect(encDek.length).toBe(ENC_DEK_BYTES);

    const opened = await eciesDecryptDek(agent.secretKey, encDek);
    expect(toHex(opened)).toBe(toHex(dek));
  });

  it("错误私钥无法解开（负向测试）", async () => {
    const agentA = generateAgentKeyPair();
    const agentB = generateAgentKeyPair();
    const dek = generateDek();
    const encDek = await eciesEncryptDek(agentA.publicKey, dek);

    await expect(eciesDecryptDek(agentB.secretKey, encDek)).rejects.toThrow();
  });

  it("密文被篡改即解密失败（GCM 认证）", async () => {
    const agent = generateAgentKeyPair();
    const dek = generateDek();
    const encDek = await eciesEncryptDek(agent.publicKey, dek);
    encDek[encDek.length - 1] ^= 0xff;

    await expect(eciesDecryptDek(agent.secretKey, encDek)).rejects.toThrow();
  });

  it("每次加密使用不同临时密钥（同 DEK 两次 enc_dek 不同）", async () => {
    const agent = generateAgentKeyPair();
    const dek = generateDek();
    const a = await eciesEncryptDek(agent.publicKey, dek);
    const b = await eciesEncryptDek(agent.publicKey, dek);
    expect(toHex(a)).not.toBe(toHex(b));
  });
});
