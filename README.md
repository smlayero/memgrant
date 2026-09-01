# 跨 Agent 记忆骨干（memory-backbone）

用户持有、端到端加密、密码学权限分级的跨 Agent 记忆基础设施。
记忆主权在用户，云端架构保证零知识，每个 Agent 只能解密被明确授权的记忆范围，撤销即失效。

本仓库是《产品技术方案 v2》的 Phase 1 MVP 实现（Sprint 1-4 核心链路）。

## 架构

```
packages/
├── sdk-core/      客户端核心（开源 AGPL）
│   ├── crypto/    MK/DEK/ECIES/AES-KW/BIP39/Keychain（含 DPAPI/security/secret-tool 平台后端）
│   ├── judge/     L0 规则判断引擎 + Embedder 接口（内置 hash fallback，bge-m3 可插拔）
│   ├── cache/     SQLite 本地缓存 + 向量/混合检索 + 离线队列（指数退避）
│   ├── sync/      WS + 增量游标同步客户端
│   ├── pairing/   SPAKE2 配对（RFC 9382，官方测试向量验证）+ 设备/Agent 配对流程
│   └── memory/    写入/读取主链路编排（MemoryService）
├── cloud/         云端（Cloudflare Workers，零知识）
│   ├── schema.sql     D1 数据模型（users/memories/agent_grants/teams...）
│   └── src/           Hono API + SyncHub Durable Object + 配对会话（KV，TTL 5min/10 次上限）
├── mcp-server/    MCP Server（save/search/delete 三工具，113+ 客户端零集成）
├── adapters/      Claude Code Hooks（SessionStart 注入 / Stop 保存 / PreCompact）+ npx 一键安装
└── desktop/       桌面管理 App（本地 Web UI，仅 127.0.0.1：记忆/权限/密钥/审计）
```

## 加密体系（方案 §4）

```
助记词（BIP-39，用户自持）
  │ PBKDF2-SHA256(mnemonic, fixed_salt, 600k)   ← 生成/恢复同一函数
  ▼
MK（256-bit，Keychain 存储，永不触网）
  │ AES-KW 包裹
  ▼
DEK（每条记忆随机，AES-256-GCM 加密内容）
  │ ECIES（secp256k1 + HKDF + AES-GCM）
  ▼
每个授权 Agent 一份 enc_dek（agent_grants）
```

- 撤销 Agent = 云端删 grants = 密码学即时失效（Agent 自始至终不接触 MK）
- MK 轮换只需重加密 wrapped_dek（grants 不受影响）
- fixed_salt 是用户级固定值（修复 v1 用设备标识导致恢复失效的 P0）

## 已通过的验收测试（sdk-core 41 项 + adapters 3 项 + desktop 7 项）

| 门禁 | 测试 | 结果 |
|------|------|------|
| S1 | 双设备同助记词派生同一 MK（v1 P0 回归） | ✅ |
| S2 | ECIES 加解密 + 错误私钥/篡改负向测试 | ✅ |
| S3 | SPAKE2 RFC 9382 官方测试向量 + 恶意中继 MITM 确认失败 + 错码拒绝 | ✅ |
| S4 | Agent 只解得开授权范围（Level 4 隔离） | ✅ |
| S5 | revoked Agent 不再获得 grant | ✅ |
| S7 | tags 白名单硬校验 | ✅ |
| R1/R2 | 断网本地可读 + 离线队列退避/死信 | ✅ |
| — | 混合检索（向量+关键词）、hooks 幂等安装、桌面 API、平台 Keychain* | ✅ |

\* 平台 Keychain 的 DPAPI 实测在禁止子进程的沙箱环境自动跳过，正常 Windows/macOS/Linux 环境执行。

## 快速开始

```bash
npm install
npm run build
cd packages/sdk-core && npm test     # 25 项验收测试
node scripts/smoke.mjs               # 端到端冒烟（写入→双路径解密→隔离）
```

### 部署云端

```bash
cd packages/cloud
wrangler d1 create memory-backbone          # 将 database_id 写入 wrangler.toml
wrangler kv namespace create SESSIONS       # 将 id 写入 wrangler.toml
wrangler r2 bucket create memory-backbone-vault
npm run db:init && npm run deploy
```

### 接入 MCP 客户端（Claude Code 示例）

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

配置 `~/.memory-backbone/config.json`：

```json
{
  "endpoint": "https://memory-backbone.workers.dev",
  "agent_id": "claude-code",
  "device_token": "注册/配对后获得",
  "cache": { "dir": "~/.memory-backbone" }
}
```

## 尚未实现（Phase 2+）

- L1 ONNX 分类器 / L2 Qwen3 本地模型（M4-M5 / M8-M9，Embedder 接口已预留）
- bge-m3 语义向量模型（接口已插拔化，当前为 hash fallback）
- Electron 壳（桌面 App 功能已就绪，发布版包裹同一前端）
- 第三方渗透测试（Sprint 6 出口标准，需外部执行）
- 生产级认证（当前 MVP 为设备 token，Phase 2 换公钥签名挑战）

## 发布前必须完成的安全事项

1. **SPAKE2 实现第三方审计**：当前实现经 RFC 9382 官方测试向量验证，但属自编排协议，按方案风险表纪律需外部审计（或换审计过的库）。
2. **渗透测试**（S8 硬门禁：无 P0/P1）。
3. DPAPI/security/secret-tool 三平台后端在真实设备上逐一验证。

## 零知识纪律

云端只见：密文、ECIES grant、脱敏类别标签（白名单二次校验）、尺寸、时间戳。
云端永不见：记忆内容、敏感标签、判断结果、任何密钥材料。
