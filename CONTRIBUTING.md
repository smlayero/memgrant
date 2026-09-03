# 贡献

感谢你愿意改这个组件。默认假设：改动必须保持零知识纪律。

## 开发

```bash
npm install
npm run build
npm test
node scripts/smoke.mjs
node scripts/e2e-selfhost.mjs
node scripts/revoke-demo.mjs
```

需要本机同步节点时：`npm run init`（建表、注册、MCP）或已有环境时 `npm run dev:cloud`。

## 纪律

- 同步节点（`packages/cloud`）不得处理记忆明文，也不得把明文写入日志或指标
- 类别级 `tags` 必须走白名单；敏感标签只允许 `encrypted_tags`
- 新的网络载荷只能是密文、grant、PAKE 公开消息、或最少元数据
- 不要引入默认开启的遥测或第三方判断 API
- 不要把计费、seat、托管云运营重新写进主路径

## 测试

安全相关改动至少补：正向路径 + 一条负向路径（错误密钥、撤销后、权限不足）。

PR 保持小而可审。加密协议变更请在描述里写清威胁模型影响。
