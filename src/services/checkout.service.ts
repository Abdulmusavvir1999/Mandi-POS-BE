import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { SettingsService } from './settings.service';
import { AuditService } from './audit.service';
import { OrderType, PaymentMethod } from '../models';
import { SequenceUtil } from '../utils/sequence.util';
import { DocumentSequence, ORDER_DOCUMENT, BILL_DOCUMENT } from '../utils/document-sequence.util';
import { logger } from '../config/logger';
import { splitTax } from '../utils/tax.util';
import { ParamUtil } from '../utils/param.util';

export interface CheckoutPayload {
  customerId?: number | null;
  diningTableId?: number | null;
  existingOrderId?: number | null;
  orderType: OrderType;
  discountType?: 'FIXED' | 'PERCENTAGE';
  discountValue?: number;
  serviceChargeAmount?: number;
  surchargeAmount?: number;
  couponCode?: string;
  couponDiscount?: number;
  cashTendered?: number;
  changeReturned?: number;
  offlineSyncId?: string;
  paymentMethod: PaymentMethod;
  paymentAmount?: number;
  paymentReference?: string;
  notes?: string;
  items: Array<{
    productId: number;
    variantId?: number | null;
    quantity: number;
    notes?: string;
    isComplimentary?: boolean;
    complimentaryReason?: string;
    selectedAddons?: Array<{ id: number; name: string; price: number; quantity?: number }>;
    itemType?: 'PRODUCT' | 'COMBO';
    comboId?: number | null;
  }>;
}

export class CheckoutService {
  private static schemaEnsured = false;

  /**
   * Auto-ensures billing, void, offline sync columns and day closing table exist.
   */
  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      // 1. Expand columns
      try {
        await dbService.execute("ALTER TABLE orders MODIFY COLUMN order_type VARCHAR(30) NOT NULL");
        await dbService.execute("ALTER TABLE bills MODIFY COLUMN order_type VARCHAR(30) NOT NULL");
        await dbService.execute("ALTER TABLE bills MODIFY COLUMN payment_method VARCHAR(30) NOT NULL");
        await dbService.execute("ALTER TABLE bills MODIFY COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID'");
      } catch (_) {}

