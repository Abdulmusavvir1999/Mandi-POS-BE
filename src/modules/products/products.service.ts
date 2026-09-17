import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';

export class ProductsService {
  static async getAll(
    page = 1,
    limit = 50,
    search?: string,
    categoryId?: number,
    status?: string,
    sortBy = 'name',
    sortOrder = 'ASC'
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
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

    const allowedSort = ['name', 'selling_price', 'cost_price', 'stock_quantity', 'created_at', 'sku'];
    const validSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const validSortOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const products = await dbService.query(
      `SELECT p.*, c.name as category_name, s.current_stock, s.min_stock_alert
       FROM products p
       JOIN categories c ON p.category_id = c.id
       LEFT JOIN stock s ON p.id = s.product_id
       ${where}
       ORDER BY p.${validSortBy} ${validSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

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
    const product = await dbService.queryOne(
      `SELECT p.*, c.name as category_name, s.current_stock, s.min_stock_alert
       FROM products p
       JOIN categories c ON p.category_id = c.id
       LEFT JOIN stock s ON p.id = s.product_id
       WHERE p.id = ?`,
      [id]
    );

    if (!product) {
      throw AppError.notFound('Product not found');
    }

    return product;
  }

  static async create(data: {
    categoryId: number;
    name: string;
    sku: string;
    description?: string;
    imageUrl?: string;
    costPrice?: number;
    sellingPrice: number;
    taxRate?: number;
    initialStock?: number;
    lowStockThreshold?: number;
    status?: string;
  }, userId: number) {
    const existingSku = await dbService.queryOne('SELECT id FROM products WHERE sku = ?', [data.sku]);
    if (existingSku) {
      throw AppError.conflict('Product SKU already exists');
    }

    return await dbService.transaction(async () => {
      const res = await dbService.execute(
        `INSERT INTO products (
          category_id, name, sku, description, image_url,
          cost_price, selling_price, tax_rate, stock_quantity,
          low_stock_threshold, is_available, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          data.categoryId,
          data.name,
          data.sku,
          data.description || null,
          data.imageUrl || null,
          data.costPrice || 0,
          data.sellingPrice,
          data.taxRate !== undefined ? data.taxRate : 5.0,
          data.initialStock || 0,
          data.lowStockThreshold || 10,
          data.status || 'ACTIVE',
        ]
      );

      const productId = res.lastInsertRowid;
      const initialStock = Number(data.initialStock) || 0;
      const costPrice = Number(data.costPrice) || 0;
      const initialVal = initialStock * costPrice;

      // 1. Create 3-Tier Stock Master record
      const stockCode = `STK-${String(productId).padStart(4, '0')}`;
      const itemUuid = `item-${productId}-${Date.now().toString(36)}`;
      const stkRes = await dbService.execute(
        `INSERT INTO stock_items (uuid, stock_code, name, unit_type, current_quantity, current_value, average_unit_price, status, min_stock_alert, product_id)
         VALUES (?, ?, ?, 'piece', ?, ?, ?, 'active', ?, ?)`,
        [itemUuid, stockCode, data.name, initialStock, initialVal, costPrice, data.lowStockThreshold || 10, productId]
      );
      const stockItemId = stkRes.lastInsertRowid;

      if (initialStock > 0) {
        const entryNum = `ENT-${String(productId).padStart(4, '0')}-INIT`;
        const entryUuid = `entry-${productId}-${Date.now().toString(36)}`;
        const moveUuid = `move-${productId}-${Date.now().toString(36)}`;

        await dbService.execute(
          `INSERT INTO stock_entries (uuid, stock_item_id, entry_number, quantity, multiplier, total_quantity, total_price, unit_price, status, supplier, notes, created_by)
           VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, 'posted', 'Initial Setup', 'Initial product inventory', ?)`,
          [entryUuid, stockItemId, entryNum, initialStock, initialStock, initialVal, costPrice, userId]
        );

        await dbService.execute(
          `INSERT INTO stock_movements (uuid, stock_item_id, movement_type, reference_type, reference_id, quantity, unit_price, total_value, balance_quantity, balance_value, notes, created_by)
           VALUES (?, ?, 'in', 'INITIAL_STOCK', ?, ?, ?, ?, ?, ?, 'Initial inventory stock addition', ?)`,
          [moveUuid, stockItemId, entryNum, initialStock, costPrice, initialVal, initialStock, initialVal, userId]
        );
      }

      // 2. Legacy stock record
      await dbService.execute(
        `INSERT INTO stock (product_id, current_stock, reserved_stock, min_stock_alert)
         VALUES (?, ?, 0, ?)`,
        [productId, initialStock, data.lowStockThreshold || 10]
      );

      if (initialStock > 0) {
        await dbService.execute(
          `INSERT INTO stock_transactions (
            product_id, transaction_type, quantity, previous_stock, new_stock, reference_id, reference_type, notes, created_by
          ) VALUES (?, 'STOCK_IN', ?, 0, ?, 'INITIAL-CREATION', 'INITIAL_STOCK', 'Initial product inventory', ?)`,
          [productId, initialStock, initialStock, userId]
        );
      }

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
    costPrice?: number;
    sellingPrice?: number;
    taxRate?: number;
    lowStockThreshold?: number;
    isAvailable?: boolean;
    status?: string;
  }, userId: number) {
    const current = await this.getById(id);

    if (data.sku && data.sku !== current.sku) {
      const existingSku = await dbService.queryOne('SELECT id FROM products WHERE sku = ? AND id != ?', [data.sku, id]);
      if (existingSku) {
        throw AppError.conflict('Product SKU already in use by another product');
      }
    }

    await dbService.execute(
      `UPDATE products
       SET category_id = COALESCE(?, category_id),
           name = COALESCE(?, name),
           sku = COALESCE(?, sku),
           description = COALESCE(?, description),
           image_url = COALESCE(?, image_url),
           cost_price = COALESCE(?, cost_price),
           selling_price = COALESCE(?, selling_price),
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
        data.costPrice,
        data.sellingPrice,
        data.taxRate,
        data.lowStockThreshold,
        data.isAvailable !== undefined ? (data.isAvailable ? 1 : 0) : null,
        data.status,
        id,
      ]
    );

    if (data.lowStockThreshold !== undefined) {
      await dbService.execute('UPDATE stock SET min_stock_alert = ? WHERE product_id = ?', [data.lowStockThreshold, id]);
      await dbService.execute('UPDATE stock_items SET min_stock_alert = ? WHERE product_id = ?', [data.lowStockThreshold, id]);
    }

    if (data.name) {
      await dbService.execute('UPDATE stock_items SET name = ? WHERE product_id = ?', [data.name, id]);
    }

    if (data.status) {
      const stockStatus = data.status.toLowerCase() === 'active' ? 'active' : 'inactive';
      await dbService.execute('UPDATE stock_items SET status = ? WHERE product_id = ?', [stockStatus, id]);
    }

    await AuditService.log({
      userId,
      action: 'PRODUCT_UPDATED',
      module: 'PRODUCTS',
      recordId: id,
      oldValues: current,
      newValues: data,
    });

    return await this.getById(id);
  }

  static async delete(id: number, userId: number) {
    const current = await this.getById(id);

    // Check if product is part of previous bills
    const billItemsCount = await dbService.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM bill_items WHERE product_id = ?',
      [id]
    );

    if (billItemsCount && billItemsCount.count > 0) {
      // Soft-delete by setting status to INACTIVE so audit and historical sales remain valid
      await dbService.execute("UPDATE products SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      await dbService.execute("UPDATE stock_items SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE product_id = ?", [id]);
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

    await dbService.transaction(async () => {
      const stkItem = await dbService.queryOne<{ id: number }>('SELECT id FROM stock_items WHERE product_id = ?', [id]);
      if (stkItem) {
        await dbService.execute('DELETE FROM stock_movements WHERE stock_item_id = ?', [stkItem.id]);
        await dbService.execute('DELETE FROM stock_entries WHERE stock_item_id = ?', [stkItem.id]);
        await dbService.execute('DELETE FROM stock_items WHERE id = ?', [stkItem.id]);
      }
      await dbService.execute('DELETE FROM stock_transactions WHERE product_id = ?', [id]);
      await dbService.execute('DELETE FROM stock WHERE product_id = ?', [id]);
      await dbService.execute('DELETE FROM products WHERE id = ?', [id]);
    });

    await AuditService.log({
      userId,
      action: 'PRODUCT_DELETED',
      module: 'PRODUCTS',
      recordId: id,
      oldValues: current,
    });

    return { success: true, message: 'Product deleted permanently' };
  }
}
