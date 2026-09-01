/**
 * SPAKE2 正确性：RFC 9382 Appendix B 官方测试向量（P256-SHA256-HKDF-HMAC 第 1 组）。
 * 通过官方向量 = 协议编排与 RFC 完全一致，降低"自实现协议"风险。
 */
import { describe, it, expect } from "vitest";
import { Spake2Session } from "../src/pairing/spake2.js";
import { toHex } from "../src/crypto/random.js";

// RFC 9382 Appendix B, P256-SHA256-HKDF-HMAC, vector 1
const V = {
  identityA: "server",
  identityB: "client",
  w: "2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f",
  x: "43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729",
  pA: "04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c",
  y: "dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be",
  pB: "0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7",
  ke: "0e0672dc86f8e45565d338b0540abe69",
  ka: "15bdf72e2b35b5c9e5663168e960a91b",
  confA: "58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0",
  confB: "d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b",
};

describe("SPAKE2（RFC 9382 官方测试向量）", () => {
  it("A 方：pA 份额与向量一致", () => {
    const a = Spake2Session.forTest("A", V.w, V.x, {
      identitySelf: V.identityA,
      identityPeer: V.identityB,
    });
    expect(toHex(a.getShare())).toBe(V.pA);
  });

  it("B 方：pB 份额与向量一致", () => {
    const b = Spake2Session.forTest("B", V.w, V.y, {
      identitySelf: V.identityB,
      identityPeer: V.identityA,
    });
    expect(toHex(b.getShare())).toBe(V.pB);
  });

  it("双方 Ke 与会话确认值与向量一致", () => {
    const a = Spake2Session.forTest("A", V.w, V.x, {
      identitySelf: V.identityA,
      identityPeer: V.identityB,
    });
    const b = Spake2Session.forTest("B", V.w, V.y, {
      identitySelf: V.identityB,
      identityPeer: V.identityA,
    });
    a.receiveShare(b.getShare());
    b.receiveShare(a.getShare());

    expect(toHex(a.getSharedKey())).toBe(V.ke);
    expect(toHex(b.getSharedKey())).toBe(V.ke);
    expect(toHex(a.getConfirmation())).toBe(V.confA);
    expect(toHex(b.getConfirmation())).toBe(V.confB);
    expect(a.verifyConfirmation(b.getConfirmation())).toBe(true);
    expect(b.verifyConfirmation(a.getConfirmation())).toBe(true);
  });

  it("非法点被拒绝（群成员资格检查）", () => {
    const a = Spake2Session.forTest("A", V.w, V.x, {
      identitySelf: V.identityA,
      identityPeer: V.identityB,
    });
    const garbage = new Uint8Array(65).fill(7);
    expect(() => a.receiveShare(garbage)).toThrow();
  });
});
