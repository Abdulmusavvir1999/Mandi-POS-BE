-- ═══════════════════════════════════════════════════════════════════════════
--  POS — CATCH-UP MIGRATION FOR AN ALREADY-DEPLOYED DATABASE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS
--   src/database/schema.sql is written entirely as CREATE TABLE IF NOT EXISTS,
--   so re-running it against a live database creates whatever tables are
--   missing and silently skips every table that already exists — including
--   tables that have since gained columns. Those columns are what this file
--   adds. It is the only part of the schema a re-run of schema.sql cannot
--   deliver.
--
-- HOW TO RUN IT
--   1. Back the database up first. Some statements rewrite large tables.
--   2. Run src/database/schema.sql   — brings in any missing TABLES.
--   3. Run this file                 — brings in any missing COLUMNS,
--                                      type widenings and indexes.
--
--   Use the mysql client or MySQL Workbench:
--
--       mysql -u <user> -p <database> < "for_existing system.sql"
--
--   It needs a client that understands DELIMITER, because the guards below
--   are stored procedures. A driver that sends one statement at a time (and
--   so cannot switch delimiters) will not run this file.
--
-- SAFETY
--   Re-runnable. Every step checks INFORMATION_SCHEMA first and does nothing
--   when the column or index is already there, so running it twice, or
--   running it against a database that is already current, changes nothing.
--
--   One step is destructive and deliberately so. Section 9 DROPS meal_deals
--   and meal_deal_items, because Meal Deals have been withdrawn from the
--   product entirely. Every meal deal and its item rows go with them and
--   cannot be recovered without a restore. Nothing else here drops a table,
--   drops a column, or deletes a row.
--
--   Section 9 also RENAMES combo_meals to combo_deals. That is not
--   destructive — the rows, ids and foreign keys travel with the table — but
--   it does mean the API must be on the matching build. See section 9.
--
-- WHY SOME OF THESE LOOK ALREADY-APPLIED
--   Most of these columns are also added at boot by the ensureSchema() method
--   of the service that owns them, so a database whose API has been started
--   recently will already have them and those steps will no-op. Two are NOT
--   covered by any runtime migration and only this file supplies them:
--
--       users.back_office_password
--       users.role_id  (NOT NULL -> NULL)
--
--   These replace the removed back_office_password_migration.sql and
--   back_office_document_renumber_migration.sql, which scripts/create-super-admin.ts
--   still refers to by name.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- HELPERS
--
-- MySQL has no ADD COLUMN IF NOT EXISTS and no CREATE INDEX IF NOT EXISTS, so
-- each change is wrapped in a procedure that probes INFORMATION_SCHEMA and
-- builds the DDL only when it is actually needed. They are dropped again at
-- the end of the file.
-- ───────────────────────────────────────────────────────────────────────────

DROP PROCEDURE IF EXISTS pos_add_column;
DROP PROCEDURE IF EXISTS pos_modify_column;
DROP PROCEDURE IF EXISTS pos_add_index;
DROP PROCEDURE IF EXISTS pos_rename_table;
DROP PROCEDURE IF EXISTS pos_rename_index;

DELIMITER //

