import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { SettingsService } from './settings.service';
import { StockUnitType, StockMovementType } from '../models';
import { logger } from '../config/logger';
import { ParamUtil } from '../utils/param.util';

export class StockService {
  private static schemaEnsured = false;

  /**
   * Adds stock_items.default_vendor_id when an older database is missing it.
   *
   * Schema here is managed out-of-band by stock_item_default_vendor.sql, but
   * createStockItem writes this column on every call, so a database the script
   * has not been run against would fail every create. This makes the column
   * self-healing on the first stock request after a deploy.
   *
   * The foreign key is deliberately NOT added here: it belongs with the
   * back-fill in the SQL script, and a half-applied constraint is worse than
   * none. A failure is logged and swallowed for the same reason the other
   * modules do it, a missing column must not take the stock screens down.
   */
  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      const dropColumnSafe = async (table: string, colName: string) => {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = ? 
              AND COLUMN_NAME = ?
          `, [table, colName]);
          if (colCheck && colCheck.count > 0) {
            try {
              const fkCheck = await dbService.query<{ CONSTRAINT_NAME: string }>(`
                SELECT CONSTRAINT_NAME
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = ?
                  AND COLUMN_NAME = ?
                  AND REFERENCED_TABLE_NAME IS NOT NULL
              `, [table, colName]);
              for (const fk of fkCheck) {
                await dbService.execute(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
              }
            } catch (_) {}

            try {
              const idxCheck = await dbService.query<{ INDEX_NAME: string }>(`
                SELECT DISTINCT INDEX_NAME
                FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = ?
                  AND COLUMN_NAME = ?
                  AND INDEX_NAME != 'PRIMARY'
              `, [table, colName]);
              for (const idx of idxCheck) {
                await dbService.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${idx.INDEX_NAME}\``);
              }
            } catch (_) {}

            await dbService.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${colName}\``);
          }
        } catch (e) {
          logger.warn(`Could not drop column ${colName} from ${table}:`, e);
        }
      };

      /**
       * Adds a column, and optionally its index, when the database predates it.
       *
       * `stock_entries.expiry_date`, `batch_number` and `vendor_id` are all in
       * schema.sql and all written by createStockEntry, but mysql_migrator.ts
       * built the table without them. Any database provisioned by the migrator
       * therefore failed every stock-in and every entry listing with
       * ER_BAD_FIELD_ERROR. Swallowed and logged like the drops above: a column
       * that cannot be added must not take the stock screens down.
       */
      const addColumnSafe = async (table: string, colName: string, ddl: string, indexName?: string) => {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
              AND COLUMN_NAME = ?
          `, [table, colName]);
          if (colCheck && colCheck.count > 0) return;

          await dbService.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${colName}\` ${ddl}`);

          if (indexName) {
            try {
              await dbService.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (\`${colName}\`)`);
            } catch (_) {}
          }
        } catch (e) {
          logger.warn(`Could not add column ${colName} to ${table}:`, e);
        }
      };

      await addColumnSafe('stock_entries', 'expiry_date', 'DATE NULL', 'idx_stock_entries_expiry');
      await addColumnSafe('stock_entries', 'batch_number', 'VARCHAR(100) NULL');
      await addColumnSafe('stock_entries', 'vendor_id', 'INT NULL', 'idx_stock_entries_vendor');

      await dropColumnSafe('stock_items', 'reorder_level');
      await dropColumnSafe('stock_items', 'reorder_quantity');
      await dropColumnSafe('stock_items', 'max_stock_threshold');
      await dropColumnSafe('stock_items', 'shelf_life_days');
      await dropColumnSafe('stock_items', 'default_vendor_id');
      await dropColumnSafe('stock_items', 'product_id');
      await dropColumnSafe('stock_items', 'is_deleted');
      await dropColumnSafe('stock_items', 'deleted_at');
      await dropColumnSafe('stock_items', 'deleted_by');
    } catch (e) {
      logger.warn('Could not ensure stock_items schema:', e);
    }

    this.schemaEnsured = true;
  }

  /**
   * Resolves a vendor id to a usable vendor, or explains why it is not one.
   *
   * Shared by createStockItem and createStockEntry so a blocked vendor is
   * refused identically whichever door the purchase comes through.
   */
  private static async resolveVendor(vendorId: number) {
    const vendor = await dbService.queryOne<{ id: number; name: string; status: string }>(
      'SELECT id, name, status FROM vendors WHERE id = ?',
      [vendorId]
    );
    if (!vendor) {
      throw AppError.notFound('Vendor not found');
    }
    if (vendor.status === 'BLOCKED') {
      throw AppError.badRequest(`Vendor ${vendor.name} is blocked and cannot be purchased from`);
    }
    return vendor;
  }
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
    await this.ensureSchema();

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
      where += ' AND (si.name LIKE ? OR si.stock_code LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term);
    }

    if (lowStockOnly) {
      where += ' AND si.current_quantity <= si.min_stock_alert';
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM stock_items si
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
       ${where}`,
      params
    );

    const stockItems = await dbService.query(
      `SELECT si.*,
              (si.current_quantity <= si.min_stock_alert) as is_low_stock,
              si.current_quantity as current_stock
       FROM stock_items si
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
    await this.ensureSchema();

    const item = await dbService.queryOne(
      `SELECT si.*
       FROM stock_items si
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
      reorderLevel?: number;
      reorderQuantity?: number;
      maxStockThreshold?: number;
      shelfLifeDays?: number;
      productId?: number | null;
      vendorId?: number | null;
      initialQuantity?: number;
      multiplier?: number;
      initialTotalPrice?: number;
      initialPrice?: number;
    },
    userId: number
  ) {
    await this.ensureSchema();

    // A default vendor is optional. When none is named, default_vendor_id
    // stays NULL and the opening balance entry is stamped "Initial Setup" -
    // the same shape the auto-provision path below has always produced.
    const vendor = data.vendorId ? await this.resolveVendor(data.vendorId) : null;

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
          current_value, average_unit_price, status, min_stock_alert
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [uuid, code, data.name, unitType, totalQty, totalPrice, unitPrice, minAlert]
      );

      const stockItemId = res.lastInsertRowid;

      // If initial stock provided, log entry and movement
      if (totalQty > 0) {
        const entryUuid = `entry-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
        const moveUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
        const entryNumber = `STK-IN-${String(stockItemId).padStart(5, '0')}`;

        // supplier carries the vendor's name as it reads today, matching how
        // createStockEntry snapshots it: renaming the vendor later must not
        // rewrite what this opening entry says the stock was bought from.
        await dbService.execute(
          `INSERT INTO stock_entries (
            uuid, stock_item_id, entry_number, quantity, multiplier,
            total_quantity, total_price, unit_price, status, supplier, vendor_id, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, 'Opening inventory entry', ?)`,
          [entryUuid, stockItemId, entryNumber, baseQty, multiplier, totalQty, totalPrice, unitPrice, vendor?.name ?? 'Initial Setup', vendor?.id ?? null, userId]
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
        newValues: { name: data.name, stockCode: code, unitType, baseQty, multiplier, totalQty, totalPrice, unitPrice, vendorId: vendor?.id ?? null, vendorName: vendor?.name ?? null },
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
    await this.ensureSchema();

    const current = await this.getStockItemById(id);

    await dbService.execute(
      `UPDATE stock_items
       SET name = COALESCE(?, name),
           unit_type = COALESCE(?, unit_type),
           min_stock_alert = COALESCE(?, min_stock_alert),
           status = COALESCE(?, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        data.name,
        data.unitType,
        data.minStockAlert,
        data.status,
        id,
      ]
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
      vendorId?: number;
      invoiceNumber?: string;
      batchNumber?: string;
      expiryDate?: string;
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
              vendorId: data.vendorId,
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

      // 2b. Resolve the vendor, when one was picked.
      // supplier is kept as the name snapshot for this purchase: renaming or
      // deleting a vendor later must not rewrite what this entry says it was
      // bought from. A free-typed supplier with no vendor picked still works.
      let vendorId: number | null = null;
      let supplierName: string | null = data.supplier?.trim() || null;

      if (data.vendorId) {
        const vendor = await StockService.resolveVendor(data.vendorId);
        vendorId = vendor.id;
        supplierName = vendor.name;
      }

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
          supplier, vendor_id, invoice_number, batch_number, expiry_date, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?)`,
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
          supplierName,
          vendorId,
          data.invoiceNumber || null,
          data.batchNumber || null,
          data.expiryDate || null,
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
          data.notes || (supplierName ? `Purchase from ${supplierName}` : 'Stock Purchase Addition'),
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
    dateTo?: string,
    vendorId?: number
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (stockItemId) {
      where += ' AND se.stock_item_id = ?';
      params.push(stockItemId);
    }

    if (search) {
      where += ' AND (se.entry_number LIKE ? OR si.name LIKE ? OR si.stock_code LIKE ? OR se.supplier LIKE ? OR v.name LIKE ? OR se.invoice_number LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term, term, term, term, term);
    }

    if (supplier) {
      where += ' AND se.supplier LIKE ?';
      params.push(ParamUtil.like(supplier));
    }

    // Exact match, unlike the supplier text filter above: once entries are
    // linked, "show me everything from this vendor" has one right answer.
    if (vendorId) {
      where += ' AND se.vendor_id = ?';
      params.push(vendorId);
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
       LEFT JOIN vendors v ON se.vendor_id = v.id
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const entries = await dbService.query(
      `SELECT se.*,
              si.name as stock_item_name,
              si.stock_code,
              si.unit_type,
              v.name as vendor_name,
              v.vendor_code,
              v.status as vendor_status,
              u.name as created_by_name
       FROM stock_entries se
       JOIN stock_items si ON se.stock_item_id = si.id
       LEFT JOIN vendors v ON se.vendor_id = v.id
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
      multiplier?: number;
      totalPrice?: number;
      unitPrice?: number;
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

      // Base quantity x multiplier, mirroring how a purchase entry is measured.
      const baseQuantity = Number(data.quantity);
      const multiplier = Number(data.multiplier ?? 1) || 1;
      const totalQuantity = baseQuantity * multiplier;
      if (totalQuantity <= 0) {
        throw AppError.badRequest('Quantity x Multiplier must be greater than 0');
      }

      const isIncrease = data.adjustmentType === 'INCREASE' || data.adjustmentType === 'in' || data.adjustmentType === 'return';
      let deltaQty = isIncrease ? totalQuantity : -totalQuantity;
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

      // Unit cost for this movement: an explicit total wins, then an explicit
      // unit rate, otherwise the item's existing weighted average.
      let unitCost = avgPrice;
      if (data.totalPrice !== undefined && data.totalPrice !== null) {
        unitCost = totalQuantity > 0 ? Number(data.totalPrice) / totalQuantity : 0;
      } else if (data.unitPrice !== undefined && data.unitPrice !== null) {
        unitCost = Number(data.unitPrice);
      }

      const movementValue = totalQuantity * unitCost;

      // Stock coming IN re-averages exactly like a purchase entry. Stock going
      // OUT is always depleted at the existing average, so a wastage entry can
      // never shift the item's costing — any cost supplied on a decrease is
      // recorded on the movement row as the write-off value only.
      let newValue: number;
      let newAvgPrice = avgPrice;
      if (isIncrease) {
        newValue = Math.max(0, prevValue + movementValue);
        newAvgPrice = newQuantity > 0 ? newValue / newQuantity : unitCost;
      } else {
        newValue = Math.max(0, newQuantity * avgPrice);
      }

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
          unitCost,
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
             average_unit_price = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newQuantity, newValue, newAvgPrice, stockItem.id]
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
      const term = ParamUtil.like(search);
      params.push(term, term, term, term);
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
   * 9. Get Comprehensive Inventory Alerts
   * Categorized: Out of Stock, Low Stock, Minimum Stock, Reorder Level, Expiry, Overstock
   */
  static async getStockAlerts(filterType?: string) {
    const summary = await dbService.queryOne<any>(
      `SELECT
         COUNT(DISTINCT CASE WHEN si.current_quantity <= 0 THEN si.id END) as out_of_stock_count,
         COUNT(DISTINCT CASE WHEN si.current_quantity > 0 AND si.current_quantity <= si.min_stock_alert THEN si.id END) as low_stock_count,
         COUNT(DISTINCT CASE WHEN si.current_quantity <= si.min_stock_alert THEN si.id END) as min_stock_count,
         COUNT(DISTINCT CASE WHEN se.expiry_date IS NOT NULL AND se.expiry_date < CURDATE() THEN si.id END) as expired_count,
         COUNT(DISTINCT CASE WHEN se.expiry_date IS NOT NULL AND se.expiry_date >= CURDATE() AND se.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN si.id END) as expiring_soon_count
       FROM stock_items si
       LEFT JOIN stock_entries se ON si.id = se.stock_item_id
       WHERE si.status = 'active'`
    );

    const itemsQuery = `
      SELECT
        si.*,
        latest_exp.batch_number as latest_batch,
        latest_exp.expiry_date as nearest_expiry_date,
        DATEDIFF(latest_exp.expiry_date, CURDATE()) as days_until_expiry,
        CASE
          WHEN si.current_quantity <= 0 THEN 'OUT_OF_STOCK'
          WHEN si.current_quantity <= si.min_stock_alert THEN 'LOW_STOCK'
          WHEN latest_exp.expiry_date IS NOT NULL AND latest_exp.expiry_date < CURDATE() THEN 'EXPIRED'
          WHEN latest_exp.expiry_date IS NOT NULL AND latest_exp.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'EXPIRING_SOON'
          ELSE 'NORMAL'
        END as alert_category,
        CASE
          WHEN si.current_quantity <= 0 THEN 'critical'
          WHEN si.current_quantity <= (si.min_stock_alert / 2) THEN 'critical'
          WHEN latest_exp.expiry_date IS NOT NULL AND latest_exp.expiry_date < CURDATE() THEN 'critical'
          WHEN si.current_quantity <= si.min_stock_alert THEN 'warning'
          WHEN latest_exp.expiry_date IS NOT NULL AND latest_exp.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'warning'
          WHEN latest_exp.expiry_date IS NOT NULL AND latest_exp.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'info'
          ELSE 'normal'
        END as severity,
        GREATEST(0, (COALESCE(si.min_stock_alert, 10) * 2 - si.current_quantity)) as suggested_reorder_quantity
      FROM stock_items si
      LEFT JOIN (
        SELECT se1.stock_item_id, se1.batch_number, se1.expiry_date
        FROM stock_entries se1
        INNER JOIN (
          SELECT stock_item_id, MIN(expiry_date) as min_exp
          FROM stock_entries
          WHERE expiry_date IS NOT NULL
          GROUP BY stock_item_id
        ) se2 ON se1.stock_item_id = se2.stock_item_id AND se1.expiry_date = se2.min_exp
        GROUP BY se1.stock_item_id, se1.batch_number, se1.expiry_date
      ) latest_exp ON si.id = latest_exp.stock_item_id
      WHERE si.status = 'active'
    `;

    const allItems: any[] = await dbService.query(itemsQuery);

    const filtered = allItems.filter(item => {
      if (!filterType || filterType === 'all') {
        return item.alert_category !== 'NORMAL';
      }
      switch (filterType.toLowerCase()) {
        case 'out_of_stock':
        case 'out-of-stock':
          return Number(item.current_quantity) <= 0;
        case 'low_stock':
        case 'low-stock':
          return Number(item.current_quantity) > 0 && Number(item.current_quantity) <= Number(item.min_stock_alert);
        case 'minimum_stock':
        case 'min-stock':
          return Number(item.current_quantity) <= Number(item.min_stock_alert);
        case 'reorder_level':
        case 'reorder':
          return Number(item.current_quantity) <= Number(item.reorder_level);
        case 'overstock':
          return Number(item.max_stock_threshold) > 0 && Number(item.current_quantity) > Number(item.max_stock_threshold);
        case 'expiry':
          return item.nearest_expiry_date && item.days_until_expiry <= 30;
        default:
          return item.alert_category !== 'NORMAL';
      }
    });

    return {
      alerts: filtered,
      summary: {
        totalAlerts: filtered.length,
        outOfStock: Number(summary?.out_of_stock_count || 0),
        lowStock: Number(summary?.low_stock_count || 0),
        minStock: Number(summary?.min_stock_count || 0),
        reorderLevel: Number(summary?.reorder_level_count || 0),
        overstock: Number(summary?.overstock_count || 0),
        expired: Number(summary?.expired_count || 0),
        expiringSoon: Number(summary?.expiring_soon_count || 0),
      },
    };
  }

  /**
   * 10. Backward Compatibility - Get Low Stock Alerts
   */
  static async getLowStock() {
    const lowStock = await dbService.query(
      `SELECT si.*,
              p.name as product_name,
              p.sku,
              c.name as category_name,
              si.current_quantity as current_stock,
              COALESCE((SELECT MIN(pv.selling_price) FROM product_variants pv WHERE pv.product_id = p.id), 0) as selling_price
       FROM stock_items si
       LEFT JOIN products p ON p.stock_item_id = si.id
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
