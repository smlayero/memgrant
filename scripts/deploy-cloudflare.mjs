#!/usr/bin/env node
/**
 * 部署到调用者自己的 Cloudflare 账号：创建 D1/KV/R2、回写 wrangler.toml、建表、deploy。
 * 本仓库不运营托管云。未登录则打印步骤后退出 0。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "cloud");
const tomlPath = path.join(cloudDir, "wrangler.toml");
const D1_NAME = "memory-backbone";
const R2_NAME = "memory-backbone-vault";
const KV_TITLE = "SESSIONS";
const PLACEHOLDER_D1 = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_KV = "00000000000000000000000000000000";

function run(args) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...args], {
      cwd: cloudDir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

function parseUuid(out) {
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m?.[0] ?? null;
}

function parseKvId(out) {
  const quoted = out.match(/id["']?\s*[:=]\s*["']([0-9a-f]{32})["']/i);
  if (quoted) return quoted[1];
  const bare = out.match(/\b([0-9a-f]{32})\b/i);
  return bare?.[1] ?? null;
}

function patchToml(src, d1Id, kvId) {
  let next = src;
  if (d1Id) {
    next = next.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${d1Id}"`);
  }
  if (kvId) {
    next = next.replace(/^id\s*=\s*"[^"]*"/m, `id = "${kvId}"`);
  }
  return next;
}

const MANUAL = `
未登录 Cloudflare。自托管步骤（或登录后重跑 npm run deploy:cf）：

  cd packages/cloud
  npx wrangler login
  npm run deploy:cf

本仓库不运营托管云。助记词恢复是丢设备后的主路径。
`;

const who = await run(["whoami"]);
if (who.code !== 0) {
  console.log(MANUAL);
  process.exit(0);
}

let toml = await fs.readFile(tomlPath, "utf8");
let d1Id = toml.match(/database_id\s*=\s*"([^"]+)"/)?.[1] ?? "";
let kvId = toml.match(/^id\s*=\s*"([^"]+)"/m)?.[1] ?? "";

if (!d1Id || d1Id === PLACEHOLDER_D1) {
  console.log("正在创建 D1", D1_NAME, "…");
  const created = await run(["d1", "create", D1_NAME]);
  d1Id = parseUuid(created.out);
  if (!d1Id) {
    const listed = await run(["d1", "list"]);
    const row = listed.out.split("\n").find((l) => l.includes(D1_NAME));
    d1Id = row ? parseUuid(row) : null;
  }
  if (!d1Id) {
    console.error("无法得到 D1 database_id。请按 docs/self-host.md 手工填 wrangler.toml。");
    process.exit(1);
  }
}

if (!kvId || kvId === PLACEHOLDER_KV) {
  console.log("正在创建 KV", KV_TITLE, "…");
  const created = await run(["kv", "namespace", "create", KV_TITLE]);
  kvId = parseKvId(created.out);
  if (!kvId) {
    console.error("无法得到 KV namespace id。请按 docs/self-host.md 手工填 wrangler.toml。");
    process.exit(1);
  }
}

console.log("正在确保 R2 桶", R2_NAME, "…");
await run(["r2", "bucket", "create", R2_NAME]);

const patched = patchToml(toml, d1Id, kvId);
if (patched !== toml) {
  await fs.writeFile(tomlPath, patched);
  toml = patched;
  console.log("已回写", tomlPath);
}

console.log("正在写入远程 D1 schema…");
const schema = await run([
  "d1",
  "execute",
  D1_NAME,
  "--remote",
  "--yes",
  "--file=./schema.sql",
]);
if (schema.code !== 0) {
  console.error("schema 写入失败。若库已存在可忽略重复错误后继续 deploy。");
}

console.log("正在 wrangler deploy…");
const deployed = await run(["deploy"]);
if (deployed.code !== 0) process.exit(deployed.code);

console.log("");
console.log("已部署到你自己的 Cloudflare 账号。把 MCP / setup 的 endpoint 改成 workers.dev 地址。");
console.log("本仓库维护者不托管用户数据。");
