import { v4 as uuidv4 } from 'uuid';
import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../config/logger';
import { ReportsSchema } from '../reports/reports.schema';
import { StockService } from '../stock/stock.service';
import { ParamUtil } from '../../core/utils/param.util';

export interface RefundLineInput {
  billItemId: number;
  quantity: number;
}

export interface CreateRefundInput {
  billId: number;
  reason: string;
  reasonCode?: 'QUALITY' | 'WRONG_ITEM' | 'SERVICE_DELAY' | 'BILLING_ERROR' | 'CUSTOMER_REQUEST' | 'OTHER';
  refundMethod?: string;
  referenceNumber?: string;
  restockItems?: boolean;
  /** Omit for a full refund of everything still refundable on the bill. */
  items?: RefundLineInput[];
}

export interface ListRefundsQuery {
  page?: number;
  limit?: number;
  search?: string;
  billId?: number;
  customerId?: number;
  status?: string;
  reasonCode?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Refunds against settled bills.
 *
 * Before this existed a refund was a single flag on the bill
 * (`payment_status = 'REFUNDED'`) with no amount, so a partial refund was
 * unrepresentable and net revenue counted the full bill. Every refund now
 * carries its own lines, and two invariants keep the finance reports honest:
 *
 * 1. **Nothing can be refunded twice.** Each line's refundable quantity is
 *    the billed quantity less everything already refunded against that line,
 *    across all non-cancelled refunds.
 * 2. **A refund can never exceed what was paid.** Line values are prorated by
 *    the bill's own item-total-to-bill-total ratio, so bill-level discounts,
 *    coupons and service charges are reflected rather than refunded at menu
 *    value. A full refund with no prior partials returns exactly
 *    `bills.total_amount`, avoiding proration drift.
 */
export class RefundsService {
  static async create(input: CreateRefundInput, userId: number) {
    await ReportsSchema.ensure();

    const reason = input.reason?.trim();
    if (!reason) {
      throw AppError.badRequest('A refund reason is required', 'VALIDATION_ERROR');
    }

    return dbService.transaction(async () => {
      const bill = await dbService.queryOne<any>(
        `SELECT id, bill_number, customer_id, order_id, total_amount, subtotal, tax_amount,
                is_voided, is_deleted, payment_status
         FROM bills WHERE id = ? FOR UPDATE`,
        [input.billId]
      );
      if (!bill) {
        throw AppError.notFound(`Bill ${input.billId} not found`);
      }
      if (bill.is_deleted) {
        throw AppError.badRequest(
          `Bill ${bill.bill_number} has been deleted and is out of the books; it cannot be refunded.`,
          'BILL_DELETED'
        );
      }
      if (bill.is_voided) {
        throw AppError.badRequest(
          `Bill ${bill.bill_number} is voided; a voided bill was never settled and cannot be refunded.`,
          'BILL_VOIDED'
        );
      }

      const billItems = await dbService.query<any>(
        `SELECT id, product_id, product_name, unit_price, quantity, subtotal, discount_amount, tax_amount, total_amount
         FROM bill_items WHERE bill_id = ?`,
        [input.billId]
      );
      if (billItems.length === 0) {
        throw AppError.badRequest(`Bill ${bill.bill_number} has no line items to refund.`, 'NO_REFUNDABLE_ITEMS');
      }

      const refundedByItem = await this.refundedQuantities(input.billId);
      const alreadyRefundedValue = await this.refundedValue(input.billId);

      const billTotal = Number(bill.total_amount) || 0;
      const itemsTotal = billItems.reduce((sum, item) => sum + (Number(item.total_amount) || 0), 0);
      // Reconciles line values to what was actually charged: a 10% bill
      // discount makes this 0.9, a service charge makes it greater than 1.
      const prorationFactor = itemsTotal > 0 ? billTotal / itemsTotal : 1;

      const remainingValue = this.round(billTotal - alreadyRefundedValue);
      if (remainingValue <= 0) {
        throw AppError.badRequest(
          `Bill ${bill.bill_number} has already been fully refunded.`,
          'ALREADY_REFUNDED'
        );
      }

      const lines = this.resolveLines(input.items, billItems, refundedByItem);
      if (lines.length === 0) {
        throw AppError.badRequest(
          `Nothing left to refund on bill ${bill.bill_number}.`,
          'NO_REFUNDABLE_ITEMS'
        );
      }

      const isFullRemaining = this.coversEverythingRemaining(lines, billItems, refundedByItem);
      const noPriorRefunds = alreadyRefundedValue === 0;

      let subtotal = 0;
      let taxAmount = 0;
      let total = 0;
      const refundLines = lines.map((line) => {
        const ratio = line.billItem.quantity > 0 ? line.quantity / Number(line.billItem.quantity) : 0;
        const lineSubtotal = this.round(Number(line.billItem.subtotal) * ratio);
        const lineTax = this.round(Number(line.billItem.tax_amount) * ratio);
        const lineTotal = this.round(Number(line.billItem.total_amount) * ratio * prorationFactor);
        subtotal += lineSubtotal;
        taxAmount += lineTax;
        total += lineTotal;
        return {
          billItemId: line.billItem.id,
          productId: line.billItem.product_id,
          productName: line.billItem.product_name,
          unitPrice: this.round(Number(line.billItem.unit_price)),
          quantity: line.quantity,
          subtotal: lineSubtotal,
          taxAmount: lineTax,
          totalAmount: lineTotal,
        };
      });

      // A clean full refund returns the exact bill total rather than the sum
      // of prorated lines, which can round a paisa away.
      if (isFullRemaining && noPriorRefunds) {
        total = billTotal;
        subtotal = this.round(Number(bill.subtotal) || subtotal);
        taxAmount = this.round(Number(bill.tax_amount) || taxAmount);
      } else {
        total = this.round(total);
        subtotal = this.round(subtotal);
        taxAmount = this.round(taxAmount);
      }

      if (total > remainingValue + 0.01) {
        throw AppError.badRequest(
          `Refund of ${total} exceeds the ${remainingValue} still refundable on bill ${bill.bill_number}.`,
          'REFUND_EXCEEDS_BILL'
        );
      }

      const refundNumber = await this.nextRefundNumber();
      const refundType = isFullRemaining ? 'FULL' : 'PARTIAL';

      const res = await dbService.execute(
        `INSERT INTO refunds (
           uuid, refund_number, bill_id, bill_number, customer_id, refund_type,
           subtotal, tax_amount, total_amount, refund_method, reason_code, reason,
           status, reference_number, restock_items, refunded_by, refunded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          uuidv4(),
          refundNumber,
          bill.id,
          bill.bill_number,
          bill.customer_id ?? null,
          refundType,
          subtotal,
          taxAmount,
          total,
          (input.refundMethod ?? 'CASH').toUpperCase(),
          input.reasonCode ?? 'OTHER',
          reason,
          input.referenceNumber ?? null,
          input.restockItems ? 1 : 0,
          userId,
        ]
      );
      const refundId = res.lastInsertRowid;

      for (const line of refundLines) {
        await dbService.execute(
          `INSERT INTO refund_items (
             refund_id, bill_item_id, product_id, product_name,
             unit_price, quantity, subtotal, tax_amount, total_amount
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            refundId,
            line.billItemId,
            line.productId ?? null,
            line.productName,
            line.unitPrice,
            line.quantity,
            line.subtotal,
            line.taxAmount,
            line.totalAmount,
          ]
        );
      }

      // Fully refunded bills read REFUNDED so existing screens keep working;
      // partials get their own status rather than being left looking unpaid.
      const fullyRefunded = this.round(alreadyRefundedValue + total) >= this.round(billTotal - 0.01);
      await dbService.execute('UPDATE bills SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
        fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        bill.id,
      ]);

      if (input.restockItems) {
        await this.restock(refundLines, refundNumber, userId);
      }

      await AuditService.log({
        userId,
        action: 'REFUND_ISSUED',
        module: 'REFUNDS',
        recordId: refundId,
        oldValues: { bill_payment_status: bill.payment_status },
        newValues: {
          refundNumber,
          billNumber: bill.bill_number,
          refundType,
          total,
          reasonCode: input.reasonCode ?? 'OTHER',
          lines: refundLines.length,
        },
      });

      return this.getById(refundId);
    });
  }

  static async getAll(query: ListRefundsQuery = {}) {
    await ReportsSchema.ensure();

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 50;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (query.search) {
      where += ' AND (rf.refund_number LIKE ? OR rf.bill_number LIKE ? OR rf.reason LIKE ? OR rf.reference_number LIKE ?)';
      const term = ParamUtil.like(query.search);
      params.push(term, term, term, term);
    }
    if (query.billId) {
      where += ' AND rf.bill_id = ?';
      params.push(query.billId);
    }
    if (query.customerId) {
      where += ' AND rf.customer_id = ?';
      params.push(query.customerId);
    }
    if (query.status) {
      where += ' AND rf.status = ?';
      params.push(query.status);
    }
    if (query.reasonCode) {
      where += ' AND rf.reason_code = ?';
      params.push(query.reasonCode);
    }
    if (query.dateFrom) {
      where += ' AND rf.created_at >= ?';
      params.push(`${query.dateFrom} 00:00:00`);
    }
    if (query.dateTo) {
      where += ' AND rf.created_at < DATE_ADD(?, INTERVAL 1 DAY)';
      params.push(query.dateTo);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM refunds rf ${where}`,
      params
    );
    const total = Number(countRes?.total ?? 0);

    const data = await dbService.query(
      `SELECT
         rf.*,
         COALESCE(cu.name, 'Walk-in Guest')  AS customer_name,
         COALESCE(u.name, 'System')          AS refunded_by_name,
         (SELECT COUNT(*) FROM refund_items ri WHERE ri.refund_id = rf.id) AS items_count
       FROM refunds rf
       LEFT JOIN customers cu ON rf.customer_id = cu.id
       LEFT JOIN users u ON rf.refunded_by = u.id
       ${where}
       ORDER BY rf.created_at DESC, rf.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  static async getById(id: number) {
    await ReportsSchema.ensure();

    const refund = await dbService.queryOne<any>(
      `SELECT
         rf.*,
         COALESCE(cu.name, 'Walk-in Guest')  AS customer_name,
         cu.phone                            AS customer_phone,
         COALESCE(u.name, 'System')          AS refunded_by_name
       FROM refunds rf
       LEFT JOIN customers cu ON rf.customer_id = cu.id
       LEFT JOIN users u ON rf.refunded_by = u.id
       WHERE rf.id = ?`,
      [id]
    );
    if (!refund) {
      throw AppError.notFound(`Refund ${id} not found`);
    }

    const items = await dbService.query(
      `SELECT * FROM refund_items WHERE refund_id = ? ORDER BY id ASC`,
      [id]
    );

    return { ...refund, items };
  }

  /** Refunds recorded against one bill, with what is still refundable. */
  static async getByBill(billId: number) {
    await ReportsSchema.ensure();

    const bill = await dbService.queryOne<any>(
      'SELECT id, bill_number, total_amount, is_voided, payment_status FROM bills WHERE id = ? AND is_deleted = 0',
      [billId]
    );
    if (!bill) {
      throw AppError.notFound(`Bill ${billId} not found`);
    }

    const refunds = await dbService.query(
      `SELECT rf.*, COALESCE(u.name, 'System') AS refunded_by_name
       FROM refunds rf
       LEFT JOIN users u ON rf.refunded_by = u.id
       WHERE rf.bill_id = ?
       ORDER BY rf.created_at DESC`,
      [billId]
    );

    const billItems = await dbService.query<any>(
      `SELECT id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total_amount
       FROM bill_items WHERE bill_id = ?`,
      [billId]
    );
    const refundedByItem = await this.refundedQuantities(billId);
    const refundedValue = await this.refundedValue(billId);

    return {
      bill: {
        id: bill.id,
        bill_number: bill.bill_number,
        total_amount: this.round(Number(bill.total_amount)),
        payment_status: bill.payment_status,
        is_voided: !!bill.is_voided,
      },
      refunds,
      refundedValue,
      refundableValue: this.round(Math.max(0, Number(bill.total_amount) - refundedValue)),
      refundableItems: billItems.map((item) => {
        const refunded = refundedByItem.get(Number(item.id)) ?? 0;
        return {
          bill_item_id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_price: this.round(Number(item.unit_price)),
          billed_quantity: Number(item.quantity),
          refunded_quantity: this.round(refunded),
          refundable_quantity: this.round(Math.max(0, Number(item.quantity) - refunded)),
        };
      }),
    };
  }

  /**
   * Cancels a refund rather than deleting it: the finance reports exclude
   * cancelled rows, but the record of the reversal has to survive.
   */
  static async cancel(id: number, reason: string, userId: number) {
    await ReportsSchema.ensure();

    return dbService.transaction(async () => {
      const refund = await dbService.queryOne<any>('SELECT * FROM refunds WHERE id = ? FOR UPDATE', [id]);
      if (!refund) {
        throw AppError.notFound(`Refund ${id} not found`);
      }
      if (refund.status === 'CANCELLED') {
        throw AppError.badRequest(`Refund ${refund.refund_number} is already cancelled.`, 'ALREADY_CANCELLED');
      }

      await dbService.execute(
        `UPDATE refunds
         SET status = 'CANCELLED',
             reason = CONCAT(COALESCE(reason, ''), ' | Cancelled: ', ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [reason?.trim() || 'No reason given', id]
      );

      // Restore the bill's status from whatever refunds remain against it.
      const remaining = await this.refundedValue(refund.bill_id);
      const bill = await dbService.queryOne<any>('SELECT total_amount FROM bills WHERE id = ?', [refund.bill_id]);
      const billTotal = Number(bill?.total_amount) || 0;
      const status = remaining <= 0 ? 'PAID' : remaining >= this.round(billTotal - 0.01) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

      await dbService.execute('UPDATE bills SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
        status,
        refund.bill_id,
      ]);

      await AuditService.log({
        userId,
        action: 'REFUND_CANCELLED',
        module: 'REFUNDS',
        recordId: id,
        oldValues: { status: refund.status, total_amount: refund.total_amount },
        newValues: { status: 'CANCELLED', billPaymentStatus: status, reason },
      });

      return this.getById(id);
    });
  }

  /**
   * Quantity already refunded per bill line, across every refund on the bill
   * that has not been cancelled. A PENDING refund still reserves the quantity,
   * so the same item cannot be promised twice.
   */
  private static async refundedQuantities(billId: number): Promise<Map<number, number>> {
    const rows = await dbService.query<{ bill_item_id: number; refunded: number }>(
      `SELECT ri.bill_item_id, COALESCE(SUM(ri.quantity), 0) AS refunded
       FROM refund_items ri
       JOIN refunds rf ON ri.refund_id = rf.id
       WHERE rf.bill_id = ? AND rf.status <> 'CANCELLED'
       GROUP BY ri.bill_item_id`,
      [billId]
    );
    return new Map(rows.map((row) => [Number(row.bill_item_id), Number(row.refunded) || 0]));
  }

  /** Value already refunded on a bill, excluding cancelled refunds. */
  private static async refundedValue(billId: number): Promise<number> {
    const row = await dbService.queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(rf.total_amount), 0) AS total
       FROM refunds rf
       WHERE rf.bill_id = ? AND rf.status <> 'CANCELLED'`,
      [billId]
    );
    return this.round(Number(row?.total) || 0);
  }

  /**
   * Turns the request into validated lines. With no `items` this is every
   * line that still has refundable quantity; with `items` each requested line
   * is checked against what is left on it.
   */
  private static resolveLines(
    requested: RefundLineInput[] | undefined,
    billItems: any[],
    refundedByItem: Map<number, number>
  ): { billItem: any; quantity: number }[] {
    const byId = new Map<number, any>(billItems.map((item) => [Number(item.id), item]));

    if (!requested || requested.length === 0) {
      return billItems
        .map((item) => ({
          billItem: item,
          quantity: this.round(Number(item.quantity) - (refundedByItem.get(Number(item.id)) ?? 0)),
        }))
        .filter((line) => line.quantity > 0);
    }

    const seen = new Set<number>();
    return requested.map((line) => {
      const billItemId = Number(line.billItemId);
      const billItem = byId.get(billItemId);
      if (!billItem) {
        throw AppError.badRequest(
          `Bill item ${billItemId} does not belong to this bill.`,
          'INVALID_REFUND_ITEM'
        );
      }
      if (seen.has(billItemId)) {
        throw AppError.badRequest(
          `Bill item ${billItemId} appears more than once in the refund.`,
          'DUPLICATE_REFUND_ITEM'
        );
      }
      seen.add(billItemId);

      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw AppError.badRequest(
          `Invalid refund quantity for ${billItem.product_name}: a positive number is required.`,
          'VALIDATION_ERROR'
        );
      }

      const refundable = this.round(Number(billItem.quantity) - (refundedByItem.get(billItemId) ?? 0));
      if (quantity > refundable + 0.0001) {
        throw AppError.badRequest(
          `Cannot refund ${quantity} of ${billItem.product_name}: only ${refundable} of ${billItem.quantity} remain refundable.`,
          'REFUND_QUANTITY_EXCEEDED'
        );
      }

      return { billItem, quantity: this.round(quantity) };
    });
  }

  /** True when these lines take every remaining refundable unit on the bill. */
  private static coversEverythingRemaining(
    lines: { billItem: any; quantity: number }[],
    billItems: any[],
    refundedByItem: Map<number, number>
  ): boolean {
    const claimed = new Map<number, number>();
    for (const line of lines) {
      const id = Number(line.billItem.id);
      claimed.set(id, (claimed.get(id) ?? 0) + line.quantity);
    }
    return billItems.every((item) => {
      const id = Number(item.id);
      const remaining = Number(item.quantity) - (refundedByItem.get(id) ?? 0);
      return remaining <= 0.0001 || (claimed.get(id) ?? 0) >= remaining - 0.0001;
    });
  }

  /**
   * Returns refunded items to stock as `return` movements.
   *
   * Best-effort: a product with no linked stock item simply has nothing to
   * return, and a stock failure must not roll back a refund the customer has
   * already been paid. Failures are logged and the refund stands, with
   * `restock_items` on the record showing the intent.
   */
  private static async restock(
    lines: { productId: number | null; productName: string; quantity: number }[],
    refundNumber: string,
    userId: number
  ): Promise<void> {
    for (const line of lines) {
      if (!line.productId) continue;
      try {
        await StockService.adjustStock(
          {
            productId: line.productId,
            adjustmentType: 'return',
            quantity: line.quantity,
            reason: `Customer refund ${refundNumber}`,
            notes: `Returned to stock from refund ${refundNumber}`,
          },
          userId
        );
      } catch (err) {
        logger.warn(`Could not restock ${line.productName} for refund ${refundNumber}:`, err);
      }
    }
  }

  /** `REF-000001`, sequential on the table's high-water mark. */
  private static async nextRefundNumber(): Promise<string> {
    const maxRes = await dbService.queryOne<{ max_id: number }>('SELECT COALESCE(MAX(id), 0) as max_id FROM refunds');
    const next = Number(maxRes?.max_id ?? 0) + 1;
    return `REF-${String(next).padStart(6, '0')}`;
  }

  private static round(value: number): number {
    return Math.round((Number(value) || 0) * 100) / 100;
  }
}
