/**
 * 验收 S1（Sprint 1 硬门禁）：两台不同设备输入同一助记词 → 派生同一 MK。
 * v1 P0 回归：fixed_salt 必须为用户级固定值，与设备无关。
 */
import { describe, it, expect } from "vitest";
import {
  generateMnemonicBundle,
  deriveMkFromMnemonic,
  PBKDF2_ITERATIONS,
} from "../src/crypto/mnemonic.js";
import { toHex } from "../src/crypto/random.js";

describe("S1: 双设备助记词派生一致性", () => {
  it("同一助记词 + 同一 fixed_salt → 同一 MK（双设备恢复）", () => {
    // 设备 A：首次生成
    const deviceA = generateMnemonicBundle();
    expect(deviceA.mnemonic.split(" ").length).toBe(24);

    // 设备 B：输入同一助记词 + 从云端取回同一 fixed_salt
    const mkOnDeviceB = deriveMkFromMnemonic(
      deviceA.mnemonic,
      deviceA.fixedSaltHex,
    );

    expect(toHex(mkOnDeviceB)).toBe(toHex(deviceA.mk));
  });

  it("同一助记词 + 不同 salt → 不同 MK（v1 bug 模式的负向验证）", () => {
    const deviceA = generateMnemonicBundle();
    const other = generateMnemonicBundle();
    const wrongMk = deriveMkFromMnemonic(deviceA.mnemonic, other.fixedSaltHex);
    expect(toHex(wrongMk)).not.toBe(toHex(deviceA.mk));
  });

  it("两次生成的助记词互不相同", () => {
    const a = generateMnemonicBundle();
    const b = generateMnemonicBundle();
    expect(a.mnemonic).not.toBe(b.mnemonic);
  });

  it("非法助记词被拒绝", () => {
    expect(() =>
      deriveMkFromMnemonic("not a valid mnemonic at all", "00".repeat(16)),
    ).toThrow();
  });

  it(`PBKDF2 迭代次数符合方案（${PBKDF2_ITERATIONS}）`, () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });
});
