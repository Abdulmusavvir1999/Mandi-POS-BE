-- POS & Offline POS Advanced Migration
-- Mandi POS

-- 1. Extend Order Types and Payment Methods in orders and bills
ALTER TABLE orders MODIFY COLUMN order_type VARCHAR(30) NOT NULL;
ALTER TABLE bills MODIFY COLUMN order_type VARCHAR(30) NOT NULL;
ALTER TABLE bills MODIFY COLUMN payment_method VARCHAR(30) NOT NULL;
ALTER TABLE bills MODIFY COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID';

-- 2. Add Billing, Void, Reopen, and Offline Sync columns to bills
ALTER TABLE bills ADD COLUMN IF NOT EXISTS service_charge_amount DECIMAL(10,2) DEFAULT 0.00 AFTER tax_amount;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS surcharge_amount DECIMAL(10,2) DEFAULT 0.00 AFTER service_charge_amount;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50) NULL AFTER surcharge_amount;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS coupon_discount DECIMAL(10,2) DEFAULT 0.00 AFTER coupon_code;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS cash_tendered DECIMAL(10,2) NULL AFTER payment_method;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS change_returned DECIMAL(10,2) NULL AFTER cash_tendered;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_voided BOOLEAN DEFAULT FALSE AFTER notes;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS void_reason TEXT NULL AFTER is_voided;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS void_by INT NULL AFTER void_reason;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS void_at DATETIME NULL AFTER void_by;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_reopened BOOLEAN DEFAULT FALSE AFTER void_at;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reopened_from_bill_id INT NULL AFTER is_reopened;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reopened_at DATETIME NULL AFTER reopened_from_bill_id;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS offline_sync_id VARCHAR(100) NULL AFTER reopened_at;

-- 3. Add Complimentary items tracking to bill_items
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS is_complimentary BOOLEAN DEFAULT FALSE AFTER tax_amount;
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS complimentary_reason VARCHAR(255) NULL AFTER is_complimentary;

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
