import { AppError } from '../errors/AppError';

/**
 * Shared query plumbing for the reporting suite.
 *
 * Three things every report needs and must agree on:
 *
 * 1. **The window.** A caller may pass an explicit `dateFrom`/`dateTo` or a
 *    named `preset`. Both resolve to the same half-open range so a bill
 *    written at 23:59 lands in the day it was rung up and no bill is counted
 *    twice at a boundary.
 *
 * 2. **Index-friendly date predicates.** `WHERE DATE(created_at) BETWEEN ? AND ?`
 *    wraps the column in a function, so MySQL cannot use `idx_bills_created`
 *    and every report degrades to a full scan as the bill table grows. The
 *    predicates built here are always `created_at >= ? AND created_at < ?`.
 *
 * 3. **What counts as a sale.** Voided bills stay in the table for audit, so
 *    every sales and finance report excludes them unless the caller explicitly
 *    asks for them back with `includeVoided`.
 */

export type Granularity = 'day' | 'week' | 'month';

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'last90',
  'thisWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'custom',
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

export interface ReportRange {
  /** Inclusive first day, `YYYY-MM-DD`. */
  dateFrom: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  dateTo: string;
  /** Inclusive lower bound for SQL, `YYYY-MM-DD 00:00:00`. */
  startAt: string;
  /** Exclusive upper bound for SQL: midnight starting the day after `dateTo`. */
  endAt: string;
  /** Number of whole days covered, used to size the comparison window. */
  days: number;
  preset: DatePreset;
}

export interface BillScope {
  paymentMethod?: string;
  orderType?: string;
  cashierId?: number;
  customerId?: number;
  /** Include voided bills. Off by default — a void is not revenue. */
  includeVoided?: boolean;
}

export interface WhereClause {
  where: string;
  params: any[];
}

