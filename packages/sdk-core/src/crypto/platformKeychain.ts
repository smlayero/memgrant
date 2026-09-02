/**
 * 平台安全存储 Keychain（方案 §6.1 crypto/Keychain 抽象落地）。
 *
 * 后端优先级：
 * - Windows：DPAPI（CryptProtectData，CurrentUser 域，经 PowerShell 调用）
 * - macOS：Keychain（security CLI）
 * - Linux：libsecret（secret-tool CLI）
 * - 兜底：FileKeychain（0600）+ 明确警告
 *
 * 所有后端都只把"加密后的 MK"落盘；明文 MK 只存在于进程内存。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  type Keychain,
  FileKeychain,
} from "./keychain.js";
import { toBase64, fromBase64, randomBytes } from "./random.js";

const execFileAsync = promisify(execFile);

/** execFile 不支持 input 选项，手工写 stdin（避免明文经命令行参数泄露）。 */
function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    child.stdin!.write(input);
    child.stdin!.end();
  });
}

const SERVICE_NAME = "memory-backbone";
const ACCOUNT_NAME = "mk";

function defaultDir(): string {
  return path.join(os.homedir(), ".memory-backbone");
}

/** Windows DPAPI：Protect/Unprotect 由系统完成用户域密钥管理。 */
export class DpapiKeychain implements Keychain {
  readonly id = "dpapi";
  private readonly filePath: string;

  constructor(dir?: string) {
    this.filePath = path.join(dir ?? defaultDir(), "mk.dpapi");
  }

  private async protect(b64Plain: string): Promise<string> {
    // base64 → DPAPI 加密 → base64，全程 stdin/stdout 不落明文
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$input_b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($input_b64)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;
    const stdout = await runWithStdin(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      b64Plain,
    );
    return stdout.trim();
  }

  private async unprotect(b64Protected: string): Promise<string> {
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$input_b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($input_b64)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;
    const stdout = await runWithStdin(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      b64Protected,
    );
    return stdout.trim();
  }

  async getMk(): Promise<Uint8Array | null> {
    try {
      const protectedB64 = (await fs.readFile(this.filePath, "utf8")).trim();
      const plainB64 = await this.unprotect(protectedB64);
      return fromBase64(plainB64);
    } catch {
      return null;
    }
  }

  async setMk(mk: Uint8Array): Promise<void> {
    const protectedB64 = await this.protect(toBase64(mk));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, protectedB64, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async deleteMk(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

/** macOS Keychain（security CLI）。 */
export class MacOsKeychain implements Keychain {
  readonly id = "macos-keychain";

  async getMk(): Promise<Uint8Array | null> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s", SERVICE_NAME,
        "-a", ACCOUNT_NAME,
        "-w",
      ]);
      return fromBase64(stdout.trim());
    } catch {
      return null;
    }
  }

  async setMk(mk: Uint8Array): Promise<void> {
    // 先删后加，避免重复项
    await this.deleteMk();
    await execFileAsync("security", [
      "add-generic-password",
      "-s", SERVICE_NAME,
      "-a", ACCOUNT_NAME,
      "-w", toBase64(mk),
      "-U",
    ]);
  }

  async deleteMk(): Promise<void> {
    await execFileAsync("security", [
      "delete-generic-password",
      "-s", SERVICE_NAME,
      "-a", ACCOUNT_NAME,
    ]).catch(() => undefined);
  }
}

/** Linux libsecret（secret-tool CLI）。 */
export class LinuxSecretKeychain implements Keychain {
  readonly id = "libsecret";

  async getMk(): Promise<Uint8Array | null> {
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup",
        "service", SERVICE_NAME,
        "account", ACCOUNT_NAME,
      ]);
      return fromBase64(stdout.trim());
    } catch {
      return null;
    }
  }

  async setMk(mk: Uint8Array): Promise<void> {
    await runWithStdin(
      "secret-tool",
      ["store", "--label", SERVICE_NAME, "service", SERVICE_NAME, "account", ACCOUNT_NAME],
      toBase64(mk),
    );
  }

  async deleteMk(): Promise<void> {
    await execFileAsync("secret-tool", [
      "clear",
      "service", SERVICE_NAME,
      "account", ACCOUNT_NAME,
    ]).catch(() => undefined);
  }
}

/** 按平台自动选择；无平台后端时降级文件存储并显式警告。 */
export function createPlatformKeychain(dir?: string): Keychain {
  switch (process.platform) {
    case "win32":
      return new DpapiKeychain(dir);
    case "darwin":
      return new MacOsKeychain();
    case "linux":
      return new LinuxSecretKeychain();
    default:
      console.warn(
        `[memgrant] 无平台安全存储后端（${process.platform}），降级文件 Keychain（0600）`,
      );
      return FileKeychain.default(dir);
  }
}

/**
 * 生产默认：平台 Keychain，失败或读不到则 0600 文件兜底。
 * 文件路径会在首次降级时警告一次。
 */
export function createBestKeychain(dir?: string): Keychain {
  const platform = createPlatformKeychain(dir);
  if (platform.id === "file") return platform;
  return new FallbackKeychain(platform, FileKeychain.default(dir));
}

class FallbackKeychain implements Keychain {
  private warned = false;

  constructor(
    private readonly primary: Keychain,
    private readonly fallback: Keychain,
  ) {}

  get id(): string {
    return `${this.primary.id}+file-fallback`;
  }

  async getMk(): Promise<Uint8Array | null> {
    try {
      const mk = await this.primary.getMk();
      if (mk) return mk;
    } catch {
      this.warn();
    }
    return this.fallback.getMk();
  }

  async setMk(mk: Uint8Array): Promise<void> {
    try {
      await this.primary.setMk(mk);
      return;
    } catch {
      this.warn();
      await this.fallback.setMk(mk);
    }
  }

  async deleteMk(): Promise<void> {
    await this.primary.deleteMk().catch(() => undefined);
    await this.fallback.deleteMk().catch(() => undefined);
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      "[memgrant] 平台 Keychain 不可用，MK 降级写入 0600 文件。见 SECURITY.md",
    );
  }
}

/** 平台后端可用性自检（用于 setup 流程提示）。 */
export async function probePlatformKeychain(): Promise<{
  backend: string;
  ok: boolean;
}> {
  const kc = createPlatformKeychain();
  const probe = randomBytes(32);
  try {
    await kc.setMk(probe);
    const back = await kc.getMk();
    await kc.deleteMk();
    return {
      backend: kc.id,
      ok: back !== null && toBase64(back) === toBase64(probe),
    };
  } catch {
    return { backend: kc.id, ok: false };
  } finally {
    probe.fill(0);
  }
}
