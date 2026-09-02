#!/usr/bin/env node
/**
 * 部署到你自己的 Cloudflare 账号。未登录则打印步骤后退出 0。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "cloud");

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

const who = await run(["whoami"]);
if (who.code !== 0) {
  console.log(`
未登录 Cloudflare。自托管步骤：

  cd packages/cloud
  npx wrangler login
  npx wrangler d1 create memory-backbone
  npx wrangler kv namespace create SESSIONS
  npx wrangler r2 bucket create memory-backbone-vault
  # 把返回的 id 写入 wrangler.toml
  npx wrangler d1 execute memory-backbone --remote --file=./schema.sql
  npx wrangler deploy

本仓库不运营托管云。助记词恢复是丢设备后的主路径。
`);
  process.exit(0);
}

console.log("已登录。请按 docs/self-host.md 填好 wrangler.toml 后执行: npm run deploy --workspace @memgrant/cloud");
