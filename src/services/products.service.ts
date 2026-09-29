import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { ProductImageService } from './product-image.service';
import { ParamUtil } from '../utils/param.util';
import { logger } from '../config/logger';

export interface ProductVariantInput {
  id?: number;
  name: string;
  /** Ledger item this portion draws from; null falls back to the dish's own. */
  stockId?: number | null;
  stock_id?: number | null;
  stockConsumption?: number;
  stock_consumption?: number;
  sellingPrice?: number;
  selling_price?: number;
  displayOrder?: number;
  display_order?: number;
  isDefault?: boolean | number;
  is_default?: boolean | number;
  status?: string;
  /** MULTI mode only: every stock item one sale of this portion draws on. */
  stocks?: VariantStockInput[];
}

export interface VariantStockInput {
  stockId?: number | null;
  stock_id?: number | null;
  /** Stock units one portion draws, in the stock item's own unit. */
  stockConsumption?: number;
  stock_consumption?: number;
  /** Older name for stockConsumption, still accepted. */
  quantity?: number;
}

export type VariantStockMode = 'COMMON' | 'EACH' | 'MULTI';
const STOCK_MODES: VariantStockMode[] = ['COMMON', 'EACH', 'MULTI'];

export class ProductsService {
  private static schemaEnsured = false;

  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    try {
      const deprecatedCols = ['cost_price', 'selling_price'];
      for (const col of deprecatedCols) {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'products' 
              AND COLUMN_NAME = ?
          `, [col]);
          if (colCheck && colCheck.count > 0) {
            await dbService.execute(`ALTER TABLE products DROP COLUMN \`${col}\``);
          }
        } catch (_) {}
      }

      // Multi Stock: the MULTI mode value, the per-portion recipe table and
      // the per-sale usage record. Mirrors schema.sql for older databases.
      try {
        const modeCol = await dbService.queryOne<{ COLUMN_TYPE: string }>(`
          SELECT COLUMN_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'products'
            AND COLUMN_NAME = 'variant_stock_mode'
        `);
        if (modeCol && !String(modeCol.COLUMN_TYPE).includes("'MULTI'")) {
          await dbService.execute(
            "ALTER TABLE products MODIFY COLUMN variant_stock_mode ENUM('COMMON', 'EACH', 'MULTI') NOT NULL DEFAULT 'COMMON'"
          );
        }
      } catch (_) {}

      try {
        await dbService.execute(`
          CREATE TABLE IF NOT EXISTS product_variant_stocks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            variant_id INT NOT NULL,
            stock_id INT NOT NULL,
            stock_consumption DECIMAL(12,3) NOT NULL,
            display_order INT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_pvs_variant_stock (variant_id, stock_id),
            INDEX idx_pvs_stock (stock_id),
            CONSTRAINT fk_pvs_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
            CONSTRAINT fk_pvs_stock FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE RESTRICT
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      } catch (_) {}

      try {
        await dbService.execute(`
          CREATE TABLE IF NOT EXISTS bill_item_stock_usage (
            id INT AUTO_INCREMENT PRIMARY KEY,
            bill_item_id INT NOT NULL,
            stock_id INT NOT NULL,
            quantity_per_unit DECIMAL(12,3) NOT NULL,
            INDEX idx_bisu_bill_item (bill_item_id),
            INDEX idx_bisu_stock (stock_id),
            CONSTRAINT fk_bisu_bill_item FOREIGN KEY (bill_item_id) REFERENCES bill_items(id) ON DELETE CASCADE,
            CONSTRAINT fk_bisu_stock FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      } catch (_) {}

      await this.moveVariantStockToRecipes();

      this.schemaEnsured = true;
    } catch (_) {}
  }

  /**
   * One place for a portion's stock: product_variant_stocks.
   *
   * Older databases kept a Common/Each portion's item and amount on
   * product_variants (stock_id, stock_consumption) and only Multi Stock used
   * product_variant_stocks, whose amount column was called `quantity`. This
   * moves everything into product_variant_stocks.stock_consumption, in an
   * order that is safe to interrupt and re-run:
   *
   *   1. back up the two columns (product_variants_stock_bak, kept);
   *   2. rename product_variant_stocks.quantity -> stock_consumption;
   *   3. copy each Common/Each portion into one row - its own item, else the
   *      dish's, which is how checkout resolved it - skipping portions that
   *      already have rows;
   *   4. drop the two columns, only if step 3 went through.
   *
   * A very old database may still call the link `stock_item_id` (the stock
   * topology rename runs later at startup), so both names are accepted.
   */
  private static async moveVariantStockToRecipes(): Promise<void> {
    const hasColumn = async (table: string, column: string) => {
      const row = await dbService.queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      return Number(row?.c ?? 0) > 0;
    };

    try {
      // 2. Rename the recipe amount column first, so the copy writes the new name.
      if ((await hasColumn('product_variant_stocks', 'quantity')) && !(await hasColumn('product_variant_stocks', 'stock_consumption'))) {
        await dbService.execute(
          'ALTER TABLE product_variant_stocks CHANGE COLUMN `quantity` `stock_consumption` DECIMAL(12,3) NOT NULL'
        );
      }

      const variantLink = (await hasColumn('product_variants', 'stock_id'))
        ? 'stock_id'
        : (await hasColumn('product_variants', 'stock_item_id')) ? 'stock_item_id' : null;
      const hasConsumption = await hasColumn('product_variants', 'stock_consumption');
      if (!variantLink && !hasConsumption) return; // already moved

      const productLink = (await hasColumn('products', 'stock_id')) ? 'stock_id' : 'stock_item_id';
      const amount = hasConsumption ? 'CASE WHEN v.stock_consumption > 0 THEN v.stock_consumption ELSE 1 END' : '1';

      // 1. Backup, once.
      if (variantLink) {
        await dbService.execute(
          `CREATE TABLE IF NOT EXISTS product_variants_stock_bak AS
           SELECT v.id, v.product_id, v.name, v.\`${variantLink}\` AS stock_id,
                  ${hasConsumption ? 'v.stock_consumption' : '1.000'} AS stock_consumption,
                  CURRENT_TIMESTAMP AS backed_up_at
           FROM product_variants v`
        );

        // 3. Copy Common/Each portions (Multi already lives in the table).
        const copied = await dbService.execute(
          `INSERT INTO product_variant_stocks (variant_id, stock_id, stock_consumption, display_order)
           SELECT v.id, COALESCE(v.\`${variantLink}\`, p.\`${productLink}\`), ${amount}, 1
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN stocks s ON s.id = COALESCE(v.\`${variantLink}\`, p.\`${productLink}\`)
           WHERE p.variant_stock_mode <> 'MULTI'
             AND NOT EXISTS (SELECT 1 FROM product_variant_stocks x WHERE x.variant_id = v.id)`
        );
        logger.info(`Moved ${copied.changes} portion stock link(s) into product_variant_stocks`);
      }

      // 4. Drop the old columns (and any foreign key / index on the link).
      if (variantLink) {
        const fks = await dbService.query<{ CONSTRAINT_NAME: string }>(
          `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_variants'
             AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [variantLink]
        );
        for (const fk of fks) {
          await dbService.execute(`ALTER TABLE product_variants DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
        }
        await dbService.execute(`ALTER TABLE product_variants DROP COLUMN \`${variantLink}\``);
      }
      if (hasConsumption) {
        await dbService.execute('ALTER TABLE product_variants DROP COLUMN `stock_consumption`');
      }
    } catch (e) {
      // Leave whatever is left for the next start; every step checks first.
      logger.warn('Could not move portion stock into product_variant_stocks:', e);
    }
  }

  /**
   * Loads every listed product's variants in one query and re-exposes the
   * default variant's price as `product.selling_price`.
   *
   * Pricing moved off `products` onto `product_variants`, but the POS grid,
   * the products list, the product detail page and the back-office order
   * screen all still read `p.selling_price`, so dropping the column blanked
   * the price everywhere at once. The column is gone for good; this is the
   * compatibility shim that keeps those screens reading a price, taken from
   * the variant marked default (falling back to the first by display order,
   * which is the same row `getVariants` orders to the top).
   */
  private static async attachVariants(products: any[]) {
    for (const p of products) p.variants = [];
    if (products.length === 0) return;

    const ids = products.map((p) => p.id);
    let rows: any[] = [];
    try {
      rows = await dbService.query<any>(
        `SELECT v.id, v.product_id, v.name,
                v.selling_price, v.display_order, v.is_default, v.status
         FROM product_variants v
         WHERE v.product_id IN (${ids.map(() => '?').join(',')})
         ORDER BY v.display_order ASC, v.id ASC`,
        ids
      );
    } catch {
      return;
    }

    const byProduct = new Map<number, any[]>();
    for (const row of rows) {
      const list = byProduct.get(row.product_id) || [];
      list.push(row);
      byProduct.set(row.product_id, list);
    }

    await this.attachVariantStocks(rows);

    for (const p of products) {
      p.variants = byProduct.get(p.id) || [];
      if (p.selling_price === undefined) {
        const preferred = p.variants.find((v: any) => Number(v.is_default) === 1) || p.variants[0];
        p.selling_price = preferred ? preferred.selling_price : null;
      }
    }
  }

  static async getVariants(productId: number) {
    try {
      const rows = await dbService.query<any>(
        `SELECT v.id, v.product_id, v.name,
                v.selling_price, v.display_order, v.is_default, v.status
         FROM product_variants v
         WHERE v.product_id = ?
         ORDER BY v.display_order ASC, v.id ASC`,
        [productId]
      );
      await this.attachVariantStocks(rows);
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Sets `variant.stocks` on every row from product_variant_stocks - the one
   * place a portion's stock lives in every mode - each line with the stock
   * item's name, unit, balance and average cost so the form, the View page
   * and the POS can show and price it without another lookup.
   *
   * A Common/Each portion has exactly one line, so its item is also exposed
   * as `stock_id`, `stock_consumption` and `stock_item_*` on the variant,
   * the shape those screens have always read. They are derived here, not
   * stored anywhere else.
   */
  private static async attachVariantStocks(variants: any[]) {
    for (const v of variants) v.stocks = [];
    if (variants.length === 0) return;

    let rows: any[] = [];
    try {
      rows = await dbService.query<any>(
        `SELECT pvs.variant_id, pvs.stock_id, pvs.stock_consumption, pvs.display_order,
                s.name AS stock_name, s.stock_code, s.unit_type,
                s.current_quantity, s.average_unit_price, s.min_stock_alert, s.status AS stock_status,
                -- Balance after the item's latest stock-in: the "full" mark
                -- for its stock bar, same rule as the Dishes list and Stock page.
                (SELECT sm.balance_quantity
                   FROM stock_movements sm
                  WHERE sm.stock_id = s.id AND sm.movement_type = 'in' AND sm.quantity > 0
                  ORDER BY sm.id DESC
                  LIMIT 1) AS last_restock_quantity
         FROM product_variant_stocks pvs
         JOIN stocks s ON s.id = pvs.stock_id
         WHERE pvs.variant_id IN (${variants.map(() => '?').join(',')})
         ORDER BY pvs.display_order ASC, pvs.id ASC`,
        variants.map((v) => v.id)
      );
    } catch {
      return;
    }

    const byVariant = new Map<number, any[]>();
    for (const r of rows) {
      const list = byVariant.get(Number(r.variant_id)) || [];
      list.push({
        stock_id: Number(r.stock_id),
        stock_consumption: Number(r.stock_consumption),
        stock_name: r.stock_name,
        stock_code: r.stock_code,
        unit_type: r.unit_type,
        current_quantity: Number(r.current_quantity),
        average_unit_price: Number(r.average_unit_price),
        min_stock_alert: Number(r.min_stock_alert),
        last_restock_quantity: r.last_restock_quantity === null ? null : Number(r.last_restock_quantity),
        stock_status: r.stock_status,
      });
      byVariant.set(Number(r.variant_id), list);
    }
    for (const v of variants) {
      v.stocks = byVariant.get(Number(v.id)) || [];
      const first = v.stocks[0];
      v.stock_id = first ? first.stock_id : null;
      v.stock_consumption = first ? first.stock_consumption : 1;
      v.stock_item_name = first?.stock_name ?? null;
      v.stock_item_code = first?.stock_code ?? null;
      v.stock_item_unit = first?.unit_type ?? null;
      v.stock_item_quantity = first ? first.current_quantity : null;
    }
  }

  /**
   * Replaces a dish's variant set in one go — the editor sends the full list,
   * which keeps "removed a row" and "renamed a row" from needing their own
   * endpoints. Rows still referenced by past orders are untouched: bill_items
   * and order_items keep their own copy of the name and consumption.
   *
   * Every portion's stock is written to product_variant_stocks, whatever the
   * mode: COMMON - one row, the dish's shared item (commonStockId) at the
   * portion's stock_consumption; EACH - one row, the portion's own item;
   * MULTI - one row per item on its list.
   */
  private static async replaceVariants(
    productId: number,
    variants: ProductVariantInput[] | undefined,
    mode: VariantStockMode = 'COMMON',
    commonStockId: number | null = null
  ) {
    if (variants === undefined) return;

    const rows = variants.filter((v) => v && String(v.name || '').trim().length > 0);
    const isMulti = mode === 'MULTI';

    // A Multi Stock dish keeps its recipe on the portions, so it needs at
    // least one; a single "Regular" portion is fine. The other modes keep the
    // "none, or at least 2" rule - one portion there is just the dish itself.
    if (isMulti && rows.length === 0) {
      throw AppError.badRequest('Multi Stock needs at least one portion with the stock items it uses.');
    }
    if (!isMulti && rows.length === 1) {
      throw AppError.badRequest('At least 2 variants are required when configuring variants for a product.');
    }

    // Validated before anything is deleted, so a bad recipe leaves the dish as it was.
    const recipes = isMulti ? await this.validateRecipes(rows) : await this.singleStockRecipes(rows, mode, commonStockId);

    await dbService.execute('DELETE FROM product_variants WHERE product_id = ?', [productId]);
    if (rows.length === 0) return;

    // Validate display order uniqueness
    const displayOrders = rows.map((v, i) =>
      v.displayOrder !== undefined && v.displayOrder !== null
        ? Number(v.displayOrder)
        : v.display_order !== undefined && v.display_order !== null
        ? Number(v.display_order)
        : i + 1
    );
    if (new Set(displayOrders).size !== displayOrders.length) {
      throw AppError.badRequest('Variant display orders cannot be duplicated for the same product.');
    }

    // Determine default: exact matching or first item
    const explicitDefaultIndex = rows.findIndex((v) => Boolean(v.isDefault || v.is_default));
    const targetDefaultIndex = explicitDefaultIndex >= 0 ? explicitDefaultIndex : 0;

    for (let i = 0; i < rows.length; i++) {
      const v = rows[i];
      const isDefault = i === targetDefaultIndex;

      const res = await dbService.execute(
        `INSERT INTO product_variants (product_id, name, selling_price, display_order, is_default, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productId,
          String(v.name).trim(),
          Number(v.sellingPrice ?? v.selling_price) || 0,
          displayOrders[i],
          isDefault ? 1 : 0,
          v.status || 'ACTIVE',
        ]
      );

      const variantId = res.lastInsertRowid;
      for (let j = 0; j < recipes[i].length; j++) {
        const line = recipes[i][j];
        await dbService.execute(
          'INSERT INTO product_variant_stocks (variant_id, stock_id, stock_consumption, display_order) VALUES (?, ?, ?, ?)',
          [variantId, line.stockId, line.stockConsumption, j + 1]
        );
      }
    }
  }

  /** A portion's per-portion amount from any of the accepted field names, else 1. */
  private static consumptionOf(input: { stockConsumption?: number; stock_consumption?: number; quantity?: number }): number {
    const raw = input.stockConsumption ?? input.stock_consumption ?? input.quantity;
    const n = Number(raw);
    return raw !== undefined && raw !== null && n > 0 ? Math.round(n * 1000) / 1000 : 1;
  }

  /**
   * COMMON / EACH: one row per portion - the dish's shared item or the
   * portion's own. A portion with no item draws no stock (as before), so it
   * gets no row; an id that is not a stock item is refused.
   */
  private static async singleStockRecipes(rows: ProductVariantInput[], mode: VariantStockMode, commonStockId: number | null) {
    const recipes = rows.map((v) => {
      const stockId = mode === 'EACH'
        ? Number(v.stockId ?? v.stock_id) || 0
        : Number(commonStockId) || 0;
      return stockId ? [{ stockId, stockConsumption: this.consumptionOf(v) }] : [];
    });

    const ids = [...new Set(recipes.flat().map((l) => l.stockId))];
    if (ids.length > 0) {
      const found = await dbService.query<{ id: number }>(
        `SELECT id FROM stocks WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      const known = new Set(found.map((s) => Number(s.id)));
      const missing = ids.find((id) => !known.has(id));
      if (missing) {
        throw AppError.badRequest(`Stock item ${missing} no longer exists - pick another one.`);
      }
    }
    return recipes;
  }

  /**
   * Checks every portion's Multi Stock list and returns it cleaned up, one
   * array per portion in the same order. Each portion needs at least one
   * stock item, each with a quantity above zero, no item twice in the same
   * portion, and every item an existing, active stock item.
   */
  private static async validateRecipes(rows: ProductVariantInput[]) {
    const recipes: { stockId: number; stockConsumption: number }[][] = [];
    const allIds = new Set<number>();

    for (const v of rows) {
      const portion = String(v.name).trim();
      const lines = (v.stocks || [])
        .map((s) => ({
          stockId: Number(s.stockId ?? s.stock_id) || 0,
          quantity: Number(s.stockConsumption ?? s.stock_consumption ?? s.quantity),
        }))
        .filter((s) => s.stockId > 0 || s.quantity > 0);

      if (lines.length === 0) {
        throw AppError.badRequest(`Portion "${portion}" needs at least one stock item in Multi Stock mode.`);
      }
      const seen = new Set<number>();
      for (const line of lines) {
        if (!line.stockId) {
          throw AppError.badRequest(`Portion "${portion}": pick a stock item on every line.`);
        }
        if (!(line.quantity > 0)) {
          throw AppError.badRequest(`Portion "${portion}": every stock item needs a quantity above 0.`);
        }
        if (seen.has(line.stockId)) {
          throw AppError.badRequest(`Portion "${portion}" lists the same stock item twice - combine it into one line.`);
        }
        seen.add(line.stockId);
        allIds.add(line.stockId);
      }
      recipes.push(lines.map((l) => ({ stockId: l.stockId, stockConsumption: Math.round(l.quantity * 1000) / 1000 })));
    }

    const ids = [...allIds];
    const found = await dbService.query<{ id: number; name: string; status: string }>(
      `SELECT id, name, status FROM stocks WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const byId = new Map(found.map((s) => [Number(s.id), s]));
    for (const id of ids) {
      const stock = byId.get(id);
      if (!stock) {
        throw AppError.badRequest(`Stock item ${id} no longer exists - pick another one.`);
      }
      if (stock.status !== 'active') {
        throw AppError.badRequest(`Stock item "${stock.name}" is inactive - activate it or pick another one.`);
      }
    }
    return recipes;
  }

  private static parseStockMode(mode: unknown): VariantStockMode | undefined {
    if (mode === undefined || mode === null || mode === '') return undefined;
    const upper = String(mode).toUpperCase() as VariantStockMode;
    if (!STOCK_MODES.includes(upper)) {
      throw AppError.badRequest('Stock mode must be Common Stock, Each Stock or Multi Stock.');
    }
    return upper;
  }

  static async getAll(
    page = 1,
    limit = 50,
    search?: string,
    categoryId?: number,
    status?: string,
    sortBy = 'name',
    sortOrder = 'ASC'
  ) {
    await this.ensureSchema();
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term, term);
    }

    if (categoryId) {
      where += ' AND p.category_id = ?';
      params.push(categoryId);
    }

    if (status) {
      where += ' AND p.status = ?';
      params.push(status);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM products p ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const allowedSort = ['name', 'stock_quantity', 'created_at', 'sku'];
    const validSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const validSortOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const products = await dbService.query<any>(
      `SELECT p.*, c.name as category_name,
              si.current_quantity AS current_stock,
              si.min_stock_alert  AS min_stock_alert,
              si.current_quantity AS linked_stock_quantity, si.unit_type AS linked_unit_type,
              -- Balance after the ledger item's latest stock-in: the "full"
              -- mark for the list's stock bar (same rule as the Stock page).
              (SELECT sm.balance_quantity
                 FROM stock_movements sm
                WHERE sm.stock_id = si.id AND sm.movement_type = 'in' AND sm.quantity > 0
                ORDER BY sm.id DESC
                LIMIT 1) AS last_restock_quantity
       FROM products p
       JOIN categories c ON p.category_id = c.id
       LEFT JOIN stocks si ON p.stock_id = si.id
       ${where}
       ORDER BY p.${validSortBy} ${validSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // One query for the whole page's variants rather than getVariants() per
    // row, which was a round trip per product — fifty on a default page.
    await this.attachVariants(products);

    return {
      data: products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    await this.ensureSchema();
    // The View page reports on the ledger item a dish draws from, so the join
    // carries the unit, the balance, the code and the weighted average cost.
    const product = await dbService.queryOne<any>(
      `SELECT p.*, c.name as category_name,
              si.current_quantity  AS current_stock,
              si.min_stock_alert   AS min_stock_alert,
              p.stock_id      AS resolved_stock_id,
              si.stock_code        AS linked_stock_code,
              si.current_quantity  AS linked_stock_quantity,
              si.unit_type         AS linked_unit_type,
              si.average_unit_price AS linked_avg_cost,
              si.min_stock_alert   AS linked_min_alert,
              si.status            AS linked_stock_status
       FROM products p
       JOIN categories c ON p.category_id = c.id
       LEFT JOIN stocks si ON p.stock_id = si.id
       WHERE p.id = ?`,
      [id]
    );

    if (!product) {
      throw AppError.notFound('Product not found');
    }

    product.variants = await this.getVariants(id);

    // Same compatibility shim as the list endpoint — the View page and its
    // margin figures read product.selling_price. See attachVariants().
    if (product.selling_price === undefined) {
      const preferred =
        product.variants.find((v: any) => Number(v.is_default) === 1) || product.variants[0];
      product.selling_price = preferred ? preferred.selling_price : null;
    }
    return product;
  }

  static async create(data: {
    categoryId: number;
    name: string;
    sku: string;
    description?: string;
    imageUrl?: string;
    taxRate?: number;
    status?: string;
    stockId?: number | null;
    variantStockMode?: VariantStockMode;
    variants?: ProductVariantInput[];
  }, userId: number) {
    await this.ensureSchema();
    const mode = this.parseStockMode(data.variantStockMode);
    const existingSku = await dbService.queryOne('SELECT id FROM products WHERE sku = ?', [data.sku]);
    if (existingSku) {
      throw AppError.conflict('Product SKU already exists');
    }

    return await dbService.transaction(async () => {
      const res = await dbService.execute(
        `INSERT INTO products (
          category_id, name, sku, description, image_url,
          tax_rate, stock_quantity, is_available, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          data.categoryId,
          data.name,
          data.sku,
          data.description || null,
          data.imageUrl || null,
          data.taxRate !== undefined ? data.taxRate : 5.0,
          0,
          data.status || 'ACTIVE',
        ]
      );

      const productId = res.lastInsertRowid;
      // A dish only points at a stock item (products.stock_id); it never
      // creates or changes one. Stock items are made and filled in the Stock
      // Ledger, and a dish with none picked simply draws no stock when sold.
      // A Multi Stock dish draws only through its portions' recipes, so its own
      // single link stays empty - otherwise that item could be counted too.
      const assignedStockItemId = mode !== 'MULTI' && data.stockId ? Number(data.stockId) : null;
      await dbService.execute(
        'UPDATE products SET stock_id = ?, variant_stock_mode = COALESCE(?, variant_stock_mode) WHERE id = ?',
        [assignedStockItemId, mode || null, productId]
      );

      if (mode === 'MULTI' && data.variants === undefined) {
        throw AppError.badRequest('Multi Stock needs at least one portion with the stock items it uses.');
      }
      await this.replaceVariants(productId, data.variants, mode || 'COMMON', assignedStockItemId);

      await AuditService.log({
        userId,
        action: 'PRODUCT_CREATED',
        module: 'PRODUCTS',
        recordId: productId,
        newValues: data,
      });

      return await this.getById(productId);
    });
  }

  static async update(id: number, data: {
    categoryId?: number;
    name?: string;
    sku?: string;
    description?: string;
    imageUrl?: string;
    taxRate?: number;
    isAvailable?: boolean;
    status?: string;
    stockId?: number | null;
    variantStockMode?: VariantStockMode;
    variants?: ProductVariantInput[];
  }, userId: number) {
    await this.ensureSchema();
    const current = await this.getById(id);
    const requestedMode = this.parseStockMode(data.variantStockMode);
    const mode: VariantStockMode = requestedMode || (current.variant_stock_mode as VariantStockMode) || 'COMMON';

    // Switching into Multi Stock without sending the portions would leave the
    // dish drawing no stock at all.
    if (mode === 'MULTI' && current.variant_stock_mode !== 'MULTI' && data.variants === undefined) {
      throw AppError.badRequest('Multi Stock needs at least one portion with the stock items it uses.');
    }

    if (data.sku && data.sku !== current.sku) {
      const existingSku = await dbService.queryOne('SELECT id FROM products WHERE sku = ? AND id != ?', [data.sku, id]);
      if (existingSku) {
        throw AppError.conflict('Product SKU already in use by another product');
      }
    }

    // One edit touches products and product_variants. Ungrouped, a failure
    // part-way left a dish's variants deleted and not put back, which is what
    // replaceVariants does first. Same grouping `create` already uses, audit
    // included. The linked stock item is never changed from here: several
    // dishes can share it, so it is edited only in the Stock Ledger.
    const updated = await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE products
         SET category_id = COALESCE(?, category_id),
             name = COALESCE(?, name),
             sku = COALESCE(?, sku),
             description = COALESCE(?, description),
             image_url = COALESCE(?, image_url),
             tax_rate = COALESCE(?, tax_rate),
             is_available = COALESCE(?, is_available),
             status = COALESCE(?, status),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          data.categoryId,
          data.name,
          data.sku,
          data.description,
          data.imageUrl,
          data.taxRate,
          data.isAvailable !== undefined ? (data.isAvailable ? 1 : 0) : null,
          data.status,
          id,
        ]
      );

      if (data.stockId !== undefined || requestedMode !== undefined) {
        // Multi Stock always clears the dish's own link (see create).
        const clearLink = mode === 'MULTI';
        await dbService.execute(
          `UPDATE products
           SET stock_id = CASE WHEN ? THEN ? ELSE stock_id END,
               variant_stock_mode = COALESCE(?, variant_stock_mode)
           WHERE id = ?`,
          [
            data.stockId !== undefined || clearLink ? 1 : 0,
            !clearLink && data.stockId ? Number(data.stockId) : null,
            requestedMode || null,
            id,
          ]
        );
      }

      // The dish's shared item after this edit - what Common portions draw.
      const commonStockId = mode === 'MULTI'
        ? null
        : data.stockId !== undefined ? (Number(data.stockId) || null) : (current.stock_id ?? null);

      if (data.variants === undefined && mode === 'COMMON' && data.stockId !== undefined) {
        // Shared item changed without the portions being re-sent: move every
        // portion's single row onto it (or drop them when it was cleared).
        if (commonStockId) {
          await dbService.execute(
            `UPDATE product_variant_stocks x
             JOIN product_variants v ON v.id = x.variant_id
             SET x.stock_id = ?
             WHERE v.product_id = ?`,
            [commonStockId, id]
          );
        } else {
          await dbService.execute(
            `DELETE x FROM product_variant_stocks x
             JOIN product_variants v ON v.id = x.variant_id
             WHERE v.product_id = ?`,
            [id]
          );
        }
      }

      await this.replaceVariants(id, data.variants, mode, commonStockId);

      await AuditService.log({
        userId,
        action: 'PRODUCT_UPDATED',
        module: 'PRODUCTS',
        recordId: id,
        oldValues: current,
        newValues: data,
      });

      return await this.getById(id);
    });

    // Deleting the replaced photo is a filesystem action and cannot be rolled
    // back, so it happens only once the row change has actually committed —
    // otherwise a failed edit destroyed the image the row still pointed at.
    if (data.imageUrl !== undefined && current.image_url && current.image_url !== data.imageUrl) {
      ProductImageService.removeByUrl(current.image_url);
    }

    return updated;
  }

  static async delete(id: number, userId: number) {
    await this.ensureSchema();
    const current = await this.getById(id);

    // Check if product is part of previous bills
    const billItemsCount = await dbService.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM bill_items WHERE product_id = ?',
      [id]
    );

    if (billItemsCount && billItemsCount.count > 0) {
      // Soft-delete by setting status to INACTIVE so audit and historical sales remain valid
      await dbService.execute("UPDATE products SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      await AuditService.log({
        userId,
        action: 'PRODUCT_DEACTIVATED',
        module: 'PRODUCTS',
        recordId: id,
        oldValues: current,
        newValues: { status: 'INACTIVE', reason: 'Has historical bill records' },
      });
      return { success: true, message: 'Product has previous sales records; status marked as INACTIVE' };
    }

    // Only the dish goes. Its stock item, ledger and purchase entries stay:
    // other dishes may draw on the same item, and purchases already sit on
    // vendor balances.
    await dbService.execute('DELETE FROM products WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'PRODUCT_DELETED',
      module: 'PRODUCTS',
      recordId: id,
      oldValues: current,
    });

    return { success: true, message: 'Product deleted permanently' };
  }

  static async checkSkuUnique(sku: string, excludeId?: number): Promise<{ isUnique: boolean; existingProduct?: { id: number; name: string; sku: string } | null }> {
    if (!sku || !sku.trim()) return { isUnique: true, existingProduct: null };
    let query = 'SELECT id, name, sku FROM products WHERE LOWER(sku) = LOWER(?)';
    const params: any[] = [sku.trim()];
    if (excludeId) {
      query += ' AND id != ?';
      params.push(excludeId);
    }
    const existing = await dbService.queryOne<{ id: number; name: string; sku: string }>(query, params);
    return {
      isUnique: !existing,
      existingProduct: existing || null,
    };
  }
}
