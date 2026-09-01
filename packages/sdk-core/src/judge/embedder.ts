/**
 * Embedding 接口与内置 fallback（方案 §8.3：bge-m3 为正式向量模型）。
 *
 * 设计：Embedder 是可插拔接口。Phase 1 内置 HashEmbedder（确定性、零依赖、
 * 中英双语可用），保证检索链路端到端可运行、可测试；M4-M5 发布
 * bge-m3（ONNX）后按同一接口替换，上层（向量索引/混合检索）零改动。
 *
 * 隐私纪律不变：embedding 只在本地计算与使用（方案 §3.3：encrypted_embedding 可空，
 * 云端不可检索密文向量，检索永远在本地完成）。
 */
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "../crypto/random.js";

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

/**
 * 确定性哈希 Embedder（fallback，非语义模型）：
 * - 拉丁词干 token + CJK 字 bigram/unigram
 * - 每个 token 经 SHA-256 映射到带符号维度（特征哈希），L2 归一化
 * 能捕捉词汇重叠，不含语义泛化；bge-m3 接入后直接替换。
 */
export class HashEmbedder implements Embedder {
  readonly id = "hash-embedder-v1";
  readonly dim: number;

  constructor(dim = 256) {
    this.dim = dim;
  }

  embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    for (const token of tokenize(text)) {
      const h = sha256(utf8ToBytes(token));
      const idx =
        ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % this.dim;
      const sign = (h[3]! & 1) === 0 ? 1 : -1;
      vec[idx]! += sign;
    }
    // L2 归一化
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
    return Promise.resolve(vec);
  }
}

/** 分词：拉丁词 + CJK unigram/bigram。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  // 拉丁/数字词
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) {
    out.push(`w:${m[0]}`);
  }
  // CJK 字符
  const cjk = [...lower].filter((ch) => /[一-鿿]/.test(ch));
  for (const ch of cjk) out.push(`c:${ch}`);
  for (let i = 0; i + 1 < cjk.length; i++) {
    out.push(`b:${cjk[i]}${cjk[i + 1]}`);
  }
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function float32ToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(0));
}

export function bytesToFloat32(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer);
}