      // 2. Add columns to bills
      const addCol = async (table: string, col: string, def: string) => {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = ? 
              AND COLUMN_NAME = ?
          `, [table, col]);
          if (!colCheck || colCheck.count === 0) {
            await dbService.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        } catch (e) {
          logger.warn(`Could not add column ${col} to ${table}:`, e);
        }
      };

      await addCol('bills', 'service_charge_amount', 'DECIMAL(10,2) DEFAULT 0.00');
      await addCol('bills', 'surcharge_amount', 'DECIMAL(10,2) DEFAULT 0.00');
      await addCol('bills', 'coupon_code', 'VARCHAR(50) NULL');
      await addCol('bills', 'coupon_discount', 'DECIMAL(10,2) DEFAULT 0.00');
      await addCol('bills', 'cash_tendered', 'DECIMAL(10,2) NULL');
      await addCol('bills', 'change_returned', 'DECIMAL(10,2) NULL');
      await addCol('bills', 'payment_reference', 'VARCHAR(100) NULL');
      await addCol('bills', 'is_voided', 'BOOLEAN DEFAULT FALSE');
      await addCol('bills', 'void_reason', 'TEXT NULL');
      await addCol('bills', 'void_by', 'INT NULL');
      await addCol('bills', 'void_at', 'DATETIME NULL');
      await addCol('bills', 'is_reopened', 'BOOLEAN DEFAULT FALSE');
      await addCol('bills', 'reopened_from_bill_id', 'INT NULL');
      await addCol('bills', 'reopened_at', 'DATETIME NULL');
      await addCol('bills', 'offline_sync_id', 'VARCHAR(100) NULL');

      // Add columns to order_items and bill_items
      await addCol('order_items', 'addons_data', 'TEXT NULL');
      await addCol('order_items', 'item_type', "VARCHAR(30) DEFAULT 'PRODUCT'");
      await addCol('order_items', 'combo_id', 'INT NULL');
      // Legacy: Meal Deals were withdrawn and nothing writes deal_id any more,
      // but sales settled while they existed still carry it, so the column is
      // still ensured rather than dropped.
      await addCol('order_items', 'deal_id', 'INT NULL');

      await addCol('bill_items', 'is_complimentary', 'BOOLEAN DEFAULT FALSE');
      await addCol('bill_items', 'complimentary_reason', 'VARCHAR(255) NULL');
      await addCol('bill_items', 'addons_data', 'TEXT NULL');
      await addCol('bill_items', 'item_type', "VARCHAR(30) DEFAULT 'PRODUCT'");
      await addCol('bill_items', 'combo_id', 'INT NULL');
      // Legacy, as for order_items above.
      await addCol('bill_items', 'deal_id', 'INT NULL');

      // Soft delete for orders and invoices (see soft_delete_migration.sql).
      //
      // An administrator withdrawing a record from the Back-Office no longer
      // destroys it: the row and its items, payments and refunds stay put, and
      // `is_deleted` takes them out of every figure and every list.
      // Deliberately distinct from `is_voided` — a void is a sale cancelled at
      // the till and remains real history; a delete is a record pulled from
      // the books by an admin.
      //
      // Owned here rather than in the orders or back-office module because
      // this is already where the bills and orders column migrations live, and
      // it is chained from ReportsSchema.ensure(), so every reader that
      // filters on the column is guaranteed to find it.
      for (const table of ['orders', 'bills']) {
        await addCol(table, 'is_deleted', 'TINYINT(1) NOT NULL DEFAULT 0');
        await addCol(table, 'deleted_at', 'DATETIME NULL');
        await addCol(table, 'deleted_by', 'INT NULL');
        await addCol(table, 'delete_reason', 'TEXT NULL');
      }

      // Every read now carries `is_deleted = 0`, usually beside a date range.
      // MySQL has no CREATE INDEX IF NOT EXISTS, so each one is probed first.
      const softDeleteIndexes: [string, string, string][] = [
        ['idx_orders_is_deleted', 'orders', 'is_deleted'],
        ['idx_orders_deleted_created', 'orders', 'is_deleted, created_at'],
        ['idx_bills_is_deleted', 'bills', 'is_deleted'],
        ['idx_bills_deleted_created', 'bills', 'is_deleted, created_at'],
      ];
      for (const [name, table, columns] of softDeleteIndexes) {
        try {
          const exists = await dbService.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
            [table, name]
          );
          if (!exists || Number(exists.count) === 0) {
            await dbService.execute(`CREATE INDEX ${name} ON ${table}(${columns})`);
          }
        } catch (e) {
          logger.warn(`Could not create index ${name} on ${table}:`, e);
        }
      }

      // The gapless per-day position for orders and invoices. Must come after
      // `is_deleted` exists: the backfill numbers active rows only.
      await DocumentSequence.ensureSchema(ORDER_DOCUMENT);
      await DocumentSequence.ensureSchema(BILL_DOCUMENT);

      // 3. Create pos_day_closings table
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS pos_day_closings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          closing_number VARCHAR(50) UNIQUE NOT NULL,
          user_id INT NOT NULL,
          cashier_name VARCHAR(100) NULL,
          opening_time DATETIME NOT NULL,
          closing_time DATETIME NOT NULL,
          opening_cash DECIMAL(10,2) DEFAULT 0.00,
          total_cash_sales DECIMAL(10,2) DEFAULT 0.00,
          total_card_sales DECIMAL(10,2) DEFAULT 0.00,
          total_upi_sales DECIMAL(10,2) DEFAULT 0.00,
          total_online_sales DECIMAL(10,2) DEFAULT 0.00,
          gross_sales DECIMAL(10,2) DEFAULT 0.00,
          total_discounts DECIMAL(10,2) DEFAULT 0.00,
          total_tax DECIMAL(10,2) DEFAULT 0.00,
          total_service_charges DECIMAL(10,2) DEFAULT 0.00,
          total_bills_count INT DEFAULT 0,
          void_bills_count INT DEFAULT 0,
          void_bills_amount DECIMAL(10,2) DEFAULT 0.00,
          expected_cash DECIMAL(10,2) DEFAULT 0.00,
          actual_cash DECIMAL(10,2) DEFAULT 0.00,
          cash_variance DECIMAL(10,2) DEFAULT 0.00,
          notes TEXT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_day_closing_user (user_id),
          INDEX idx_day_closing_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      this.schemaEnsured = true;
    } catch (err) {
      logger.error('Failed to ensure checkout schema:', err);
    }
  }

  static async processCheckout(payload: CheckoutPayload, cashierId: number) {
    await this.ensureSchema();

    if (!payload.items || payload.items.length === 0) {
      throw AppError.badRequest('Cart is empty. Please add items to checkout.');
    }

    // Check for duplicate offline sync
    if (payload.offlineSyncId) {
      const existingOffline = await dbService.queryOne<{ id: number; bill_number: string }>(
        'SELECT id, bill_number FROM bills WHERE offline_sync_id = ? AND is_deleted = 0',
        [payload.offlineSyncId]
      );
      if (existingOffline) {
        return await this.getBillSummary(existingOffline.id);
      }
    }

    // The configured tax rule: the rate, whether tax is charged at all, and
    // whether the menu price already contains it. The till works to the same
    // three, so its grand total and this one agree — they have to, since the
    // payment check below rejects anything under the total computed here.
    const taxPolicy = await SettingsService.getTaxPolicy();

    return await dbService.transaction(async () => {
      // 1. Verify items & Stock availability
      let subtotal = 0;
      const verifiedItems: Array<{
        productId: number;
        productName: string;
        variantId: number | null;
        variantName: string | null;
        stockConsumption: number;
        requiredStock: number;
        unitPrice: number;
        costPrice: number;
        quantity: number;
        subtotal: number;
        discountAmount: number;
        taxAmount: number;
        totalAmount: number;
        notes?: string;
        currentStock: number;
        stockItemId: number | null;
        isComplimentary: boolean;
        complimentaryReason: string | null;
        addonsData: string | null;
        itemType: string;
        comboId: number | null;
      }> = [];

      for (const item of payload.items) {
        const product = await dbService.queryOne<any>(
          'SELECT * FROM products WHERE id = ?',
          [item.productId]
        );

        if (!product) {
          throw AppError.notFound(`Product with ID ${item.productId} not found`);
        }

        if (product.status !== 'ACTIVE' || !product.is_available) {
          throw AppError.badRequest(`Product "${product.name}" is currently unavailable for order.`);
        }

        let variant: any = null;
        if (item.variantId) {
          variant = await dbService.queryOne<any>(
            'SELECT * FROM product_variants WHERE id = ? AND product_id = ?',
            [item.variantId, item.productId]
          );
          if (!variant) {
            throw AppError.notFound(`Variant ${item.variantId} not found for product "${product.name}"`);
          }
        }

        // Inventory check
        const targetStockItemId = variant?.stock_item_id ?? product.stock_item_id;
        const stockConsumption = variant ? Number(variant.stock_consumption || 1) : 1.0;
        const requiredStock = stockConsumption * item.quantity;

        let currentStock = 0;
        let stockItem: any = null;

        if (targetStockItemId) {
          stockItem = await dbService.queryOne<any>(
            'SELECT * FROM stock_items WHERE id = ?',
            [targetStockItemId]
          );
          currentStock = stockItem ? Number(stockItem.current_quantity) : 0;
        } else {
          const legacyStock = await dbService.queryOne<any>(
            'SELECT current_stock FROM stock WHERE product_id = ?',
            [product.id]
          );
          currentStock = legacyStock ? Number(legacyStock.current_stock) : Number(product.stock_quantity || 0);
        }

        const allowNegativeStock = false;
        if (!allowNegativeStock && currentStock < requiredStock) {
          const label = variant ? `${product.name} (${variant.name})` : product.name;
          const unit = stockItem?.unit_type ? ` ${stockItem.unit_type}` : '';
          throw AppError.badRequest(
            `Insufficient stock for "${label}". Available: ${currentStock}${unit}, Required: ${requiredStock}${unit}`
          );
        }

        const isComp = Boolean(item.isComplimentary);
        if (!variant) {
          variant = await dbService.queryOne<any>(
            'SELECT * FROM product_variants WHERE product_id = ? ORDER BY is_default DESC, display_order ASC, id ASC LIMIT 1',
            [item.productId]
          );
        }
        const baseUnitPrice = variant ? Number(variant.selling_price) : (Number((item as any).unitPrice) || 0);
        const addonsPrice = (item.selectedAddons || []).reduce((sum, a) => sum + (Number(a.price) || 0) * (a.quantity || 1), 0);
        // If complimentary, price charged is 0
        const unitPrice = isComp ? 0 : (baseUnitPrice + addonsPrice);
        const itemSubtotal = unitPrice * item.quantity;
        subtotal += itemSubtotal;

        verifiedItems.push({
          productId: product.id,
          productName: product.name,
          variantId: variant ? variant.id : null,
          variantName: variant ? variant.name : null,
          stockConsumption,
          requiredStock,
          unitPrice,
          costPrice: (stockItem ? Number(stockItem.average_unit_price) : 0),
          quantity: item.quantity,
          subtotal: itemSubtotal,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: itemSubtotal,
          notes: item.notes,
          currentStock,
          stockItemId: stockItem ? stockItem.id : null,
          isComplimentary: isComp,
          complimentaryReason: isComp ? (item.complimentaryReason || 'Staff Authorized Complimentary') : null,
          addonsData: item.selectedAddons && item.selectedAddons.length > 0 ? JSON.stringify(item.selectedAddons) : null,
          itemType: item.itemType || 'PRODUCT',
          comboId: item.comboId || null,
        });
      }

      // 3. Discount calculation
      let discountAmount = 0;
      const discountVal = payload.discountValue || 0;
      if (discountVal > 0) {
        if (payload.discountType === 'PERCENTAGE') {
          if (discountVal > 100) {
            throw AppError.badRequest('Discount percentage cannot exceed 100%');
          }
          discountAmount = (subtotal * discountVal) / 100;
        } else {
          if (discountVal > subtotal) {
            throw AppError.badRequest('Fixed discount cannot exceed subtotal amount');
          }
          discountAmount = discountVal;
        }
      }

      const couponDiscount = Math.max(0, Number(payload.couponDiscount) || 0);
      const totalDiscounts = Math.min(subtotal, discountAmount + couponDiscount);

      // 4. Tax & Additional Charges (Service Charge & Surcharges)
      //
      // splitTax carries both rules: under EXCLUSIVE `taxedAmount` is the
      // taxable base plus the tax, under INCLUSIVE it is the base itself with
      // the tax already inside it. `subtotal` stays what the guest was
      // quoted either way, and `taxAmount` is what the GST return needs.
      const taxableAmount = Math.max(0, subtotal - totalDiscounts);
      const { tax: taxAmount, gross: taxedAmount } = splitTax(taxableAmount, taxPolicy);
      const serviceCharge = Math.max(0, Number(payload.serviceChargeAmount) || 0);
      const surcharge = Math.max(0, Number(payload.surchargeAmount) || 0);
      const grandTotal = Math.round((taxedAmount + serviceCharge + surcharge) * 100) / 100;

      const paymentAmount = payload.paymentAmount !== undefined ? payload.paymentAmount : grandTotal;
      if (paymentAmount < grandTotal) {
        throw AppError.badRequest(`Payment amount (${paymentAmount}) cannot be less than Grand Total (${grandTotal})`);
      }

      const cashTendered = payload.paymentMethod === 'CASH' && payload.cashTendered
        ? Number(payload.cashTendered)
        : paymentAmount;
      const changeReturned = Math.max(0, cashTendered - grandTotal);

      // 5. Create or reuse Order
      let orderId: number;
      let orderNumber: string;

      if (payload.existingOrderId) {
        const existingOrder = await dbService.queryOne<{ id: number; order_number: string; status: string }>(
          'SELECT id, order_number, status FROM orders WHERE id = ? AND is_deleted = 0',
          [payload.existingOrderId]
        );
        if (!existingOrder) {
          throw AppError.notFound(`Order ${payload.existingOrderId} not found.`);
        }
        orderId = existingOrder.id;
        orderNumber = existingOrder.order_number;

        await dbService.execute(
          `UPDATE orders 
           SET status = 'COMPLETED', subtotal = ?, discount_type = ?, discount_value = ?,
               discount_amount = ?, tax_amount = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            subtotal,
            payload.discountType || 'FIXED',
            discountVal,
            totalDiscounts,
            taxAmount,
            grandTotal,
            orderId,
          ]
        );
      } else {
        orderNumber = await SequenceUtil.nextDailyNumber('orders', 'order_number', 'ORD');

        const orderRes = await dbService.execute(
          `INSERT INTO orders (
            order_number, customer_id, dining_table_id, order_type,
            status, subtotal, discount_type, discount_value,
            discount_amount, tax_amount, total_amount, notes, created_by
          ) VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderNumber,
            payload.customerId || null,
            payload.diningTableId || null,
            ParamUtil.orderType(payload.orderType),
            subtotal,
            payload.discountType || 'FIXED',
            discountVal,
            totalDiscounts,
            taxAmount,
            grandTotal,
            payload.notes || null,
            cashierId,
          ]
        );
        orderId = orderRes.lastInsertRowid;

        // Gapless position within the day, so a list never shows a hole left
        // by a withdrawn order. Separate from `order_number`, which stays
        // permanent because it is printed on the receipt.
        await DocumentSequence.assignForNew(ORDER_DOCUMENT, orderId);
      }

      // Order Items & Stock Deductions
      for (const item of verifiedItems) {
        await dbService.execute(
          `INSERT INTO order_items (
            order_id, product_id, product_name, variant_id, variant_name,
            stock_consumption, unit_price, quantity, subtotal,
            discount_amount, tax_amount, total_amount, addons_data, item_type, combo_id, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
          [
            orderId,
            item.productId,
            item.productName,
            item.variantId,
            item.variantName,
            item.stockConsumption,
            item.unitPrice,
            item.quantity,
            item.subtotal,
            item.subtotal,
            item.addonsData,
            item.itemType,
            item.comboId,
            item.notes || null,
          ]
        );

        // Deduct inventory
        if (item.stockItemId) {
          await dbService.execute(
            'UPDATE stock_items SET current_quantity = current_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [item.requiredStock, item.stockItemId]
          );
        } else {
          await dbService.execute(
            'UPDATE stock SET current_stock = current_stock - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?',
            [item.requiredStock, item.productId]
          );
        }
      }

      // 6. Generate Sequential Bill Number
      const billNumber = await SequenceUtil.nextDailyNumber('bills', 'bill_number', 'INV');

      // 7. Create Bill Record
      const billRes = await dbService.execute(
        `INSERT INTO bills (
          bill_number, order_id, customer_id, dining_table_id, cashier_id,
          order_type, subtotal, discount_type, discount_value,
          discount_amount, tax_amount, service_charge_amount, surcharge_amount,
          coupon_code, coupon_discount, total_amount, payment_status,
          payment_method, cash_tendered, change_returned, offline_sync_id, notes, printed_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, ?, ?, ?, ?, 0)`,
        [
          billNumber,
          orderId,
          payload.customerId || null,
          payload.diningTableId || null,
          cashierId,
          ParamUtil.orderType(payload.orderType),
          subtotal,
          payload.discountType || 'FIXED',
          discountVal,
          discountAmount,
          taxAmount,
          serviceCharge,
          surcharge,
          payload.couponCode || null,
          couponDiscount,
          grandTotal,
          payload.paymentMethod,
          cashTendered,
          changeReturned,
          payload.offlineSyncId || null,
          payload.notes || null,
        ]
      );

      const billId = billRes.lastInsertRowid;

      // Gapless position within the day, so an invoice list never shows a hole
      // left by a withdrawn invoice. Separate from `bill_number`, which stays
      // permanent because it is printed on the customer's copy.
      await DocumentSequence.assignForNew(BILL_DOCUMENT, billId);

      // 8. Insert Bill Items
      for (const item of verifiedItems) {
        await dbService.execute(
          `INSERT INTO bill_items (
            bill_id, product_id, product_name, variant_id, variant_name, stock_consumption,
            unit_price, quantity, subtotal, discount_amount, tax_amount, total_amount,
            is_complimentary, complimentary_reason, addons_data, item_type, combo_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
          [
            billId,
            item.productId,
            item.productName,
            item.variantId,
            item.variantName,
            item.stockConsumption,
            item.unitPrice,
            item.quantity,
            item.subtotal,
            item.subtotal,
            item.isComplimentary,
            item.complimentaryReason,
            item.addonsData,
            item.itemType,
            item.comboId,
          ]
        );
      }

      // 9. Create Payment Record
      await dbService.execute(
        `INSERT INTO payments (
          bill_id, order_id, payment_method, amount, status, reference_number, created_by
        ) VALUES (?, ?, ?, ?, 'PAID', ?, ?)`,
        [
          billId,
          orderId,
          payload.paymentMethod,
          paymentAmount,
          payload.paymentReference || null,
          cashierId,
        ]
      );

      // 10. Update Customer Stats
      if (payload.customerId) {
        await dbService.execute(
          `UPDATE customers
           SET total_visits = total_visits + 1,
               total_spent = total_spent + ?,
               last_visit_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [grandTotal, payload.customerId]
        );
      }

      // 11. Free Table if dining
      if (payload.diningTableId) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'AVAILABLE',
               active_guest_count = 0,
               current_order_id = NULL,
               seated_at = NULL,
               cleaning_started_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [payload.diningTableId]
        );
      }

      // 12. Audit Log
      await AuditService.log({
        userId: cashierId,
        action: 'ORDER_CHECKOUT_COMPLETED',
        module: 'CHECKOUT',
        recordId: billId,
        newValues: {
          billNumber,
          orderNumber,
          orderType: ParamUtil.orderType(payload.orderType),
          paymentMethod: payload.paymentMethod,
          grandTotal,
          itemCount: verifiedItems.length,
          offlineSyncId: payload.offlineSyncId || null,
        },
      });

      return await this.getBillSummary(billId);
    });
  }

  static async getBillSummary(billId: number) {
    const bill = await dbService.queryOne(
      `SELECT b.*, o.order_number, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as cashier_name
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN dining_tables t ON b.dining_table_id = t.id
       LEFT JOIN users u ON b.cashier_id = u.id
       WHERE b.id = ? AND b.is_deleted = 0`,
      [billId]
    );

    const items = await dbService.query(
      'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id ASC',
      [billId]
    );

    // The bill's own fields stay at the top level because that is the contract
    // every existing caller was written against: the POS reads
    // `res.data.bill_number` for the settled-bill toast and `res.data.id` to
    // fetch the KOT, and both silently became undefined when this started
    // returning only the nested form. `bill` and `items` are kept alongside so
    // newer callers that want the line items still get them.
    return {
      ...bill,
      bill,
      items,
    };
  }

  /**
   * Sync a batch of offline orders created while disconnected.
   */
  static async syncOfflineOrders(orders: CheckoutPayload[], cashierId: number) {
    await this.ensureSchema();
    if (!orders || orders.length === 0) {
      return { syncedCount: 0, results: [] };
    }

    const results: any[] = [];
    for (const order of orders) {
      try {
        const res = await this.processCheckout(order, cashierId);
        results.push({ success: true, offlineSyncId: order.offlineSyncId, bill: res.bill });
      } catch (err: any) {
        results.push({ success: false, offlineSyncId: order.offlineSyncId, error: err?.message || 'Sync failed' });
      }
    }

    return {
      syncedCount: results.filter((r) => r.success).length,
      totalCount: orders.length,
      results,
    };
  }
}
