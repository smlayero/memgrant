/**
 * 配对协议（方案 §4.4，修复 v1 P1 MITM）。
 *
 * 流程（设备配对，MK 传输）：
 *   1. 设备 A 生成 6 位配对码，云端 KV 注册会话（TTL 5 分钟，10 次尝试上限）
 *   2. 设备 B 输入配对码
 *   3. 双方 SPAKE2：云端只见公开消息，被动解密/离线字典攻击不可行
 *   4. 确认值互换（HMAC），任何 MITM 替换必然失败
 *   5. 用会话密钥 Ke 加密传输 MK（设备配对）或 Agent 公钥（Agent 配对）
 *
 * 云端只是信箱：PairingChannel 抽象下，测试用内存通道，生产用云端 KV 端点。
 */
import { Spake2Session } from "./spake2.js";
import { randomBytes, toBase64, fromBase64, concatBytes } from "../crypto/random.js";
import { generateAgentKeyPair, type AgentKeyPair } from "../crypto/ecies.js";

export interface PairingMessage {
  from: "A" | "B";
  type:
    | "share-a"
    | "share-b"
    | "conf-a"
    | "conf-b"
    | "mk-transfer"
    | "agent-pubkey"
    | "device-pubkey"
    | "device-cred";
  body: string; // base64
}

/** 配对消息通道（云端 KV 会话 / 测试内存通道）。 */
export interface PairingChannel {
  create(code: string, first: PairingMessage): Promise<void>;
  post(code: string, message: PairingMessage): Promise<void>;
  /** 拉取自 sinceIndex 起的消息；会话不存在返回 null。 */
  poll(code: string, sinceIndex: number): Promise<PairingMessage[] | null>;
}

export function generatePairingCode(): string {
  const buf = randomBytes(4);
  const n = ((buf[0]! << 24) >>> 0) + ((buf[1]! << 16) | (buf[2]! << 8) | buf[3]!);
  return (n % 1_000_000).toString().padStart(6, "0");
}

const PAIRING_AAD = "memory-backbone/pairing/v1";

async function sealWithSessionKey(
  ke: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    ke as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return concatBytes(iv, ct);
}

async function openWithSessionKey(
  ke: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  const iv = sealed.slice(0, 12);
  const ct = sealed.slice(12);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    ke as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ct as BufferSource,
    ),
  );
}

function sessionParams(role: "A" | "B", code: string): {
  identitySelf: string;
  identityPeer: string;
  aad: string;
} {
  return {
    identitySelf: role === "A" ? "device-a" : "device-b",
    identityPeer: role === "A" ? "device-b" : "device-a",
    aad: `${PAIRING_AAD}/${code}`,
  };
}

// ---------- 设备 A（发起方，持有 MK 或执行授权） ----------

export class PairingInitiator {
  readonly code: string;
  private readonly session: Spake2Session;
  private step = 0;

  constructor(
    private readonly channel: PairingChannel,
    code?: string,
  ) {
    this.code = code ?? generatePairingCode();
    this.session = Spake2Session.start("A", this.code, sessionParams("A", this.code));
  }

  /** 步骤 1：注册会话并发布 pA。 */
  async start(): Promise<void> {
    await this.channel.create(this.code, {
      from: "A",
      type: "share-a",
      body: toBase64(this.session.getShare()),
    });
    this.step = 1;
  }

  /** 步骤 2：收到 pB 后发布确认值 cA。 */
  async acceptShare(): Promise<void> {
    const msgs = await this.waitFor("share-b");
    this.session.receiveShare(fromBase64(msgs.body));
    await this.channel.post(this.code, {
      from: "A",
      type: "conf-a",
      body: toBase64(this.session.getConfirmation()),
    });
    this.step = 2;
  }

  /** 步骤 3：验证 cB。失败 = 口令错误或 MITM（S3）。 */
  async verify(): Promise<boolean> {
    const msgs = await this.waitFor("conf-b");
    return this.session.verifyConfirmation(fromBase64(msgs.body));
  }

  /** 设备配对：加密传输 MK。 */
  async sendMk(mk: Uint8Array): Promise<void> {
    const sealed = await sealWithSessionKey(this.session.getSharedKey(), mk);
    await this.channel.post(this.code, {
      from: "A",
      type: "mk-transfer",
      body: toBase64(sealed),
    });
  }

  /** Agent 配对：接收经会话密钥加密的 Agent 公钥（MITM 无法伪造）。 */
  async receiveAgentPubkey(): Promise<Uint8Array> {
    const msgs = await this.waitFor("agent-pubkey");
    return openWithSessionKey(
      this.session.getSharedKey(),
      fromBase64(msgs.body),
    );
  }

  async receiveDevicePubkey(): Promise<Uint8Array> {
    const msgs = await this.waitFor("device-pubkey");
    return openWithSessionKey(
      this.session.getSharedKey(),
      fromBase64(msgs.body),
    );
  }

  async sendDeviceCred(cred: {
    userId: string;
    deviceId: string;
    deviceToken: string;
  }): Promise<void> {
    const sealed = await sealWithSessionKey(
      this.session.getSharedKey(),
      new TextEncoder().encode(JSON.stringify(cred)),
    );
    await this.channel.post(this.code, {
      from: "A",
      type: "device-cred",
      body: toBase64(sealed),
    });
  }

