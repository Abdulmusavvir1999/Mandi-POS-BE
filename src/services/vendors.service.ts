import { v4 as uuidv4 } from 'uuid';
import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { logger } from '../config/logger';
import { ParamUtil } from '../utils/param.util';

export interface CreateVendorInput {
  vendor_code?: string;
  name: string;
  category?: string;
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

          preferred_payment_method VARCHAR(50) DEFAULT 'BANK_TRANSFER',
          bank_name VARCHAR(100) NULL,
          account_number VARCHAR(50) NULL,
          ifsc_code VARCHAR(50) NULL,
          upi_id VARCHAR(100) NULL,

          outstanding_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,

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

      // 2. Drop deprecated/extra columns from existing DB schema if present
      const colsToDrop = [
        'msme_number',
        'credit_period_days',
        'tax_category',
        'payment_terms',
        'branch_name',
        'credit_limit',
        'total_purchases_amount',
        'total_purchases_count',
        'last_purchase_date',
        'last_payment_date',
        'rating',
        'delivery_speed_rating',
        'quality_rating',
        'pricing_rating',
        'on_time_delivery_rate',
        'quality_score',
        'fulfillment_rate',
        'performance_notes',
      ];
      for (const col of colsToDrop) {
        try {
          await dbService.execute(`ALTER TABLE vendors DROP COLUMN \`${col}\``);
        } catch (_) {}
      }

      try {
        await dbService.execute(`ALTER TABLE vendors ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0`);
      } catch (_) {}
      try {
        await dbService.execute(`ALTER TABLE vendors ADD COLUMN deleted_at DATETIME NULL`);
      } catch (_) {}
      try {
        await dbService.execute(`ALTER TABLE vendors ADD COLUMN deleted_by INT NULL`);
      } catch (_) {}
      try {
        await dbService.execute(`ALTER TABLE vendors ADD COLUMN outstanding_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00`);
      } catch (_) {}

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

      // 4. Check if any vendor exists, if not, seed realistic sample data
      const countRes = await dbService.queryOne<{ total: number }>('SELECT COUNT(*) as total FROM vendors');
      if (!countRes || countRes.total === 0) {
        await this.seedInitialVendors();
      }

