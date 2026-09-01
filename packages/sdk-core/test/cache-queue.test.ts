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
      token: "t",
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
      token: "t",
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
  });

  it("退避间隔指数增长（5s 基础）", async () => {
    const store = await LocalStore.open();
    store.enqueue("create", "m1", "{}");
    const before = Date.now();
    const item = store.dueOutbox()[0]!;
    store.scheduleRetry(item.id, 1);
    store.scheduleRetry(item.id, 2);
    const r2 = store.dueOutbox(Date.now() + 60 * 1000)[0]!;
    expect(r2.nextRetryAt - before).toBeGreaterThanOrEqual(20 * 1000);
  });
});
