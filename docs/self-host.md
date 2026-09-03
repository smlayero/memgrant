# 自托管

本仓库不提供托管云。同步节点跑在你的机器或你自己的 Cloudflare 账号上。

## 本机（开发 / 单机）

```bash
npm install
npm run build
npm run init
```

`init` 会：

1. 写入本地 D1 schema（不必再手跑 `wrangler d1 execute`）
2. 若 `127.0.0.1:8787` 空闲则拉起 `wrangler dev`（不需要 Cloudflare 账号）
3. 生成助记词、注册首设备（已有 `config.json` 则跳过）
4. 预置 `cursor` / `claude-code` 两个授权目标
5. 写入 Cursor MCP 与 Claude Code hooks

管理台默认打开 **Agent 授权**：`npm run desktop` → http://127.0.0.1:4787。

单独步骤仍可用：`npm run setup`、`npm run clients`。

## 部署到自己的 Cloudflare 账号

免费额度通常够个人使用。

```bash
cd packages/cloud
npx wrangler login
npx wrangler d1 create memory-backbone          # 把 database_id 写入 wrangler.toml
npx wrangler kv namespace create SESSIONS       # 把 id 写入 wrangler.toml
npx wrangler r2 bucket create memory-backbone-vault
npx wrangler d1 execute memory-backbone --remote --file=./schema.sql
npx wrangler deploy
```

把 MCP / setup 的 `endpoint` 改成你的 `https://<name>.<account>.workers.dev`。

已有本地 D1 若缺 `recovery_verifier` 列：

```sql
ALTER TABLE users ADD COLUMN recovery_verifier TEXT;
```

## Docker（仅隔离本机节点，不是生产）

```bash
docker compose up --build
```

容器内跑 `wrangler dev --ip 0.0.0.0`，宿主机 `http://127.0.0.1:8787`。密钥和缓存仍建议留在宿主机 `MB_HOME`。

## 多设备

**主路径（推荐）：** 旧设备丢失或新电脑，用助记词恢复主密钥：

```bash
node scripts/cli.mjs recover <user_id> "word1 word2 ... word24"
```

`user_id` 在首设备 `config.json` 里。恢复证明是 MK 的哈希，MK 本身不上网。

**便利路径：** 已有设备还在、只是再加一台：

```bash
node scripts/cli.mjs pair
```

打印 6 位码。新设备：

```bash
node scripts/cli.mjs join 123456
```

SPAKE2 未经第三方协议审计；不要把它当成比助记词更可信的主路径。
