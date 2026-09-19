-- ═══════════════════════════════════════════════════════════════════════════
-- Vendor Management — Schema, Permissions & Seed Data
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This script creates:
-- 1. `vendors` table (profile, contact, tax, payment terms, credit limits, rating & performance scorecards)
-- 2. `vendor_purchases` table (purchase orders, invoice details, payment status, items summary)
-- 3. `vendor_payments` table (payments made to suppliers, payment method, reference, receipt)
-- 4. Permissions `vendor.view` and `vendor.manage` mapped to ADMIN and MANAGER roles
-- 5. Realistic initial vendor seed records for Mandi & Arabian Restaurant operations
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- PART 1: TABLES
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

  -- Contact Information
  contact_person VARCHAR(100) NULL,
  phone VARCHAR(30) NOT NULL,
  email VARCHAR(100) NULL,
  address TEXT NULL,
  city VARCHAR(100) NULL,
  state VARCHAR(100) NULL,
  postal_code VARCHAR(20) NULL,
  website VARCHAR(255) NULL,

  -- Tax Details
  tax_id VARCHAR(50) NULL,             -- GSTIN / VAT Number
  pan_number VARCHAR(50) NULL,         -- PAN / Business Tax ID
  tax_category VARCHAR(50) DEFAULT 'STANDARD', -- Regular, Composition, Exempt, SEZ
  msme_number VARCHAR(50) NULL,        -- MSME / Small Business Reg

  -- Payment Terms & Banking
  payment_terms VARCHAR(50) DEFAULT 'NET_30', -- COD, ADVANCE, NET_7, NET_15, NET_30, NET_45, NET_60
  preferred_payment_method VARCHAR(50) DEFAULT 'BANK_TRANSFER', -- BANK_TRANSFER, CHEQUE, UPI, CASH
  bank_name VARCHAR(100) NULL,
  account_number VARCHAR(50) NULL,
  ifsc_code VARCHAR(50) NULL,
  branch_name VARCHAR(100) NULL,
  upi_id VARCHAR(100) NULL,

  -- Credit Limit & Balances
  credit_limit DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  credit_period_days INT NOT NULL DEFAULT 30,
  outstanding_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  total_purchases_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  total_purchases_count INT NOT NULL DEFAULT 0,
  last_purchase_date DATETIME NULL,
  last_payment_date DATETIME NULL,

  -- Vendor Rating & Performance
  rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  delivery_speed_rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  quality_rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  pricing_rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  on_time_delivery_rate DECIMAL(5, 2) NOT NULL DEFAULT 100.00, -- percentage (0-100)
  quality_score DECIMAL(5, 2) NOT NULL DEFAULT 100.00,          -- percentage (0-100)
  fulfillment_rate DECIMAL(5, 2) NOT NULL DEFAULT 100.00,       -- percentage (0-100)
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

-- Purchases History Table
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

-- Payments Table
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


-- ───────────────────────────────────────────────────────────────────────────
-- PART 2: PERMISSIONS
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO permissions (code, module, description)
VALUES 
  ('vendor.view', 'VENDORS', 'View vendor list, profiles, ratings and purchase records'),
  ('vendor.manage', 'VENDORS', 'Create, edit, delete vendors and record purchases and payments');

-- Grant permissions to ADMIN and MANAGER
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('vendor.view', 'vendor.manage')
  AND r.name IN ('ADMIN', 'MANAGER');

-- Grant view permission to CASHIER
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'vendor.view'
  AND r.name = 'CASHIER';


