-- ═══════════════════════════════════════════════════════════════════════════
-- Staff Track — migration for an already-seeded system
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run this once against an existing database. A freshly seeded database gets
-- the permission from src/database/seeders.ts instead and needs only PART 2.
--
-- This script adds NO tables and NO columns. Staff Track reads the data the
-- POS already writes — orders.created_by, order_status_history.changed_by,
-- bills.cashier_id, payments.created_by and audit_logs — so there is no new
-- place for order, revenue, table or activity data to drift out of sync.
--
-- PART 1 registers the permission that widens /api/staff-track to the whole
-- roster. It does not gate the module: a signed-in user without it still
-- reaches Staff Track and is scoped by the server to their own attribution.
-- PART 2 adds read indexes only. Both parts are safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- PART 1 — Permission
-- ───────────────────────────────────────────────────────────────────────────

-- The permission that turns Staff Track from "my own figures" into "everyone's".
-- Holding it means a viewer sees every staff member; lacking it means the API
-- pins every query, report and filter list to the caller's own id rather than
-- refusing them. `permissions.code` is UNIQUE, so IGNORE makes a second run a
-- no-op rather than an error.
INSERT IGNORE INTO permissions (code, module, description)
VALUES ('stafftrack.view', 'STAFF_TRACK', 'View staff activity, order and revenue tracking');

-- Grant to ADMIN and MANAGER. role_permissions has a composite primary key,
-- so IGNORE likewise makes re-running harmless.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'stafftrack.view'
  AND r.name IN ('ADMIN', 'MANAGER');

-- To give another role the all-staff view later, add its name to the IN list
-- above and re-run. Revoking does not remove the role's access to Staff Track;
-- it drops that role back to seeing only its own rows. To revoke:
--   DELETE rp FROM role_permissions rp
--   JOIN permissions p ON p.id = rp.permission_id
--   JOIN roles r       ON r.id = rp.role_id
--   WHERE p.code = 'stafftrack.view' AND r.name = 'MANAGER';


-- ───────────────────────────────────────────────────────────────────────────
-- PART 2 — Read indexes (performance only; no data or schema change)
-- ───────────────────────────────────────────────────────────────────────────
--
-- InnoDB already indexes the foreign keys Staff Track attributes through
-- (orders.created_by, bills.cashier_id, order_status_history.changed_by,
-- audit_logs.user_id), so per-staff lookups are covered. What is missing is
-- the date side: every Staff Track screen is bounded by a date range, and
-- audit_logs in particular is scanned by timestamp on each load.
--
-- MySQL has no CREATE INDEX IF NOT EXISTS. Each block below therefore checks
-- information_schema first and builds the ALTER only when the index is absent,
-- so a second run reports "already present" instead of failing on a duplicate
-- key name. This uses only SET / PREPARE / EXECUTE — no stored procedure and no
-- DELIMITER — so it runs identically in phpMyAdmin, the mysql CLI and a driver.

-- Activity History and the Live Activity window both filter audit_logs by
-- timestamp; the composite serves "one staff member's recent activity", which
-- is the shape the staff detail page and live view ask for.
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_created');
SET @s := IF(@x = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_created (created_at)',
                     'SELECT ''idx_audit_created already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_user_created');
SET @s := IF(@x = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_user_created (user_id, created_at)',
                     'SELECT ''idx_audit_user_created already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_module');
