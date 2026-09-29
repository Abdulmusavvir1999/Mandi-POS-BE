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
-- 8 — Portion stock lives in product_variant_stocks only
-- ───────────────────────────────────────────────────────────────────────────
--
-- A portion's stock item and per-portion amount used to sit on
-- product_variants (stock_id, stock_consumption) for Common / Each Stock,
-- and in product_variant_stocks (then with a `quantity` column) for Multi
-- Stock. Now every mode uses product_variant_stocks.stock_consumption:
-- Common = one row with the dish's shared item, Each = one row with the
-- portion's own item, Multi = one row per item. The backend does the same
-- move on startup (ProductsService.moveVariantStockToRecipes); this is the
-- manual equivalent. Run it once: step 3 reads the columns step 4 drops.

-- 1. The table, with the new column name
CREATE TABLE IF NOT EXISTS product_variant_stocks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  variant_id INT NOT NULL,
  stock_id INT NOT NULL,
  stock_consumption DECIMAL(12,3) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_pvs_variant_stock (variant_id, stock_id),
  INDEX idx_pvs_stock (stock_id),
  CONSTRAINT fk_pvs_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT fk_pvs_stock FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE product_variant_stocks CHANGE COLUMN IF EXISTS quantity stock_consumption DECIMAL(12,3) NOT NULL;

-- 2. Backup of the two columns before they go
CREATE TABLE IF NOT EXISTS product_variants_stock_bak AS
SELECT id, product_id, name, stock_id, stock_consumption, CURRENT_TIMESTAMP AS backed_up_at
FROM product_variants;

-- 3. One row per Common / Each portion: its own item, else the dish's
INSERT INTO product_variant_stocks (variant_id, stock_id, stock_consumption, display_order)
SELECT v.id,
       COALESCE(v.stock_id, p.stock_id),
       CASE WHEN v.stock_consumption > 0 THEN v.stock_consumption ELSE 1 END,
       1
FROM product_variants v
JOIN products p ON p.id = v.product_id
JOIN stocks s ON s.id = COALESCE(v.stock_id, p.stock_id)
WHERE p.variant_stock_mode <> 'MULTI'
  AND NOT EXISTS (SELECT 1 FROM product_variant_stocks x WHERE x.variant_id = v.id);

-- 4. Drop the old columns (drop any foreign key on stock_id first if one exists)
ALTER TABLE product_variants DROP COLUMN IF EXISTS stock_id;
ALTER TABLE product_variants DROP COLUMN IF EXISTS stock_consumption;


-- ───────────────────────────────────────────────────────────────────────────
-- 9 — Combo deals are made of add-ons; combos and add-ons can be sold
-- ───────────────────────────────────────────────────────────────────────────
--
-- combo_deal_items named a dish (product_id / variant_id). A combo is now a
-- bundle of add-ons, so each line names an add-on (addon_id). The old dish
-- lines cannot be turned into add-ons and are deleted; the combos themselves
-- stay, and their contents are re-picked from the add-ons.
--
-- A combo or a stand-alone add-on sold at the till is a bill line with no
-- dish, so order_items, bill_items and draft_bill_items take an empty
-- product_id and an addon_id; drafts also record item_type and combo_id.
--
-- The API makes the same changes on its first start, so running this after
-- that is a no-op.

SET @cdi_has_product := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'combo_deal_items' AND COLUMN_NAME = 'product_id'
);
SET @cdi_sql := IF(@cdi_has_product > 0, 'DELETE FROM combo_deal_items', 'DO 0');
PREPARE cdi_stmt FROM @cdi_sql;
EXECUTE cdi_stmt;
DEALLOCATE PREPARE cdi_stmt;

-- The two dish foreign keys were created unnamed, so their names are looked up.
SET @cdi_fk := (
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'combo_deal_items'
    AND COLUMN_NAME = 'product_id' AND REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1
);
SET @cdi_sql := IF(@cdi_fk IS NULL, 'DO 0', CONCAT('ALTER TABLE combo_deal_items DROP FOREIGN KEY `', @cdi_fk, '`'));
PREPARE cdi_stmt FROM @cdi_sql;
EXECUTE cdi_stmt;
DEALLOCATE PREPARE cdi_stmt;

SET @cdi_fk := (
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'combo_deal_items'
    AND COLUMN_NAME = 'variant_id' AND REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1
);
SET @cdi_sql := IF(@cdi_fk IS NULL, 'DO 0', CONCAT('ALTER TABLE combo_deal_items DROP FOREIGN KEY `', @cdi_fk, '`'));
PREPARE cdi_stmt FROM @cdi_sql;
EXECUTE cdi_stmt;
DEALLOCATE PREPARE cdi_stmt;

ALTER TABLE combo_deal_items DROP COLUMN IF EXISTS variant_id;
ALTER TABLE combo_deal_items DROP COLUMN IF EXISTS product_id;
ALTER TABLE combo_deal_items ADD COLUMN IF NOT EXISTS addon_id INT NOT NULL AFTER combo_id;
ALTER TABLE combo_deal_items ADD INDEX IF NOT EXISTS idx_cdi_addon (addon_id);
ALTER TABLE combo_deal_items
  ADD CONSTRAINT fk_cdi_addon
  FOREIGN KEY IF NOT EXISTS (addon_id) REFERENCES product_addons(id)
  ON DELETE CASCADE;

ALTER TABLE order_items MODIFY COLUMN product_id INT NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS addon_id INT NULL AFTER combo_id;

ALTER TABLE bill_items MODIFY COLUMN product_id INT NULL;
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS addon_id INT NULL AFTER combo_id;

ALTER TABLE draft_bill_items MODIFY COLUMN product_id INT NULL;
ALTER TABLE draft_bill_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(30) NOT NULL DEFAULT 'PRODUCT';
ALTER TABLE draft_bill_items ADD COLUMN IF NOT EXISTS combo_id INT NULL;
ALTER TABLE draft_bill_items ADD COLUMN IF NOT EXISTS addon_id INT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- 10 — Drop products.low_stock_threshold
-- ───────────────────────────────────────────────────────────────────────────
--
-- A dish's low-stock level is its stock item's stocks.min_stock_alert, set in
-- the Stock Ledger. products.low_stock_threshold was a second copy that the
-- product form wrote and nothing else kept in step. Its values are not copied
-- over: they would overwrite alert levels already set on the stock items.

ALTER TABLE products DROP COLUMN IF EXISTS low_stock_threshold;


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
