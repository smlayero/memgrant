/**
 * OpenAI 兼容 embeddings（Ollama / LM Studio / llama.cpp 的 /v1/embeddings）。
 * 失败时抛错，由 createEmbedderFromConfig 决定是否回退 HashEmbedder。
 */
import type { Embedder } from "./embedder.js";

export interface OpenAiCompatEmbedderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/embeddings")) return trimmed;
  return `${trimmed}/embeddings`;
}

export function createOpenAiCompatEmbedder(
  options: OpenAiCompatEmbedderOptions,
): Embedder {
  const timeoutMs = options.timeoutMs ?? 8000;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = embeddingsUrl(options.baseUrl);
  return {
    id: `openai-compat-embed:${options.model}`,
    dim: 0,
    async embed(text: string): Promise<Float32Array> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({ model: options.model, input: text }),
        });
        if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
        const body = (await res.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        const arr = body.data?.[0]?.embedding;
        if (!Array.isArray(arr) || arr.length === 0) {
          throw new Error("embed: empty vector");
        }
        return Float32Array.from(arr);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
