-- =====================================================================
-- Incremental Database Update Queries (Run on existing database)
-- Note: Once executed on your database, you can clear this file.
-- New schema changes will only add new queries here.
-- =====================================================================

-- 1. Add multiplier column to stock_entries table (if not exists)
ALTER TABLE `stock_entries` 
  ADD COLUMN IF NOT EXISTS `multiplier` DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER `quantity`;
