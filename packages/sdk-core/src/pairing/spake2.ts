/**
 * SPAKE2 配对原语（RFC 9382，套件 P256-SHA256-HKDF-HMAC）。
 *
 * 用于方案 §4.4 配对协议：6 位配对码 = 口令；云端只做消息中继，
 * 只见公开消息（pA/pB/确认 MAC），无法被动解密、无法离线字典攻击，
 * 替换公钥中间人攻击必然导致确认失败（验收 S3）。
 *
 * 实现纪律：
 * - 椭圆曲线运算全部使用 @noble/curves（审计过的底层原语），本文件只做 RFC 协议编排
 * - 本实现已通过 RFC 9382 Appendix B 官方测试向量验证（见 test/spake2.test.ts）
 * - 生产发布前仍建议第三方审计（方案风险表 #5 的保守纪律）
 *
 * w 派生（RFC §3.2 要求上层定义）：w = scrypt(code, 固定域分隔 salt, N=2^15,r=8,p=1, 40B) mod n
 * 40B 输出比群阶多 64bit，消除取模统计偏差（NIST SP 800-56Ar3）。
 */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { scrypt } from "@noble/hashes/scrypt";
import {
  bytesToNumberBE,
  numberToBytesBE,
  concatBytes,
  utf8ToBytes,
} from "./spake2Utils.js";

const CURVE_N = p256.CURVE.n;

/** RFC 9382 §6 P-256 固定群元素（SEC1 压缩格式） */
const M_COMPRESSED =
  "02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f";
const N_COMPRESSED =
  "03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49";

const M = p256.ProjectivePoint.fromHex(M_COMPRESSED);
const N = p256.ProjectivePoint.fromHex(N_COMPRESSED);

const W_SALT = "memory-backbone/spake2/w/v1";
const CONFIRMATION_INFO = "ConfirmationKeys";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** w = MHF(password) mod n（RFC §3.2；MHF 选 scrypt，40B 输出消偏差）。 */
export function deriveW(password: string): Uint8Array {
  const wide = scrypt(utf8ToBytes(password), utf8ToBytes(W_SALT), {
    N: 32768,
    r: 8,
    p: 1,
    dkLen: 40,
  });
  const w = bytesToNumberBE(wide) % CURVE_N;
  wide.fill(0);
  return numberToBytesBE(w, 32);
}

/** 8 字节小端长度前缀（RFC §3.3 len() 编码）。 */
function lenPrefix(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, data.length, true);
  return out;
}

function transcriptPart(data: Uint8Array): Uint8Array {
  return concatBytes(lenPrefix(data), data);
}

export interface Spake2Params {
  /** 本方身份（写入 TT，防 unknown key-share） */
  identitySelf: string;
  identityPeer: string;
  /** 附加认证数据（可选），进入确认密钥派生 */
  aad?: string;
}

type Role = "A" | "B";

export class Spake2Session {
  private readonly role: Role;
  private readonly params: Spake2Params;
  private readonly w: bigint;
  private readonly scalar: bigint; // x 或 y
  private readonly share: Uint8Array; // pA 或 pB（65B 未压缩）
  private peerShare: Uint8Array | null = null;
  private tt: Uint8Array | null = null;
  private ke: Uint8Array | null = null;
  private kcSelf: Uint8Array | null = null;
  private kcPeer: Uint8Array | null = null;

  private constructor(
    role: Role,
    params: Spake2Params,
    wBytes: Uint8Array,
    scalar: bigint,
  ) {
    this.role = role;
    this.params = params;
    this.w = bytesToNumberBE(wBytes);
    this.scalar = scalar;
    const g = p256.ProjectivePoint.BASE;
    // pA = w*M + x*P；pB = w*N + y*P（RFC §3.3）
    const sharePoint =
      role === "A"
        ? M.multiply(this.w).add(g.multiply(this.scalar))
        : N.multiply(this.w).add(g.multiply(this.scalar));
    this.share = sharePoint.toRawBytes(false);
  }

  /** 开始会话：随机选取标量，生成公开份额。 */
  static start(
    role: Role,
    password: string,
    params: Spake2Params,
  ): Spake2Session {
    const wBytes = deriveW(password);
    const scalar = bytesToNumberBE(p256.utils.randomPrivateKey());
    try {
      return new Spake2Session(role, params, wBytes, scalar);
    } finally {
      wBytes.fill(0);
    }
  }

