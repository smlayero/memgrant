/**
 * AES-KW：MK 包裹/解包裹 DEK（方案 §4.1 用户设备解密路径 wrapped_dek）。
 * MK 轮换时只需重加密全部 wrapped_dek（每条 40B），Agent grants 不受影响。
 */
async function importAesKwKey(mk: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    mk as BufferSource,
    { name: "AES-KW" },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function importRawAesGcm(dek: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    dek as BufferSource,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
}

/** MK 包裹 DEK → wrapped_dek（40B：32B 密钥 + 8B 完整性校验）。 */
export async function wrapDekWithMk(
  mk: Uint8Array,
  dek: Uint8Array,
): Promise<Uint8Array> {
  const kek = await importAesKwKey(mk);
  const dekKey = await importRawAesGcm(dek);
  const wrapped = await globalThis.crypto.subtle.wrapKey(
    "raw",
    dekKey,
    kek,
    { name: "AES-KW" },
  );
  return new Uint8Array(wrapped);
}

/** MK 解包裹 wrapped_dek → DEK。MK 错误时抛错（完整性校验失败）。 */
export async function unwrapDekWithMk(
  mk: Uint8Array,
  wrappedDek: Uint8Array,
): Promise<Uint8Array> {
  const kek = await importAesKwKey(mk);
  const dekKey = await globalThis.crypto.subtle.unwrapKey(
    "raw",
    wrappedDek as BufferSource,
    kek,
    { name: "AES-KW" },
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
  const raw = await globalThis.crypto.subtle.exportKey("raw", dekKey);
  return new Uint8Array(raw);
}

/** MK 轮换：旧 MK 解出 DEK，新 MK 重包裹（grants 不受影响，方案 §4.6）。 */
export async function rewrapDek(
  oldMk: Uint8Array,
  newMk: Uint8Array,
  wrappedDek: Uint8Array,
): Promise<Uint8Array> {
  const dek = await unwrapDekWithMk(oldMk, wrappedDek);
  try {
    return await wrapDekWithMk(newMk, dek);
  } finally {
    dek.fill(0);
  }
}
