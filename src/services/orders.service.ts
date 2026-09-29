import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { CheckoutService } from './checkout.service';
import { SettingsService } from './settings.service';
import { OrderStatus, OrderType } from '../models';
import { SequenceUtil } from '../utils/sequence.util';
import { DocumentSequence, ORDER_DOCUMENT, decorateDocument, decorateDocuments } from '../utils/document-sequence.util';
import { ParamUtil } from '../utils/param.util';
import { splitTax } from '../utils/tax.util';

export class OrdersService {
  static async getAll(
    page = 1,
    limit = 50,
    status?: OrderStatus,
    orderType?: OrderType,
    search?: string,
    diningTableId?: number,
    dateFrom?: string,
    dateTo?: string
  ) {
    const offset = (page - 1) * limit;
    // Withdrawn orders drop off the board and out of every list, while their
    // items and status history stay on the record.
    let where = 'WHERE o.is_deleted = 0';
    const params: any[] = [];

    if (status) {
      where += ' AND o.status = ?';
      params.push(status);
    }

    if (orderType) {
      where += ' AND o.order_type = ?';
      params.push(orderType);
    }

    if (diningTableId) {
      where += ' AND o.dining_table_id = ?';
      params.push(diningTableId);
    }

    if (search) {
      where += ' AND (o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term, term);
    }

    if (dateFrom) {
      where += ' AND DATE(o.created_at) >= DATE(?)';
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ' AND DATE(o.created_at) <= DATE(?)';
      params.push(dateTo);
    }

    // Only `search` reaches outside `orders`, so the customers join is dead
    // weight on an unfiltered count.
    const filterJoins = search ? 'LEFT JOIN customers c ON o.customer_id = c.id' : '';

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM orders o
       ${filterJoins}
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    // Deferred join, as in BillsService.getAll: page the ids off `orders`
    // alone, then join and run the per-row item_count subquery for the page
    // that survives instead of for every row scanned up to the offset.
    const orders = await dbService.query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM (
         SELECT o.id
         FROM orders o
         ${filterJoins}
         ${where}
         ORDER BY o.created_at DESC
         LIMIT ? OFFSET ?
       ) pg
       JOIN orders o ON o.id = pg.id
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u ON o.created_by = u.id
       ORDER BY o.created_at DESC`,
      [...params, limit, offset]
    );

    if (orders.length > 0) {
      const orderIds = orders.map((o: any) => o.id);
      const items = await dbService.query(
        `SELECT oi.*, COALESCE(p.sku, cd.combo_code) AS sku, COALESCE(p.image_url, pa.image_url, cd.image_url) AS image_url
         FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         LEFT JOIN product_addons pa ON pa.id = oi.addon_id
         LEFT JOIN combo_deals cd ON cd.id = oi.combo_id
         WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );
      const itemsByOrder: Record<number, any[]> = {};
      for (const item of items) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }
      for (const o of orders) {
        o.items = itemsByOrder[o.id] || [];
      }
    }

    return {
      // `display_number` is the gapless per-day number an operator reads;
      // `order_number` beside it is the permanent one on the receipt.
      data: decorateDocuments(orders as any[]),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    const order = await dbService.queryOne(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              b.bill_number, b.display_seq as bill_display_seq, b.id as bill_id, b.payment_status, b.payment_method
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN bills b ON b.order_id = o.id AND b.is_deleted = 0
       WHERE o.id = ? AND o.is_deleted = 0`,
      [id]
    );

    if (!order) {
      throw AppError.notFound('Order not found');
    }

    const items = await dbService.query(
      `SELECT oi.*, COALESCE(p.sku, cd.combo_code) AS sku, COALESCE(p.image_url, pa.image_url, cd.image_url) AS image_url
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN product_addons pa ON pa.id = oi.addon_id
       LEFT JOIN combo_deals cd ON cd.id = oi.combo_id
       WHERE oi.order_id = ?`,
      [id]
    );

    const history = await this.lifecycle(id);

    return decorateDocument({
      ...(order as any),
      items,
      history,
    });
  }

  /**
   * The order's timeline for the kitchen drawer, read from audit_logs (the
   * order_status_history table was dropped: it only duplicated these
   * entries). Covers creation, status changes, kitchen rounds, removed
   * lines, a cancelled tab and the bill that closed it.
   */
  private static async lifecycle(orderId: number) {
    const rows = await dbService.query<any>(
      `SELECT a.id, a.action, a.old_values, a.new_values, a.created_at, u.name AS changed_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE (a.record_id = ? AND (
                (a.module = 'ORDERS' AND a.action IN ('ORDER_CREATED', 'ORDER_STATUS_CHANGED', 'ORDER_KITCHEN_READY', 'ORDER_CANCELLED_BY_INVOICE_DELETE'))
             OR (a.module = 'DINING' AND a.action IN ('DINING_KOT_SENT', 'DINING_TAB_LINE_REMOVED', 'DINING_TAB_CANCELLED'))))
          OR (a.module = 'CHECKOUT' AND a.action = 'ORDER_CHECKOUT_COMPLETED'
              AND a.record_id IN (SELECT CAST(b.id AS CHAR) FROM bills b WHERE b.order_id = ?))
       ORDER BY a.created_at ASC, a.id ASC`,
      [String(orderId), orderId]
    );

    const parse = (raw: any) => {
      if (!raw) return {};
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(raw) || {};
      } catch (_) {
        return {};
      }
    };

    return rows.map((r) => {
      const oldV = parse(r.old_values);
      const newV = parse(r.new_values);
      let status = '';
      let notes = '';
      switch (r.action) {
        case 'ORDER_CREATED':
          status = 'IN_PROGRESS';
          notes = 'Order created';
          break;
        case 'ORDER_STATUS_CHANGED':
          status = newV.status || '';
          notes = newV.notes || `Status updated to ${status}`;
          break;
        case 'ORDER_CANCELLED_BY_INVOICE_DELETE':
          status = 'CANCELLED';
          notes = newV.notes || 'Invoice deleted from Back-Office';
          break;
        case 'ORDER_KITCHEN_READY':
          status = 'SERVED';
          notes = newV.notes || 'Kitchen: served, bill still open';
          break;
        case 'DINING_KOT_SENT':
          status = `KOT ${newV.round ?? ''}`.trim();
          notes = `${newV.lines ?? ''} ${Number(newV.lines) === 1 ? 'line' : 'lines'} sent to the kitchen`.trim();
          break;
        case 'DINING_TAB_LINE_REMOVED':
          status = 'ITEM REMOVED';
          notes = `${oldV.quantity ?? ''}× ${oldV.product ?? 'item'}${newV.reason ? ` · ${newV.reason}` : ''}`.trim();
          break;
        case 'DINING_TAB_CANCELLED':
          status = 'CANCELLED';
          notes = newV.reason ? `Tab cancelled: ${newV.reason}` : 'Tab cancelled';
          break;
        case 'ORDER_CHECKOUT_COMPLETED':
          status = 'COMPLETED';
          notes = `Billed ${newV.billNumber || ''} · ${newV.paymentMethod || ''}`.trim();
          break;
      }
      return {
        id: r.id,
        previous_status: oldV.status || null,
        new_status: status,
        notes,
        changed_by_name: r.changed_by_name || null,
        created_at: r.created_at,
      };
    });
  }

  static async create(data: {
    customerId?: number | null;
    diningTableId?: number | null;
    orderType: OrderType;
    discountType?: 'FIXED' | 'PERCENTAGE';
    discountValue?: number;
    notes?: string;
    items: Array<{ productId: number; quantity: number; unitPrice?: number; notes?: string }>;
  }, userId: number) {
    if (!data.items || data.items.length === 0) {
      throw AppError.badRequest('Order must contain at least one item');
    }

    return await dbService.transaction(async () => {
      // Validate Dining Table if applicable
      if (data.orderType === 'DINING') {
        if (!data.diningTableId) {
          throw AppError.badRequest('Dining order requires a selected table');
        }
        const table = await dbService.queryOne<{ id: number; status: string; current_order_id: number }>(
          'SELECT id, status, current_order_id FROM dining_tables WHERE id = ?',
          [data.diningTableId]
        );
        if (!table) {
          throw AppError.badRequest('Selected dining table does not exist');
        }
        if (table.status === 'OCCUPIED' && table.current_order_id) {
          throw AppError.badRequest('Table is already occupied with an active order');
        }
      }

      // Generate Order Number
      const orderNumber = await SequenceUtil.nextDailyNumber('orders', 'order_number', 'ORD');

      let subtotal = 0;
      const calculatedItems: any[] = [];

      for (const item of data.items) {
        // `products.cost_price` no longer exists — cost lives on the stock
        // ledger now. Without this join the order line was written with an
        // undefined cost, which mysql2 stores as NULL, so every order silently
        // lost its cost basis and margin reporting had nothing to read.
        const product = await dbService.queryOne<{
          id: number;
          name: string;
          selling_price: number;
          cost_price: number;
          tax_rate: number;
          status: string;
        }>(
          `SELECT p.*, COALESCE(si.average_unit_price, 0) AS cost_price
           FROM products p
           LEFT JOIN stocks si ON si.id = p.stock_id
           WHERE p.id = ?`,
          [item.productId]
        );

        if (!product) {
          throw AppError.badRequest(`Product ID ${item.productId} not found`);
        }

        if (product.status !== 'ACTIVE') {
          throw AppError.badRequest(`Product "${product.name}" is inactive and cannot be ordered`);
        }

        let variantPrice = 0;
        const variant = await dbService.queryOne<{ selling_price: number }>(
          'SELECT selling_price FROM product_variants WHERE product_id = ? ORDER BY is_default DESC, display_order ASC, id ASC LIMIT 1',
          [product.id]
        );
        if (variant) {
          variantPrice = Number(variant.selling_price);
        }
        const unitPrice = item.unitPrice !== undefined ? item.unitPrice : variantPrice;
        const itemSubtotal = unitPrice * item.quantity;
        subtotal += itemSubtotal;

        calculatedItems.push({
          productId: product.id,
          productName: product.name,
          unitPrice,
          costPrice: product.cost_price,
          quantity: item.quantity,
          subtotal: itemSubtotal,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: itemSubtotal,
          notes: item.notes || null,
        });
      }

      // Calculate Discount
      let discountAmount = 0;
      if (data.discountValue && data.discountValue > 0) {
        if (data.discountType === 'PERCENTAGE') {
          discountAmount = (subtotal * Math.min(data.discountValue, 100)) / 100;
        } else {
          discountAmount = Math.min(data.discountValue, subtotal);
        }
      }

      // Calculate Tax based on settings. Under INCLUSIVE the menu price
      // already contains the tax, so the order total is the taxable base
      // itself and the tax is only recorded, never added.
      const taxPolicy = await SettingsService.getTaxPolicy();

      const taxableAmount = Math.max(0, subtotal - discountAmount);
      const { tax: taxAmount, gross: totalAmount } = splitTax(taxableAmount, taxPolicy);

      // Insert Order. There is no separate "new" stage: an order is Processing
      // (IN_PROGRESS) from the moment it is placed until it is completed.
      const res = await dbService.execute(
        `INSERT INTO orders (
          order_number, customer_id, dining_table_id, order_type,
          status, subtotal, discount_type, discount_value,
          discount_amount, tax_amount, total_amount, notes, created_by
        ) VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber,
          data.customerId || null,
          data.diningTableId || null,
          ParamUtil.orderType(data.orderType),
          subtotal,
          data.discountType || 'FIXED',
          data.discountValue || 0.0,
          discountAmount,
          taxAmount,
          totalAmount,
          data.notes || null,
          userId,
        ]
      );

      const orderId = res.lastInsertRowid;

      // Gapless position within the day, so a list never shows a hole left by
      // a withdrawn order. Separate from `order_number`, which stays permanent.
      await DocumentSequence.assignForNew(ORDER_DOCUMENT, orderId);

      // Insert Order Items
      for (const item of calculatedItems) {
        await dbService.execute(
          `INSERT INTO order_items (
            order_id, product_id, product_name, unit_price, cost_price,
            quantity, subtotal, discount_amount, tax_amount, total_amount, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
            item.productId,
            item.productName,
            item.unitPrice,
            item.costPrice,
            item.quantity,
            item.subtotal,
            item.discountAmount,
            item.taxAmount,
            item.totalAmount,
            item.notes,
          ]
        );
      }

      // Lock Dining table if Dining
      if (data.orderType === 'DINING' && data.diningTableId) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'OCCUPIED', current_order_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [orderId, data.diningTableId]
        );
      }

      await AuditService.log({
        userId,
        action: 'ORDER_CREATED',
        module: 'ORDERS',
        recordId: orderId,
        newValues: { orderNumber, orderType: data.orderType, totalAmount },
      });

      return await this.getById(orderId);
    });
  }

  static async updateStatus(id: number, newStatus: OrderStatus, userId: number, notes?: string) {
    const order = await this.getById(id);

    // State Transition Rules (Section 39)
    const validTransitions: Record<OrderStatus, OrderStatus[]> = {
      // PENDING is no longer produced; an old one may still finish or be cancelled.
      PENDING: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [], // terminal state
      CANCELLED: [], // terminal state
    };

    const currentStatus = order.status as OrderStatus;
    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw AppError.badRequest(`Invalid status transition from ${currentStatus} to ${newStatus}`);
    }

    // An open dining tab is COMPLETED by its bill, not by the kitchen. When
    // the kitchen marks it ready, record that and leave the order open -
    // closing it here let the table be released with the food never billed.
    if (newStatus === 'COMPLETED' && order.dining_table_id) {
      const bill = await dbService.queryOne<{ id: number }>(
        'SELECT id FROM bills WHERE order_id = ? AND is_deleted = 0 LIMIT 1',
        [id]
      );
      if (!bill) {
        await CheckoutService.ensureSchema();
        await dbService.execute(
          `UPDATE orders SET kitchen_status = 'READY', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [id]
        );
        await AuditService.log({
          userId,
          action: 'ORDER_KITCHEN_READY',
          module: 'ORDERS',
          recordId: id,
          newValues: { kitchenStatus: 'READY', notes },
        });
        return await this.getById(id);
      }
    }

    return await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE orders
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newStatus, id]
      );

      // If cancelled and was dining, release table
      if (newStatus === 'CANCELLED' && order.dining_table_id) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'AVAILABLE', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [order.dining_table_id]
        );
      }

      await AuditService.log({
        userId,
        action: 'ORDER_STATUS_CHANGED',
        module: 'ORDERS',
        recordId: id,
        oldValues: { status: currentStatus },
        newValues: { status: newStatus, notes },
      });

      return await this.getById(id);
    });
  }
}
