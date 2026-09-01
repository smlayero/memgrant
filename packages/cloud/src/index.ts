/**
 * 跨 Agent 记忆骨干 · 云端 API（方案 §二/§七）。
 *
 * 零知识纪律：本服务只见密文、ECIES grant、脱敏类别标签与尺寸/时间戳。
 * 任何 handler 都不得处理记忆明文——SDK 上送的载荷本身不含明文，
 * 服务端不做也不允许做内容解析。
 */
import { Hono } from "hono";
import { SyncHub } from "./syncHub.js";
import { parseMb1Header, verifyMb1, b64ToBytes } from "./mb1.js";

export { SyncHub };

export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;
  SESSIONS: KVNamespace;
  SYNC_HUB: DurableObjectNamespace;
  ENV: string;
}

interface AuthedVars {
  userId: string;
  deviceId: string;
}

const app = new Hono<{ Bindings: Env; Variables: AuthedVars }>();

// ---------- 工具 ----------

function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/[/+=]/g, "")
    .slice(0, bytes);
}

/** 类别级标签白名单（方案 §3.3：服务端二次校验，防 SDK 被篡改后注入敏感标签） */
const TAG_WHITELIST = new Set([
  "work",
  "finance",
  "personal",
  "health",
  "tech",
  "travel",
  "family",
  "legal",
  "study",
  "project",
]);

async function broadcast(env: Env, userId: string, event: object): Promise<void> {
  const stub = env.SYNC_HUB.get(env.SYNC_HUB.idFromName(userId));
  await stub.fetch("https://do/broadcast", {
    method: "POST",
    body: JSON.stringify(event),
  });
}

async function recordChange(
  env: Env,
  userId: string,
  memoryId: string,
  op: "create" | "update" | "delete",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_changes (user_id, memory_id, op) VALUES (?, ?, ?)`,
  )
    .bind(userId, memoryId, op)
    .run();
  await broadcast(env, userId, { memoryId, op, ts: Date.now() });
}

// ---------- 认证：MB1 设备签名优先，Bearer device_token 仍可用（WS / 旧配置） ----------

async function auth(
  c: {
    req: {
      header: (n: string) => string | undefined;
      method: string;
      path: string;
    };
    env: Env;
  },
): Promise<{ userId: string; deviceId: string } | null> {
  const header = c.req.header("authorization");
  if (!header) return null;

  if (header.startsWith("MB1 ")) {
    const parsed = parseMb1Header(header);
    if (!parsed) return null;
    const ts = Number(parsed.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 90_000) return null;
    const chal = await c.env.SESSIONS.get(
      `chal:${parsed.deviceId}:${parsed.nonce}`,
    );
    if (!chal) return null;
    const row = await c.env.DB.prepare(
      `SELECT device_id, user_id, device_pubkey FROM devices
       WHERE device_id = ? AND revoked_at IS NULL`,
    )
      .bind(parsed.deviceId)
      .first<{ device_id: string; user_id: string; device_pubkey: string }>();
    if (!row?.device_pubkey) return null;
    let pub: Uint8Array;
    try {
      pub = b64ToBytes(row.device_pubkey);
    } catch {
      return null;
    }
    const ok = verifyMb1(
      parsed.deviceId,
      parsed.nonce,
      parsed.ts,
      c.req.method,
      c.req.path,
      pub,
      parsed.signature,
    );
    if (!ok) return null;
    return { userId: row.user_id, deviceId: row.device_id };
  }

  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const row = await c.env.DB.prepare(
    `SELECT device_id, user_id FROM devices WHERE device_token = ? AND revoked_at IS NULL`,
  )
    .bind(token)
    .first<{ device_id: string; user_id: string }>();
  return row ? { userId: row.user_id, deviceId: row.device_id } : null;
}

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/pairing/")) {
    return next();
  }
  const who = await auth(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", who.userId);
  c.set("deviceId", who.deviceId);
  return next();
});

// ---------- 注册 / 恢复 ----------

app.post("/api/auth/challenge", async (c) => {
  const body = await c.req.json<{ device_id?: string }>();
  if (!body.device_id) return c.json({ error: "device_id required" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT device_id FROM devices WHERE device_id = ? AND revoked_at IS NULL`,
  )
    .bind(body.device_id)
    .first<{ device_id: string }>();
  if (!row) return c.json({ error: "unknown device" }, 404);
  const nonce = randomId(16);
  await c.env.SESSIONS.put(`chal:${body.device_id}:${nonce}`, "1", {
    expirationTtl: 90,
  });
  return c.json({ nonce, ttl: 90 });
});