SET @s := IF(@x = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_module (module)',
                     'SELECT ''idx_audit_module already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Order and revenue screens are date-bounded before they are grouped by staff.
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = 'idx_orders_created_by_date');
SET @s := IF(@x = 0, 'ALTER TABLE orders ADD INDEX idx_orders_created_by_date (created_by, created_at)',
                     'SELECT ''idx_orders_created_by_date already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'bills' AND index_name = 'idx_bills_cashier_date');
SET @s := IF(@x = 0, 'ALTER TABLE bills ADD INDEX idx_bills_cashier_date (cashier_id, created_at)',
                     'SELECT ''idx_bills_cashier_date already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Order duration and average service time read the COMPLETED transition.
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'order_status_history' AND index_name = 'idx_osh_order_status');
SET @s := IF(@x = 0, 'ALTER TABLE order_status_history ADD INDEX idx_osh_order_status (order_id, new_status)',
                     'SELECT ''idx_osh_order_status already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ───────────────────────────────────────────────────────────────────────────
-- Verification
-- ───────────────────────────────────────────────────────────────────────────

SELECT r.name AS role_name, p.code AS permission
FROM role_permissions rp
JOIN roles r       ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE p.code = 'stafftrack.view'
ORDER BY r.name;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 3 — Dish Variants & Stock Architecture
-- ───────────────────────────────────────────────────────────────────────────

-- Add dish variant stock columns to products if absent
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'stock_item_id');
SET @s := IF(@col = 0, 'ALTER TABLE products ADD COLUMN stock_item_id INT NULL AFTER low_stock_threshold', 'SELECT ''products.stock_item_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'variant_stock_mode');
SET @s := IF(@col = 0, 'ALTER TABLE products ADD COLUMN variant_stock_mode ENUM(\'COMMON\', \'EACH\') NOT NULL DEFAULT \'COMMON\' AFTER stock_item_id', 'SELECT ''products.variant_stock_mode already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Dish Variants table (portion sizes: Full / Half / Quarter / Family Platter)
CREATE TABLE IF NOT EXISTS product_variants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  stock_item_id INT NULL,
  selling_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  display_order INT DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_variant_name_per_product (product_id, name),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add variant tracking columns to order_items
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'variant_id');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN variant_id INT NULL AFTER product_name', 'SELECT ''order_items.variant_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'variant_name');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN variant_name VARCHAR(80) NULL AFTER variant_id', 'SELECT ''order_items.variant_name already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'stock_consumption');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER variant_name', 'SELECT ''order_items.stock_consumption already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Add variant tracking columns to bill_items
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'variant_id');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN variant_id INT NULL AFTER product_name', 'SELECT ''bill_items.variant_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'variant_name');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN variant_name VARCHAR(80) NULL AFTER variant_id', 'SELECT ''bill_items.variant_name already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'stock_consumption');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER variant_name', 'SELECT ''bill_items.stock_consumption already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 4 — Vendor Management Suite
-- ───────────────────────────────────────────────────────────────────────────

-- 1. Vendors Master Table
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
  tax_category VARCHAR(50) DEFAULT 'STANDARD',
  msme_number VARCHAR(50) NULL,

  payment_terms VARCHAR(50) DEFAULT 'NET_30',
  preferred_payment_method VARCHAR(50) DEFAULT 'BANK_TRANSFER',
  bank_name VARCHAR(100) NULL,
  account_number VARCHAR(50) NULL,
  ifsc_code VARCHAR(50) NULL,
  branch_name VARCHAR(100) NULL,
  upi_id VARCHAR(100) NULL,

  credit_limit DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  credit_period_days INT NOT NULL DEFAULT 30,
  outstanding_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  total_purchases_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  total_purchases_count INT NOT NULL DEFAULT 0,
  last_purchase_date DATETIME NULL,
  last_payment_date DATETIME NULL,

  rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  delivery_speed_rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  quality_rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  pricing_rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  on_time_delivery_rate DECIMAL(5, 2) NOT NULL DEFAULT 100.00,
  quality_score DECIMAL(5, 2) NOT NULL DEFAULT 100.00,
  fulfillment_rate DECIMAL(5, 2) NOT NULL DEFAULT 100.00,
  performance_notes TEXT NULL,

  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vendors_code (vendor_code),
  INDEX idx_vendors_name (name),
  INDEX idx_vendors_category (category),
  INDEX idx_vendors_status (status),
  INDEX idx_vendors_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Vendor Purchases (Invoices Ledger)
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

-- 3. Vendor Payments (Disbursements Ledger)
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

