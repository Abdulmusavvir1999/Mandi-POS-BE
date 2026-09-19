-- ═══════════════════════════════════════════════════════════════════════════
-- Stock ⇄ Vendor Link — point purchase entries at a real vendor record
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `stock_entries.supplier` has always been free text, so a purchase could name
-- "Al Watania", "Al-Watania Poultry" and "al watania poultry" and none of them
-- joined back to the vendor those invoices actually belong to.
--
-- This script adds `stock_entries.vendor_id` as a real foreign key, then
-- back-fills it by matching the existing free-text supplier names.
--
-- `supplier` is deliberately KEPT rather than dropped. It becomes the name
-- snapshot at the moment of purchase, which is what a ledger needs: renaming a
-- vendor later must not silently rewrite what last year's entries say, and a
-- one-off supplier that never earns a vendor record still has somewhere to go.
--
-- ON DELETE SET NULL for the same reason — deleting a vendor must not delete
-- the purchase history that references them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- PART 1: COLUMN
-- ───────────────────────────────────────────────────────────────────────────

-- Re-runnable: MySQL has no ADD COLUMN IF NOT EXISTS before 8.0.29, so the
-- column is only added when information_schema says it is missing.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'stock_entries'
    AND column_name = 'vendor_id'
);

SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE stock_entries ADD COLUMN vendor_id INT NULL AFTER supplier',
  'SELECT ''Column stock_entries.vendor_id already present.'' AS note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ───────────────────────────────────────────────────────────────────────────
-- PART 2: INDEX
-- ───────────────────────────────────────────────────────────────────────────

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'stock_entries'
    AND index_name = 'idx_stock_entries_vendor'
);

SET @sql := IF(
  @idx_exists = 0,
  'CREATE INDEX idx_stock_entries_vendor ON stock_entries(vendor_id)',
  'SELECT ''Index idx_stock_entries_vendor already present.'' AS note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ───────────────────────────────────────────────────────────────────────────
-- PART 3: BACK-FILL FROM THE FREE-TEXT SUPPLIER NAME
-- ───────────────────────────────────────────────────────────────────────────
--
-- Only exact, case-insensitive name matches are linked. Anything fuzzier is
-- left NULL on purpose: a wrong vendor on a purchase ledger is worse than an
-- unlinked one, and the picker makes it a two-second fix in the UI.

UPDATE stock_entries se
JOIN vendors v
  ON LOWER(TRIM(v.name)) = LOWER(TRIM(se.supplier))
SET se.vendor_id = v.id
WHERE se.vendor_id IS NULL
  AND se.supplier IS NOT NULL
  AND TRIM(se.supplier) <> '';

-- ───────────────────────────────────────────────────────────────────────────
-- PART 4: FOREIGN KEY
-- ───────────────────────────────────────────────────────────────────────────
--
-- Added after the back-fill so a stale supplier name can never block the
-- constraint from being created.

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
-- Verification
-- ───────────────────────────────────────────────────────────────────────────

SELECT
  COUNT(*)                                            AS entries_total,
  SUM(vendor_id IS NOT NULL)                          AS entries_linked,
  SUM(vendor_id IS NULL AND TRIM(IFNULL(supplier,'')) <> '') AS entries_named_but_unlinked
FROM stock_entries;
