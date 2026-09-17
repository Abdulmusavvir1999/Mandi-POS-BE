import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { StockUnitType, StockMovementType } from '../../core/types';

export class StockService {
  /**
   * 1. Get Stock Items (Master balance list)
   */
  static async getCurrentStock(
    page = 1,
    limit = 50,
    search?: string,
    categoryId?: number,
    lowStockOnly = false,
    status = 'active',
    unitType?: string
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (status && status !== 'all') {
      where += ' AND si.status = ?';
      params.push(status);
    }

    if (unitType) {
      where += ' AND si.unit_type = ?';
      params.push(unitType);
    }

    if (search) {
      where += ' AND (si.name LIKE ? OR si.stock_code LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (categoryId) {
      where += ' AND p.category_id = ?';
      params.push(categoryId);
    }

    if (lowStockOnly) {
      where += ' AND si.current_quantity <= si.min_stock_alert';
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const summaryRes = await dbService.queryOne<{
      total_items: number;
      total_units: number;
      total_valuation: number;
      low_stock_count: number;
    }>(
      `SELECT
         COUNT(si.id) as total_items,
         COALESCE(SUM(si.current_quantity), 0) as total_units,
         COALESCE(SUM(si.current_value), 0) as total_valuation,
         COALESCE(SUM(CASE WHEN si.current_quantity <= si.min_stock_alert THEN 1 ELSE 0 END), 0) as low_stock_count
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       ${where}`,
      params
    );

    const stockItems = await dbService.query(
      `SELECT si.*,
              p.id as product_id,
              p.name as product_name,
              p.sku,
              p.selling_price,
              p.cost_price as product_cost_price,
              c.name as category_name,
              (si.current_quantity <= si.min_stock_alert) as is_low_stock,
              si.current_quantity as current_stock
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       ${where}
       ORDER BY (si.current_quantity <= si.min_stock_alert) DESC, si.name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: stockItems,
      summary: {
        totalItems: summaryRes?.total_items || 0,
        totalUnits: summaryRes?.total_units || 0,
        totalValuation: summaryRes?.total_valuation || 0,
        lowStockCount: summaryRes?.low_stock_count || 0,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 2. Get Single Stock Item Details
   */
  static async getStockItemById(id: number) {
    const item = await dbService.queryOne(
      `SELECT si.*,
              p.name as product_name,
              p.sku,
              p.selling_price,
              c.name as category_name
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE si.id = ?`,
      [id]
    );

    if (!item) {
      throw AppError.notFound('Stock item not found');
    }

    // Recent entries
    const entries = await dbService.query(
      `SELECT se.*, u.name as created_by_name
       FROM stock_entries se
       LEFT JOIN users u ON se.created_by = u.id
       WHERE se.stock_item_id = ?
       ORDER BY se.entry_date DESC
       LIMIT 10`,
      [id]
    );

    // Recent movements
    const movements = await dbService.query(
      `SELECT sm.*, u.name as created_by_name
       FROM stock_movements sm
       LEFT JOIN users u ON sm.created_by = u.id
       WHERE sm.stock_item_id = ?
       ORDER BY sm.movement_date DESC
       LIMIT 15`,
      [id]
    );

    return {
      ...item,
      entries,
      movements,
    };
  }

  /**
   * 3. Create a new Stock Master item
   */
  static async createStockItem(
    data: {
      name: string;
      stockCode?: string;
      unitType?: StockUnitType;
      minStockAlert?: number;
      productId?: number | null;
      initialQuantity?: number;
      multiplier?: number;
      initialTotalPrice?: number;
      initialPrice?: number;
    },
    userId: number
  ) {
    return await dbService.transaction(async () => {
      let code = data.stockCode;
      if (!code) {
        const countRes = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM stock_items');
        const nextNum = (countRes?.count || 0) + 1;
        code = `STK-${String(nextNum).padStart(4, '0')}`;
      }

      // Check unique code
      const existing = await dbService.queryOne('SELECT id FROM stock_items WHERE stock_code = ?', [code]);
      if (existing) {
        throw AppError.conflict(`Stock code "${code}" already exists`);
      }

      const uuid = `stk-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const unitType = data.unitType || 'piece';
      const minAlert = data.minStockAlert !== undefined ? data.minStockAlert : 10.0;
      const baseQty = Number(data.initialQuantity) || 0;
      const multiplier = Number(data.multiplier) && Number(data.multiplier) > 0 ? Number(data.multiplier) : 1.0;
      const totalQty = baseQty * multiplier;

      let totalPrice = Number(data.initialTotalPrice) || 0;
      let unitPrice = Number(data.initialPrice) || 0;

      if (totalPrice > 0 && unitPrice === 0 && totalQty > 0) {
        unitPrice = totalPrice / totalQty;
      } else if (unitPrice > 0 && totalPrice === 0 && totalQty > 0) {
        totalPrice = totalQty * unitPrice;
      } else if (totalPrice === 0 && unitPrice === 0 && totalQty > 0) {
        totalPrice = 0;
        unitPrice = 0;
      }

      const res = await dbService.execute(
        `INSERT INTO stock_items (
          uuid, stock_code, name, unit_type, current_quantity,
          current_value, average_unit_price, status, min_stock_alert, product_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [uuid, code, data.name, unitType, totalQty, totalPrice, unitPrice, minAlert, data.productId || null]
      );

      const stockItemId = res.lastInsertRowid;

      // If initial stock provided, log entry and movement
      if (totalQty > 0) {
        const entryUuid = `entry-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
        const moveUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
        const entryNumber = `STK-IN-${String(stockItemId).padStart(5, '0')}`;

        await dbService.execute(
          `INSERT INTO stock_entries (
            uuid, stock_item_id, entry_number, quantity, multiplier,
            total_quantity, total_price, unit_price, status, supplier, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', 'Initial Setup', 'Opening inventory entry', ?)`,
          [entryUuid, stockItemId, entryNumber, baseQty, multiplier, totalQty, totalPrice, unitPrice, userId]
        );

        await dbService.execute(
          `INSERT INTO stock_movements (
            uuid, stock_item_id, movement_type, reference_type, reference_id,
            quantity, unit_price, total_value, balance_quantity, balance_value, notes, created_by
          ) VALUES (?, ?, 'in', 'INITIAL_STOCK', ?, ?, ?, ?, ?, ?, 'Opening inventory initial stock', ?)`,
          [moveUuid, stockItemId, entryNumber, totalQty, unitPrice, totalPrice, totalQty, totalPrice, userId]
        );
      }

      await AuditService.log({
        userId,
        action: 'STOCK_ITEM_CREATED',
        module: 'STOCK',
        recordId: stockItemId,
        newValues: { name: data.name, stockCode: code, unitType, baseQty, multiplier, totalQty, totalPrice, unitPrice },
      });

      return await this.getStockItemById(stockItemId);
    });
  }

