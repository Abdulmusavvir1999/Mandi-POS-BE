import { v4 as uuidv4 } from 'uuid';
import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { logger } from '../config/logger';
import { ParamUtil } from '../utils/param.util';

export interface CreateVendorInput {
  vendor_code?: string;
  name: string;
  /** Primary category. Kept for existing callers and reports; mirrors categories[0]. */
  category?: string;
  /** Every kind of goods this vendor supplies. */
  categories?: string[];
  status?: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  image_url?: string;
  notes?: string;

  contact_person?: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  website?: string;

  tax_id?: string;
  pan_number?: string;

  preferred_payment_method?: string;
  bank_name?: string;
  account_number?: string;
  ifsc_code?: string;
  upi_id?: string;

  outstanding_balance?: number;
}

export interface RecordPurchaseInput {
  invoice_number: string;
  order_date: string;
  due_date?: string;
  total_amount: number;
  paid_amount?: number;
  items_summary?: string;
  notes?: string;
}

export interface RecordPaymentInput {
  purchase_id?: number;
  payment_number?: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  reference_number?: string;
  notes?: string;
}

export class VendorsService {
  private static schemaEnsured = false;

  /**
   * Automatically ensures vendor tables, permissions, and baseline seed data exist.
   */
  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      // 1. Create tables
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS vendors (
          id INT AUTO_INCREMENT PRIMARY KEY,
          uuid VARCHAR(64) NOT NULL UNIQUE,
          vendor_code VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(150) NOT NULL,
          category VARCHAR(100) NOT NULL DEFAULT 'General Supplies',
          status ENUM('ACTIVE', 'INACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
          image_url VARCHAR(255) NULL,
          notes TEXT NULL,

          contact_person VARCHAR(100) NULL,
          phone VARCHAR(30) NOT NULL,
          email VARCHAR(100) NULL,
          address TEXT NULL,
          city VARCHAR(100) NULL,
          state VARCHAR(100) NULL,
          postal_code VARCHAR(20) NULL,
          website VARCHAR(255) NULL,

          tax_id VARCHAR(50) NULL,
          pan_number VARCHAR(50) NULL,

          outstanding_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,

          preferred_payment_method VARCHAR(50) DEFAULT 'BANK_TRANSFER',
          bank_name VARCHAR(100) NULL,
          account_number VARCHAR(50) NULL,
          ifsc_code VARCHAR(50) NULL,
          upi_id VARCHAR(100) NULL,

          created_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          is_deleted TINYINT(1) NOT NULL DEFAULT 0,
          deleted_at DATETIME NULL,
          deleted_by INT NULL,
          INDEX idx_vendors_code (vendor_code),
          INDEX idx_vendors_name (name),
          INDEX idx_vendors_category (category),
          INDEX idx_vendors_status (status),
          INDEX idx_vendors_phone (phone),
          INDEX idx_vendors_is_deleted (is_deleted)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // A vendor supplies more than one kind of goods, so the categories live
      // in their own table. `vendors.category` is kept as the primary one —
      // the first the user picked — because the vendor list, the detail header
      // and the inventory purchases report all still read it, and dropping it
      // would break them for no gain.
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS vendor_categories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          vendor_id INT NOT NULL,
          category VARCHAR(100) NOT NULL,
          display_order INT NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_vendor_category (vendor_id, category),
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
          INDEX idx_vendor_categories_vendor (vendor_id),
          INDEX idx_vendor_categories_category (category)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Back-fill once, so vendors created before this keep the category they
      // already had instead of appearing to supply nothing.
      await dbService.execute(`
        INSERT IGNORE INTO vendor_categories (vendor_id, category, display_order)
        SELECT v.id, v.category, 0
        FROM vendors v
        WHERE v.category IS NOT NULL
          AND v.category <> ''
          AND NOT EXISTS (SELECT 1 FROM vendor_categories vc WHERE vc.vendor_id = v.id)
      `);

      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS vendor_purchases (
          id INT AUTO_INCREMENT PRIMARY KEY,
          uuid VARCHAR(64) NOT NULL UNIQUE,
          vendor_id INT NOT NULL,
          invoice_number VARCHAR(100) NOT NULL,
          order_date DATETIME NOT NULL,
          due_date DATETIME NULL,
          total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          paid_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          balance_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          payment_status ENUM('PAID', 'PARTIAL', 'UNPAID', 'OVERDUE') NOT NULL DEFAULT 'UNPAID',
          delivery_status ENUM('RECEIVED', 'PENDING', 'CANCELLED') NOT NULL DEFAULT 'RECEIVED',
          items_summary TEXT NULL,
          notes TEXT NULL,
          created_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_vp_vendor_id (vendor_id),
          INDEX idx_vp_invoice (invoice_number),
          INDEX idx_vp_payment_status (payment_status),
          INDEX idx_vp_order_date (order_date),
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS vendor_payments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          uuid VARCHAR(64) NOT NULL UNIQUE,
          vendor_id INT NOT NULL,
          purchase_id INT NULL,
          payment_number VARCHAR(100) NOT NULL UNIQUE,
          payment_date DATETIME NOT NULL,
          amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          payment_method VARCHAR(50) NOT NULL DEFAULT 'BANK_TRANSFER',
          reference_number VARCHAR(100) NULL,
          notes TEXT NULL,
          created_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_vpay_vendor_id (vendor_id),
          INDEX idx_vpay_purchase_id (purchase_id),
          INDEX idx_vpay_date (payment_date),
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
          FOREIGN KEY (purchase_id) REFERENCES vendor_purchases(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 3. Ensure Permissions
      await dbService.execute(`
        INSERT IGNORE INTO permissions (code, module, description)
        VALUES 
          ('vendor.view', 'VENDORS', 'View vendor list, profiles and purchase records'),
          ('vendor.manage', 'VENDORS', 'Create, edit, delete vendors and record purchases and payments');
      `);

      await dbService.execute(`
        INSERT IGNORE INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        CROSS JOIN permissions p
        WHERE p.code IN ('vendor.view', 'vendor.manage')
          AND r.name IN ('ADMIN', 'MANAGER');
      `);

      await dbService.execute(`
        INSERT IGNORE INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        CROSS JOIN permissions p
        WHERE p.code = 'vendor.view'
          AND r.name = 'CASHIER';
      `);

      this.schemaEnsured = true;
      logger.info('Vendor Management schema, permissions, and tables verified successfully.');
    } catch (err) {
      this.schemaEnsured = true;
      logger.error('Error ensuring vendor schema:', err);
    }
  }

  /**
   * Normalises a submitted category list: trimmed, de-duplicated
   * case-insensitively, blanks dropped, order preserved. The first entry is
   * the primary one written back to `vendors.category`.
   */
  private static normaliseCategories(input: unknown, fallback?: string): string[] {
    const raw = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
      const value = String(item ?? '').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    if (out.length === 0) {
      const fb = String(fallback ?? '').trim();
      if (fb) out.push(fb);
    }
    return out;
  }

  /** Replaces a vendor's category set. Call inside a transaction. */
  private static async replaceCategories(vendorId: number, categories: string[]): Promise<void> {
    await dbService.execute('DELETE FROM vendor_categories WHERE vendor_id = ?', [vendorId]);
    for (let i = 0; i < categories.length; i++) {
      await dbService.execute(
        'INSERT IGNORE INTO vendor_categories (vendor_id, category, display_order) VALUES (?, ?, ?)',
        [vendorId, categories[i], i]
      );
    }
  }

  /**
   * Adds `categories` to each vendor in one query rather than one per row —
   * a page of 50 vendors would otherwise be 50 extra round trips.
   */
  private static async attachCategories(vendors: any[]): Promise<void> {
    for (const v of vendors) v.categories = [];
    if (vendors.length === 0) return;

    const ids = vendors.map((v) => v.id).filter((id) => Number.isFinite(Number(id)));
    if (ids.length === 0) return;

    let rows: any[] = [];
    try {
      rows = await dbService.query<any>(
        `SELECT vendor_id, category
         FROM vendor_categories
         WHERE vendor_id IN (${ids.map(() => '?').join(',')})
         ORDER BY display_order ASC, id ASC`,
        ids
      );
    } catch {
      return;
    }

    const byVendor = new Map<number, string[]>();
    for (const r of rows) {
      const list = byVendor.get(r.vendor_id) || [];
      list.push(r.category);
      byVendor.set(r.vendor_id, list);
    }
    for (const v of vendors) {
      const list = byVendor.get(v.id) || [];
      // A vendor that predates the join table still shows its single category.
      v.categories = list.length ? list : this.normaliseCategories([], v.category);
    }
  }

  static async getAll(options: {
    page?: number;
    limit?: number;
    search?: string;
    category?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
  }) {
    await this.ensureSchema();

    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 50));
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (options.search) {
      where += ' AND (name LIKE ? OR vendor_code LIKE ? OR contact_person LIKE ? OR phone LIKE ? OR tax_id LIKE ? OR email LIKE ?)';
      const term = ParamUtil.like(options.search);
      params.push(term, term, term, term, term, term);
    }

    if (options.category && options.category !== 'ALL') {
      // Matches any of the vendor's categories, not just the primary one, so a
      // vendor that supplies three things is found under all three. The OR on
      // `category` keeps rows that predate the join table findable.
      where += ` AND (EXISTS (
                   SELECT 1 FROM vendor_categories vc
                   WHERE vc.vendor_id = vendors.id AND vc.category = ?
                 ) OR category = ?)`;
      params.push(options.category, options.category);
    }

    if (options.status && options.status !== 'ALL') {
      where += ' AND status = ?';
      params.push(options.status);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM vendors ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const validSortCols: Record<string, string> = {
      name: 'name',
      vendor_code: 'vendor_code',
      outstanding_balance: 'outstanding_balance',
      created_at: 'created_at',
    };
    const sortCol = validSortCols[options.sortBy || ''] || 'name';
    const sortDir = options.sortOrder === 'DESC' ? 'DESC' : 'ASC';

    const vendors = await dbService.query<any>(
      `SELECT vendors.*,
              COALESCE((SELECT SUM(amount) FROM vendor_payments WHERE vendor_id = vendors.id), 0) AS total_paid_amount,
              COALESCE((SELECT SUM(total_amount) FROM vendor_purchases WHERE vendor_id = vendors.id), 0) AS total_purchases_amount,
              COALESCE((SELECT COUNT(*) FROM vendor_purchases WHERE vendor_id = vendors.id), 0) AS total_purchases_count,
              (SELECT order_date FROM vendor_purchases WHERE vendor_id = vendors.id ORDER BY order_date DESC LIMIT 1) AS last_purchase_date,
              (SELECT payment_date FROM vendor_payments WHERE vendor_id = vendors.id ORDER BY payment_date DESC LIMIT 1) AS last_payment_date
       FROM vendors
       ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    await this.attachCategories(vendors);

    return {
      data: vendors,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getStats() {
    await this.ensureSchema();

    const summary = await dbService.queryOne<{
      total_vendors: number;
      active_vendors: number;
      total_outstanding: number;
    }>(`
      SELECT 
        COUNT(*) as total_vendors,
        COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) as active_vendors,
        COALESCE(SUM(outstanding_balance), 0) as total_outstanding
      FROM vendors
      WHERE is_deleted = 0
    `);

    const purchasesSummary = await dbService.queryOne<{
      total_purchases: number;
    }>(`
      SELECT COALESCE(SUM(total_amount), 0) as total_purchases
      FROM vendor_purchases
    `);

    // Overdue summary
    const overdueRes = await dbService.queryOne<{
      overdue_count: number;
      overdue_amount: number;
    }>(`
      SELECT 
        COUNT(*) as overdue_count,
        COALESCE(SUM(balance_amount), 0) as overdue_amount
      FROM vendor_purchases
      WHERE payment_status != 'PAID' AND due_date IS NOT NULL AND due_date < NOW()
    `);

    // Distinct categories, counted across every category a vendor supplies —
    // so a vendor listed under three appears in all three tallies. The UNION
    // picks up vendors that predate the join table and have only the primary.
    const categories = await dbService.query<{ category: string; count: number }>(`
      SELECT category, COUNT(DISTINCT vendor_id) as count
      FROM (
        SELECT vc.category AS category, vc.vendor_id AS vendor_id
        FROM vendor_categories vc
        JOIN vendors v ON v.id = vc.vendor_id
        WHERE v.is_deleted = 0
        UNION
        SELECT v.category AS category, v.id AS vendor_id
        FROM vendors v
        WHERE v.is_deleted = 0
          AND v.category IS NOT NULL
          AND v.category <> ''
          AND NOT EXISTS (SELECT 1 FROM vendor_categories vc2 WHERE vc2.vendor_id = v.id)
      ) all_cats
      GROUP BY category
      ORDER BY count DESC
    `);

    return {
      totalVendors: summary?.total_vendors || 0,
      activeVendors: summary?.active_vendors || 0,
      totalOutstanding: summary?.total_outstanding || 0,
      totalPurchases: purchasesSummary?.total_purchases || 0,
      overdueCount: overdueRes?.overdue_count || 0,
      overdueAmount: overdueRes?.overdue_amount || 0,
      categories: categories.map((c) => ({ name: c.category, count: c.count })),
    };
  }

  static async getById(id: number) {
    await this.ensureSchema();

    const vendor = await dbService.queryOne<any>('SELECT * FROM vendors WHERE id = ?', [id]);
    if (!vendor) {
      throw AppError.notFound('Vendor not found');
    }

    await this.attachCategories([vendor]);

    const purchases = await dbService.query(
      `SELECT * FROM vendor_purchases WHERE vendor_id = ? ORDER BY order_date DESC LIMIT 50`,
      [id]
    );

    const payments = await dbService.query(
      `SELECT * FROM vendor_payments WHERE vendor_id = ? ORDER BY payment_date DESC LIMIT 50`,
      [id]
    );

    const auditLogs = await this.getAuditLogs(id);

    const totalPurchasesAmount = (purchases as any[]).reduce((sum: number, p: any) => sum + Number(p.total_amount || 0), 0);
    const totalPaidAmount = (payments as any[]).reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    const lastPurchaseDate = (purchases as any[]).length > 0 ? (purchases as any[])[0].order_date : null;
    const lastPaymentDate = (payments as any[]).length > 0 ? (payments as any[])[0].payment_date : null;

    return {
      ...(vendor as any),
      total_purchases_amount: totalPurchasesAmount,
      total_paid_amount: totalPaidAmount,
      total_purchases_count: (purchases as any[]).length,
      last_purchase_date: lastPurchaseDate,
      last_payment_date: lastPaymentDate,
      purchases,
      payments,
      audit_logs: auditLogs,
    };
  }

  static async getAuditLogs(id: number) {
    await this.ensureSchema();
    const logs = await dbService.query(
      `SELECT a.id, a.user_id, u.name as user_name, u.username, a.action, a.module, a.record_id,
              a.old_values, a.new_values, a.ip_address, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.module = 'VENDORS' AND (a.record_id = ? OR a.record_id = ?)
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [String(id), id]
    );

    return (logs as any[]).map((log: any) => {
      let oldValues = null;
      let newValues = null;
      try {
        oldValues = log.old_values ? (typeof log.old_values === 'string' ? JSON.parse(log.old_values) : log.old_values) : null;
      } catch {}
      try {
        newValues = log.new_values ? (typeof log.new_values === 'string' ? JSON.parse(log.new_values) : log.new_values) : null;
      } catch {}

      return {
        ...log,
        old_values: oldValues,
        new_values: newValues,
      };
    });
  }

