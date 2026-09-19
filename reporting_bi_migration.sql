-- ===========================================================================
-- Reporting & Business Intelligence -- Schema, Permissions & Seed Data
-- Mandi POS
-- ===========================================================================
--
-- The reporting suite reads almost entirely from tables that already exist
-- (bills, bill_items, orders, payments, stock_*, customers, vendor_*). Two of
-- the requested reports had no source of truth at all, so this script adds it:
--
-- 1. expense_categories + expenses -- operating spend, without which the
--    Expenses and Profit reports can only ever show gross margin.
-- 2. refunds + refund_items -- money returned to customers. bills only carried
--    payment_status = 'REFUNDED', a flag with no amount, reason or line detail,
--    so partial refunds were invisible and net revenue overstated.
-- 3. Permissions expense.view / expense.manage and refund.view / refund.manage.
-- 4. Reporting indexes on the columns every report groups and filters by.
--
-- Idempotent except for PART 4: re-running the CREATE INDEX statements reports
-- duplicate key names, which is harmless. The same DDL is applied at runtime by
-- src/modules/reports/reports.schema.ts, so a fresh install needs no manual run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PART 1: EXPENSES
-- ---------------------------------------------------------------------------

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

-- category is denormalised onto the row on purpose: an expense report run a
-- year later must still show the label the spend was booked under, even if the
-- category has since been renamed or retired.
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

INSERT IGNORE INTO expense_categories (name, description, is_fixed_cost, is_system, display_order) VALUES
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

-- ---------------------------------------------------------------------------
-- PART 2: REFUNDS
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- PART 3: PERMISSIONS
-- ---------------------------------------------------------------------------

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('expense.view', 'EXPENSES', 'View operating expenses and expense reports'),
  ('expense.manage', 'EXPENSES', 'Record, edit and delete operating expenses'),
  ('refund.view', 'REFUNDS', 'View refunds issued against bills'),
  ('refund.manage', 'REFUNDS', 'Issue, edit and cancel refunds');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('expense.view', 'expense.manage', 'refund.view', 'refund.manage')
  AND r.name IN ('ADMIN', 'MANAGER');

-- Cashiers can see refunds raised against bills but not issue or edit them.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'refund.view'
  AND r.name = 'CASHIER';

-- ---------------------------------------------------------------------------
-- PART 4: REPORTING INDEXES
-- ---------------------------------------------------------------------------
--
-- Every report groups by date and joins bill_items to bills and products; these
-- are the access paths those queries take.

CREATE INDEX idx_bills_cashier ON bills(cashier_id);
CREATE INDEX idx_bills_customer ON bills(customer_id);
CREATE INDEX idx_bills_order_type ON bills(order_type);
CREATE INDEX idx_bills_payment_status ON bills(payment_status);
CREATE INDEX idx_bill_items_bill ON bill_items(bill_id);
CREATE INDEX idx_bill_items_product ON bill_items(product_id);
CREATE INDEX idx_payments_created ON payments(created_at);
CREATE INDEX idx_payments_method ON payments(payment_method);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);
