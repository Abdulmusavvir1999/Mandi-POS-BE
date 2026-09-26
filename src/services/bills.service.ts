import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { SettingsService } from './settings.service';
import { PaymentMethod, OrderType } from '../models';
import { decorateDocument, decorateDocuments } from '../utils/document-sequence.util';
import { ParamUtil } from '../utils/param.util';

export class BillsService {
  static async getAll(
    page = 1,
    limit = 50,
    search?: string,
    paymentMethod?: PaymentMethod,
    orderType?: OrderType,
    dateFrom?: string,
    dateTo?: string,
    cashierId?: number,
    /**
     * Newest-first by insertion order rather than by timestamp. The Back-Office
     * asks for this; the Bills register keeps the timestamp ordering it has
     * always had.
     */
    sortBy: 'created_at' | 'id' = 'created_at'
  ) {
    const offset = (page - 1) * limit;
    // Withdrawn invoices drop out of the register. They are not gone — the row
    // and its items, payments and refunds are intact — but they are out of the
    // books, so nothing that totals or prints them should see them.
    let where = 'WHERE b.is_deleted = 0';
    const params: any[] = [];

    if (search) {
      where += ' AND (b.bill_number LIKE ? OR o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term, term, term);
    }

    if (paymentMethod) {
      where += ' AND b.payment_method = ?';
      params.push(paymentMethod);
    }

    if (orderType) {
      where += ' AND b.order_type = ?';
      params.push(orderType);
    }

    if (cashierId) {
      where += ' AND b.cashier_id = ?';
      params.push(cashierId);
    }

    if (dateFrom) {
      where += ' AND DATE(b.created_at) >= DATE(?)';
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ' AND DATE(b.created_at) <= DATE(?)';
      params.push(dateTo);
    }

    // Only `search` reaches outside `bills`, so the orders/customers joins are
    // dead weight on every unfiltered request — dropping them takes the count
    // on 40k invoices from ~48ms to ~8ms.
    const filterJoins = search
      ? `LEFT JOIN orders o ON b.order_id = o.id
         LEFT JOIN customers c ON b.customer_id = c.id`
      : '';

    // The id DESC on the timestamp branch is a tiebreaker, not a reordering:
    // several invoices routinely share a created_at to the second, and without
    // it MySQL is free to order those rows differently on each query, so paging
    // could show one twice and skip another.
    const orderBy = sortBy === 'id' ? 'ORDER BY b.id DESC' : 'ORDER BY b.created_at DESC, b.id DESC';

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM bills b
       ${filterJoins}
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    // Deferred join. `LIMIT ? OFFSET ?` applied straight to the five-way join
    // makes MySQL build every joined row up to the offset and throw almost all
    // of them away — page 200 of 40k invoices cost ~4.6s. Paging the ids alone
    // touches only `bills` (served by idx_bills_deleted_created), then the
    // joins run for the fifty rows that survive: same rows, same order, ~14ms.
    const bills = await dbService.query(
      `SELECT b.*, o.order_number, o.display_seq as order_display_seq, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as cashier_name
       FROM (
         SELECT b.id
         FROM bills b
         ${filterJoins}
         ${where}
         ${orderBy}
         LIMIT ? OFFSET ?
       ) pg
       JOIN bills b ON b.id = pg.id
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN dining_tables t ON b.dining_table_id = t.id
       LEFT JOIN users u ON b.cashier_id = u.id
       ${orderBy}`,
      [...params, limit, offset]
    );

    return {
      // `display_number` is the gapless per-day number an operator reads;
      // `bill_number` beside it is the permanent one on the customer's copy.
      data: decorateDocuments(bills as any[], 'bill'),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    const bill = await dbService.queryOne(
      `SELECT b.*, o.order_number, o.display_seq as order_display_seq, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
              t.table_number, t.name as table_name,
              u.name as cashier_name
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN dining_tables t ON b.dining_table_id = t.id
       LEFT JOIN users u ON b.cashier_id = u.id
       WHERE b.id = ? AND b.is_deleted = 0`,
      [id]
    );

    if (!bill) {
      throw AppError.notFound('Bill not found');
    }

    const items = await dbService.query(
      `SELECT bi.*, p.sku, p.image_url
       FROM bill_items bi
       JOIN products p ON bi.product_id = p.id
       WHERE bi.bill_id = ?
       ORDER BY bi.id ASC`,
      [id]
    );

    const payments = await dbService.query(
      'SELECT * FROM payments WHERE bill_id = ?',
      [id]
    );

    return decorateDocument({
      ...(bill as any),
      items,
      payments,
    }, 'bill');
  }

  static async getPrintData(id: number, userId?: number) {
    const bill = await this.getById(id);

    const settingsRows = await dbService.query<{ key: string; value: string }>('SELECT `key`, `value` FROM settings');
    const settingsMap: Record<string, string> = {};
    for (const r of settingsRows) {
      settingsMap[r.key] = r.value;
    }
    SettingsService.applyKeyAliases(settingsMap);

    await dbService.execute('UPDATE bills SET printed_count = printed_count + 1 WHERE id = ?', [id]);

    if (userId) {
      await AuditService.log({
        userId,
        action: 'BILL_PRINTED',
        module: 'BILLS',
        recordId: id,
        newValues: { billNumber: (bill as any).bill_number },
      });
    }

    return {
      bill,
      receiptSettings: {
        businessName: settingsMap['BUSINESS_NAME'] || settingsMap['restaurant_name'] || '',
        phone: settingsMap['BUSINESS_PHONE'] || '',
        email: settingsMap['BUSINESS_EMAIL'] || '',
        address: settingsMap['BUSINESS_ADDRESS'] || '',
        gstin: settingsMap['BUSINESS_GSTIN'] || '',
        currencySymbol: settingsMap['CURRENCY_SYMBOL'] || '₹',
        header: settingsMap['RECEIPT_HEADER'] || '',
        footer: settingsMap['RECEIPT_FOOTER'] || '',
        showLogo: settingsMap['RECEIPT_SHOW_LOGO'] === 'true',
        showTax: settingsMap['RECEIPT_SHOW_TAX'] === 'true',
        showCustomer: settingsMap['RECEIPT_SHOW_CUSTOMER'] === 'true',
        paperWidth: settingsMap['RECEIPT_PAPER_WIDTH'] || '80mm',
      },
    };
  }

  /**
   * Kitchen Order Ticket (KOT) print layout for kitchen and bar printers.
   */
  static async getKotPrintData(id: number) {
    const bill = await this.getById(id);

    return {
      kotNumber: `KOT-${(bill as any).bill_number.replace('INV-', '')}`,
      orderNumber: (bill as any).order_number,
      orderType: (bill as any).order_type,
      tableNumber: (bill as any).table_number || 'Takeaway/Counter',
      tableName: (bill as any).table_name || '',
      cashierName: (bill as any).cashier_name || 'Staff',
      orderTime: (bill as any).created_at,
      notes: (bill as any).notes || '',
      items: (bill as any).items.map((it: any) => ({
        productName: it.product_name,
        variantName: it.variant_name || '',
        quantity: it.quantity,
        notes: it.notes || '',
        isComplimentary: Boolean(it.is_complimentary),
      })),
    };
  }

  /**
   * Void a bill: marks as VOIDED, returns deducted items back to inventory,
   * updates order status, adjusts customer statistics, and logs audit record.
   */
  static async voidBill(id: number, reason: string, userId: number) {
    const billData = await this.getById(id);
    const bill: any = billData;

    if (bill.is_voided || bill.payment_status === 'VOIDED') {
      throw AppError.badRequest('This bill has already been voided');
    }

    if (!reason || !reason.trim()) {
      throw AppError.badRequest('A mandatory reason is required to void this bill');
    }

    return await dbService.transaction(async () => {
      // 1. Update bill status
      await dbService.execute(
        `UPDATE bills
         SET is_voided = TRUE,
             void_reason = ?,
             void_by = ?,
             void_at = CURRENT_TIMESTAMP,
             payment_status = 'VOIDED',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [reason.trim(), userId, id]
      );

      // 2. Update order status
      if (bill.order_id) {
        await dbService.execute(
          `UPDATE orders
           SET status = 'CANCELLED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [bill.order_id]
        );
      }

      // 3. Return stock for each item
      for (const item of bill.items) {
        const stockQty = Number(item.stock_consumption || 1) * Number(item.quantity);

        // Check if item was linked to stock_item
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

      // 4. Adjust customer statistics if registered
      if (bill.customer_id) {
        await dbService.execute(
          `UPDATE customers
           SET total_visits = GREATEST(0, total_visits - 1),
               total_spent = GREATEST(0, total_spent - ?),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [bill.total_amount, bill.customer_id]
        );
      }

      // 5. Audit Log
      await AuditService.log({
        userId,
        action: 'BILL_VOIDED',
        module: 'BILLS',
        recordId: id,
        newValues: {
          billNumber: bill.bill_number,
          reason,
          amountVoided: bill.total_amount,
        },
      });

      return {
        success: true,
        message: `Bill #${bill.bill_number} has been voided and inventory was returned.`,
      };
    });
  }

  /**
   * Reopen a bill: Marks bill as reopened and returns the cart payload
   * so the cashier can edit and re-bill.
   */
  static async reopenBill(id: number, userId: number) {
    const billData = await this.getById(id);
    const bill: any = billData;

    if (bill.is_voided) {
      throw AppError.badRequest('Cannot reopen a voided bill');
    }

    await dbService.execute(
      `UPDATE bills
       SET is_reopened = TRUE,
           reopened_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );

    await AuditService.log({
      userId,
      action: 'BILL_REOPENED',
      module: 'BILLS',
      recordId: id,
      newValues: { billNumber: bill.bill_number },
    });

    return {
      originalBillId: bill.id,
      billNumber: bill.bill_number,
      orderType: bill.order_type,
      customerId: bill.customer_id,
      customerName: bill.customer_name,
      customerPhone: bill.customer_phone,
      diningTableId: bill.dining_table_id,
      tableNumber: bill.table_number,
      tableName: bill.table_name,
      discountType: bill.discount_type,
      discountValue: bill.discount_value,
      serviceChargeAmount: bill.service_charge_amount,
      surchargeAmount: bill.surcharge_amount,
      couponCode: bill.coupon_code,
      couponDiscount: bill.coupon_discount,
      notes: bill.notes,
      items: bill.items.map((it: any) => ({
        productId: it.product_id,
        productName: it.product_name,
        variantId: it.variant_id,
        variantName: it.variant_name,
        quantity: it.quantity,
        unitPrice: it.unit_price,
        notes: it.notes,
        isComplimentary: Boolean(it.is_complimentary),
        complimentaryReason: it.complimentary_reason,
      })),
    };
  }

  /**
   * Duplicate a bill: Returns items and customer payload ready to insert into active cart.
   */
  static async getDuplicateOrderData(id: number) {
    const billData = await this.getById(id);
    const bill: any = billData;

    return {
      orderType: bill.order_type,
      customerId: bill.customer_id,
      customerName: bill.customer_name,
      customerPhone: bill.customer_phone,
      notes: bill.notes,
      items: bill.items.map((it: any) => ({
        productId: it.product_id,
        productName: it.product_name,
        variantId: it.variant_id,
        variantName: it.variant_name,
        quantity: it.quantity,
        unitPrice: it.unit_price,
        notes: it.notes,
        isComplimentary: false,
      })),
    };
  }
}
