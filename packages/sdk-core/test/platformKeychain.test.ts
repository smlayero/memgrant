/**
 * 平台 Keychain 测试：当前平台后端（Windows=DPAPI）加解密往返。
 *
 * 注意：部分沙箱/CI 环境禁止子进程调用系统安全工具（powershell/secret-tool），
 * 此时探测失败则跳过而非判失败——该用例在正常开发机与 CI Runner 上必须全绿。
 */
import { describe, it, expect } from "vitest";
import {
  createPlatformKeychain,
  probePlatformKeychain,
} from "../src/crypto/platformKeychain.js";
import { randomBytes, toHex } from "../src/crypto/random.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const probe = await probePlatformKeychain();
const usable = probe.ok;
if (!usable) {
  console.warn(
    `[platformKeychain] 后端 ${probe.backend} 在当前环境不可用（可能为沙箱限制），跳过实测`,
  );
}

describe("平台 Keychain", () => {
  it("后端探测", () => {
    expect(probe.backend.length).toBeGreaterThan(0);
    if (!usable) console.warn(`后端 ${probe.backend} 不可用，跳过往返实测`);
  });

  it.skipIf(!usable)("MK 写入/读取往返一致，删除后不可读", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-kc-"));
    const kc = createPlatformKeychain(dir);
    const mk = randomBytes(32);

    await kc.setMk(mk);
    const back = await kc.getMk();
    expect(back).not.toBeNull();
    expect(toHex(back!)).toBe(toHex(mk));

    // 落盘的不是明文 MK
    if (kc.id === "dpapi" || kc.id === "file") {
      const file = path.join(dir, kc.id === "dpapi" ? "mk.dpapi" : "mk.key");
      const onDisk = await fs.readFile(file, "utf8");
      expect(onDisk).not.toContain(toHex(mk));
      expect(onDisk.trim()).not.toBe(Buffer.from(mk).toString("base64"));
    }

    await kc.deleteMk();
    expect(await kc.getMk()).toBeNull();
    mk.fill(0);
  });
});