app.post("/api/auth/register", async (c) => {
  const body = await c.req.json<{
    fixed_salt: string;
    device_pubkey: string;
    device_name?: string;
    device_type?: string;
    paired_via?: string;
    recovery_verifier?: string;
  }>();
  if (!body.fixed_salt || !body.device_pubkey) {
    return c.json({ error: "fixed_salt and device_pubkey required" }, 400);
  }
  const userId = randomId();
  const deviceId = randomId();
  const deviceToken = randomId(32);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (user_id, fixed_salt, recovery_verifier) VALUES (?, ?, ?)`,
    ).bind(userId, body.fixed_salt, body.recovery_verifier ?? null),
    c.env.DB.prepare(
      `INSERT INTO devices (device_id, user_id, device_name, device_type, device_pubkey, device_token, paired_via, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      deviceId,
      userId,
      body.device_name ?? null,
      body.device_type ?? null,
      body.device_pubkey,
      deviceToken,
      body.paired_via ?? "mnemonic",
    ),
  ]);
  return c.json({ user_id: userId, device_id: deviceId, device_token: deviceToken });
});

/** 助记词恢复：新设备取回 fixed_salt（salt 非秘密，方案 §4.2）。 */
app.get("/api/auth/salt/:user_id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT fixed_salt FROM users WHERE user_id = ?`,
  )
    .bind(c.req.param("user_id"))
    .first<{ fixed_salt: string }>();
  if (!row) return c.json({ error: "user not found" }, 404);
  return c.json({ fixed_salt: row.fixed_salt });
});

