/**
 * MemoryService：写入/读取主链路编排（方案 §2.2）。
 *
 * 写入：本地判断（明文不出设备）→ 随机 DEK → AES-256-GCM 加密 →
 *       MK 包裹 DEK（wrapped_dek）+ 每个覆盖 Agent 一份 ECIES grant →
 *       本地缓存明文 + 离线队列（密文载荷）→ 联网推送。
 * 读取（用户设备）：本地优先，直接读本地缓存明文。
 * 读取（Agent）：拉密文 + 该 Agent 的 grant → agent_sk 解 ECIES 得 DEK → 解明文。
 *   Agent 自始至终不接触 MK，且只能解开有 grant 的记忆（验收 S4）。
 */
import { randomBytes, toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "../crypto/random.js";
import { generateDek, sealWithDek, openWithDek } from "../crypto/aead.js";
import { wrapDekWithMk, unwrapDekWithMk } from "../crypto/wrap.js";
import { eciesDecryptDek } from "../crypto/ecies.js";
import {
  createIncrementalGrants,
  type AgentAccess,
  type Grant,
} from "../crypto/grants.js";
import type { Keychain } from "../crypto/keychain.js";
import type { LocalStore, LocalMemory } from "../cache/localStore.js";
import { type JudgeInput, type JudgeResult } from "../judge/rules.js";
import { rulesJudge, type Judge } from "../judge/compose.js";
import { HashEmbedder, type Embedder } from "../judge/embedder.js";

export interface SaveMemoryInput extends JudgeInput {
  memoryId?: string;
  now?: string;
}

export interface SaveMemoryResult {
  stored: boolean;
  memoryId: string;
  judge: JudgeResult;
  grants: Grant[];
}

/** 上送云端的写入载荷：只有密文与最少元数据，零明文。 */
export interface MemorySyncPayload {
  op: "create" | "update" | "delete";
  memory_id: string;
  ciphertext?: string; // base64(iv || ct+tag)
  wrapped_dek?: string; // base64
  type?: string;
  tags?: string[]; // 仅白名单类别级
  encrypted_tags?: string; // DEK 加密的敏感标签，禁入明文 tags
  permission_level?: number;
  importance?: number;
  source_agent?: string;
  judge_model_version?: string;
  size_bytes?: number;
  grants?: Grant[];
  updated_at: string;
}

export class MemoryService {
  private readonly judgeFn: Judge;
  private readonly embedder: Embedder;

  constructor(
    private readonly keychain: Keychain,
    private readonly store: LocalStore,
    private readonly agents: () => AgentAccess[],
    embedder?: Embedder,
    judge?: Judge,
  ) {
    this.embedder = embedder ?? new HashEmbedder();
    this.judgeFn = judge ?? rulesJudge;
  }

  /** 写入主链路。 */
  async saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
    const judge = await this.judgeFn(input);
    const memoryId =
      input.memoryId ?? toBase64(randomBytes(16)).replace(/[/+=]/g, "");
    if (!judge.shouldStore) {
      return { stored: false, memoryId, judge, grants: [] };
    }

    const mk = await this.requireMk();
    const dek = generateDek();
    const now = input.now ?? new Date().toISOString();
    try {
      const sealed = await sealWithDek(dek, utf8ToBytes(input.text));
      const wrappedDek = await wrapDekWithMk(mk, dek);
      const grants = await createIncrementalGrants(this.agents(), {
        memoryId,
        dek,
        permissionLevel: judge.permissionLevel,
      });

      let encryptedTags: string | undefined;
      if (judge.sensitiveTags.length > 0) {
        const sealedTags = await sealWithDek(
          dek,
          utf8ToBytes(JSON.stringify(judge.sensitiveTags)),
        );
        encryptedTags = toBase64(sealedTags.sealed);
      }

      // 本地明文缓存（本地优先，云端不可用可读）
      const local: LocalMemory = {
        memoryId,
        plaintext: input.text,
        type: judge.type,
        tags: judge.tags,
        permissionLevel: judge.permissionLevel,
        importance: judge.importance,
        sourceAgent: input.sourceAgent ?? null,
        createdAt: now,
        updatedAt: now,
        deleted: false,
      };
      this.store.putMemory(local, await this.embedder.embed(input.text));

      // 离线队列：只放密文载荷（验收 S6：任何持久化载体零明文事故面最小化）
      const payload: MemorySyncPayload = {
        op: "create",
        memory_id: memoryId,
        ciphertext: toBase64(sealed.sealed),
        wrapped_dek: toBase64(wrappedDek),
        type: judge.type,
        tags: judge.tags,
        permission_level: judge.permissionLevel,
        importance: judge.importance,
        judge_model_version: judge.engineVersion,
        size_bytes: sealed.sealed.length,
        grants,
        updated_at: now,
      };
      if (encryptedTags) payload.encrypted_tags = encryptedTags;
      if (input.sourceAgent) payload.source_agent = input.sourceAgent;
      this.store.enqueue("create", memoryId, JSON.stringify(payload));

      return { stored: true, memoryId, judge, grants };
    } finally {
      dek.fill(0);
    }
  }

  /** 用户设备读取：本地优先。 */
  readMemoryLocal(memoryId: string): LocalMemory | null {
    return this.store.getMemory(memoryId);
  }

  /** 用户设备解密云端密文（MK 解 wrapped_dek 路径）。 */
  async decryptAsUser(
    ciphertextB64: string,
    wrappedDekB64: string,
  ): Promise<string> {
    const mk = await this.requireMk();
    const dek = await unwrapDekWithMk(mk, fromBase64(wrappedDekB64));
    try {
      const pt = await openWithDek(dek, fromBase64(ciphertextB64));
      return bytesToUtf8(pt);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Agent 读取解密：agent_sk 解 ECIES 得 DEK → 解明文。
   * 无 grant（encDekB64 为空）即 404 等价物 —— 调用方在拉取层就拒绝。
   */
  static async decryptAsAgent(
    ciphertextB64: string,
    encDekB64: string,
    agentSecretKey: Uint8Array,
  ): Promise<string> {
    const dek = await eciesDecryptDek(agentSecretKey, fromBase64(encDekB64));
    try {
      const pt = await openWithDek(dek, fromBase64(ciphertextB64));
      return bytesToUtf8(pt);
    } finally {
      dek.fill(0);
    }
  }

  /** 删除：本地标记 + 队列删除指令（云端删密文+wrapped_dek+全部 grants）。 */
  async deleteMemory(memoryId: string): Promise<void> {
    const now = new Date().toISOString();
    this.store.markDeleted(memoryId, now);
    const payload: MemorySyncPayload = {
      op: "delete",
      memory_id: memoryId,
      updated_at: now,
    };
    this.store.enqueue("delete", memoryId, JSON.stringify(payload));
  }

  /**
   * 把云端拉回的密文写入本地缓存（多设备同步回填）。
   * 明文只在本机落盘。
   */
  async applyFetched(
    memoryId: string,
    fetched: {
      ciphertext: string;
      wrapped_dek: string;
      type?: string;
      tags?: string[];
      permission_level?: number;
      importance?: number;
      source_agent?: string | null;
      created_at?: string;
      updated_at?: string;
    },
  ): Promise<void> {
    const text = await this.decryptAsUser(fetched.ciphertext, fetched.wrapped_dek);
    const now = fetched.updated_at ?? new Date().toISOString();
    this.store.putMemory(
      {
        memoryId,
        plaintext: text,
        type: fetched.type ?? "event",
        tags: fetched.tags ?? [],
        permissionLevel: fetched.permission_level ?? 2,
        importance: fetched.importance ?? 0.5,
        sourceAgent: fetched.source_agent ?? null,
        createdAt: fetched.created_at ?? now,
        updatedAt: now,
        deleted: false,
      },
      await this.embedder.embed(text),
    );
  }

  private async requireMk(): Promise<Uint8Array> {
    const mk = await this.keychain.getMk();
    if (!mk) throw new Error("MK not available: device not initialized");
    return mk;
  }
}
