import { dbService } from '../database/db';
import { logger } from '../config/logger';

/**
 * Gapless document numbering for orders and invoices.
 *
 * Two rules, applied to `orders.order_number` and `bills.bill_number` alike:
 *
 * 1. **A withdrawn document gives up its number.** Soft-deleting sets the
 *    number column to NULL, releasing it back to the day.
 * 2. **The day is then renumbered from 1.** The surviving active documents of
 *    that day are rewritten in creation order, so the register reads
 *    `INV-...-0001, 0002, 0003` with no hole where the withdrawn one was.
 *
 * THIS REWRITES NUMBERS THAT HAVE ALREADY BEEN PRINTED. Withdraw the second
 * invoice of the day and the third becomes `-0002`; a customer holding a
 * receipt that says `-0003` is holding a number that now names a different
 * sale. That is a deliberate instruction, not an oversight — it replaces the
 * earlier design in which the numbers were immutable and a separate
 * `display_seq` column carried the rearranging. See
 * back_office_document_renumber_migration.sql.
 *
 * `display_seq` is kept in step with the numeric suffix rather than removed,
 * so `display_number` and everything reading it keep working; it is now
 * redundant with the number rather than the thing that made it gapless.
 *
 * Three properties make this predictable:
 *
 * - **Creation order decides position.** Positions come from `created_at, id`,
 *   never from when a document was deleted or restored, so a restored record
 *   lands back where it belongs rather than at the end — and takes back a
 *   number in that position.
 * - **A day is renumbered as a whole, inside the caller's transaction.** Any
 *   number of documents can be withdrawn or restored in one operation and the
 *   day is still left contiguous, because the sequence is recomputed from the
 *   surviving rows rather than patched incrementally.
 * - **Rewrites are two-phase.** Shifting `0003` down to `0002` while `0002` is
 *   still held would trip the UNIQUE index, so every row that moves is parked
 *   on a temporary value first and given its final number second.
 *
 * Scoped per day because both document numbers are per day. A global sequence
 * would make every delete rewrite every later document in the database.
 */

export interface DocumentKind {
  /** Table holding the documents. Internal literal — never from a request. */
  table: 'orders' | 'bills';
  /** The number column, rewritten on every delete and restore. */
  numberColumn: 'order_number' | 'bill_number';
  /** Leading segment of the number, e.g. `INV` in `INV-20260921-0002`. */
  prefix: string;
  indexName: string;
}

export const ORDER_DOCUMENT: DocumentKind = {
  table: 'orders',
  numberColumn: 'order_number',
  prefix: 'ORD',
  indexName: 'idx_orders_display_seq',
};

export const BILL_DOCUMENT: DocumentKind = {
  table: 'bills',
  numberColumn: 'bill_number',
  prefix: 'INV',
  indexName: 'idx_bills_display_seq',
};

/** Zero-padding on the sequence segment: `0002`, not `2`. */
const SEQUENCE_WIDTH = 4;

export class DocumentSequence {
  private static ensured = new Set<string>();

