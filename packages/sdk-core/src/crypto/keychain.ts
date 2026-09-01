/**
 * Keychain 抽象（方案 §6.1 crypto/Keychain 抽象 macOS/Windows/Linux）。
 *
 * MK 存平台安全存储，永不以明文触碰网络：
 * - macOS：Keychain（security CLI / Keychain Services）—— TODO M1
 * - Windows：DPAPI（CryptProtectData）—— TODO M1
 * - Linux：libsecret —— TODO M1
 * 当前提供测试用内存实现与开发用文件实现（权限 0600）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fromBase64, toBase64 } from "./random.js";

export interface Keychain {
  readonly id: string;
  getMk(): Promise<Uint8Array | null>;
  setMk(mk: Uint8Array): Promise<void>;
  deleteMk(): Promise<void>;
}

/** 测试用：进程内存 Keychain。 */
export class InMemoryKeychain implements Keychain {
  readonly id = "memory";
  private mk: Uint8Array | null = null;

  async getMk(): Promise<Uint8Array | null> {
    return this.mk ? new Uint8Array(this.mk) : null;
  }
  async setMk(mk: Uint8Array): Promise<void> {
    this.mk = new Uint8Array(mk);
  }
  async deleteMk(): Promise<void> {
    this.mk?.fill(0);
    this.mk = null;
  }
}

/**
 * 开发用文件 Keychain（~/.memory-backbone/mk.key，0600）。
 * 仅用于本地开发联调；发布版必须替换为平台安全存储。
 */
export class FileKeychain implements Keychain {
  readonly id = "file";
  constructor(private readonly filePath: string) {}

  static default(dir?: string): FileKeychain {
    const base =
      dir ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".memory-backbone");
    return new FileKeychain(path.join(base, "mk.key"));
  }

  async getMk(): Promise<Uint8Array | null> {
    try {
      const b64 = (await fs.readFile(this.filePath, "utf8")).trim();
      return fromBase64(b64);
    } catch {
      return null;
    }
  }

  async setMk(mk: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, toBase64(mk), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async deleteMk(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
