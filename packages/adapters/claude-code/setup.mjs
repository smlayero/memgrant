#!/usr/bin/env node
/**
 * 一键安装（方案 §6.3：npx @memory-backbone/setup）。
 *
 * 把 SessionStart / Stop / PreCompact 三个 hook 写入 ~/.claude/settings.json。
 * 合并而非覆盖：已有其他 hook 的配置保留；重复执行幂等（先移除旧条目再写入）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function hookCommand(script) {
  const scriptPath = path.join(HERE, script);
  return `${process.execPath} ${JSON.stringify(scriptPath)}`;
}

const HOOK_EVENTS = ["SessionStart", "Stop", "PreCompact"];
const OUR_HOOKS = {
  SessionStart: hookCommand("sessionStart.mjs"),
  Stop: hookCommand("stop.mjs"),
  PreCompact: hookCommand("preCompact.mjs"),
};
const MARKER = "memory-backbone";

async function main() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch {
    // 首次使用，新建
  }

  settings.hooks = settings.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks[event] ?? [];
    // 幂等：剔除旧的 memory-backbone 条目
    const kept = groups
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((h) => !(h.command ?? "").includes(MARKER)),
      }))
      .filter((g) => g.hooks.length > 0);
    kept.push({
      hooks: [{ type: "command", command: OUR_HOOKS[event] }],
    });
    settings.hooks[event] = kept;
  }

  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

  console.log(`memory-backbone hooks 已写入 ${settingsPath}`);
  console.log(`  SessionStart → ${OUR_HOOKS.SessionStart}`);
  console.log(`  Stop         → ${OUR_HOOKS.Stop}`);
  console.log(`  PreCompact   → ${OUR_HOOKS.PreCompact}`);
  console.log("重开 Claude Code 会话生效。");
}

main().catch((err) => {
  console.error("setup 失败:", err.message);
  process.exit(1);
});
