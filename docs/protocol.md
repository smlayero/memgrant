# 协议（一页）

memgrant 是用户持钥的跨 Agent 记忆层。同步节点只见密文、grant 和最少元数据。对标心智是 age / Signal 协议库，不是记忆召回产品。

## 密钥

```
BIP-39 助记词
  → PBKDF2-SHA256(mnemonic, fixed_salt, 600k) → MK（只在用户设备）
  → AES-KW(MK, DEK)
  → 每条记忆一个随机 DEK，AES-256-GCM 封明文
  → 每个被授权 Agent：ECIES(agent_pk, DEK) = grant
```

- **用户设备**持有 MK，可解全部记忆。
- **Agent** 只持有自己的 `agent_sk`（本机 `agents/<id>.sk`，0600）。无对应 grant 则不可解 DEK。
- **同步节点**（含你自己的 Workers）无 MK、无 agent_sk、无明文。

## 线上载荷（只允许这些）

| 字段 | 含义 |
|------|------|
| ciphertext | `iv \|\| ct+tag`，DEK 封的正文 |
| wrapped_dek | MK 包裹的 DEK，仅用户设备用 |
| grants[].enc_dek | 该 Agent 的 ECIES(DEK) |
| type / tags | 类别级白名单；敏感标签走 encrypted_tags |
| permission_level / size / timestamps | 最少元数据 |

禁止把明文、MK、助记词、agent_sk 送上同步节点。

## 授权与撤销

写入时为每个 `permission_level ≤ mask` 的活跃 Agent 生成一条 grant。  
撤销 = 删除该 Agent 的全部 grant。此后**新拉取**的密文对该 Agent 不可解。  
本机缓存里已经解密过的明文**无法远程擦除**（必须写进 UI）。

## 设备恢复

**主路径：** 24 词助记词在新设备派生同一 MK，再登记新 `device_sk`。  
**实验路径：** 6 位码 SPAKE2 配对（见下）。不要把它当成比助记词更可信。

## SPAKE2（实验）

设备配对用 RFC 9382 编排（P256-SHA256-HKDF-HMAC），云端只中继公开消息，确认值失败则拒绝。实现经过官方测试向量与恶意中继测试，**未经第三方协议审计**。生产敏感场景只用助记词恢复。

## 模型厂商

注入上下文的片段对模型是明文。本协议不承诺对模型厂商保密。
