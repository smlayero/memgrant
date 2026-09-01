/**
 * ECIES（secp256k1 + HKDF-SHA256 + AES-256-GCM），方案 §4.1/§4.3。
 *
 * Agent 解密路径：每条授权记忆一份 enc_dek = ECIES(agent_pubkey, DEK)。
 * Agent 自始至终不接触 MK，且只能解开有 grant 的记忆（验收 S4）。
 *
 * enc_dek 格式（93B）：ephemeral_pubkey(33B 压缩) || iv(12B) || ct(32B)+tag(16B)
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes, concatBytes } from "./random.js";

const ECIES_INFO = "memory-backbone/ecies/v1";
export const ENC_DEK_BYTES = 33 + 12 + 32 + 16;

export interface AgentKeyPair {
  /** 压缩公钥（33B），经 PAKE 配对认证后登记云端 */
  publicKey: Uint8Array;
  /** 私钥（32B），不出 Agent 环境 */
  secretKey: Uint8Array;
}

/** Agent 配对时在本地生成永久密钥对（方案 §4.3 步骤 1）。 */
export function generateAgentKeyPair(): AgentKeyPair {
  const secretKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(secretKey, true);
  return { publicKey, secretKey };
}

function ecdhSharedKey(
  secretKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  const shared = secp256k1.getSharedSecret(secretKey, publicKey, true);
  // 去掉压缩前缀字节，取 x 坐标做 HKDF 输入
  return hkdf(sha256, shared.slice(1), undefined, ECIES_INFO, 32);
}

/** 用户设备：为某 Agent 生成该记忆的授权凭据 enc_dek。 */
export async function eciesEncryptDek(
  agentPublicKey: Uint8Array,
  dek: Uint8Array,
): Promise<Uint8Array> {
  const ephemeral = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeral, true);
  const key = ecdhSharedKey(ephemeral, agentPublicKey);
  const iv = randomBytes(12);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      cryptoKey,
      dek as BufferSource,
    ),
  );
  ephemeral.fill(0);
  key.fill(0);
  return concatBytes(ephemeralPub, iv, ct);
}

/** Agent 侧：用自己的私钥解开 enc_dek → DEK。非授权/被篡改则抛错。 */
export async function eciesDecryptDek(
  agentSecretKey: Uint8Array,
  encDek: Uint8Array,
): Promise<Uint8Array> {
  if (encDek.length !== ENC_DEK_BYTES) {
    throw new Error(`enc_dek must be ${ENC_DEK_BYTES} bytes`);
  }
  const ephemeralPub = encDek.slice(0, 33);
  const iv = encDek.slice(33, 45);
  const ct = encDek.slice(45);
  const key = ecdhSharedKey(agentSecretKey, ephemeralPub);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      cryptoKey,
      ct as BufferSource,
    );
    return new Uint8Array(pt);
  } finally {
    key.fill(0);
  }
}
