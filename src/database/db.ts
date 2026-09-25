import { AsyncLocalStorage } from 'async_hooks';
import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../errors/AppError';

/**
 * MySQL/MariaDB data layer.
 *
 * The API surface intentionally mirrors the previous sql.js service
 * (query / queryOne / execute / transaction) so call sites only had to gain
 * `await`. Every method is async because mysql2 has no synchronous driver.
 *
 * `transaction()` pins a single pooled connection for the duration of the
 * callback via AsyncLocalStorage, so any nested query/execute inside the
 * callback automatically runs on that same connection — and therefore inside
 * the same transaction — without having to thread a connection argument
 * through every service method.
 */
class DatabaseService {
  private pool: Pool | null = null;
  private readonly txStorage = new AsyncLocalStorage<PoolConnection>();

  public async initialize(): Promise<void> {
    if (this.pool) return;

    this.pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.poolMax,
      queueLimit: 0,
      dateStrings: true,
      multipleStatements: false,
    });

    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version, DATABASE() AS db');
      logger.info(
        `Connected to MySQL ${rows[0]?.version} at ${config.db.host}:${config.db.port}, database "${rows[0]?.db}"`
      );
    } finally {
      conn.release();
    }
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  /** Inside transaction() this is the pinned connection; otherwise the pool. */
  private getExecutor(): Pool | PoolConnection {
    return this.txStorage.getStore() ?? this.getPool();
  }

  /**
   * mysql2 rejects `undefined`; COALESCE-style partial updates mean NULL.
   *
   * NaN and Infinity are rejected outright. mysql2 renders them into SQL as the
   * bare words `NaN` / `Infinity`, which the server parses as column names — the
   * query then fails with ER_BAD_FIELD_ERROR, a non-AppError that surfaced to
   * users as an opaque "Internal server error occurred" 500. Callers sanitise
   * input at the controller boundary (see ParamUtil); this is the backstop for
   * a NaN computed further in, and it names the offending slot so the cause is
   * obvious in the log instead of being a mystery 500.
   */
  private normalizeParams(params: any[]): any[] {
    return params.map((p, i) => {
      if (p === undefined) return null;
      if (typeof p === 'number' && !Number.isFinite(p)) {
        throw AppError.badRequest(
          `Invalid numeric value supplied for query parameter #${i + 1}.`,
          'INVALID_PARAMETER'
        );
      }
      return p;
    });
  }

  public async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const [rows] = await this.getExecutor().query<RowDataPacket[]>(sql, this.normalizeParams(params));
    return rows as unknown as T[];
  }

  public async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /** INSERT / UPDATE / DELETE, or null for anything else (DDL, SET, ...). */
  private writeOperation(sql: string): 'INSERT' | 'UPDATE' | 'DELETE' | null {
    const head = sql.trim().slice(0, 12).toUpperCase();
    if (head.startsWith('INSERT')) return 'INSERT';
    if (head.startsWith('UPDATE')) return 'UPDATE';
    if (head.startsWith('DELETE')) return 'DELETE';
    return null;
  }

  private tableOf(sql: string, op: string): string {
    const patterns: Record<string, RegExp> = {
      INSERT: /INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?/i,
      UPDATE: /UPDATE\s+`?(\w+)`?/i,
      DELETE: /DELETE\s+FROM\s+`?(\w+)`?/i,
    };
    return sql.match(patterns[op])?.[1] ?? 'unknown';
  }

  public async execute(sql: string, params: any[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    const [result] = await this.getExecutor().query<ResultSetHeader>(sql, this.normalizeParams(params));
    const outcome = {
      changes: result.affectedRows ?? 0,
      lastInsertRowid: result.insertId ?? 0,
    };

    // Development-only trace of every write. Parameter values are deliberately
    // not logged — they can carry password hashes and other credentials.
    if (config.nodeEnv !== 'production') {
      const op = this.writeOperation(sql);
      if (op) {
        const table = this.tableOf(sql, op);
        const inTx = this.txStorage.getStore() ? ' (in transaction)' : '';
        const id = op === 'INSERT' && outcome.lastInsertRowid ? `, id=${outcome.lastInsertRowid}` : '';
        console.log(`  [DB ${op}] table=${table}, rows=${outcome.changes}${id}${inTx}`);
      }
    }

    return outcome;
  }

  public async executeBatch(sqlBatch: string): Promise<void> {
    const statements = sqlBatch
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await this.execute(statement);
    }
  }

  public async transaction<T>(callback: () => T | Promise<T>): Promise<T> {
    // Already inside a transaction: join it rather than opening a nested one.
    const existing = this.txStorage.getStore();
    if (existing) {
      return await callback();
    }

    const conn = await this.getPool().getConnection();
    await conn.beginTransaction();
    try {
      const result = await this.txStorage.run(conn, async () => await callback());
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const dbService = new DatabaseService();
