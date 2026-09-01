/**
 * 设备签名认证（MB1）：secp256k1 签 SHA-256(canonical)。
 * 设备私钥只留在本机；云端用登记过的 device_pubkey 验签。
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes, toBase64, fromBase64 } from "./random.js";

export const AUTH_SCHEME = "MB1";

export interface DeviceAuthInput {
  deviceId: string;
  nonce: string;
  ts: string;
  method: string;
  path: string;
}

export function canonicalDeviceAuth(input: DeviceAuthInput): string {
  return [
    AUTH_SCHEME,
    input.deviceId,
    input.nonce,
    input.ts,
    input.method.toUpperCase(),
    input.path,
  ].join("\n");
}

export function signDeviceAuth(
  input: DeviceAuthInput,
  secretKey: Uint8Array,
): Uint8Array {
  const hash = sha256(utf8ToBytes(canonicalDeviceAuth(input)));
  return secp256k1.sign(hash, secretKey).toCompactRawBytes();
}

export function verifyDeviceAuth(
  input: DeviceAuthInput,
  publicKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  const hash = sha256(utf8ToBytes(canonicalDeviceAuth(input)));
  return secp256k1.verify(signature, hash, publicKey);
}

export function formatMb1Header(
  input: DeviceAuthInput,
  signature: Uint8Array,
): string {
  return `${AUTH_SCHEME} ${input.deviceId} ${input.ts} ${input.nonce} ${toBase64(signature)}`;
}

export function parseMb1Header(header: string): {
  input: Omit<DeviceAuthInput, "method" | "path">;
  signature: Uint8Array;
} | null {
  if (!header.startsWith(`${AUTH_SCHEME} `)) return null;
  const parts = header.slice(AUTH_SCHEME.length + 1).split(" ");
  if (parts.length !== 4) return null;
  const [deviceId, ts, nonce, sigB64] = parts;
  if (!deviceId || !ts || !nonce || !sigB64) return null;
  try {
    return {
      input: { deviceId, ts, nonce },
      signature: fromBase64(sigB64),
    };
  } catch {
    return null;
  }
}
