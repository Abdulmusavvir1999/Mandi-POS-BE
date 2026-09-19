import { dbService } from '../../database/db';

/**
 * Daily document numbers (`ORD-YYYYMMDD-0001`, `INV-YYYYMMDD-0001`).
 *
 * The sequence is taken from the highest number already issued for the day
 * rather than from a count of the day's rows. The two agree exactly as long as
 * no row is ever removed, which is why counting was fine until the Back-Office
 * gained the ability to delete orders and invoices: with a gap in the middle of
 * the day, a count re-issues a number that is still on another record, and the
 * UNIQUE constraint rejects the next sale outright.
 *
 * Matching on the number's own date prefix rather than on `DATE(created_at)`
 * also keeps the lookup and the string being generated on the same calendar
 * day, which a count against `CURDATE()` could not guarantee on a server whose
 * local date differs from UTC.
 */
export class SequenceUtil {
  /** UTC date stamp used inside the generated number. */
  static dateStamp(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  /**
   * Next unused number for today, e.g. `nextDailyNumber('orders',
   * 'order_number', 'ORD')`. `table` and `column` are interpolated, so they
   * must stay internal literals and never come from a request.
   */
  static async nextDailyNumber(table: string, column: string, prefix: string): Promise<string> {
    const stamp = this.dateStamp();

    const row = await dbService.queryOne<{ max_seq: number | null }>(
      `SELECT MAX(CAST(SUBSTRING_INDEX(${column}, '-', -1) AS UNSIGNED)) AS max_seq
       FROM ${table}
       WHERE ${column} LIKE ?`,
      [`${prefix}-${stamp}-%`]
    );

    const next = (Number(row?.max_seq) || 0) + 1;
    return `${prefix}-${stamp}-${String(next).padStart(4, '0')}`;
  }
}