      this.schemaEnsured = true;
      logger.info('Vendor Management schema, permissions, and tables verified successfully.');
    } catch (err) {
      logger.error('Error ensuring vendor schema:', err);
    }
  }

  private static async seedInitialVendors(): Promise<void> {
    const seeds = [
      {
        uuid: uuidv4(),
        vendor_code: 'VND-001',
        name: 'Al-Watania Poultry & Meat Farms',
        category: 'Meat & Poultry',
        status: 'ACTIVE',
        contact_person: 'Sheikh Tariq Mansoor',
        phone: '+966 50 123 4567',
        email: 'orders@alwatania-farms.com',
        address: 'Wholesale Meat District, Gate 4',
        city: 'Riyadh',
        state: 'Central Region',
        postal_code: '11564',
        website: 'https://alwatania-farms.com',
        tax_id: '310123456700003',
        pan_number: 'ALWPM9821K',
        preferred_payment_method: 'BANK_TRANSFER',
        bank_name: 'Al Rajhi Bank',
        account_number: 'SA0380000123456789012345',
        ifsc_code: 'RJHISARI',
        upi_id: 'alwatania@rajhi',
        outstanding_balance: 14500,
        notes: 'Primary contractor for chicken and lamb portions.',
      },
      {
        uuid: uuidv4(),
        vendor_code: 'VND-002',
        name: 'Deccan Basmati & Grain Traders',
        category: 'Rice & Grains',
        status: 'ACTIVE',
        contact_person: 'Abdul Rahman Siddiqui',
        phone: '+966 54 987 6543',
        email: 'supplies@deccanbasmati.com',
        address: 'Grain Silo Complex, Warehouse #12',
        city: 'Jeddah',
        state: 'Western Province',
        postal_code: '21432',
        website: 'https://deccanbasmati.com',
        tax_id: '310987654300003',
        pan_number: 'DECBA3412M',
        preferred_payment_method: 'BANK_TRANSFER',
        bank_name: 'National Commercial Bank (SNB)',
        account_number: 'SA4410000098765432109876',
        ifsc_code: 'NCBKSARI',
        upi_id: 'deccanrice@snb',
        outstanding_balance: 8200,
        notes: 'Bulk packaging 25kg and 50kg bags.',
      },
      {
        uuid: uuidv4(),
        vendor_code: 'VND-003',
        name: 'Royal Arabian Spice Kingdom',
        category: 'Spices & Condiments',
        status: 'ACTIVE',
        contact_person: 'Mustafa Al-Harbi',
        phone: '+966 56 333 7890',
        email: 'spices@royal-arabian.sa',
        address: 'Souq Al-Zal, Shop 88',
        city: 'Riyadh',
        state: 'Central Region',
        postal_code: '11411',
        website: 'https://royal-arabian.sa',
        tax_id: '310555666700003',
        pan_number: 'ROYSP7719P',
        preferred_payment_method: 'BANK_TRANSFER',
        bank_name: 'Riyad Bank',
        account_number: 'SA2220000055566677788899',
        ifsc_code: 'RIBLSARI',
        upi_id: 'royalspices@riyad',
        outstanding_balance: 3400,
        notes: 'Exclusive artisan spice blend for signature seasoning.',
      },
      {
        uuid: uuidv4(),
        vendor_code: 'VND-004',
        name: 'Daily Fresh Dairy & Produce Co.',
        category: 'Dairy & Fresh Produce',
        status: 'ACTIVE',
        contact_person: 'Hassan Al-Najjar',
        phone: '+966 53 444 1122',
        email: 'dispatch@dailyfreshdairy.com',
        address: 'Industrial Dairy Valley, Unit 5',
        city: 'Al Kharj',
        state: 'Central Region',
        postal_code: '16278',
        website: 'https://dailyfreshdairy.com',
        tax_id: '310444112200003',
        pan_number: 'DFDP9012R',
        preferred_payment_method: 'BANK_TRANSFER',
        bank_name: 'Banque Saudi Fransi',
        account_number: 'SA5550000011223344556677',
        ifsc_code: 'BSFRSARI',
        upi_id: 'dailyfresh@fransi',
        outstanding_balance: 2100,
        notes: 'Daily morning deliveries at 06:30 AM.',
      },
      {
        uuid: uuidv4(),
        vendor_code: 'VND-005',
        name: 'Gulf EcoPack & Disposables',
        category: 'Packaging & Disposables',
        status: 'ACTIVE',
        contact_person: 'Bilal Khurram',
        phone: '+966 55 777 9900',
        email: 'sales@gulfecopack.com',
        address: '2nd Industrial City, Plot 405',
        city: 'Dammam',
        state: 'Eastern Province',
        postal_code: '31421',
        website: 'https://gulfecopack.com',
        tax_id: '310777990000003',
        pan_number: 'GEPAK5523T',
        preferred_payment_method: 'BANK_TRANSFER',
        bank_name: 'Arab National Bank (ANB)',
        account_number: 'SA7740000033445566778899',
        ifsc_code: 'ARNBSARI',
        upi_id: 'gulfecopack@anb',
        outstanding_balance: 0,
        notes: 'Stocked on 2-month buffer quantities.',
      },
    ];

    for (const v of seeds) {
      const res = await dbService.execute(`
        INSERT INTO vendors (
          uuid, vendor_code, name, category, status, contact_person, phone, email,
          address, city, state, postal_code, website, tax_id, pan_number,
          preferred_payment_method, bank_name, account_number, ifsc_code, upi_id,
          outstanding_balance, notes
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )
      `, [
        v.uuid, v.vendor_code, v.name, v.category, v.status, v.contact_person, v.phone, v.email,
        v.address, v.city, v.state, v.postal_code, v.website, v.tax_id, v.pan_number,
        v.preferred_payment_method, v.bank_name, v.account_number, v.ifsc_code, v.upi_id,
        v.outstanding_balance, v.notes
      ]);

      const vendorId = res.lastInsertRowid;

      // Seed initial purchase invoice for this vendor
      if (v.outstanding_balance > 0) {
        await dbService.execute(`
          INSERT INTO vendor_purchases (
            uuid, vendor_id, invoice_number, order_date, due_date, total_amount, paid_amount, balance_amount, payment_status, delivery_status, items_summary, notes
          ) VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 DAY), DATE_ADD(NOW(), INTERVAL 25 DAY), ?, 0.00, ?, 'UNPAID', 'RECEIVED', ?, 'Initial system seed invoice')
        `, [
          uuidv4(), vendorId, `INV-${v.vendor_code}-001`, v.outstanding_balance, v.outstanding_balance, `Standard supply delivery for ${v.category}`
        ]);
      }
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
      where += ' AND category = ?';
      params.push(options.category);
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

    const vendors = await dbService.query(
      `SELECT * FROM vendors
       ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

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

    // Distinct categories
    const categories = await dbService.query<{ category: string; count: number }>(`
      SELECT category, COUNT(*) as count
      FROM vendors
      WHERE is_deleted = 0
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

    const vendor = await dbService.queryOne('SELECT * FROM vendors WHERE id = ?', [id]);
    if (!vendor) {
      throw AppError.notFound('Vendor not found');
    }

    const purchases = await dbService.query(
      `SELECT * FROM vendor_purchases WHERE vendor_id = ? ORDER BY order_date DESC LIMIT 50`,
      [id]
    );

    const payments = await dbService.query(
      `SELECT * FROM vendor_payments WHERE vendor_id = ? ORDER BY payment_date DESC LIMIT 50`,
      [id]
    );

    return {
      ...vendor,
      purchases,
      payments,
    };
  }

  static async create(data: CreateVendorInput, userId: number) {
    await this.ensureSchema();

    // Auto-generate vendor_code if not supplied
    let vendorCode = data.vendor_code?.trim().toUpperCase();
    if (!vendorCode) {
      const maxRes = await dbService.queryOne<{ max_id: number }>('SELECT COALESCE(MAX(id), 0) as max_id FROM vendors');
      const nextNum = (maxRes?.max_id || 0) + 1;
      vendorCode = `VND-${String(nextNum).padStart(3, '0')}`;
    }

    const existingCode = await dbService.queryOne('SELECT id FROM vendors WHERE vendor_code = ?', [vendorCode]);
    if (existingCode) {
      throw AppError.conflict(`Vendor code ${vendorCode} already exists`);
    }

    const uuid = uuidv4();

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
      data.category || 'General Supplies',
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

      data.preferred_payment_method || 'BANK_TRANSFER',
      data.bank_name || null,
      data.account_number || null,
      data.ifsc_code || null,
      data.upi_id || null,

      data.outstanding_balance !== undefined ? Number(data.outstanding_balance) : 0,
      userId,
    ]);

    const createdId = res.lastInsertRowid;

    await AuditService.log({
      userId,
      action: 'VENDOR_CREATED',
      module: 'VENDORS',
      recordId: createdId,
      newValues: { name: data.name, vendor_code: vendorCode },
    });

    return await this.getById(createdId);
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
      data.category ?? null,
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
      data.preferred_payment_method ?? null,
      data.bank_name ?? null,
      data.account_number ?? null,
      data.ifsc_code ?? null,
      data.upi_id ?? null,
      data.outstanding_balance !== undefined ? Number(data.outstanding_balance) : null,
      id,
    ]);

    await AuditService.log({
      userId,
      action: 'VENDOR_UPDATED',
      module: 'VENDORS',
      recordId: id,
      newValues: data,
    });

    return await this.getById(id);
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
          total_purchases_amount = total_purchases_amount + ?,
          total_purchases_count = total_purchases_count + 1,
          last_purchase_date = ?,
          last_payment_date = CASE WHEN ? > 0 THEN ? ELSE last_payment_date END,
          updated_at = NOW()
        WHERE id = ?
      `, [
        balanceAmount,
        totalAmount,
        data.order_date,
        paidAmount,
        data.order_date,
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
          last_payment_date = ?,
          updated_at = NOW()
        WHERE id = ?
      `, [paymentAmount, data.payment_date, vendorId]);

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

  /**
   * Rating & Performance Scorecard Update
   */
  static async updateRatingAndPerformance(
    vendorId: number,
    data: {
      rating?: number;
      delivery_speed_rating?: number;
      quality_rating?: number;
      pricing_rating?: number;
      on_time_delivery_rate?: number;
      quality_score?: number;
      fulfillment_rate?: number;
      performance_notes?: string;
    },
    userId: number
  ) {
    await this.ensureSchema();

    await dbService.execute(`
      UPDATE vendors
      SET
        rating = COALESCE(?, rating),
        delivery_speed_rating = COALESCE(?, delivery_speed_rating),
        quality_rating = COALESCE(?, quality_rating),
        pricing_rating = COALESCE(?, pricing_rating),
        on_time_delivery_rate = COALESCE(?, on_time_delivery_rate),
        quality_score = COALESCE(?, quality_score),
        fulfillment_rate = COALESCE(?, fulfillment_rate),
        performance_notes = COALESCE(?, performance_notes),
        updated_at = NOW()
      WHERE id = ?
    `, [
      data.rating ?? null,
      data.delivery_speed_rating ?? null,
      data.quality_rating ?? null,
      data.pricing_rating ?? null,
      data.on_time_delivery_rate ?? null,
      data.quality_score ?? null,
      data.fulfillment_rate ?? null,
      data.performance_notes ?? null,
      vendorId,
    ]);

    await AuditService.log({
      userId,
      action: 'VENDOR_PERFORMANCE_UPDATED',
      module: 'VENDORS',
      recordId: vendorId,
      newValues: data,
    });

    return await this.getById(vendorId);
  }
}