  /**
   * 4. Update Stock Master Metadata
   */
  static async updateStockItem(
    id: number,
    data: {
      name?: string;
      unitType?: StockUnitType;
      minStockAlert?: number;
      status?: 'active' | 'inactive';
    },
    userId: number
  ) {
    const current = await this.getStockItemById(id);

    await dbService.execute(
      `UPDATE stock_items
       SET name = COALESCE(?, name),
           unit_type = COALESCE(?, unit_type),
           min_stock_alert = COALESCE(?, min_stock_alert),
           status = COALESCE(?, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.name, data.unitType, data.minStockAlert, data.status, id]
    );

    await AuditService.log({
      userId,
      action: 'STOCK_ITEM_UPDATED',
      module: 'STOCK',
      recordId: id,
      oldValues: current,
      newValues: data,
    });

    return await this.getStockItemById(id);
  }

  /**
   * 5. Create Stock Purchase / Addition Entry (The Core 3-tier Transaction)
   * Quantity × Multiplier = Total Quantity
   * Total Price ÷ Total Quantity = Unit Price
   * Append to stock_entries without updating old entries.
   * Update stock_items balance & weighted average unit price.
   * Append to stock_movements audit trail.
   */
  static async createStockEntry(
    data: {
      stockItemId?: number;
      productId?: number;
      quantity: number;
      multiplier?: number;
      totalPrice?: number;
      unitPrice?: number;
      supplier?: string;
      invoiceNumber?: string;
      notes?: string;
      entryDate?: string;
    },
    userId: number
  ) {
    if (data.quantity <= 0) {
      throw AppError.badRequest('Quantity must be greater than 0');
    }

    return await dbService.transaction(async () => {
      // 1. Locate Target Stock Item
      let stockItem: any = null;
      if (data.stockItemId) {
        stockItem = await dbService.queryOne('SELECT * FROM stock_items WHERE id = ?', [data.stockItemId]);
      } else if (data.productId) {
        stockItem = await dbService.queryOne('SELECT * FROM stock_items WHERE product_id = ?', [data.productId]);
        if (!stockItem) {
          // If no stock_item exists yet for product, create or link one
          const product = await dbService.queryOne<{ id: number; name: string; sku: string; cost_price: number; stock_quantity: number }>(
            'SELECT * FROM products WHERE id = ?',
            [data.productId]
          );
          if (!product) {
            throw AppError.notFound('Product not found');
          }
          const itemRes = await this.createStockItem(
            {
              name: product.name,
              stockCode: `STK-P${product.id}`,
              unitType: 'piece',
              productId: product.id,
              initialQuantity: product.stock_quantity || 0,
              initialPrice: product.cost_price || 0,
            },
            userId
          );
          stockItem = itemRes;
        }
      }

      if (!stockItem) {
        throw AppError.notFound('Stock item not found');
      }

      // 2. Perform Exact Calculations
      const baseQuantity = Number(data.quantity);
      const multiplier = Number(data.multiplier || 1.0);
      const totalQuantity = baseQuantity * multiplier;

      let totalPrice = 0;
      if (data.totalPrice !== undefined && data.totalPrice !== null) {
        totalPrice = Number(data.totalPrice);
      } else if (data.unitPrice !== undefined && data.unitPrice !== null) {
        totalPrice = totalQuantity * Number(data.unitPrice);
      } else {
        totalPrice = totalQuantity * (Number(stockItem.average_unit_price) || 0);
      }

      const unitPrice = totalQuantity > 0 ? totalPrice / totalQuantity : 0;

      // 3. Generate Sequential Entry Number (e.g. STK-IN-00001)
      const countRes = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM stock_entries');
      const nextSeq = (countRes?.count || 0) + 1;
      const entryNumber = `STK-IN-${String(nextSeq).padStart(5, '0')}`;
      const entryUuid = `entry-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const movementUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const entryDate = data.entryDate || new Date().toISOString().slice(0, 19).replace('T', ' ');

      // 4. Insert into stock_entries
      const entryRes = await dbService.execute(
        `INSERT INTO stock_entries (
          uuid, stock_item_id, entry_number, entry_date, quantity,
          multiplier, total_quantity, total_price, unit_price, status,
          supplier, invoice_number, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?)`,
        [
          entryUuid,
          stockItem.id,
          entryNumber,
          entryDate,
          baseQuantity,
          multiplier,
          totalQuantity,
          totalPrice,
          unitPrice,
          data.supplier || null,
          data.invoiceNumber || null,
          data.notes || null,
          userId,
        ]
      );

      const entryId = entryRes.lastInsertRowid;

      // 5. Calculate New Master Stock Item Balance & Weighted Average Unit Price
      const prevQuantity = Number(stockItem.current_quantity) || 0;
      const prevValue = Number(stockItem.current_value) || 0;

      const newQuantity = prevQuantity + totalQuantity;
      const newValue = prevValue + totalPrice;
      const newAverageUnitPrice = newQuantity > 0 ? newValue / newQuantity : 0;

      // 6. Insert into stock_movements (Audit Record)
      await dbService.execute(
        `INSERT INTO stock_movements (
          uuid, stock_item_id, movement_type, reference_type, reference_id,
          quantity, unit_price, total_value, balance_quantity, balance_value,
          notes, created_by
        ) VALUES (?, ?, 'in', 'PURCHASE_ENTRY', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movementUuid,
          stockItem.id,
          entryNumber,
          totalQuantity,
          unitPrice,
          totalPrice,
          newQuantity,
          newValue,
          data.notes || (data.supplier ? `Purchase from ${data.supplier}` : 'Stock Purchase Addition'),
          userId,
        ]
      );

      // 7. Update stock_items Master
      await dbService.execute(
        `UPDATE stock_items
         SET current_quantity = ?,
             current_value = ?,
             average_unit_price = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newQuantity, newValue, newAverageUnitPrice, stockItem.id]
      );

      // 8. Backward Compatibility & Synchronization with Products table
      if (stockItem.product_id) {
        await dbService.execute(
          `UPDATE products
           SET stock_quantity = ?,
               cost_price = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [newQuantity, newAverageUnitPrice, stockItem.product_id]
        );

        await dbService.execute(
          `UPDATE stock
           SET current_stock = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE product_id = ?`,
          [newQuantity, stockItem.product_id]
        );

        await dbService.execute(
          `INSERT INTO stock_transactions (
            product_id, transaction_type, quantity, previous_stock, new_stock,
            reference_id, reference_type, notes, created_by
          ) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, 'PURCHASE_ENTRY', ?, ?)`,
          [
            stockItem.product_id,
            totalQuantity,
            prevQuantity,
            newQuantity,
            entryNumber,
            data.notes || `Stock In via Entry ${entryNumber}`,
            userId,
          ]
        );
      }

      await AuditService.log({
        userId,
        action: 'STOCK_PURCHASE_ENTRY',
        module: 'STOCK',
        recordId: entryId,
        newValues: {
          stockItemId: stockItem.id,
          stockItemName: stockItem.name,
          entryNumber,
          quantity: baseQuantity,
          multiplier,
          totalQuantity,
          totalPrice,
          unitPrice,
          newQuantity,
          newAverageUnitPrice,
          newValue,
        },
      });

      return {
        entryId,
        entryNumber,
        stockItemId: stockItem.id,
        stockItemName: stockItem.name,
        stockCode: stockItem.stock_code,
        baseQuantity,
        multiplier,
        totalQuantity,
        totalPrice,
        unitPrice,
        previousQuantity: prevQuantity,
        newQuantity,
        newAverageUnitPrice,
        newValue,
        addedQuantity: totalQuantity,
        productName: stockItem.name,
        newStock: newQuantity,
      };
    });
  }

  /**
   * 6. Get Stock Entries (Purchase Ledger)
   */
  static async getStockEntries(
    page = 1,
    limit = 50,
    stockItemId?: number,
    search?: string,
    supplier?: string,
    dateFrom?: string,
    dateTo?: string
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (stockItemId) {
      where += ' AND se.stock_item_id = ?';
      params.push(stockItemId);
    }

    if (search) {
      where += ' AND (se.entry_number LIKE ? OR si.name LIKE ? OR si.stock_code LIKE ? OR se.supplier LIKE ? OR se.invoice_number LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (supplier) {
      where += ' AND se.supplier LIKE ?';
      params.push(`%${supplier}%`);
    }

    if (dateFrom) {
      where += ' AND DATE(se.entry_date) >= DATE(?)';
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ' AND DATE(se.entry_date) <= DATE(?)';
      params.push(dateTo);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM stock_entries se
       JOIN stock_items si ON se.stock_item_id = si.id
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const entries = await dbService.query(
      `SELECT se.*,
              si.name as stock_item_name,
              si.stock_code,
              si.unit_type,
              u.name as created_by_name
       FROM stock_entries se
       JOIN stock_items si ON se.stock_item_id = si.id
       LEFT JOIN users u ON se.created_by = u.id
       ${where}
       ORDER BY se.entry_date DESC, se.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: entries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 7. Stock Adjustments (Audit, Wastage, Returns, Spoilage)
   */
  static async adjustStock(
    data: {
      stockItemId?: number;
      productId?: number;
      adjustmentType: 'INCREASE' | 'DECREASE' | 'adjustment' | 'wastage' | 'return' | 'in' | 'out';
      quantity: number;
      reason: string;
      notes?: string;
    },
    userId: number
  ) {
    if (data.quantity <= 0) {
      throw AppError.badRequest('Quantity must be greater than 0');
    }

    return await dbService.transaction(async () => {
      let stockItem: any = null;
      if (data.stockItemId) {
        stockItem = await dbService.queryOne('SELECT * FROM stock_items WHERE id = ?', [data.stockItemId]);
      } else if (data.productId) {
        stockItem = await dbService.queryOne('SELECT * FROM stock_items WHERE product_id = ?', [data.productId]);
      }

      if (!stockItem) {
        throw AppError.notFound('Stock item not found');
      }

      const prevQuantity = Number(stockItem.current_quantity) || 0;
      const prevValue = Number(stockItem.current_value) || 0;
      const avgPrice = Number(stockItem.average_unit_price) || 0;

      const isIncrease = data.adjustmentType === 'INCREASE' || data.adjustmentType === 'in' || data.adjustmentType === 'return';
      let deltaQty = isIncrease ? Number(data.quantity) : -Number(data.quantity);
      let movementType: StockMovementType = 'adjustment';

      if (data.adjustmentType === 'wastage') movementType = 'wastage';
      else if (data.adjustmentType === 'return') movementType = 'return';
      else if (data.adjustmentType === 'INCREASE' || data.adjustmentType === 'in') movementType = 'in';
      else if (data.adjustmentType === 'DECREASE' || data.adjustmentType === 'out') movementType = 'out';

      const newQuantity = prevQuantity + deltaQty;
      if (newQuantity < 0) {
        const allowNegativeStock = await SettingsService.getValue('POS_ALLOW_NEGATIVE_STOCK');
        if (allowNegativeStock !== 'true') {
          throw AppError.badRequest(`Cannot reduce stock below 0. Current balance is ${prevQuantity} ${stockItem.unit_type}`);
        }
      }

      // Calculate adjusted value based on weighted average price
      const movementValue = Math.abs(deltaQty) * avgPrice;
      const newValue = Math.max(0, newQuantity * avgPrice);

      const moveUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const adjRef = `ADJ-${Date.now().toString().slice(-6)}`;

      // Log movement
      await dbService.execute(
        `INSERT INTO stock_movements (
          uuid, stock_item_id, movement_type, reference_type, reference_id,
          quantity, unit_price, total_value, balance_quantity, balance_value,
          notes, created_by
        ) VALUES (?, ?, ?, 'MANUAL_ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          moveUuid,
          stockItem.id,
          movementType,
          adjRef,
          deltaQty,
          avgPrice,
          movementValue,
          newQuantity,
          newValue,
          data.reason + (data.notes ? ` - ${data.notes}` : ''),
          userId,
        ]
      );

      // Update stock_items
      await dbService.execute(
        `UPDATE stock_items
         SET current_quantity = ?,
             current_value = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newQuantity, newValue, stockItem.id]
      );

      // Sync legacy tables if linked
      if (stockItem.product_id) {
        await dbService.execute('UPDATE stock SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?', [
          newQuantity,
          stockItem.product_id,
        ]);
        await dbService.execute('UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
          newQuantity,
          stockItem.product_id,
        ]);

        await dbService.execute(
          `INSERT INTO stock_adjustments (product_id, adjustment_type, quantity, reason, approved_by)
           VALUES (?, ?, ?, ?, ?)`,
          [stockItem.product_id, isIncrease ? 'INCREASE' : 'DECREASE', Math.abs(deltaQty), data.reason, userId]
        );

        await dbService.execute(
          `INSERT INTO stock_transactions (
            product_id, transaction_type, quantity, previous_stock, new_stock, reference_id, reference_type, notes, created_by
          ) VALUES (?, 'ADJUSTMENT', ?, ?, ?, 'STOCK-ADJUST', 'INVENTORY_AUDIT', ?, ?)`,
          [stockItem.product_id, deltaQty, prevQuantity, newQuantity, data.reason, userId]
        );
      }

      await AuditService.log({
        userId,
        action: 'STOCK_ADJUSTMENT',
        module: 'STOCK',
        recordId: stockItem.id,
        oldValues: { previousQuantity: prevQuantity, previousValue: prevValue },
        newValues: {
          movementType,
          quantityChanged: deltaQty,
          newQuantity,
          newValue,
          reason: data.reason,
        },
      });

      return {
        stockItemId: stockItem.id,
        stockItemName: stockItem.name,
        previousQuantity: prevQuantity,
        newQuantity,
        adjustmentType: data.adjustmentType,
        movementType,
        newStock: newQuantity,
        productName: stockItem.name,
      };
    });
  }

