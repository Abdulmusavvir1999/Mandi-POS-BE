-- ═══════════════════════════════════════════════════════════════════════════
-- Project X POS — Seed Data
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The factory dataset: roles, permissions and their grants, the four demo
-- logins, the menu catalog with its opening stock ledger, the dining room,
-- sample customers, expense categories, add-ons / combo deals, and every
-- default row in the settings table.
--
-- Run schema.sql first, then this file.
--
--   mysql -h <host> -u <user> -p <database> < schema.sql
--   mysql -h <host> -u <user> -p <database> < seeders.sql
--
-- Every statement is INSERT IGNORE or an idempotent UPDATE, so the file is safe
-- to re-run: it fills in what is missing and never overwrites a row that is
-- already there. Nothing is deleted.
--
-- Foreign keys are resolved by name — (SELECT id FROM roles WHERE name = ...) —
-- rather than by hardcoded ids, so the file does not care what auto-increment
-- values a database happens to be on.
--
-- ⚠  DEMO CREDENTIALS. All four seeded logins share the password `Super@123`.
--    Change them before this database faces anything real.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 — Roles
-- ───────────────────────────────────────────────────────────────────────────
--
-- is_system = 1 marks these as seeded. roles.controller.ts counts only
-- is_system = 0 rows against the manual role limit, so these four never
-- consume a slot.

INSERT IGNORE INTO roles (name, description, is_system) VALUES
  ('ADMIN',   'Full Administrator with unrestricted system access', 1),
  ('MANAGER', 'Store Manager with inventory, dining, reports, and operational control', 1),
  ('CASHIER', 'POS Cashier with billing, payment, draft bill, and customer management access', 1),
  ('STAFF',   'Floor & Kitchen Staff with order queue and table status access', 1);


-- ───────────────────────────────────────────────────────────────────────────
-- 2 — Permissions
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('auth.login',            'AUTH',        'Login to system'),
  ('auth.change_password',  'AUTH',        'Change password'),
  ('user.manage',           'USERS',       'Manage user accounts and roles'),
  ('product.manage',        'PRODUCTS',    'Manage products and pricing'),
  ('category.manage',       'CATEGORIES',  'Manage product categories'),
  ('stock.manage',          'STOCK',       'Perform stock in, adjustments and audits'),
  ('stock.view',            'STOCK',       'View inventory and low stock alerts'),
  ('customer.manage',       'CUSTOMERS',   'Manage customer records'),
  ('dining.manage',         'DINING',      'Manage tables and dining layout'),
  ('pos.billing',           'POS',         'Create and process POS sales'),
  ('pos.hold_bill',         'POS',         'Hold and resume draft bills'),
  ('pos.discount',          'POS',         'Apply discounts to orders'),
  ('order.manage',          'ORDERS',      'Process and update order statuses'),
  ('bill.view',             'BILLS',       'View sales bills and receipts'),
  ('bill.print',            'BILLS',       'Print and reprint bills'),
  ('queue.manage',          'QUEUE',       'Manage takeaway token queue'),
  ('report.view',           'REPORTS',     'View sales, stock and financial reports'),
  ('dashboard.view',        'DASHBOARD',   'View analytics dashboard'),
  ('settings.manage',       'SETTINGS',    'Configure system, tax and theme settings'),
  ('audit.view',            'AUDIT',       'View security and change audit logs'),
  ('stafftrack.view',       'STAFF_TRACK', 'View staff activity, order and revenue tracking'),
  ('vendor.view',           'VENDORS',     'View vendor list, profiles, ratings and purchase records'),
  ('vendor.manage',         'VENDORS',     'Create, edit, delete vendors and record purchases and payments'),
  ('expense.view',          'EXPENSES',    'View operating expenses and expense reports'),
  ('expense.manage',        'EXPENSES',    'Record, edit and delete operating expenses'),
  ('refund.view',           'REFUNDS',     'View refunds issued against bills'),
  ('refund.manage',         'REFUNDS',     'Issue, edit and cancel refunds');


-- ───────────────────────────────────────────────────────────────────────────
-- 3 — Role grants
-- ───────────────────────────────────────────────────────────────────────────

-- ADMIN holds everything, including anything added later.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'ADMIN';

-- MANAGER runs the floor but does not administer the system: no user accounts,
-- no settings, no audit trail.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'MANAGER'
  AND p.code NOT IN ('user.manage', 'settings.manage', 'audit.view');

