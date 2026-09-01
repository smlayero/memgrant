/**
 * Grant 生成与维护（方案 §4.3）。
 *
 * - 新记忆写入：为每个覆盖的活跃 Agent 生成 1 条 grant（O(Agents)，写入路径无感）
 * - 新 Agent 全量授权：O(N) 分批后台任务（≤1000 条/批）
 * - 权限级别变更：重算该 Agent 全部 grants
 * - 撤销：云端删除 agent_access + 全部 grants，密码学上即时失效
 */
import { eciesEncryptDek } from "./ecies.js";
import { randomBytes, toBase64 } from "./random.js";

export interface AgentAccess {
  agentId: string;
  agentPublicKey: Uint8Array;
  /** 可访问的最高 permission_level（0-4） */
  permissionMask: number;
  status: "active" | "revoked";
}

export interface MemoryKeyMaterial {
  memoryId: string;
  dek: Uint8Array;
  permissionLevel: number;
}

export interface Grant {
  grantId: string;
  agentId: string;
  memoryId: string;
  /** base64(ECIES(agent_pubkey, DEK)) */
  encDekB64: string;
}

export function newGrantId(): string {
  return toBase64(randomBytes(16));
}

/** 单条 grant 生成。 */
export async function createGrant(
  access: AgentAccess,
  memory: MemoryKeyMaterial,
): Promise<Grant | null> {
  if (access.status !== "active") return null;
  if (memory.permissionLevel > access.permissionMask) return null;
  const encDek = await eciesEncryptDek(access.agentPublicKey, memory.dek);
  return {
    grantId: newGrantId(),
    agentId: access.agentId,
    memoryId: memory.memoryId,
    encDekB64: toBase64(encDek),
  };
}

/**
 * 增量路径：一条新记忆为所有覆盖的活跃 Agent 生成 grants。
 * 复杂度 O(Agents)，通常 < 5（方案 §4.3 步骤 5）。
 */
export async function createIncrementalGrants(
  agents: AgentAccess[],
  memory: MemoryKeyMaterial,
): Promise<Grant[]> {
  const out: Grant[] = [];
  for (const agent of agents) {
    const grant = await createGrant(agent, memory);
    if (grant) out.push(grant);
  }
  return out;
}

/**
 * 全量路径：新 Agent 配对 / 权限变更后的批量授权。
 * 分批（默认 1000 条/批），批间让出事件循环，不阻塞前台（方案 §4.3 步骤 4/6）。
 */
export async function createBulkGrants(
  access: AgentAccess,
  memories: MemoryKeyMaterial[],
  options: {
    batchSize?: number;
    onBatch?: (done: number, total: number) => void;
  } = {},
): Promise<Grant[]> {
  const batchSize = options.batchSize ?? 1000;
  const out: Grant[] = [];
  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);
    for (const memory of batch) {
      const grant = await createGrant(access, memory);
      if (grant) out.push(grant);
    }
    options.onBatch?.(Math.min(i + batchSize, memories.length), memories.length);
    if (i + batchSize < memories.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
}
