#!/usr/bin/env node
/**
 * 设备配对 / 助记词恢复 CLI。
 *
 *   node scripts/cli.mjs pair
 *   node scripts/cli.mjs join <code>
 *   node scripts/cli.mjs recover <user_id> "<24-word mnemonic>"
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const sdk = await import(
  new URL("../packages/sdk-core/dist/index.js", import.meta.url).href
);

function mbHome() {
  return process.env.MB_HOME ?? path.join(os.homedir(), ".memory-backbone");
}

async function readConfig() {
  const raw = await fs.readFile(path.join(mbHome(), "config.json"), "utf8");
  return JSON.parse(raw);
}

async function writeConfig(config) {
  const home = mbHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function cmdPair() {
  const config = await readConfig();
  const kc = sdk.createBestKeychain(mbHome());
  const mk = await kc.getMk();
  if (!mk) throw new Error("本机没有 MK，请先 npm run setup 或 recover");
  const channel = new sdk.HttpPairingChannel(config.endpoint);
  const initiator = new sdk.PairingInitiator(channel);
  console.log("配对码（5 分钟有效）：", initiator.code);
  console.log("在新设备执行: node scripts/cli.mjs join", initiator.code);
  await initiator.start();
  await initiator.acceptShare();
  const ok = await initiator.verify();
  if (!ok) throw new Error("配对确认失败（错码或中间人）");
  console.log("SAS 指纹（请与对端核对）：", initiator.getSasFingerprint());
  await initiator.sendMk(mk);
  const pub = await initiator.receiveDevicePubkey();
  const res = await fetch(`${config.endpoint}/api/auth/devices`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.device_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      device_pubkey: sdk.toBase64(pub),
      device_name: "paired-device",
      paired_via: "pake",
    }),
  });
  if (!res.ok) throw new Error(`register device failed: ${res.status} ${await res.text()}`);
  const cred = await res.json();
  await initiator.sendDeviceCred({
    userId: cred.user_id,
    deviceId: cred.device_id,
    deviceToken: cred.device_token,
  });
  console.log("新设备已登记。");
}

async function cmdJoin(code) {
  if (!/^\d{6}$/.test(code)) throw new Error("配对码必须是 6 位数字");
  const endpoint = (process.env.MB_ENDPOINT ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const channel = new sdk.HttpPairingChannel(endpoint);
  const joiner = new sdk.PairingJoiner(channel, code);
  await joiner.join();
  const ok = await joiner.verify();
  if (!ok) throw new Error("配对确认失败");
  console.log("SAS 指纹（请与对端核对）：", joiner.getSasFingerprint());
  const mk = await joiner.receiveMk();
  const keys = sdk.generateAgentKeyPair();
  await joiner.sendDevicePubkey(keys.publicKey);
  const cred = await joiner.receiveDeviceCred();
  const kc = sdk.createBestKeychain(mbHome());
  await kc.setMk(mk);
  await sdk.saveDeviceSk(mbHome(), keys.secretKey);
  await writeConfig({
    endpoint,
    user_id: cred.userId,
    device_id: cred.deviceId,
    device_token: cred.deviceToken,
    agent_id: process.env.MB_AGENT_ID ?? "claude-code",
    cache: { dir: mbHome() },
    telemetry: { opt_in: false },
  });
  mk.fill(0);
  keys.secretKey.fill(0);
  console.log("已加入。config:", path.join(mbHome(), "config.json"));
}

async function cmdRecover(userId, mnemonic) {
  if (!userId || !mnemonic) throw new Error("用法: recover <user_id> \"<mnemonic>\"");
  const endpoint = (process.env.MB_ENDPOINT ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const saltRes = await fetch(`${endpoint}/api/auth/salt/${encodeURIComponent(userId)}`);
  if (!saltRes.ok) throw new Error(`salt: ${saltRes.status}`);
  const { fixed_salt } = await saltRes.json();
  const mk = sdk.deriveMkFromMnemonic(mnemonic, fixed_salt);
  const keys = sdk.generateAgentKeyPair();
  const res = await fetch(`${endpoint}/api/auth/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      recovery_verifier: sdk.recoveryVerifier(mk),
      device_pubkey: sdk.toBase64(keys.publicKey),
      device_name: os.hostname(),
      device_type: process.platform,
    }),
  });
  if (!res.ok) throw new Error(`recover: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const kc = sdk.createBestKeychain(mbHome());
  await kc.setMk(mk);
  await sdk.saveDeviceSk(mbHome(), keys.secretKey);
  await writeConfig({
    endpoint,
    user_id: body.user_id,
    device_id: body.device_id,
    device_token: body.device_token,
    agent_id: process.env.MB_AGENT_ID ?? "claude-code",
    cache: { dir: mbHome() },
    telemetry: { opt_in: false },
  });
  mk.fill(0);
  keys.secretKey.fill(0);
  console.log("恢复完成。user_id:", body.user_id);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === "pair") await cmdPair();
  else if (cmd === "join") await cmdJoin(a);
  else if (cmd === "recover") await cmdRecover(a, b ?? process.argv.slice(4).join(" "));
  else {
    console.error("用法: pair | join <code> | recover <user_id> \"<mnemonic>\"");
    process.exit(1);
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
