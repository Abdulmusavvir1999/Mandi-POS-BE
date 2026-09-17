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

-- =====================================================================
-- 3. Dish Variants
--    Stock is no longer entered per dish. A dish links to a stock item
--    (stock_items.product_id) and each variant declares how much of that
--    stock one sale consumes, e.g. Full = 4, Half = 2.
-- =====================================================================

CREATE TABLE IF NOT EXISTS `product_variants` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `selling_price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `stock_consumption` DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  `display_order` INT DEFAULT 0,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('ACTIVE','INACTIVE') DEFAULT 'ACTIVE',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_variant_name_per_product` (`product_id`, `name`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Record the chosen variant on order lines
ALTER TABLE `order_items`
  ADD COLUMN IF NOT EXISTS `variant_id` INT NULL AFTER `product_name`,
  ADD COLUMN IF NOT EXISTS `variant_name` VARCHAR(80) NULL AFTER `variant_id`,
  ADD COLUMN IF NOT EXISTS `stock_consumption` DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER `variant_name`;

-- 5. ...and on bill lines, so receipts and reports can split Full vs Half
ALTER TABLE `bill_items`
  ADD COLUMN IF NOT EXISTS `variant_id` INT NULL AFTER `product_name`,
  ADD COLUMN IF NOT EXISTS `variant_name` VARCHAR(80) NULL AFTER `variant_id`,
  ADD COLUMN IF NOT EXISTS `stock_consumption` DECIMAL(12,3) NOT NULL DEFAULT 1.000 AFTER `variant_name`;