-- ───────────────────────────────────────────────────────────────────────────
-- PART 3: INITIAL SEED VENDORS
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO vendors (
  id, uuid, vendor_code, name, category, status, contact_person, phone, email,
  address, city, state, postal_code, website, tax_id, pan_number, tax_category, msme_number,
  payment_terms, preferred_payment_method, bank_name, account_number, ifsc_code, branch_name, upi_id,
  credit_limit, credit_period_days, outstanding_balance, total_purchases_amount, total_purchases_count,
  last_purchase_date, last_payment_date, rating, delivery_speed_rating, quality_rating, pricing_rating,
  on_time_delivery_rate, quality_score, fulfillment_rate, performance_notes, notes
) VALUES
(
  1,
  'v-uuid-001',
  'VND-001',
  'Al-Watania Poultry & Meat Farms',
  'Meat & Poultry',
  'ACTIVE',
  'Sheikh Tariq Mansoor',
  '+966 50 123 4567',
  'orders@alwatania-farms.com',
  'Wholesale Meat District, Gate 4',
  'Riyadh',
  'Central Region',
  '11564',
  'https://alwatania-farms.com',
  '310123456700003',
  'ALWPM9821K',
  'STANDARD',
  'MSME-SA-2023-8891',
  'NET_30',
  'BANK_TRANSFER',
  'Al Rajhi Bank',
  'SA0380000123456789012345',
  'RJHISARI',
  'Al Olaya Commercial Branch',
  'alwatania@rajhi',
  50000.00,
  30,
  14500.00,
  182400.00,
  16,
  DATE_SUB(NOW(), INTERVAL 3 DAY),
  DATE_SUB(NOW(), INTERVAL 12 DAY),
  4.85,
  4.90,
  4.95,
  4.70,
  98.50,
  99.20,
  97.80,
  'Premium Grade-A fresh chicken, mutton cuts, and camel meat. Extremely reliable cold-chain delivery.',
  'Primary contractor for Mandi chicken and lamb portions.'
),
(
  2,
  'v-uuid-002',
  'VND-002',
  'Deccan Basmati & Grain Traders',
  'Rice & Grains',
  'ACTIVE',
  'Abdul Rahman Siddiqui',
  '+966 54 987 6543',
  'supplies@deccanbasmati.com',
  'Grain Silo Complex, Warehouse #12',
  'Jeddah',
  'Western Province',
  '21432',
  'https://deccanbasmati.com',
  '310987654300003',
  'DECBA3412M',
  'STANDARD',
  'MSME-SA-2022-4412',
  'NET_45',
  'BANK_TRANSFER',
  'National Commercial Bank (SNB)',
  'SA4410000098765432109876',
  'NCBKSARI',
  'Jeddah Port Branch',
  'deccanrice@snb',
  40000.00,
  45,
  8200.00,
  135000.00,
  11,
  DATE_SUB(NOW(), INTERVAL 6 DAY),
  DATE_SUB(NOW(), INTERVAL 20 DAY),
  4.70,
  4.60,
  4.90,
  4.60,
  96.00,
  98.50,
  95.50,
  'Supplies aged 1121 Sella Basmati rice, biryani spices, and dry pulses. Very consistent aromatic quality.',
  'Bulk packaging 25kg and 50kg bags.'
),
(
  3,
  'v-uuid-003',
  'VND-003',
  'Royal Arabian Spice Kingdom',
  'Spices & Condiments',
  'ACTIVE',
  'Mustafa Al-Harbi',
  '+966 56 333 7890',
  'spices@royal-arabian.sa',
  'Souq Al-Zal, Shop 88',
  'Riyadh',
  'Central Region',
  '11411',
  'https://royal-arabian.sa',
  '310555666700003',
  'ROYSP7719P',
  'STANDARD',
  'MSME-SA-2024-1029',
  'NET_15',
  'BANK_TRANSFER',
  'Riyad Bank',
  'SA2220000055566677788899',
  'RIBLSARI',
  'Batha Commercial Center',
  'royalspices@riyad',
  20000.00,
  15,
  3400.00,
  48600.00,
  8,
  DATE_SUB(NOW(), INTERVAL 5 DAY),
  DATE_SUB(NOW(), INTERVAL 18 DAY),
  4.90,
  4.80,
  5.00,
  4.90,
  99.00,
  100.00,
  99.00,
  'Supplies authentic Hawayej, saffron threads, whole cardamom, cloves, dried black limes, and cinnamon barks.',
  'Exclusive artisan spice blend for signature Mandi seasoning.'
),
(
  4,
  'v-uuid-004',
  'VND-004',
  'Daily Fresh Dairy & Produce Co.',
  'Dairy & Fresh Produce',
  'ACTIVE',
  'Hassan Al-Najjar',
  '+966 53 444 1122',
  'dispatch@dailyfreshdairy.com',
  'Industrial Dairy Valley, Unit 5',
  'Al Kharj',
  'Central Region',
  '16278',
  'https://dailyfreshdairy.com',
  '310444112200003',
  'DFDP9012R',
  'STANDARD',
  NULL,
  'NET_7',
  'BANK_TRANSFER',
  'Banque Saudi Fransi',
  'SA5550000011223344556677',
  'BSFRSARI',
  'Al Kharj Highway Branch',
  'dailyfresh@fransi',
  15000.00,
  7,
  2100.00,
  39800.00,
  14,
  DATE_SUB(NOW(), INTERVAL 1 DAY),
  DATE_SUB(NOW(), INTERVAL 8 DAY),
  4.60,
  4.70,
  4.80,
  4.30,
  95.00,
  97.00,
  96.00,
  'Fresh Laban, full-cream yoghurt for raita, tomatoes, onions, garlic, and fresh mint/coriander.',
  'Daily morning deliveries at 06:30 AM.'
),
(
  5,
  'v-uuid-005',
  'VND-005',
  'Gulf EcoPack & Disposables',
  'Packaging & Disposables',
  'ACTIVE',
  'Bilal Khurram',
  '+966 55 777 9900',
  'sales@gulfecopack.com',
  '2nd Industrial City, Plot 405',
  'Dammam',
  'Eastern Province',
  '31421',
  'https://gulfecopack.com',
  '310777990000003',
  'GEPAK5523T',
  'STANDARD',
  'MSME-SA-2021-9921',
  'NET_30',
  'BANK_TRANSFER',
  'Arab National Bank (ANB)',
  'SA7740000033445566778899',
  'ARNBSARI',
  'Dammam Corniche Branch',
  'gulfecopack@anb',
  25000.00,
  30,
  0.00,
  52000.00,
  9,
  DATE_SUB(NOW(), INTERVAL 14 DAY),
  DATE_SUB(NOW(), INTERVAL 14 DAY),
  4.75,
  4.80,
  4.70,
  4.75,
  97.00,
  98.00,
  98.00,
  'Mandi heavy-duty thermal foil sheets, large banquet round trays, takeaway paper bags, cutlery sets, and napkins.',
  'Stocked on 2-month buffer quantities.'
);