  getSasFingerprint(): string {
    return this.session.getSasFingerprint();
  }

  private async waitFor(
    type: PairingMessage["type"],
    timeoutMs = 120_000,
  ): Promise<PairingMessage> {
    const deadline = Date.now() + timeoutMs;
    let index = 0;
    while (Date.now() < deadline) {
      const msgs = await this.channel.poll(this.code, index);
      if (msgs === null) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      index += msgs.length;
      const hit = msgs.find((m) => m.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
}

// ---------- 设备 B / Agent（加入方） ----------

export class PairingJoiner {
  private readonly session: Spake2Session;
  private agentKeys: AgentKeyPair | null = null;

  /**
   * @param sessionCode 云端会话标识（正常情况 = 配对码）
   * @param password    SPAKE2 口令；默认与 sessionCode 相同，
   *                    分离参数用于"输错配对码"等异常路径测试
   */
  constructor(
    private readonly channel: PairingChannel,
    private readonly code: string,
    password?: string,
  ) {
    const pw = password ?? code;
    this.session = Spake2Session.start("B", pw, sessionParams("B", pw));
  }

  /** 步骤 1：取 pA，回发 pB 与确认值 cB。 */
  async join(): Promise<void> {
    const shareA = await this.waitFor("share-a");
    this.session.receiveShare(fromBase64(shareA.body));
    await this.channel.post(this.code, {
      from: "B",
      type: "share-b",
      body: toBase64(this.session.getShare()),
    });
    await this.channel.post(this.code, {
      from: "B",
      type: "conf-b",
      body: toBase64(this.session.getConfirmation()),
    });
  }

  /** 步骤 2：验证 cA。 */
  async verify(): Promise<boolean> {
    const confA = await this.waitFor("conf-a");
    return this.session.verifyConfirmation(fromBase64(confA.body));
  }

  /** 设备配对：接收并解密 MK。 */
  async receiveMk(): Promise<Uint8Array> {
    const msg = await this.waitFor("mk-transfer");
    return openWithSessionKey(
      this.session.getSharedKey(),
      fromBase64(msg.body),
    );
  }

  /** Agent 配对：本地生成永久密钥对，公钥经会话密钥加密后登记（方案 §4.3 步骤 1-2）。 */
  async sendAgentPubkey(): Promise<AgentKeyPair> {
    this.agentKeys = generateAgentKeyPair();
    const sealed = await sealWithSessionKey(
      this.session.getSharedKey(),
      this.agentKeys.publicKey,
    );
    await this.channel.post(this.code, {
      from: "B",
      type: "agent-pubkey",
      body: toBase64(sealed),
    });
    return this.agentKeys;
  }

  async sendDevicePubkey(publicKey: Uint8Array): Promise<void> {
    const sealed = await sealWithSessionKey(this.session.getSharedKey(), publicKey);
    await this.channel.post(this.code, {
      from: "B",
      type: "device-pubkey",
      body: toBase64(sealed),
    });
  }

  async receiveDeviceCred(): Promise<{
    userId: string;
    deviceId: string;
    deviceToken: string;
  }> {
    const msg = await this.waitFor("device-cred");
    const raw = await openWithSessionKey(
      this.session.getSharedKey(),
      fromBase64(msg.body),
    );
    return JSON.parse(new TextDecoder().decode(raw)) as {
      userId: string;
      deviceId: string;
      deviceToken: string;
    };
  }

  getSasFingerprint(): string {
    return this.session.getSasFingerprint();
  }

  private async waitFor(
    type: PairingMessage["type"],
    timeoutMs = 120_000,
  ): Promise<PairingMessage> {
    const deadline = Date.now() + timeoutMs;
    let index = 0;
    while (Date.now() < deadline) {
      const msgs = await this.channel.poll(this.code, index);
      if (msgs === null) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      index += msgs.length;
      const hit = msgs.find((m) => m.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
}

/** 测试/开发用内存通道（生产为云端 KV 端点）。 */
export class InMemoryPairingChannel implements PairingChannel {
  private sessions = new Map<
    string,
    { messages: PairingMessage[]; expiresAt: number; attempts: number }
  >();
  private readonly maxAttempts = 10;

  async create(code: string, first: PairingMessage): Promise<void> {
    this.sessions.set(code, {
      messages: [first],
      expiresAt: Date.now() + 5 * 60 * 1000, // TTL 5 分钟（方案 §4.4）
      attempts: 0,
    });
  }

  async post(code: string, message: PairingMessage): Promise<void> {
    const s = this.sessions.get(code);
    if (!s || s.expiresAt < Date.now()) throw new Error("session expired");
    s.attempts++;
    if (s.attempts > this.maxAttempts) {
      this.sessions.delete(code);
      throw new Error("too many attempts");
    }
    s.messages.push(message);
  }

  async poll(code: string, sinceIndex: number): Promise<PairingMessage[] | null> {
    const s = this.sessions.get(code);
    if (!s || s.expiresAt < Date.now()) return null;
    return s.messages.slice(sinceIndex);
  }
}
