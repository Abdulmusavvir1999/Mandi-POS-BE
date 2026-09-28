-- ═══════════════════════════════════════════════════════════════════════════
-- Project X POS — Migration for an existing database
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Brings a database that already carries data up to src/database/schema.sql.
-- A new install does not need this file: schema.sql + seeders.sql already
-- produce the current shape.
--
--   mysql -h 127.0.0.1 -u root pos < "for_existing system.sql"
--
-- Safe to re-run. Every ALTER uses IF [NOT] EXISTS, and section 4 only writes
-- a row for an item whose ledger does not already add up.
--
-- Written for MariaDB (XAMPP ships 10.4). MySQL 8 does not accept IF NOT
-- EXISTS on ADD COLUMN / ADD INDEX; there, run each ALTER once by hand.
--
-- Take a backup first:
--   C:\xampp\mysql\bin\mysqldump.exe -h 127.0.0.1 -u root pos > pos_backup.sql
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 — stock_movements: link to the purchase batch
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS stock_vendor_purchase_id INT NULL DEFAULT NULL AFTER stock_id;

ALTER TABLE stock_movements
  ADD INDEX IF NOT EXISTS idx_stock_movements_svp (stock_vendor_purchase_id);

ALTER TABLE stock_movements
  ADD CONSTRAINT fk_sm_stock_vendor_purchase
  FOREIGN KEY IF NOT EXISTS (stock_vendor_purchase_id) REFERENCES stock_vendor_purchase(id)
  ON DELETE SET NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- 2 — stocks: default purchase multiplier
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS default_multiplier DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER unit_type;


-- ───────────────────────────────────────────────────────────────────────────
-- 3 — Drop stock_transactions
-- ───────────────────────────────────────────────────────────────────────────
--
-- A second, per-product ledger with integer quantities. It was written beside
-- stock_movements on product create, purchase and adjustment, and read by
-- nothing; the API no longer writes it. stock_movements is the one ledger.

DROP TABLE IF EXISTS stock_transactions;


-- ───────────────────────────────────────────────────────────────────────────
-- 4 — Bring each stock item's ledger level with its balance
-- ───────────────────────────────────────────────────────────────────────────
--
-- Until now a sale lowered stocks.current_quantity without writing a
-- movement, and so did voiding, withdrawing and restoring a bill. The ledger
-- therefore holds purchases and adjustments but not sales, and SUM(quantity)
-- per item no longer matches current_quantity; the Stock Variance report shows
-- every such item as a discrepancy.
--
-- The API now writes a movement for all of those. For the history before it
-- did, this writes one catch-up row per item for the difference, dated now and
-- marked LEDGER_OPENING, so the ledger adds up from here on. current_quantity
-- itself is not changed: it is the figure the till has been selling against.
--
-- Mostly the difference is unrecorded sales, so the row is 'out'; an item that
-- came out higher than its ledger (for example after a void) gets an 'in' row.

INSERT INTO stock_movements (
  uuid, stock_id, movement_type, reference_type, reference_id,
  quantity, unit_price, total_value, balance_quantity, balance_value,
  notes, created_by
)
SELECT
  UUID(),
  s.id,
  IF(s.current_quantity - COALESCE(l.ledger_quantity, 0) < 0, 'out', 'in'),
  'LEDGER_OPENING',
  NULL,
  s.current_quantity - COALESCE(l.ledger_quantity, 0),
  s.average_unit_price,
  ROUND(ABS(s.current_quantity - COALESCE(l.ledger_quantity, 0)) * s.average_unit_price, 2),
  s.current_quantity,
  s.current_value,
  'Catch-up for sales and bill reversals made before they were written to the ledger',
  NULL
FROM stocks s
LEFT JOIN (
  SELECT stock_id, SUM(quantity) AS ledger_quantity
  FROM stock_movements
  GROUP BY stock_id
) l ON l.stock_id = s.id
WHERE ABS(s.current_quantity - COALESCE(l.ledger_quantity, 0)) >= 0.001;


-- ───────────────────────────────────────────────────────────────────────────
-- 5 — stock_movements.reference_type: VARCHAR to ENUM
-- ───────────────────────────────────────────────────────────────────────────
--
-- The column only ever holds the values below (StockReferenceType in
-- src/models/index.ts). As an ENUM, a mistyped value is rejected rather than
-- saved, as long as the connection runs in strict mode.
--
-- Refunds used to be booked as MANUAL_ADJUSTMENT with an ADJ- reference.
-- Those rows carry "Customer refund REF-..." as their notes, so they are
-- relabelled REFUND with the refund number as the reference.
--
-- Any other value would be blanked by a non-strict ALTER, so this session is
-- made strict first: an unknown value stops the ALTER with an error instead.
-- If that happens, find the rows with
--   SELECT DISTINCT reference_type FROM stock_movements;
-- and add the value to the list (and to StockReferenceType) or relabel it.

UPDATE stock_movements
SET reference_type = 'REFUND',
    reference_id = SUBSTRING_INDEX(SUBSTRING_INDEX(notes, 'Customer refund ', -1), ' ', 1)
WHERE reference_type = 'MANUAL_ADJUSTMENT'
  AND movement_type = 'return'
  AND quantity > 0
  AND notes LIKE 'Customer refund %';