-- Seed Purchases for initial vendors
INSERT IGNORE INTO vendor_purchases (
  id, uuid, vendor_id, invoice_number, order_date, due_date, total_amount, paid_amount, balance_amount, payment_status, delivery_status, items_summary, notes
) VALUES
(1, 'vp-uuid-101', 1, 'INV-WAT-2026-088', DATE_SUB(NOW(), INTERVAL 3 DAY), DATE_ADD(NOW(), INTERVAL 27 DAY), 14500.00, 0.00, 14500.00, 'UNPAID', 'RECEIVED', '300x Fresh Mandi Broiler Chickens (1100g), 40kg Camel Meat Ribs', 'Invoice received with shipment on refrigerated vehicle #4'),
(2, 'vp-uuid-102', 1, 'INV-WAT-2026-062', DATE_SUB(NOW(), INTERVAL 18 DAY), DATE_SUB(NOW(), INTERVAL 2 DAY), 16200.00, 16200.00, 0.00, 'PAID', 'RECEIVED', '350x Fresh Chickens, 50kg Lamb Carcasses', 'Settled in full via Al Rajhi bank transfer'),
(3, 'vp-uuid-103', 2, 'INV-DEC-2026-034', DATE_SUB(NOW(), INTERVAL 6 DAY), DATE_ADD(NOW(), INTERVAL 39 DAY), 8200.00, 0.00, 8200.00, 'UNPAID', 'RECEIVED', '60x 25kg Bags Aged Extra Long Grain 1121 Sella Basmati', 'Unloaded at central pantry warehouse'),
(4, 'vp-uuid-104', 3, 'INV-ROY-2026-019', DATE_SUB(NOW(), INTERVAL 5 DAY), DATE_ADD(NOW(), INTERVAL 10 DAY), 3400.00, 0.00, 3400.00, 'UNPAID', 'RECEIVED', '500g Premium Saffron Threads, 20kg Green Cardamom #1, 15kg Dried Black Lemons (Loomi)', 'Quality inspected and accepted by Chef'),
(5, 'vp-uuid-105', 4, 'INV-DFD-2026-112', DATE_SUB(NOW(), INTERVAL 1 DAY), DATE_ADD(NOW(), INTERVAL 6 DAY), 2100.00, 0.00, 2100.00, 'UNPAID', 'RECEIVED', '120L Fresh Laban, 80kg Fresh Tomatoes, 50kg Red Onions', 'Daily fresh supply');

-- Seed sample payments
INSERT IGNORE INTO vendor_payments (
  id, uuid, vendor_id, purchase_id, payment_number, payment_date, amount, payment_method, reference_number, notes
) VALUES
(1, 'vpay-uuid-001', 1, 2, 'PAY-VND-2026-001', DATE_SUB(NOW(), INTERVAL 12 DAY), 16200.00, 'BANK_TRANSFER', 'TXN-RAJHI-8891024', 'Payment for invoice INV-WAT-2026-062 settled in full'),
(2, 'vpay-uuid-002', 5, NULL, 'PAY-VND-2026-002', DATE_SUB(NOW(), INTERVAL 14 DAY), 7500.00, 'BANK_TRANSFER', 'TXN-ANB-4412098', 'Clearance of pending packaging batch invoices');
