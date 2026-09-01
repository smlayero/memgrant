/**
 * 同步客户端（方案 §五）。
 *
 * - 离线队列：指数退避（5s 起步 ×2^(n-1)），5 次后移入死信表保留
 * - 增量同步：GET /api/sync/changes?since={cursor} 游标分页
 * - 实时通道：WebSocket 接收变更事件（仅 memory_id + 操作类型，不含内容）
 * - fetch/WebSocket 均可注入，便于测试与多运行时复用
 */
import type { LocalStore } from "../cache/localStore.js";

export interface SyncClientOptions {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  onDeadLetter?: (memoryId: string, op: string) => void;
  onChange?: (event: SyncChangeEvent) => void;
}

export interface SyncChangeEvent {
  cursor: string;
  memoryId: string;
  op: "create" | "update" | "delete";
}

export interface PushResult {
  pushed: number;
  failed: number;
  deadLettered: number;
}

export class SyncClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly onDeadLetter?: (memoryId: string, op: string) => void;
  private readonly onChange?: (event: SyncChangeEvent) => void;

  constructor(options: SyncClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (options.onDeadLetter) this.onDeadLetter = options.onDeadLetter;
    if (options.onChange) this.onChange = options.onChange;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  /** 推送离线队列：成功移除，失败按指数退避重排。 */
  async pushOutbox(store: LocalStore): Promise<PushResult> {
    const result: PushResult = { pushed: 0, failed: 0, deadLettered: 0 };
    const due = store.dueOutbox();
    for (const item of due) {
      try {
        const res = await this.fetchImpl(`${this.endpoint}/api/memory/sync`, {
          method: "POST",
          headers: this.headers(),
          body: item.payload,
        });
        if (!res.ok) throw new Error(`sync http ${res.status}`);
        store.removeOutbox(item.id);
        result.pushed++;
      } catch {
        const attempts = item.attempts + 1;
        if (attempts >= this.maxAttempts) {
          store.moveToDeadLetter(item, attempts);
          this.onDeadLetter?.(item.memoryId, item.op);
          result.deadLettered++;
        } else {
          store.scheduleRetry(item.id, attempts);
          result.failed++;
        }
      }
    }
    return result;
  }

  /** 拉取增量变更（游标分页），返回最新游标。 */
  async pullChanges(
    store: LocalStore,
  ): Promise<{ events: SyncChangeEvent[]; cursor: string | null }> {
    const since = store.getCursor();
    const url = since
      ? `${this.endpoint}/api/sync/changes?since=${encodeURIComponent(since)}`
      : `${this.endpoint}/api/sync/changes`;
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`changes http ${res.status}`);
    const body = (await res.json()) as {
      changes: SyncChangeEvent[];
      cursor: string | null;
    };
    if (body.cursor) store.setCursor(body.cursor);
    return { events: body.changes, cursor: body.cursor };
  }

  /** 拉取增量变更并回填本地缓存。 */
  async pullAndApply(
    store: LocalStore,
    apply: (
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
    ) => Promise<void>,
  ): Promise<{ applied: number; deleted: number }> {
    const { events } = await this.pullChanges(store);
    let applied = 0;
    let deleted = 0;
    for (const ev of events) {
      if (ev.op === "delete") {
        store.markDeleted(ev.memoryId, new Date().toISOString());
        deleted++;
        continue;
      }
      const res = await this.fetchImpl(
        `${this.endpoint}/api/memory/fetch/${encodeURIComponent(ev.memoryId)}`,
        { headers: this.headers() },
      );
      if (res.status === 404) {
        store.markDeleted(ev.memoryId, new Date().toISOString());
        deleted++;
        continue;
      }
      if (!res.ok) throw new Error(`fetch http ${res.status}`);
      const body = (await res.json()) as {
        ciphertext: string;
        wrapped_dek: string;
        type?: string;
        tags?: string[];
        permission_level?: number;
        importance?: number;
        source_agent?: string | null;
        created_at?: string;
        updated_at?: string;
      };
      await apply(ev.memoryId, body);
      applied++;
    }
    return { applied, deleted };
  }

  /** WebSocket 实时通道。Token 只走 Sec-WebSocket-Protocol，不进 URL。 */
  connectWs(): WebSocket {
    const wsUrl = `${this.endpoint.replace(/^http/, "ws")}/api/sync/ws`;
    const ws = new WebSocket(wsUrl, [this.token]);
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as SyncChangeEvent;
        this.onChange?.(data);
      } catch {
        // 忽略无法解析的帧——事件只含 memory_id + op，绝不含内容
      }
    };
    return ws;
  }
}
