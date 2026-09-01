import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const AUTH_SCHEME = "MB1";

export function canonicalMb1(
  deviceId: string,
  nonce: string,
  ts: string,
  method: string,
  path: string,
): string {
  return [AUTH_SCHEME, deviceId, nonce, ts, method.toUpperCase(), path].join("\n");
}

export function parseMb1Header(header: string): {
  deviceId: string;
  ts: string;
  nonce: string;
  signature: Uint8Array;
} | null {
  if (!header.startsWith(`${AUTH_SCHEME} `)) return null;
  const parts = header.slice(AUTH_SCHEME.length + 1).split(" ");
  if (parts.length !== 4) return null;
  const [deviceId, ts, nonce, sigB64] = parts;
  if (!deviceId || !ts || !nonce || !sigB64) return null;
  try {
    const bin = atob(sigB64);
    const signature = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) signature[i] = bin.charCodeAt(i);
    return { deviceId, ts, nonce, signature };
  } catch {
    return null;
  }
}

export function verifyMb1(
  deviceId: string,
  nonce: string,
  ts: string,
  method: string,
  path: string,
  publicKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  const msg = new TextEncoder().encode(
    canonicalMb1(deviceId, nonce, ts, method, path),
  );
  const hash = sha256(msg);
  return secp256k1.verify(signature, hash, publicKey);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
