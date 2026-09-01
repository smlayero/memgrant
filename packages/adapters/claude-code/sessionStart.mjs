#!/usr/bin/env node
/**
 * SessionStart hook（方案 §6.3 Hook 阶段：会话开始注入相关记忆）。
 *
 * 只注入本 Agent 权限掩码允许的记忆（permission_level <= mask），
 * 与密码学授权一致：掩码之外的记忆即使有本地明文缓存也不注入。
 * 输出到 stdout 的文本进入 Claude Code 会话上下文。
 */
import { loadConfig, loadAgentMask, openStore } from "./shared.mjs";

const MAX_INJECT = 8;
const MAX_CHARS = 2000;

async function main() {
  const config = await loadConfig();
  const mask = await loadAgentMask(config.agent_id);
  const store = await openStore();

  const all = store.listMemories(200);
  const allowed = all
    .filter((m) => m.permissionLevel <= mask)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_INJECT);

  store.close();

  if (allowed.length === 0) process.exit(0);

  let out = "## 用户长期记忆（memory-backbone，按权限过滤）\n";
  for (const m of allowed) {
    const line = `- [${m.type}] ${m.plaintext}\n`;
    if (out.length + line.length > MAX_CHARS) break;
    out += line;
  }
  process.stdout.write(out);
}

main().catch(() => process.exit(0)); // hook 失败不得阻断会话