  static async create(data: CreateVendorInput, userId: number) {
    await this.ensureSchema();

    // Auto-generate unique vendor_code if not supplied
    let vendorCode = data.vendor_code?.trim().toUpperCase();
    if (!vendorCode) {
      const maxRes = await dbService.queryOne<{ max_id: number }>('SELECT COALESCE(MAX(id), 0) as max_id FROM vendors');
      let nextNum = (maxRes?.max_id || 0) + 1;
      vendorCode = `VND-${String(nextNum).padStart(3, '0')}`;
      let exists = await dbService.queryOne('SELECT id FROM vendors WHERE vendor_code = ?', [vendorCode]);
      while (exists) {
        nextNum++;
        vendorCode = `VND-${String(nextNum).padStart(3, '0')}`;
        exists = await dbService.queryOne('SELECT id FROM vendors WHERE vendor_code = ?', [vendorCode]);
      }
    } else {
      const existingCode = await dbService.queryOne('SELECT id FROM vendors WHERE vendor_code = ?', [vendorCode]);
      if (existingCode) {
        throw AppError.conflict(`Vendor code ${vendorCode} already exists`);
      }
    }

    const uuid = uuidv4();
    const paymentMethod = Array.isArray(data.preferred_payment_method)
      ? data.preferred_payment_method.join(',')
      : (data.preferred_payment_method || 'BANK_TRANSFER');

    // The first selected category is written to vendors.category so the list,
    // the detail header and the purchases report keep working unchanged.
    const categories = this.normaliseCategories(
      data.categories ?? data.category,
      'General Supplies'
    );
    const primaryCategory = categories[0] || 'General Supplies';

    return await dbService.transaction(async () => {
    const res = await dbService.execute(`
      INSERT INTO vendors (
        uuid, vendor_code, name, category, status, image_url, notes,
        contact_person, phone, email, address, city, state, postal_code, website,
        tax_id, pan_number,
        preferred_payment_method, bank_name, account_number, ifsc_code, upi_id,
        outstanding_balance, created_by
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
    `, [
      uuid,
      vendorCode,
      data.name.trim(),
      primaryCategory,
      data.status || 'ACTIVE',
      data.image_url || null,
      data.notes || null,

      data.contact_person || null,
      data.phone.trim(),
      data.email || null,
      data.address || null,
      data.city || null,
      data.state || null,
      data.postal_code || null,
      data.website || null,

      data.tax_id || null,
      data.pan_number || null,

      paymentMethod,
      data.bank_name || null,
      data.account_number || null,
      data.ifsc_code || null,
      data.upi_id || null,

      data.outstanding_balance !== undefined ? Number(data.outstanding_balance) : 0,
      userId,
    ]);

    const createdId = res.lastInsertRowid;

    await this.replaceCategories(createdId, categories);

    await AuditService.log({
      userId,
      action: 'VENDOR_CREATED',
      module: 'VENDORS',
      recordId: createdId,
      newValues: { name: data.name, vendor_code: vendorCode, categories },
    });

    return await this.getById(createdId);
    });
  }

