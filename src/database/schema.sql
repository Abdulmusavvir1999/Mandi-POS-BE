-- ═══════════════════════════════════════════════════════════════════════════
-- Project X POS — Complete MySQL Schema
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every table, column and index the system uses, in its CURRENT shape. This is
-- the fresh-install schema: the base tables from src/database/mysql_migrator.ts
-- with every later migration already folded in, so a database built from this
-- file is identical to one built from the migrator and then brought forward by
-- `for_existing system.sql`.
--
-- Run this first, then seeders.sql.
--
--   mysql -h <host> -u <user> -p <database> < schema.sql
--   mysql -h <host> -u <user> -p <database> < seeders.sql
--
-- Every statement is CREATE TABLE IF NOT EXISTS, so the file is safe to re-run.
-- It creates nothing destructively and drops nothing: pointing it at a live
-- database adds what is missing and leaves everything else untouched.
--
-- IMPORTANT — it does not ALTER existing tables. On a database that predates a
-- column, run `for_existing system.sql`, which adds columns in place. This file
-- is for new databases; that one is for databases already carrying data.
--
-- Engine/charset is InnoDB + utf8mb4 throughout, so the currency symbols and
-- Arabic dish names in the seed data survive a round trip.
-- ═══════════════════════════════════════════════════════════════════════════

SET FOREIGN_KEY_CHECKS = 0;


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Identity & Access
-- ───────────────────────────────────────────────────────────────────────────

-- Seeded roles carry is_system = 1 and are excluded from the manual role limit
-- enforced in roles.controller.ts.
CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255),
  is_system TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) NOT NULL UNIQUE,
  module VARCHAR(50) NOT NULL,
  description VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT NOT NULL,
  permission_id INT NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  -- Second lock in front of /admin/back-office, deliberately separate from the
  -- login credential above. bcrypt hash; NULL = not configured yet.
  -- See back_office_password_migration.sql.
  back_office_password VARCHAR(255) NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  image_url VARCHAR(255),
  -- NULL identifies the super administrator: the one account with no role.
  -- See back_office_password_migration.sql and core/utils/role.util.ts.
  role_id INT NULL,
  status ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') DEFAULT 'ACTIVE',
  last_login_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Catalog
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  image_url VARCHAR(255),
  display_order INT DEFAULT 0,
  status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- variant_stock_mode decides whether every portion draws down one shared stock
-- item (COMMON) or each variant keeps its own (EACH).
CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT NOT NULL,
  name VARCHAR(150) NOT NULL,
  sku VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  image_url VARCHAR(255),
  tax_rate DECIMAL(5,2) DEFAULT 5.00,
  stock_quantity INT DEFAULT 0,
  low_stock_threshold INT DEFAULT 10,
  stock_item_id INT NULL,
  variant_stock_mode ENUM('COMMON', 'EACH') NOT NULL DEFAULT 'COMMON',
  is_available TINYINT(1) DEFAULT 1,
  status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Portion sizes (Full / Half / Quarter). Each carries its own price and the
-- amount of the linked stock item one sale of it consumes.
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


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 3 — Inventory
-- ───────────────────────────────────────────────────────────────────────────

-- The stock master. reorder_level / reorder_quantity / max_stock_threshold and
-- shelf_life_days drive the inventory alert screens.
CREATE TABLE IF NOT EXISTS stock_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL UNIQUE,
  stock_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  unit_type VARCHAR(50) NOT NULL DEFAULT 'piece',
  current_quantity DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  current_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  average_unit_price DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  min_stock_alert DECIMAL(12,3) NOT NULL DEFAULT 10.000,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stock_items_code (stock_code),
  INDEX idx_stock_items_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Purchase / addition ledger. expiry_date and batch_number support the expiry