SET @previous_sql_mode = @@SESSION.sql_mode;
SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES');

ALTER TABLE stock_movements
  MODIFY COLUMN reference_type ENUM(
    'INITIAL_STOCK', 'PURCHASE_ENTRY', 'MANUAL_ADJUSTMENT', 'RETURN_TO_SUPPLIER',
    'REFUND', 'SALE', 'BILL_VOID', 'BILL_DELETE', 'BILL_RESTORE', 'LEDGER_OPENING'
  ) NOT NULL;

SET SESSION sql_mode = @previous_sql_mode;


-- ───────────────────────────────────────────────────────────────────────────
-- 6 — Drop vendor_purchases (the Vendor Purchases flow is removed)
-- ───────────────────────────────────────────────────────────────────────────
--
-- Purchase invoices recorded against a vendor are gone from the API and the
-- UI; stock purchases are booked through the stock purchase entry
-- (stock_vendor_purchase) instead. Every row in vendor_purchases is deleted
-- with the table: take the backup at the top of this file first if any of
-- them are still wanted.
--
-- vendor_payments.purchase_id pointed a payment at one of those invoices. Its
-- foreign key has to go before the table can be dropped, and the column with
-- it. The key was created unnamed, so its generated name
-- (vendor_payments_ibfk_2 on most databases) is looked up rather than assumed.
-- Payments themselves are kept.

SET @vpay_fk := (
  SELECT CONSTRAINT_NAME
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'vendor_payments'
    AND REFERENCED_TABLE_NAME = 'vendor_purchases'
  LIMIT 1
);
SET @vpay_sql := IF(@vpay_fk IS NULL, 'DO 0', CONCAT('ALTER TABLE vendor_payments DROP FOREIGN KEY `', @vpay_fk, '`'));
PREPARE vpay_stmt FROM @vpay_sql;
EXECUTE vpay_stmt;
DEALLOCATE PREPARE vpay_stmt;

ALTER TABLE vendor_payments DROP INDEX IF EXISTS idx_vpay_purchase_id;
ALTER TABLE vendor_payments DROP COLUMN IF EXISTS purchase_id;

DROP TABLE IF EXISTS vendor_purchases;

UPDATE permissions SET description = 'View vendor list, profiles, ratings and payment records'
WHERE code = 'vendor.view';
UPDATE permissions SET description = 'Create, edit, delete vendors and record payments'
WHERE code = 'vendor.manage';


-- ───────────────────────────────────────────────────────────────────────────
-- 7 — product_addon_mappings: Drop category_id and is_global, add is_free, amount, free_limit
-- ───────────────────────────────────────────────────────────────────────────
--
-- Add-ons are now mapped strictly per-product and support both Free and Paid (Amount) options.

SET @pam_cat_fk := (
  SELECT CONSTRAINT_NAME
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'product_addon_mappings'
    AND COLUMN_NAME = 'category_id'
    AND REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1
);
SET @pam_sql := IF(@pam_cat_fk IS NULL, 'DO 0', CONCAT('ALTER TABLE product_addon_mappings DROP FOREIGN KEY `', @pam_cat_fk, '`'));
PREPARE pam_stmt FROM @pam_sql;
EXECUTE pam_stmt;
DEALLOCATE PREPARE pam_stmt;

-- Clean up any orphaned rows without product_id before making product_id NOT NULL
DELETE FROM product_addon_mappings WHERE product_id IS NULL;

ALTER TABLE product_addon_mappings DROP INDEX IF EXISTS idx_pam_category;
ALTER TABLE product_addon_mappings DROP COLUMN IF EXISTS category_id;
ALTER TABLE product_addon_mappings DROP COLUMN IF EXISTS is_global;
ALTER TABLE product_addon_mappings MODIFY COLUMN product_id INT NOT NULL;

-- Add is_free ENUM('Free', 'Amount'), amount, and free_limit columns
ALTER TABLE product_addon_mappings ADD COLUMN IF NOT EXISTS is_free ENUM('Free', 'Amount') NOT NULL DEFAULT 'Amount' AFTER product_id;
ALTER TABLE product_addon_mappings ADD COLUMN IF NOT EXISTS amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER is_free;
ALTER TABLE product_addon_mappings ADD COLUMN IF NOT EXISTS free_limit INT NULL DEFAULT NULL AFTER amount;
ALTER TABLE product_addon_mappings MODIFY COLUMN free_limit INT NULL DEFAULT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- 8 — product_variants: stock_consumption
-- ───────────────────────────────────────────────────────────────────────────
--
-- Each variant / portion specifies how many units of stock one portion sale consumes.

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER stock_id;


-- ───────────────────────────────────────────────────────────────────────────
-- Verification
-- ───────────────────────────────────────────────────────────────────────────
--
-- Expect: stock_transactions_left = 0, vendor_purchases_left = 0 and
-- items_out_of_balance = 0.

SELECT
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'stock_transactions') AS stock_transactions_left,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'vendor_purchases') AS vendor_purchases_left,
  (SELECT COUNT(*)
     FROM stocks s
     LEFT JOIN (SELECT stock_id, SUM(quantity) AS q FROM stock_movements GROUP BY stock_id) l
       ON l.stock_id = s.id
    WHERE ABS(s.current_quantity - COALESCE(l.q, 0)) >= 0.001) AS items_out_of_balance;
