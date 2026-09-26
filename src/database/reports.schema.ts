import { dbService } from './db';
import { logger } from '../config/logger';
import { CheckoutService } from '../services/checkout.service';

/**
 * Runtime DDL for the reporting suite, mirroring reporting_bi_migration.sql.
 *
 * Every other module in this codebase ensures its own tables on first use
 * rather than relying on the migration having been run, because installations
 * are provisioned at different times from different scripts. Reporting follows
 * the same rule so a report endpoint never 500s on a missing table.
 *
 * `CheckoutService.ensureSchema()` is chained in because almost every finance
 * and sales report filters on `bills.is_voided` and sums
 * `bills.coupon_discount` / `service_charge_amount` — columns added by the POS
 * offline migration. Without that guarantee a report would fail with
 * ER_BAD_FIELD_ERROR on a database that predates it.
 */
/**
 * Schema features the reports use when present.
 *
 * Reporting is the one module that reads every other module's tables, so it is
 * the first place a half-migrated database shows up. Rather than hard-failing
 * on a column a newer migration introduced, each report asks what this
 * database actually has and drops the corresponding breakdown when it is
 * missing.
 */
export interface ReportCapabilities {
  /** `bill_items.variant_id` / `variant_name` — portion-level sales breakdown. */
  billItemVariants: boolean;
  /** `bill_items.stock_consumption` — units of stock drawn per item sold. */
  billItemConsumption: boolean;
  /** `products.stock_item_id` — links a menu item to the stock it depletes. */
  productStockLink: boolean;
  /** `customers.tier` — loyalty tier segmentation in customer analytics. */
  customerTiers: boolean;
}

export class ReportsSchema {
  private static ensured = false;
  private static capabilityCache: ReportCapabilities | null = null;