-- 4. Vendor Permissions
INSERT IGNORE INTO permissions (code, module, description)
VALUES 
  ('vendor.view', 'VENDORS', 'View vendor list, profiles, ratings and purchase records'),
  ('vendor.manage', 'VENDORS', 'Create, edit, delete vendors and record purchases and payments');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('vendor.view', 'vendor.manage')
  AND r.name IN ('ADMIN', 'MANAGER');


-- ───────────────────────────────────────────────────────────────────────────
-- PART 5 — Dine-In & Table Management Suite
-- ───────────────────────────────────────────────────────────────────────────

-- Expand table status column to VARCHAR(30) so all operational statuses are supported:
-- AVAILABLE, OCCUPIED, RESERVED, CLEANING, UNAVAILABLE
ALTER TABLE dining_tables MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE';

-- Add active guest count and timers to dining_tables
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dining_tables' AND column_name = 'active_guest_count');
SET @s := IF(@col = 0, 'ALTER TABLE dining_tables ADD COLUMN active_guest_count INT NOT NULL DEFAULT 0 AFTER capacity', 'SELECT ''dining_tables.active_guest_count already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dining_tables' AND column_name = 'seated_at');
SET @s := IF(@col = 0, 'ALTER TABLE dining_tables ADD COLUMN seated_at DATETIME NULL AFTER current_order_id', 'SELECT ''dining_tables.seated_at already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dining_tables' AND column_name = 'cleaning_started_at');
SET @s := IF(@col = 0, 'ALTER TABLE dining_tables ADD COLUMN cleaning_started_at DATETIME NULL AFTER seated_at', 'SELECT ''dining_tables.cleaning_started_at already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dining_tables' AND column_name = 'reservation_id');
SET @s := IF(@col = 0, 'ALTER TABLE dining_tables ADD COLUMN reservation_id INT NULL AFTER cleaning_started_at', 'SELECT ''dining_tables.reservation_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Table Reservations
CREATE TABLE IF NOT EXISTS table_reservations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  reservation_code VARCHAR(50) NOT NULL UNIQUE,
  table_id INT NULL,
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  guest_count INT NOT NULL DEFAULT 2,
  reservation_time DATETIME NOT NULL,
  preferred_section VARCHAR(50) NULL,
  special_requests TEXT NULL,
  status ENUM('CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'CONFIRMED',
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tr_time (reservation_time),
  INDEX idx_tr_table (table_id),
  INDEX idx_tr_status (status),
  FOREIGN KEY (table_id) REFERENCES dining_tables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Waiting List & Queue Tokens
CREATE TABLE IF NOT EXISTS table_waitlist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  token_number VARCHAR(50) NOT NULL,
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(30) NULL,
  guest_count INT NOT NULL DEFAULT 2,
  preferred_section VARCHAR(50) NULL,
  estimated_wait_minutes INT NOT NULL DEFAULT 15,
  status ENUM('WAITING', 'NOTIFIED', 'SEATED', 'CANCELLED') NOT NULL DEFAULT 'WAITING',
  assigned_table_id INT NULL,
  seated_at DATETIME NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_wl_status (status),
  INDEX idx_wl_created (created_at),
  FOREIGN KEY (assigned_table_id) REFERENCES dining_tables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 6 — Customer CRM, Analytics & Notes Suite
-- ───────────────────────────────────────────────────────────────────────────

-- Add customer CRM columns to customers
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'customer_code');
SET @s := IF(@col = 0, 'ALTER TABLE customers ADD COLUMN customer_code VARCHAR(50) NULL AFTER id', 'SELECT ''customers.customer_code already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'tier');
SET @s := IF(@col = 0, 'ALTER TABLE customers ADD COLUMN tier VARCHAR(30) NOT NULL DEFAULT \'REGULAR\' AFTER status', 'SELECT ''customers.tier already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'loyalty_points');
SET @s := IF(@col = 0, 'ALTER TABLE customers ADD COLUMN loyalty_points INT NOT NULL DEFAULT 0 AFTER tier', 'SELECT ''customers.loyalty_points already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'last_visit_at');
SET @s := IF(@col = 0, 'ALTER TABLE customers ADD COLUMN last_visit_at DATETIME NULL AFTER loyalty_points', 'SELECT ''customers.last_visit_at already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Customer Notes table
CREATE TABLE IF NOT EXISTS customer_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  user_id INT NULL,
  author_name VARCHAR(100) NULL,
  note_type VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
  note_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cust_notes_cid (customer_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill customer codes for existing records
UPDATE customers 
SET customer_code = CONCAT('CUST-', LPAD(id, 4, '0')) 
WHERE customer_code IS NULL OR customer_code = '';

-- Backfill VIP tier for high-spending customers
UPDATE customers 
SET tier = 'VIP' 
WHERE total_spent >= 5000 AND (tier IS NULL OR tier = 'REGULAR');


-- ───────────────────────────────────────────────────────────────────────────
-- PART 7 — POS Operations, Advanced Billing, Void/Reopen, Offline POS & Day Closing
-- ───────────────────────────────────────────────────────────────────────────

-- 1. Extend Order Types and Payment Methods
-- Allows: WALK_IN, TAKEAWAY, DINING, PICKUP, COUNTER
ALTER TABLE orders MODIFY COLUMN order_type VARCHAR(30) NOT NULL;
ALTER TABLE draft_bills MODIFY COLUMN order_type VARCHAR(30) NOT NULL DEFAULT 'WALK_IN';
ALTER TABLE bills MODIFY COLUMN order_type VARCHAR(30) NOT NULL;
ALTER TABLE bills MODIFY COLUMN payment_method VARCHAR(30) NOT NULL;
ALTER TABLE bills MODIFY COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID';

-- 2. Add Billing, Service Charge, Surcharge, Coupons, Void, Reopen, and Offline Sync columns to bills
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'service_charge_amount');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN service_charge_amount DECIMAL(10,2) DEFAULT 0.00 AFTER tax_amount', 'SELECT ''bills.service_charge_amount already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'surcharge_amount');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN surcharge_amount DECIMAL(10,2) DEFAULT 0.00 AFTER service_charge_amount', 'SELECT ''bills.surcharge_amount already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'coupon_code');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN coupon_code VARCHAR(50) NULL AFTER surcharge_amount', 'SELECT ''bills.coupon_code already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'coupon_discount');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN coupon_discount DECIMAL(10,2) DEFAULT 0.00 AFTER coupon_code', 'SELECT ''bills.coupon_discount already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'cash_tendered');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN cash_tendered DECIMAL(10,2) NULL AFTER payment_method', 'SELECT ''bills.cash_tendered already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'change_returned');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN change_returned DECIMAL(10,2) NULL AFTER cash_tendered', 'SELECT ''bills.change_returned already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'payment_reference');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN payment_reference VARCHAR(100) NULL AFTER change_returned', 'SELECT ''bills.payment_reference already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'is_voided');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN is_voided BOOLEAN DEFAULT FALSE AFTER notes', 'SELECT ''bills.is_voided already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'void_reason');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN void_reason TEXT NULL AFTER is_voided', 'SELECT ''bills.void_reason already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'void_by');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN void_by INT NULL AFTER void_reason', 'SELECT ''bills.void_by already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'void_at');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN void_at DATETIME NULL AFTER void_by', 'SELECT ''bills.void_at already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'is_reopened');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN is_reopened BOOLEAN DEFAULT FALSE AFTER void_at', 'SELECT ''bills.is_reopened already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'reopened_from_bill_id');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN reopened_from_bill_id INT NULL AFTER is_reopened', 'SELECT ''bills.reopened_from_bill_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'reopened_at');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN reopened_at DATETIME NULL AFTER reopened_from_bill_id', 'SELECT ''bills.reopened_at already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bills' AND column_name = 'offline_sync_id');
SET @s := IF(@col = 0, 'ALTER TABLE bills ADD COLUMN offline_sync_id VARCHAR(100) NULL AFTER reopened_at', 'SELECT ''bills.offline_sync_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. Add Complimentary items tracking to bill_items
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'is_complimentary');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN is_complimentary BOOLEAN DEFAULT FALSE AFTER tax_amount', 'SELECT ''bill_items.is_complimentary already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'complimentary_reason');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN complimentary_reason VARCHAR(255) NULL AFTER is_complimentary', 'SELECT ''bill_items.complimentary_reason already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 4. Create POS Day Closing (Z-Report / Shift Close) table
CREATE TABLE IF NOT EXISTS pos_day_closings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  closing_number VARCHAR(50) UNIQUE NOT NULL,
  user_id INT NOT NULL,
  cashier_name VARCHAR(100) NULL,
  opening_time DATETIME NOT NULL,
  closing_time DATETIME NOT NULL,
  opening_cash DECIMAL(10,2) DEFAULT 0.00,
  total_cash_sales DECIMAL(10,2) DEFAULT 0.00,
  total_card_sales DECIMAL(10,2) DEFAULT 0.00,
  total_upi_sales DECIMAL(10,2) DEFAULT 0.00,
  total_online_sales DECIMAL(10,2) DEFAULT 0.00,
  gross_sales DECIMAL(10,2) DEFAULT 0.00,
  total_discounts DECIMAL(10,2) DEFAULT 0.00,
  total_tax DECIMAL(10,2) DEFAULT 0.00,
  total_service_charges DECIMAL(10,2) DEFAULT 0.00,
  total_bills_count INT DEFAULT 0,
  void_bills_count INT DEFAULT 0,
  void_bills_amount DECIMAL(10,2) DEFAULT 0.00,
  expected_cash DECIMAL(10,2) DEFAULT 0.00,
  actual_cash DECIMAL(10,2) DEFAULT 0.00,
  cash_variance DECIMAL(10,2) DEFAULT 0.00,
  notes TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_day_closing_user (user_id),
  INDEX idx_day_closing_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Additional Performance Indexes
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'bills' AND index_name = 'idx_bills_offline_sync');
SET @s := IF(@x = 0, 'ALTER TABLE bills ADD INDEX idx_bills_offline_sync (offline_sync_id)',
                     'SELECT ''idx_bills_offline_sync already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'bills' AND index_name = 'idx_bills_voided');
SET @s := IF(@x = 0, 'ALTER TABLE bills ADD INDEX idx_bills_voided (is_voided)',
                     'SELECT ''idx_bills_voided already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 9 — Product Add-ons, Combo Meals & Meal Deals Suite
-- ───────────────────────────────────────────────────────────────────────────

-- 1. Product Add-ons Catalog
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

-- 2. Add-on Mappings (Product, Category, or Global)
CREATE TABLE IF NOT EXISTS product_addon_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  addon_id INT NOT NULL,
  product_id INT NULL,
  category_id INT NULL,
  is_global BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pam_addon (addon_id),
  INDEX idx_pam_product (product_id),
  INDEX idx_pam_category (category_id),
  FOREIGN KEY (addon_id) REFERENCES product_addons(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Combo Meals
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

-- 4. Combo Meal Items
CREATE TABLE IF NOT EXISTS combo_meal_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  combo_id INT NOT NULL,
  product_id INT NOT NULL,
  variant_id INT NULL,
  quantity INT NOT NULL DEFAULT 1,
  display_order INT DEFAULT 0,
  INDEX idx_cmi_combo (combo_id),
  INDEX idx_cmi_product (product_id),
  FOREIGN KEY (combo_id) REFERENCES combo_meals(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Meal Deals (Promotional & Time-Sensitive Packages)
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

-- 6. Meal Deal Items
CREATE TABLE IF NOT EXISTS meal_deal_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  deal_id INT NOT NULL,
  product_id INT NOT NULL,
  variant_id INT NULL,
  quantity INT NOT NULL DEFAULT 1,
  notes VARCHAR(255) NULL,
  INDEX idx_mdi_deal (deal_id),
  INDEX idx_mdi_product (product_id),
  FOREIGN KEY (deal_id) REFERENCES meal_deals(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Add columns to order_items and bill_items for Add-ons, Combos, and Deals
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'addons_data');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN addons_data TEXT NULL AFTER notes', 'SELECT ''order_items.addons_data already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'item_type');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN item_type VARCHAR(30) DEFAULT \'PRODUCT\' AFTER addons_data', 'SELECT ''order_items.item_type already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'combo_id');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN combo_id INT NULL AFTER item_type', 'SELECT ''order_items.combo_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'deal_id');
SET @s := IF(@col = 0, 'ALTER TABLE order_items ADD COLUMN deal_id INT NULL AFTER combo_id', 'SELECT ''order_items.deal_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'addons_data');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN addons_data TEXT NULL AFTER complimentary_reason', 'SELECT ''bill_items.addons_data already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'item_type');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN item_type VARCHAR(30) DEFAULT \'PRODUCT\' AFTER addons_data', 'SELECT ''bill_items.item_type already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'combo_id');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN combo_id INT NULL AFTER item_type', 'SELECT ''bill_items.combo_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bill_items' AND column_name = 'deal_id');
SET @s := IF(@col = 0, 'ALTER TABLE bill_items ADD COLUMN deal_id INT NULL AFTER combo_id', 'SELECT ''bill_items.deal_id already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 10 — Inventory Alerts Suite & Expiry Tracking
-- ───────────────────────────────────────────────────────────────────────────

-- 1. Extend stock_items with Reorder Level, Reorder Qty, and Overstock Thresholds
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_items' AND column_name = 'reorder_level');
SET @s := IF(@col = 0, 'ALTER TABLE stock_items ADD COLUMN reorder_level DECIMAL(12,3) NOT NULL DEFAULT 15.000 AFTER min_stock_alert', 'SELECT ''stock_items.reorder_level already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_items' AND column_name = 'reorder_quantity');
SET @s := IF(@col = 0, 'ALTER TABLE stock_items ADD COLUMN reorder_quantity DECIMAL(12,3) NOT NULL DEFAULT 50.000 AFTER reorder_level', 'SELECT ''stock_items.reorder_quantity already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_items' AND column_name = 'max_stock_threshold');
SET @s := IF(@col = 0, 'ALTER TABLE stock_items ADD COLUMN max_stock_threshold DECIMAL(12,3) NOT NULL DEFAULT 100.000 AFTER reorder_quantity', 'SELECT ''stock_items.max_stock_threshold already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_items' AND column_name = 'shelf_life_days');
SET @s := IF(@col = 0, 'ALTER TABLE stock_items ADD COLUMN shelf_life_days INT NULL AFTER max_stock_threshold', 'SELECT ''stock_items.shelf_life_days already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. Extend stock_entries with Expiry Date and Batch Number
SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_entries' AND column_name = 'expiry_date');
SET @s := IF(@col = 0, 'ALTER TABLE stock_entries ADD COLUMN expiry_date DATE NULL AFTER entry_date', 'SELECT ''stock_entries.expiry_date already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_entries' AND column_name = 'batch_number');
SET @s := IF(@col = 0, 'ALTER TABLE stock_entries ADD COLUMN batch_number VARCHAR(100) NULL AFTER expiry_date', 'SELECT ''stock_entries.batch_number already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. Indexes for Inventory Alerts
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'stock_entries' AND index_name = 'idx_stock_entries_expiry');
SET @s := IF(@x = 0, 'ALTER TABLE stock_entries ADD INDEX idx_stock_entries_expiry (expiry_date)',
                     'SELECT ''idx_stock_entries_expiry already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'stock_items' AND index_name = 'idx_stock_items_reorder');
SET @s := IF(@x = 0, 'ALTER TABLE stock_items ADD INDEX idx_stock_items_reorder (reorder_level, current_quantity)',
                     'SELECT ''idx_stock_items_reorder already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 11 — Sample Seed Data for Add-ons, Combos & Deals
-- ───────────────────────────────────────────────────────────────────────────

-- Add-ons Seeds
INSERT IGNORE INTO product_addons (id, name, category, price, cost_price, is_available, status) VALUES
(1, 'Extra Spicy Daqoos Sauce', 'Sauces', 3.00, 1.00, 1, 'ACTIVE'),
(2, 'Creamy Garlic Tahini Dip', 'Sauces', 4.00, 1.50, 1, 'ACTIVE'),
(3, 'Crispy Fried Caramelized Onions', 'Toppings', 4.00, 1.20, 1, 'ACTIVE'),
(4, 'Golden Roasted Almonds & Raisins', 'Toppings', 8.00, 3.50, 1, 'ACTIVE'),
(5, 'Extra Traditional Shurba (Soup Bowl)', 'Sides', 6.00, 2.00, 1, 'ACTIVE'),
(6, 'Extra Fragrant Mandi Rice Portion', 'Sides', 15.00, 5.00, 1, 'ACTIVE'),
(7, 'Melted Cheddar Cheese Drizzle', 'Toppings', 5.00, 2.00, 1, 'ACTIVE'),
(8, 'Chilled Ayran Laban Bottle (330ml)', 'Beverages', 6.00, 2.50, 1, 'ACTIVE');

-- Global Add-on Mappings (Available across Mandi dishes)
INSERT IGNORE INTO product_addon_mappings (id, addon_id, is_global) VALUES
(1, 1, 1),
(2, 2, 1),
(3, 3, 1),
(4, 4, 1),
(5, 5, 1),
(6, 6, 1),
(7, 7, 1),
(8, 8, 1);

-- Combo Meals Seeds
INSERT IGNORE INTO combo_meals (id, combo_code, name, description, original_price, combo_price, savings_amount, is_available, status) VALUES
(1, 'CMB-ROYAL-DUO', 'Royal Mandi Duo Combo', '1 Half Mutton Mandi + 1 Half Chicken Mandi + 2 Daqoos + 2 Ayran Laban Bottles', 134.00, 115.00, 19.00, 1, 'ACTIVE'),
(2, 'CMB-CHARCOAL-SOLO', 'Single Charcoal Grill Meal', '1 Half Chicken Madhbi + Fresh Garden Salad + 1 Daqoos + Arabic Red Tea Pot', 58.00, 49.00, 9.00, 1, 'ACTIVE');

-- Meal Deals Seeds
INSERT IGNORE INTO meal_deals (id, deal_code, title, badge_text, description, original_price, deal_price, savings_amount, days_of_week, start_time, end_time, is_active) VALUES
(1, 'DEAL-FAMILY-FEAST', 'Royal Family Weekend Feast', 'FAMILY PACK', '2 Full Royal Mutton Mandis + 4 Shurba Soups + 1 Kunafa Plate + 4 Ayran Labans', 380.00, 329.00, 51.00, 'FRI,SAT,SUN', '12:00', '23:30', 1),
(2, 'DEAL-LUNCH-EXPRESS', 'Executive Lunch Express Deal', 'LUNCH SPECIAL', '1 Half Chicken Mandi + 1 Fresh Salad + 1 Daqoos + 1 Mint Lemonade Juice', 62.00, 45.00, 17.00, 'SUN,MON,TUE,WED,THU', '11:30', '16:30', 1);


-- ───────────────────────────────────────────────────────────────────────────
-- PART 12 — System Settings: Printer, Notification & Invoice
-- ───────────────────────────────────────────────────────────────────────────
--
-- Three new tabs on the System Settings screen — Printer Settings,
-- Notification Settings and Invoice Settings. This part adds NO tables and NO
-- columns: each tab persists exactly one row in the existing `settings` table,
-- the same way `system_theme`, `system_toast`, `system_hardware` and the
-- per-page design rows already do.
--
-- `settings.category` is an ENUM('GENERAL','TAX','RECEIPT','POS','THEME') and
-- every value used below is already a member, so the column needs no ALTER.
-- The API classifies these rows the same way on write:
--   system_printer      -> RECEIPT
--   system_invoice      -> RECEIPT
--   system_notification -> POS
--
-- Do NOT add flat PRINTER_% / NOTIFY_% / INVOICE_% rows. The API derives those
-- keys in memory by unpacking the JSON below, and a stored flat row would be a
-- second copy that silently drifts once the tab is saved.
--
-- `settings.key` is UNIQUE, so INSERT IGNORE makes this re-runnable and — more
-- importantly — never overwrites a site that has already saved these tabs. The
-- values are only the factory defaults a terminal shows before its first save.

-- Printer Settings — the three print stations, the device connection and what
-- the paper and drawer do once a job finishes.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
('system_printer',
 '{"receiptEnabled":"true","receiptName":"Cashier Thermal Receipt Printer","receiptPaperWidth":"80mm","receiptAutoPrint":"true","receiptCopies":"1","kitchenEnabled":"true","kitchenName":"Kitchen Order Ticket (KOT) Printer","kitchenPaperWidth":"80mm","kitchenAutoPrint":"true","kitchenCopies":"1","barEnabled":"false","barName":"Bar Beverage Printer","barPaperWidth":"80mm","barAutoPrint":"false","barCopies":"1","connection":"usb","deviceIp":"","devicePort":"9100","charset":"CP437","density":"normal","autoCut":"true","cashDrawer":"true","buzzer":"false","feedLines":"3"}',
 'RECEIPT',
 'Print stations, device connection & paper behaviour stored as JSON',
 0);

-- Notification Settings — which floor events raise an alert, the channels that
-- carry it, and when the system is allowed to make a noise.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
('system_notification',
 '{"newOrder":"true","orderReady":"true","billVoided":"true","lowStock":"true","lowStockThreshold":"5","dayClose":"true","channelInApp":"true","channelDesktop":"false","channelEmail":"false","emailRecipients":"","channelSms":"false","smsRecipients":"","sound":"true","soundTone":"chime","quietStart":"","quietEnd":"","dailySummary":"false","dailySummaryTime":"23:30"}',
 'POS',
 'Operational alert triggers, channels & quiet hours stored as JSON',
 0);

-- Invoice Settings — the numbering series, the document format and the
-- optional blocks printed beside the line items.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
('system_invoice',
 '{"prefix":"INV-","nextNumber":"1","padLength":"4","resetCycle":"yearly","title":"TAX INVOICE","paperSize":"A4","dateFormat":"dd/MM/yyyy","decimals":"2","currencyPosition":"prefix","showLogo":"true","showTaxBreakdown":"true","showQr":"false","upiId":"","showSignature":"true","signatory":"Authorised Signatory","dueDays":"0","terms":"Goods once sold will not be taken back or exchanged.","footerNote":"Thank you for your business."}',
 'RECEIPT',
 'Invoice numbering, document format & printed blocks stored as JSON',
 0);

-- Belt and braces. The API already writes these categories and repairs a
-- mismatched one on its next read, so on a healthy database both statements
-- match zero rows. They are here for the case where a row was inserted by hand
-- or by an older build, so that anyone querying the table directly — rather
-- than through the API — sees it filed correctly. Safe to re-run.
UPDATE settings SET category = 'RECEIPT'
 WHERE `key` IN ('system_printer', 'system_invoice') AND category <> 'RECEIPT';

UPDATE settings SET category = 'POS'
 WHERE `key` = 'system_notification' AND category <> 'POS';

-- Verify: three rows, each holding one JSON document.
SELECT `key`, category, CHAR_LENGTH(`value`) AS json_length, updated_at
FROM settings
WHERE `key` IN ('system_printer', 'system_notification', 'system_invoice')
ORDER BY `key`;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 13 — Diagnostics & Verification Summary
-- ───────────────────────────────────────────────────────────────────────────

SELECT 'Migration complete! Summary of verified tables:' AS status;

SELECT table_name, table_rows, engine 
FROM information_schema.tables 
WHERE table_schema = DATABASE() 
  AND table_name IN (
    'vendors', 'vendor_purchases', 'vendor_payments',
    'dining_tables', 'table_reservations', 'table_waitlist',
    'customers', 'customer_notes',
    'orders', 'order_items', 'draft_bills', 'bills', 'bill_items',
    'product_variants', 'pos_day_closings',
    'product_addons', 'product_addon_mappings', 'combo_meals', 'combo_meal_items', 'meal_deals', 'meal_deal_items'
  )
ORDER BY table_name;


