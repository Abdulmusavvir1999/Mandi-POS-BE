import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { logger } from '../config/logger';

export interface CreateAddonInput {
  name: string;
  category?: string;
  price: number;
  cost_price?: number;
  image_url?: string | null;
  is_available?: boolean;
  stock_id?: number | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface CreateComboDealInput {
  combo_code?: string;
  name: string;
  description?: string;
  image_url?: string;
  category_id?: number | null;
  original_price?: number;
  combo_price: number;
  savings_amount?: number;
  is_available?: boolean;
  status?: 'ACTIVE' | 'INACTIVE';
  items: Array<{
    product_id: number;
    variant_id?: number | null;
    quantity: number;
  }>;
}

export class AddonsCombosService {
  private static schemaEnsured = false;

  public static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      // 0. Combo Meals became Combo Deals. A till that already holds the old
      // tables is renamed into the new names before anything below runs —
      // otherwise the CREATE TABLE IF NOT EXISTS calls in step 3 would build
      // a second, empty pair beside the operator's real combos and the
      // catalogue would look wiped. Renaming carries the rows, the ids and
      // the foreign keys across untouched.
      for (const [from, to] of [
        ['combo_meal_items', 'combo_deal_items'],
        ['combo_meals', 'combo_deals'],
      ]) {
        const legacy = await dbService.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count
             FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
          [from]
        );
        const current = await dbService.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count
             FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
          [to]
        );
        // Only when the old name is there and the new one is not: if both
        // exist the rename already happened and something else made the
        // spare, which is not this method's to resolve.
        if (legacy && Number(legacy.count) > 0 && (!current || Number(current.count) === 0)) {
          await dbService.execute(`RENAME TABLE \`${from}\` TO \`${to}\``);
          logger.info(`Renamed ${from} to ${to}.`);
        }
      }

      // 1. Create product_addons
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS product_addons (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL DEFAULT 'Sides',
          price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          image_url VARCHAR(255) NULL,
          is_available BOOLEAN DEFAULT TRUE,
          stock_id INT NULL,
          status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_addon_name (name),
          INDEX idx_addon_category (category),
          INDEX idx_addon_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 2. Create product_addon_mappings
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS product_addon_mappings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          addon_id INT NOT NULL,
          product_id INT NULL,
          category_id INT NULL,
          is_global BOOLEAN DEFAULT FALSE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_pam_addon (addon_id),
          INDEX idx_pam_product (product_id),
          INDEX idx_pam_category (category_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 3. Create combo_deals
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS combo_deals (
          id INT AUTO_INCREMENT PRIMARY KEY,
          combo_code VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(150) NOT NULL,
          description TEXT NULL,
          image_url VARCHAR(255) NULL,
          category_id INT NULL,
          original_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          combo_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          savings_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          is_available BOOLEAN DEFAULT TRUE,
          status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_combo_deal_code (combo_code),
          INDEX idx_combo_deal_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 4. Create combo_deal_items
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS combo_deal_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          combo_id INT NOT NULL,
          product_id INT NOT NULL,
          variant_id INT NULL,
          quantity INT NOT NULL DEFAULT 1,
          display_order INT DEFAULT 0,
          INDEX idx_cdi_combo (combo_id),
          INDEX idx_cdi_product (product_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 5. product_addons predates add-on photos, so a till that already has
      // the table gets the column added rather than recreated. combo_deals was
      // declared with image_url from the start and needs none.
      const addonImageCol = await dbService.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'product_addons'
            AND COLUMN_NAME = 'image_url'`
      );
      if (!addonImageCol || Number(addonImageCol.count) === 0) {
        await dbService.execute(
          'ALTER TABLE product_addons ADD COLUMN image_url VARCHAR(255) NULL AFTER cost_price'
        );
      }

      this.schemaEnsured = true;
      logger.info('Add-ons and Combo Deals schema verified successfully.');
    } catch (err) {
      logger.error('Failed to ensure Add-ons and Combo Deals schema:', err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ADD-ONS METHODS
  // ═════════════════════════════════════════════════════════════════════════════

  public static async getAddons(category?: string, status?: string) {
    await this.ensureSchema();
    let sql = 'SELECT * FROM product_addons WHERE 1=1';
    const params: any[] = [];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY category ASC, name ASC';
    return await dbService.query(sql, params);
  }

  public static async getAddonById(id: number) {
    await this.ensureSchema();
    const addon = await dbService.queryOne('SELECT * FROM product_addons WHERE id = ?', [id]);
    if (!addon) throw AppError.notFound('Add-on not found');
    return addon;
  }

  public static async createAddon(input: CreateAddonInput, userId: number) {
    await this.ensureSchema();
    // The add-on and the mapping that makes it global are one unit: without
    // the mapping the add-on exists but appears on no dish.
    return await dbService.transaction(async () => {
      const res = await dbService.execute(
        `INSERT INTO product_addons (name, category, price, cost_price, image_url, is_available, stock_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.name.trim(),
          input.category || 'Sides',
          Number(input.price) || 0,
          Number(input.cost_price) || 0,
          input.image_url || null,
          input.is_available !== false ? 1 : 0,
          input.stock_id || null,
          input.status || 'ACTIVE',
        ]
      );

      const created = await this.getAddonById(res.lastInsertRowid);
      // Make global by default
      await dbService.execute(
        'INSERT IGNORE INTO product_addon_mappings (addon_id, is_global) VALUES (?, 1)',
        [created.id]
      );

      await AuditService.log({
        userId,
        action: 'ADDON_CREATED',
        module: 'PRODUCTS',
        recordId: String(created.id),
        newValues: created,
      });

      return created;
    });
  }

  public static async updateAddon(id: number, input: Partial<CreateAddonInput>, userId: number) {
    await this.ensureSchema();
    const existing = await this.getAddonById(id);

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const category = input.category !== undefined ? input.category : existing.category;
    const price = input.price !== undefined ? Number(input.price) : existing.price;
    const cost_price = input.cost_price !== undefined ? Number(input.cost_price) : existing.cost_price;
    // An empty string is the form clearing the photo, which is not the same as
    // the field being absent from the payload.
    const image_url = input.image_url !== undefined ? input.image_url || null : existing.image_url;
    const is_available = input.is_available !== undefined ? (input.is_available ? 1 : 0) : existing.is_available;
    const stock_id = input.stock_id !== undefined ? input.stock_id : existing.stock_id;
    const status = input.status !== undefined ? input.status : existing.status;

    await dbService.execute(
      `UPDATE product_addons 
       SET name = ?, category = ?, price = ?, cost_price = ?, image_url = ?, is_available = ?, stock_id = ?, status = ?
       WHERE id = ?`,
      [name, category, price, cost_price, image_url, is_available, stock_id, status, id]
    );

    const updated = await this.getAddonById(id);
    await AuditService.log({
      userId,
      action: 'ADDON_UPDATED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  public static async deleteAddon(id: number, userId: number) {
    await this.ensureSchema();
    const existing = await this.getAddonById(id);
    await dbService.execute('DELETE FROM product_addons WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'ADDON_DELETED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
    });

    return { message: 'Add-on deleted successfully' };
  }

  public static async getProductAddons(productId: number) {
    await this.ensureSchema();
    // Fetch add-ons mapped directly to this product OR globally mapped
    const addons = await dbService.query(`
      SELECT DISTINCT a.*
      FROM product_addons a
      JOIN product_addon_mappings pam ON a.id = pam.addon_id
      WHERE (pam.product_id = ? OR pam.is_global = 1)
        AND a.status = 'ACTIVE'
        AND a.is_available = 1
      ORDER BY a.category ASC, a.price ASC
    `, [productId]);

    return addons;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // COMBO DEALS METHODS
  // ═════════════════════════════════════════════════════════════════════════════

  public static async getComboDeals(status?: string) {
    await this.ensureSchema();
    let sql = 'SELECT * FROM combo_deals WHERE 1=1';
    const params: any[] = [];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id DESC';

    const combos = await dbService.query(sql, params);
    for (const combo of combos) {
      combo.items = await dbService.query(`
        SELECT cdi.*, p.name as product_name, p.image_url as product_image, COALESCE(pv.selling_price, (SELECT MIN(pv2.selling_price) FROM product_variants pv2 WHERE pv2.product_id = p.id), 0) as product_price,
               pv.name as variant_name, pv.selling_price as variant_price
        FROM combo_deal_items cdi
        JOIN products p ON cdi.product_id = p.id
        LEFT JOIN product_variants pv ON cdi.variant_id = pv.id
        WHERE cdi.combo_id = ?
        ORDER BY cdi.display_order ASC
      `, [combo.id]);
    }

    return combos;
  }

  public static async getComboDealById(id: number) {
    await this.ensureSchema();
    const combo = await dbService.queryOne('SELECT * FROM combo_deals WHERE id = ?', [id]);
    if (!combo) throw AppError.notFound('Combo deal not found');

    combo.items = await dbService.query(`
      SELECT cdi.*, p.name as product_name, p.image_url as product_image, COALESCE(pv.selling_price, (SELECT MIN(pv2.selling_price) FROM product_variants pv2 WHERE pv2.product_id = p.id), 0) as product_price,
             pv.name as variant_name, pv.selling_price as variant_price
      FROM combo_deal_items cdi
      JOIN products p ON cdi.product_id = p.id
      LEFT JOIN product_variants pv ON cdi.variant_id = pv.id
      WHERE cdi.combo_id = ?
      ORDER BY cdi.display_order ASC
    `, [id]);

    return combo;
  }

  public static async createComboDeal(input: CreateComboDealInput, userId: number) {
    await this.ensureSchema();
    const code = input.combo_code || `CMB-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const originalPrice = Number(input.original_price) || Number(input.combo_price);
    const comboPrice = Number(input.combo_price) || 0;
    const savings = Math.max(0, originalPrice - comboPrice);

    // Header and its lines are one deal: a failure between them left a combo
    // on the menu with no items, or only the first few.
    return await dbService.transaction(async () => {
      const res = await dbService.execute(
        `INSERT INTO combo_deals (combo_code, name, description, image_url, category_id, original_price, combo_price, savings_amount, is_available, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          code,
          input.name.trim(),
          input.description || null,
          input.image_url || null,
          input.category_id || null,
          originalPrice,
          comboPrice,
          savings,
          input.is_available !== false ? 1 : 0,
          input.status || 'ACTIVE',
        ]
      );

      const comboId = res.lastInsertRowid;

      if (input.items && input.items.length > 0) {
        for (let i = 0; i < input.items.length; i++) {
          const item = input.items[i];
          await dbService.execute(
            `INSERT INTO combo_deal_items (combo_id, product_id, variant_id, quantity, display_order)
             VALUES (?, ?, ?, ?, ?)`,
            [comboId, item.product_id, item.variant_id || null, item.quantity || 1, i + 1]
          );
        }
      }

      const created = await this.getComboDealById(comboId);
      await AuditService.log({
        userId,
        action: 'COMBO_CREATED',
        module: 'PRODUCTS',
        recordId: String(comboId),
        newValues: created,
      });

      return created;
    });
  }

  public static async updateComboDeal(id: number, input: Partial<CreateComboDealInput>, userId: number) {
    await this.ensureSchema();
    const existing = await this.getComboDealById(id);

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const desc = input.description !== undefined ? input.description : existing.description;
    const img = input.image_url !== undefined ? input.image_url : existing.image_url;
    const originalPrice = input.original_price !== undefined ? Number(input.original_price) : existing.original_price;
    const comboPrice = input.combo_price !== undefined ? Number(input.combo_price) : existing.combo_price;
    const savings = Math.max(0, originalPrice - comboPrice);
    const isAvail = input.is_available !== undefined ? (input.is_available ? 1 : 0) : existing.is_available;
    const status = input.status !== undefined ? input.status : existing.status;

    // The item list is replaced by clearing it first, so an failure between
    // the DELETE and the re-INSERT emptied the combo outright. Grouped so it
    // either swaps to the new list or keeps the old one.
    return await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE combo_deals
         SET name = ?, description = ?, image_url = ?, original_price = ?, combo_price = ?, savings_amount = ?, is_available = ?, status = ?
         WHERE id = ?`,
        [name, desc, img, originalPrice, comboPrice, savings, isAvail, status, id]
      );

      if (input.items !== undefined) {
        await dbService.execute('DELETE FROM combo_deal_items WHERE combo_id = ?', [id]);
        for (let i = 0; i < input.items.length; i++) {
          const item = input.items[i];
          await dbService.execute(
            `INSERT INTO combo_deal_items (combo_id, product_id, variant_id, quantity, display_order)
             VALUES (?, ?, ?, ?, ?)`,
            [id, item.product_id, item.variant_id || null, item.quantity || 1, i + 1]
          );
        }
      }

      const updated = await this.getComboDealById(id);
      await AuditService.log({
        userId,
        action: 'COMBO_UPDATED',
        module: 'PRODUCTS',
        recordId: String(id),
        oldValues: existing,
        newValues: updated,
      });

      return updated;
    });
  }

  public static async deleteComboDeal(id: number, userId: number) {
    await this.ensureSchema();
    const existing = await this.getComboDealById(id);
    await dbService.execute('DELETE FROM combo_deals WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'COMBO_DELETED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
    });

    return { message: 'Combo deal deleted successfully' };
  }

}
