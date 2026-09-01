# VISION

用户自持密钥、端到端加密、按 Agent 密码学授权的跨 Agent 记忆组件。
全部开源，同步服务由用户自己部署。没有托管云，没有订阅。

对标心智是 [age](https://github.com/FiloSottile/age) / Signal 协议库，不是 Mem0。

## 是什么

- 本地 SDK：写入时加密，读取时解密，判断与检索不出设备
- MCP Server + Claude Code Hooks：Agent 用标准协议显式保存 / 检索 / 删除
- 自托管同步节点（Cloudflare Workers：D1 + R2 + Durable Object）：只存密文、grant 与最少元数据
- 每 Agent 一份 ECIES grant；撤销 = 删除 grant = 新拉取的密文不可解

## 不是什么

- 不是记忆智能 SaaS，不和 Mem0/Zep 比召回榜
- 不是托管云；本仓库维护者不运营用户数据
- 不做订阅、seat、团队空间计费、浏览器扩展、本地大模型分发
- 不承诺「对模型厂商保密」：注入上下文的片段对模型是明文

上层目录里的《产品方向与计划 v2》等文档是历史商业化方案，**已搁置**。以本文件为准。

## 威胁模型（摘要）

| 事件 | 结果 |
|------|------|
| 自托管节点被攻破 | 攻击者得到密文、ECIES grant、脱敏类别标签；无明文、无 MK |
| 某 Agent 被入侵 | 仅其授权范围内、已缓存到该 Agent 本地的明文 |
| 撤销 Agent | 云端 grants 删除；此后新拉取全部不可解。已缓存在 Agent 本地的历史明文无法远程擦除 |
| 配对中间人 | SPAKE2 下替换公钥会使确认值失败（实现待外部审计，见 SECURITY.md） |

## 自托管边界

两种合法运行方式：

1. `wrangler dev` 本机全栈（本地 D1/R2/KV/DO），开发与单机使用
2. 部署到**你自己的** Cloudflare 账号（免费额度通常够个人/小团队）

Docker 只是给 `wrangler dev` 套一层，方便隔离，不是生产方案。

## 与邻近项目的差异

Walrus Memory 的默认生产路径是托管 relayer 见明文再加密；本组件默认在客户端加密，同步节点只见密文。访问控制落在密钥分发（每条记忆 × 每个 Agent 一份 grant），不是整账号一把 delegate key。
