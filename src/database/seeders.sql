-- ═══════════════════════════════════════════════════════════════════════════
-- Project POS — Seed Data
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The factory dataset: roles, permissions and their grants, the super
-- administrator and the four demo logins, the menu catalog with its opening
-- stock ledger, the dining room,
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
-- ⚠  DEMO CREDENTIALS. All five seeded logins share the password `Super@123`,
--    including the super administrator. Change them before this database
--    faces anything real.
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
-- ⚠  All five share the password `Super@123`, stored as one bcrypt hash
--    (cost 10). Change these before the database faces anything real.
--
-- To reset a password by hand, generate a fresh hash rather than copying this
-- one:  node -e "console.log(require('bcryptjs').hashSync('NewPass', 10))"
--
-- The first row is the super administrator, and role_id NULL is what makes it
-- one. There is deliberately no SUPER_ADMIN row in `roles`: the absence of a
-- role is the identity, which is why the account cannot be created from the
-- Users screen or handed out from the Roles screen. See
-- core/utils/role.util.ts and src/scripts/create-super-admin.ts, which
-- provisions the same account interactively and may still be used to reset
-- its password.
--
-- This needs users.role_id to be nullable. schema.sql already declares it so;
-- a database created before that must run section 1 of "for_existing
-- system.sql" first, or this row is rejected.
--
-- back_office_password is deliberately left NULL. The second lock in front of
-- /admin/back-office is set from My Profile once, by the person who owns the
-- account, and seeding a shared one would defeat the point of it.

INSERT IGNORE INTO users (username, email, password_hash, name, phone, role_id, status) VALUES
  ('superadmin', 'superadmin@project.com', '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Super Administrator',  '+91 98765 43209', NULL,                                          'ACTIVE'),
  ('admin',      'admin@project.com',      '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'System Administrator', '+91 98765 43210', (SELECT id FROM roles WHERE name = 'ADMIN'),   'ACTIVE'),
  ('manager',    'manager@project.com',    '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Operations Manager',   '+91 98765 43211', (SELECT id FROM roles WHERE name = 'MANAGER'), 'ACTIVE'),
  ('cashier',    'cashier@project.com',    '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Head Cashier',         '+91 98765 43212', (SELECT id FROM roles WHERE name = 'CASHIER'), 'ACTIVE'),
  ('staff',      'staff@project.com',      '$2b$10$nJlibIwf3u1ODb8KPLfZ7uKIOZKaLckfJLwdnK/wOBU1JBhQZXh3q', 'Service Staff',        '+91 98765 43213', (SELECT id FROM roles WHERE name = 'STAFF'),   'ACTIVE');


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
  ('BUSINESS_NAME',    'Project — POS & Management System',                        'GENERAL', 'Official registered trade name',   1),
  ('BUSINESS_PHONE',   '+91 40 2355 8900 / +91 98765 43210',                         'GENERAL', 'Contact phone numbers',           1),
  ('BUSINESS_EMAIL',   'contact@project.com',                                       'GENERAL', 'Official email address',          1),
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
  ('RECEIPT_HEADER',        '*** Project POS ***\nOfficial Store Terminal',                                'RECEIPT', 'Top header printed on receipts',        1),
  ('RECEIPT_FOOTER',        'Thank you for your visit!\nPlease rate our service.\nFor Support: +91 98765 43210', 'RECEIPT', 'Bottom message printed on receipt',  1),
  ('RECEIPT_SHOW_LOGO',     'true',                                                                          'RECEIPT', 'Show restaurant emblem on print',       1),
  ('RECEIPT_SHOW_TAX',      'true',                                                                          'RECEIPT', 'Display tax breakdown line',            1),
  ('RECEIPT_SHOW_CUSTOMER', 'true',                                                                          'RECEIPT', 'Print customer name & phone',           1),
  ('RECEIPT_PAPER_WIDTH',   '80mm',                                                                          'RECEIPT', 'Receipt printer thermal paper width',   1);

-- ── POS behaviour ──────────────────────────────────────────────────────────
INSERT IGNORE INTO settings (`key`, `value`, category, description, is_system) VALUES
  ('POS_DEFAULT_ORDER_TYPE',   'TAKEAWAY', 'POS', 'Default order type on fresh POS load',           1),
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
