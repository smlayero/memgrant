/**
 * 本地缓存（方案 §6.1 cache/）。
 *
 * - SQLite（sql.js WASM，无原生依赖）存明文缓存 + 离线队列 + 同步游标
 * - 明文只在本地：云端不可用时下线兜底读取（验收 R1）
 * - 向量检索：Embedder 可插拔（内置 hash fallback，bge-m3 ONNX 按同接口替换）；
 *   检索全部本地完成，向量不上云（方案 §3.3）
 */
import initSqlJs, { type Database } from "sql.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  bytesToFloat32,
  cosineSimilarity,
  float32ToBytes,
} from "../judge/embedder.js";

export interface LocalMemory {
  memoryId: string;
  plaintext: string;
  type: string;
  tags: string[];
  permissionLevel: number;
  importance: number;
  sourceAgent: string | null;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface OutboxItem {
  id: number;
  op: "create" | "update" | "delete";
  memoryId: string;
  /** 待上送的密文载荷（JSON） */
  payload: string;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  plaintext TEXT NOT NULL,
  type TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  permission_level INTEGER NOT NULL DEFAULT 2,
  importance REAL NOT NULL DEFAULT 0.5,
  source_agent TEXT,
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type, deleted);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL,
  op TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  dead_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class LocalStore {
  private constructor(
    private db: Database,
    private readonly filePath: string | null,
  ) {}

  static async open(filePath?: string): Promise<LocalStore> {
    const SQL = await initSqlJs();
    let db: Database;
    if (filePath) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        const raw = await fs.readFile(filePath);
        db = new SQL.Database(raw);
      } catch {
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }
    db.exec(SCHEMA);
    // 旧库迁移：补 embedding 列（已存在则忽略）
    try {
      db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB`);
    } catch {
      /* column exists */
    }
    return new LocalStore(db, filePath ?? null);
  }

  async persist(): Promise<void> {
    if (!this.filePath) return;
    const data = this.db.export();
    await fs.writeFile(this.filePath, Buffer.from(data));
  }

  close(): void {
    this.db.close();
  }

  putMemory(m: LocalMemory, embedding?: Float32Array): void {
    this.db.run(
      `INSERT INTO memories (memory_id, plaintext, type, tags, permission_level, importance, source_agent, embedding, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         plaintext = excluded.plaintext,
         type = excluded.type,
         tags = excluded.tags,
         permission_level = excluded.permission_level,
         importance = excluded.importance,
         embedding = COALESCE(excluded.embedding, memories.embedding),
         updated_at = excluded.updated_at,
         deleted = excluded.deleted`,
      [
        m.memoryId,
        m.plaintext,
        m.type,
        JSON.stringify(m.tags),
        m.permissionLevel,
        m.importance,
        m.sourceAgent,
        embedding ? float32ToBytes(embedding) : null,
        m.createdAt,
        m.updatedAt,
        m.deleted ? 1 : 0,
      ],
    );
  }

  setEmbedding(memoryId: string, embedding: Float32Array): void {
    this.db.run(`UPDATE memories SET embedding = ? WHERE memory_id = ?`, [
      float32ToBytes(embedding),
      memoryId,
    ]);
  }

  getMemory(memoryId: string): LocalMemory | null {
    const res = this.db.exec(
      `SELECT memory_id, plaintext, type, tags, permission_level, importance, source_agent, created_at, updated_at, deleted
       FROM memories WHERE memory_id = ?`,
      [memoryId],
    );
    const row = res[0]?.values[0];
    if (!row) return null;
    return this.rowToMemory(row);
  }

  markDeleted(memoryId: string, updatedAt: string): void {
    this.db.run(
      `UPDATE memories SET deleted = 1, updated_at = ? WHERE memory_id = ?`,
      [updatedAt, memoryId],
    );
  }

  /** 关键词检索（精确/子串匹配通道）。 */
  searchMemories(query: string, limit = 10): LocalMemory[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const res = this.db.exec(
      `SELECT memory_id, plaintext, type, tags, permission_level, importance, source_agent, created_at, updated_at, deleted
       FROM memories
       WHERE deleted = 0 AND plaintext LIKE ?
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
      [like, limit],
    );
    return (res[0]?.values ?? []).map((row) => this.rowToMemory(row));
  }

  /** 向量检索：全表余弦（10 万条级本地扫描毫秒级；后续可换 ANN 索引）。 */
  searchByVector(query: Float32Array, limit = 10): Array<{ memory: LocalMemory; score: number }> {
    const res = this.db.exec(
      `SELECT memory_id, plaintext, type, tags, permission_level, importance, source_agent, created_at, updated_at, deleted, embedding
       FROM memories WHERE deleted = 0 AND embedding IS NOT NULL`,
    );
    const scored: Array<{ memory: LocalMemory; score: number }> = [];
    for (const row of res[0]?.values ?? []) {
      const emb = row[10] as Uint8Array | null;
      if (!emb) continue;
      const score = cosineSimilarity(query, bytesToFloat32(emb));
      scored.push({ memory: this.rowToMemory(row), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * 混合检索：关键词通道 + 向量通道按分数归一合并。
   * 关键词命中权重更高（精确信号），向量补足语义/近义召回。
   */
  searchHybrid(
    queryText: string,
    queryVector: Float32Array | null,
    limit = 10,
  ): Array<{ memory: LocalMemory; score: number }> {
    const merged = new Map<string, { memory: LocalMemory; score: number }>();
    for (const m of this.searchMemories(queryText, limit * 2)) {
      merged.set(m.memoryId, { memory: m, score: 0.6 + 0.4 * m.importance });
    }
    if (queryVector) {
      for (const hit of this.searchByVector(queryVector, limit * 2)) {
        const existing = merged.get(hit.memory.memoryId);
        const vecScore = 0.7 * Math.max(hit.score, 0);
        if (existing) {
          existing.score += vecScore;
        } else {
          merged.set(hit.memory.memoryId, { memory: hit.memory, score: vecScore });
        }
      }
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  listMemories(limit = 1000, offset = 0): LocalMemory[] {
    const res = this.db.exec(
      `SELECT memory_id, plaintext, type, tags, permission_level, importance, source_agent, created_at, updated_at, deleted
       FROM memories WHERE deleted = 0
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return (res[0]?.values ?? []).map((row) => this.rowToMemory(row));
  }

  countMemories(): number {
    const res = this.db.exec(`SELECT COUNT(*) FROM memories WHERE deleted = 0`);
    return Number(res[0]?.values[0]?.[0] ?? 0);
  }

  // —— 离线队列（方案 §五：指数退避重试 5 次，基础 5s） ——

  enqueue(op: OutboxItem["op"], memoryId: string, payload: string): void {
    this.db.run(
      `INSERT INTO outbox (op, memory_id, payload, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
      [op, memoryId, payload, Date.now()],
    );
  }

  dueOutbox(now = Date.now(), limit = 50): OutboxItem[] {
    const res = this.db.exec(
      `SELECT id, op, memory_id, payload, attempts, next_retry_at, created_at
       FROM outbox WHERE next_retry_at <= ? ORDER BY id LIMIT ?`,
      [now, limit],
    );
    return (res[0]?.values ?? []).map((row) => ({
      id: Number(row[0]),
      op: row[1] as OutboxItem["op"],
      memoryId: String(row[2]),
      payload: String(row[3]),
      attempts: Number(row[4]),
      nextRetryAt: Number(row[5]),
      createdAt: Number(row[6]),
    }));
  }

  removeOutbox(id: number): void {
    this.db.run(`DELETE FROM outbox WHERE id = ?`, [id]);
  }

  /** 将多次重试失败的条目移入死信表保留（不删除，可手动重放）。 */
  moveToDeadLetter(item: OutboxItem, finalAttempts: number): void {
    this.db.run(
      `INSERT INTO dead_letter (outbox_id, op, memory_id, payload, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [item.id, item.op, item.memoryId, item.payload, finalAttempts, item.createdAt],
    );
    this.db.run(`DELETE FROM outbox WHERE id = ?`, [item.id]);
  }

  listDeadLetters(limit = 100): Array<{ id: number; op: string; memoryId: string; payload: string; attempts: number; createdAt: number }> {
    const res = this.db.exec(
      `SELECT id, op, memory_id, payload, attempts, created_at
       FROM dead_letter ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    return (res[0]?.values ?? []).map((row) => ({
      id: Number(row[0]),
      op: String(row[1]),
      memoryId: String(row[2]),
      payload: String(row[3]),
      attempts: Number(row[4]),
      createdAt: Number(row[5]),
    }));
  }

  replayDeadLetter(id: number): void {
    const res = this.db.exec(
      `SELECT op, memory_id, payload, created_at FROM dead_letter WHERE id = ?`,
      [id],
    );
    const row = res[0]?.values[0];
    if (!row) return;
    this.db.run(
      `INSERT INTO outbox (op, memory_id, payload, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
      [row[0], row[1], row[2], row[3]],
    );
    this.db.run(`DELETE FROM dead_letter WHERE id = ?`, [id]);
  }

  deadLetterCount(): number {
    const res = this.db.exec(`SELECT COUNT(*) FROM dead_letter`);
    return Number(res[0]?.values[0]?.[0] ?? 0);
  }

  /** 指数退避：5s 起步 ×2^(attempts-1)，5 次后移入死信（由调用方触发）。 */
  scheduleRetry(id: number, attempts: number): void {
    const delayMs = Math.min(5000 * 2 ** (attempts - 1), 5 * 60 * 1000);
    this.db.run(
      `UPDATE outbox SET attempts = ?, next_retry_at = ? WHERE id = ?`,
      [attempts, Date.now() + delayMs, id],
    );
  }

  /** 立即重试（用户手动触发 / 测试用）：将重试时间清零。 */
  makeOutboxDue(id: number): void {
    this.db.run(`UPDATE outbox SET next_retry_at = 0 WHERE id = ?`, [id]);
  }

  outboxSize(): number {
    const res = this.db.exec(`SELECT COUNT(*) FROM outbox`);
    return Number(res[0]?.values[0]?.[0] ?? 0);
  }

  // —— 同步游标 ——

  getCursor(): string | null {
    const res = this.db.exec(`SELECT value FROM sync_state WHERE key = 'cursor'`);
    const v = res[0]?.values[0]?.[0];
    return v === undefined ? null : String(v);
  }

  setCursor(cursor: string): void {
    this.db.run(
      `INSERT INTO sync_state (key, value) VALUES ('cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [cursor],
    );
  }

  private rowToMemory(row: unknown[]): LocalMemory {
    return {
      memoryId: String(row[0]),
      plaintext: String(row[1]),
      type: String(row[2]),
      tags: JSON.parse(String(row[3])) as string[],
      permissionLevel: Number(row[4]),
      importance: Number(row[5]),
      sourceAgent: row[6] === null ? null : String(row[6]),
      createdAt: String(row[7]),
      updatedAt: String(row[8]),
      deleted: Number(row[9]) === 1,
    };
  }
}
