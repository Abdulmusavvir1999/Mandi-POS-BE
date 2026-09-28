import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { ProductImageService } from './product-image.service';
import { ParamUtil } from '../utils/param.util';

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
}

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

      // Ensure stock_consumption in product_variants
      try {
        const pvColCheck = await dbService.queryOne<{ count: number }>(`
          SELECT COUNT(*) as count 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = 'product_variants' 
            AND COLUMN_NAME = 'stock_consumption'
        `);
        if (!pvColCheck || pvColCheck.count === 0) {
          await dbService.execute('ALTER TABLE product_variants ADD COLUMN `stock_consumption` DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER `stock_id`');
        }
      } catch (_) {}

      this.schemaEnsured = true;
    } catch (_) {}
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
        `SELECT v.id, v.product_id, v.name, v.stock_id, v.stock_consumption,
                v.selling_price, v.display_order, v.is_default, v.status,
                si.name       AS stock_item_name,
                si.stock_code AS stock_item_code,
                si.unit_type  AS stock_item_unit,
                si.current_quantity AS stock_item_quantity
         FROM product_variants v
         LEFT JOIN stocks si ON si.id = v.stock_id
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
      return await dbService.query(
        `SELECT v.id, v.product_id, v.name, v.stock_id, v.stock_consumption,
                v.selling_price, v.display_order, v.is_default, v.status,
                si.name       AS stock_item_name,
                si.stock_code AS stock_item_code,
                si.unit_type  AS stock_item_unit,
                si.current_quantity AS stock_item_quantity
         FROM product_variants v
         LEFT JOIN stocks si ON si.id = v.stock_id
         WHERE v.product_id = ?
         ORDER BY v.display_order ASC, v.id ASC`,
        [productId]
      );
    } catch {
      return [];
    }
  }

  /**
   * Replaces a dish's variant set in one go — the editor sends the full list,
   * which keeps "removed a row" and "renamed a row" from needing their own
   * endpoints. Rows still referenced by past orders are untouched: bill_items
   * and order_items keep their own copy of the name and consumption.
   */
  private static async replaceVariants(productId: number, variants: ProductVariantInput[] | undefined) {
    if (variants === undefined) return;

    await dbService.execute('DELETE FROM product_variants WHERE product_id = ?', [productId]);

    const rows = variants.filter((v) => v && String(v.name || '').trim().length > 0);
    if (rows.length === 0) return;

    if (rows.length < 2) {
      throw AppError.badRequest('At least 2 variants are required when configuring variants for a product.');
    }

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
      const stockUsage = v.stockConsumption !== undefined && v.stockConsumption !== null
        ? Number(v.stockConsumption)
        : v.stock_consumption !== undefined && v.stock_consumption !== null
        ? Number(v.stock_consumption)
        : 1.0;

      await dbService.execute(
        `INSERT INTO product_variants (product_id, name, stock_id, stock_consumption, selling_price, display_order, is_default, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          String(v.name).trim(),
          v.stockId ? Number(v.stockId) : (v.stock_id ? Number(v.stock_id) : null),
          stockUsage > 0 ? stockUsage : 1.0,
          Number(v.sellingPrice ?? v.selling_price) || 0,
          displayOrders[i],
          isDefault ? 1 : 0,
          v.status || 'ACTIVE',
        ]
      );
    }
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
              si.current_quantity AS linked_stock_quantity, si.unit_type AS linked_unit_type
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
    lowStockThreshold?: number;
    status?: string;
    stockId?: number | null;
    variantStockMode?: 'COMMON' | 'EACH';
    variants?: ProductVariantInput[];
  }, userId: number) {
    await this.ensureSchema();
    const existingSku = await dbService.queryOne('SELECT id FROM products WHERE sku = ?', [data.sku]);
    if (existingSku) {
      throw AppError.conflict('Product SKU already exists');
    }

    return await dbService.transaction(async () => {
      const res = await dbService.execute(
        `INSERT INTO products (
          category_id, name, sku, description, image_url,
          tax_rate, stock_quantity,
          low_stock_threshold, is_available, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          data.categoryId,
          data.name,
          data.sku,
          data.description || null,
          data.imageUrl || null,
          data.taxRate !== undefined ? data.taxRate : 5.0,
          0,
          data.lowStockThreshold || 10,
          data.status || 'ACTIVE',
        ]
      );

      const productId = res.lastInsertRowid;
      // A dish only points at a stock item (products.stock_id); it never
      // creates or changes one. Stock items are made and filled in the Stock
      // Ledger, and a dish with none picked simply draws no stock when sold.
      const assignedStockItemId = data.stockId ? Number(data.stockId) : null;
      await dbService.execute(
        'UPDATE products SET stock_id = ?, variant_stock_mode = COALESCE(?, variant_stock_mode) WHERE id = ?',
        [assignedStockItemId, data.variantStockMode || null, productId]
      );

      await this.replaceVariants(productId, data.variants);

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
    lowStockThreshold?: number;
    isAvailable?: boolean;
    status?: string;
    stockId?: number | null;
    variantStockMode?: 'COMMON' | 'EACH';
    variants?: ProductVariantInput[];
  }, userId: number) {
    await this.ensureSchema();
    const current = await this.getById(id);

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
             low_stock_threshold = COALESCE(?, low_stock_threshold),
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
          data.lowStockThreshold,
          data.isAvailable !== undefined ? (data.isAvailable ? 1 : 0) : null,
          data.status,
          id,
        ]
      );

      if (data.stockId !== undefined || data.variantStockMode !== undefined) {
        await dbService.execute(
          `UPDATE products
           SET stock_id = CASE WHEN ? THEN ? ELSE stock_id END,
               variant_stock_mode = COALESCE(?, variant_stock_mode)
           WHERE id = ?`,
          [
            data.stockId !== undefined ? 1 : 0,
            data.stockId ? Number(data.stockId) : null,
            data.variantStockMode || null,
            id,
          ]
        );
      }

      await this.replaceVariants(id, data.variants);

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
