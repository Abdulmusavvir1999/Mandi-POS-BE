import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { OrderType, PaymentMethod } from '../../core/types';

export interface CheckoutPayload {
  customerId?: number | null;
  diningTableId?: number | null;
  existingOrderId?: number | null;
  orderType: OrderType;
  discountType?: 'FIXED' | 'PERCENTAGE';
  discountValue?: number;
  paymentMethod: PaymentMethod;
  paymentAmount?: number;
  paymentReference?: string;
  notes?: string;
  items: Array<{
    productId: number;
    quantity: number;
    notes?: string;
  }>;
}

export class CheckoutService {
  static async processCheckout(payload: CheckoutPayload, cashierId: number) {
    if (!payload.items || payload.items.length === 0) {
      throw AppError.badRequest('Cart is empty. Please add items to checkout.');
    }

    return await dbService.transaction(async () => {
      // 1. Check settings for negative stock & tax
      const allowNegativeStock = (await SettingsService.getValue('POS_ALLOW_NEGATIVE_STOCK')) === 'true';

      const taxEnabledValue = await SettingsService.getValue('TAX_ENABLED');
      const taxRateValue = await SettingsService.getValue('TAX_PERCENTAGE');
      const configuredTaxRate = parseFloat(taxRateValue || '5.0');
      // Databases provisioned before TAX_ENABLED existed only carry a tax rate;
      // treat a configured rate as enabled unless the flag explicitly says otherwise.
      const isTaxEnabled = taxEnabledValue !== null ? taxEnabledValue === 'true' : configuredTaxRate > 0;
      const defaultTaxRate = isTaxEnabled ? configuredTaxRate : 0.0;

      // 2. Validate Products & Stock & Recalculate Prices
      let subtotal = 0;
      const verifiedItems: Array<{
        productId: number;
        productName: string;
        unitPrice: number;
        costPrice: number;
        quantity: number;
        subtotal: number;
        discountAmount: number;
        taxAmount: number;
        totalAmount: number;
        notes?: string;
        currentStock: number;
      }> = [];

      for (const item of payload.items) {
        if (item.quantity <= 0) {
          throw AppError.badRequest(`Invalid quantity (${item.quantity}) for product ID ${item.productId}`);
        }

        const product = await dbService.queryOne<{
          id: number;
          name: string;
          sku: string;
          selling_price: number;
          cost_price: number;
          tax_rate: number;
          status: string;
        }>('SELECT * FROM products WHERE id = ?', [item.productId]);

        if (!product) {
          throw AppError.badRequest(`Product with ID ${item.productId} does not exist`);
        }

        if (product.status !== 'ACTIVE') {
          throw AppError.badRequest(`Product "${product.name}" is currently inactive and cannot be sold`);
        }

        // Check stock
        const stockRec = await dbService.queryOne<{ current_stock: number }>('SELECT current_stock FROM stock WHERE product_id = ?', [product.id]);
        const currentStock = stockRec?.current_stock || 0;

        if (!allowNegativeStock && currentStock < item.quantity) {
          throw AppError.badRequest(
            `Insufficient stock for "${product.name}". Available: ${currentStock}, Requested: ${item.quantity}`
          );
        }

        const unitPrice = product.selling_price;
        const itemSubtotal = unitPrice * item.quantity;
        subtotal += itemSubtotal;

        verifiedItems.push({
          productId: product.id,
          productName: product.name,
          unitPrice,
          costPrice: product.cost_price,
          quantity: item.quantity,
          subtotal: itemSubtotal,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: itemSubtotal,
          notes: item.notes,
          currentStock,
        });
      }

      // 3. Server-side authoritative discount calculation
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

      // 4. Server-side tax calculation
      const taxableAmount = Math.max(0, subtotal - discountAmount);
      const taxAmount = Math.round(((taxableAmount * defaultTaxRate) / 100) * 100) / 100;
      const grandTotal = Math.round((taxableAmount + taxAmount) * 100) / 100;

      const paymentAmount = payload.paymentAmount !== undefined ? payload.paymentAmount : grandTotal;
      if (paymentAmount < grandTotal) {
        throw AppError.badRequest(`Payment amount (${paymentAmount}) cannot be less than Grand Total (${grandTotal})`);
      }

      // 5. Create or reuse Order
      let orderId: number;
      let orderNumber: string;

      if (payload.existingOrderId) {
        const existingOrder = await dbService.queryOne<{ id: number; order_number: string; status: string }>(
          'SELECT id, order_number, status FROM orders WHERE id = ?',
          [payload.existingOrderId]
        );
        if (!existingOrder) {
          throw AppError.notFound('Referenced existing order not found');
        }
        orderId = existingOrder.id;
        orderNumber = existingOrder.order_number;

        // Update existing order status to COMPLETED
        await dbService.execute(
          `UPDATE orders
           SET status = 'COMPLETED',
               subtotal = ?,
               discount_type = ?,
               discount_value = ?,
               discount_amount = ?,
               tax_amount = ?,
               total_amount = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            subtotal,
            payload.discountType || 'FIXED',
            discountVal,
            discountAmount,
            taxAmount,
            grandTotal,
            orderId,
          ]
        );
      } else {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const countToday = await dbService.queryOne<{ count: number }>(
          "SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURDATE()"
        );
        const nextSeq = ((countToday?.count || 0) + 1).toString().padStart(4, '0');
        orderNumber = `ORD-${dateStr}-${nextSeq}`;

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
            payload.orderType,
            subtotal,
            payload.discountType || 'FIXED',
            discountVal,
            discountAmount,
            taxAmount,
            grandTotal,
            payload.notes || null,
            cashierId,
          ]
        );

        orderId = orderRes.lastInsertRowid;

        // Insert Order Items
        for (const item of verifiedItems) {
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
              0,
              0,
              item.subtotal,
              item.notes || null,
            ]
          );
        }
      }

      // Record Order History
      await dbService.execute(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
         VALUES (?, 'PENDING', 'COMPLETED', ?, 'Order billed and completed at checkout')`,
        [orderId, cashierId]
      );

      // 6. Generate Unique Sequential Bill Number
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const billCountToday = await dbService.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM bills WHERE DATE(created_at) = CURDATE()"
      );
      const nextBillSeq = ((billCountToday?.count || 0) + 1).toString().padStart(4, '0');
      const billNumber = `INV-${datePart}-${nextBillSeq}`;

      // 7. Create Bill Record
      const billRes = await dbService.execute(
        `INSERT INTO bills (
          bill_number, order_id, customer_id, dining_table_id, cashier_id,
          order_type, subtotal, discount_type, discount_value,
          discount_amount, tax_amount, total_amount, payment_status,
          payment_method, notes, printed_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, ?, 0)`,
        [
          billNumber,
          orderId,
          payload.customerId || null,
          payload.diningTableId || null,
          cashierId,
          payload.orderType,
          subtotal,
          payload.discountType || 'FIXED',
          discountVal,
          discountAmount,
          taxAmount,
          grandTotal,
          payload.paymentMethod,
          payload.notes || null,
        ]
      );

      const billId = billRes.lastInsertRowid;

      // 8. Insert Bill Items
      for (const item of verifiedItems) {
        await dbService.execute(
          `INSERT INTO bill_items (
            bill_id, product_id, product_name, unit_price, quantity,
            subtotal, discount_amount, tax_amount, total_amount
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
          [
            billId,
            item.productId,
            item.productName,
            item.unitPrice,
            item.quantity,
            item.subtotal,
            item.subtotal,
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

      // 10. Deduct Stock & Record Stock Movements
      for (const item of verifiedItems) {
        const newStock = item.currentStock - item.quantity;

        // 10a. Update or create master stock_items
        const stkItem = await dbService.queryOne<{ id: number; average_unit_price: number; current_value: number }>(
          'SELECT id, average_unit_price, current_value FROM stock_items WHERE product_id = ?',
          [item.productId]
        );

        if (stkItem) {
          const avgPrice = Number(stkItem.average_unit_price) || item.costPrice || 0;
          const newValue = Math.max(0, newStock * avgPrice);
          const moveValue = item.quantity * avgPrice;
          const moveUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;

          await dbService.execute(
            `UPDATE stock_items
             SET current_quantity = ?,
                 current_value = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [newStock, newValue, stkItem.id]
          );

          await dbService.execute(
            `INSERT INTO stock_movements (
              uuid, stock_item_id, movement_type, reference_type, reference_id,
              quantity, unit_price, total_value, balance_quantity, balance_value,
              notes, created_by
            ) VALUES (?, ?, 'out', 'POS_SALE', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              moveUuid,
              stkItem.id,
              billNumber,
              -item.quantity,
              avgPrice,
              moveValue,
              newStock,
              newValue,
              `Sale deduction on Bill #${billNumber} (${item.quantity} units)`,
              cashierId,
            ]
          );
        }

        // 10b. Legacy sync
        await dbService.execute(
          'UPDATE stock SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?',
          [newStock, item.productId]
        );

        await dbService.execute(
          'UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [newStock, item.productId]
        );

        await dbService.execute(
          `INSERT INTO stock_transactions (
            product_id, transaction_type, quantity, previous_stock, new_stock,
            reference_id, reference_type, notes, created_by
          ) VALUES (?, 'SALE', ?, ?, ?, ?, 'POS_CHECKOUT_BILL', ?, ?)`,
          [
            item.productId,
            item.quantity,
            item.currentStock,
            newStock,
            billNumber,
            `Sale on Bill #${billNumber}`,
            cashierId,
          ]
        );
      }

      // 11. Update Dining Table (Release table if dining)
      if (payload.diningTableId) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'AVAILABLE', current_order_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [payload.diningTableId]
        );
      }

      // 12. Update Customer statistics
      if (payload.customerId) {
        await dbService.execute(
          `UPDATE customers
           SET total_visits = total_visits + 1,
               total_spent = total_spent + ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [grandTotal, payload.customerId]
        );
      }

      // 13. Audit Log
      await AuditService.log({
        userId: cashierId,
        action: 'POS_CHECKOUT_COMPLETED',
        module: 'CHECKOUT',
        recordId: billId,
        newValues: {
          billNumber,
          orderNumber,
          totalAmount: grandTotal,
          paymentMethod: payload.paymentMethod,
          itemCount: verifiedItems.length,
        },
      });

      // 14. Return Complete Bill Representation
      const fullBill = await dbService.queryOne(
        `SELECT b.*, c.name as customer_name, c.phone as customer_phone,
                t.table_number, t.name as table_name,
                u.name as cashier_name
         FROM bills b
         LEFT JOIN customers c ON b.customer_id = c.id
         LEFT JOIN dining_tables t ON b.dining_table_id = t.id
         LEFT JOIN users u ON b.cashier_id = u.id
         WHERE b.id = ?`,
        [billId]
      );

      const billItems = await dbService.query('SELECT * FROM bill_items WHERE bill_id = ?', [billId]);
      const paymentInfo = await dbService.queryOne('SELECT * FROM payments WHERE bill_id = ?', [billId]);

      return {
        ...fullBill,
        items: billItems,
        payment: paymentInfo,
        changeDue: Math.max(0, paymentAmount - grandTotal),
      };
    });
  }
}