-- Adds a column when the table exists and the column does not.
-- p_definition is the full definition, and may carry a trailing AFTER clause.
CREATE PROCEDURE pos_add_column(
  IN p_table      VARCHAR(64),
  IN p_column     VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  DECLARE v_tables  INT DEFAULT 0;
  DECLARE v_columns INT DEFAULT 0;

  SELECT COUNT(*) INTO v_tables
    FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table;

  SELECT COUNT(*) INTO v_columns
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table
     AND COLUMN_NAME  = p_column;

  IF v_tables > 0 AND v_columns = 0 THEN
    SET @pos_ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE pos_stmt FROM @pos_ddl;
    EXECUTE pos_stmt;
    DEALLOCATE PREPARE pos_stmt;
  END IF;
END//

-- Retypes an existing column. Applying the same definition twice is a no-op
-- in effect, so this is guarded only on the column being there at all.
CREATE PROCEDURE pos_modify_column(
  IN p_table      VARCHAR(64),
  IN p_column     VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  DECLARE v_columns INT DEFAULT 0;

  SELECT COUNT(*) INTO v_columns
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table
     AND COLUMN_NAME  = p_column;

  IF v_columns > 0 THEN
    SET @pos_ddl = CONCAT('ALTER TABLE `', p_table, '` MODIFY COLUMN `', p_column, '` ', p_definition);
    PREPARE pos_stmt FROM @pos_ddl;
    EXECUTE pos_stmt;
    DEALLOCATE PREPARE pos_stmt;
  END IF;
END//

-- Adds an index when the table exists and the index name does not.
CREATE PROCEDURE pos_add_index(
  IN p_table   VARCHAR(64),
  IN p_index   VARCHAR(64),
  IN p_columns TEXT
)
BEGIN
  DECLARE v_tables  INT DEFAULT 0;
  DECLARE v_indexes INT DEFAULT 0;

  SELECT COUNT(*) INTO v_tables
    FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table;

  SELECT COUNT(*) INTO v_indexes
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table
     AND INDEX_NAME   = p_index;

  IF v_tables > 0 AND v_indexes = 0 THEN
    SET @pos_ddl = CONCAT('CREATE INDEX `', p_index, '` ON `', p_table, '` (', p_columns, ')');
    PREPARE pos_stmt FROM @pos_ddl;
    EXECUTE pos_stmt;
    DEALLOCATE PREPARE pos_stmt;
  END IF;
END//

-- Renames a table when the old name is there and the new one is not.
CREATE PROCEDURE pos_rename_table(
  IN p_from VARCHAR(64),
  IN p_to   VARCHAR(64)
)
BEGIN
  DECLARE v_from INT DEFAULT 0;
  DECLARE v_to   INT DEFAULT 0;

  SELECT COUNT(*) INTO v_from
    FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_from;

  SELECT COUNT(*) INTO v_to
    FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_to;

  -- Both present means the rename already ran and something else made the
  -- spare; that is not this script's to resolve, so it is left alone.
  IF v_from > 0 AND v_to = 0 THEN
    SET @pos_ddl = CONCAT('RENAME TABLE `', p_from, '` TO `', p_to, '`');
    PREPARE pos_stmt FROM @pos_ddl;
    EXECUTE pos_stmt;
    DEALLOCATE PREPARE pos_stmt;
  END IF;
END//

-- Renames an index on a table, when the old name is there and the new is not.
CREATE PROCEDURE pos_rename_index(
  IN p_table VARCHAR(64),
  IN p_from  VARCHAR(64),
  IN p_to    VARCHAR(64)
)
BEGIN
  DECLARE v_from INT DEFAULT 0;
  DECLARE v_to   INT DEFAULT 0;

  SELECT COUNT(*) INTO v_from
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table
     AND INDEX_NAME   = p_from;

  SELECT COUNT(*) INTO v_to
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = p_table
     AND INDEX_NAME   = p_to;

  IF v_from > 0 AND v_to = 0 THEN
    SET @pos_ddl = CONCAT('ALTER TABLE `', p_table, '` RENAME INDEX `', p_from, '` TO `', p_to, '`');
    PREPARE pos_stmt FROM @pos_ddl;
    EXECUTE pos_stmt;
    DEALLOCATE PREPARE pos_stmt;
  END IF;
END//

DELIMITER ;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. USERS — Back-Office lock and the super administrator
--
-- No runtime migration covers this section. Without it the Back-Office
-- unlock screen cannot store or check its password, and the super admin
-- account cannot be created at all.
-- ───────────────────────────────────────────────────────────────────────────

-- A second lock in front of /admin/back-office, deliberately separate from the
-- login credential. bcrypt hash; NULL means not configured yet, which is the
-- correct starting state for every existing user.
CALL pos_add_column('users', 'back_office_password', 'VARCHAR(255) NULL AFTER password_hash');

-- NULL role_id identifies the super administrator: the one account that holds
-- no role. The column was declared NOT NULL originally, so an existing
-- database rejects that account until this runs.
-- See core/utils/role.util.ts and scripts/create-super-admin.ts.
CALL pos_modify_column('users', 'role_id', 'INT NULL');


-- ───────────────────────────────────────────────────────────────────────────
-- 2. CUSTOMERS — CRM fields
-- Mirrors CustomersService.ensureSchema().
-- ───────────────────────────────────────────────────────────────────────────

CALL pos_add_column('customers', 'customer_code',  'VARCHAR(50) NULL');
CALL pos_add_column('customers', 'tier',           "VARCHAR(30) NOT NULL DEFAULT 'REGULAR'");
CALL pos_add_column('customers', 'loyalty_points', 'INT NOT NULL DEFAULT 0');
CALL pos_add_column('customers', 'last_visit_at',  'DATETIME NULL');


-- ───────────────────────────────────────────────────────────────────────────
-- 3. DINING TABLES — live service state
-- Mirrors DiningTablesService.ensureSchema().
-- ───────────────────────────────────────────────────────────────────────────

-- status began as a narrow ENUM and has since taken values it could not hold.
CALL pos_modify_column('dining_tables', 'status', "VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE'");

CALL pos_add_column('dining_tables', 'active_guest_count',  'INT NOT NULL DEFAULT 0');
CALL pos_add_column('dining_tables', 'seated_at',           'DATETIME NULL');
CALL pos_add_column('dining_tables', 'cleaning_started_at', 'DATETIME NULL');
CALL pos_add_column('dining_tables', 'reservation_id',      'INT NULL');


-- ───────────────────────────────────────────────────────────────────────────
-- 4. ORDERS — widened type, soft delete, document numbering
-- Mirrors CheckoutService.ensureSchema() and DocumentSequence.ensureSchema().
-- ───────────────────────────────────────────────────────────────────────────

-- order_type gained values after the original WALK_IN / TAKEAWAY / DINING set.
CALL pos_modify_column('orders', 'order_type', 'VARCHAR(30) NOT NULL');

-- Soft delete. An administrator withdrawing a record from the Back-Office no
-- longer destroys it: the row and its items, payments and refunds stay put and
-- is_deleted takes them out of every figure and every list. Deliberately
-- distinct from is_voided — a void is a sale cancelled at the till and remains
-- real history; a delete is a record pulled from the books by an admin.
CALL pos_add_column('orders', 'is_deleted',    'TINYINT(1) NOT NULL DEFAULT 0');
CALL pos_add_column('orders', 'deleted_at',    'DATETIME NULL');
CALL pos_add_column('orders', 'deleted_by',    'INT NULL');
CALL pos_add_column('orders', 'delete_reason', 'TEXT NULL');

-- Document numbering. A withdrawn document releases its number so the day can
-- renumber, which means the number column has to accept NULL. UNIQUE stays:
-- MySQL lets any number of rows hold NULL under it, which is exactly what
-- withdrawn documents need. delete_json keeps what was released — the row id
-- and the number it held — so a deleted-records view can still name the
-- document after the register has moved on.
CALL pos_add_column('orders', 'delete_json', 'JSON NULL');
CALL pos_add_column('orders', 'display_seq', 'INT NULL AFTER order_number');
CALL pos_modify_column('orders', 'order_number', 'VARCHAR(50) NULL');

-- Every read now carries is_deleted = 0, usually beside a date range.
CALL pos_add_index('orders', 'idx_orders_is_deleted',      'is_deleted');
CALL pos_add_index('orders', 'idx_orders_deleted_created', 'is_deleted, created_at');
CALL pos_add_index('orders', 'idx_orders_display_seq',     'is_deleted, created_at, display_seq');


-- ───────────────────────────────────────────────────────────────────────────
-- 5. BILLS — billing fields, voids, reopens, offline sync, soft delete
-- Mirrors CheckoutService.ensureSchema() and DocumentSequence.ensureSchema().
-- ───────────────────────────────────────────────────────────────────────────

CALL pos_modify_column('bills', 'order_type',     'VARCHAR(30) NOT NULL');
CALL pos_modify_column('bills', 'payment_method', 'VARCHAR(30) NOT NULL');
CALL pos_modify_column('bills', 'payment_status', "VARCHAR(30) NOT NULL DEFAULT 'PAID'");

-- Charges and discounts added after the original subtotal/tax/total set.
CALL pos_add_column('bills', 'service_charge_amount', 'DECIMAL(10,2) DEFAULT 0.00');
CALL pos_add_column('bills', 'surcharge_amount',      'DECIMAL(10,2) DEFAULT 0.00');
CALL pos_add_column('bills', 'coupon_code',           'VARCHAR(50) NULL');
CALL pos_add_column('bills', 'coupon_discount',       'DECIMAL(10,2) DEFAULT 0.00');

-- Cash drawer and payment reference.
CALL pos_add_column('bills', 'cash_tendered',     'DECIMAL(10,2) NULL');
CALL pos_add_column('bills', 'change_returned',   'DECIMAL(10,2) NULL');
CALL pos_add_column('bills', 'payment_reference', 'VARCHAR(100) NULL');

-- Voids, and the reopen that replaces a voided bill with a corrected one.
CALL pos_add_column('bills', 'is_voided',             'BOOLEAN DEFAULT FALSE');
CALL pos_add_column('bills', 'void_reason',           'TEXT NULL');
CALL pos_add_column('bills', 'void_by',               'INT NULL');
CALL pos_add_column('bills', 'void_at',               'DATETIME NULL');
CALL pos_add_column('bills', 'is_reopened',           'BOOLEAN DEFAULT FALSE');
CALL pos_add_column('bills', 'reopened_from_bill_id', 'INT NULL');
CALL pos_add_column('bills', 'reopened_at',           'DATETIME NULL');

-- The till's own id for a sale rung up offline, used to de-duplicate on sync.
CALL pos_add_column('bills', 'offline_sync_id', 'VARCHAR(100) NULL');

-- Soft delete, as for orders above.
CALL pos_add_column('bills', 'is_deleted',    'TINYINT(1) NOT NULL DEFAULT 0');
CALL pos_add_column('bills', 'deleted_at',    'DATETIME NULL');
CALL pos_add_column('bills', 'deleted_by',    'INT NULL');
CALL pos_add_column('bills', 'delete_reason', 'TEXT NULL');

-- Document numbering, as for orders above.
CALL pos_add_column('bills', 'delete_json', 'JSON NULL');
CALL pos_add_column('bills', 'display_seq', 'INT NULL AFTER bill_number');
CALL pos_modify_column('bills', 'bill_number', 'VARCHAR(50) NULL');

CALL pos_add_index('bills', 'idx_bills_is_deleted',      'is_deleted');
CALL pos_add_index('bills', 'idx_bills_deleted_created', 'is_deleted, created_at');
CALL pos_add_index('bills', 'idx_bills_display_seq',     'is_deleted, created_at, display_seq');


-- ───────────────────────────────────────────────────────────────────────────
-- 6. ORDER ITEMS & BILL ITEMS — add-ons, combo deals, complimentary lines
-- Mirrors CheckoutService.ensureSchema().
-- ───────────────────────────────────────────────────────────────────────────

-- A line is no longer always a plain product: item_type says whether it is a
-- product or a combo deal, and combo_id points at that record. addons_data is
-- the JSON of the add-ons chosen for the line, kept on the line itself so a
-- reprint shows what was actually sold.
--
-- deal_id is legacy. Meal Deals were withdrawn and nothing writes it any more,
-- but sales settled while they existed still carry the id they were sold
-- under, so it is still ensured here rather than dropped.
CALL pos_add_column('order_items', 'addons_data', 'TEXT NULL');
CALL pos_add_column('order_items', 'item_type',   "VARCHAR(30) DEFAULT 'PRODUCT'");
CALL pos_add_column('order_items', 'combo_id',    'INT NULL');
CALL pos_add_column('order_items', 'deal_id',     'INT NULL');

CALL pos_add_column('bill_items', 'is_complimentary',     'BOOLEAN DEFAULT FALSE');
CALL pos_add_column('bill_items', 'complimentary_reason', 'VARCHAR(255) NULL');
CALL pos_add_column('bill_items', 'addons_data',          'TEXT NULL');
CALL pos_add_column('bill_items', 'item_type',            "VARCHAR(30) DEFAULT 'PRODUCT'");
CALL pos_add_column('bill_items', 'combo_id',             'INT NULL');
CALL pos_add_column('bill_items', 'deal_id',              'INT NULL');


-- ───────────────────────────────────────────────────────────────────────────
-- 7. STOCK ITEMS — default vendor
-- Mirrors StockService.ensureSchema(). Indexed but deliberately not a foreign
-- key, so removing a vendor cannot block a stock item.
-- ───────────────────────────────────────────────────────────────────────────

CALL pos_add_column('stock_items', 'default_vendor_id', 'INT NULL AFTER product_id');
CALL pos_add_index('stock_items', 'idx_stock_items_default_vendor', 'default_vendor_id');


-- ───────────────────────────────────────────────────────────────────────────
-- 8. PRODUCT ADD-ONS — add-on photo
-- Mirrors AddonsCombosService.ensureSchema().
--
-- combo_deals was declared with image_url from the start and needs nothing
-- here; product_addons predates add-on photos.
-- ───────────────────────────────────────────────────────────────────────────

CALL pos_add_column('product_addons', 'image_url', 'VARCHAR(255) NULL AFTER cost_price');


-- ───────────────────────────────────────────────────────────────────────────
-- 9. COMBO DEALS REPLACE COMBO MEALS, AND MEAL DEALS ARE WITHDRAWN
--
-- The catalogue used to carry two bundle types. It now carries one, named
-- Combo Deal, and Meal Deals are gone entirely.
--
-- The rename has to happen before the API next starts. AddonsCombosService
-- creates combo_deals with CREATE TABLE IF NOT EXISTS, so a till still holding
-- combo_meals would otherwise end up with a second, empty pair beside its real
-- combos and the catalogue would look wiped. The service performs the same
-- rename at boot for exactly that reason; doing it here first is the safe
-- order when the database is upgraded ahead of the deploy.
--
-- Renaming carries the rows, the ids and the foreign keys across untouched.
-- ───────────────────────────────────────────────────────────────────────────

CALL pos_rename_table('combo_meal_items', 'combo_deal_items');
CALL pos_rename_table('combo_meals', 'combo_deals');

-- The index names spelled out the old table names.
CALL pos_rename_index('combo_deals', 'idx_combo_code', 'idx_combo_deal_code');
CALL pos_rename_index('combo_deals', 'idx_combo_status', 'idx_combo_deal_status');
CALL pos_rename_index('combo_deal_items', 'idx_cmi_combo', 'idx_cdi_combo');
CALL pos_rename_index('combo_deal_items', 'idx_cmi_product', 'idx_cdi_product');

-- Meal Deals. This destroys every meal deal and its item rows, and cannot be
-- undone without a restore. The child table goes first: it holds the foreign
-- key into the parent.
DROP TABLE IF EXISTS meal_deal_items;
DROP TABLE IF EXISTS meal_deals;


-- ───────────────────────────────────────────────────────────────────────────
-- 10. ORDER TYPES — walk-in, pickup and counter fold into takeaway
--
-- The POS now offers two order types, Dine In and Takeaway. WALK_IN, PICKUP
-- and COUNTER described how the customer arrived rather than how the order is
-- served, and nothing downstream ever treated them differently, so they all
-- become TAKEAWAY here.
--
-- This REWRITES ROWS and cannot be undone without a restore. After it runs,
-- an order that was recorded as a walk-in is indistinguishable from one
-- recorded as a takeaway. Nothing else in the file changes historical data;
-- if that distinction still matters to you, take the backup seriously or
-- skip this section and leave the old values in place - the application
-- treats anything that is not DINING as takeaway either way.
--
-- DINING is deliberately untouched: it is the value already written to every
-- dine-in row, and renaming it would buy nothing.
--
-- Re-runnable: the second run matches no rows.
-- ───────────────────────────────────────────────────────────────────────────

UPDATE orders
   SET order_type = 'TAKEAWAY'
 WHERE order_type IN ('WALK_IN', 'PICKUP', 'COUNTER');

UPDATE bills
   SET order_type = 'TAKEAWAY'
 WHERE order_type IN ('WALK_IN', 'PICKUP', 'COUNTER');

UPDATE draft_bills
   SET order_type = 'TAKEAWAY'
 WHERE order_type IN ('WALK_IN', 'PICKUP', 'COUNTER');

-- The column default followed the same rule.
CALL pos_modify_column('draft_bills', 'order_type', "VARCHAR(30) NOT NULL DEFAULT 'TAKEAWAY'");

-- And the setting that seeds a fresh POS screen.
UPDATE settings
   SET `value` = 'TAKEAWAY'
 WHERE `key` = 'POS_DEFAULT_ORDER_TYPE'
   AND `value` NOT IN ('DINING', 'TAKEAWAY');


-- ───────────────────────────────────────────────────────────────────────────
-- CLEAN UP
-- ───────────────────────────────────────────────────────────────────────────

DROP PROCEDURE IF EXISTS pos_add_column;
DROP PROCEDURE IF EXISTS pos_modify_column;
DROP PROCEDURE IF EXISTS pos_add_index;
DROP PROCEDURE IF EXISTS pos_rename_table;
DROP PROCEDURE IF EXISTS pos_rename_index;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY
--
-- Every row should report 'OK'. Anything reporting 'MISSING' did not apply —
-- check that the table itself exists, which means re-running schema.sql.
-- ───────────────────────────────────────────────────────────────────────────

SELECT
  t.TABLE_NAME  AS table_name,
  t.COLUMN_NAME AS column_name,
  CASE WHEN c.COLUMN_NAME IS NULL THEN 'MISSING' ELSE 'OK' END AS state
FROM (
            SELECT 'users'          AS TABLE_NAME, 'back_office_password' AS COLUMN_NAME
  UNION ALL SELECT 'customers',          'customer_code'
  UNION ALL SELECT 'customers',          'tier'
  UNION ALL SELECT 'customers',          'loyalty_points'
  UNION ALL SELECT 'customers',          'last_visit_at'
  UNION ALL SELECT 'dining_tables',      'active_guest_count'
  UNION ALL SELECT 'dining_tables',      'seated_at'
  UNION ALL SELECT 'dining_tables',      'cleaning_started_at'
  UNION ALL SELECT 'dining_tables',      'reservation_id'
  UNION ALL SELECT 'orders',             'is_deleted'
  UNION ALL SELECT 'orders',             'deleted_at'
  UNION ALL SELECT 'orders',             'deleted_by'
  UNION ALL SELECT 'orders',             'delete_reason'
  UNION ALL SELECT 'orders',             'delete_json'
  UNION ALL SELECT 'orders',             'display_seq'
  UNION ALL SELECT 'bills',              'service_charge_amount'
  UNION ALL SELECT 'bills',              'surcharge_amount'
  UNION ALL SELECT 'bills',              'coupon_code'
  UNION ALL SELECT 'bills',              'coupon_discount'
  UNION ALL SELECT 'bills',              'cash_tendered'
  UNION ALL SELECT 'bills',              'change_returned'
  UNION ALL SELECT 'bills',              'payment_reference'
  UNION ALL SELECT 'bills',              'is_voided'
  UNION ALL SELECT 'bills',              'void_reason'
  UNION ALL SELECT 'bills',              'void_by'
  UNION ALL SELECT 'bills',              'void_at'
  UNION ALL SELECT 'bills',              'is_reopened'
  UNION ALL SELECT 'bills',              'reopened_from_bill_id'
  UNION ALL SELECT 'bills',              'reopened_at'
  UNION ALL SELECT 'bills',              'offline_sync_id'
  UNION ALL SELECT 'bills',              'is_deleted'
  UNION ALL SELECT 'bills',              'deleted_at'
  UNION ALL SELECT 'bills',              'deleted_by'
  UNION ALL SELECT 'bills',              'delete_reason'
  UNION ALL SELECT 'bills',              'delete_json'
  UNION ALL SELECT 'bills',              'display_seq'
  UNION ALL SELECT 'order_items',        'addons_data'
  UNION ALL SELECT 'order_items',        'item_type'
  UNION ALL SELECT 'order_items',        'combo_id'
  UNION ALL SELECT 'order_items',        'deal_id'
  UNION ALL SELECT 'bill_items',         'is_complimentary'
  UNION ALL SELECT 'bill_items',         'complimentary_reason'
  UNION ALL SELECT 'bill_items',         'addons_data'
  UNION ALL SELECT 'bill_items',         'item_type'
  UNION ALL SELECT 'bill_items',         'combo_id'
  UNION ALL SELECT 'bill_items',         'deal_id'
  UNION ALL SELECT 'stock_items',        'default_vendor_id'
  UNION ALL SELECT 'product_addons',     'image_url'
) AS t
LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
       ON c.TABLE_SCHEMA = DATABASE()
      AND c.TABLE_NAME   = t.TABLE_NAME
      AND c.COLUMN_NAME  = t.COLUMN_NAME
-- MISSING sorts before OK, so anything that needs attention is at the top.
ORDER BY state ASC, t.TABLE_NAME, t.COLUMN_NAME;

-- The bundle tables: combo_deals present, and neither meal-deal table left.
SELECT
  t.name AS table_name,
  CASE
    WHEN c.TABLE_NAME IS NULL THEN t.want_absent
    ELSE t.want_present
  END AS state
FROM (
            SELECT 'combo_deals'      AS name, 'OK' AS want_present, 'MISSING' AS want_absent
  UNION ALL SELECT 'combo_deal_items',      'OK',      'MISSING'
  UNION ALL SELECT 'combo_meals',           'STILL THERE', 'OK'
  UNION ALL SELECT 'combo_meal_items',      'STILL THERE', 'OK'
  UNION ALL SELECT 'meal_deals',            'STILL THERE', 'OK'
  UNION ALL SELECT 'meal_deal_items',       'STILL THERE', 'OK'
) AS t
LEFT JOIN INFORMATION_SCHEMA.TABLES c
       ON c.TABLE_SCHEMA = DATABASE()
      AND c.TABLE_NAME   = t.name
ORDER BY state DESC, t.name;

-- users.role_id has to report YES, or the super administrator cannot exist.
SELECT
  'users.role_id nullable' AS check_name,
  IS_NULLABLE              AS state
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'users'
  AND COLUMN_NAME  = 'role_id';

-- Order types: every row should now read DINING or TAKEAWAY and nothing else.
-- A non-zero count means section 10 did not run, or new rows arrived from an
-- application build that still writes the old values.
SELECT
  'orders'       AS table_name, COUNT(*) AS legacy_order_type_rows
  FROM orders      WHERE order_type NOT IN ('DINING', 'TAKEAWAY')
UNION ALL
SELECT 'bills',       COUNT(*) FROM bills       WHERE order_type NOT IN ('DINING', 'TAKEAWAY')
UNION ALL
SELECT 'draft_bills', COUNT(*) FROM draft_bills WHERE order_type NOT IN ('DINING', 'TAKEAWAY');
