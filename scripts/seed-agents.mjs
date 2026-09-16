/**
 * 默认写入 cursor / claude-code 两个授权目标，并为每个 Agent 留下私钥。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_IDS = ["cursor", "claude-code"];

async function persistAgent(home, sdk, agentId, permissionMask) {
  const keys = sdk.generateAgentKeyPair();
  await sdk.saveAgentSk(home, agentId, keys.secretKey);
  const rec = {
    agentId,
    agentPublicKeyB64: sdk.toBase64(keys.publicKey),
    permissionMask,
    status: "active",
  };
  keys.secretKey.fill(0);
  return rec;
}

export async function seedDefaultAgents(home, sdk) {
  const file = path.join(home, "paired-agents.json");
  let agents = [];
  try {
    agents = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(agents)) agents = [];
  } catch {
    agents = [];
  }
  const have = new Set(agents.map((a) => a.agentId));
  let changed = 0;
  for (const agentId of DEFAULT_IDS) {
    if (have.has(agentId)) continue;
    agents.push(await persistAgent(home, sdk, agentId, 2));
    changed++;
  }
  for (const agent of agents) {
    if (!agent.agentId || agent.status === "revoked") continue;
    const sk = await sdk.loadAgentSk(home, agent.agentId);
    if (sk) continue;
    const keys = sdk.generateAgentKeyPair();
    await sdk.saveAgentSk(home, agent.agentId, keys.secretKey);
    agent.agentPublicKeyB64 = sdk.toBase64(keys.publicKey);
    keys.secretKey.fill(0);
    changed++;
  }
  if (changed > 0 || !have.size) {
    await fs.writeFile(file, JSON.stringify(agents, null, 2));
  }
  return agents;
}
