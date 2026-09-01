/**
 * 本地缓存 CRUD / 断网兜底（R1）+ 离线队列指数退避（R2）。
 */
import { describe, it, expect } from "vitest";
import { LocalStore } from "../src/cache/localStore.js";
import { SyncClient } from "../src/sync/syncClient.js";

function sample(id: string, text: string) {
  return {
    memoryId: id,
    plaintext: text,
    type: "preference",
    tags: ["tech"],
    permissionLevel: 2,
    importance: 0.7,
    sourceAgent: null,
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    deleted: false,
  };
}

describe("本地缓存", () => {
  it("写入/读取/检索/删除闭环", async () => {
    const store = await LocalStore.open();
    store.putMemory(sample("m1", "我喜欢用 pnpm 管理依赖"));
    store.putMemory(sample("m2", "我在深圳工作"));

    expect(store.getMemory("m1")?.plaintext).toContain("pnpm");
    expect(store.countMemories()).toBe(2);

    const hits = store.searchMemories("pnpm");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memoryId).toBe("m1");

    store.markDeleted("m1", "2026-07-31T01:00:00Z");
    expect(store.countMemories()).toBe(1);
    expect(store.searchMemories("pnpm")).toHaveLength(0);
  });

  it("R1: 纯本地读取不依赖网络（断网兜底）", async () => {
    const store = await LocalStore.open();
    store.putMemory(sample("m1", "离线可读的记忆"));
    // 无任何网络调用即可读
    expect(store.getMemory("m1")?.plaintext).toBe("离线可读的记忆");
  });
});

describe("离线队列（R2）", () => {
  it("推送成功后清空队列", async () => {
    const store = await LocalStore.open();
    store.enqueue("create", "m1", JSON.stringify({ op: "create" }));
    const fetchOk = async () => new Response("{}", { status: 200 });
    const client = new SyncClient({
      endpoint: "http://localhost:8787",
      token: "test-token",
      fetchImpl: fetchOk as typeof fetch,
    });
    const res = await client.pushOutbox(store);
    expect(res.pushed).toBe(1);
    expect(store.outboxSize()).toBe(0);
  });

  it("失败按指数退避重排，5 次后死信", async () => {
    const store = await LocalStore.open();
    store.enqueue("create", "m1", JSON.stringify({ op: "create" }));
    const fetchFail = async () => {
      throw new Error("network down");
    };
    const dead: string[] = [];
    const client = new SyncClient({
      endpoint: "http://localhost:8787",
      token: "test-token",
      fetchImpl: fetchFail as typeof fetch,
      maxAttempts: 5,
      onDeadLetter: (id) => dead.push(id),
    });

    for (let i = 0; i < 6; i++) {
      await client.pushOutbox(store);
      // 失败后 nextRetryAt 在未来，模拟时间推进到下次重试点
      const pending = store.dueOutbox(Date.now() + 10 * 60 * 1000);
      if (pending.length === 0) break;
      store.makeOutboxDue(pending[0]!.id);
    }
    expect(dead).toEqual(["m1"]);
    expect(store.outboxSize()).toBe(0);
    expect(store.deadLetterCount()).toBe(1);
  });

  it("退避间隔指数增长（5s 起步）", async () => {
    const store = await LocalStore.open();
    store.enqueue("create", "m1", "{}");
    const before = Date.now();
    const item = store.dueOutbox()[0]!;
    store.scheduleRetry(item.id, 1);
    store.scheduleRetry(item.id, 2);
    const r2 = store.dueOutbox(Date.now() + 60 * 1000)[0]!;
    // 新公式：5000 * 2^(attempts-1)，attempts=2 → 10000ms
    expect(r2.nextRetryAt - before).toBeGreaterThanOrEqual(10 * 1000);
  });
});

describe("同步回填", () => {
  it("pullAndApply：create 拉密文并交给 apply，delete 标记本地删除", async () => {
    const store = await LocalStore.open();
    store.putMemory(sample("gone", "将被删除"));
    const fetches: string[] = [];
    const fetchImpl = async (url: string) => {
      if (url.includes("/api/sync/changes")) {
        return new Response(
          JSON.stringify({
            changes: [
              { cursor: "1", memoryId: "m-new", op: "create" },
              { cursor: "2", memoryId: "gone", op: "delete" },
            ],
            cursor: "2",
          }),
        );
      }
      fetches.push(url);
      return new Response(
        JSON.stringify({
          ciphertext: "Yw==",
          wrapped_dek: "ZA==",
          type: "preference",
        }),
      );
    };
    const client = new SyncClient({
      endpoint: "http://localhost:8787",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const applied: string[] = [];
    const result = await client.pullAndApply(store, async (id) => {
      applied.push(id);
    });
    expect(result.applied).toBe(1);
    expect(result.deleted).toBe(1);
    expect(applied).toEqual(["m-new"]);
    expect(store.getMemory("gone")?.deleted).toBe(true);
  });

  it("connectWs 不把 token 拼进 URL", () => {
    const Original = globalThis.WebSocket;
    const seen: string[] = [];
    globalThis.WebSocket = class {
      constructor(url: string, protocols?: string | string[]) {
        seen.push(url);
        this.protocol = Array.isArray(protocols) ? protocols[0] : protocols;
      }
      protocol?: string;
      onmessage: ((ev: { data: string }) => void) | null = null;
    } as unknown as typeof WebSocket;
    try {
      const client = new SyncClient({ endpoint: "http://localhost:8787", token: "secret-token" });
      client.connectWs();
      expect(seen[0]).toBe("ws://localhost:8787/api/sync/ws");
      expect(seen[0]).not.toContain("secret-token");
    } finally {
      globalThis.WebSocket = Original;
    }
  });
});