/** 已有设备登记一台新设备（配对成功后由发起方调用）。 */
app.post("/api/auth/devices", async (c) => {
  const who = await auth(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{
    device_pubkey: string;
    device_name?: string;
    device_type?: string;
    paired_via?: string;
  }>();
  if (!body.device_pubkey) return c.json({ error: "device_pubkey required" }, 400);
  const deviceId = randomId();
  const deviceToken = randomId(32);
  await c.env.DB.prepare(
    `INSERT INTO devices (device_id, user_id, device_name, device_type, device_pubkey, device_token, paired_via, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      deviceId,
      who.userId,
      body.device_name ?? null,
      body.device_type ?? null,
      body.device_pubkey,
      deviceToken,
      body.paired_via ?? "pake",
    )
    .run();
  return c.json({
    user_id: who.userId,
    device_id: deviceId,
    device_token: deviceToken,
  });
});

/**
 * 助记词恢复：证明持有 MK（recovery_verifier）后登记新设备。
 * 云端只比对哈希，永不接收 MK。
 */
app.post("/api/auth/recover", async (c) => {
  const body = await c.req.json<{
    user_id: string;
    recovery_verifier: string;
    device_pubkey: string;
    device_name?: string;
    device_type?: string;
  }>();
  if (!body.user_id || !body.recovery_verifier || !body.device_pubkey) {
    return c.json({ error: "user_id, recovery_verifier, device_pubkey required" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT recovery_verifier FROM users WHERE user_id = ?`,
  )
    .bind(body.user_id)
    .first<{ recovery_verifier: string | null }>();
  if (!row?.recovery_verifier) {
    return c.json({ error: "recovery not enabled; pair with an existing device" }, 400);
  }
  if (row.recovery_verifier !== body.recovery_verifier) {
    return c.json({ error: "verifier mismatch" }, 403);
  }
  const deviceId = randomId();
  const deviceToken = randomId(32);
  await c.env.DB.prepare(
    `INSERT INTO devices (device_id, user_id, device_name, device_type, device_pubkey, device_token, paired_via, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 'mnemonic', datetime('now'))`,
  )
    .bind(
      deviceId,
      body.user_id,
      body.device_name ?? null,
      body.device_type ?? null,
      body.device_pubkey,
      deviceToken,
    )
    .run();
  return c.json({
    user_id: body.user_id,
    device_id: deviceId,
    device_token: deviceToken,
  });
});

// ---------- 记忆写入/读取 ----------

interface SyncPayload {
  op: "create" | "update" | "delete";
  memory_id: string;
  ciphertext?: string;
  wrapped_dek?: string;
  type?: string;
  tags?: string[];
  permission_level?: number;
  importance?: number;
  source_agent?: string;
  judge_model_version?: string;
  size_bytes?: number;
  encrypted_tags?: string;
  grants?: Array<{ grantId: string; agentId: string; memoryId: string; encDekB64: string }>;
  updated_at: string;
}

app.post("/api/memory/sync", async (c) => {
  const userId = c.get("userId");
  const p = await c.req.json<SyncPayload>();
  if (!p.memory_id || !p.op) return c.json({ error: "invalid payload" }, 400);

  if (p.op === "delete") {
    const existing = await c.env.DB.prepare(
      `SELECT ciphertext FROM memories WHERE memory_id = ? AND user_id = ?`,
    )
      .bind(p.memory_id, userId)
      .first<{ ciphertext: string }>();
    if (existing) {
      await c.env.VAULT.delete(existing.ciphertext);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE memories SET deleted_at = datetime('now'), updated_at = ? WHERE user_id = ? AND memory_id = ?`,
        ).bind(p.updated_at, userId, p.memory_id),
        c.env.DB.prepare(`DELETE FROM agent_grants WHERE user_id = ? AND memory_id = ?`).bind(
          userId, p.memory_id,
        ),
      ]);
      await recordChange(c.env, userId, p.memory_id, "delete");
    }
    return c.json({ ok: true });
  }

  if (!p.ciphertext || !p.wrapped_dek) {
    return c.json({ error: "ciphertext and wrapped_dek required" }, 400);
  }

  // 服务端白名单二次校验：脱敏类别级之外的 tags 一律剥离（防 SDK 被篡改）
  const safeTags = (p.tags ?? []).filter((t) => TAG_WHITELIST.has(t));

  const r2Key = `${userId}/${p.memory_id}`;
  const sealed = Uint8Array.from(atob(p.ciphertext), (ch) => ch.charCodeAt(0));
  await c.env.VAULT.put(r2Key, sealed);

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO memories (memory_id, user_id, ciphertext, wrapped_dek, type, tags, encrypted_tags, permission_level, importance, source_agent, judge_model_version, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(user_id, memory_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         wrapped_dek = excluded.wrapped_dek,
         type = excluded.type,
         tags = excluded.tags,
         encrypted_tags = excluded.encrypted_tags,
         permission_level = excluded.permission_level,
         importance = excluded.importance,
         judge_model_version = excluded.judge_model_version,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at,
         version = version + 1,
         deleted_at = NULL`,
    ).bind(
      p.memory_id,
      userId,
      r2Key,
      p.wrapped_dek,
      p.type ?? null,
      JSON.stringify(safeTags),
      p.encrypted_tags ?? null,
      p.permission_level ?? 2,
      p.importance ?? null,
      p.source_agent ?? null,
      p.judge_model_version ?? null,
      p.size_bytes ?? sealed.length,
      p.updated_at,
    ),
  ];

  // 服务端 grants 校验：只接受 agent_access 中 active 且 permission_mask 覆盖的 Agent
  const permLevel = p.permission_level ?? 2;
  const validAgentsRes = await c.env.DB.prepare(
    `SELECT agent_id FROM agent_access
     WHERE user_id = ? AND status = 'active' AND permission_mask >= ?`,
  ).bind(userId, permLevel).all<{ agent_id: string }>();
  const validAgentSet = new Set((validAgentsRes.results ?? []).map((r) => r.agent_id));

  for (const g of (p.grants ?? []).slice(0, 50)) {
    if (!validAgentSet.has(g.agentId)) continue; // 撤销/权限不足的 Agent 不获得 grant
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO agent_grants (grant_id, user_id, agent_id, memory_id, enc_dek)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, agent_id, memory_id) DO UPDATE SET enc_dek = excluded.enc_dek`,
      ).bind(g.grantId, userId, g.agentId, g.memoryId, g.encDekB64),
    );
  }
  await c.env.DB.batch(stmts);
  await recordChange(c.env, userId, p.memory_id, p.op === "create" ? "create" : "update");
  return c.json({ ok: true });
});

/** 用户设备读取：返回密文 + wrapped_dek（MK 路径）。 */
app.get("/api/memory/fetch/:id", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare(
    `SELECT ciphertext, wrapped_dek, type, tags, permission_level, importance, source_agent, created_at, updated_at
     FROM memories
     WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(c.req.param("id"), userId)
    .first<{
      ciphertext: string;
      wrapped_dek: string;
      type: string | null;
      tags: string | null;
      permission_level: number;
      importance: number | null;
      source_agent: string | null;
      created_at: string | null;
      updated_at: string | null;
    }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const obj = await c.env.VAULT.get(row.ciphertext);
  if (!obj) return c.json({ error: "ciphertext missing" }, 404);
  const buf = new Uint8Array(await obj.arrayBuffer());
  const b64 = btoa(String.fromCharCode(...buf));
  let tags: string[] = [];
  try {
    tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    tags = [];
  }
  return c.json({
    ciphertext: b64,
    wrapped_dek: row.wrapped_dek,
    type: row.type,
    tags,
    permission_level: row.permission_level,
    importance: row.importance,
    source_agent: row.source_agent,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

/** Agent 读取：返回密文 + 该 Agent 的 grant；无 grant → 404（双保险，方案 §7.1）。 */
app.get("/api/memory/read/:id", async (c) => {
  const userId = c.get("userId");
  const agentId = c.req.query("agent_id");
  if (!agentId) return c.json({ error: "agent_id required" }, 400);

  const grant = await c.env.DB.prepare(
    `SELECT enc_dek FROM agent_grants
     WHERE memory_id = ? AND user_id = ? AND agent_id = ?`,
  )
    .bind(c.req.param("id"), userId, agentId)
    .first<{ enc_dek: string }>();
  if (!grant) return c.json({ error: "not found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT ciphertext FROM memories
     WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(c.req.param("id"), userId)
    .first<{ ciphertext: string }>();
  if (!row) return c.json({ error: "not found" }, 404);

  const obj = await c.env.VAULT.get(row.ciphertext);
  if (!obj) return c.json({ error: "ciphertext missing" }, 404);
  const buf = new Uint8Array(await obj.arrayBuffer());
  const b64 = btoa(String.fromCharCode(...buf));
  return c.json({ ciphertext: b64, enc_dek: grant.enc_dek });
});

app.delete("/api/memory/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    `SELECT ciphertext FROM memories WHERE memory_id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first<{ ciphertext: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  await c.env.VAULT.delete(existing.ciphertext);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE memories SET deleted_at = datetime('now') WHERE user_id = ? AND memory_id = ?`,
    ).bind(userId, id),
    c.env.DB.prepare(`DELETE FROM agent_grants WHERE user_id = ? AND memory_id = ?`).bind(userId, id),
  ]);
  await recordChange(c.env, userId, id, "delete");
  return c.json({ ok: true });
});

// ---------- 权限与授权（方案 §7.1） ----------

app.post("/api/permissions/grant", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    agent_id: string;
    agent_name?: string;
    agent_pubkey: string;
    permission_mask: number;
  }>();
  if (!body.agent_id || !body.agent_pubkey) {
    return c.json({ error: "agent_id and agent_pubkey required" }, 400);
  }
  const accessId = randomId();
  await c.env.DB.prepare(
    `INSERT INTO agent_access (access_id, user_id, agent_id, agent_name, agent_pubkey, permission_mask, status, paired_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
     ON CONFLICT(user_id, agent_id) DO UPDATE SET
       agent_pubkey = excluded.agent_pubkey,
       permission_mask = excluded.permission_mask,
       status = 'active',
       revoked_at = NULL`,
  )
    .bind(
      accessId,
      userId,
      body.agent_id,
      body.agent_name ?? body.agent_id,
      body.agent_pubkey,
      body.permission_mask ?? 2,
    )
    .run();
  return c.json({ access_id: accessId, status: "active" });
});

/** 批量上送 ECIES 授权凭据（≤1000，云端无法解密 enc_dek）。 */
app.post("/api/grants/sync", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    grants: Array<{ grant_id: string; agent_id: string; memory_id: string; enc_dek: string }>;
  }>();
  const grants = (body.grants ?? []).slice(0, 1000);
  if (grants.length === 0) return c.json({ accepted: 0 });

  // 服务端 grants 校验：验证 agent 活跃且权限覆盖对应记忆的 permission_level
  const agentsRes = await c.env.DB.prepare(
    `SELECT agent_id, permission_mask FROM agent_access
     WHERE user_id = ? AND status = 'active'`,
  ).bind(userId).all<{ agent_id: string; permission_mask: number }>();
  const agentMaskMap = new Map(
    (agentsRes.results ?? []).map((r) => [r.agent_id, r.permission_mask]),
  );
  const memIds = [...new Set(grants.map((g) => g.memory_id))];
  const memPermMap = new Map<string, number>();
  for (let mi = 0; mi < memIds.length; mi += 500) {
    const batch = memIds.slice(mi, mi + 500);
    const placeholders = batch.map(() => "?").join(",");
    const res = await c.env.DB.prepare(
      `SELECT memory_id, permission_level FROM memories
       WHERE user_id = ? AND memory_id IN (${placeholders})`,
    ).bind(userId, ...batch).all<{ memory_id: string; permission_level: number }>();
    for (const r of res.results ?? []) {
      memPermMap.set(r.memory_id, r.permission_level);
    }
  }
  const validGrants = grants.filter((g) => {
    const mask = agentMaskMap.get(g.agent_id);
    if (mask === undefined) return false;
    const level = memPermMap.get(g.memory_id) ?? 2;
    return mask >= level;
  });

  const stmts = validGrants.map((g) =>
    c.env.DB.prepare(
      `INSERT INTO agent_grants (grant_id, user_id, agent_id, memory_id, enc_dek)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, agent_id, memory_id) DO UPDATE SET enc_dek = excluded.enc_dek`,
    ).bind(g.grant_id, userId, g.agent_id, g.memory_id, g.enc_dek),
  );
  // D1 batch 有语句数上限，分批 100 条
  for (let i = 0; i < stmts.length; i += 100) {
    await c.env.DB.batch(stmts.slice(i, i + 100));
  }
  return c.json({ accepted: validGrants.length, rejected: grants.length - validGrants.length });
});

