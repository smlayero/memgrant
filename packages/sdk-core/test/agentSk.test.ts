import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateAgentKeyPair,
  saveAgentSk,
  loadAgentSk,
  validAgentId,
} from "../src/index.js";

describe("agent sk 文件", () => {
  it("validAgentId 拒绝路径穿越", () => {
    expect(validAgentId("cursor")).toBe(true);
    expect(validAgentId("gemini-cli")).toBe(true);
    expect(validAgentId("../etc")).toBe(false);
    expect(validAgentId("a/b")).toBe(false);
    expect(validAgentId("")).toBe(false);
  });

  it("保存后只能用同一 agentId 读回", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-agent-sk-"));
    const keys = generateAgentKeyPair();
    await saveAgentSk(dir, "cursor", keys.secretKey);
    const back = await loadAgentSk(dir, "cursor");
    expect(back).not.toBeNull();
    expect(Buffer.from(back!).equals(Buffer.from(keys.secretKey))).toBe(true);
    expect(await loadAgentSk(dir, "claude-code")).toBeNull();
    keys.secretKey.fill(0);
    back!.fill(0);
  });
});