  /**
   * Adds `display_seq` to a document table and backfills every existing day.
   *
   * The backfill runs once per process per table, and only touches days that
   * still have an unnumbered active row, so it costs nothing after the first
   * pass and cannot disturb positions already assigned.
   *
   * Requires `is_deleted` to exist already — it numbers active rows only.
   */
  static async ensureSchema(kind: DocumentKind): Promise<void> {
    if (this.ensured.has(kind.table)) return;

    try {
      const col = await dbService.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'display_seq'`,
        [kind.table]
      );

      if (!col || Number(col.count) === 0) {
        await dbService.execute(
          `ALTER TABLE ${kind.table} ADD COLUMN display_seq INT NULL AFTER ${kind.numberColumn}`
        );
      }

      // A withdrawn document releases its number, so the column has to accept
      // NULL. It was declared NOT NULL UNIQUE; only the NOT NULL is lifted —
      // UNIQUE stays, and MySQL lets any number of rows hold NULL under it,
      // which is exactly what withdrawn documents need.
      const numberCol = await dbService.queryOne<{ IS_NULLABLE: string }>(
        `SELECT IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [kind.table, kind.numberColumn]
      );
      if (numberCol && numberCol.IS_NULLABLE !== 'YES') {
        await dbService.execute(
          `ALTER TABLE ${kind.table} MODIFY COLUMN ${kind.numberColumn} VARCHAR(50) NULL`
        );
      }

      // Releasing the number would otherwise destroy the only handle anyone
      // had on a withdrawn document. `delete_json` keeps what was released —
      // the row id and the number it held — so a deleted-records view can
      // still say "this was INV-20260921-0002" after the register has moved on.
      const deleteJsonCol = await dbService.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'delete_json'`,
        [kind.table]
      );
      if (!deleteJsonCol || Number(deleteJsonCol.count) === 0) {
        await dbService.execute(`ALTER TABLE ${kind.table} ADD COLUMN delete_json JSON NULL`);
      }

      const idx = await dbService.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [kind.table, kind.indexName]
      );
      if (!idx || Number(idx.count) === 0) {
        await dbService.execute(
          `CREATE INDEX ${kind.indexName} ON ${kind.table}(is_deleted, created_at, display_seq)`
        );
      }

      // Days still carrying the old arrangement: an active row that was never
      // positioned, or a withdrawn row still holding the number it should have
      // released. Both are exactly the days a renumber has to visit, so days
      // that are already correct cost nothing.
      const stale = await dbService.query<{ day: string }>(
        `SELECT DISTINCT DATE(created_at) AS day
         FROM ${kind.table}
         WHERE (is_deleted = 0 AND display_seq IS NULL)
            OR (is_deleted = 1 AND ${kind.numberColumn} IS NOT NULL)`
      );
      // Marked before the backfill, not after: resequenceDay() calls back into
      // this method so it can stand alone, and the flag is what stops that
      // from recursing. Every column and index it needs exists by this point.
      this.ensured.add(kind.table);

      for (const row of stale) {
        await this.resequenceDay(kind, String(row.day));
      }
    } catch (err) {
      logger.error(`Failed to ensure ${kind.table} display sequence schema:`, err);
    }
  }

  /**
   * Renumbers one day: withdrawn documents release their number, the survivors
   * are numbered 1..N in creation order.
   *
   * Only rows that actually move are written, so the common case — withdrawing
   * the newest document of the day — costs one UPDATE rather than rewriting
   * every row.
   *
   * Call inside the caller's transaction so the renumber commits or rolls back
   * with the delete or restore that triggered it.
   */
  static async resequenceDay(kind: DocumentKind, day: string): Promise<number> {
    // Stands on its own: BackOfficeService.deleteOrder and deleteInvoice reach
    // a renumber without going through any listing endpoint first, so on a
    // freshly deployed database the columns this reads would not exist yet.
    // Memoised per table, so this costs nothing after the first call.
    await this.ensureSchema(kind);

    // The stamp comes from the day being renumbered, not from the numbers
    // already on the rows, so every document in a day carries the same one
    // even when a restored row arrives holding no number to copy it from.
    const stamp = String(day).slice(0, 10).replace(/-/g, '');

    // Withdrawn rows are read too: they are what has to be blanked, and their
    // position in creation order is what the survivors are numbered around.
    const rows = await dbService.query<{
      id: number;
      number: string | null;
      display_seq: number | null;
      is_deleted: number;
      delete_json: string | null;
    }>(
      `SELECT id, ${kind.numberColumn} AS number, display_seq, is_deleted, delete_json
       FROM ${kind.table}
       WHERE DATE(created_at) = DATE(?)
       ORDER BY created_at ASC, id ASC`,
      [day]
    );

    let position = 0;
    const targets = rows.map((row) => {
      if (Number(row.is_deleted) === 1) {
        // The number is released here, so this is the only moment it can still
        // be recorded. Captured only on the pass that actually takes it away:
        // a row already blanked keeps the record written when it was withdrawn
        // rather than having it overwritten with nothing on every later
        // renumber of the same day.
        const deleteJson = row.number
          ? JSON.stringify({
              id: row.id,
              number: row.number,
              display_seq: row.display_seq === null ? null : Number(row.display_seq),
              released_at: new Date().toISOString(),
            })
          : row.delete_json ?? null;

        // The frozen position is left alone so a deleted-list can still show
        // where the document sat.
        return { id: row.id, number: null as string | null, seq: row.display_seq, deleteJson };
      }
      position += 1;
      return {
        id: row.id,
        number: `${kind.prefix}-${stamp}-${String(position).padStart(SEQUENCE_WIDTH, '0')}`,
        seq: position,
        // Restored: the row holds a live number again, so the record of what it
        // gave up is cleared, exactly as restore clears deleted_at and
        // delete_reason.
        deleteJson: null as string | null,
      };
    });

    const current = new Map(rows.map((row) => [row.id, row]));
    const moved = targets.filter((target) => {
      const row = current.get(target.id)!;
      const sameNumber = (row.number ?? null) === target.number;
      const sameSeq = row.display_seq === null ? target.seq === null : Number(row.display_seq) === target.seq;
      // Safe as a plain comparison: the unchanged path reuses the stored
      // string verbatim, so only a genuine capture or clear differs.
      const sameJson = (row.delete_json ?? null) === (target.deleteJson ?? null);
      return !(sameNumber && sameSeq && sameJson);
    });

    if (moved.length === 0) return 0;

    // Two phases, because the UNIQUE index sees the intermediate state. Moving
    // 0003 down to 0002 while 0002 is still held would be rejected outright,
    // so every row that moves is parked on a value nothing can collide with
    // and only then given its final number. The `~` prefix cannot occur in a
    // real number, and the id makes each parking slot distinct.
    for (const target of moved) {
      await dbService.execute(
        `UPDATE ${kind.table} SET ${kind.numberColumn} = ? WHERE id = ?`,
        [`~${kind.prefix}-${target.id}-${stamp}`, target.id]
      );
    }

    for (const target of moved) {
      await dbService.execute(
        `UPDATE ${kind.table}
         SET ${kind.numberColumn} = ?, display_seq = ?, delete_json = ?
         WHERE id = ?`,
        [target.number, target.seq, target.deleteJson, target.id]
      );
    }

    // `refunds` keeps its own copy of the invoice number for display. Renumbering
    // the invoice without it would leave refunds quoting a number that either no
    // longer exists or now belongs to a different sale.
    if (kind.table === 'bills') {
      for (const target of moved) {
        await dbService.execute('UPDATE refunds SET bill_number = ? WHERE bill_id = ?', [
          target.number,
          target.id,
        ]);
      }
    }

    return moved.length;
  }

  /** Renumbers the day a document belongs to. No-op for an unknown id. */
  static async resequenceFor(kind: DocumentKind, id: number): Promise<number> {
    const row = await dbService.queryOne<{ day: string }>(
      `SELECT DATE(created_at) AS day FROM ${kind.table} WHERE id = ?`,
      [id]
    );
    if (!row?.day) return 0;
    return this.resequenceDay(kind, String(row.day));
  }

  /**
   * Position for a newly created document: the next free slot in its own day.
   *
   * Taken from the day's high-water mark rather than a row count so two
   * concurrent sales cannot be handed the same position; active positions are
   * contiguous, so the maximum and the count agree anyway.
   */
  static async assignForNew(kind: DocumentKind, id: number): Promise<number> {
    const row = await dbService.queryOne<{ next_seq: number }>(
      `SELECT COALESCE(MAX(display_seq), 0) + 1 AS next_seq
       FROM ${kind.table}
       WHERE is_deleted = 0
         AND DATE(created_at) = (SELECT DATE(created_at) FROM ${kind.table} WHERE id = ?)
         AND id <> ?`,
      [id, id]
    );

    const position = Number(row?.next_seq) || 1;
    await dbService.execute(`UPDATE ${kind.table} SET display_seq = ? WHERE id = ?`, [position, id]);
    return position;
  }

  /**
   * The number an operator sees: the permanent number's prefix and date, with
   * the gapless position in place of the issued one.
   *
   * `INV-20260919-0007` withdrawn from a day of ten leaves the next invoice
   * reading `INV-20260919-0007` again rather than `0008`. Built from the
   * permanent number so the format follows it automatically if the prefix or
   * stamp ever changes.
   */
  static displayNumber(permanentNumber: string | null, displaySeq: number | null): string | null {
    if (!permanentNumber) return null;
    if (displaySeq === null || displaySeq === undefined) return permanentNumber;

    const parts = String(permanentNumber).split('-');
    if (parts.length < 3) return permanentNumber;

    const width = parts[parts.length - 1].length || 4;
    parts[parts.length - 1] = String(displaySeq).padStart(width, '0');
    return parts.join('-');
  }
}

/**
 * Adds `display_number` to a row, plus the counterpart number when the row
 * joined the other document.
 *
 * `primary` says which document the row's own `display_seq` belongs to, and is
 * not guessable: an order list selects `o.*` and joins `bill_number`, a bill
 * list selects `b.*` and joins `order_number`, so both shapes carry both
 * numbers and only the caller knows which `display_seq` is on the row. Getting
 * it wrong would silently pair an invoice's position with an order's number.
 *
 * The counterpart's position travels under an explicit alias
 * (`bill_display_seq` / `order_display_seq`) so the two can never collide.
 */
export function decorateDocument<T extends Record<string, any>>(
  row: T,
  primary: 'order' | 'bill' = 'order'
): T {
  if (!row) return row;

  const decorated: Record<string, any> = { ...row };
  const ownSeq = decorated['display_seq'] ?? null;

  if (primary === 'order') {
    decorated['display_number'] = DocumentSequence.displayNumber(decorated['order_number'] ?? null, ownSeq);
    if ('bill_number' in decorated) {
      decorated['bill_display_number'] = DocumentSequence.displayNumber(
        decorated['bill_number'] ?? null,
        decorated['bill_display_seq'] ?? null
      );
    }
  } else {
    decorated['display_number'] = DocumentSequence.displayNumber(decorated['bill_number'] ?? null, ownSeq);
    if ('order_number' in decorated) {
      decorated['order_display_number'] = DocumentSequence.displayNumber(
        decorated['order_number'] ?? null,
        decorated['order_display_seq'] ?? null
      );
    }
  }

  return decorated as T;
}

export function decorateDocuments<T extends Record<string, any>>(
  rows: T[],
  primary: 'order' | 'bill' = 'order'
): T[] {
  return (rows ?? []).map((row) => decorateDocument(row, primary));
}

/** The number a withdrawn document gave up, read back out of `delete_json`. */
export function releasedNumber(deleteJson: unknown): string | null {
  if (!deleteJson) return null;
  try {
    const parsed = typeof deleteJson === 'string' ? JSON.parse(deleteJson) : (deleteJson as any);
    return parsed?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * Adds `released_number` to withdrawn rows, and `bill_released_number` /
 * `order_released_number` for the counterpart document when one is joined.
 *
 * A withdrawn document holds no number — that is the point of releasing it —
 * so a deleted-records list has nothing to identify rows by unless it reads
 * what was given up. Restoring is the whole reason that list exists, and
 * "restore which one?" needs an answer beyond a row id.
 */
export function decorateDeletedDocuments<T extends Record<string, any>>(
  rows: T[],
  primary: 'order' | 'bill' = 'order'
): T[] {
  return (rows ?? []).map((row) => {
    const decorated: Record<string, any> = { ...row };
    decorated['released_number'] = releasedNumber(decorated['delete_json']);

    // The counterpart travels under its own alias, set by the list query, so an
    // order row can name the invoice that went with it and vice versa.
    const counterpart = primary === 'order' ? 'bill' : 'order';
    if (`${counterpart}_delete_json` in decorated) {
      decorated[`${counterpart}_released_number`] = releasedNumber(
        decorated[`${counterpart}_delete_json`]
      );
    }

    return decorated as T;
  });
}
