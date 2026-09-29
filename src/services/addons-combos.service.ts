import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { logger } from '../config/logger';
import { SchemaUtil } from '../utils/schema.util';

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
  /** The add-ons the deal bundles, each with how many of it one combo serves. */
  items: Array<{
    addon_id: number;
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
          product_id INT NOT NULL,
          is_free ENUM('Free', 'Amount') NOT NULL DEFAULT 'Amount',
          amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          free_limit INT NULL DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_pam_addon (addon_id),
          INDEX idx_pam_product (product_id)
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
          addon_id INT NOT NULL,
          quantity INT NOT NULL DEFAULT 1,
          display_order INT DEFAULT 0,
          INDEX idx_cdi_combo (combo_id),
          INDEX idx_cdi_addon (addon_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // A combo is made of add-ons, not dishes. On a database that still has
      // the dish-based shape, the dish rows go (they cannot be translated into
      // add-ons) and the table moves to addon_id.
      if (await SchemaUtil.columnExists('combo_deal_items', 'product_id')) {
        await dbService.execute('DELETE FROM combo_deal_items');
        await SchemaUtil.dropColumn('combo_deal_items', 'variant_id');
        await SchemaUtil.dropColumn('combo_deal_items', 'product_id');
        logger.info('combo_deal_items moved from dishes to add-ons; the old dish rows were removed.');
      }
      await SchemaUtil.addColumn('combo_deal_items', 'addon_id', 'INT NOT NULL AFTER combo_id');
      await SchemaUtil.addForeignKey('combo_deal_items', 'combo_id', 'combo_deals', 'fk_cdi_combo', 'CASCADE');
      await SchemaUtil.addForeignKey('combo_deal_items', 'addon_id', 'product_addons', 'fk_cdi_addon', 'CASCADE');

      // 5. product_addons image_url column migration
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

      // 6. Ensure product_addon_mappings has category_id and is_global dropped, and is_free/amount/free_limit added
      const pamCols = await dbService.query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'product_addon_mappings'`
      );
      const colNames = (pamCols || []).map((c: any) => c.COLUMN_NAME?.toLowerCase());
      if (colNames.includes('category_id')) {
        try {
          const fkRow = await dbService.queryOne<{ CONSTRAINT_NAME: string }>(
            `SELECT CONSTRAINT_NAME
               FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'product_addon_mappings'
                AND COLUMN_NAME = 'category_id'
                AND REFERENCED_TABLE_NAME IS NOT NULL
              LIMIT 1`
          );
          if (fkRow && fkRow.CONSTRAINT_NAME) {
            await dbService.execute(`ALTER TABLE product_addon_mappings DROP FOREIGN KEY \`${fkRow.CONSTRAINT_NAME}\``);
          }
          await dbService.execute('ALTER TABLE product_addon_mappings DROP COLUMN category_id');
        } catch (e) {
          logger.warn('Could not drop category_id from product_addon_mappings:', e);
        }
      }
      if (colNames.includes('is_global')) {
        try {
          await dbService.execute('ALTER TABLE product_addon_mappings DROP COLUMN is_global');
        } catch (e) {
          logger.warn('Could not drop is_global from product_addon_mappings:', e);
        }
      }
      if (!colNames.includes('is_free')) {
        try {
          await dbService.execute("ALTER TABLE product_addon_mappings ADD COLUMN is_free ENUM('Free', 'Amount') NOT NULL DEFAULT 'Amount' AFTER product_id");
        } catch (e) {
          logger.warn('Could not add is_free to product_addon_mappings:', e);
        }
      }
      if (!colNames.includes('amount')) {
        try {
          await dbService.execute('ALTER TABLE product_addon_mappings ADD COLUMN amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER is_free');
        } catch (e) {
          logger.warn('Could not add amount to product_addon_mappings:', e);
        }
      }
      if (!colNames.includes('free_limit')) {
        try {
          await dbService.execute('ALTER TABLE product_addon_mappings ADD COLUMN free_limit INT NULL DEFAULT NULL AFTER amount');
        } catch (e) {
          logger.warn('Could not add free_limit to product_addon_mappings:', e);
        }
      } else {
        try {
          await dbService.execute('ALTER TABLE product_addon_mappings MODIFY COLUMN free_limit INT NULL DEFAULT NULL');
        } catch (e) {
          logger.warn('Could not modify free_limit to NULL in product_addon_mappings:', e);
        }
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
    const addons = await dbService.query(`
      SELECT 
        pam.id AS mapping_id,
        pam.product_id,
        pam.addon_id,
        pam.is_free,
        pam.amount,
        pam.free_limit,
        pam.free_limit AS free_quantity,
        a.id,
        a.name,
        a.category,
        a.price AS default_price,
        IF(pam.is_free = 'Free', 0.00, COALESCE(pam.amount, a.price)) AS price,
        a.cost_price,
        a.image_url,
        a.is_available,
        a.stock_id,
        a.status,
        a.created_at,
        a.updated_at
      FROM product_addon_mappings pam
      JOIN product_addons a ON pam.addon_id = a.id
      WHERE pam.product_id = ?
        AND a.status = 'ACTIVE'
        AND a.is_available = 1
      ORDER BY a.category ASC, a.name ASC
    `, [productId]);

    return addons;
  }

  public static async setProductAddons(productId: number, mappings: any[], userId: number) {
    await this.ensureSchema();
    return await dbService.transaction(async () => {
      // Clear existing mappings for this product
      await dbService.execute('DELETE FROM product_addon_mappings WHERE product_id = ?', [productId]);

      // Insert new direct product mappings
      if (Array.isArray(mappings) && mappings.length > 0) {
        for (const item of mappings) {
          const addonId = typeof item === 'object' ? Number(item.addon_id ?? item.addonId ?? item.id) : Number(item);
          if (!addonId) continue;

          let isFree: 'Free' | 'Amount' = 'Amount';
          if (typeof item === 'object' && item.is_free) {
            isFree = String(item.is_free).toLowerCase() === 'free' ? 'Free' : 'Amount';
          }

          let amount = 0;
          if (isFree === 'Amount') {
            if (typeof item === 'object' && item.amount !== undefined && item.amount !== null && item.amount !== '') {
              amount = Number(item.amount) || 0;
            } else if (typeof item === 'object' && item.price !== undefined && item.price !== null && item.price !== '') {
              amount = Number(item.price) || 0;
            } else {
              const addon = await dbService.queryOne<any>('SELECT price FROM product_addons WHERE id = ?', [addonId]);
              amount = addon ? Number(addon.price) || 0 : 0;
            }
          }

          let freeLimit: number | null = null;
          if (isFree === 'Free') {
            const rawLimit = typeof item === 'object' ? (item.free_limit ?? item.free_quantity ?? item.freeLimit) : undefined;
            if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '' && rawLimit !== 'Unlimited') {
              const parsed = Number(rawLimit);
              freeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
            } else {
              freeLimit = null; // Unlimited free
            }
          }

          await dbService.execute(
            `INSERT INTO product_addon_mappings (addon_id, product_id, is_free, amount, free_limit)
             VALUES (?, ?, ?, ?, ?)`,
            [addonId, productId, isFree, amount, freeLimit]
          );
        }
      }

      await AuditService.log({
        userId,
        action: 'PRODUCT_ADDONS_UPDATED',
        module: 'PRODUCTS',
        recordId: String(productId),
        newValues: { mappings },
      });

      return await this.getProductAddons(productId);
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // COMBO DEALS METHODS
  // ═════════════════════════════════════════════════════════════════════════════

  /** Every combo line must name a live add-on and a whole quantity of at least 1. */
  private static async assertComboAddons(items: CreateComboDealInput['items'] | undefined): Promise<void> {
    for (const item of items || []) {
      const addonId = Number(item?.addon_id);
      const qty = Number(item?.quantity ?? 1);
      if (!Number.isInteger(addonId) || addonId <= 0) {
        throw AppError.badRequest('Each combo item must pick an add-on.');
      }
      if (!Number.isInteger(qty) || qty < 1) {
        throw AppError.badRequest('Each combo item needs a quantity of at least 1.');
      }
      const addon = await dbService.queryOne<{ id: number }>(
        'SELECT id FROM product_addons WHERE id = ? AND is_deleted = 0',
        [addonId]
      );
      if (!addon) {
        throw AppError.badRequest(`Add-on ${addonId} does not exist or has been deleted.`);
      }
    }
  }

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
        SELECT cdi.*, a.name as addon_name, a.image_url as addon_image, a.price as addon_price, a.stock_id as addon_stock_id
        FROM combo_deal_items cdi
        JOIN product_addons a ON cdi.addon_id = a.id
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
      SELECT cdi.*, a.name as addon_name, a.image_url as addon_image, a.price as addon_price, a.stock_id as addon_stock_id
      FROM combo_deal_items cdi
      JOIN product_addons a ON cdi.addon_id = a.id
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

    await this.assertComboAddons(input.items);

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
            `INSERT INTO combo_deal_items (combo_id, addon_id, quantity, display_order)
             VALUES (?, ?, ?, ?)`,
            [comboId, item.addon_id, item.quantity || 1, i + 1]
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

    if (input.items !== undefined) await this.assertComboAddons(input.items);

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
            `INSERT INTO combo_deal_items (combo_id, addon_id, quantity, display_order)
             VALUES (?, ?, ?, ?)`,
            [id, item.addon_id, item.quantity || 1, i + 1]
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
