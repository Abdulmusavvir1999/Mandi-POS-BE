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
   * Adds stocks.default_vendor_id when an older database is missing it.
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
       * Adds a column the current schema has but an older database does not,
       * with the foreign key that goes with it when one is named. Guarded on
       * the column and the key already being there, so it is a no-op once
       * applied and safe to run on every stock request.
       */
      const addColumnSafe = async (
        table: string,
        colName: string,
        definition: string,
        fk?: { refTable: string; name: string; onDelete: string }
      ) => {
        try {
          const col = await dbService.queryOne<{ c: number }>(
            `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [table, colName]
          );
          if (Number(col?.c ?? 0) === 0) {
            await dbService.execute(
              `ALTER TABLE \`${table}\` ADD COLUMN \`${colName}\` ${definition}`
            );
          }
          if (fk) {
            const existing = await dbService.queryOne<{ c: number }>(
              `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                 AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
              [table, colName]
            );
            if (Number(existing?.c ?? 0) === 0) {
              await dbService.execute(
                `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fk.name}\`
                 FOREIGN KEY (\`${colName}\`) REFERENCES \`${fk.refTable}\`(\`id\`)
                 ON DELETE ${fk.onDelete}`
              );
            }
          }
        } catch (e) {
          logger.warn(`Could not add column ${colName} to ${table}:`, e);
        }
      };

      /**
       * Drops a table that is no longer part of the schema, if it is still
       * there. Swallowed and logged like the column drops: a table that cannot
       * go must not take the stock screens down with it.
       */
      const dropTableSafe = async (table: string) => {
        try {
          await dbService.execute(`DROP TABLE IF EXISTS \`${table}\``);
        } catch (e) {
          logger.warn(`Could not drop table ${table}:`, e);
        }
      };

      /**
       * Renames a table in place when the database still has the old name.
       * Guarded both ways so it is a no-op once applied, and so it cannot fire
       * if something has already created the new table.
       */
      const renameTableSafe = async (from: string, to: string) => {
        try {
          const has = async (t: string) =>
            Number(
              (
                await dbService.queryOne<{ c: number }>(
                  `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                  [t]
                )
              )?.c ?? 0
            ) > 0;
          if ((await has(from)) && !(await has(to))) {
            await dbService.execute(`RENAME TABLE \`${from}\` TO \`${to}\``);
            logger.info(`Renamed table ${from} -> ${to}`);
          }
        } catch (e) {
          logger.warn(`Could not rename table ${from} to ${to}:`, e);
        }
      };

      /**
       * `supplier` used to be free text: a vendor name typed by hand, or the
       * literal 'Initial Setup' for an opening row. The vendor belongs in
       * vendor_id, so the column is narrowed to what it actually answers —
       * where the batch came from, not who supplied it.
       *
       * Order matters. A typed name that matches a vendor is promoted to a
       * real link first, so it survives as data rather than being flattened;
       * a name that matches nothing is copied into `notes` before it is lost.
       * Re-running is a no-op once the column is already an enum.
       */
      const convertSupplierToSource = async () => {
        try {
          const col = await dbService.queryOne<{ t: string }>(
            `SELECT COLUMN_TYPE t FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_vendor_purchase'
               AND COLUMN_NAME = 'supplier'`
          );
          if (!col || String(col.t).toLowerCase().startsWith('enum')) return;

          await dbService.execute(
            `UPDATE stock_vendor_purchase se
               JOIN vendors v ON v.name = TRIM(se.supplier)
                SET se.vendor_id = v.id
              WHERE se.vendor_id IS NULL
                AND TRIM(COALESCE(se.supplier, '')) <> ''`
          );

          await dbService.execute(
            `UPDATE stock_vendor_purchase
                SET notes = CONCAT(
                      COALESCE(notes, ''),
                      CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' - ' END,
                      'Supplier: ', TRIM(supplier))
              WHERE vendor_id IS NULL
                AND TRIM(COALESCE(supplier, '')) NOT IN ('', 'Initial Setup')`
          );

          await dbService.execute(
            `UPDATE stock_vendor_purchase
                SET supplier = CASE WHEN vendor_id IS NOT NULL THEN 'Vendor' ELSE 'Initial Setup' END`
          );

          await dbService.execute(
            `ALTER TABLE stock_vendor_purchase
             MODIFY COLUMN supplier ENUM('Initial Setup', 'Vendor') NOT NULL DEFAULT 'Initial Setup'`
          );
          logger.info("Narrowed stock_vendor_purchase.supplier to ENUM('Initial Setup','Vendor')");
        } catch (e) {
          logger.warn('Could not convert stock_vendor_purchase.supplier to a source enum:', e);
        }
      };

      await StockService.ensureStockTopology();

      // `stock` held a second per-product counter beside stocks, which
      // only let the two disagree; every dish is backed by a stock item now.
      // `stock_adjustments` was written on every adjustment and read by
      // nothing — stock_movements already carries that audit trail.
      await dropTableSafe('stock_adjustments');
      await dropTableSafe('stock');

      // Each purchase entry records the vendor it was bought from. Nullable,
      // because a batch can be entered before the vendor is known and because
      // the rows written before this column existed have no vendor to name;
      // ON DELETE SET NULL so removing a vendor keeps the purchase history.
      await addColumnSafe('stock_vendor_purchase', 'vendor_id', 'INT NULL AFTER `stock_id`', {
        refTable: 'vendors',
        name: 'fk_svp_vendor',
        onDelete: 'SET NULL',
      });

      // Runs after vendor_id exists, because it promotes typed supplier names
      // into that column before narrowing what is left.
      await convertSupplierToSource();

      // The invoice, expiry and batch fields are not kept on an entry:
      // dropColumnSafe clears the index and the foreign key first, so an
      // existing database sheds them on the next stock request.
      await dropColumnSafe('stock_vendor_purchase', 'invoice_number');
      await dropColumnSafe('stock_vendor_purchase', 'expiry_date');
      await dropColumnSafe('stock_vendor_purchase', 'batch_number');

      await dropColumnSafe('stocks', 'reorder_level');
      await dropColumnSafe('stocks', 'reorder_quantity');
      await dropColumnSafe('stocks', 'max_stock_threshold');
      await dropColumnSafe('stocks', 'shelf_life_days');
      await dropColumnSafe('stocks', 'default_vendor_id');
      await dropColumnSafe('stocks', 'product_id');
      await dropColumnSafe('stocks', 'is_deleted');
      await dropColumnSafe('stocks', 'deleted_at');
      await dropColumnSafe('stocks', 'deleted_by');
    } catch (e) {
      logger.warn('Could not ensure stocks schema:', e);
    }

    this.schemaEnsured = true;
  }

  /**
   * Resolves a vendor id to a usable vendor, or explains why it is not one.
   *
   * Shared by createStockItem and createStockEntry so a blocked vendor is
   * refused identically whichever door the purchase comes through.
   */
  /**
   * Brings an existing database to the current stock topology:
   *
   *   stocks                 — the master item (stock_code, balance, avg cost)
   *   stock_vendor_purchase  — the purchase ledger, stock_id -> stocks.id
   *   stock_movements        — stock_id -> stocks.id
   *
   * Works from any earlier shape: the original `stock_items` / `stock_entries`
   * pair, or the intermediate state where the two new names ended up on the
   * wrong tables. Which table is which is decided by the columns it carries,
   * not by its name, so this is safe to re-run and cannot mis-fire.
   *
   * MariaDB 10.4 has no `RENAME COLUMN`, so columns move with `CHANGE`.
   */
  private static async ensureStockTopology(): Promise<void> {
    const tableExists = async (t: string): Promise<boolean> =>
      Number(
        (
          await dbService.queryOne<{ c: number }>(
            `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
            [t]
          )
        )?.c ?? 0
      ) > 0;

    const columnExists = async (t: string, c: string): Promise<boolean> =>
      Number(
        (
          await dbService.queryOne<{ c: number }>(
            `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [t, c]
          )
        )?.c ?? 0
      ) > 0;

    /** Drops every foreign key on `table` that sits on `column`. */
    const dropFksOn = async (table: string, column: string) => {
      const fks = await dbService.query<{ CONSTRAINT_NAME: string }>(
        `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table, column]
      );
      for (const fk of fks) {
        try {
          await dbService.execute(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
        } catch (_) {}
      }
    };

    const renameColumn = async (table: string, from: string, to: string, type: string) => {
      if (!(await tableExists(table))) return;
      if (!(await columnExists(table, from)) || (await columnExists(table, to))) return;
      await dropFksOn(table, from);
      await dbService.execute(`ALTER TABLE \`${table}\` CHANGE \`${from}\` \`${to}\` ${type}`);
    };

    const addFk = async (table: string, column: string, refTable: string, name: string) => {
      if (!(await tableExists(table)) || !(await columnExists(table, column))) return;
      const existing = await dbService.queryOne<{ c: number }>(
        `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table, column]
      );
      if (Number(existing?.c ?? 0) > 0) return;
      try {
        await dbService.execute(
          `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\`
           FOREIGN KEY (\`${column}\`) REFERENCES \`${refTable}\`(\`id\`) ON DELETE CASCADE`
        );
      } catch (e) {
        logger.warn(`Could not add foreign key ${name} on ${table}.${column}:`, e);
      }
    };

    try {
      // 1. Original names move to the new ones, if they are still around.
      if ((await tableExists('stock_items')) && !(await tableExists('stocks'))) {
        await dbService.execute('RENAME TABLE `stock_items` TO `stocks`');
        logger.info('Renamed stock_items -> stocks');
      }
      if ((await tableExists('stock_entries')) && !(await tableExists('stock_vendor_purchase'))) {
        await dbService.execute('RENAME TABLE `stock_entries` TO `stock_vendor_purchase`');
        logger.info('Renamed stock_entries -> stock_vendor_purchase');
      }

      // 2. If the two names landed on the wrong tables, swap them. `stocks`
      //    holding entry_number means it is the ledger, not the master.
      const stocksIsLedger = await columnExists('stocks', 'entry_number');
      const otherIsMaster = await columnExists('stock_vendor_purchase', 'stock_code');
      if (stocksIsLedger && otherIsMaster) {
        await dropFksOn('stocks', 'stock_item_id');
        await dropFksOn('stock_movements', 'stock_item_id');
        await dbService.execute(
          'RENAME TABLE `stocks` TO `__stock_swap_tmp`, `stock_vendor_purchase` TO `stocks`, `__stock_swap_tmp` TO `stock_vendor_purchase`'
        );
        logger.info('Swapped stocks <-> stock_vendor_purchase so the master is `stocks`');
      }

      // 3. The link column is `stock_id` everywhere now.
      await renameColumn('stock_vendor_purchase', 'stock_item_id', 'stock_id', 'INT NOT NULL');
      await renameColumn('stock_movements', 'stock_item_id', 'stock_id', 'INT NOT NULL');
      for (const t of ['products', 'product_variants', 'product_addons']) {
        await renameColumn(t, 'stock_item_id', 'stock_id', 'INT NULL');
      }

      // 4. Re-establish the two owning references.
      await addFk('stock_vendor_purchase', 'stock_id', 'stocks', 'fk_svp_stock');
      await addFk('stock_movements', 'stock_id', 'stocks', 'fk_stock_movements_stock');
    } catch (e) {
      logger.warn('Could not ensure stock table topology:', e);
    }
  }

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
       FROM stocks si
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
       FROM stocks si
       ${where}`,
      params
    );

    const stockItems = await dbService.query(
      `SELECT si.*,
              (si.current_quantity <= si.min_stock_alert) as is_low_stock,
              si.current_quantity as current_stock
       FROM stocks si
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
       FROM stocks si
       WHERE si.id = ?`,
      [id]
    );

    if (!item) {
      throw AppError.notFound('Stock item not found');
    }

    // Recent entries
    const entries = await dbService.query(
      `SELECT se.*, u.name as created_by_name
       FROM stock_vendor_purchase se
       LEFT JOIN users u ON se.created_by = u.id
       WHERE se.stock_id = ?
       ORDER BY se.entry_date DESC
       LIMIT 10`,
      [id]
    );

    // Recent movements
    const movements = await dbService.query(
      `SELECT sm.*, u.name as created_by_name
       FROM stock_movements sm
       LEFT JOIN users u ON sm.created_by = u.id
       WHERE sm.stock_id = ?
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
        // Numbered from the highest code in use, not from COUNT(*). With the
        // count, deleting any ledger item made the next number collide with a
        // code already taken — STK-0042 with 41 rows — and every attempt to
        // add a stock item failed with a 409 the operator could do nothing
        // about. Only auto-generated codes are advanced here; a code typed by
        // the user still conflicts loudly, which is correct.
        const maxRes = await dbService.queryOne<{ max_num: number | null }>(
          `SELECT MAX(CAST(SUBSTRING(stock_code, 5) AS UNSIGNED)) AS max_num
           FROM stocks
           WHERE stock_code REGEXP '^STK-[0-9]+$'`
        );
        let next = Number(maxRes?.max_num || 0) + 1;
        // Belt and braces: skip anything already present (a hand-typed code
        // could sit anywhere in the range).
        for (let attempt = 0; attempt < 50; attempt++) {
          const candidate = `STK-${String(next).padStart(4, '0')}`;
          const taken = await dbService.queryOne('SELECT id FROM stocks WHERE stock_code = ?', [candidate]);
          if (!taken) { code = candidate; break; }
          next++;
        }
        if (!code) {
          throw AppError.conflict('Could not allocate a free stock code. Supply one explicitly.');
        }
      } else {
        // Check unique code
        const existing = await dbService.queryOne('SELECT id FROM stocks WHERE stock_code = ?', [code]);
        if (existing) {
          throw AppError.conflict(`Stock code "${code}" already exists`);
        }
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
        `INSERT INTO stocks (
          uuid, stock_code, name, unit_type, current_quantity,
          current_value, average_unit_price, status, min_stock_alert
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [uuid, code, data.name, unitType, totalQty, totalPrice, unitPrice, minAlert]
      );

      const stockId = res.lastInsertRowid;

      // If initial stock provided, log entry and movement
      if (totalQty > 0) {
        const entryUuid = `entry-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
        const moveUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
        const entryNumber = `STK-IN-${String(stockId).padStart(5, '0')}`;

        // An opening balance bought from a named vendor is still a purchase,
        // so it is booked as one and carries the link; without a vendor it is
        // the plain opening row.
        await dbService.execute(
          `INSERT INTO stock_vendor_purchase (
            uuid, stock_id, vendor_id, entry_number, quantity, multiplier,
            total_quantity, total_price, unit_price, status, supplier, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, 'Opening inventory entry', ?)`,
          [entryUuid, stockId, vendor?.id ?? null, entryNumber, baseQty, multiplier, totalQty, totalPrice, unitPrice, vendor ? 'Vendor' : 'Initial Setup', userId]
        );

        await dbService.execute(
          `INSERT INTO stock_movements (
            uuid, stock_id, movement_type, reference_type, reference_id,
            quantity, unit_price, total_value, balance_quantity, balance_value, notes, created_by
          ) VALUES (?, ?, 'in', 'INITIAL_STOCK', ?, ?, ?, ?, ?, ?, 'Opening inventory initial stock', ?)`,
          [moveUuid, stockId, entryNumber, totalQty, unitPrice, totalPrice, totalQty, totalPrice, userId]
        );
      }

      await AuditService.log({
        userId,
        action: 'STOCK_ITEM_CREATED',
        module: 'STOCK',
        recordId: stockId,
        newValues: { name: data.name, stockCode: code, unitType, baseQty, multiplier, totalQty, totalPrice, unitPrice, vendorId: vendor?.id ?? null, vendorName: vendor?.name ?? null },
      });

      return await this.getStockItemById(stockId);
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
      `UPDATE stocks
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
   * Append to stock_vendor_purchase without updating old entries.
   * Update stocks balance & weighted average unit price.
   * Append to stock_movements audit trail.
   */
  static async createStockEntry(
    data: {
      stockId?: number;
      productId?: number;
      vendorId?: number | null;
      quantity: number;
      multiplier?: number;
      totalPrice?: number;
      unitPrice?: number;
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
      if (data.stockId) {
        stockItem = await dbService.queryOne('SELECT * FROM stocks WHERE id = ?', [data.stockId]);
      } else if (data.productId) {
        stockItem = await dbService.queryOne('SELECT * FROM stocks WHERE product_id = ?', [data.productId]);
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

      // 2b. The entry records which vendor this purchase came from. Resolving
      // it here refuses a missing or blocked vendor before anything is written.
      // `supplier` is only the source of the batch — the vendor's identity is
      // vendor_id, so a rename is picked up by the join rather than frozen in
      // a text column that then disagrees with the linked row.
      let vendorId: number | null = null;
      let vendorName: string | null = null;
      if (data.vendorId !== undefined && data.vendorId !== null) {
        const vendor = await this.resolveVendor(Number(data.vendorId));
        vendorId = vendor.id;
        vendorName = vendor.name;
      }
      const source: 'Initial Setup' | 'Vendor' = vendorId !== null ? 'Vendor' : 'Initial Setup';

      // 3. Generate Sequential Entry Number (e.g. STK-IN-00001)
      const countRes = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM stock_vendor_purchase');
      const nextSeq = (countRes?.count || 0) + 1;
      const entryNumber = `STK-IN-${String(nextSeq).padStart(5, '0')}`;
      const entryUuid = `entry-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const movementUuid = `move-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const entryDate = data.entryDate || new Date().toISOString().slice(0, 19).replace('T', ' ');

      // 4. Insert into stock_vendor_purchase
      const entryRes = await dbService.execute(
        `INSERT INTO stock_vendor_purchase (
          uuid, stock_id, vendor_id, entry_number, entry_date, quantity,
          multiplier, total_quantity, total_price, unit_price, status,
          supplier, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`,
        [
          entryUuid,
          stockItem.id,
          vendorId,
          entryNumber,
          entryDate,
          baseQuantity,
          multiplier,
          totalQuantity,
          totalPrice,
          unitPrice,
          source,
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
          uuid, stock_id, movement_type, reference_type, reference_id,
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
          data.notes || (vendorName ? `Purchase from ${vendorName}` : 'Stock Purchase Addition'),
          userId,
        ]
      );

      // 7. Update stocks Master
      await dbService.execute(
        `UPDATE stocks
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
          stockId: stockItem.id,
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
        stockId: stockItem.id,
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
    stockId?: number,
    search?: string,
    supplier?: 'Initial Setup' | 'Vendor',
    dateFrom?: string,
    dateTo?: string,
    vendorId?: number
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (stockId) {
      where += ' AND se.stock_id = ?';
      params.push(stockId);
    }

    if (vendorId) {
      where += ' AND se.vendor_id = ?';
      params.push(vendorId);
    }

    if (search) {
      where +=
        ' AND (se.entry_number LIKE ? OR si.name LIKE ? OR si.stock_code LIKE ? OR v.name LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term, term, term);
    }

    if (supplier) {
      where += ' AND se.supplier = ?';
      params.push(supplier);
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
       FROM stock_vendor_purchase se
       JOIN stocks si ON se.stock_id = si.id
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
              u.name as created_by_name
       FROM stock_vendor_purchase se
       JOIN stocks si ON se.stock_id = si.id
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
      stockId?: number;
      productId?: number;
      /**
       * `return` and `return_to_supplier` are opposite directions and must not
       * be confused. `return` is a customer handing goods back, so stock comes
       * in — that is what RefundsService.restock sends. `return_to_supplier` is
       * goods going back to the vendor, so stock goes out.
       */
      adjustmentType:
        | 'INCREASE'
        | 'DECREASE'
        | 'adjustment'
        | 'wastage'
        | 'return'
        | 'return_to_supplier'
        | 'in'
        | 'out';
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
      if (data.stockId) {
        stockItem = await dbService.queryOne('SELECT * FROM stocks WHERE id = ?', [data.stockId]);
      } else if (data.productId) {
        stockItem = await dbService.queryOne('SELECT * FROM stocks WHERE product_id = ?', [data.productId]);
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
      // Both are logged against the 'return' movement type; the direction is
      // carried by the signed quantity, not by the label.
      else if (data.adjustmentType === 'return' || data.adjustmentType === 'return_to_supplier') movementType = 'return';
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
          uuid, stock_id, movement_type, reference_type, reference_id,
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

      // Update stocks
      await dbService.execute(
        `UPDATE stocks
         SET current_quantity = ?,
             current_value = ?,
             average_unit_price = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newQuantity, newValue, newAvgPrice, stockItem.id]
      );

      // Keep the dish's own counter in step with the ledger item behind it.
      if (stockItem.product_id) {
        await dbService.execute('UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
          newQuantity,
          stockItem.product_id,
        ]);

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
        stockId: stockItem.id,
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
    stockId?: number,
    movementType?: string,
    search?: string,
    dateFrom?: string,
    dateTo?: string
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (stockId) {
      where += ' AND sm.stock_id = ?';
      params.push(stockId);
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
       JOIN stocks si ON sm.stock_id = si.id
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
       JOIN stocks si ON sm.stock_id = si.id
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
         COUNT(DISTINCT CASE WHEN si.current_quantity <= si.min_stock_alert THEN si.id END) as min_stock_count
       FROM stocks si
       WHERE si.status = 'active'`
    );

    const itemsQuery = `
      SELECT
        si.*,
        CASE
          WHEN si.current_quantity <= 0 THEN 'OUT_OF_STOCK'
          WHEN si.current_quantity <= si.min_stock_alert THEN 'LOW_STOCK'
          ELSE 'NORMAL'
        END as alert_category,
        CASE
          WHEN si.current_quantity <= 0 THEN 'critical'
          WHEN si.current_quantity <= (si.min_stock_alert / 2) THEN 'critical'
          WHEN si.current_quantity <= si.min_stock_alert THEN 'warning'
          ELSE 'normal'
        END as severity,
        GREATEST(0, (COALESCE(si.min_stock_alert, 10) * 2 - si.current_quantity)) as suggested_reorder_quantity
      FROM stocks si
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
       FROM stocks si
       LEFT JOIN products p ON p.stock_id = si.id
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
      stockId?: number;
      quantity: number;
      multiplier?: number;
      totalPrice?: number;
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
    let stockId: number | undefined;
    if (productId) {
      const item = await dbService.queryOne<{ id: number }>('SELECT id FROM stocks WHERE product_id = ?', [productId]);
      stockId = item?.id;
    }
    return await this.getStockMovements(page, limit, stockId, type);
  }
}
