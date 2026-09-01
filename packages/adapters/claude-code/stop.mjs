#!/usr/bin/env node
/**
 * Stop / PreCompact hook（方案 §6.3：会话结束/压缩前自动保存）。
 *
 * 从 stdin 读取 hook 输入 JSON（含 transcript_path），解析 JSONL 会话记录，
 * 用 L0 规则引擎本地判断用户消息中值得存的内容（明文不出设备），
 * 判存则走 MemoryService 主链路（加密 + grants + 离线队列）。
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig, mbHome, openStore, sdk } from "./shared.mjs";

const MAX_CANDIDATES = 20;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** 解析 Claude Code transcript（JSONL），抽取用户文本消息。 */
export async function extractUserMessages(transcriptPath) {
  const raw = await fs.readFile(transcriptPath, "utf8");
  const texts = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user") continue;
      const content = entry.message?.content;
      if (typeof content === "string") {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          }
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }
  return texts;
}

async function main() {
  const input = JSON.parse(await readStdin() || "{}");
  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  const config = await loadConfig();
  const store = await openStore();
  const keychain = sdk.FileKeychain.default(mbHome());
  const service = new sdk.MemoryService(
    keychain,
    store,
    () => [],
    sdk.createEmbedderFromConfig(config.embedder),
    sdk.createJudgeFromConfig(config.judge),
  );

  const messages = await extractUserMessages(transcriptPath);
  let saved = 0;
  for (const text of messages.slice(-MAX_CANDIDATES)) {
    const trimmed = text.trim();
    if (trimmed.length < 8) continue;
    // 去重：本地已有相同明文则跳过
    if (store.searchMemories(trimmed.slice(0, 32), 1).length > 0) continue;
    const result = await service.saveMemory({
      text: trimmed,
      explicit: false, // 自动保存走规则判断，只有命中有价值模式才存
      sourceAgent: config.agent_id,
      sourceSession: input.session_id,
    });
    if (result.stored) saved++;
  }
  await store.persist();

  // 尽力同步，失败留离线队列
  if (config.device_token && config.endpoint) {
    const sync = new sdk.SyncClient({
      endpoint: config.endpoint,
      token: config.device_token,
    });
    await sync.pushOutbox(store).catch(() => undefined);
    await store.persist();
  }

  if (saved > 0) {
    process.stderr.write(`memory-backbone: 已自动保存 ${saved} 条记忆\n`);
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  main().catch(() => process.exit(0)); // hook 失败不得阻断会话
}
