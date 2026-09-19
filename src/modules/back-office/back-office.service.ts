import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { OrdersService } from '../orders/orders.service';
import { BillsService } from '../bills/bills.service';
import { CheckoutService, CheckoutPayload } from '../checkout/checkout.service';
import { OrderStatus, OrderType, PaymentMethod } from '../../core/types';
import { logger } from '../../config/logger';

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
 * Deletion here is a hard purge, not a void: the records go away. To keep the
 * ledger honest the purge still returns consumed stock and rolls back customer
 * lifetime statistics for any invoice that was not already voided (a voided
 * bill has returned both already — doing it twice would inflate inventory).
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

    let where = 'WHERE 1=1';
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
      const term = `%${options.search}%`;
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
       LEFT JOIN bills b ON b.order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}`,
      params
    );

    const rows = await dbService.query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              b.id as bill_id, b.bill_number, b.payment_status, b.payment_method,
              b.is_voided as bill_is_voided,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u ON o.created_by = u.id
       ${where}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = countRes?.total || 0;
    return {
      data: rows,
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

    const orderType: OrderType = body.orderType || 'WALK_IN';
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
   * Removes a bill and everything that hangs off it. bill_items, payments and
   * refunds are all `ON DELETE CASCADE` from bills, so the single DELETE clears
   * them; what cascade cannot do is put the stock back or undo the customer's
   * lifetime totals, which is what the rest of this does.
   *
   * Must be called inside a transaction.
   */
  private static async purgeBill(billId: number, userId: number): Promise<void> {
    const bill = await dbService.queryOne<any>('SELECT * FROM bills WHERE id = ?', [billId]);
    if (!bill) return;

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

    // `reopened_from_bill_id` carries no foreign key, so a later bill would be
    // left pointing at an id that no longer resolves. Clear it rather than
    // leaving a dangling reference behind.
    try {
      await dbService.execute(
        'UPDATE bills SET reopened_from_bill_id = NULL WHERE reopened_from_bill_id = ?',
        [billId]
      );
    } catch (_) {
      // Column only exists once the offline/billing migration has run.
    }

    await dbService.execute('DELETE FROM bills WHERE id = ?', [billId]);

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

  /** Detaches an order from everything that would otherwise block the DELETE. */
  private static async detachOrderReferences(orderId: number): Promise<void> {
    // `payments.order_id` has no cascade of its own — those rows normally go
    // with the bill they belong to, but a schema where that cascade is missing
    // would otherwise make the order undeletable for no useful reason.
    await dbService.execute('DELETE FROM payments WHERE order_id = ?', [orderId]);

    // The queue keeps its token row for the day's history; only the link goes.
    await dbService.execute('UPDATE queue SET order_id = NULL WHERE order_id = ?', [orderId]);

    await this.releaseTableFor(orderId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — delete
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Deletes the given orders together with their invoices. Each order runs in
   * its own transaction so one rejected record cannot roll back the rest, and
   * every rejection is reported back by order number instead of being folded
   * into a blanket success.
   */
  static async deleteOrders(rawIds: unknown, userId: number): Promise<BulkResult> {
    const orderIds = this.parseIdList(rawIds, 'orderIds');

    const succeeded: BulkOutcome[] = [];
    const failed: BulkOutcome[] = [];
    let invoicesRemoved = 0;

    for (const orderId of orderIds) {
      const order = await dbService.queryOne<any>(
        `SELECT o.*, b.id as bill_id, b.bill_number
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
            await this.purgeBill(order.bill_id, userId);
          }

          await this.detachOrderReferences(orderId);

          // order_items and order_status_history cascade from orders.
          await dbService.execute('DELETE FROM orders WHERE id = ?', [orderId]);

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
  // ORDERS — bulk discount
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Re-prices an order and its invoice around a new discount.
   *
   * The tax rate is taken from the record itself (old tax ÷ old taxable base)
   * rather than from current settings, so re-pricing a historical order does
   * not quietly move it onto today's tax percentage. Only when the old taxable
   * base was zero does it fall back to the configured rate.
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

    let fallbackTaxRate = 5.0;
    try {
      const taxEnabled = await SettingsService.getValue('TAX_ENABLED');
      const configured = parseFloat((await SettingsService.getValue('TAX_PERCENTAGE')) || '5.0');
      const rate = Number.isFinite(configured) ? configured : 5.0;
      fallbackTaxRate = taxEnabled !== null && taxEnabled !== 'true' ? 0 : rate;
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
         LEFT JOIN bills b ON b.order_id = o.id
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

          const orderTaxable = Math.max(0, orderSubtotal - orderDiscount);
          const orderTax = round2((orderTaxable * orderTaxRate) / 100);
          const orderTotal = round2(orderTaxable + orderTax);

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

              const billTaxable = Math.max(0, billSubtotal - Math.min(billSubtotal, billDiscount + coupon));
              const billTax = round2((billTaxable * billTaxRate) / 100);
              const billTotal = round2(billTaxable + billTax + serviceCharge + surcharge);
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
      options.dateTo
    );
  }

  static async getInvoice(id: number) {
    return await BillsService.getById(id);
  }

  /**
   * Deletes invoices without removing their orders.
   *
   * An order left behind would otherwise still read as settled while its
   * invoice is gone, so the order is pushed to CANCELLED with a history entry
   * naming the deletion. That keeps the order/invoice relationship valid: an
   * order either has an invoice or is cancelled, never "paid, no invoice".
   */
  static async deleteInvoices(rawIds: unknown, userId: number): Promise<BulkResult> {
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
          await this.purgeBill(billId, userId);

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