  /** Cached per process; a migration run mid-process is not picked up until restart. */
  static async capabilities(): Promise<ReportCapabilities> {
    if (this.capabilityCache) return this.capabilityCache;

    const has = async (table: string, column: string): Promise<boolean> => {
      try {
        const row = await dbService.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = ?
             AND COLUMN_NAME = ?`,
          [table, column]
        );
        return !!row && Number(row.count) > 0;
      } catch (e) {
        logger.warn(`Could not probe ${table}.${column} for reporting:`, e);
        return false;
      }
    };

    this.capabilityCache = {
      billItemVariants: await has('bill_items', 'variant_id'),
      billItemConsumption: await has('bill_items', 'stock_consumption'),
      productStockLink: await has('products', 'stock_item_id'),
      customerTiers: await has('customers', 'tier'),
    };
    return this.capabilityCache;
  }

  static async ensure(): Promise<void> {
    if (this.ensured) return;

    try {
      await CheckoutService.ensureSchema();

      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS expense_categories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(80) NOT NULL UNIQUE,
          description VARCHAR(255) NULL,
          is_fixed_cost TINYINT(1) NOT NULL DEFAULT 0,
          is_system TINYINT(1) NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          display_order INT NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_expense_cat_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INT AUTO_INCREMENT PRIMARY KEY,
          uuid VARCHAR(64) NOT NULL UNIQUE,
          expense_number VARCHAR(50) NOT NULL UNIQUE,
          category VARCHAR(80) NOT NULL DEFAULT 'Miscellaneous',
          expense_date DATE NOT NULL,
          amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          tax_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          payment_method VARCHAR(30) NOT NULL DEFAULT 'CASH',
          payment_status VARCHAR(20) NOT NULL DEFAULT 'PAID',
          vendor_id INT NULL,
          vendor_name VARCHAR(150) NULL,
          reference_number VARCHAR(100) NULL,
          description VARCHAR(255) NULL,
          notes TEXT NULL,
          is_recurring TINYINT(1) NOT NULL DEFAULT 0,
          recorded_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_expenses_date (expense_date),
          INDEX idx_expenses_category (category),
          INDEX idx_expenses_status (payment_status),
          INDEX idx_expenses_vendor (vendor_id),
          INDEX idx_expenses_method (payment_method)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS refunds (
          id INT AUTO_INCREMENT PRIMARY KEY,
          uuid VARCHAR(64) NOT NULL UNIQUE,
          refund_number VARCHAR(50) NOT NULL UNIQUE,
          bill_id INT NOT NULL,
          bill_number VARCHAR(50) NULL,
          customer_id INT NULL,
          refund_type VARCHAR(20) NOT NULL DEFAULT 'FULL',
          subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          tax_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          refund_method VARCHAR(30) NOT NULL DEFAULT 'CASH',
          reason_code VARCHAR(50) NOT NULL DEFAULT 'OTHER',
          reason TEXT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
          reference_number VARCHAR(100) NULL,
          restock_items TINYINT(1) NOT NULL DEFAULT 0,
          approved_by INT NULL,
          refunded_by INT NULL,
          refunded_at DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_refunds_bill (bill_id),
          INDEX idx_refunds_customer (customer_id),
          INDEX idx_refunds_created (created_at),
          INDEX idx_refunds_status (status),
          INDEX idx_refunds_reason (reason_code),
          FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS refund_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          refund_id INT NOT NULL,
          bill_item_id INT NULL,
          product_id INT NULL,
          product_name VARCHAR(150) NOT NULL,
          unit_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
          quantity DECIMAL(10, 3) NOT NULL DEFAULT 0.000,
          subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          tax_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_refund_items_refund (refund_id),
          INDEX idx_refund_items_product (product_id),
          FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await dbService.execute(`
        INSERT IGNORE INTO permissions (code, module, description)
        VALUES
          ('expense.view', 'EXPENSES', 'View operating expenses and expense reports'),
          ('expense.manage', 'EXPENSES', 'Record, edit and delete operating expenses'),
          ('refund.view', 'REFUNDS', 'View refunds issued against bills'),
          ('refund.manage', 'REFUNDS', 'Issue, edit and cancel refunds');
      `);

      await dbService.execute(`
        INSERT IGNORE INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        CROSS JOIN permissions p
        WHERE p.code IN ('expense.view', 'expense.manage', 'refund.view', 'refund.manage')
          AND r.name IN ('ADMIN', 'MANAGER');
      `);

      await dbService.execute(`
        INSERT IGNORE INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        CROSS JOIN permissions p
        WHERE p.code = 'refund.view'
          AND r.name = 'CASHIER';
      `);

      const seeded = await dbService.queryOne<{ total: number }>(
        'SELECT COUNT(*) as total FROM expense_categories'
      );
      if (!seeded || Number(seeded.total) === 0) {
        await dbService.execute(`
          INSERT IGNORE INTO expense_categories (name, description, is_fixed_cost, is_system, display_order)
          VALUES
            ('Rent', 'Shop, kitchen and storage rent', 1, 1, 1),
            ('Salaries and Wages', 'Staff payroll, overtime and incentives', 1, 1, 2),
            ('Utilities', 'Electricity, water, gas and internet', 0, 1, 3),
            ('Raw Material', 'Ingredient and grocery purchases', 0, 1, 4),
            ('Packaging', 'Takeaway boxes, bags, cutlery and wrapping', 0, 1, 5),
            ('Maintenance', 'Equipment servicing, plumbing and repairs', 0, 1, 6),
            ('Transport', 'Delivery fuel, vehicle upkeep and freight', 0, 1, 7),
            ('Marketing', 'Advertising, printing and promotions', 0, 1, 8),
            ('Licenses and Fees', 'Trade licence, FSSAI and statutory fees', 1, 1, 9),
            ('Cleaning', 'Housekeeping supplies and pest control', 0, 1, 10),
            ('Miscellaneous', 'Uncategorised operational spend', 0, 1, 99);
        `);
      }

      // Reporting indexes. MySQL has no CREATE INDEX IF NOT EXISTS, so each one
      // is attempted and a duplicate-name failure is the expected no-op.
      const indexes: [string, string, string][] = [
        ['idx_bills_cashier', 'bills', 'cashier_id'],
        ['idx_bills_customer', 'bills', 'customer_id'],
        ['idx_bills_order_type', 'bills', 'order_type'],
        ['idx_bills_payment_status', 'bills', 'payment_status'],
        ['idx_bill_items_bill', 'bill_items', 'bill_id'],
        ['idx_bill_items_product', 'bill_items', 'product_id'],
        ['idx_payments_created', 'payments', 'created_at'],
        ['idx_payments_method', 'payments', 'payment_method'],
        ['idx_order_items_order', 'order_items', 'order_id'],
        ['idx_order_items_product', 'order_items', 'product_id'],

        // The two that matter most. Almost every sales, finance, inventory and
        // BI figure is `bills JOIN bill_items` aggregated over a date window,
        // and on 40k invoices / 100k line items those ran 700-1500ms each.
        //
        // idx_bi_bill_cover carries product_id, quantity and total_amount
        // alongside bill_id, so the join and the SUM/COUNT are answered from
        // the index without touching the row data. idx_bills_live_created puts
        // the two liveness flags ahead of created_at, which is exactly the
        // WHERE every one of those reports builds.
        //
        // Measured together on pos_bench: sales/daily 1124 -> 208ms,
        // sales/employees 666 -> 153ms, categories 1156 -> 408ms.
        ['idx_bi_bill_cover', 'bill_items', 'bill_id, product_id, quantity, total_amount'],
        ['idx_bills_live_created', 'bills', 'is_deleted, is_voided, created_at'],

        // Per-user and per-product aggregates. Staff Track builds a roster by
        // joining six derived tables, each of which aggregates the whole of
        // orders / bills / order_items / order_status_history / audit_logs
        // before joining to a handful of user rows; the BI and finance reports
        // group bill_items by product. Leading each index with the column being
        // grouped on is what lets those aggregates use an index rather than
        // scan. Measured on pos_bench: reports/sales 653 -> 127ms,
        // bi/product-performance 1520 -> 415ms, staff-track/tables 1779 ->
        // 714ms, staff-track/staff 2321 -> 1169ms.
        ['idx_orders_creator_live', 'orders', 'created_by, is_deleted, created_at'],
        ['idx_bills_cashier_live', 'bills', 'cashier_id, is_deleted, created_at'],
        ['idx_oi_order_qty', 'order_items', 'order_id, quantity'],
        ['idx_osh_status_order', 'order_status_history', 'new_status, order_id, created_at'],
        ['idx_audit_user_id', 'audit_logs', 'user_id, id'],
        ['idx_bi_product_cover', 'bill_items', 'product_id, bill_id, quantity, subtotal, discount_amount, total_amount'],
      ];
      for (const [name, table, column] of indexes) {
        try {
          const exists = await dbService.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = ?
               AND INDEX_NAME = ?`,
            [table, name]
          );
          if (!exists || Number(exists.count) === 0) {
            await dbService.execute(`CREATE INDEX ${name} ON ${table}(${column})`);
          }
        } catch (e) {
          logger.warn(`Could not create reporting index ${name} on ${table}:`, e);
        }
      }

      this.ensured = true;
      logger.info('Reporting & BI schema, permissions and indexes verified successfully.');
    } catch (err) {
      logger.error('Failed to ensure reporting schema:', err);
    }
  }
}