  static async update(id: number, data: Partial<CreateVendorInput>, userId: number) {
    await this.ensureSchema();
    const current = await this.getById(id);

    if (data.vendor_code && data.vendor_code !== current.vendor_code) {
      const existing = await dbService.queryOne('SELECT id FROM vendors WHERE vendor_code = ? AND id != ?', [data.vendor_code, id]);
      if (existing) {
        throw AppError.conflict(`Vendor code ${data.vendor_code} already belongs to another vendor`);
      }
    }

    const paymentMethod = data.preferred_payment_method !== undefined
      ? (Array.isArray(data.preferred_payment_method) ? data.preferred_payment_method.join(',') : data.preferred_payment_method)
      : null;

    // Only touch categories when the caller sent them; an update that omits
    // the field leaves the existing set alone, like every other column here.
    const nextCategories = data.categories !== undefined || data.category !== undefined
      ? this.normaliseCategories(data.categories ?? data.category, current.category)
      : null;
    const primaryCategory = nextCategories && nextCategories.length ? nextCategories[0] : null;

    return await dbService.transaction(async () => {
    await dbService.execute(`
      UPDATE vendors
      SET 
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        status = COALESCE(?, status),
        image_url = COALESCE(?, image_url),
        notes = COALESCE(?, notes),
        contact_person = COALESCE(?, contact_person),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        postal_code = COALESCE(?, postal_code),
        website = COALESCE(?, website),
        tax_id = COALESCE(?, tax_id),
        pan_number = COALESCE(?, pan_number),
        preferred_payment_method = COALESCE(?, preferred_payment_method),
        bank_name = COALESCE(?, bank_name),
        account_number = COALESCE(?, account_number),
        ifsc_code = COALESCE(?, ifsc_code),
        upi_id = COALESCE(?, upi_id),
        outstanding_balance = COALESCE(?, outstanding_balance),
        updated_at = NOW()
      WHERE id = ?
    `, [
      data.name ?? null,
      primaryCategory,
      data.status ?? null,
      data.image_url ?? null,
      data.notes ?? null,
      data.contact_person ?? null,
      data.phone ?? null,
      data.email ?? null,
      data.address ?? null,
      data.city ?? null,
      data.state ?? null,
      data.postal_code ?? null,
      data.website ?? null,
      data.tax_id ?? null,
      data.pan_number ?? null,
      paymentMethod,
      data.bank_name ?? null,
      data.account_number ?? null,
      data.ifsc_code ?? null,
      data.upi_id ?? null,
      data.outstanding_balance !== undefined ? Number(data.outstanding_balance) : null,
      id,
    ]);

    if (nextCategories) {
      await this.replaceCategories(id, nextCategories);
    }

    await AuditService.log({
      userId,
      action: 'VENDOR_UPDATED',
      module: 'VENDORS',
      recordId: id,
      newValues: data,
    });

    return await this.getById(id);
    });
  }

