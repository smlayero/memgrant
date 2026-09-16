/**
 * 每个 Agent 一份私钥：0600 文件，与 MK / device.sk 分开放。
 * 公钥在 paired-agents.json；私钥不进 JSON、不上同步节点。
 */
import path from "node:path";
import { FileKeychain } from "./keychain.js";

export function validAgentId(id: string): boolean {
  if (!id || id.length > 64) return false;
  for (const ch of id) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      ch === "." ||
      ch === "_" ||
      ch === "-";
    if (!ok) return false;
  }
  return true;
}

function skFile(dir: string, agentId: string): FileKeychain {
  if (!validAgentId(agentId)) {
    throw new Error("invalid agent id");
  }
  return new FileKeychain(path.join(dir, "agents", `${agentId}.sk`));
}

export async function saveAgentSk(
  dir: string,
  agentId: string,
  secretKey: Uint8Array,
): Promise<void> {
  await skFile(dir, agentId).setMk(secretKey);
}

export async function loadAgentSk(
  dir: string,
  agentId: string,
): Promise<Uint8Array | null> {
  if (!validAgentId(agentId)) return null;
  return skFile(dir, agentId).getMk();
}

export async function deleteAgentSk(dir: string, agentId: string): Promise<void> {
  if (!validAgentId(agentId)) return;
  await skFile(dir, agentId).deleteMk();
}