  /**
   * 8. Get Stock Movements (Complete Audit History)
   */
  static async getStockMovements(
    page = 1,
    limit = 50,
    stockItemId?: number,
    movementType?: string,
    search?: string,
    dateFrom?: string,
    dateTo?: string
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (stockItemId) {
      where += ' AND sm.stock_item_id = ?';
      params.push(stockItemId);
    }

    if (movementType && movementType !== 'all') {
      where += ' AND sm.movement_type = ?';
      params.push(movementType);
    }

    if (search) {
      where += ' AND (si.name LIKE ? OR si.stock_code LIKE ? OR sm.reference_id LIKE ? OR sm.notes LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (dateFrom) {
      where += ' AND DATE(sm.movement_date) >= DATE(?)';
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ' AND DATE(sm.movement_date) <= DATE(?)';
      params.push(dateTo);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM stock_movements sm
       JOIN stock_items si ON sm.stock_item_id = si.id
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const movements = await dbService.query(
      `SELECT sm.*,
              si.name as stock_item_name,
              si.stock_code,
              si.unit_type,
              u.name as created_by_name,
              si.name as product_name,
              sm.movement_type as transaction_type,
              sm.balance_quantity as new_stock,
              (sm.balance_quantity - sm.quantity) as previous_stock,
              sm.movement_date as created_at
       FROM stock_movements sm
       JOIN stock_items si ON sm.stock_item_id = si.id
       LEFT JOIN users u ON sm.created_by = u.id
       ${where}
       ORDER BY sm.movement_date DESC, sm.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: movements,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 9. Get Low Stock Alerts
   */
  static async getLowStock() {
    const lowStock = await dbService.query(
      `SELECT si.*,
              p.name as product_name,
              p.sku,
              c.name as category_name,
              si.current_quantity as current_stock,
              p.selling_price
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE si.status = 'active' AND si.current_quantity <= si.min_stock_alert
       ORDER BY si.current_quantity ASC`
    );
    return lowStock;
  }

  /**
   * 10. Backward Compatibility - Stock In forwarding to createStockEntry
   */
  static async stockIn(
    data: {
      productId?: number;
      stockItemId?: number;
      quantity: number;
      multiplier?: number;
      totalPrice?: number;
      supplier?: string;
      invoiceNumber?: string;
      notes?: string;
    },
    userId: number
  ) {
    return await this.createStockEntry(data, userId);
  }

  /**
   * 11. Backward Compatibility - Get Transactions forwarding to Movements
   */
  static async getTransactions(page = 1, limit = 50, productId?: number, type?: string) {
    let stockItemId: number | undefined;
    if (productId) {
      const item = await dbService.queryOne<{ id: number }>('SELECT id FROM stock_items WHERE product_id = ?', [productId]);
      stockItemId = item?.id;
    }
    return await this.getStockMovements(page, limit, stockItemId, type);
  }
}
