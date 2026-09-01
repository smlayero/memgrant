/**
 * 向量检索与混合搜索测试（指标 P3 链路：本地检索；Embedder 接口可插拔）。
 */
import { describe, it, expect } from "vitest";
import {
  HashEmbedder,
  cosineSimilarity,
  tokenize,
} from "../src/judge/embedder.js";
import { LocalStore } from "../src/cache/localStore.js";

function mem(id: string, text: string) {
  return {
    memoryId: id,
    plaintext: text,
    type: "preference",
    tags: [],
    permissionLevel: 2,
    importance: 0.6,
    sourceAgent: null,
    createdAt: "2026-08-04T00:00:00Z",
    updatedAt: "2026-08-04T00:00:00Z",
    deleted: false,
  };
}

describe("Embedder", () => {
  it("分词覆盖拉丁词与 CJK bigram", () => {
    const tokens = tokenize("我喜欢用 pnpm 管理依赖");
    expect(tokens).toContain("w:pnpm");
    expect(tokens.some((t) => t.startsWith("b:"))).toBe(true);
  });

  it("相似文本余弦相似度高于无关文本", async () => {
    const e = new HashEmbedder();
    const a = await e.embed("我喜欢用 pnpm 管理项目依赖");
    const b = await e.embed("pnpm 是管理依赖的工具");
    const c = await e.embed("明天要去机场赶飞机");
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it("输出 L2 归一化", async () => {
    const e = new HashEmbedder();
    const v = await e.embed("归一化测试文本内容");
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });
});

describe("混合检索", () => {
  it("向量通道召回关键词未命中的相关记忆", async () => {
    const store = await LocalStore.open();
    const e = new HashEmbedder();
    await store.putMemory(mem("m1", "我喜欢用 pnpm 管理项目依赖"), await e.embed("我喜欢用 pnpm 管理项目依赖"));
    store.putMemory(mem("m2", "明天要去机场赶飞机"), await e.embed("明天要去机场赶飞机"));
    store.putMemory(mem("m3", "体检报告显示血压偏高"), await e.embed("体检报告显示血压偏高"));

    // 查询与 m1 词汇重叠但非完全子串（"pnpm 依赖" 不是 m1 的子串匹配词序）
    const hits = store.searchHybrid("pnpm 依赖", await e.embed("pnpm 依赖"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.memory.memoryId).toBe("m1");
  });

  it("无向量时退化为纯关键词检索", async () => {
    const store = await LocalStore.open();
    store.putMemory(mem("m1", "我喜欢用 pnpm"));
    const hits = store.searchHybrid("pnpm", null);
    expect(hits[0]?.memory.memoryId).toBe("m1");
  });

  it("删除的记忆不参与向量检索", async () => {
    const store = await LocalStore.open();
    const e = new HashEmbedder();
    store.putMemory(mem("m1", "我喜欢用 pnpm 管理依赖"), await e.embed("我喜欢用 pnpm 管理依赖"));
    store.markDeleted("m1", "2026-08-04T01:00:00Z");
    const hits = store.searchByVector(await e.embed("pnpm 依赖"), 10);
    expect(hits).toHaveLength(0);
  });
});