/** 撤销：删除 agent_access + 该 Agent 全部 grants（密码学上即时失效）。 */
app.delete("/api/permissions/revoke/:agent_id", async (c) => {
  const userId = c.get("userId");
  const agentId = c.req.param("agent_id");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE agent_access SET status = 'revoked', revoked_at = datetime('now')
       WHERE user_id = ? AND agent_id = ?`,
    ).bind(userId, agentId),
    c.env.DB.prepare(
      `DELETE FROM agent_grants WHERE user_id = ? AND agent_id = ?`,
    ).bind(userId, agentId),
  ]);
  return c.json({ ok: true, revoked: agentId });
});

/** 调整掩码：立刻删掉超出新掩码的 grants；提升掩码时由客户端补传新 grant。 */
app.put("/api/permissions/update/:agent_id", async (c) => {
  const userId = c.get("userId");
  const agentId = c.req.param("agent_id");
  const body = await c.req.json<{ permission_mask: number }>();
  const mask = body.permission_mask;
  if (typeof mask !== "number" || mask < 0 || mask > 4) {
    return c.json({ error: "permission_mask must be 0-4" }, 400);
  }
  const existing = await c.env.DB.prepare(
    `SELECT access_id FROM agent_access WHERE user_id = ? AND agent_id = ? AND status = 'active'`,
  )
    .bind(userId, agentId)
    .first<{ access_id: string }>();
  if (!existing) return c.json({ error: "agent not found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE agent_access SET permission_mask = ? WHERE user_id = ? AND agent_id = ?`,
    ).bind(mask, userId, agentId),
    c.env.DB.prepare(
      `DELETE FROM agent_grants WHERE user_id = ? AND agent_id = ? AND memory_id IN (
         SELECT memory_id FROM memories WHERE user_id = ? AND permission_level > ?
       )`,
    ).bind(userId, agentId, userId, mask),
  ]);
  return c.json({ ok: true, permission_mask: mask });
});

