<p align="center">
  <b>中文</b> · <a href="./README.md">English</a>
</p>

# memgrant

用户自持密钥、端到端加密、按 Agent 密码学授权的跨 Agent 记忆组件。
同步服务由你自己部署。本仓库不运营托管云。

npm 工作区名：`memgrant`（`@memgrant/*`）

[愿景](VISION.md) · [安全](SECURITY.md) · [自托管](docs/self-host.md)

## 项目初衷

人已经不只跟一个 Agent 说话。写代码、查资料、改文档，往往同时开着几个窗口；偏好、项目事实、你反复纠正过的习惯，却锁在某一个产品里。换一个 Agent，它不认识你。

把这些内容存进别人的服务器，等于把长期笔记交给第三方保管。真正需要的其实很窄：钥匙在自己手里；明文只在自己的设备上判断和检索；同步节点只见到密文；每个 Agent 只能解开你明确授权的那一部分，收回授权后新拉下来的内容它解不开。

所以这个仓库做成一个你可以自己跑的协议组件，心智对标 [age](https://github.com/FiloSottile/age) 这类「用户持有密钥」的工具，而不是又一个记忆召回产品。记忆跟着你的密钥走，不跟着某一家 Agent 厂商走。

## 承诺

- 同步节点（含你自己的 Workers）只见密文
- 每个 Agent 只有对应的 ECIES grant 才能解密；撤销 = 删 grant = 新拉取不可解
- 判断与检索在本地，明文不出设备

不承诺对模型厂商保密：注入上下文的片段对模型是明文。详见 [SECURITY.md](SECURITY.md)。

## 架构

```
packages/
├── sdk-core/      加密引擎、L0 规则、本地缓存、同步客户端、SPAKE2
├── cloud/         自托管 Workers：密文存 R2，元数据 D1，同步 DO
├── mcp-server/    save / search / delete
├── adapters/      Claude Code Hooks
└── desktop/       本机 127.0.0.1 管理台
```

```
助记词（BIP-39）
  │ PBKDF2-SHA256(mnemonic, fixed_salt, 600k)
  ▼
MK（平台 Keychain，永不触网）
  │ AES-KW
  ▼
DEK（每条记忆随机，AES-256-GCM）
  │ ECIES（secp256k1）
  ▼
每个授权 Agent 一份 enc_dek
```

## 快速开始（本机）

```bash
npm install
npm run build
npm test
node scripts/smoke.mjs

npm run dev:cloud          # wrangler dev → http://127.0.0.1:8787
```

本地 D1 默认是空库，第一次（或清掉 `.wrangler` 之后）要建表：

```bash
cd packages/cloud
npx wrangler d1 execute memory-backbone --local --file=./schema.sql
cd ../..
npm run setup              # 写入 ~/.memory-backbone/config.json 并注册首设备
```

MCP（Claude Code / Cursor 等）：

```json
{
  "mcpServers": {
    "memgrant": {
      "command": "node",
      "args": ["path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

管理台：`npm run desktop`（仅绑定 127.0.0.1）。点 **从云端拉同步** 会把节点上的密文解开写进本机缓存。

多设备**主路径**：在新机器上 `node scripts/cli.mjs recover <user_id> "<mnemonic>"`。

6 位配对码（`pair` / `join`）只是便利手段。SPAKE2 未经第三方协议审计。

部署到自己的 Cloudflare 账号见 [docs/self-host.md](docs/self-host.md)，或 `npm run deploy:cf`。

一键写入 Cursor MCP 与 Claude Code hooks：

```bash
npm run build
npm run clients
```

然后在 Cursor 里重载 MCP。

## 可选：用本机模型做判断

默认判断是本地正则规则（L0）。你可以额外接 **本机** OpenAI 兼容接口（Ollama、LM Studio、llama.cpp），用来决定该不该存、敏感级别。助记词仍然只用来派生主密钥，**不能**用模型替换。

在 `~/.memory-backbone/config.json` 里加上：

```json
"judge": {
  "l1": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5:7b"
  }
}
```

L0 始终先跑，作为安全地板：凭证类仍是 4 级，模型不能降级。模型挂掉或超时则退回纯 L0。不装模型也能用本仓库。

本机模型进程会看到正在分类的明文。同步节点仍然只见密文。把 `baseUrl` 指到远程 API 等于让明文离机——除非你接受这一点，否则不要这样做。

可选本机向量（同一套 `/v1`）做混合检索：

```json
"embedder": {
  "l1": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "nomic-embed-text"
  }
}
```

不配时仍可搜：关键词 + 本地哈希向量（不是语义模型）。

HTTP 优先用 **MB1** 设备签名（先 `POST /api/auth/challenge`）。`device_token` 留给 WebSocket 和旧客户端。

## 验收测试

| 门禁 | 内容 |
|------|------|
| S1 | 双设备同助记词派生同一 MK |
| S2 | ECIES 正负向 |
| S3 | SPAKE2 RFC 9382 向量 + 恶意中继失败 |
| S4 | Agent 只解得开授权范围 |
| S5 | 撤销后不再获得 grant |
| S7 | tags 白名单 |
| R1/R2 | 断网本地可读 + 离线队列 |

```bash
node scripts/e2e-selfhost.mjs    # 双设备写入→对端可读
node scripts/revoke-demo.mjs     # 撤销后 Agent 读取 404
```

## npm 包

本机 `npm login` 之后可发布（cloud 保持 private，自己部署）：

```bash
npm publish -w @memgrant/sdk-core --access public
npm publish -w @memgrant/mcp-server --access public
npm publish -w @memgrant/adapters --access public
npm publish -w @memgrant/desktop --access public
```

## 许可证

[Apache License 2.0](LICENSE)

## 已知限制

SPAKE2 未经第三方协议审计；平台 Keychain 不可用时降级为文件。完整列表见 [SECURITY.md](SECURITY.md)。