  static async delete(id: number, userId: number) {
    await this.ensureSchema();
    const vendor = await this.getById(id);

    // If vendor has non-zero outstanding balance, prevent outright delete to maintain financial integrity
    if (vendor.outstanding_balance > 0) {
      throw AppError.badRequest(
        `Cannot delete vendor with outstanding balance of ${vendor.outstanding_balance}. Settle all balances or set status to BLOCKED instead.`
      );
    }

    await dbService.execute('DELETE FROM vendors WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'VENDOR_DELETED',
      module: 'VENDORS',
      recordId: id,
      oldValues: { name: vendor.name, vendor_code: vendor.vendor_code },
    });

    return { success: true, message: 'Vendor removed successfully' };
  }

  /**
   * Purchase History & Recording
   */
  static async getPurchases(vendorId: number, page = 1, limit = 50) {
    await this.ensureSchema();
    const offset = (page - 1) * limit;

    const countRes = await dbService.queryOne<{ total: number }>(
      'SELECT COUNT(*) as total FROM vendor_purchases WHERE vendor_id = ?',
      [vendorId]
    );
    const total = countRes?.total || 0;

    const purchases = await dbService.query(
      `SELECT * FROM vendor_purchases WHERE vendor_id = ? ORDER BY order_date DESC LIMIT ? OFFSET ?`,
      [vendorId, limit, offset]
    );

    return {
      data: purchases,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async recordPurchase(vendorId: number, data: RecordPurchaseInput, userId: number) {
    await this.ensureSchema();
    const vendor = await this.getById(vendorId);

    const totalAmount = Number(data.total_amount) || 0;
    const paidAmount = Number(data.paid_amount) || 0;
    const balanceAmount = Math.max(0, totalAmount - paidAmount);

    let paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID' = 'UNPAID';
    if (paidAmount >= totalAmount && totalAmount > 0) {
      paymentStatus = 'PAID';
    } else if (paidAmount > 0) {
      paymentStatus = 'PARTIAL';
    }

    const uuid = uuidv4();

    return await dbService.transaction(async () => {
      // 1. Insert purchase invoice
      const res = await dbService.execute(`
        INSERT INTO vendor_purchases (
          uuid, vendor_id, invoice_number, order_date, due_date,
          total_amount, paid_amount, balance_amount, payment_status,
          delivery_status, items_summary, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?)
      `, [
        uuid,
        vendorId,
        data.invoice_number.trim(),
        data.order_date,
        data.due_date || null,
        totalAmount,
        paidAmount,
        balanceAmount,
        paymentStatus,
        data.items_summary || null,
        data.notes || null,
        userId,
      ]);

      const purchaseId = res.lastInsertRowid;

      // 2. If immediate partial or full payment was recorded, log the payment
      if (paidAmount > 0) {
        const payNum = `PAY-${Date.now()}`;
        await dbService.execute(`
          INSERT INTO vendor_payments (
            uuid, vendor_id, purchase_id, payment_number, payment_date,
            amount, payment_method, reference_number, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, 'BANK_TRANSFER', ?, 'Initial payment on purchase invoice', ?)
        `, [
          uuidv4(),
          vendorId,
          purchaseId,
          payNum,
          data.order_date,
          paidAmount,
          `AUTO-PAY-${data.invoice_number}`,
          userId,
        ]);
      }

      // 3. Atomically update vendor balances
      await dbService.execute(`
        UPDATE vendors
        SET 
          outstanding_balance = outstanding_balance + ?,
          updated_at = NOW()
        WHERE id = ?
      `, [
        balanceAmount,
        vendorId,
      ]);

      await AuditService.log({
        userId,
        action: 'VENDOR_PURCHASE_RECORDED',
        module: 'VENDORS',
        recordId: purchaseId,
        newValues: { invoice: data.invoice_number, amount: totalAmount, vendorId },
      });

      return await this.getById(vendorId);
    });
  }

  /**
   * Payments & Balance Clearance
   */
  static async getPayments(vendorId: number, page = 1, limit = 50) {
    await this.ensureSchema();
    const offset = (page - 1) * limit;

    const countRes = await dbService.queryOne<{ total: number }>(
      'SELECT COUNT(*) as total FROM vendor_payments WHERE vendor_id = ?',
      [vendorId]
    );
    const total = countRes?.total || 0;

    const payments = await dbService.query(
      `SELECT vp.*, p.invoice_number 
       FROM vendor_payments vp
       LEFT JOIN vendor_purchases p ON p.id = vp.purchase_id
       WHERE vp.vendor_id = ?
       ORDER BY vp.payment_date DESC
       LIMIT ? OFFSET ?`,
      [vendorId, limit, offset]
    );

    return {
      data: payments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async recordPayment(vendorId: number, data: RecordPaymentInput, userId: number) {
    await this.ensureSchema();
    const vendor = await this.getById(vendorId);

    const paymentAmount = Number(data.amount);
    if (!paymentAmount || paymentAmount <= 0) {
      throw AppError.badRequest('Payment amount must be greater than zero');
    }

    const payNumber = data.payment_number?.trim() || `PAY-VND-${Date.now()}`;

    return await dbService.transaction(async () => {
      // 1. Insert payment record
      const res = await dbService.execute(`
        INSERT INTO vendor_payments (
          uuid, vendor_id, purchase_id, payment_number, payment_date,
          amount, payment_method, reference_number, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(),
        vendorId,
        data.purchase_id || null,
        payNumber,
        data.payment_date,
        paymentAmount,
        data.payment_method || 'BANK_TRANSFER',
        data.reference_number || null,
        data.notes || null,
        userId,
      ]);

      // 2. If tied to a specific purchase invoice, update its payment and balance status
      if (data.purchase_id) {
        const purchase = await dbService.queryOne<{
          id: number;
          total_amount: number;
          paid_amount: number;
          balance_amount: number;
        }>('SELECT * FROM vendor_purchases WHERE id = ? AND vendor_id = ?', [data.purchase_id, vendorId]);

        if (purchase) {
          const newPaid = Math.min(purchase.total_amount, Number(purchase.paid_amount) + paymentAmount);
          const newBal = Math.max(0, Number(purchase.total_amount) - newPaid);
          const newStatus = newBal === 0 ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : 'UNPAID');

          await dbService.execute(`
            UPDATE vendor_purchases
            SET paid_amount = ?, balance_amount = ?, payment_status = ?, updated_at = NOW()
            WHERE id = ?
          `, [newPaid, newBal, newStatus, data.purchase_id]);
        }
      }

      // 3. Atomically decrease vendor outstanding balance
      await dbService.execute(`
        UPDATE vendors
        SET 
          outstanding_balance = GREATEST(0.00, outstanding_balance - ?),
          updated_at = NOW()
        WHERE id = ?
      `, [paymentAmount, vendorId]);

      await AuditService.log({
        userId,
        action: 'VENDOR_PAYMENT_RECORDED',
        module: 'VENDORS',
        recordId: res.lastInsertRowid,
        newValues: { amount: paymentAmount, method: data.payment_method, vendorId },
      });

      return await this.getById(vendorId);
    });
  }

  static async updatePayment(vendorId: number, paymentId: number, data: Partial<RecordPaymentInput>, userId: number) {
    await this.ensureSchema();
    const currentPayment = await dbService.queryOne<any>(
      'SELECT * FROM vendor_payments WHERE id = ? AND vendor_id = ?',
      [paymentId, vendorId]
    );
    if (!currentPayment) {
      throw AppError.notFound('Payment record not found');
    }

    const newAmount = data.amount !== undefined ? Number(data.amount) : Number(currentPayment.amount);
    const amountDiff = newAmount - Number(currentPayment.amount);

    return await dbService.transaction(async () => {
      await dbService.execute(`
        UPDATE vendor_payments
        SET 
          payment_date = COALESCE(?, payment_date),
          amount = COALESCE(?, amount),
          payment_method = COALESCE(?, payment_method),
          reference_number = COALESCE(?, reference_number),
          notes = COALESCE(?, notes)
        WHERE id = ? AND vendor_id = ?
      `, [
        data.payment_date ?? null,
        data.amount !== undefined ? newAmount : null,
        data.payment_method ?? null,
        data.reference_number ?? null,
        data.notes ?? null,
        paymentId,
        vendorId,
      ]);

      if (amountDiff !== 0) {
        await dbService.execute(`
          UPDATE vendors
          SET outstanding_balance = GREATEST(0.00, outstanding_balance - ?), updated_at = NOW()
          WHERE id = ?
        `, [amountDiff, vendorId]);
      }

      await AuditService.log({
        userId,
        action: 'VENDOR_PAYMENT_UPDATED',
        module: 'VENDORS',
        recordId: paymentId,
        newValues: { vendorId, amount: newAmount },
      });

      return await this.getById(vendorId);
    });
  }

  static async deletePayment(vendorId: number, paymentId: number, userId: number) {
    await this.ensureSchema();
    const currentPayment = await dbService.queryOne<any>(
      'SELECT * FROM vendor_payments WHERE id = ? AND vendor_id = ?',
      [paymentId, vendorId]
    );
    if (!currentPayment) {
      throw AppError.notFound('Payment record not found');
    }

    const amount = Number(currentPayment.amount);

    return await dbService.transaction(async () => {
      await dbService.execute('DELETE FROM vendor_payments WHERE id = ? AND vendor_id = ?', [paymentId, vendorId]);

      // Restore vendor outstanding balance
      await dbService.execute(`
        UPDATE vendors
        SET outstanding_balance = outstanding_balance + ?, updated_at = NOW()
        WHERE id = ?
      `, [amount, vendorId]);

      // If linked to a purchase, reverse the purchase paid amount
      if (currentPayment.purchase_id) {
        const purchase = await dbService.queryOne<any>(
          'SELECT * FROM vendor_purchases WHERE id = ? AND vendor_id = ?',
          [currentPayment.purchase_id, vendorId]
        );
        if (purchase) {
          const newPaid = Math.max(0, Number(purchase.paid_amount) - amount);
          const newBal = Number(purchase.total_amount) - newPaid;
          const newStatus = newBal === 0 ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : 'UNPAID');

          await dbService.execute(`
            UPDATE vendor_purchases
            SET paid_amount = ?, balance_amount = ?, payment_status = ?, updated_at = NOW()
            WHERE id = ?
          `, [newPaid, newBal, newStatus, currentPayment.purchase_id]);
        }
      }

      await AuditService.log({
        userId,
        action: 'VENDOR_PAYMENT_DELETED',
        module: 'VENDORS',
        recordId: paymentId,
        oldValues: { amount, paymentNumber: currentPayment.payment_number, vendorId },
      });

      return await this.getById(vendorId);
    });
  }

  static async updatePurchase(vendorId: number, purchaseId: number, data: Partial<RecordPurchaseInput>, userId: number) {
    await this.ensureSchema();
    const currentPurchase = await dbService.queryOne<any>(
      'SELECT * FROM vendor_purchases WHERE id = ? AND vendor_id = ?',
      [purchaseId, vendorId]
    );
    if (!currentPurchase) {
      throw AppError.notFound('Purchase record not found');
    }

    const newTotal = data.total_amount !== undefined ? Number(data.total_amount) : Number(currentPurchase.total_amount);
    const paidAmount = Number(currentPurchase.paid_amount);
    const newBal = Math.max(0, newTotal - paidAmount);
    const balanceDiff = newBal - Number(currentPurchase.balance_amount);
    const newStatus = newBal === 0 ? 'PAID' : (paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    return await dbService.transaction(async () => {
      await dbService.execute(`
        UPDATE vendor_purchases
        SET 
          invoice_number = COALESCE(?, invoice_number),
          order_date = COALESCE(?, order_date),
          due_date = COALESCE(?, due_date),
          total_amount = ?,
          balance_amount = ?,
          payment_status = ?,
          items_summary = COALESCE(?, items_summary),
          notes = COALESCE(?, notes),
          updated_at = NOW()
        WHERE id = ? AND vendor_id = ?
      `, [
        data.invoice_number ?? null,
        data.order_date ?? null,
        data.due_date ?? null,
        newTotal,
        newBal,
        newStatus,
        data.items_summary ?? null,
        data.notes ?? null,
        purchaseId,
        vendorId,
      ]);

      if (balanceDiff !== 0) {
        await dbService.execute(`
          UPDATE vendors
          SET outstanding_balance = GREATEST(0.00, outstanding_balance + ?), updated_at = NOW()
          WHERE id = ?
        `, [balanceDiff, vendorId]);
      }

      await AuditService.log({
        userId,
        action: 'VENDOR_PURCHASE_UPDATED',
        module: 'VENDORS',
        recordId: purchaseId,
        newValues: { total_amount: newTotal, vendorId },
      });

      return await this.getById(vendorId);
    });
  }

  static async deletePurchase(vendorId: number, purchaseId: number, userId: number) {
    await this.ensureSchema();
    const currentPurchase = await dbService.queryOne<any>(
      'SELECT * FROM vendor_purchases WHERE id = ? AND vendor_id = ?',
      [purchaseId, vendorId]
    );
    if (!currentPurchase) {
      throw AppError.notFound('Purchase record not found');
    }

    const balanceAmount = Number(currentPurchase.balance_amount);

    return await dbService.transaction(async () => {
      await dbService.execute('DELETE FROM vendor_purchases WHERE id = ? AND vendor_id = ?', [purchaseId, vendorId]);

      if (balanceAmount > 0) {
        await dbService.execute(`
          UPDATE vendors
          SET outstanding_balance = GREATEST(0.00, outstanding_balance - ?), updated_at = NOW()
          WHERE id = ?
        `, [balanceAmount, vendorId]);
      }

      await AuditService.log({
        userId,
        action: 'VENDOR_PURCHASE_DELETED',
        module: 'VENDORS',
        recordId: purchaseId,
        oldValues: { invoice: currentPurchase.invoice_number, amount: currentPurchase.total_amount, vendorId },
      });

      return await this.getById(vendorId);
    });
  }
}
