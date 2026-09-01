/**
 * 组装 Embedder：未配置本机模型时用 HashEmbedder（零依赖，非语义）。
 */
import { HashEmbedder, type Embedder } from "./embedder.js";
import { createOpenAiCompatEmbedder } from "./openaiEmbedder.js";
import { warnIfRemoteModelUrl } from "./localUrl.js";

export interface EmbedderL1Config {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export interface EmbedderConfig {
  l1?: Partial<EmbedderL1Config> | null;
}

export function createEmbedderFromConfig(
  config?: EmbedderConfig | null,
): Embedder {
  const baseUrl = config?.l1?.baseUrl?.trim();
  const model = config?.l1?.model?.trim();
  if (!baseUrl || !model) return new HashEmbedder();
  warnIfRemoteModelUrl("embedder", baseUrl);
  return createOpenAiCompatEmbedder({
    baseUrl,
    model,
    ...(typeof config?.l1?.timeoutMs === "number"
      ? { timeoutMs: config.l1.timeoutMs }
      : {}),
  });
}
