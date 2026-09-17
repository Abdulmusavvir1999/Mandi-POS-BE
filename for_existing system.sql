-- =====================================================================
-- Incremental Database Update Queries (Run on existing database)
-- Note: Once executed on your database, you can clear this file.
-- New schema changes will only add new queries here.
-- =====================================================================

-- 1. Add multiplier column to stock_entries table (if not exists)
ALTER TABLE `stock_entries`
  ADD COLUMN IF NOT EXISTS `multiplier` DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER `quantity`;

-- 2. Add is_system flag to roles table (if not exists)
--    Built-in roles are flagged so they are excluded from the manual role
--    limit (max 2 manually created roles).
ALTER TABLE `roles`
  ADD COLUMN IF NOT EXISTS `is_system` TINYINT(1) NOT NULL DEFAULT 0 AFTER `description`;

UPDATE `roles`
  SET `is_system` = 1
  WHERE `name` IN ('ADMIN', 'MANAGER', 'CASHIER', 'STAFF');