/** 用户设备列出 wrapped_dek，供权限变更时重算 grants（不含内容密文）。 */
app.get("/api/memories/keys", async (c) => {
  const userId = c.get("userId");
  const rows = await c.env.DB.prepare(
    `SELECT memory_id, wrapped_dek, permission_level FROM memories
     WHERE user_id = ? AND deleted_at IS NULL`,
  )
    .bind(userId)
    .all<{ memory_id: string; wrapped_dek: string; permission_level: number }>();
  return c.json({ items: rows.results ?? [] });
});

// ---------- 同步 ----------

app.get("/api/sync/changes", async (c) => {
  const userId = c.get("userId");
  const since = Number(c.req.query("since") ?? "0");
  const rows = await c.env.DB.prepare(
    `SELECT seq, memory_id, op FROM sync_changes
     WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT 500`,
  )
    .bind(userId, since)
    .all<{ seq: number; memory_id: string; op: string }>();
  const changes = (rows.results ?? []).map((r) => ({
    cursor: String(r.seq),
    memoryId: r.memory_id,
    op: r.op,
  }));
  const cursor = changes.length > 0 ? changes[changes.length - 1]!.cursor : String(since);
  return c.json({ changes, cursor });
});

/** WS 实时通道 → Durable Object（token 鉴权后转发）。 */
app.get("/api/sync/ws", async (c) => {
  // Token via Sec-WebSocket-Protocol header（避免 query string 泄露到代理日志）
  const protocols = c.req.header("sec-websocket-protocol");
  if (!protocols) return c.json({ error: "token required" }, 401);
  const token = protocols.split(",")[0]!.trim();
  const row = await c.env.DB.prepare(
    `SELECT user_id FROM devices WHERE device_token = ? AND revoked_at IS NULL`,
  )
    .bind(token)
    .first<{ user_id: string }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);
  const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(row.user_id));
  const url = new URL(c.req.url);
  return stub.fetch(new Request(`https://do/ws${url.search}`, c.req.raw));
});

