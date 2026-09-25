import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
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

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const orders = await dbService.query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u ON o.created_by = u.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    if (orders.length > 0) {
      const orderIds = orders.map((o: any) => o.id);
      const items = await dbService.query(
        `SELECT oi.*, p.sku, p.image_url
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
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
      `SELECT oi.*, p.sku, p.image_url
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?`,
      [id]
    );

    const history = await dbService.query(
      `SELECT h.*, u.name as changed_by_name
       FROM order_status_history h
       LEFT JOIN users u ON h.changed_by = u.id
       WHERE h.order_id = ?
       ORDER BY h.created_at ASC`,
      [id]
    );

    return decorateDocument({
      ...(order as any),
      items,
      history,
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
        const product = await dbService.queryOne<{
          id: number;
          name: string;
          selling_price: number;
          cost_price: number;
          tax_rate: number;
          status: string;
        }>('SELECT * FROM products WHERE id = ?', [item.productId]);

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

      // Insert Order
      const res = await dbService.execute(
        `INSERT INTO orders (
          order_number, customer_id, dining_table_id, order_type,
          status, subtotal, discount_type, discount_value,
          discount_amount, tax_amount, total_amount, notes, created_by
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?)`,
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

      // Record Order History
      await dbService.execute(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
         VALUES (?, NULL, 'PENDING', ?, 'Order created')`,
        [orderId, userId]
      );

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
      PENDING: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [], // terminal state
      CANCELLED: [], // terminal state
    };

    const currentStatus = order.status as OrderStatus;
    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw AppError.badRequest(`Invalid status transition from ${currentStatus} to ${newStatus}`);
    }

    return await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE orders
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newStatus, id]
      );

      await dbService.execute(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [id, currentStatus, newStatus, userId, notes || `Status updated to ${newStatus}`]
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
