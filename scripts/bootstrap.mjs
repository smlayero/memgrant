#!/usr/bin/env node
/**
 * 首次安装：本地 D1 建表、等同步节点、注册首设备、写入默认 Agent、MCP。
 * 已初始化则跳过注册，只补 schema / Agent / 客户端。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLOUD = path.join(ROOT, "packages", "cloud");
const endpoint = (process.env.MB_ENDPOINT ?? "http://127.0.0.1:8787").replace(/\/$/, "");

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} → ${code}`)),
    );
  });
}

async function waitHealth(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function applySchema() {
  console.log("正在写入本地 D1 schema…");
  await run(
    "npx",
    ["wrangler", "d1", "execute", "memory-backbone", "--local", "--yes", "--file=./schema.sql"],
    CLOUD,
  );
}

async function ensureCloud() {
  if (await waitHealth(1500)) return;
  console.log(`同步节点未就绪，正在启动 wrangler dev（${endpoint}）…`);
  const child = spawn("npx", ["wrangler", "dev"], {
    cwd: CLOUD,
    shell: process.platform === "win32",
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  if (await waitHealth(45000)) return;
  console.error(`
同步节点仍未响应 ${endpoint}/health。
请另开终端运行：npm run dev:cloud
然后再执行：npm run init
`);
  process.exit(1);
}

const mcpDist = path.join(ROOT, "packages", "mcp-server", "dist", "index.js");
try {
  await fs.access(mcpDist);
} catch {
  console.log("正在构建…");
  await run("npm", ["run", "build"], ROOT);
}

await applySchema();
await ensureCloud();
await run(process.execPath, [path.join(HERE, "setup.mjs")], ROOT);
await run(process.execPath, [path.join(HERE, "install-clients.mjs")], ROOT);

console.log("");
console.log("首次安装完成。请抄写上面的助记词（若本次新生成）。");
console.log("管理台（Agent 授权）：npm run desktop  →  http://127.0.0.1:4787");
console.log("在 Cursor 里重载 MCP。同步节点需保持 npm run dev:cloud。");
