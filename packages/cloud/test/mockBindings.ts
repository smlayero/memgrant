/**
 * 测试用 Cloudflare 绑定 mock（D1/R2/KV/Durable Object）。
 * D1 用 sql.js（SQLite WASM）模拟，R2/KV/DO 用内存 Map 模拟。
 */
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- D1 mock ----------

class MockPreparedStatement {
  private params: SqlValue[] = [];

  constructor(private db: Database, private sql: string) {}

  bind(...values: unknown[]): this {
    this.params = values as SqlValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(this.params);
    let result: T | null = null;
    if (stmt.step()) {
      result = stmt.getAsObject() as unknown as T;
    }
    stmt.free();
    return result;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean }> {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(this.params);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as T);
    }
    stmt.free();
    return { results, success: true };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    this.db.run(this.sql, this.params);
    return { success: true, meta: { changes: this.db.getRowsModified() } };
  }
}

class MockD1 {
  constructor(private db: Database) {}

  prepare(sql: string): MockPreparedStatement {
    return new MockPreparedStatement(this.db, sql);
  }

  async batch(stmts: MockPreparedStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const stmt of stmts) {
      results.push(await stmt.run());
    }
    return results;
  }

  async exec(sql: string): Promise<unknown> {
    this.db.run(sql);
    return { success: true };
  }
}

// ---------- R2 mock ----------

class MockR2 {
  private store = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<void> {
    if (value instanceof Uint8Array) {
      this.store.set(key, value);
    } else if (value instanceof ArrayBuffer) {
      this.store.set(key, new Uint8Array(value));
    } else {
      this.store.set(key, new TextEncoder().encode(value));
    }
  }

  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const val = this.store.get(key);
    if (!val) return null;
    return {
      arrayBuffer: async () => val.buffer.slice(0),
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ---------- KV mock ----------

class MockKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ---------- Durable Object mock ----------

class MockDOStub {
  async fetch(_request: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    return new Response("ok");
  }
}

class MockDONamespace {
  private stub = new MockDOStub();

  idFromName(name: string): string {
    return name;
  }

  get(_id: string): MockDOStub {
    return this.stub;
  }
}

// ---------- 创建 mock env ----------

export async function createMockEnv(): Promise<{
  DB: MockD1;
  VAULT: MockR2;
  SESSIONS: MockKV;
  SYNC_HUB: MockDONamespace;
  ENV: string;
}> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const schemaPath = resolve(__dirname, "..", "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");
  db.run(schemaSql);

  return {
    DB: new MockD1(db),
    VAULT: new MockR2(),
    SESSIONS: new MockKV(),
    SYNC_HUB: new MockDONamespace(),
    ENV: "test",
  };
}
