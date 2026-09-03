#!/usr/bin/env node
/**
 * 本机初始化：生成助记词、写入 Keychain、向同步节点注册首设备。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const sdk = await import(
  new URL("../packages/sdk-core/dist/index.js", import.meta.url).href
);
const { seedDefaultAgents } = await import(
  new URL("./seed-agents.mjs", import.meta.url).href
);

function mbHome() {
  return process.env.MB_HOME ?? path.join(os.homedir(), ".memory-backbone");
}

const endpoint = (process.env.MB_ENDPOINT ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const home = mbHome();
await fs.mkdir(home, { recursive: true });

const configPath = path.join(home, "config.json");
try {
  await fs.access(configPath);
  await seedDefaultAgents(home, sdk);
  console.log("已存在", configPath, "跳过注册。默认 Agent 已核对。");
  process.exit(0);
} catch {
  /* first run */
}

const bundle = sdk.generateMnemonicBundle();
const deviceKeys = sdk.generateAgentKeyPair();
const kc = sdk.createBestKeychain(home);
await kc.setMk(bundle.mk);
await sdk.saveDeviceSk(home, deviceKeys.secretKey);

const verifier = sdk.recoveryVerifier(bundle.mk);
const res = await fetch(`${endpoint}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    fixed_salt: bundle.fixedSaltHex,
    device_pubkey: sdk.toBase64(deviceKeys.publicKey),
    device_name: os.hostname(),
    device_type: process.platform,
    paired_via: "mnemonic",
    recovery_verifier: verifier,
  }),
});
if (!res.ok) {
  console.error("register failed:", res.status, await res.text());
  process.exit(1);
}
const body = await res.json();

const config = {
  endpoint,
  user_id: body.user_id,
  device_id: body.device_id,
  device_token: body.device_token,
  agent_id: process.env.MB_AGENT_ID ?? "claude-code",
  cache: { dir: home },
  telemetry: { opt_in: false },
};
await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
  encoding: "utf8",
  mode: 0o600,
});
await seedDefaultAgents(home, sdk);

console.log("已写入", configPath);
console.log("user_id:", body.user_id);
console.log("Keychain:", kc.id);
console.log("");
console.log("助记词（只显示一次，请离线抄写；这是恢复主密钥的唯一主路径）：");
console.log(bundle.mnemonic);
console.log("");
console.log("配对码（SPAKE2）只是多设备便利手段，未做第三方协议审计；丢设备请用上面的助记词 recover。");
console.log("");
console.log("已写入默认 Agent：cursor（MCP）、claude-code（Hooks）。在管理台调整掩码或撤销。");

bundle.mk.fill(0);
deviceKeys.secretKey.fill(0);
void fileURLToPath;
