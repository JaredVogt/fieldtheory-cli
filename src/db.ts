import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface QueryResult {
  columns: string[];
  values: unknown[][];
}

type BindParams = unknown[] | Record<string, unknown> | undefined;

export interface Statement {
  run(params?: BindParams): unknown;
  get(params?: BindParams): Record<string, unknown> | undefined;
  all(params?: BindParams): Record<string, unknown>[];
  free(): void;
}

export interface Database {
  exec(sql: string, params?: BindParams): QueryResult[];
  run(sql: string, params?: BindParams): unknown;
  prepare(sql: string): Statement;
  pragma(statement: string): unknown;
  close(): void;
}

function bindMethod<T>(method: (...args: any[]) => T, context: unknown, params?: BindParams): T {
  if (params == null) return method.call(context);
  if (Array.isArray(params)) return method.call(context, ...params);
  return method.call(context, params);
}

class BetterStatement implements Statement {
  constructor(private readonly statement: BetterSqlite3.Statement) {}

  run(params?: BindParams): unknown {
    return bindMethod(this.statement.run, this.statement, params);
  }

  get(params?: BindParams): Record<string, unknown> | undefined {
    return bindMethod(this.statement.get, this.statement, params) as unknown as Record<string, unknown> | undefined;
  }

  all(params?: BindParams): Record<string, unknown>[] {
    return bindMethod(this.statement.all, this.statement, params) as unknown as Record<string, unknown>[];
  }

  free(): void {
    // better-sqlite3 statements do not need explicit disposal
  }
}

class BetterDatabase implements Database {
  constructor(private readonly inner: BetterSqlite3.Database) {}

  exec(sql: string, params?: BindParams): QueryResult[] {
    const trimmed = sql.trim().toUpperCase();
    const isQuery =
      trimmed.startsWith('SELECT') ||
      trimmed.startsWith('WITH') ||
      trimmed.startsWith('PRAGMA') ||
      trimmed.startsWith('EXPLAIN');

    if (!isQuery) {
      this.run(sql, params);
      return [];
    }

    const statement = this.inner.prepare(sql);
    const rows = bindMethod(statement.all, statement, params) as unknown as Record<string, unknown>[];
    if (rows.length === 0) return [];

    const columns = Object.keys(rows[0]);
    return [
      {
        columns,
        values: rows.map((row) => columns.map((column) => row[column])),
      },
    ];
  }

  run(sql: string, params?: BindParams): unknown {
    const statement = this.inner.prepare(sql);
    return bindMethod(statement.run, statement, params);
  }

  prepare(sql: string): Statement {
    return new BetterStatement(this.inner.prepare(sql));
  }

  pragma(statement: string): unknown {
    return this.inner.pragma(statement);
  }

  close(): void {
    this.inner.close();
  }
}

export async function openDb(filePath: string): Promise<Database> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const inner = new BetterSqlite3(filePath);
  inner.pragma('journal_mode = WAL');
  inner.pragma('foreign_keys = ON');
  inner.pragma('busy_timeout = 5000');
  return new BetterDatabase(inner);
}

export async function createDb(filePath = ':memory:'): Promise<Database> {
  const inner = new BetterSqlite3(filePath);
  inner.pragma('journal_mode = WAL');
  inner.pragma('foreign_keys = ON');
  inner.pragma('busy_timeout = 5000');
  return new BetterDatabase(inner);
}

export function saveDb(_db: Database, _filePath: string): void {
  // Real SQLite persists each write; callers can keep invoking this as a no-op.
}
