/**
 * L1 本机模型判断：L0 地板、白名单、HTTP 失败回退。不连真实 Ollama。
 */
import { describe, it, expect } from "vitest";
import { composeJudge, rulesJudge } from "../src/judge/compose.js";
import { createOpenAiCompatJudge } from "../src/judge/openaiCompat.js";
import { createJudgeFromConfig } from "../src/judge/fromConfig.js";
import { judgeByRules, TAG_WHITELIST } from "../src/judge/rules.js";
import type { Judge } from "../src/judge/compose.js";
import type { JudgeInput, JudgeResult } from "../src/judge/rules.js";

function stubL1(partial: Partial<JudgeResult>): Judge {
  return async () =>
    ({
      shouldStore: true,
      type: "preference",
      permissionLevel: 2,
      tags: [],
      sensitiveTags: [],
      importance: 0.5,
      reason: "stub",
      engineVersion: "stub-l1",
      ...partial,
    }) as JudgeResult;
}

function jsonChoice(obj: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(obj) } }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("composeJudge L0 地板", () => {
  it("L0 判 L4 时模型不得降到 L2", async () => {
    const judge = composeJudge(
      rulesJudge,
      stubL1({ permissionLevel: 2, type: "preference", shouldStore: true }),
    );
    const r = await judge({ text: "我的密码是 hunter2" });
    expect(r.permissionLevel).toBe(4);
    expect(r.sensitiveTags).toContain("credential");
    expect(r.engineVersion).toContain("mb-judge-l0-rules-v1");
    expect(r.engineVersion).toContain("stub-l1");
  });

  it("L1 能补上 L0 漏掉的偏好", async () => {
    const text = "以后写提交信息请用英文、一行摘要";
    expect(judgeByRules({ text }).shouldStore).toBe(false);
    const judge = composeJudge(
      rulesJudge,
      stubL1({
        shouldStore: true,
        type: "preference",
        permissionLevel: 2,
        tags: ["tech"],
      }),
    );
    const r = await judge({ text });
    expect(r.shouldStore).toBe(true);
    expect(r.type).toBe("preference");
    expect(r.tags).toContain("tech");
  });

  it("L1 越表白名单的 tags 被丢掉", async () => {
    const judge = composeJudge(
      rulesJudge,
      stubL1({ tags: ["tech", "hacked-secret", "work"] }),
    );
    const r = await judge({ text: "我喜欢用 Vim 写代码" });
    expect(r.tags).toContain("tech");
    expect(r.tags).not.toContain("hacked-secret");
    for (const tag of r.tags) expect(TAG_WHITELIST.has(tag)).toBe(true);
  });

  it("L1 抛错时等于纯 L0", async () => {
    const boom: Judge = async () => {
      throw new Error("down");
    };
    const input: JudgeInput = { text: "我喜欢用 Vim 写代码" };
    const composed = composeJudge(rulesJudge, boom);
    expect(await composed(input)).toEqual(judgeByRules(input));
  });

  it("未配置 L1 时 createJudgeFromConfig 就是 L0", async () => {
    const input = { text: "我喜欢用 Vim 写代码" };
    const r = await createJudgeFromConfig({})(input);
    expect(r).toEqual(judgeByRules(input));
  });
});

describe("createOpenAiCompatJudge mock HTTP", () => {
  const l1Body = {
    shouldStore: true,
    type: "preference",
    permissionLevel: 2,
    tags: ["tech", "not-a-real-tag"],
    sensitiveTags: [],
    importance: 0.7,
    reason: "style",
  };

  it("解析 JSON 并把非法 tag 滤掉", async () => {
    const l1 = createOpenAiCompatJudge({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      fetch: async () => jsonChoice(l1Body),
    });
    const r = await l1({ text: "以后提交请用英文" });
    expect(r.shouldStore).toBe(true);
    expect(r.tags).toEqual(["tech"]);
    expect(r.engineVersion).toBe("openai-compat:qwen2.5:7b");
  });

  it("与 L0 组合后凭证仍为 L4", async () => {
    const judge = composeJudge(
      rulesJudge,
      createOpenAiCompatJudge({
        baseUrl: "http://127.0.0.1:9/v1",
        model: "stub",
        fetch: async () => jsonChoice(l1Body),
      }),
    );
    const r = await judge({ text: "我的密码是 hunter2" });
    expect(r.permissionLevel).toBe(4);
  });

  it("HTTP 5xx 回退 L0", async () => {
    const input = { text: "我喜欢用 Vim 写代码" };
    const judge = composeJudge(
      rulesJudge,
      createOpenAiCompatJudge({
        baseUrl: "http://127.0.0.1:9/v1",
        model: "stub",
        fetch: async () => new Response("nope", { status: 500 }),
      }),
    );
    expect(await judge(input)).toEqual(judgeByRules(input));
  });

  it("超时回退 L0", async () => {
    const input = { text: "我喜欢用 Vim 写代码" };
    const judge = composeJudge(
      rulesJudge,
      createOpenAiCompatJudge({
        baseUrl: "http://127.0.0.1:9/v1",
        model: "stub",
        timeoutMs: 30,
        fetch: (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      }),
    );
    expect(await judge(input)).toEqual(judgeByRules(input));
  });
});
