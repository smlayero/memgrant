-- 跨 Agent 记忆骨干 · D1 schema（技术方案 v2 §3.1/§3.2）
-- 云端零知识：本库只存密文引用、加密密钥材料与最少元数据，绝无内容明文。

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  plan TEXT DEFAULT 'free',            -- free/pro/team/enterprise
  fixed_salt TEXT NOT NULL,            -- 用户级固定 salt（非秘密），助记词派生 MK 用
  storage_used INTEGER DEFAULT 0,
  max_devices INTEGER DEFAULT 2,
  max_memories INTEGER DEFAULT 10000,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),
  device_name TEXT,
  device_type TEXT,
  device_pubkey TEXT,                  -- 设备长期公钥（认证用）
  device_token TEXT NOT NULL,          -- 设备访问令牌（MVP 简化认证，Phase 2 换签名挑战）
  paired_via TEXT,                     -- 'mnemonic' | 'pake'
  last_seen TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);

-- 记忆元数据（内容密文本体在 R2，这里只有键与最少元数据）
CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  ciphertext TEXT NOT NULL,            -- R2 对象键
  wrapped_dek TEXT NOT NULL,           -- DEK 用 MK 包裹（用户设备解密路径）
  key_version INTEGER DEFAULT 1,
  type TEXT,
  tags TEXT,                           -- 仅脱敏类别级标签（白名单），敏感标签禁入
  encrypted_tags TEXT,                 -- 敏感标签密文（DEK 加密）
  encrypted_embedding TEXT,            -- 向量密文（可空）
  permission_level INTEGER DEFAULT 2,  -- 0-4
  importance REAL,
  source_agent TEXT, source_session TEXT,
  judge_model_version TEXT,
  size_bytes INTEGER,
  version INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT, deleted_at TEXT,
  PRIMARY KEY (user_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, deleted_at);

-- Agent 授权（含 Agent 永久公钥，ECIES 授权目标）
CREATE TABLE IF NOT EXISTS agent_access (
  access_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),
  agent_id TEXT,
  agent_name TEXT,
  agent_pubkey TEXT NOT NULL,
  permission_mask INTEGER DEFAULT 2,
  status TEXT DEFAULT 'active',        -- active/revoked
  paired_at TEXT, revoked_at TEXT,
  UNIQUE(user_id, agent_id)
);

-- Agent 授权凭据：每条记忆 × 每个 Agent 的 ECIES(DEK)
CREATE TABLE IF NOT EXISTS agent_grants (
  grant_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  enc_dek TEXT NOT NULL,               -- ECIES(agent_pubkey, DEK)，云端无法解密
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, agent_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_grants_agent ON agent_grants(user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_grants_memory ON agent_grants(memory_id);

-- 同步游标（变更事件只含 memory_id + op，不含内容）
CREATE TABLE IF NOT EXISTS sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  op TEXT NOT NULL,                    -- create/update/delete
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_changes_user ON sync_changes(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_changes_created ON sync_changes(created_at);

-- 审计日志（不含内容）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  actor TEXT NOT NULL,                 -- device_id | agent_id
  action TEXT NOT NULL,
  target TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id);

-- —— 团队空间（Phase 2 预留，方案 §3.2） ——
CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  team_name TEXT,
  plan TEXT DEFAULT 'team',
  created_by TEXT REFERENCES users(user_id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT REFERENCES teams(team_id),
  user_id TEXT REFERENCES users(user_id),
  role TEXT DEFAULT 'member',
  joined_at TEXT, removed_at TEXT,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_keys (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  enc_tk TEXT NOT NULL,                -- ECIES(device_pubkey, TeamKey)
  tk_version INTEGER DEFAULT 1,
  PRIMARY KEY (team_id, device_id)
);
