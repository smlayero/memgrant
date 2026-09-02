/**
 * Claude Code 适配器共享模块：配置加载、存储打开、权限过滤。
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";

const sdk = await import("@memgrant/sdk-core");

export function mbHome() {
  return process.env.MB_HOME ?? path.join(os.homedir(), ".memory-backbone");
}

export async function loadConfig() {
  const raw = await fs.readFile(path.join(mbHome(), "config.json"), "utf8");
  return JSON.parse(raw);
}

export async function loadAgentMask(agentId) {
  try {
    const raw = await fs.readFile(
      path.join(mbHome(), "paired-agents.json"),
      "utf8",
    );
    const agents = JSON.parse(raw);
    const me = agents.find((a) => a.agentId === agentId && a.status === "active");
    return me?.permissionMask ?? 2;
  } catch {
    return 2;
  }
}

export async function openStore() {
  return sdk.LocalStore.open(path.join(mbHome(), "cache.db"));
}

export { sdk };