-- tracking screens.
CREATE TABLE IF NOT EXISTS stock_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL UNIQUE,
  stock_item_id INT NOT NULL,
  entry_number VARCHAR(50) NOT NULL UNIQUE,
  entry_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiry_date DATE NULL,
  batch_number VARCHAR(100) NULL,
  quantity DECIMAL(12,3) NOT NULL,
  multiplier DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  total_quantity DECIMAL(12,3) NOT NULL,
  total_price DECIMAL(14,2) NOT NULL,
  unit_price DECIMAL(14,4) NOT NULL,
  status ENUM('draft', 'posted', 'cancelled') NOT NULL DEFAULT 'posted',
  supplier VARCHAR(150) NULL,
  vendor_id INT NULL,
  invoice_number VARCHAR(100) NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_stock_entries_item (stock_item_id),
  INDEX idx_stock_entries_number (entry_number),
  INDEX idx_stock_entries_date (entry_date),
  INDEX idx_stock_entries_expiry (expiry_date),
  INDEX idx_stock_entries_vendor (vendor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only history. balance_quantity / balance_value are the running totals
-- after the movement, so a ledger can be rebuilt without replaying arithmetic.
CREATE TABLE IF NOT EXISTS stock_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL UNIQUE,
  stock_item_id INT NOT NULL,
  movement_type ENUM('in', 'out', 'adjustment', 'return', 'wastage', 'transfer_in', 'transfer_out') NOT NULL,
  reference_type VARCHAR(50) NOT NULL,
  reference_id VARCHAR(100) NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_price DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  total_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  balance_quantity DECIMAL(12,3) NOT NULL,
  balance_value DECIMAL(14,2) NOT NULL,
  movement_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_stock_movements_item (stock_item_id),
  INDEX idx_stock_movements_type (movement_type),
  INDEX idx_stock_movements_date (movement_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy per-product stock counters, kept for backward compatibility. New work
-- belongs in stock_items / stock_entries / stock_movements above.
CREATE TABLE IF NOT EXISTS stock (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL UNIQUE,
  current_stock INT NOT NULL DEFAULT 0,
  reserved_stock INT NOT NULL DEFAULT 0,
  min_stock_alert INT DEFAULT 10,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  transaction_type ENUM('STOCK_IN', 'SALE', 'ADJUSTMENT', 'RETURN') NOT NULL,
  quantity INT NOT NULL,
  previous_stock INT NOT NULL,
  new_stock INT NOT NULL,
  reference_id VARCHAR(100),
  reference_type VARCHAR(50),
  notes TEXT,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  adjustment_type ENUM('INCREASE', 'DECREASE') NOT NULL,
  quantity INT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  approved_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 4 — Customers & CRM
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_code VARCHAR(50) NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  email VARCHAR(100),
  address TEXT,
  image_url VARCHAR(255),
  status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  loyalty_points INT NOT NULL DEFAULT 0,
  last_visit_at DATETIME NULL,
  total_visits INT DEFAULT 0,
  total_spent DECIMAL(10,2) DEFAULT 0.00,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- author_name is denormalised so a note keeps its attribution after the staff
-- member who wrote it is removed.
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


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 5 — Dining Room
-- ───────────────────────────────────────────────────────────────────────────

-- status is VARCHAR rather than ENUM: the dining suite added states (CLEANING,
-- RESERVED, BLOCKED) after the table shipped, and a VARCHAR takes a new one
-- without an ALTER on every deployment.
CREATE TABLE IF NOT EXISTS dining_tables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  table_number VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  section VARCHAR(50) DEFAULT 'Main Hall',
  capacity INT DEFAULT 4,
  active_guest_count INT NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
  current_order_id INT NULL,
  seated_at DATETIME NULL,
  cleaning_started_at DATETIME NULL,
  reservation_id INT NULL,
  display_order INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 6 — Orders
-- ───────────────────────────────────────────────────────────────────────────

-- order_type holds one of two values, DINING or TAKEAWAY. It stays
-- VARCHAR(30) rather than an ENUM so the set can change again without a
-- table rewrite - it already has once, when walk-in, pickup and counter
-- were folded into TAKEAWAY. See section 15 of "for_existing system.sql"
-- for the migration that folds them in an already-deployed database.
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- What a withdrawn document gave up: its id and the number it held,
  -- captured at the moment the number is released to NULL.
  delete_json JSON NULL,
  -- NULL once withdrawn: the number is released and the day renumbers.
  -- See back_office_document_renumber_migration.sql.
  order_number VARCHAR(50) NULL UNIQUE,
  customer_id INT NULL,
  dining_table_id INT NULL,
  order_type VARCHAR(30) NOT NULL,
  status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') DEFAULT 'PENDING',
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  discount_type ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
  discount_value DECIMAL(10,2) DEFAULT 0.00,
  discount_amount DECIMAL(10,2) DEFAULT 0.00,
  tax_amount DECIMAL(10,2) DEFAULT 0.00,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  notes TEXT,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_orders_created_by_date (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- product_name and variant_name are denormalised on purpose: a reprint of a
-- year-old ticket must show what was sold, not what the dish is called today.
CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(150) NOT NULL,
  variant_id INT NULL,
  variant_name VARCHAR(80) NULL,
  stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  unit_price DECIMAL(10,2) NOT NULL,
  cost_price DECIMAL(10,2) DEFAULT 0.00,
  quantity INT NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) DEFAULT 0.00,
  tax_amount DECIMAL(10,2) DEFAULT 0.00,
  total_amount DECIMAL(10,2) NOT NULL,
  notes TEXT,
  addons_data TEXT NULL,
  item_type VARCHAR(30) DEFAULT 'PRODUCT',
  combo_id INT NULL,
  -- Legacy. Meal Deals were withdrawn and nothing writes this any more, but
  -- sales settled while they existed still carry the id they were sold under.
  deal_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX idx_order_items_order (order_id),
  INDEX idx_order_items_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  changed_by INT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id),
  INDEX idx_osh_order_status (order_id, new_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 7 — Billing, Payments & Day Close
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS draft_bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  draft_number VARCHAR(50) NOT NULL UNIQUE,
  customer_id INT NULL,
  dining_table_id INT NULL,
  order_type VARCHAR(30) NOT NULL DEFAULT 'TAKEAWAY',
  discount_type ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
  discount_value DECIMAL(10,2) DEFAULT 0.00,
  notes TEXT,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS draft_bill_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  draft_bill_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(150) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  notes TEXT,
  FOREIGN KEY (draft_bill_id) REFERENCES draft_bills(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A voided bill is never deleted: is_voided plus void_by / void_at / void_reason
-- keep the reversal on the record, and a reopened bill points back at the one
-- it replaced through reopened_from_bill_id.
CREATE TABLE IF NOT EXISTS bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- What a withdrawn document gave up: its id and the number it held,
  -- captured at the moment the number is released to NULL.
  delete_json JSON NULL,
  -- NULL once withdrawn (see back_office_document_renumber_migration.sql).
  bill_number VARCHAR(50) NULL UNIQUE,
  order_id INT NOT NULL UNIQUE,
  customer_id INT NULL,
  dining_table_id INT NULL,
  cashier_id INT NOT NULL,
  order_type VARCHAR(30) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  discount_type ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
  discount_value DECIMAL(10,2) DEFAULT 0.00,
  discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  service_charge_amount DECIMAL(10,2) DEFAULT 0.00,
  surcharge_amount DECIMAL(10,2) DEFAULT 0.00,
  coupon_code VARCHAR(50) NULL,
  coupon_discount DECIMAL(10,2) DEFAULT 0.00,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID',
  payment_method VARCHAR(30) NOT NULL,
  cash_tendered DECIMAL(10,2) NULL,
  change_returned DECIMAL(10,2) NULL,
  payment_reference VARCHAR(100) NULL,
  notes TEXT,
  is_voided BOOLEAN DEFAULT FALSE,
  void_reason TEXT NULL,
  void_by INT NULL,
  void_at DATETIME NULL,
  is_reopened BOOLEAN DEFAULT FALSE,
  reopened_from_bill_id INT NULL,
  reopened_at DATETIME NULL,
  offline_sync_id VARCHAR(100) NULL,
  printed_count INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
  FOREIGN KEY (cashier_id) REFERENCES users(id),
  INDEX idx_bills_cashier (cashier_id),
  INDEX idx_bills_cashier_date (cashier_id, created_at),
  INDEX idx_bills_customer (customer_id),
  INDEX idx_bills_order_type (order_type),
  INDEX idx_bills_payment_status (payment_status),
  INDEX idx_bills_offline_sync (offline_sync_id),
  INDEX idx_bills_voided (is_voided)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bill_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(150) NOT NULL,
  variant_id INT NULL,
  variant_name VARCHAR(80) NULL,
  stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  unit_price DECIMAL(10,2) NOT NULL,
  quantity INT NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) DEFAULT 0.00,
  tax_amount DECIMAL(10,2) DEFAULT 0.00,
  is_complimentary BOOLEAN DEFAULT FALSE,
  complimentary_reason VARCHAR(255) NULL,
  addons_data TEXT NULL,
  item_type VARCHAR(30) DEFAULT 'PRODUCT',
  combo_id INT NULL,
  -- Legacy. Meal Deals were withdrawn and nothing writes this any more, but
  -- sales settled while they existed still carry the id they were sold under.
  deal_id INT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX idx_bill_items_bill (bill_id),
  INDEX idx_bill_items_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  order_id INT NOT NULL,
  payment_method ENUM('CASH', 'CARD', 'UPI', 'OTHER') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('PAID', 'PENDING', 'FAILED', 'REFUNDED') DEFAULT 'PAID',
  reference_number VARCHAR(100),
  transaction_data TEXT,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_payments_created (created_at),
  INDEX idx_payments_method (payment_method)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The Z-report. cash_variance is the counted till minus what the system
-- expected, so a shortage is stored as a negative number rather than hidden.
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


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 8 — Takeaway Queue
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS queue (
  id INT AUTO_INCREMENT PRIMARY KEY,
  queue_number VARCHAR(50) NOT NULL,
  order_id INT NULL,
  customer_name VARCHAR(100),
  customer_phone VARCHAR(20),
  status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') DEFAULT 'PENDING',
  token_type VARCHAR(50) DEFAULT 'TAKEAWAY',
  estimated_minutes INT DEFAULT 15,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 9 — Add-ons & Combo Deals
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_addons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'Sides',
  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  image_url VARCHAR(255) NULL,
  is_available BOOLEAN DEFAULT TRUE,
  stock_item_id INT NULL,
  status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  deleted_at DATETIME NULL,
  deleted_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_addon_name (name),
  INDEX idx_addon_category (category),
  INDEX idx_addon_status (status),
  INDEX idx_addon_is_deleted (is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An add-on reaches the till through one of three routes: pinned to a product,
-- to a whole category, or marked global.
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
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  deleted_at DATETIME NULL,
  deleted_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_combo_deal_code (combo_code),
  INDEX idx_combo_deal_status (status),
  INDEX idx_combo_deal_is_deleted (is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS combo_deal_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  combo_id INT NOT NULL,
  product_id INT NOT NULL,
  variant_id INT NULL,
  quantity INT NOT NULL DEFAULT 1,
  display_order INT DEFAULT 0,
  INDEX idx_cdi_combo (combo_id),
  INDEX idx_cdi_product (product_id),
  FOREIGN KEY (combo_id) REFERENCES combo_deals(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 10 — Vendors & Purchasing
-- ───────────────────────────────────────────────────────────────────────────

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
  website VARCHAR(255) NULL,
  address TEXT NULL,
  city VARCHAR(100) NULL,
  state VARCHAR(100) NULL,
  postal_code VARCHAR(20) NULL,

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


-- stock_entries.vendor_id is declared up in SECTION 3, but the constraint has to
-- wait until here: vendors does not exist yet at that point in this file.
-- Guarded so re-running the schema does not fail on an existing constraint.
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'stock_entries'
    AND constraint_name = 'fk_stock_entries_vendor'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE stock_entries
     ADD CONSTRAINT fk_stock_entries_vendor
     FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL',
  'SELECT ''FK fk_stock_entries_vendor already present.'' AS note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 11 — Expenses & Refunds
-- ───────────────────────────────────────────────────────────────────────────

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

-- category is denormalised on purpose: an expense report run a year later must
-- still show the label the spend was booked under, even if the category has
-- since been renamed or retired.
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


-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 12 — Settings & Audit
-- ───────────────────────────────────────────────────────────────────────────

-- `key` and `value` are MySQL reserved words and must stay backquoted in every
-- statement that touches them.
--
-- Most of the settings screen stores one JSON document per tab rather than one
-- row per field — system_theme, system_toast, system_business, system_hardware,
-- system_branding, system_printer, system_notification, system_invoice and the
-- per-page design rows. The API unpacks those into flat keys in memory; the
-- flat keys are never stored, so there is only ever one copy of a value.
CREATE TABLE IF NOT EXISTS settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(100) NOT NULL UNIQUE,
  `value` TEXT NOT NULL,
  category ENUM('GENERAL', 'TAX', 'RECEIPT', 'POS', 'THEME') NOT NULL,
  description VARCHAR(255),
  is_system TINYINT(1) DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff Track reads this table by timestamp on every load, hence the date
-- indexes alongside the user one.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(100) NOT NULL,
  module VARCHAR(50) NOT NULL,
  record_id VARCHAR(50),
  old_values TEXT,
  new_values TEXT,
  ip_address VARCHAR(45),
  user_agent VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_user_created (user_id, created_at),
  INDEX idx_audit_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


SET FOREIGN_KEY_CHECKS = 1;


-- ───────────────────────────────────────────────────────────────────────────
-- Verification
-- ───────────────────────────────────────────────────────────────────────────

SELECT 'Schema ready.' AS status, COUNT(*) AS tables_present
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'roles', 'permissions', 'role_permissions', 'users',
    'categories', 'products', 'product_variants',
    'stock_items', 'stock_entries', 'stock_movements',
    'stock', 'stock_transactions', 'stock_adjustments',
    'customers', 'customer_notes',
    'dining_tables', 'table_reservations',
    'orders', 'order_items', 'order_status_history',
    'draft_bills', 'draft_bill_items', 'bills', 'bill_items',
    'payments', 'pos_day_closings', 'queue',
    'product_addons', 'product_addon_mappings',
    'combo_deals', 'combo_deal_items',
    'vendors', 'vendor_purchases', 'vendor_payments',
    'expense_categories', 'expenses', 'refunds', 'refund_items',
    'settings', 'audit_logs'
  );
