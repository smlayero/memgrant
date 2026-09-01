/**
 * AES-256-GCM 内容加密（方案 §4.1：每条记忆随机 DEK）。
 * 密文格式：iv(12B) || ciphertext || auth_tag(16B) —— WebCrypto 输出已含 tag。
 */
import { randomBytes, concatBytes } from "./random.js";

export const DEK_BYTES = 32;
export const GCM_IV_BYTES = 12;

export interface SealedBox {
  /** iv || ciphertext+tag */
  sealed: Uint8Array;
  iv: Uint8Array;
}

async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export function generateDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

export async function sealWithDek(
  dek: Uint8Array,
  plaintext: Uint8Array,
): Promise<SealedBox> {
  if (dek.length !== DEK_BYTES) throw new Error("DEK must be 32 bytes");
  const iv = randomBytes(GCM_IV_BYTES);
  const key = await importAesGcmKey(dek);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return { sealed: concatBytes(iv, ct), iv };
}

export async function openWithDek(
  dek: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  if (dek.length !== DEK_BYTES) throw new Error("DEK must be 32 bytes");
  if (sealed.length <= GCM_IV_BYTES) throw new Error("sealed too short");
  const iv = sealed.slice(0, GCM_IV_BYTES);
  const ct = sealed.slice(GCM_IV_BYTES);
  const key = await importAesGcmKey(dek);
  // 认证失败时 WebCrypto 抛 OperationError —— 保证完整性失败即拒绝
  const pt = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}
