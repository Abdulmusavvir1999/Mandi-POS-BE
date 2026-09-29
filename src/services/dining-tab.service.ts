import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { CheckoutService, CheckoutPayload } from './checkout.service';
import { DiningTablesService } from './dining-tables.service';
import { SequenceUtil } from '../utils/sequence.util';
import { DocumentSequence, ORDER_DOCUMENT } from '../utils/document-sequence.util';

/**
 * Open dining tabs: a table orders in rounds and pays once at the end.
 *
 * Each "Send to Kitchen" adds the new lines to the table's open order
 * (status IN_PROGRESS, created on the first round) with the next kot_round,
 * and the till prints a KOT for just that round. Nothing is billed and no
 * stock moves yet. The bill is made by the normal checkout with
 * existingOrderId set: it bills every line on the order at the price it was
 * sent at, deducts stock for all of them, and frees the table.
 */
export class DiningTabService {
  private static async ensure(): Promise<void> {
    await CheckoutService.ensureSchema();
    await DiningTablesService.ensureSchema();
  }

  /** The table's unbilled order, or null. Pass forUpdate inside a transaction. */
  private static async findOpenOrder(tableId: number, forUpdate = false) {
    return await dbService.queryOne<{ id: number; order_number: string; status: string; customer_id: number | null; created_at: string }>(
      `SELECT o.id, o.order_number, o.status, o.customer_id, o.created_at
       FROM dining_tables t
       JOIN orders o ON o.id = t.current_order_id
       WHERE t.id = ? AND o.is_deleted = 0 AND o.status IN ('PENDING', 'IN_PROGRESS')
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tableId]
    );
  }

  private static async recalcOrder(orderId: number): Promise<void> {
    await dbService.execute(
      `UPDATE orders o
       SET o.subtotal = (SELECT COALESCE(SUM(oi.subtotal), 0) FROM order_items oi WHERE oi.order_id = o.id),
           o.total_amount = (SELECT COALESCE(SUM(oi.subtotal), 0) FROM order_items oi WHERE oi.order_id = o.id),
           o.updated_at = CURRENT_TIMESTAMP
       WHERE o.id = ?`,
      [orderId]
    );
  }

  /** Open tab for a table: the order and every line sent so far, oldest round first. */
  static async getTab(tableId: number) {
    await this.ensure();
    const table = await DiningTablesService.getById(tableId);
    const order = await this.findOpenOrder(tableId);
    if (!order) return { table, order: null, items: [], rounds: 0, subtotal: 0 };

    const items = await dbService.query<any>(
      `SELECT id, product_id, product_name, variant_id, variant_name, unit_price, quantity, subtotal,
              notes, addons_data, item_type, combo_id, addon_id, is_complimentary, complimentary_reason,
              kot_round, created_at
       FROM order_items WHERE order_id = ?
       ORDER BY COALESCE(kot_round, 0) ASC, id ASC`,
      [order.id]
    );
    const subtotal = items.reduce((sum, i) => sum + (Number(i.subtotal) || 0), 0);
    const rounds = items.reduce((max, i) => Math.max(max, Number(i.kot_round) || 0), 0);
    return {
      table,
      order,
      items: items.map((i) => ({
        ...i,
        is_complimentary: Boolean(Number(i.is_complimentary)),
        selected_addons: (() => {
          try {
            const a = i.addons_data ? JSON.parse(i.addons_data) : [];
            return Array.isArray(a) ? a : [];
          } catch (_) {
            return [];
          }
        })(),
      })),
      rounds,
      subtotal: Math.round(subtotal * 100) / 100,
    };
  }

  /**
   * Adds a round to the table's tab, opening the tab on the first one.
   * Returns the updated tab and the KOT for this round.
   */
  static async sendToKitchen(
    input: { tableId: number; items: CheckoutPayload['items']; customerId?: number | null; guestCount?: number | null; notes?: string },
    userId: number
  ) {
    await this.ensure();
    const items = (input.items || []).map((i) => {
      // Prices are the menu's; a client can never lock one.
      const { lockedUnitPrice: _drop, ...rest } = i as any;
      return rest as CheckoutPayload['items'][number];
    });
    if (!items.length) throw AppError.badRequest('Add items to the cart before sending to the kitchen.');

    const result = await dbService.transaction(async () => {
      const table = await dbService.queryOne<any>('SELECT * FROM dining_tables WHERE id = ? FOR UPDATE', [input.tableId]);
      if (!table) throw AppError.notFound('Dining table not found');
      if (table.status === 'UNAVAILABLE' || table.status === 'CLEANING') {
        throw AppError.badRequest(`Table ${table.table_number} is ${String(table.status).toLowerCase()}; it cannot take orders.`);
      }
      if (table.status === 'RESERVED') {
        throw AppError.conflict(`Table ${table.table_number} is reserved. Seat the reservation first.`);
      }

      let order = await this.findOpenOrder(input.tableId, true);
      if (!order) {
        const orderNumber = await SequenceUtil.nextDailyNumber('orders', 'order_number', 'ORD');
        const res = await dbService.execute(
          `INSERT INTO orders (
             order_number, customer_id, dining_table_id, order_type, status,
             subtotal, discount_type, discount_value, discount_amount, tax_amount, total_amount, notes, created_by
           ) VALUES (?, ?, ?, 'DINING', 'IN_PROGRESS', 0, 'FIXED', 0, 0, 0, 0, ?, ?)`,
          [orderNumber, input.customerId || null, input.tableId, input.notes || null, userId]
        );
        await DocumentSequence.assignForNew(ORDER_DOCUMENT, res.lastInsertRowid);
        order = await dbService.queryOne(
          'SELECT id, order_number, status, customer_id, created_at FROM orders WHERE id = ?',
          [res.lastInsertRowid]
        );
      }
      const orderId = order!.id;

      const { lines } = await CheckoutService.verifyLines(items);

      // Nothing on a tab has left stock yet, so this round has to fit
      // alongside what the table already ordered.
      const { lines: earlier } = await CheckoutService.verifyLines(await CheckoutService.loadTabLines(orderId));
      await CheckoutService.assertStock([...earlier, ...lines]);

      const round = await CheckoutService.nextKotRound(orderId);
      await CheckoutService.insertOrderLines(orderId, lines, round);
      await this.recalcOrder(orderId);
      // A new round is cooking again, whatever the kitchen marked before.
      await dbService.execute('UPDATE orders SET kitchen_status = NULL WHERE id = ?', [orderId]);

      if (input.customerId) {
        await dbService.execute('UPDATE orders SET customer_id = ? WHERE id = ?', [input.customerId, orderId]);
      }

      const guests = Number(input.guestCount) || 0;
      await dbService.execute(
        `UPDATE dining_tables
         SET status = 'OCCUPIED',
             current_order_id = ?,
             seated_at = COALESCE(seated_at, NOW()),
             cleaning_started_at = NULL,
             active_guest_count = CASE WHEN ? > 0 THEN ? WHEN active_guest_count > 0 THEN active_guest_count ELSE capacity END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [orderId, guests, guests, input.tableId]
      );

      await AuditService.log({
        userId,
        action: 'DINING_KOT_SENT',
        module: 'DINING',
        recordId: orderId,
        newValues: { tableId: input.tableId, orderNumber: order!.order_number, round, lines: lines.length },
      });

      return { orderNumber: order!.order_number, tableNumber: table.table_number, round, lines };
    });

    const cashier = await dbService.queryOne<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
    const tab = await this.getTab(input.tableId);
    return {
      tab,
      round: result.round,
      kot: {
        kotNumber: `KOT ${result.round} · ${result.orderNumber}`,
        orderNumber: result.orderNumber,
        orderType: 'DINING',
        tableNumber: result.tableNumber,
        orderTime: new Date().toISOString(),
        cashierName: cashier?.name || 'Staff',
        notes: input.notes || undefined,
        items: result.lines.map((l) => ({
          productName: l.productName,
          variantName: l.variantName,
          quantity: l.quantity,
          notes: l.notes,
          isComplimentary: l.isComplimentary,
        })),
      },
    };
  }

  /** Takes a sent line off an unbilled tab (wrong dish, guest changed their mind). */
  static async removeLine(input: { orderItemId: number; reason?: string }, userId: number) {
    await this.ensure();
    const line = await dbService.queryOne<any>(
      `SELECT oi.*, o.status AS order_status, o.dining_table_id, o.order_number
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.id = ? AND o.is_deleted = 0`,
      [input.orderItemId]
    );
    if (!line) throw AppError.notFound('Order line not found');
    if (line.order_status !== 'IN_PROGRESS' && line.order_status !== 'PENDING') {
      throw AppError.badRequest('This order is already billed; void the bill instead.');
    }

    await dbService.transaction(async () => {
      await dbService.execute('DELETE FROM order_items WHERE id = ?', [input.orderItemId]);
      await this.recalcOrder(line.order_id);
    });

    await AuditService.log({
      userId,
      action: 'DINING_TAB_LINE_REMOVED',
      module: 'DINING',
      recordId: line.order_id,
      oldValues: {
        orderNumber: line.order_number,
        product: line.product_name,
        variant: line.variant_name,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        round: line.kot_round,
      },
      newValues: { reason: input.reason || null },
    });

    return await this.getTab(line.dining_table_id);
  }

  /** Closes a tab without billing it (guests left before ordering, or everything was removed). */
  static async cancelTab(input: { tableId: number; reason?: string }, userId: number) {
    await this.ensure();
    const order = await this.findOpenOrder(input.tableId);
    if (!order) throw AppError.notFound('This table has no open tab');

    await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE orders SET status = 'CANCELLED', notes = CONCAT_WS(' | ', notes, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [input.reason ? `Tab cancelled: ${input.reason}` : 'Tab cancelled', order.id]
      );
      await dbService.execute(
        `UPDATE dining_tables
         SET status = 'AVAILABLE', current_order_id = NULL, active_guest_count = 0,
             seated_at = NULL, cleaning_started_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND current_order_id = ?`,
        [input.tableId, order.id]
      );
    });

    await AuditService.log({
      userId,
      action: 'DINING_TAB_CANCELLED',
      module: 'DINING',
      recordId: order.id,
      newValues: { tableId: input.tableId, orderNumber: order.order_number, reason: input.reason || null },
    });

    return { success: true };
  }
}
