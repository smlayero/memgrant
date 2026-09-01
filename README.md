# memory-backbone

用户自持密钥、端到端加密、按 Agent 密码学授权的跨 Agent 记忆组件。
同步服务由你自己部署。本仓库不运营托管云、不计费。

[VISION](VISION.md) · [SECURITY](SECURITY.md) · [自托管](docs/self-host.md)

## 承诺

- 同步节点（含你自己的 Workers）只见密文
- 每个 Agent 只有对应的 ECIES grant 才能解密；撤销 = 删 grant = 新拉取不可解
- 判断与检索在本地，明文不出设备

不承诺对模型厂商保密：注入上下文的片段对模型是明文。详见 [SECURITY.md](SECURITY.md)。

历史商业化方案文档已搁置，以 [VISION.md](VISION.md) 为准。

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
    "memory-backbone": {
      "command": "node",
      "args": ["path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

管理台：`npm run desktop`（仅绑定 127.0.0.1）。

多设备：`node scripts/cli.mjs pair` 在已有设备上发起，`node scripts/cli.mjs join <code>` 在新设备上加入。助记词恢复：`node scripts/cli.mjs recover <user_id> "<mnemonic>"`。

部署到自己的 Cloudflare 账号见 [docs/self-host.md](docs/self-host.md)。

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

## 许可证

[Apache License 2.0](LICENSE)

## 已知限制

SPAKE2 未经第三方协议审计；平台 Keychain 不可用时降级为文件。完整列表见 [SECURITY.md](SECURITY.md)。
