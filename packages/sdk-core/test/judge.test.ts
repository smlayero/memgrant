/**
 * L0 规则引擎测试（指标 M1：敏感规则命中零降级）+ S7 标签白名单。
 */
import { describe, it, expect } from "vitest";
import { judgeByRules, TAG_WHITELIST } from "../src/judge/rules.js";

describe("L0 规则判断引擎", () => {
  it("密码类内容：强制存储 + Level 4 + 敏感标签不进明文 tags", () => {
    const r = judgeByRules({ text: "我的密码是 hunter2" });
    expect(r.shouldStore).toBe(true);
    expect(r.permissionLevel).toBe(4);
    expect(r.sensitiveTags).toContain("credential");
    expect(r.tags).not.toContain("credential");
  });

  it("偏好类内容：preference + Level 2", () => {
    const r = judgeByRules({ text: "我喜欢用 Vim 写代码" });
    expect(r.shouldStore).toBe(true);
    expect(r.type).toBe("preference");
    expect(r.permissionLevel).toBe(2);
  });

  it("显式保存永远可用（L0 兜底承诺）", () => {
    const r = judgeByRules({ text: "量子玫瑰绽放了三次", explicit: true });
    expect(r.shouldStore).toBe(true);
  });

  it("噪音闲聊不存", () => {
    expect(judgeByRules({ text: "谢谢" }).shouldStore).toBe(false);
    expect(judgeByRules({ text: "ok" }).shouldStore).toBe(false);
    expect(judgeByRules({ text: "嗯" }).shouldStore).toBe(false);
  });

  it("健康类内容 Level 3", () => {
    const r = judgeByRules({ text: "体检报告显示血压偏高，需要复查" });
    expect(r.shouldStore).toBe(true);
    expect(r.permissionLevel).toBe(3);
    expect(r.tags).toContain("health");
  });

  it("tags 全部落在白名单内（S7）", () => {
    const samples = [
      "我的密码是 abc123",
      "我在腾讯做前端工程师，项目用 React",
      "下周要出差，机票酒店都订好了",
      "合同里有一个合规条款需要法务确认",
      "股票账户这个月亏了不少",
    ];
    for (const text of samples) {
      const r = judgeByRules({ text });
      for (const tag of r.tags) {
        expect(TAG_WHITELIST.has(tag)).toBe(true);
      }
    }
  });

  it("engineVersion 落库（审计与回溯）", () => {
    const r = judgeByRules({ text: "记住我偏好深色主题" });
    expect(r.engineVersion).toMatch(/^mb-judge-l0-rules-v/);
  });
});
