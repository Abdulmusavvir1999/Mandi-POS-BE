import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { OrdersService } from '../orders/orders.service';
import { DocumentSequence, ORDER_DOCUMENT, BILL_DOCUMENT, decorateDocuments, decorateDeletedDocuments } from '../../core/utils/document-sequence.util';
import { BillsService } from '../bills/bills.service';
import { CheckoutService, CheckoutPayload } from '../checkout/checkout.service';
import { OrderStatus, OrderType, PaymentMethod } from '../../core/types';
import { logger } from '../../config/logger';
import { ParamUtil } from '../../core/utils/param.util';
import { DEFAULT_TAX_POLICY, effectiveTaxShare, wasTaxIncludedInTotal } from '../../core/utils/tax.util';

/** Per-record outcome for every bulk operation, so partial failures stay visible. */
export interface BulkOutcome {
  id: number;
  reference: string;
  reason: string;
}

export interface BulkResult<T = any> {
  requested: number;
  succeeded: BulkOutcome[];
  failed: BulkOutcome[];
  details?: T;
}

const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Back-Office administration for orders and invoices.
 *
 * This module is reachable only from `/admin/back-office` and is deliberately
 * self-contained: it never calls into the POS, Orders or Bills write paths, so
 * none of those flows change behaviour. Reads are delegated to the existing
 * Orders/Bills services where the shape is already correct, and order creation
 * is delegated to CheckoutService so a back-office order is produced by exactly
 * the same code that produces a counter sale — order and invoice in one
 * transaction, with identical totals.
 *
 * Deletion here is a withdrawal, not a purge and not a void. The row is flagged
 * `is_deleted` and disappears from every list and every figure, while its
 * items, status history, payments, refunds and invoice stay exactly where they
 * are — so an administrator's removal is auditable afterwards, not just at the
 * moment it happened. To keep the ledger honest the withdrawal still returns
 * consumed stock and rolls back customer lifetime statistics for any invoice
 * that was not already voided (a voided bill has returned both already — doing
 * it twice would inflate inventory), and a record already withdrawn is refused
 * rather than reversed a second time.
 *
 * `is_voided` and `is_deleted` mean different things and both are kept: a void
 * is a sale cancelled at the till and remains real history; a delete is a
 * record pulled from the books.
 */
export class BackOfficeService {
  /** Cache of optional-table probes; migrations are not applied on every install. */
  private static tablePresence = new Map<string, boolean>();

  private static async tableExists(table: string): Promise<boolean> {
    const cached = this.tablePresence.get(table);
    if (cached !== undefined) return cached;

    try {
      const row = await dbService.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      const present = (row?.count || 0) > 0;
      this.tablePresence.set(table, present);
      return present;
    } catch (err) {
      logger.warn(`Back-office could not probe for table ${table}:`, err);
      return false;
    }
  }

