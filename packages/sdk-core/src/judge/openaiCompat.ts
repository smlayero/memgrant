/**
 * OpenAI 兼容 Chat Completions（Ollama / LM Studio / llama.cpp 的 /v1）。
 * 明文只发往调用方配置的 baseUrl；失败时抛错，由 composeJudge 回退 L0。
 */
import type { Judge } from "./compose.js";
import {
  TAG_WHITELIST,
  type JudgeResult,
  type MemoryType,
  type PermissionLevel,
} from "./rules.js";

export interface OpenAiCompatJudgeOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const MEMORY_TYPES = new Set<string>([
  "profile",
  "preference",
  "entity",
  "event",
  "relationship",
  "skill",
  "task",
  "temporary",
]);

const SYSTEM_PROMPT = `You classify whether a user utterance should be stored as long-term memory.
Reply with a single JSON object, no markdown, keys:
shouldStore (boolean), type (one of profile|preference|entity|event|relationship|skill|task|temporary),
permissionLevel (0-4 integer; 4=credentials/id documents, 3=health/finance detail, 2=default),
tags (array from: ${[...TAG_WHITELIST].join(",")}),
sensitiveTags (array of strings, not for plaintext tags),
importance (0-1 number), reason (short string).
Do not copy secrets into reason.`;

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function extractJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/u, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("judge L1: no JSON object");
  return JSON.parse(stripped.slice(start, end + 1));
}

function clampLevel(n: unknown): PermissionLevel {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.max(0, Math.min(4, Math.round(v))) as PermissionLevel;
}

function parseResult(raw: unknown, engineVersion: string): JudgeResult {
  if (!raw || typeof raw !== "object") throw new Error("judge L1: invalid body");
  const o = raw as Record<string, unknown>;
  const typeRaw = String(o.type ?? "event");
  const type = (MEMORY_TYPES.has(typeRaw) ? typeRaw : "event") as MemoryType;
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string")
    : [];
  const sensitiveTags = Array.isArray(o.sensitiveTags)
    ? o.sensitiveTags.filter((t): t is string => typeof t === "string")
    : [];
  const importance = Number(o.importance);
  return {
    shouldStore: Boolean(o.shouldStore),
    type,
    permissionLevel: clampLevel(o.permissionLevel),
    tags: tags.filter((t) => TAG_WHITELIST.has(t)),
    sensitiveTags,
    importance: Number.isFinite(importance)
      ? Math.max(0, Math.min(1, importance))
      : 0.5,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 120) : "l1",
    engineVersion,
  };
}

export function createOpenAiCompatJudge(
  options: OpenAiCompatJudgeOptions,
): Judge {
  const timeoutMs = options.timeoutMs ?? 8000;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const engineVersion = `openai-compat:${options.model}`;
  const url = completionsUrl(options.baseUrl);

  return async (input) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                text: input.text,
                explicit: Boolean(input.explicit),
              }),
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`judge L1 HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("judge L1: empty content");
      }
      return parseResult(extractJson(content), engineVersion);
    } finally {
      clearTimeout(timer);
    }
  };
}
