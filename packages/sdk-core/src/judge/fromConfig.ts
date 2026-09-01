/**
 * 从 ~/.memory-backbone/config.json 的 judge 字段组装 Judge。
 * 未配置 l1.baseUrl/model 时只有 L0，行为与 v0.1 相同。
 */
import { composeJudge, rulesJudge, type Judge } from "./compose.js";
import { createOpenAiCompatJudge } from "./openaiCompat.js";

export interface JudgeL1Config {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export interface JudgeConfig {
  l1?: Partial<JudgeL1Config> | null;
}

export function createJudgeFromConfig(config?: JudgeConfig | null): Judge {
  const baseUrl = config?.l1?.baseUrl?.trim();
  const model = config?.l1?.model?.trim();
  if (!baseUrl || !model) return rulesJudge;
  const l1 = createOpenAiCompatJudge({
    baseUrl,
    model,
    ...(typeof config?.l1?.timeoutMs === "number"
      ? { timeoutMs: config.l1.timeoutMs }
      : {}),
  });
  return composeJudge(rulesJudge, l1);
}