-- CASHIER works the till. refund.view is included so a cashier can see a
-- reversal raised against a bill, but refund.manage is not: issuing one is a
-- manager decision.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'CASHIER'
  AND p.code IN (
    'auth.login', 'auth.change_password',
    'pos.billing', 'pos.hold_bill', 'pos.discount',
    'customer.manage', 'vendor.view',
    'bill.view', 'bill.print',
    'order.manage', 'queue.manage', 'dining.manage',
    'stock.view', 'refund.view'
  );

-- STAFF move tickets and tables, and touch no money.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'STAFF'
  AND p.code IN (
    'auth.login', 'auth.change_password',
    'order.manage', 'queue.manage', 'dining.manage'
  );


-- ───────────────────────────────────────────────────────────────────────────
-- 4 — Users
-- ───────────────────────────────────────────────────────────────────────────
--
-- ⚠  All four share the password `Super@123`, stored as one bcrypt hash
--    (cost 10). Change these before the database faces anything real.
--
-- To reset a password by hand, generate a fresh hash rather than copying this
-- one:  node -e "console.log(require('bcryptjs').hashSync('NewPass', 10))"

INSERT IGNORE INTO users (username, email, password_hash, name, phone, role_id, status) VALUES
  ('admin',   'admin@projectx.com',   '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'System Administrator', '+91 98765 43210', (SELECT id FROM roles WHERE name = 'ADMIN'),   'ACTIVE'),
  ('manager', 'manager@projectx.com', '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Operations Manager',   '+91 98765 43211', (SELECT id FROM roles WHERE name = 'MANAGER'), 'ACTIVE'),
  ('cashier', 'cashier@projectx.com', '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Head Cashier',         '+91 98765 43212', (SELECT id FROM roles WHERE name = 'CASHIER'), 'ACTIVE'),
  ('staff',   'staff@projectx.com',   '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Service Staff',        '+91 98765 43213', (SELECT id FROM roles WHERE name = 'STAFF'),   'ACTIVE');


-- ───────────────────────────────────────────────────────────────────────────
-- 5 — Menu categories
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO categories (name, description, icon, display_order, status) VALUES
  ('Mandi Specials',        'Authentic Yemeni slow-cooked fragrant Mandi rice dishes',   'utensils',   1, 'ACTIVE'),
  ('Biryani & Rice',        'Dum-cooked royal biryanis and specialty rice platters',     'flame',      2, 'ACTIVE'),
  ('Starters & Grills',     'Al Faham, Kebabs, Hummus and hot Arabian appetizers',       'drumstick',  3, 'ACTIVE'),
  ('Beverages & Mocktails', 'Refreshing Saudi Champagne, fresh juices and mint coolers', 'glass-water', 4, 'ACTIVE'),
  ('Desserts & Sweets',     'Fresh Kunafa, Baklava and traditional sweets',              'cake',       5, 'ACTIVE'),
  ('Accompaniments',        'Extra Toum garlic paste, Maraq soup and salads',            'bowl-food',  6, 'ACTIVE');


-- ───────────────────────────────────────────────────────────────────────────
-- 6 — Products
-- ───────────────────────────────────────────────────────────────────────────
--
-- sku is UNIQUE, which is what makes this block re-runnable.

INSERT IGNORE INTO products (category_id, name, sku, description, cost_price, selling_price, tax_rate, stock_quantity, low_stock_threshold, is_available, status) VALUES
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Special Chicken Mandi (Full)',    'MND-CHK-F',  'Full fragrant Mandi rice served with tender roasted whole chicken and soup',        420.00,  680.00, 5.00, 45, 10, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Special Chicken Mandi (Half)',    'MND-CHK-H',  'Half portion Mandi rice with half roasted chicken and side sauces',                 230.00,  380.00, 5.00, 60, 15, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Special Chicken Mandi (Quarter)', 'MND-CHK-Q',  'Single serving chicken mandi with aromatic rice and spicy dakous',                  130.00,  220.00, 5.00, 80, 20, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Royal Mutton Mandi (Full)',       'MND-MUT-F',  'Tender melt-in-mouth slow-braised mutton shanks on premium basmati mandi rice',     680.00, 1050.00, 5.00, 30,  8, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Royal Mutton Mandi (Half)',       'MND-MUT-H',  'Succulent mutton portion served over rich spiced mandi rice with fried nuts',       360.00,  580.00, 5.00, 40, 10, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Al Faham Chicken Mandi',          'MND-ALF-F',  'Charcoal grilled spicy Al Faham chicken paired with long-grain mandi rice',         460.00,  740.00, 5.00, 35, 10, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Mandi Specials'), 'Peri Peri Fish Mandi',            'MND-FSH-F',  'Fresh marinated King Fish steak charcoal grilled over spiced rice',                 480.00,  790.00, 5.00, 25,  5, 1, 'ACTIVE'),

  ((SELECT id FROM categories WHERE name = 'Biryani & Rice'), 'Hyderabadi Mutton Dum Biryani',   'BRY-MUT-D',  'Traditional sealed pot dum biryani with marinated mutton and saffron aroma',        240.00,  390.00, 5.00, 50, 12, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Biryani & Rice'), 'Chicken Dum Biryani Pot',         'BRY-CHK-D',  'Rich spiced layered basmati rice with juicy chicken cuts and raita',                160.00,  280.00, 5.00, 70, 15, 1, 'ACTIVE'),

  ((SELECT id FROM categories WHERE name = 'Starters & Grills'), 'Arabian Al Faham Dajaj (Full)',   'STR-ALF-F', 'Full charcoal grilled marinated Arabian chicken with toum garlic sauce',         300.00,  490.00, 5.00, 40, 10, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Starters & Grills'), 'Creamy Hummus with Pita (2 Pcs)', 'STR-HUM-P', 'Velvety chickpea hummus dip topped with extra virgin olive oil and sumac',        80.00,  160.00, 5.00, 60, 15, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Starters & Grills'), 'Mutton Maraq Soup (Bowl)',        'STR-MAR-B', 'Rich aromatic mutton bone broth infused with cardamom and black pepper',          40.00,   90.00, 5.00, 100, 25, 1, 'ACTIVE'),

  ((SELECT id FROM categories WHERE name = 'Beverages & Mocktails'), 'Saudi Champagne (Pitcher 1.5L)', 'BEV-SAU-P',  'Sparkling apple cider cocktail infused with fresh mint, orange and lemon slices', 90.00, 220.00, 5.00, 50, 10, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Beverages & Mocktails'), 'Fresh Mint Lemonade',            'BEV-MNT-L',  'Zesty chilled lemonade blended with fresh mountain mint',                         30.00,  80.00, 5.00, 120, 20, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Beverages & Mocktails'), 'Mineral Water (1L)',             'BEV-WAT-1L', 'Packaged premium drinking water',                                                 12.00,  30.00, 5.00, 200, 40, 1, 'ACTIVE'),

  ((SELECT id FROM categories WHERE name = 'Desserts & Sweets'), 'Hot Cheese Kunafa (Large)',  'DST-KNF-L', 'Crispy golden kataifi pastry layered with melted sweet cheese and crushed pistachios', 160.00, 320.00, 5.00, 30, 8, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Desserts & Sweets'), 'Classic Umali Pudding',      'DST-UML-P', 'Warm Egyptian puff pastry pudding with condensed milk, raisins and roasted nuts',       90.00, 190.00, 5.00, 35, 8, 1, 'ACTIVE'),

  ((SELECT id FROM categories WHERE name = 'Accompaniments'), 'Extra Toum Garlic Paste',       'SID-TOU-X', 'Traditional fluffy whipped garlic toum dip',                        15.00, 40.00, 5.00, 150, 30, 1, 'ACTIVE'),
  ((SELECT id FROM categories WHERE name = 'Accompaniments'), 'Spicy Yemeni Dakous Chutney',   'SID-DAK-X', 'Fresh crushed tomato, green chili, garlic and coriander sauce',     10.00, 30.00, 5.00, 150, 30, 1, 'ACTIVE');


-- ───────────────────────────────────────────────────────────────────────────
-- 7 — Opening stock
-- ───────────────────────────────────────────────────────────────────────────
--
-- Derived from the products above rather than repeated by hand, so the counters
-- and the ledger can never disagree with the catalog. Every generated uuid,
-- stock_code and entry_number is a deterministic function of the row id, which
-- is what makes re-running these four statements a no-op.

-- Legacy per-product counters.
INSERT IGNORE INTO stock (product_id, current_stock, reserved_stock, min_stock_alert)
SELECT p.id, p.stock_quantity, 0, p.low_stock_threshold
FROM products p;

-- Stock master. unit_type is inferred from the dish name the same way the
-- TypeScript seeder infers it.
INSERT IGNORE INTO stock_items
  (uuid, stock_code, name, unit_type, current_quantity, current_value, average_unit_price, status, min_stock_alert, product_id)
SELECT
  CONCAT('item-', p.id, '-seed'),
  CONCAT('STK-', LPAD(p.id, 4, '0')),
  p.name,
  CASE
    WHEN p.name LIKE '%Water%' OR p.name LIKE '%Lemonade%' OR p.name LIKE '%Champagne%' THEN 'liter'
    WHEN p.name LIKE '%Soup%'  OR p.name LIKE '%Chutney%'  OR p.name LIKE '%Paste%'     THEN 'portion'
    ELSE 'piece'
  END,
  p.stock_quantity,
  p.stock_quantity * p.cost_price,
  p.cost_price,
  'active',
  p.low_stock_threshold,
  p.id
FROM products p;

-- The opening purchase entry behind each stock item.
INSERT IGNORE INTO stock_entries
  (uuid, stock_item_id, entry_number, quantity, multiplier, total_quantity, total_price, unit_price, status, supplier, notes, created_by)
SELECT
  CONCAT('entry-', si.id, '-seed'),
  si.id,
  CONCAT('ENT-', LPAD(si.product_id, 4, '0'), '-INIT'),
  si.current_quantity,
  1.000,
  si.current_quantity,
  si.current_value,
  si.average_unit_price,
  'posted',
  'Primary Wholesale Supplier',
  'Initial opening stock ledger entry',
  (SELECT id FROM users WHERE username = 'admin')
FROM stock_items si
WHERE si.product_id IS NOT NULL;

-- The matching movement, so the history starts where the counters do.
INSERT IGNORE INTO stock_movements
  (uuid, stock_item_id, movement_type, reference_type, reference_id, quantity, unit_price, total_value, balance_quantity, balance_value, notes, created_by)
SELECT
  CONCAT('move-', si.id, '-seed'),
  si.id,
  'in',
  'PURCHASE_ENTRY',
  CONCAT('ENT-', LPAD(si.product_id, 4, '0'), '-INIT'),
  si.current_quantity,
  si.average_unit_price,
  si.current_value,
  si.current_quantity,
  si.current_value,
  'Initial inventory stock addition',
  (SELECT id FROM users WHERE username = 'admin')
FROM stock_items si
WHERE si.product_id IS NOT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- 8 — Dining room
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO dining_tables (table_number, name, section, capacity, status, display_order) VALUES
  ('T-01', 'Table 1',               'Main AC Hall',         4, 'AVAILABLE',  1),
  ('T-02', 'Table 2',               'Main AC Hall',         4, 'AVAILABLE',  2),
  ('T-03', 'Table 3',               'Main AC Hall',         6, 'AVAILABLE',  3),
  ('T-04', 'Table 4',               'Main AC Hall',         6, 'AVAILABLE',  4),
  ('T-05', 'Table 5',               'Main AC Hall',         8, 'AVAILABLE',  5),
  ('T-06', 'Table 6',               'Main AC Hall',         2, 'AVAILABLE',  6),
  ('M-01', 'Majlis Al-Noor',        'Majlis Carpet Floor',  8, 'AVAILABLE',  7),
  ('M-02', 'Majlis Al-Barakah',     'Majlis Carpet Floor',  8, 'AVAILABLE',  8),
  ('M-03', 'Majlis Al-Sultan (VIP)', 'Majlis Carpet Floor', 12, 'AVAILABLE',  9),
  ('F-01', 'Family Cabin 1',        'Family Enclosure',     6, 'AVAILABLE', 10),
  ('F-02', 'Family Cabin 2',        'Family Enclosure',     6, 'AVAILABLE', 11),
  ('F-03', 'Family Royal Suite',    'Family Enclosure',    10, 'AVAILABLE', 12);


-- ───────────────────────────────────────────────────────────────────────────
-- 9 — Sample customers
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO customers (name, phone, email, address, status, total_visits, total_spent) VALUES
  ('Dr. Farooq Siddiqui', '9845012345', 'farooq@example.com',   'Banjara Hills, Hyderabad',  'ACTIVE', 3, 2450.00),
  ('Rashid Khan',         '9988776655', 'rashid.k@example.com', 'Jubilee Hills, Hyderabad',  'ACTIVE', 3, 2450.00),
  ('Zoya Fatima',         '9123456780', 'zoya@example.com',     'Tolichowki, Hyderabad',     'ACTIVE', 3, 2450.00),
  ('Mohammed Irfan',      '9871122334', 'irfan.m@example.com',  'Mehdipatnam, Hyderabad',    'ACTIVE', 3, 2450.00);

-- Give every customer a display code, and promote the big spenders. Both are
-- no-ops once they have run.
UPDATE customers
SET customer_code = CONCAT('CUST-', LPAD(id, 4, '0'))
WHERE customer_code IS NULL OR customer_code = '';

UPDATE customers
SET tier = 'VIP'
WHERE total_spent >= 5000 AND (tier IS NULL OR tier = 'REGULAR');


-- ───────────────────────────────────────────────────────────────────────────
-- 10 — Expense categories
-- ───────────────────────────────────────────────────────────────────────────
--
-- is_fixed_cost marks spend that recurs whether or not a single plate is sold,
-- which is what separates a break-even calculation from a margin one.

INSERT IGNORE INTO expense_categories (name, description, is_fixed_cost, is_system, display_order) VALUES
  ('Rent',               'Shop, kitchen and storage rent',                  1, 1,  1),
  ('Salaries and Wages', 'Staff payroll, overtime and incentives',          1, 1,  2),
  ('Utilities',          'Electricity, water, gas and internet',            0, 1,  3),
  ('Raw Material',       'Ingredient and grocery purchases',                0, 1,  4),
  ('Packaging',          'Takeaway boxes, bags, cutlery and wrapping',      0, 1,  5),
  ('Maintenance',        'Equipment servicing, plumbing and repairs',       0, 1,  6),
  ('Transport',          'Delivery fuel, vehicle upkeep and freight',       0, 1,  7),
  ('Marketing',          'Advertising, printing and promotions',            0, 1,  8),
  ('Licenses and Fees',  'Trade licence, FSSAI and statutory fees',         1, 1,  9),
  ('Cleaning',           'Housekeeping supplies and pest control',          0, 1, 10),
  ('Miscellaneous',      'Uncategorised operational spend',                 0, 1, 99);


-- ───────────────────────────────────────────────────────────────────────────
-- 11 — Add-ons & combo deals
-- ───────────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO product_addons (id, name, category, price, cost_price, is_available, status) VALUES
  (1, 'Extra Spicy Daqoos Sauce',            'Sauces',    3.00, 1.00, 1, 'ACTIVE'),
  (2, 'Creamy Garlic Tahini Dip',            'Sauces',    4.00, 1.50, 1, 'ACTIVE'),
  (3, 'Crispy Fried Caramelized Onions',     'Toppings',  4.00, 1.20, 1, 'ACTIVE'),
  (4, 'Golden Roasted Almonds & Raisins',    'Toppings',  8.00, 3.50, 1, 'ACTIVE'),
  (5, 'Extra Traditional Shurba (Soup Bowl)', 'Sides',    6.00, 2.00, 1, 'ACTIVE'),
  (6, 'Extra Fragrant Mandi Rice Portion',   'Sides',    15.00, 5.00, 1, 'ACTIVE'),
  (7, 'Melted Cheddar Cheese Drizzle',       'Toppings',  5.00, 2.00, 1, 'ACTIVE'),
  (8, 'Chilled Ayran Laban Bottle (330ml)',  'Beverages', 6.00, 2.50, 1, 'ACTIVE');

-- All eight are global: offered against every dish rather than pinned to one.
INSERT IGNORE INTO product_addon_mappings (id, addon_id, is_global) VALUES
  (1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 4, 1),
  (5, 5, 1), (6, 6, 1), (7, 7, 1), (8, 8, 1);

INSERT IGNORE INTO combo_deals (id, combo_code, name, description, original_price, combo_price, savings_amount, is_available, status) VALUES
  (1, 'CMB-ROYAL-DUO',      'Royal Mandi Duo Combo',     '1 Half Mutton Mandi + 1 Half Chicken Mandi + 2 Daqoos + 2 Ayran Laban Bottles', 134.00, 115.00, 19.00, 1, 'ACTIVE'),
  (2, 'CMB-CHARCOAL-SOLO',  'Single Charcoal Grill Meal', '1 Half Chicken Madhbi + Fresh Garden Salad + 1 Daqoos + Arabic Red Tea Pot',    58.00,  49.00,  9.00, 1, 'ACTIVE');


-- ───────────────────────────────────────────────────────────────────────────
-- 12 — Settings
-- ───────────────────────────────────────────────────────────────────────────
--
-- `key` and `value` are MySQL reserved words and must stay backquoted.
--
-- Two shapes live in this table. The older keys are one row per field
-- (BUSINESS_NAME, TAX_PERCENTAGE, …). The newer screens store one JSON document
-- per tab — system_theme, system_printer, system_notification, system_invoice
-- and so on — which the API unpacks into flat keys in memory. Never seed the
-- flat form of a JSON-backed setting: it would be a second copy that drifts the
-- first time the tab is saved.

-- ── General ────────────────────────────────────────────────────────────────
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('BUSINESS_NAME',    'Project X — POS & Management System',                        'GENERAL', 'Official registered trade name',   1),
  ('BUSINESS_PHONE',   '+91 40 2355 8900 / +91 98765 43210',                         'GENERAL', 'Contact phone numbers',           1),
  ('BUSINESS_EMAIL',   'contact@projectx.com',                                       'GENERAL', 'Official email address',          1),
  ('BUSINESS_ADDRESS', 'Plot 42, Gachibowli Main Road, Hyderabad, Telangana 500032', 'GENERAL', 'Store physical address',          1),
  ('BUSINESS_GSTIN',   '36AAAAA0000A1Z5',                                            'GENERAL', 'GST / Tax identification number', 1),
  ('CURRENCY_SYMBOL',  '₹',                                                          'GENERAL', 'Primary currency symbol',         1);

-- ── Tax ────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('TAX_ENABLED',    'true',                       'TAX', 'Enable automated tax computation',            1),
  ('TAX_NAME',       'GST (CGST 2.5% + SGST 2.5%)', 'TAX', 'Tax title printed on invoices',              1),
  ('TAX_PERCENTAGE', '5.0',                        'TAX', 'Standard tax percentage rate',                1),
  ('TAX_INCLUSIVE',  'false',                      'TAX', 'Whether product prices already include tax',  1);

-- ── Receipt ────────────────────────────────────────────────────────────────
-- The \n sequences below are interpreted by MySQL as real newlines, which is
-- what the thermal printer expects.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('RECEIPT_HEADER',        '*** PROJECT X POS ***\nOfficial Store Terminal',                                'RECEIPT', 'Top header printed on receipts',        1),
  ('RECEIPT_FOOTER',        'Thank you for your visit!\nPlease rate our service.\nFor Support: +91 98765 43210', 'RECEIPT', 'Bottom message printed on receipt',  1),
  ('RECEIPT_SHOW_LOGO',     'true',                                                                          'RECEIPT', 'Show restaurant emblem on print',       1),
  ('RECEIPT_SHOW_TAX',      'true',                                                                          'RECEIPT', 'Display tax breakdown line',            1),
  ('RECEIPT_SHOW_CUSTOMER', 'true',                                                                          'RECEIPT', 'Print customer name & phone',           1),
  ('RECEIPT_PAPER_WIDTH',   '80mm',                                                                          'RECEIPT', 'Receipt printer thermal paper width',   1);

-- ── POS behaviour ──────────────────────────────────────────────────────────
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('POS_DEFAULT_ORDER_TYPE',   'WALK_IN', 'POS', 'Default order type on fresh POS load',            1),
  ('POS_ALLOW_NEGATIVE_STOCK', 'false',   'POS', 'Permit billing when stock reaches zero',          1),
  ('POS_ENABLE_DISCOUNTS',     'true',    'POS', 'Allow cashier to input discounts',                1),
  ('POS_SOUND_EFFECTS',        'true',    'POS', 'Play audible chimes on add to cart & checkout',   1);

-- ── Theme ──────────────────────────────────────────────────────────────────
-- system_theme is the live palette; the individual THEME_* rows are the legacy
-- fallback the API reads only when it is absent.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('THEME_PRIMARY_COLOR', '#D97706', 'THEME', 'Brand amber / saffron primary color', 1),
  ('THEME_ACCENT_COLOR',  '#EA580C', 'THEME', 'Warm fiery orange accent',            1),
  ('THEME_DARK_BG',       '#0F172A', 'THEME', 'Deep slate background',               1),
  ('system_theme',
   '{"primary":"#D97706","primaryHover":"#EA580C","sidebarBg":"#1C1917","sidebarText":"#F5F5F4","sidebarActiveAccent":"#F59E0B","bgApp":"#F8F7F4","cardBg":"#FFFFFF","cardBorder":"#E7E5E4","textMain":"#1C1917","success":"#15803D","danger":"#DC2626","warning":"#D97706"}',
   'THEME',
   'Full UI theme palette stored as JSON (overrides individual THEME_* keys)',
   1);

-- ── Printer Settings ───────────────────────────────────────────────────────
-- The three print stations, how this terminal reaches the hardware, and what
-- the paper and drawer do once a job finishes.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('system_printer',
   '{"receiptEnabled":"true","receiptName":"Cashier Thermal Receipt Printer","receiptPaperWidth":"80mm","receiptAutoPrint":"true","receiptCopies":"1","kitchenEnabled":"true","kitchenName":"Kitchen Order Ticket (KOT) Printer","kitchenPaperWidth":"80mm","kitchenAutoPrint":"true","kitchenCopies":"1","barEnabled":"false","barName":"Bar Beverage Printer","barPaperWidth":"80mm","barAutoPrint":"false","barCopies":"1","connection":"usb","deviceIp":"","devicePort":"9100","charset":"CP437","density":"normal","autoCut":"true","cashDrawer":"true","buzzer":"false","feedLines":"3"}',
   'RECEIPT',
   'Print stations, device connection & paper behaviour stored as JSON',
   1);

-- ── Notification Settings ──────────────────────────────────────────────────
-- Which floor events raise an alert, the channels that carry it, and when the
-- system is allowed to make a noise.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('system_notification',
   '{"newOrder":"true","orderReady":"true","billVoided":"true","lowStock":"true","lowStockThreshold":"5","dayClose":"true","channelInApp":"true","channelDesktop":"false","channelEmail":"false","emailRecipients":"","channelSms":"false","smsRecipients":"","sound":"true","soundTone":"chime","quietStart":"","quietEnd":"","dailySummary":"false","dailySummaryTime":"23:30"}',
   'POS',
   'Operational alert triggers, channels & quiet hours stored as JSON',
   1);

-- ── Invoice Settings ───────────────────────────────────────────────────────
-- The numbering series, the document format, and the optional blocks printed
-- beside the line items.
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('system_invoice',
   '{"prefix":"INV-","nextNumber":"1","padLength":"4","resetCycle":"yearly","title":"TAX INVOICE","paperSize":"A4","dateFormat":"dd/MM/yyyy","decimals":"2","currencyPosition":"prefix","showLogo":"true","showTaxBreakdown":"true","showQr":"false","upiId":"","showSignature":"true","signatory":"Authorised Signatory","dueDays":"0","terms":"Goods once sold will not be taken back or exchanged.","footerNote":"Thank you for your business."}',
   'RECEIPT',
   'Invoice numbering, document format & printed blocks stored as JSON',
   1);


-- ───────────────────────────────────────────────────────────────────────────
-- Verification
-- ───────────────────────────────────────────────────────────────────────────

SELECT 'roles'             AS seeded, COUNT(*) AS rows_present FROM roles
UNION ALL SELECT 'permissions',       COUNT(*) FROM permissions
UNION ALL SELECT 'role_permissions',  COUNT(*) FROM role_permissions
UNION ALL SELECT 'users',             COUNT(*) FROM users
UNION ALL SELECT 'categories',        COUNT(*) FROM categories
UNION ALL SELECT 'products',          COUNT(*) FROM products
UNION ALL SELECT 'stock_items',       COUNT(*) FROM stock_items
UNION ALL SELECT 'stock_entries',     COUNT(*) FROM stock_entries
UNION ALL SELECT 'stock_movements',   COUNT(*) FROM stock_movements
UNION ALL SELECT 'dining_tables',     COUNT(*) FROM dining_tables
UNION ALL SELECT 'customers',         COUNT(*) FROM customers
UNION ALL SELECT 'expense_categories', COUNT(*) FROM expense_categories
UNION ALL SELECT 'product_addons',    COUNT(*) FROM product_addons
UNION ALL SELECT 'combo_deals',       COUNT(*) FROM combo_deals
UNION ALL SELECT 'settings',          COUNT(*) FROM settings;

-- The three settings screens added alongside the original tabs.
SELECT `key`, category, CHAR_LENGTH(`value`) AS json_length
FROM settings
WHERE `key` IN ('system_printer', 'system_notification', 'system_invoice')
ORDER BY `key`;