/** 清理旧的同步变更记录（防止 sync_changes 无限增长，客户端同步后可调用）。 */
app.delete("/api/sync/changes", async (c) => {
  const userId = c.get("userId");
  const before = Number(c.req.query("before") ?? "0");
  if (!before) return c.json({ error: "before cursor required" }, 400);
  const res = await c.env.DB.prepare(
    `DELETE FROM sync_changes WHERE user_id = ? AND seq <= ?`,
  ).bind(userId, before).run();
  return c.json({ ok: true, deleted: res.meta?.changes ?? 0 });
});

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENV }));

// ---------- 配对会话（方案 §4.4：KV，TTL 5 分钟，10 次尝试上限） ----------
// 云端只是信箱：存储 SPAKE2 公开消息与 MAC，无任何可解密材料。

interface PairingSession {
  messages: Array<{ from: string; type: string; body: string }>;
  attempts: number;
  createdAt: number;
}

const PAIRING_TTL_SECONDS = 300;
const PAIRING_MAX_ATTEMPTS = 10;

app.post("/api/pairing/session", async (c) => {
  const body = await c.req.json<{
    code: string;
    message: { from: string; type: string; body: string };
  }>();
  if (!body.code || !/^\d{6}$/.test(body.code) || !body.message) {
    return c.json({ error: "valid 6-digit code and message required" }, 400);
  }
  const key = `pairing:${body.code}`;
  const existing = await c.env.SESSIONS.get(key);
  if (existing) return c.json({ error: "code already in use" }, 409);
  const session: PairingSession = {
    messages: [body.message],
    attempts: 0,
    createdAt: Date.now(),
  };
  await c.env.SESSIONS.put(key, JSON.stringify(session), {
    expirationTtl: PAIRING_TTL_SECONDS,
  });
  return c.json({ ok: true, ttl: PAIRING_TTL_SECONDS });
});

app.get("/api/pairing/session/:code", async (c) => {
  const raw = await c.env.SESSIONS.get(`pairing:${c.req.param("code")}`);
  if (!raw) return c.json({ error: "session expired or not found" }, 404);
  const session = JSON.parse(raw) as PairingSession;
  return c.json({ messages: session.messages });
});

app.post("/api/pairing/session/:code/message", async (c) => {
  const body = await c.req.json<{ from: string; type: string; body: string }>();
  const key = `pairing:${c.req.param("code")}`;
  const raw = await c.env.SESSIONS.get(key);
  if (!raw) return c.json({ error: "session expired or not found" }, 404);
  const session = JSON.parse(raw) as PairingSession;
  session.attempts++;
  if (session.attempts > PAIRING_MAX_ATTEMPTS) {
    // 速率限制：超限即销毁会话（方案 §4.4 在线猜测防线）
    await c.env.SESSIONS.delete(key);
    return c.json({ error: "too many attempts, session destroyed" }, 429);
  }
  session.messages.push({ from: body.from, type: body.type, body: body.body });
  await c.env.SESSIONS.put(key, JSON.stringify(session), {
    expirationTtl: PAIRING_TTL_SECONDS,
  });
  return c.json({ ok: true });
});

export default app;
