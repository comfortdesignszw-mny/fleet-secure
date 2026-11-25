import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { D1DatabaseLike, D1ExecResult, D1PreparedStatementLike, D1ResultMeta } from './types';

class LocalPreparedStatement implements D1PreparedStatementLike {
  private db: DatabaseSync;
  private sql: string;
  private params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    const normalized = values.map((v) => (v === undefined ? null : v));
    return new LocalPreparedStatement(this.db, this.sql, normalized);
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as (string | number | bigint | Uint8Array | null)[])) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] ?? null) as T | null;
    }
    return { ...row } as T;
  }

  async run(): Promise<{ success: boolean; meta: D1ResultMeta }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...(this.params as (string | number | bigint | Uint8Array | null)[]));
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.params as (string | number | bigint | Uint8Array | null)[])) as Record<
      string,
      unknown
    >[];
    return {
      success: true,
      results: rows.map((r) => ({ ...r }) as T),
    };
  }
}

export class LocalD1Adapter implements D1DatabaseLike {
  public readonly raw: DatabaseSync;

  constructor(dbPath: string, schemaSql?: string) {
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    if (schemaSql) {
      this.raw.exec(schemaSql);
    }
  }

  prepare(query: string): D1PreparedStatementLike {
    return new LocalPreparedStatement(this.raw, query);
  }

  async exec(query: string): Promise<D1ExecResult> {
    const start = Date.now();
    this.raw.exec(query);
    return {
      count: 1,
      duration: Date.now() - start,
    };
  }

  async batch<T = unknown>(
    statements: D1PreparedStatementLike[]
  ): Promise<Array<{ success: boolean; results?: T[]; meta?: D1ResultMeta }>> {
    const results: Array<{ success: boolean; results?: T[]; meta?: D1ResultMeta }> = [];
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      for (const stmt of statements) {
        const res = await stmt.run();
        results.push({ success: res.success, meta: res.meta });
      }
      this.raw.exec('COMMIT');
      return results;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // Ignore rollback error
      }
      throw err;
    }
  }
}

export function createLocalDatabase(dbFilePath = path.resolve(process.cwd(), 'fleet_secure.db')): LocalD1Adapter {
  const schemaPath = path.resolve(process.cwd(), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  return new LocalD1Adapter(dbFilePath, schemaSql);
}
