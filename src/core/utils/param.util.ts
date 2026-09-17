import { AppError } from '../errors/AppError';

/**
 * Request parameter coercion.
 *
 * `parseInt('abc', 10)` yields NaN, and mysql2 renders NaN into SQL as the bare
 * word `NaN`, which the server reads as a column name — the query dies with
 * ER_BAD_FIELD_ERROR, which is not an AppError, so the global handler turned it
 * into a blank "Internal server error occurred" 500. A malformed id is a client
 * mistake, so it is rejected here as a 400 with a message that names the field.
 */
export class ParamUtil {
  /** Required positive integer (route ids). Throws 400 when absent or malformed. */
  static id(value: unknown, field = 'id'): number {
    const parsed = this.toInt(value);
    if (parsed === null || parsed <= 0) {
      throw AppError.badRequest(`Invalid ${field}: a positive numeric value is required.`, 'INVALID_PARAMETER');
    }
    return parsed;
  }

  /** Optional integer (query filters). Absent/blank yields undefined; malformed throws 400. */
  static optionalId(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = this.toInt(value);
    if (parsed === null || parsed <= 0) {
      throw AppError.badRequest(`Invalid ${field}: a positive numeric value is required.`, 'INVALID_PARAMETER');
    }
    return parsed;
  }

  /** Pagination page number. Anything unusable falls back to 1 rather than erroring. */
  static page(value: unknown): number {
    const parsed = this.toInt(value);
    return parsed && parsed > 0 ? parsed : 1;
  }

  /** Pagination size, clamped so a huge `limit` cannot be used to pull the whole table. */
  static limit(value: unknown, fallback = 50, max = 500): number {
    const parsed = this.toInt(value);
    if (!parsed || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  }

  /** Trimmed string, or undefined when blank — keeps empty filters out of WHERE clauses. */
  static text(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Accepts 'true'/'1' (and real booleans) as true; everything else is false. */
  static bool(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true' || value === '1';
    return false;
  }

  /** Strict integer parse: rejects '', 'abc', '12abc', Infinity. Returns null when unusable. */
  private static toInt(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isInteger(value) ? value : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
}
