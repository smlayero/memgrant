/**
 * 默认写入 cursor / claude-code 两个授权目标，便于管理台把 grant 当主路径。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_IDS = ["cursor", "claude-code"];

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
  let added = 0;
  for (const agentId of DEFAULT_IDS) {
    if (have.has(agentId)) continue;
    const keys = sdk.generateAgentKeyPair();
    agents.push({
      agentId,
      agentPublicKeyB64: sdk.toBase64(keys.publicKey),
      permissionMask: 2,
      status: "active",
    });
    keys.secretKey.fill(0);
    added++;
  }
  if (added > 0 || !have.size) {
    await fs.writeFile(file, JSON.stringify(agents, null, 2));
  }
  return agents;
}
