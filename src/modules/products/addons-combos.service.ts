import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../config/logger';

export interface CreateAddonInput {
  name: string;
  category?: string;
  price: number;
  cost_price?: number;
  is_available?: boolean;
  stock_item_id?: number | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface CreateComboInput {
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

export interface CreateDealInput {
  deal_code?: string;
  title: string;
  badge_text?: string;
  description?: string;
  image_url?: string;
  original_price?: number;
  deal_price: number;
  savings_amount?: number;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  days_of_week?: string;
  is_active?: boolean;
  items: Array<{
    product_id: number;
    variant_id?: number | null;
    quantity: number;
    notes?: string;
  }>;
}

export class AddonsCombosService {
  private static schemaEnsured = false;

  public static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      // 1. Create product_addons
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS product_addons (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL DEFAULT 'Sides',
          price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          is_available BOOLEAN DEFAULT TRUE,
          stock_item_id INT NULL,
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

      // 3. Create combo_meals
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS combo_meals (
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
          INDEX idx_combo_code (combo_code),
          INDEX idx_combo_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 4. Create combo_meal_items
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS combo_meal_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          combo_id INT NOT NULL,
          product_id INT NOT NULL,
          variant_id INT NULL,
          quantity INT NOT NULL DEFAULT 1,
          display_order INT DEFAULT 0,
          INDEX idx_cmi_combo (combo_id),
          INDEX idx_cmi_product (product_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 5. Create meal_deals
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS meal_deals (
          id INT AUTO_INCREMENT PRIMARY KEY,
          deal_code VARCHAR(50) UNIQUE NOT NULL,
          title VARCHAR(150) NOT NULL,
          badge_text VARCHAR(50) DEFAULT 'VALUE DEAL',
          description TEXT NULL,
          image_url VARCHAR(255) NULL,
          original_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          deal_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          savings_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          start_date DATE NULL,
          end_date DATE NULL,
          start_time VARCHAR(10) NULL,
          end_time VARCHAR(10) NULL,
          days_of_week VARCHAR(100) DEFAULT 'ALL',
          is_active BOOLEAN DEFAULT TRUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_deal_code (deal_code),
          INDEX idx_deal_active (is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 6. Create meal_deal_items
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS meal_deal_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          deal_id INT NOT NULL,
          product_id INT NOT NULL,
          variant_id INT NULL,
          quantity INT NOT NULL DEFAULT 1,
          notes VARCHAR(255) NULL,
          INDEX idx_mdi_deal (deal_id),
          INDEX idx_mdi_product (product_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 7. Seed baseline add-ons if empty
      const addonCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM product_addons');
      if (!addonCount || addonCount.count === 0) {
        await dbService.execute(`
          INSERT IGNORE INTO product_addons (id, name, category, price, cost_price, is_available, status) VALUES
          (1, 'Extra Spicy Daqoos Sauce', 'Sauces', 3.00, 1.00, 1, 'ACTIVE'),
          (2, 'Creamy Garlic Tahini Dip', 'Sauces', 4.00, 1.50, 1, 'ACTIVE'),
          (3, 'Crispy Fried Caramelized Onions', 'Toppings', 4.00, 1.20, 1, 'ACTIVE'),
          (4, 'Golden Roasted Almonds & Raisins', 'Toppings', 8.00, 3.50, 1, 'ACTIVE'),
          (5, 'Extra Traditional Shurba (Soup Bowl)', 'Sides', 6.00, 2.00, 1, 'ACTIVE'),
          (6, 'Extra Fragrant Mandi Rice Portion', 'Sides', 15.00, 5.00, 1, 'ACTIVE'),
          (7, 'Melted Cheddar Cheese Drizzle', 'Toppings', 5.00, 2.00, 1, 'ACTIVE'),
          (8, 'Chilled Ayran Laban Bottle (330ml)', 'Beverages', 6.00, 2.50, 1, 'ACTIVE');
        `);

        await dbService.execute(`
          INSERT IGNORE INTO product_addon_mappings (id, addon_id, is_global) VALUES
          (1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 4, 1), (5, 5, 1), (6, 6, 1), (7, 7, 1), (8, 8, 1);
        `);
      }

      // 8. Seed baseline combos if empty
      const comboCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM combo_meals');
      if (!comboCount || comboCount.count === 0) {
        await dbService.execute(`
          INSERT IGNORE INTO combo_meals (id, combo_code, name, description, original_price, combo_price, savings_amount, is_available, status) VALUES
          (1, 'CMB-ROYAL-DUO', 'Royal Mandi Duo Combo', '1 Half Mutton Mandi + 1 Half Chicken Mandi + 2 Daqoos + 2 Ayran Laban Bottles', 134.00, 115.00, 19.00, 1, 'ACTIVE'),
          (2, 'CMB-CHARCOAL-SOLO', 'Single Charcoal Grill Meal', '1 Half Chicken Madhbi + Fresh Garden Salad + 1 Daqoos + Arabic Red Tea Pot', 58.00, 49.00, 9.00, 1, 'ACTIVE');
        `);

        // Connect combo items if products exist
        const p1 = await dbService.queryOne<{ id: number }>('SELECT id FROM products WHERE sku LIKE "%MM%" OR name LIKE "%Mutton%" LIMIT 1');
        const p2 = await dbService.queryOne<{ id: number }>('SELECT id FROM products WHERE sku LIKE "%CM%" OR name LIKE "%Chicken%" LIMIT 1');
        if (p1 && p2) {
          await dbService.execute(`
            INSERT IGNORE INTO combo_meal_items (combo_id, product_id, quantity, display_order) VALUES
            (1, ?, 1, 1),
            (1, ?, 1, 2);
          `, [p1.id, p2.id]);
        }
      }

      // 9. Seed baseline meal deals if empty
      const dealCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM meal_deals');
      if (!dealCount || dealCount.count === 0) {
        await dbService.execute(`
          INSERT IGNORE INTO meal_deals (id, deal_code, title, badge_text, description, original_price, deal_price, savings_amount, days_of_week, start_time, end_time, is_active) VALUES
          (1, 'DEAL-FAMILY-FEAST', 'Royal Family Weekend Feast', 'FAMILY PACK', '2 Full Royal Mutton Mandis + 4 Shurba Soups + 1 Kunafa Plate + 4 Ayran Labans', 380.00, 329.00, 51.00, 'FRI,SAT,SUN', '12:00', '23:30', 1),
          (2, 'DEAL-LUNCH-EXPRESS', 'Executive Lunch Express Deal', 'LUNCH SPECIAL', '1 Half Chicken Mandi + 1 Fresh Salad + 1 Daqoos + 1 Mint Lemonade Juice', 62.00, 45.00, 17.00, 'SUN,MON,TUE,WED,THU', '11:30', '16:30', 1);
        `);
      }

      this.schemaEnsured = true;
      logger.info('Add-ons, Combo Meals, and Meal Deals schema verified successfully.');
    } catch (err) {
      logger.error('Failed to ensure Add-ons and Combos schema:', err);
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
    const res = await dbService.execute(
      `INSERT INTO product_addons (name, category, price, cost_price, is_available, stock_item_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name.trim(),
        input.category || 'Sides',
        Number(input.price) || 0,
        Number(input.cost_price) || 0,
        input.is_available !== false ? 1 : 0,
        input.stock_item_id || null,
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
  }

  public static async updateAddon(id: number, input: Partial<CreateAddonInput>, userId: number) {
    await this.ensureSchema();
    const existing = await this.getAddonById(id);

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const category = input.category !== undefined ? input.category : existing.category;
    const price = input.price !== undefined ? Number(input.price) : existing.price;
    const cost_price = input.cost_price !== undefined ? Number(input.cost_price) : existing.cost_price;
    const is_available = input.is_available !== undefined ? (input.is_available ? 1 : 0) : existing.is_available;
    const stock_item_id = input.stock_item_id !== undefined ? input.stock_item_id : existing.stock_item_id;
    const status = input.status !== undefined ? input.status : existing.status;

    await dbService.execute(
      `UPDATE product_addons 
       SET name = ?, category = ?, price = ?, cost_price = ?, is_available = ?, stock_item_id = ?, status = ?
       WHERE id = ?`,
      [name, category, price, cost_price, is_available, stock_item_id, status, id]
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
  // COMBO MEALS METHODS
  // ═════════════════════════════════════════════════════════════════════════════

  public static async getCombos(status?: string) {
    await this.ensureSchema();
    let sql = 'SELECT * FROM combo_meals WHERE 1=1';
    const params: any[] = [];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id DESC';

    const combos = await dbService.query(sql, params);
    for (const combo of combos) {
      combo.items = await dbService.query(`
        SELECT cmi.*, p.name as product_name, p.image_url as product_image, p.selling_price as product_price,
               pv.name as variant_name, pv.selling_price as variant_price
        FROM combo_meal_items cmi
        JOIN products p ON cmi.product_id = p.id
        LEFT JOIN product_variants pv ON cmi.variant_id = pv.id
        WHERE cmi.combo_id = ?
        ORDER BY cmi.display_order ASC
      `, [combo.id]);
    }

    return combos;
  }

  public static async getComboById(id: number) {
    await this.ensureSchema();
    const combo = await dbService.queryOne('SELECT * FROM combo_meals WHERE id = ?', [id]);
    if (!combo) throw AppError.notFound('Combo meal not found');

    combo.items = await dbService.query(`
      SELECT cmi.*, p.name as product_name, p.image_url as product_image, p.selling_price as product_price,
             pv.name as variant_name, pv.selling_price as variant_price
      FROM combo_meal_items cmi
      JOIN products p ON cmi.product_id = p.id
      LEFT JOIN product_variants pv ON cmi.variant_id = pv.id
      WHERE cmi.combo_id = ?
      ORDER BY cmi.display_order ASC
    `, [id]);

    return combo;
  }

  public static async createCombo(input: CreateComboInput, userId: number) {
    await this.ensureSchema();
    const code = input.combo_code || `CMB-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const originalPrice = Number(input.original_price) || Number(input.combo_price);
    const comboPrice = Number(input.combo_price) || 0;
    const savings = Math.max(0, originalPrice - comboPrice);

    const res = await dbService.execute(
      `INSERT INTO combo_meals (combo_code, name, description, image_url, category_id, original_price, combo_price, savings_amount, is_available, status)
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
          `INSERT INTO combo_meal_items (combo_id, product_id, variant_id, quantity, display_order)
           VALUES (?, ?, ?, ?, ?)`,
          [comboId, item.product_id, item.variant_id || null, item.quantity || 1, i + 1]
        );
      }
    }

    const created = await this.getComboById(comboId);
    await AuditService.log({
      userId,
      action: 'COMBO_CREATED',
      module: 'PRODUCTS',
      recordId: String(comboId),
      newValues: created,
    });

    return created;
  }

  public static async updateCombo(id: number, input: Partial<CreateComboInput>, userId: number) {
    await this.ensureSchema();
    const existing = await this.getComboById(id);

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const desc = input.description !== undefined ? input.description : existing.description;
    const img = input.image_url !== undefined ? input.image_url : existing.image_url;
    const originalPrice = input.original_price !== undefined ? Number(input.original_price) : existing.original_price;
    const comboPrice = input.combo_price !== undefined ? Number(input.combo_price) : existing.combo_price;
    const savings = Math.max(0, originalPrice - comboPrice);
    const isAvail = input.is_available !== undefined ? (input.is_available ? 1 : 0) : existing.is_available;
    const status = input.status !== undefined ? input.status : existing.status;

    await dbService.execute(
      `UPDATE combo_meals
       SET name = ?, description = ?, image_url = ?, original_price = ?, combo_price = ?, savings_amount = ?, is_available = ?, status = ?
       WHERE id = ?`,
      [name, desc, img, originalPrice, comboPrice, savings, isAvail, status, id]
    );

    if (input.items !== undefined) {
      await dbService.execute('DELETE FROM combo_meal_items WHERE combo_id = ?', [id]);
      for (let i = 0; i < input.items.length; i++) {
        const item = input.items[i];
        await dbService.execute(
          `INSERT INTO combo_meal_items (combo_id, product_id, variant_id, quantity, display_order)
           VALUES (?, ?, ?, ?, ?)`,
          [id, item.product_id, item.variant_id || null, item.quantity || 1, i + 1]
        );
      }
    }

    const updated = await this.getComboById(id);
    await AuditService.log({
      userId,
      action: 'COMBO_UPDATED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  public static async deleteCombo(id: number, userId: number) {
    await this.ensureSchema();
    const existing = await this.getComboById(id);
    await dbService.execute('DELETE FROM combo_meals WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'COMBO_DELETED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
    });

    return { message: 'Combo meal deleted successfully' };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // MEAL DEALS METHODS
  // ═════════════════════════════════════════════════════════════════════════════

  public static async getDeals(activeOnly = false) {
    await this.ensureSchema();
    let sql = 'SELECT * FROM meal_deals WHERE 1=1';
    if (activeOnly) {
      sql += ' AND is_active = 1';
    }
    sql += ' ORDER BY id DESC';

    const deals = await dbService.query(sql);
    for (const deal of deals) {
      deal.items = await dbService.query(`
        SELECT mdi.*, p.name as product_name, p.image_url as product_image, p.selling_price as product_price,
               pv.name as variant_name
        FROM meal_deal_items mdi
        JOIN products p ON mdi.product_id = p.id
        LEFT JOIN product_variants pv ON mdi.variant_id = pv.id
        WHERE mdi.deal_id = ?
      `, [deal.id]);
    }

    return deals;
  }

  public static async getDealById(id: number) {
    await this.ensureSchema();
    const deal = await dbService.queryOne('SELECT * FROM meal_deals WHERE id = ?', [id]);
    if (!deal) throw AppError.notFound('Meal deal not found');

    deal.items = await dbService.query(`
      SELECT mdi.*, p.name as product_name, p.image_url as product_image, p.selling_price as product_price,
             pv.name as variant_name
      FROM meal_deal_items mdi
      JOIN products p ON mdi.product_id = p.id
      LEFT JOIN product_variants pv ON mdi.variant_id = pv.id
      WHERE mdi.deal_id = ?
    `, [id]);

    return deal;
  }

  public static async createDeal(input: CreateDealInput, userId: number) {
    await this.ensureSchema();
    const code = input.deal_code || `DEAL-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const originalPrice = Number(input.original_price) || Number(input.deal_price);
    const dealPrice = Number(input.deal_price) || 0;
    const savings = Math.max(0, originalPrice - dealPrice);

    const res = await dbService.execute(
      `INSERT INTO meal_deals (deal_code, title, badge_text, description, image_url, original_price, deal_price, savings_amount, start_date, end_date, start_time, end_time, days_of_week, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        input.title.trim(),
        input.badge_text || 'VALUE DEAL',
        input.description || null,
        input.image_url || null,
        originalPrice,
        dealPrice,
        savings,
        input.start_date || null,
        input.end_date || null,
        input.start_time || null,
        input.end_time || null,
        input.days_of_week || 'ALL',
        input.is_active !== false ? 1 : 0,
      ]
    );

    const dealId = res.lastInsertRowid;

    if (input.items && input.items.length > 0) {
      for (const item of input.items) {
        await dbService.execute(
          `INSERT INTO meal_deal_items (deal_id, product_id, variant_id, quantity, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [dealId, item.product_id, item.variant_id || null, item.quantity || 1, item.notes || null]
        );
      }
    }

    const created = await this.getDealById(dealId);
    await AuditService.log({
      userId,
      action: 'DEAL_CREATED',
      module: 'PRODUCTS',
      recordId: String(dealId),
      newValues: created,
    });

    return created;
  }

  public static async updateDeal(id: number, input: Partial<CreateDealInput>, userId: number) {
    await this.ensureSchema();
    const existing = await this.getDealById(id);

    const title = input.title !== undefined ? input.title.trim() : existing.title;
    const badge = input.badge_text !== undefined ? input.badge_text : existing.badge_text;
    const desc = input.description !== undefined ? input.description : existing.description;
    const img = input.image_url !== undefined ? input.image_url : existing.image_url;
    const originalPrice = input.original_price !== undefined ? Number(input.original_price) : existing.original_price;
    const dealPrice = input.deal_price !== undefined ? Number(input.deal_price) : existing.deal_price;
    const savings = Math.max(0, originalPrice - dealPrice);
    const startDate = input.start_date !== undefined ? input.start_date : existing.start_date;
    const endDate = input.end_date !== undefined ? input.end_date : existing.end_date;
    const startTime = input.start_time !== undefined ? input.start_time : existing.start_time;
    const endTime = input.end_time !== undefined ? input.end_time : existing.end_time;
    const daysOfWeek = input.days_of_week !== undefined ? input.days_of_week : existing.days_of_week;
    const isActive = input.is_active !== undefined ? (input.is_active ? 1 : 0) : existing.is_active;

    await dbService.execute(
      `UPDATE meal_deals
       SET title = ?, badge_text = ?, description = ?, image_url = ?, original_price = ?, deal_price = ?, savings_amount = ?,
           start_date = ?, end_date = ?, start_time = ?, end_time = ?, days_of_week = ?, is_active = ?
       WHERE id = ?`,
      [title, badge, desc, img, originalPrice, dealPrice, savings, startDate, endDate, startTime, endTime, daysOfWeek, isActive, id]
    );

    if (input.items !== undefined) {
      await dbService.execute('DELETE FROM meal_deal_items WHERE deal_id = ?', [id]);
      for (const item of input.items) {
        await dbService.execute(
          `INSERT INTO meal_deal_items (deal_id, product_id, variant_id, quantity, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [id, item.product_id, item.variant_id || null, item.quantity || 1, item.notes || null]
        );
      }
    }

    const updated = await this.getDealById(id);
    await AuditService.log({
      userId,
      action: 'DEAL_UPDATED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  public static async deleteDeal(id: number, userId: number) {
    await this.ensureSchema();
    const existing = await this.getDealById(id);
    await dbService.execute('DELETE FROM meal_deals WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'DEAL_DELETED',
      module: 'PRODUCTS',
      recordId: String(id),
      oldValues: existing,
    });

    return { message: 'Meal deal deleted successfully' };
  }
}