  /**
   * Active refunds block both deletion and re-pricing: the refund rows carry
   * their own amounts and cascade away with the bill, so silently removing or
   * re-costing a refunded invoice would destroy a money trail the finance
   * reports still reference.
   */
  private static async activeRefundCount(billId: number): Promise<number> {
    if (!(await this.tableExists('refunds'))) return 0;
    const row = await dbService.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM refunds WHERE bill_id = ? AND status <> 'CANCELLED'",
      [billId]
    );
    return row?.count || 0;
  }

  /** Normalises and validates a list of ids arriving from the client. */
  private static parseIdList(raw: unknown, field = 'ids'): number[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw AppError.badRequest(`Select at least one record: ${field} must be a non-empty array.`);
    }

    const ids: number[] = [];
    for (const value of raw) {
      const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw AppError.badRequest(`Invalid ${field} entry: "${value}" is not a valid record id.`);
      }
      if (!ids.includes(parsed)) ids.push(parsed);
    }

    if (ids.length > 200) {
      throw AppError.badRequest('A maximum of 200 records can be processed in a single bulk operation.');
    }

    return ids;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — read
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Order register for the back-office grid. Unlike the kitchen board this
   * carries the linked invoice on every row, because every bulk action here
   * has to tell the operator what will happen to the invoice as well.
   */
  static async listOrders(options: {
    page?: number;
    limit?: number;
    status?: OrderStatus;
    orderType?: OrderType;
    search?: string;
    hasInvoice?: 'YES' | 'NO';
    dateFrom?: string;
    dateTo?: string;
  }) {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? options.limit : 20;
    const offset = (page - 1) * limit;

    // Withdrawn orders drop out of the register. The invoice join carries the
    // same filter so an order whose invoice was withdrawn on its own reads as
    // having no invoice rather than showing a deleted one.
    let where = 'WHERE o.is_deleted = 0';
    const params: any[] = [];

    if (options.status) {
      where += ' AND o.status = ?';
      params.push(options.status);
    }
    if (options.orderType) {
      where += ' AND o.order_type = ?';
      params.push(options.orderType);
    }
    if (options.search) {
      where += ' AND (o.order_number LIKE ? OR b.bill_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
      const term = ParamUtil.like(options.search);
      params.push(term, term, term, term);
    }
    if (options.hasInvoice === 'YES') {
      where += ' AND b.id IS NOT NULL';
    } else if (options.hasInvoice === 'NO') {
      where += ' AND b.id IS NULL';
    }
    if (options.dateFrom) {
      where += ' AND DATE(o.created_at) >= DATE(?)';
      params.push(options.dateFrom);
    }
    if (options.dateTo) {
      where += ' AND DATE(o.created_at) <= DATE(?)';
      params.push(options.dateTo);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id AND b.is_deleted = 0
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}`,
      params
    );

    const rows = await dbService.query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              b.id as bill_id, b.bill_number, b.display_seq as bill_display_seq, b.payment_status, b.payment_method,
              b.is_voided as bill_is_voided,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id AND b.is_deleted = 0
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u ON o.created_by = u.id
       ${where}
       -- Newest first by insertion order. Several orders routinely share a
       -- created_at to the second, so sorting on the timestamp left their
       -- relative order up to MySQL and a row could surface on two pages or
       -- on none. The id is unique and monotonic, so the sequence is stable.
       ORDER BY o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = countRes?.total || 0;
    return {
      data: decorateDocuments(rows as any[]),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  static async getOrder(id: number) {
    return await OrdersService.getById(id);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — create (order + invoice in one step)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Creates an order and its invoice together. The operator never has to raise
   * the invoice by hand, and because both records come out of a single
   * CheckoutService transaction the invoice always carries the order's final
   * values rather than a re-derived copy of them.
   */
  static async createOrderWithInvoice(
    body: {
      customerId?: number | null;
      diningTableId?: number | null;
      orderType?: OrderType;
      discountType?: 'FIXED' | 'PERCENTAGE';
      discountValue?: number;
      serviceChargeAmount?: number;
      surchargeAmount?: number;
      paymentMethod?: PaymentMethod;
      paymentReference?: string;
      notes?: string;
      items?: Array<{ productId: number; quantity: number; notes?: string }>;
    },
    userId: number
  ) {
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw AppError.badRequest('An order must contain at least one item.');
    }

    for (const item of body.items) {
      const productId = Number(item?.productId);
      const quantity = Number(item?.quantity);
      if (!Number.isSafeInteger(productId) || productId <= 0) {
        throw AppError.badRequest('Every order line needs a valid product.');
      }
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw AppError.badRequest('Every order line needs a quantity of at least 1.');
      }
    }

    const orderType: OrderType = ParamUtil.orderType(body.orderType);
    if (orderType === 'DINING' && !body.diningTableId) {
      throw AppError.badRequest('A dining order needs a table to be selected.');
    }

    const payload: CheckoutPayload = {
      customerId: body.customerId || null,
      diningTableId: body.diningTableId || null,
      orderType,
      discountType: body.discountType || 'FIXED',
      discountValue: Math.max(0, Number(body.discountValue) || 0),
      serviceChargeAmount: Math.max(0, Number(body.serviceChargeAmount) || 0),
      surchargeAmount: Math.max(0, Number(body.surchargeAmount) || 0),
      paymentMethod: body.paymentMethod || 'CASH',
      paymentReference: body.paymentReference,
      notes: body.notes,
      items: body.items.map((item) => ({
        productId: Number(item.productId),
        quantity: Number(item.quantity),
        notes: item.notes,
      })),
    };

    const result = await CheckoutService.processCheckout(payload, userId);
    const billId = Number((result as any)?.bill?.id);

    await AuditService.log({
      userId,
      action: 'BACKOFFICE_ORDER_CREATED',
      module: 'BACK_OFFICE',
      recordId: billId || undefined,
      newValues: {
        orderNumber: (result as any)?.bill?.order_number,
        billNumber: (result as any)?.bill?.bill_number,
        totalAmount: (result as any)?.bill?.total_amount,
      },
    });

    return {
      order: await OrdersService.getById(Number((result as any).bill.order_id)),
      invoice: billId ? await BillsService.getById(billId) : null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // Shared purge helpers
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Withdraws a bill from the books.
   *
   * The row is flagged rather than deleted, so bill_items, payments and refunds
   * — all `ON DELETE CASCADE` from bills, and all previously destroyed with it
   * — stay readable. What the flag alone cannot do is put the stock back or
   * undo the customer's lifetime totals, so that reversal is still performed
   * exactly as it was when this deleted outright: a withdrawn invoice must
   * leave the same figures behind whether it was removed before or after soft
   * delete existed.
   *
   * Must be called inside a transaction.
   */
  private static async purgeBill(billId: number, userId: number, reason?: string): Promise<void> {
    const bill = await dbService.queryOne<any>('SELECT * FROM bills WHERE id = ?', [billId]);
    if (!bill) return;

    // Already withdrawn: the stock and customer reversal below has run once
    // already, and running it twice would credit the same stock back twice.
    if (Boolean(bill.is_deleted)) return;

    const alreadyVoided = Boolean(bill.is_voided) || bill.payment_status === 'VOIDED';

    if (!alreadyVoided) {
      const items = await dbService.query<any>(
        'SELECT product_id, quantity, stock_consumption FROM bill_items WHERE bill_id = ?',
        [billId]
      );

      for (const item of items) {
        const stockQty = Number(item.stock_consumption || 1) * Number(item.quantity || 0);
        if (stockQty <= 0) continue;

        const product = await dbService.queryOne<{ stock_item_id: number | null }>(
          'SELECT stock_item_id FROM products WHERE id = ?',
          [item.product_id]
        );

        if (product?.stock_item_id) {
          await dbService.execute(
            'UPDATE stock_items SET current_quantity = current_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [stockQty, product.stock_item_id]
          );
        } else {
          await dbService.execute(
            'UPDATE stock SET current_stock = current_stock + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?',
            [stockQty, item.product_id]
          );
        }
      }

      if (bill.customer_id) {
        await dbService.execute(
          `UPDATE customers
           SET total_visits = GREATEST(0, total_visits - 1),
               total_spent = GREATEST(0, total_spent - ?),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [Number(bill.total_amount) || 0, bill.customer_id]
        );
      }
    }

    // `reopened_from_bill_id` is deliberately left alone. The row it points at
    // still exists and still resolves — that reference was only a problem when
    // the delete destroyed its target.
    await dbService.execute(
      `UPDATE bills
       SET is_deleted = 1,
           deleted_at = CURRENT_TIMESTAMP,
           deleted_by = ?,
           delete_reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [userId, reason || 'Withdrawn from the Back-Office', billId]
    );

    // Close the hole this leaves in the invoice register: the day's remaining
    // active invoices shift down so the list reads 1, 2, 3 rather than 1, 2, 4.
    // The withdrawn row keeps the position it held, frozen.
    await DocumentSequence.resequenceFor(BILL_DOCUMENT, billId);

    await AuditService.log({
      userId,
      action: 'BACKOFFICE_INVOICE_DELETED',
      module: 'BACK_OFFICE',
      recordId: billId,
      oldValues: {
        billNumber: bill.bill_number,
        orderId: bill.order_id,
        totalAmount: bill.total_amount,
        wasVoided: alreadyVoided,
        stockRestored: !alreadyVoided,
      },
      newValues: { isDeleted: true, reason: reason || null },
    });
  }

  /**
   * Frees any table still held by this order. `dining_tables.current_order_id`
   * carries no foreign key, so a table left pointing at a deleted or cancelled
   * order would read as occupied forever.
   */
  private static async releaseTableFor(orderId: number): Promise<void> {
    await dbService.execute(
      `UPDATE dining_tables
       SET status = 'AVAILABLE', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE current_order_id = ?`,
      [orderId]
    );
  }

  /**
   * Releases the live state a withdrawn order was still holding.
   *
   * Payments are no longer deleted here. That DELETE existed because
   * `payments.order_id` has no cascade and would have blocked the row removal;
   * with the order merely flagged there is nothing to unblock, and the payment
   * rows are the record of money actually taken — the most important part of
   * the history this change set out to keep.
   *
   * The table is still freed: `dining_tables.current_order_id` carries no
   * foreign key, so a table left pointing at a withdrawn order would read as
   * occupied forever and could never be seated again.
   */
  private static async detachOrderReferences(orderId: number): Promise<void> {
    // The queue keeps its token row for the day's history; only the link goes,
    // so a live kitchen board stops showing a withdrawn order.
    await dbService.execute('UPDATE queue SET order_id = NULL WHERE order_id = ?', [orderId]);

    await this.releaseTableFor(orderId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — delete
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Withdraws the given orders, and their invoices, from the books.
   *
   * Nothing is destroyed: each order is flagged `is_deleted` and drops out of
   * every list and figure, while its items, status history, payments and
   * invoice stay readable. Each order runs in its own transaction so one
   * rejected record cannot roll back the rest, and every rejection is reported
   * back by order number instead of being folded into a blanket success.
   */
  static async deleteOrders(rawIds: unknown, userId: number, reason?: string): Promise<BulkResult> {
    const orderIds = this.parseIdList(rawIds, 'orderIds');

    const succeeded: BulkOutcome[] = [];
    const failed: BulkOutcome[] = [];
    let invoicesRemoved = 0;

    for (const orderId of orderIds) {
      const order = await dbService.queryOne<any>(
        `SELECT o.*, b.id as bill_id, b.bill_number
         FROM orders o
         LEFT JOIN bills b ON b.order_id = o.id AND b.is_deleted = 0
         WHERE o.id = ?`,
        [orderId]
      );

      if (!order) {
        failed.push({ id: orderId, reference: `#${orderId}`, reason: 'Order no longer exists.' });
        continue;
      }

      const reference = order.order_number || `#${orderId}`;

      // Re-withdrawing would run the stock and customer reversal a second
      // time, crediting the same stock back twice.
      if (Boolean(order.is_deleted)) {
        failed.push({ id: orderId, reference, reason: 'Order has already been deleted.' });
        continue;
      }

      if (order.bill_id) {
        const refunds = await this.activeRefundCount(order.bill_id);
        if (refunds > 0) {
          failed.push({
            id: orderId,
            reference,
            reason: `Invoice ${order.bill_number} has ${refunds} refund(s) recorded against it. Cancel the refunds first.`,
          });
          continue;
        }
      }

      try {
        await dbService.transaction(async () => {
          if (order.bill_id) {
            await this.purgeBill(order.bill_id, userId, reason);
          }

          await this.detachOrderReferences(orderId);

          // order_items and order_status_history are left in place — they used
          // to cascade away with the row and are now part of the kept history.
          await dbService.execute(
            `UPDATE orders
             SET is_deleted = 1,
                 deleted_at = CURRENT_TIMESTAMP,
                 deleted_by = ?,
                 delete_reason = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [userId, reason || 'Withdrawn from the Back-Office', orderId]
          );

          // Close the hole this leaves: the day's remaining active orders
          // shift down so the list reads 1, 2, 3 rather than 1, 2, 4. The
          // withdrawn row keeps the position it held, frozen, so the deleted
          // list can still show where it sat. Inside this transaction, so the
          // renumber commits or rolls back with the withdrawal.
          await DocumentSequence.resequenceFor(ORDER_DOCUMENT, orderId);

          await AuditService.log({
            userId,
            action: 'BACKOFFICE_ORDER_DELETED',
            module: 'BACK_OFFICE',
            recordId: orderId,
            oldValues: {
              orderNumber: order.order_number,
              status: order.status,
              totalAmount: order.total_amount,
              billNumber: order.bill_number || null,
            },
            newValues: { isDeleted: true, reason: reason || null },
          });
        });

        if (order.bill_id) invoicesRemoved += 1;
        succeeded.push({ id: orderId, reference, reason: 'Deleted' });
      } catch (err: any) {
        logger.error(`Back-office failed to delete order ${orderId}:`, err);
        failed.push({
          id: orderId,
          reference,
          reason: err?.message || 'The database refused to delete this order.',
        });
      }
    }

    return {
      requested: orderIds.length,
      succeeded,
      failed,
      details: { invoicesRemoved },
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — restore (undo delete)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Withdrawn orders, so an administrator can see what there is to undo.
   *
   * This is the one read in the system that deliberately looks past
   * `is_deleted`; everything else treats a withdrawn record as gone.
   */
  static async listDeletedOrders(options: { page?: number; limit?: number; search?: string } = {}) {
    await CheckoutService.ensureSchema();

    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? options.limit : 20;
    const offset = (page - 1) * limit;

    // A withdrawn order holds no `order_number` — it released it — so matching
    // on that column alone would make every deleted record unsearchable by the
    // number the operator remembers. The released number lives in `delete_json`
    // and is searched alongside the live columns.
    let where = 'WHERE o.is_deleted = 1';
    const params: any[] = [];
    if (options.search) {
      where +=
        ` AND (o.order_number LIKE ? OR b.bill_number LIKE ? OR c.name LIKE ?` +
        ` OR JSON_UNQUOTE(JSON_EXTRACT(o.delete_json, '$.number')) LIKE ?` +
        ` OR JSON_UNQUOTE(JSON_EXTRACT(b.delete_json, '$.number')) LIKE ?)`;
      const term = ParamUtil.like(options.search);
      params.push(term, term, term, term, term);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}`,
      params
    );

    const rows = await dbService.query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              du.name as deleted_by_name,
              b.id as bill_id, b.bill_number, b.display_seq as bill_display_seq, b.total_amount as bill_total, b.is_deleted as bill_is_deleted,
              b.delete_json as bill_delete_json,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN users du ON o.deleted_by = du.id
       ${where}
       ORDER BY o.deleted_at DESC, o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = countRes?.total || 0;
    return {
      data: decorateDeletedDocuments(decorateDocuments(rows as any[]), 'order'),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Undoes a withdrawal: the order comes back, its invoice with it, and the
   * day is renumbered so the restored order takes its place in sequence.
   *
   * The stock and customer reversal the withdrawal performed is re-applied, so
   * a delete followed by a restore is a round trip that leaves the books
   * exactly as they started. That symmetry is the whole point — without it,
   * undoing a mistaken delete would silently inflate inventory.
   *
   * Position is not stored and replayed; it falls out of the renumber. Because
   * positions are assigned in creation order, a restored order lands back
   * where it was as long as nothing created since has taken that slot, which
   * is what "its original position where possible" means in practice.
   */
  static async restoreOrders(rawIds: unknown, userId: number): Promise<BulkResult> {
    await CheckoutService.ensureSchema();
    const orderIds = this.parseIdList(rawIds, 'orderIds');

    const succeeded: BulkOutcome[] = [];
    const failed: BulkOutcome[] = [];
    let invoicesRestored = 0;

    for (const orderId of orderIds) {
      const order = await dbService.queryOne<any>(
        `SELECT o.*, b.id as bill_id, b.bill_number, b.is_deleted as bill_is_deleted
         FROM orders o
         LEFT JOIN bills b ON b.order_id = o.id
         WHERE o.id = ?`,
        [orderId]
      );

      if (!order) {
        failed.push({ id: orderId, reference: `#${orderId}`, reason: 'Order no longer exists.' });
        continue;
      }

      const reference = order.order_number || `#${orderId}`;

      if (!Number(order.is_deleted)) {
        failed.push({ id: orderId, reference, reason: 'Order is not deleted; there is nothing to restore.' });
        continue;
      }

      try {
        await dbService.transaction(async () => {
          if (order.bill_id && Number(order.bill_is_deleted)) {
            await this.restoreBill(order.bill_id, userId);
          }

          await dbService.execute(
            `UPDATE orders
             SET is_deleted = 0,
                 deleted_at = NULL,
                 deleted_by = NULL,
                 delete_reason = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [orderId]
          );

          // Reopens the slot: the restored order is back among the day's
          // active rows, so renumbering from creation order puts it and
          // everything after it back in sequence.
          await DocumentSequence.resequenceFor(ORDER_DOCUMENT, orderId);

          await AuditService.log({
            userId,
            action: 'BACKOFFICE_ORDER_RESTORED',
            module: 'BACK_OFFICE',
            recordId: orderId,
            oldValues: {
              isDeleted: true,
              deletedAt: order.deleted_at,
              deleteReason: order.delete_reason,
            },
            newValues: {
              orderNumber: order.order_number,
              billNumber: order.bill_number || null,
              isDeleted: false,
            },
          });
        });

        if (order.bill_id && Number(order.bill_is_deleted)) invoicesRestored += 1;
        succeeded.push({ id: orderId, reference, reason: 'Restored' });
      } catch (err: any) {
        logger.error(`Back-office failed to restore order ${orderId}:`, err);
        failed.push({
          id: orderId,
          reference,
          reason: err?.message || 'The database refused to restore this order.',
        });
      }
    }

    return {
      requested: orderIds.length,
      succeeded,
      failed,
      details: { invoicesRestored },
    };
  }

  /**
   * Brings an invoice back and re-applies what its withdrawal reversed.
   *
   * The mirror of `purgeBill`: stock is consumed again and the customer's
   * lifetime totals are re-credited, but only when the bill was not voided —
   * a voided bill never consumed the stock in the first place, so putting it
   * back would take inventory that was never sold.
   *
   * Must be called inside a transaction.
   */
  private static async restoreBill(billId: number, userId: number): Promise<void> {
    const bill = await dbService.queryOne<any>('SELECT * FROM bills WHERE id = ?', [billId]);
    if (!bill) return;
    if (!Number(bill.is_deleted)) return;

    const wasVoided = Boolean(bill.is_voided) || bill.payment_status === 'VOIDED';

    if (!wasVoided) {
      const items = await dbService.query<any>(
        'SELECT product_id, quantity, stock_consumption FROM bill_items WHERE bill_id = ?',
        [billId]
      );

      for (const item of items) {
        const stockQty = Number(item.stock_consumption || 1) * Number(item.quantity || 0);
        if (stockQty <= 0) continue;

        const product = await dbService.queryOne<{ stock_item_id: number | null }>(
          'SELECT stock_item_id FROM products WHERE id = ?',
          [item.product_id]
        );

        if (product?.stock_item_id) {
          await dbService.execute(
            'UPDATE stock_items SET current_quantity = current_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [stockQty, product.stock_item_id]
          );
        } else {
          await dbService.execute(
            'UPDATE stock SET current_stock = current_stock - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?',
            [stockQty, item.product_id]
          );
        }
      }

      if (bill.customer_id) {
        await dbService.execute(
          `UPDATE customers
           SET total_visits = total_visits + 1,
               total_spent = total_spent + ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [Number(bill.total_amount) || 0, bill.customer_id]
        );
      }
    }

    await dbService.execute(
      `UPDATE bills
       SET is_deleted = 0,
           deleted_at = NULL,
           deleted_by = NULL,
           delete_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [billId]
    );

    // Reopens the slot: the invoice is back among the day's active rows, so
    // renumbering from creation order puts it and everything after it back in
    // sequence.
    await DocumentSequence.resequenceFor(BILL_DOCUMENT, billId);

    await AuditService.log({
      userId,
      action: 'BACKOFFICE_INVOICE_RESTORED',
      module: 'BACK_OFFICE',
      recordId: billId,
      newValues: {
        billNumber: bill.bill_number,
        totalAmount: bill.total_amount,
        stockReconsumed: !wasVoided,
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — bulk discount
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Re-prices an order and its invoice around a new discount.
   *
   * The tax rate is taken from the record itself (old tax ÷ old taxable base)
   * rather than from current settings, so re-pricing a historical order does
   * not quietly move it onto today's tax percentage. Only when the old taxable
   * base was zero does it fall back to the configured rate.
   *
   * What that ratio means depends on the rule the record was written under: an
   * EXCLUSIVE record's tax is a share of a net base, an INCLUSIVE record's is a
   * share of a base that already contains it. Either way the ratio re-applies
   * correctly to the new base — only whether the tax is then *added* to the
   * total differs, which is what wasTaxIncludedInTotal settles per record.
   */
  private static effectiveTaxRate(
    oldTaxableAmount: number,
    oldTaxAmount: number,
    fallbackRate: number
  ): number {
    if (oldTaxableAmount > 0) {
      return (oldTaxAmount / oldTaxableAmount) * 100;
    }
    return fallbackRate;
  }

  /**
   * Applies the same discount to every selected order — a fixed amount is
   * applied in full to each order, never split across the selection — then
   * recalculates the order and its invoice so both carry the new final amount.
   */
  static async applyBulkDiscount(
    body: { orderIds?: unknown; discountType?: 'FIXED' | 'PERCENTAGE'; discountValue?: number },
    userId: number
  ): Promise<BulkResult> {
    const orderIds = this.parseIdList(body.orderIds, 'orderIds');
    const discountType: 'FIXED' | 'PERCENTAGE' = body.discountType === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED';
    const discountValue = Number(body.discountValue);

    if (!Number.isFinite(discountValue) || discountValue < 0) {
      throw AppError.badRequest('Enter a discount amount of zero or more.');
    }
    if (discountType === 'PERCENTAGE' && discountValue > 100) {
      throw AppError.badRequest('A percentage discount cannot exceed 100%.');
    }

    // Only reached for a record carrying no tax of its own; everything else
    // re-prices on its own ratio. `inclusive` additionally decides those
    // zero-tax records' totals, where adding nothing and containing nothing
    // come to the same number anyway.
    let fallbackTaxRate = 5.0;
    let taxPolicy = { ...DEFAULT_TAX_POLICY };
    try {
      taxPolicy = await SettingsService.getTaxPolicy();
      fallbackTaxRate = effectiveTaxShare(taxPolicy);
    } catch (_) {
      // Settings unavailable: the per-record rate below still covers every
      // order that already carries tax, which is the normal case.
    }

    const succeeded: BulkOutcome[] = [];
    const failed: BulkOutcome[] = [];
    const updates: Array<{ orderId: number; orderNumber: string; billNumber: string | null; newTotal: number }> = [];

    for (const orderId of orderIds) {
      const order = await dbService.queryOne<any>(
        `SELECT o.*, b.id as bill_id, b.bill_number, b.is_voided as bill_is_voided
         FROM orders o
         LEFT JOIN bills b ON b.order_id = o.id AND b.is_deleted = 0
         WHERE o.id = ?`,
        [orderId]
      );

      if (!order) {
        failed.push({ id: orderId, reference: `#${orderId}`, reason: 'Order no longer exists.' });
        continue;
      }

      const reference = order.order_number || `#${orderId}`;

      if (order.status === 'CANCELLED') {
        failed.push({ id: orderId, reference, reason: 'Cancelled orders cannot be re-priced.' });
        continue;
      }

      if (order.bill_id && Boolean(order.bill_is_voided)) {
        failed.push({
          id: orderId,
          reference,
          reason: `Invoice ${order.bill_number} has been voided and cannot be re-priced.`,
        });
        continue;
      }

      if (order.bill_id) {
        const refunds = await this.activeRefundCount(order.bill_id);
        if (refunds > 0) {
          failed.push({
            id: orderId,
            reference,
            reason: `Invoice ${order.bill_number} has ${refunds} refund(s) recorded against it.`,
          });
          continue;
        }
      }

      const orderSubtotal = Number(order.subtotal) || 0;
      if (orderSubtotal <= 0) {
        failed.push({ id: orderId, reference, reason: 'Order has no billable value to discount.' });
        continue;
      }

      const orderDiscount =
        discountType === 'PERCENTAGE'
          ? round2((orderSubtotal * discountValue) / 100)
          : round2(Math.min(discountValue, orderSubtotal));

      try {
        const newOrderTotal = await dbService.transaction(async () => {
          // ── Order ───────────────────────────────────────────────────────
          const oldOrderTaxable = Math.max(0, orderSubtotal - (Number(order.discount_amount) || 0));
          const orderTaxRate = this.effectiveTaxRate(
            oldOrderTaxable,
            Number(order.tax_amount) || 0,
            fallbackTaxRate
          );

          const orderTaxWasInside = wasTaxIncludedInTotal(
            oldOrderTaxable,
            Number(order.tax_amount) || 0,
            0,
            Number(order.total_amount) || 0,
            taxPolicy.inclusive
          );

          const orderTaxable = Math.max(0, orderSubtotal - orderDiscount);
          const orderTax = round2((orderTaxable * orderTaxRate) / 100);
          const orderTotal = round2(orderTaxWasInside ? orderTaxable : orderTaxable + orderTax);

          await dbService.execute(
            `UPDATE orders
             SET discount_type = ?, discount_value = ?, discount_amount = ?,
                 tax_amount = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [discountType, discountValue, orderDiscount, orderTax, orderTotal, orderId]
          );

          // ── Invoice ─────────────────────────────────────────────────────
          if (order.bill_id) {
            const bill = await dbService.queryOne<any>('SELECT * FROM bills WHERE id = ?', [order.bill_id]);
            if (bill) {
              const billSubtotal = Number(bill.subtotal) || 0;
              const coupon = Math.max(0, Number(bill.coupon_discount) || 0);
              const serviceCharge = Math.max(0, Number(bill.service_charge_amount) || 0);
              const surcharge = Math.max(0, Number(bill.surcharge_amount) || 0);

              const billDiscount =
                discountType === 'PERCENTAGE'
                  ? round2((billSubtotal * discountValue) / 100)
                  : round2(Math.min(discountValue, billSubtotal));

              const oldBillTaxable = Math.max(
                0,
                billSubtotal - Math.min(billSubtotal, (Number(bill.discount_amount) || 0) + coupon)
              );
              const billTaxRate = this.effectiveTaxRate(
                oldBillTaxable,
                Number(bill.tax_amount) || 0,
                fallbackTaxRate
              );

              const billTaxWasInside = wasTaxIncludedInTotal(
                oldBillTaxable,
                Number(bill.tax_amount) || 0,
                serviceCharge + surcharge,
                Number(bill.total_amount) || 0,
                taxPolicy.inclusive
              );

              const billTaxable = Math.max(0, billSubtotal - Math.min(billSubtotal, billDiscount + coupon));
              const billTax = round2((billTaxable * billTaxRate) / 100);
              const billTotal = round2(
                (billTaxWasInside ? billTaxable : billTaxable + billTax) + serviceCharge + surcharge
              );
              const previousTotal = Number(bill.total_amount) || 0;

              await dbService.execute(
                `UPDATE bills
                 SET discount_type = ?, discount_value = ?, discount_amount = ?,
                     tax_amount = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [discountType, discountValue, billDiscount, billTax, billTotal, order.bill_id]
              );

              // Keep the tendered figures and the payment ledger in step with
              // the new invoice total; otherwise day-closing and the payment
              // mode reports would still be counting the pre-discount amount.
              await this.resyncBillPayment(order.bill_id, bill, billTotal);

              if (bill.customer_id && previousTotal !== billTotal) {
                await dbService.execute(
                  `UPDATE customers
                   SET total_spent = GREATEST(0, total_spent + ?), updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?`,
                  [round2(billTotal - previousTotal), bill.customer_id]
                );
              }
            }
          }

          await AuditService.log({
            userId,
            action: 'BACKOFFICE_DISCOUNT_APPLIED',
            module: 'BACK_OFFICE',
            recordId: orderId,
            oldValues: {
              discountType: order.discount_type,
              discountValue: order.discount_value,
              discountAmount: order.discount_amount,
              totalAmount: order.total_amount,
            },
            newValues: {
              orderNumber: order.order_number,
              billNumber: order.bill_number || null,
              discountType,
              discountValue,
              discountAmount: orderDiscount,
              totalAmount: orderTotal,
            },
          });

          return orderTotal;
        });

        updates.push({
          orderId,
          orderNumber: reference,
          billNumber: order.bill_number || null,
          newTotal: newOrderTotal,
        });
        succeeded.push({
          id: orderId,
          reference,
          reason: order.bill_number
            ? `Discount applied, invoice ${order.bill_number} recalculated.`
            : 'Discount applied.',
        });
      } catch (err: any) {
        logger.error(`Back-office failed to discount order ${orderId}:`, err);
        failed.push({
          id: orderId,
          reference,
          reason: err?.message || 'The database refused to re-price this order.',
        });
      }
    }

    return {
      requested: orderIds.length,
      succeeded,
      failed,
      details: { discountType, discountValue, updates },
    };
  }

  /**
   * Re-points a settled invoice's payment record at its new grand total.
   *
   * Only a single-payment invoice is adjusted: a split-tender bill has no
   * unambiguous line to absorb the change, so those are left for the cashier to
   * settle manually rather than having the difference guessed at.
   */
  private static async resyncBillPayment(billId: number, bill: any, newTotal: number): Promise<void> {
    const payments = await dbService.query<any>('SELECT id, amount FROM payments WHERE bill_id = ?', [billId]);

    if (payments.length === 1) {
      await dbService.execute('UPDATE payments SET amount = ? WHERE id = ?', [newTotal, payments[0].id]);
    }

    const tendered = Number(bill.cash_tendered);
    if (Number.isFinite(tendered) && tendered > 0) {
      await dbService.execute('UPDATE bills SET change_returned = ? WHERE id = ?', [
        round2(Math.max(0, tendered - newTotal)),
        billId,
      ]);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // INVOICES
  // ══════════════════════════════════════════════════════════════════════

  static async listInvoices(options: {
    page?: number;
    limit?: number;
    search?: string;
    paymentMethod?: PaymentMethod;
    orderType?: OrderType;
    dateFrom?: string;
    dateTo?: string;
  }) {
    return await BillsService.getAll(
      options.page && options.page > 0 ? options.page : 1,
      options.limit && options.limit > 0 ? options.limit : 20,
      options.search,
      options.paymentMethod,
      options.orderType,
      options.dateFrom,
      options.dateTo,
      undefined, // no cashier filter — the Back-Office sees every till
      // Newest first by id, matching the Orders grid beside it. The Bills
      // register keeps its own timestamp ordering.
      'id'
    );
  }

  static async getInvoice(id: number) {
    return await BillsService.getById(id);
  }

  /** Withdrawn invoices, so an administrator can see what there is to undo. */
  static async listDeletedInvoices(options: { page?: number; limit?: number; search?: string } = {}) {
    await CheckoutService.ensureSchema();

    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? options.limit : 20;
    const offset = (page - 1) * limit;

    // A withdrawn invoice released its `bill_number`, so the number an operator
    // remembers now lives only in `delete_json`. Searched alongside the live
    // columns, or every deleted record would be unfindable by number.
    let where = 'WHERE b.is_deleted = 1';
    const params: any[] = [];
    if (options.search) {
      where +=
        ` AND (b.bill_number LIKE ? OR o.order_number LIKE ? OR c.name LIKE ?` +
        ` OR JSON_UNQUOTE(JSON_EXTRACT(b.delete_json, '$.number')) LIKE ?` +
        ` OR JSON_UNQUOTE(JSON_EXTRACT(o.delete_json, '$.number')) LIKE ?)`;
      const term = ParamUtil.like(options.search);
      params.push(term, term, term, term, term);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       ${where}`,
      params
    );

    const rows = await dbService.query(
      `SELECT b.*, o.order_number, o.display_seq as order_display_seq, o.status as order_status,
              o.is_deleted as order_is_deleted, o.delete_json as order_delete_json,
              c.name as customer_name, c.phone as customer_phone,
              u.name as cashier_name,
              du.name as deleted_by_name
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN users u ON b.cashier_id = u.id
       LEFT JOIN users du ON b.deleted_by = du.id
       ${where}
       ORDER BY b.deleted_at DESC, b.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = countRes?.total || 0;
    return {
      data: decorateDeletedDocuments(decorateDocuments(rows as any[], 'bill'), 'bill'),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Undoes an invoice withdrawal, and un-cancels the order it took down with
   * it.
   *
   * The mirror of `deleteInvoices`: that pushed the order to CANCELLED so it
   * would not read as "paid, no invoice", recording the status it came from in
   * `order_status_history`. The restore reads that entry back and returns the
   * order to it, rather than guessing at COMPLETED — an order cancelled for
   * its own reasons before the invoice was ever withdrawn must stay cancelled.
   *
   * An invoice whose order was withdrawn too — the usual case, since deleting
   * an order takes its invoice with it — restores the order instead, which
   * brings this invoice back with it. Either id therefore undoes the pair, and
   * the caller does not have to know which way round the withdrawal happened.
   */
  static async restoreInvoices(rawIds: unknown, userId: number): Promise<BulkResult> {
    await CheckoutService.ensureSchema();
    const billIds = this.parseIdList(rawIds, 'invoiceIds');

    const succeeded: BulkOutcome[] = [];
    const failed: BulkOutcome[] = [];
    let ordersReinstated = 0;

    for (const billId of billIds) {
      const bill = await dbService.queryOne<any>(
        `SELECT b.*, o.status as order_status, o.order_number, o.is_deleted as order_is_deleted
         FROM bills b
         LEFT JOIN orders o ON b.order_id = o.id
         WHERE b.id = ?`,
        [billId]
      );

      if (!bill) {
        failed.push({ id: billId, reference: `#${billId}`, reason: 'Invoice no longer exists.' });
        continue;
      }

      const reference = bill.bill_number || `#${billId}`;

      if (!Number(bill.is_deleted)) {
        failed.push({ id: billId, reference, reason: 'Invoice is not deleted; there is nothing to restore.' });
        continue;
      }

      // The invoice's order was withdrawn too — the usual case, since deleting
      // an order takes its invoice with it. Restoring the invoice alone would
      // leave it hanging off a withdrawn order, so the order is restored
      // instead and brings this invoice back on the way. Delegating rather
      // than un-deleting both here keeps the stock and customer re-application
      // in exactly one place, so it cannot run twice.
      if (bill.order_id && Number(bill.order_is_deleted)) {
        const orderResult = await this.restoreOrders([bill.order_id], userId);

        if (orderResult.failed.length > 0) {
          failed.push({ id: billId, reference, reason: orderResult.failed[0].reason });
        } else {
          ordersReinstated += 1;
          succeeded.push({
            id: billId,
            reference,
            reason: `Restored with its order ${bill.order_number}.`,
          });
        }
        continue;
      }

      try {
        const reinstated = await dbService.transaction(async () => {
          await this.restoreBill(billId, userId);

          if (bill.order_id && bill.order_status === 'CANCELLED') {
            // The status the order held before this invoice's withdrawal
            // cancelled it. Absent — an order cancelled for its own reasons —
            // means leave it alone.
            const priorEntry = await dbService.queryOne<{ previous_status: string }>(
              `SELECT previous_status
               FROM order_status_history
               WHERE order_id = ?
                 AND new_status = 'CANCELLED'
                 AND notes LIKE ?
               ORDER BY id DESC
               LIMIT 1`,
              [bill.order_id, `%${reference}%`]
            );

            if (priorEntry?.previous_status) {
              await dbService.execute(
                'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [priorEntry.previous_status, bill.order_id]
              );
              await dbService.execute(
                `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
                 VALUES (?, 'CANCELLED', ?, ?, ?)`,
                [bill.order_id, priorEntry.previous_status, userId, `Invoice ${reference} restored from Back-Office`]
              );
              return true;
            }
          }
          return false;
        });

        if (reinstated) ordersReinstated += 1;
        succeeded.push({
          id: billId,
          reference,
          reason: reinstated ? `Restored. Order ${bill.order_number} reinstated.` : 'Restored',
        });
      } catch (err: any) {
        logger.error(`Back-office failed to restore invoice ${billId}:`, err);
        failed.push({
          id: billId,
          reference,
          reason: err?.message || 'The database refused to restore this invoice.',
        });
      }
    }

    return {
      requested: billIds.length,
      succeeded,
      failed,
      details: { ordersReinstated },
    };
  }

  /**
   * Withdraws invoices without withdrawing their orders.
   *
   * An order left behind would otherwise still read as settled while its
   * invoice is gone, so the order is pushed to CANCELLED with a history entry
   * naming the deletion. That keeps the order/invoice relationship valid: an
   * order either has a live invoice or is cancelled, never "paid, no invoice".
   */
  static async deleteInvoices(rawIds: unknown, userId: number, reason?: string): Promise<BulkResult> {
    const billIds = this.parseIdList(rawIds, 'invoiceIds');

    const succeeded: BulkOutcome[] = [];
    const failed: BulkOutcome[] = [];
    let ordersCancelled = 0;

    for (const billId of billIds) {
      const bill = await dbService.queryOne<any>(
        `SELECT b.*, o.status as order_status, o.order_number
         FROM bills b
         LEFT JOIN orders o ON b.order_id = o.id
         WHERE b.id = ?`,
        [billId]
      );

      if (!bill) {
        failed.push({ id: billId, reference: `#${billId}`, reason: 'Invoice no longer exists.' });
        continue;
      }

      const reference = bill.bill_number || `#${billId}`;

      // Re-withdrawing would credit the same stock back a second time.
      if (Boolean(bill.is_deleted)) {
        failed.push({ id: billId, reference, reason: 'Invoice has already been deleted.' });
        continue;
      }

      const refunds = await this.activeRefundCount(billId);
      if (refunds > 0) {
        failed.push({
          id: billId,
          reference,
          reason: `${refunds} refund(s) are recorded against this invoice. Cancel the refunds first.`,
        });
        continue;
      }

      try {
        const cancelledOrder = await dbService.transaction(async () => {
          await this.purgeBill(billId, userId, reason);

          if (bill.order_id && bill.order_status && bill.order_status !== 'CANCELLED') {
            await dbService.execute(
              `UPDATE orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [bill.order_id]
            );
            await dbService.execute(
              `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
               VALUES (?, ?, 'CANCELLED', ?, ?)`,
              [
                bill.order_id,
                bill.order_status,
                userId,
                `Invoice ${reference} deleted from Back-Office`,
              ]
            );
            // The order survives as CANCELLED, so only the table is freed —
            // its queue token and history stay intact as a record of the day.
            await this.releaseTableFor(bill.order_id);
            return true;
          }

          return false;
        });

        if (cancelledOrder) ordersCancelled += 1;
        succeeded.push({
          id: billId,
          reference,
          reason: cancelledOrder
            ? `Deleted. Order ${bill.order_number} was cancelled.`
            : 'Deleted.',
        });
      } catch (err: any) {
        logger.error(`Back-office failed to delete invoice ${billId}:`, err);
        failed.push({
          id: billId,
          reference,
          reason: err?.message || 'The database refused to delete this invoice.',
        });
      }
    }

    return {
      requested: billIds.length,
      succeeded,
      failed,
      details: { ordersCancelled },
    };
  }
}
