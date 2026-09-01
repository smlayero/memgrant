# cross-agent-memory

用户自持密钥、端到端加密、按 Agent 密码学授权的跨 Agent 记忆组件。
同步服务由你自己部署。本仓库不运营托管云。

A self-hosted, user-held, end-to-end encrypted memory layer for multiple agents.
Each agent decrypts only what it has been granted. This repository does not run a hosted cloud.

npm 工作区名 / workspace name: `memory-backbone`（`@memory-backbone/*`）

[VISION](VISION.md) · [SECURITY](SECURITY.md) · [自托管 / Self-hosting](docs/self-host.md)

## 项目初衷 / Why this exists

人已经不只跟一个 Agent 说话。写代码、查资料、改文档，往往同时开着几个窗口；偏好、项目事实、你反复纠正过的习惯，却锁在某一个产品里。换一个 Agent，它不认识你。

把这些内容存进别人的服务器，等于把长期笔记交给第三方保管。真正需要的其实很窄：钥匙在自己手里；明文只在自己的设备上判断和检索；同步节点只见到密文；每个 Agent 只能解开你明确授权的那一部分，收回授权后新拉下来的内容它解不开。

所以这个仓库做成一个你可以自己跑的协议组件，心智对标 [age](https://github.com/FiloSottile/age) 这类「用户持有密钥」的工具，而不是又一个记忆召回产品。记忆跟着你的密钥走，不跟着某一家 Agent 厂商走。

You already talk to more than one agent. Coding, research, and editing often happen in several windows at once, while preferences, project facts, and corrections stay trapped inside a single product. Switch agents, and you start from zero.

Putting that material on someone else's servers means handing long-lived notes to a third party. The actual need is narrower: you hold the keys; judging and search stay on your device in plaintext; the sync node sees only ciphertext; each agent can decrypt only what you granted; after you revoke a grant, newly fetched ciphertext is unreadable to that agent.

This repo is a protocol component you run yourself. The mental model is tools like [age](https://github.com/FiloSottile/age)—user-held keys—not another memory-retrieval product. Memory follows your key, not a particular agent vendor.

## 承诺 / Guarantees

- 同步节点（含你自己的 Workers）只见密文。 / The sync node (including your own Workers) sees ciphertext only.
- 每个 Agent 只有对应的 ECIES grant 才能解密；撤销 = 删 grant = 新拉取不可解。 / An agent can decrypt only with its ECIES grant. Revoke = delete the grant = newly fetched ciphertext is unreadable.
- 判断与检索在本地，明文不出设备。 / Classification and search run locally. Plaintext does not leave the device.

不承诺对模型厂商保密：注入上下文的片段对模型是明文。详见 [SECURITY.md](SECURITY.md)。

This does **not** promise secrecy from model vendors: any snippet injected into context is plaintext to the model. See [SECURITY.md](SECURITY.md).

## 架构 / Architecture

```
packages/
├── sdk-core/      crypto, L0 rules, local cache, sync client, SPAKE2
├── cloud/         self-hosted Workers: ciphertext on R2, metadata on D1, sync DO
├── mcp-server/    save / search / delete
├── adapters/      Claude Code hooks
└── desktop/       local console bound to 127.0.0.1
```

```
助记词 / BIP-39 mnemonic
  │ PBKDF2-SHA256(mnemonic, fixed_salt, 600k)
  ▼
MK（平台 Keychain，永不触网 / never leaves the device）
  │ AES-KW
  ▼
DEK（每条记忆随机 / per-memory, AES-256-GCM）
  │ ECIES（secp256k1）
  ▼
每个授权 Agent 一份 enc_dek / one wrapped DEK per granted agent
```

## 快速开始（本机） / Quick start (local)

```bash
npm install
npm run build
npm test
node scripts/smoke.mjs

npm run dev:cloud          # wrangler dev → http://127.0.0.1:8787
```

本地 D1 默认是空库，第一次（或清掉 `.wrangler` 之后）要建表：

Local D1 starts empty. Create tables on first run (or after deleting `.wrangler`):

```bash
cd packages/cloud
npx wrangler d1 execute memory-backbone --local --file=./schema.sql
cd ../..
npm run setup              # writes ~/.memory-backbone/config.json and registers the first device
```

MCP（Claude Code / Cursor 等）:

```json
{
  "mcpServers": {
    "memory-backbone": {
      "command": "node",
      "args": ["path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

管理台 / desktop console: `npm run desktop`（仅绑定 / binds only `127.0.0.1`）。

多设备 / extra devices: 已有设备上 `node scripts/cli.mjs pair`，新设备 `node scripts/cli.mjs join <code>`。

助记词恢复 / mnemonic recover: `node scripts/cli.mjs recover <user_id> "<mnemonic>"`。

部署到自己的 Cloudflare 账号见 [docs/self-host.md](docs/self-host.md)。

Deploy to your own Cloudflare account: [docs/self-host.md](docs/self-host.md).

## 验收测试 / Acceptance tests

| 门禁 / Gate | 内容 / What it checks |
|------|------|
| S1 | 双设备同助记词派生同一 MK / two devices, same mnemonic → same MK |
| S2 | ECIES 正负向 / ECIES success and failure paths |
| S3 | SPAKE2 RFC 9382 向量 + 恶意中继失败 / RFC vectors + malicious relay fails |
| S4 | Agent 只解得开授权范围 / agent decrypts only its grant |
| S5 | 撤销后不再获得 grant / revoke then grant is gone |
| S7 | tags 白名单 / tag allowlist |
| R1/R2 | 断网本地可读 + 离线队列 / offline read + outbox |

```bash
node scripts/e2e-selfhost.mjs    # 双设备写入→对端可读 / write on A, read on B
node scripts/revoke-demo.mjs     # 撤销后 Agent 读取 404 / revoke → 404
```

## 许可证 / License

[Apache License 2.0](LICENSE)

## 已知限制 / Known limits

SPAKE2 未经第三方协议审计；平台 Keychain 不可用时降级为文件。完整列表见 [SECURITY.md](SECURITY.md)。

SPAKE2 has not had a third-party protocol audit. If the platform keychain is unavailable, the implementation falls back to a file. Full list: [SECURITY.md](SECURITY.md).
