import { describe, it, expect } from "vitest";
import { generateAgentKeyPair } from "../src/crypto/ecies.js";
import {
  signDeviceAuth,
  verifyDeviceAuth,
  formatMb1Header,
  parseMb1Header,
} from "../src/crypto/deviceAuth.js";
import { createOpenAiCompatEmbedder } from "../src/judge/openaiEmbedder.js";
import { isLoopbackUrl } from "../src/judge/localUrl.js";
import { saveDeviceSk, loadDeviceSk } from "../src/crypto/deviceSk.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("MB1 设备签名", () => {
  it("真密钥对可验签，错钥失败", () => {
    const keys = generateAgentKeyPair();
    const input = {
      deviceId: "dev1",
      nonce: "n1",
      ts: "1",
      method: "POST",
      path: "/api/memory/sync",
    };
    const sig = signDeviceAuth(input, keys.secretKey);
    expect(verifyDeviceAuth(input, keys.publicKey, sig)).toBe(true);
    const other = generateAgentKeyPair();
    expect(verifyDeviceAuth(input, other.publicKey, sig)).toBe(false);
  });

  it("header 往返", () => {
    const keys = generateAgentKeyPair();
    const input = {
      deviceId: "abc",
      nonce: "nonce",
      ts: "99",
      method: "GET",
      path: "/api/x",
    };
    const header = formatMb1Header(input, signDeviceAuth(input, keys.secretKey));
    const parsed = parseMb1Header(header);
    expect(parsed?.input.deviceId).toBe("abc");
    expect(verifyDeviceAuth(input, keys.publicKey, parsed!.signature)).toBe(true);
  });
});

describe("设备私钥落盘", () => {
  it("写入后再读出一致", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mb-sk-"));
    const keys = generateAgentKeyPair();
    await saveDeviceSk(dir, keys.secretKey);
    const back = await loadDeviceSk(dir);
    expect(back).not.toBeNull();
    expect(Buffer.from(back!).equals(Buffer.from(keys.secretKey))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("OpenAI 兼容 embedding", () => {
  it("解析 mock 向量", async () => {
    const e = createOpenAiCompatEmbedder({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      fetch: async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          { status: 200 },
        ),
    });
    const v = await e.embed("hello");
    expect(v.length).toBe(3);
    expect(v[0]).toBeCloseTo(0.1, 5);
  });
});

describe("本机 URL", () => {
  it("127.0.0.1 是回环", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
  });
});
