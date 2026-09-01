/**
 * MK 派生与恢复（方案 §4.2，修复 v1 P0）。
 *
 * 助记词与 MK 的关系：首设备生成随机 entropy → BIP-39 助记词（唯一的"主秘密"）；
 * MK 永远通过 PBKDF2(mnemonic, fixed_salt) 派生 —— 生成路径与恢复路径走同一函数，
 * 保证"两台设备 + 同一助记词 + 同一 fixed_salt → 同一 MK"（验收 S1）。
 *
 * fixed_salt 是用户级固定值（注册时生成，随账号存云端），不是秘密；
 * 严禁使用 device_id 等设备级标识（v1 因此灾难恢复失效）。
 */
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes, utf8ToBytes, toHex, fromHex, concatBytes } from "./random.js";

export const MK_BYTES = 32;
export const FIXED_SALT_BYTES = 16;
export const PBKDF2_ITERATIONS = 600_000;

export interface MnemonicBundle {
  /** 24 词助记词，仅向用户展示一次，由用户自持 */
  mnemonic: string;
  /** 派生出的用户主密钥 */
  mk: Uint8Array;
  /** 用户级固定 salt（hex），注册时上送云端 */
  fixedSaltHex: string;
}

/** 首设备：生成助记词并派生 MK（生成路径与恢复路径同为 PBKDF2，保证一致性）。 */
export function generateMnemonicBundle(): MnemonicBundle {
  // 256-bit entropy → 24 词
  const mnemonic = generateMnemonic(wordlist, 256);
  const fixedSaltHex = toHex(randomBytes(FIXED_SALT_BYTES));
  const mk = deriveMkFromMnemonic(mnemonic, fixedSaltHex);
  return { mnemonic, mk, fixedSaltHex };
}

/** 恢复路径 / 生成路径共用的唯一派生函数。 */
export function deriveMkFromMnemonic(
  mnemonic: string,
  fixedSaltHex: string,
): Uint8Array {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("invalid BIP-39 mnemonic");
  }
  const salt = fromHex(fixedSaltHex);
  if (salt.length !== FIXED_SALT_BYTES) {
    throw new Error("fixed_salt must be 16 bytes hex");
  }
  return pbkdf2(sha256, utf8ToBytes(normalized), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: MK_BYTES,
  });
}

const RECOVERY_DOMAIN = "memory-backbone/recover/v1";

/** 助记词恢复证明：云端只存哈希，永不上传 MK。 */
export function recoveryVerifier(mk: Uint8Array): string {
  return toHex(sha256(concatBytes(utf8ToBytes(RECOVERY_DOMAIN), mk)));
}