  /** 测试专用：注入确定性标量与 w（RFC 测试向量用）。 */
  static forTest(
    role: Role,
    wHex: string,
    scalarHex: string,
    params: Spake2Params,
  ): Spake2Session {
    return new Spake2Session(
      role,
      params,
      fromHex(wHex),
      bytesToNumberBE(fromHex(scalarHex)),
    );
  }

  /** 本方公开份额 pA/pB（65B 未压缩 SEC1 点），可安全经云端中继。 */
  getShare(): Uint8Array {
    return new Uint8Array(this.share);
  }

  /**
   * 接收对方份额，计算共享群元素 K 与 TT，派生 Ke/Ka/确认密钥。
   * 群成员资格检查失败即抛错中止（RFC §7 强制要求）。
   */
  receiveShare(peerShare: Uint8Array): void {
    if (peerShare.length !== 65) throw new Error("invalid peer share length");
    const peerPoint = p256.ProjectivePoint.fromHex(peerShare); // 含曲线成员检查
    // K = h*s*(peer - w*blinder)，P-256 余因子 h=1
    const kPoint =
      this.role === "A"
        ? peerPoint.subtract(N.multiply(this.w)).multiply(this.scalar)
        : peerPoint.subtract(M.multiply(this.w)).multiply(this.scalar);
    if (kPoint.equals(p256.ProjectivePoint.ZERO)) {
      throw new Error("invalid shared point");
    }
    const kBytes = kPoint.toRawBytes(false);

    const idA = utf8ToBytes(
      this.role === "A" ? this.params.identitySelf : this.params.identityPeer,
    );
    const idB = utf8ToBytes(
      this.role === "A" ? this.params.identityPeer : this.params.identitySelf,
    );
    const pA = this.role === "A" ? this.share : peerShare;
    const pB = this.role === "A" ? peerShare : this.share;
    const wBytes = numberToBytesBE(this.w, 32);

    this.tt = concatBytes(
      transcriptPart(idA),
      transcriptPart(idB),
      transcriptPart(pA),
      transcriptPart(pB),
      transcriptPart(kBytes),
      transcriptPart(wBytes),
    );
    wBytes.fill(0);
    this.peerShare = new Uint8Array(peerShare);

    // Ke || Ka = Hash(TT)，各 128bit（RFC §4）
    const hash = sha256(this.tt);
    this.ke = hash.slice(0, 16);
    const ka = hash.slice(16, 32);

    // KcA || KcB = HKDF(Ka, nil, "ConfirmationKeys" || AAD)
    const info = this.params.aad
      ? concatBytes(utf8ToBytes(CONFIRMATION_INFO), utf8ToBytes(this.params.aad))
      : utf8ToBytes(CONFIRMATION_INFO);
    const kc = hkdf(sha256, ka, undefined, info, 32);
    const [kcA, kcB] = [kc.slice(0, 16), kc.slice(16, 32)];
    this.kcSelf = this.role === "A" ? kcA : kcB;
    this.kcPeer = this.role === "A" ? kcB : kcA;
  }

  /** 本方确认值 c = HMAC(Kc_self, TT)。 */
  getConfirmation(): Uint8Array {
    if (!this.tt || !this.kcSelf) throw new Error("share not received yet");
    return hmac(sha256, this.kcSelf, this.tt);
  }

  /** 校验对方确认值；不匹配 = 口令错误或中间人（S3 验收点）。 */
  verifyConfirmation(peerConfirmation: Uint8Array): boolean {
    if (!this.tt || !this.kcPeer) throw new Error("share not received yet");
    const expected = hmac(sha256, this.kcPeer, this.tt);
    if (expected.length !== peerConfirmation.length) return false;
    // 常数时间比较
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected[i]! ^ peerConfirmation[i]!;
    }
    return diff === 0;
  }

  /** 会话密钥 Ke：仅在确认通过后使用。 */
  getSharedKey(): Uint8Array {
    if (!this.ke) throw new Error("share not received yet");
    return new Uint8Array(this.ke);
  }

  /**
   * SAS 指纹（方案 §4.4 可选增强）：6 位数字，双端肉眼比对。
   * 由 Ke 派生，中间人无法让两端显示相同指纹。
   */
  getSasFingerprint(): string {
    const key = this.getSharedKey();
    // 与角色无关的确定性顺序：pA 在前、pB 在后
    const pA = this.role === "A" ? this.share : this.peerShare!;
    const pB = this.role === "A" ? this.peerShare! : this.share;
    const hash = sha256(concatBytes(key, pA, pB));
    const n = bytesToNumberBE(hash.slice(0, 4)) % 1_000_000n;
    return n.toString().padStart(6, "0");
  }
}