export interface Bucket {
  /** Expression producing the period label, e.g. `2026-09` for a month. */
  label: string;
  /** Expression producing the period's first date, used for ORDER BY. */
  start: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ReportQuery {
  /** Resolves `dateFrom`/`dateTo`/`preset` into one canonical window. */
  static range(input: { dateFrom?: unknown; dateTo?: unknown; preset?: unknown }): ReportRange {
    const preset = this.preset(input.preset);
    const explicitFrom = this.dateOnly(input.dateFrom, 'dateFrom');
    const explicitTo = this.dateOnly(input.dateTo, 'dateTo');

    // An explicit range always wins; `preset` is the fallback for callers that
    // only want "this month" without computing the dates client-side.
    if (explicitFrom || explicitTo) {
      const from = explicitFrom ?? explicitTo!;
      const to = explicitTo ?? explicitFrom!;
      return this.build(from, to, 'custom');
    }

    const today = this.startOfToday();
    switch (preset) {
      case 'today':
        return this.build(this.fmt(today), this.fmt(today), preset);
      case 'yesterday': {
        const y = this.addDays(today, -1);
        return this.build(this.fmt(y), this.fmt(y), preset);
      }
      case 'last7':
        return this.build(this.fmt(this.addDays(today, -6)), this.fmt(today), preset);
      case 'last90':
        return this.build(this.fmt(this.addDays(today, -89)), this.fmt(today), preset);
      case 'thisWeek': {
        // Week starts Monday, matching MySQL WEEKDAY() and the ISO week used
        // by the `week` granularity bucket.
        const start = this.addDays(today, -((today.getDay() + 6) % 7));
        return this.build(this.fmt(start), this.fmt(today), preset);
      }
      case 'thisMonth': {
        const start = new Date(today.getFullYear(), today.getMonth(), 1);
        return this.build(this.fmt(start), this.fmt(today), preset);
      }
      case 'lastMonth': {
        const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const end = new Date(today.getFullYear(), today.getMonth(), 0);
        return this.build(this.fmt(start), this.fmt(end), preset);
      }
      case 'thisYear': {
        const start = new Date(today.getFullYear(), 0, 1);
        return this.build(this.fmt(start), this.fmt(today), preset);
      }
      case 'last30':
      default:
        return this.build(this.fmt(this.addDays(today, -29)), this.fmt(today), 'last30');
    }
  }

  /**
   * The equally long window immediately before `range`, for period-on-period
   * deltas. A 30-day window compares against the 30 days before it, so the
   * comparison is never distorted by unequal-length periods.
   */
  static previousRange(range: ReportRange): ReportRange {
    const from = this.parse(range.dateFrom);
    const prevTo = this.addDays(from, -1);
    const prevFrom = this.addDays(prevTo, -(range.days - 1));
    return this.build(this.fmt(prevFrom), this.fmt(prevTo), 'custom');
  }

  /** Validated period granularity; anything unrecognised falls back to `day`. */
  static granularity(value: unknown, fallback: Granularity = 'day'): Granularity {
    if (value === 'day' || value === 'week' || value === 'month') return value;
    return fallback;
  }

  /**
   * SQL expressions that bucket `<alias>.<column>` by granularity.
   *
   * `%x-W%v` is the ISO year/week pair — using `%Y` here would mis-label the
   * days of week 1 that fall in the previous calendar year.
   */
  static bucket(alias: string, granularity: Granularity, column = 'created_at'): Bucket {
    const col = `${alias}.${column}`;
    switch (granularity) {
      case 'month':
        return {
          label: `DATE_FORMAT(${col}, '%Y-%m')`,
          start: `DATE_FORMAT(${col}, '%Y-%m-01')`,
        };
      case 'week':
        return {
          label: `DATE_FORMAT(${col}, '%x-W%v')`,
          start: `DATE(DATE_SUB(${col}, INTERVAL WEEKDAY(${col}) DAY))`,
        };
      case 'day':
      default:
        return {
          label: `DATE_FORMAT(${col}, '%Y-%m-%d')`,
          start: `DATE(${col})`,
        };
    }
  }

  /**
   * `WHERE` fragment scoping a bills query to the range and the caller filters.
   * `alias` and `column` are module constants, never request input.
   */
  static bills(alias: string, range: ReportRange, scope: BillScope = {}, column = 'created_at'): WhereClause {
    const params: any[] = [range.startAt, range.endAt];
    let where = `WHERE ${alias}.${column} >= ? AND ${alias}.${column} < ?`;

    // A withdrawn invoice is out of the books entirely, so unlike a void it is
    // excluded unconditionally — `includeVoided` does not bring it back.
    where += ` AND ${alias}.is_deleted = 0`;

    if (!scope.includeVoided) {
      where += ` AND ${alias}.is_voided = 0`;
    }
    if (scope.paymentMethod) {
      where += ` AND ${alias}.payment_method = ?`;
      params.push(scope.paymentMethod);
    }
    if (scope.orderType) {
      where += ` AND ${alias}.order_type = ?`;
      params.push(scope.orderType);
    }
    if (scope.cashierId) {
      where += ` AND ${alias}.cashier_id = ?`;
      params.push(scope.cashierId);
    }
    if (scope.customerId) {
      where += ` AND ${alias}.customer_id = ?`;
      params.push(scope.customerId);
    }

    return { where, params };
  }

  /** Plain date-range `WHERE` for tables without bill semantics. */
  static dateRange(alias: string, range: ReportRange, column = 'created_at'): WhereClause {
    return {
      where: `WHERE ${alias}.${column} >= ? AND ${alias}.${column} < ?`,
      params: [range.startAt, range.endAt],
    };
  }

  /** Percentage change from `previous` to `current`, rounded to 2dp. */
  static growth(current: number, previous: number): number {
    if (!previous) return current > 0 ? 100 : 0;
    return this.round(((current - previous) / Math.abs(previous)) * 100);
  }

  /** `SUM()` and `AVG()` come back from mysql2 as strings on DECIMAL columns. */
  static num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Coerces the named columns of every row to numbers.
   *
   * mysql2 returns DECIMAL and SUM()/AVG() results as strings, so a report
   * handed straight to JSON emits `"total": "1240.50"` and the client's
   * arithmetic silently concatenates. Every aggregate row goes through this.
   */
  static numbers<T extends Record<string, any>>(rows: T[], fields: string[]): T[] {
    return rows.map((row) => {
      const copy: Record<string, any> = { ...row };
      for (const field of fields) {
        if (field in copy) copy[field] = this.round(this.num(copy[field]));
      }
      return copy as T;
    });
  }

  static round(value: number, dp = 2): number {
    const factor = 10 ** dp;
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  /** Share of `total` taken by `part`, as a rounded percentage. */
  static share(part: number, total: number): number {
    if (!total) return 0;
    return this.round((part / total) * 100);
  }

  private static preset(value: unknown): DatePreset {
    if (typeof value !== 'string' || value.trim() === '') return 'last30';
    const trimmed = value.trim();
    if ((DATE_PRESETS as readonly string[]).includes(trimmed)) return trimmed as DatePreset;
    throw AppError.badRequest(
      `Invalid preset "${trimmed}". Expected one of: ${DATE_PRESETS.join(', ')}.`,
      'INVALID_PARAMETER'
    );
  }

  /** Accepts `YYYY-MM-DD` or any ISO timestamp, of which only the date is kept. */
  private static dateOnly(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
      throw AppError.badRequest(`Invalid ${field}: expected a YYYY-MM-DD date.`, 'INVALID_PARAMETER');
    }
    const candidate = value.trim().slice(0, 10);
    if (!DATE_ONLY.test(candidate)) {
      throw AppError.badRequest(`Invalid ${field}: expected a YYYY-MM-DD date.`, 'INVALID_PARAMETER');
    }
    const parsed = new Date(`${candidate}T00:00:00`);
    if (Number.isNaN(parsed.getTime()) || this.fmt(parsed) !== candidate) {
      throw AppError.badRequest(`Invalid ${field}: "${candidate}" is not a real date.`, 'INVALID_PARAMETER');
    }
    return candidate;
  }

  private static build(dateFrom: string, dateTo: string, preset: DatePreset): ReportRange {
    // A reversed range is a client mistake that would otherwise return an
    // empty report and look like "no sales" rather than a bad request.
    let from = dateFrom;
    let to = dateTo;
    if (from > to) {
      [from, to] = [to, from];
    }

    const endExclusive = this.addDays(this.parse(to), 1);
    const days = Math.round((this.parse(to).getTime() - this.parse(from).getTime()) / 86_400_000) + 1;

    return {
      dateFrom: from,
      dateTo: to,
      startAt: `${from} 00:00:00`,
      endAt: `${this.fmt(endExclusive)} 00:00:00`,
      days,
      preset,
    };
  }

  private static startOfToday(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  private static parse(date: string): Date {
    return new Date(`${date}T00:00:00`);
  }

  private static addDays(date: Date, days: number): Date {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  private static fmt(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
