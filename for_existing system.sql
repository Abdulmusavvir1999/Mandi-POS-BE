-- ============================================================================
-- POS DATABASE MIGRATION SCRIPT FOR EXISTING SYSTEMS
-- ============================================================================
-- Safe DROP queries for deprecated and extra columns across final schema tables

DROP PROCEDURE IF EXISTS pos_drop_column_safe;
DELIMITER $$
CREATE PROCEDURE pos_drop_column_safe(
  IN in_table_name VARCHAR(64),
  IN in_col_name VARCHAR(64)
)
BEGIN
  DECLARE fk_name VARCHAR(128);
  DECLARE idx_name VARCHAR(128);

  -- 1. Drop foreign key constraint if exists
  SELECT CONSTRAINT_NAME INTO fk_name
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = in_table_name
    AND COLUMN_NAME = in_col_name
    AND REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    SET @sql_drop_fk = CONCAT('ALTER TABLE `', in_table_name, '` DROP FOREIGN KEY `', fk_name, '`');
    PREPARE stmt_fk FROM @sql_drop_fk;
    EXECUTE stmt_fk;
    DEALLOCATE PREPARE stmt_fk;
  END IF;

  -- 2. Drop index if exists
  SELECT DISTINCT INDEX_NAME INTO idx_name
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = in_table_name
    AND COLUMN_NAME = in_col_name
    AND INDEX_NAME != 'PRIMARY'
  LIMIT 1;

  IF idx_name IS NOT NULL THEN
    SET @sql_drop_idx = CONCAT('ALTER TABLE `', in_table_name, '` DROP INDEX `', idx_name, '`');
    PREPARE stmt_idx FROM @sql_drop_idx;
    EXECUTE stmt_idx;
    DEALLOCATE PREPARE stmt_idx;
  END IF;

  -- 3. Drop column if exists
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = in_table_name
        AND COLUMN_NAME = in_col_name) > 0 THEN
    SET @sql_drop_col = CONCAT('ALTER TABLE `', in_table_name, '` DROP COLUMN `', in_col_name, '`');
    PREPARE stmt_col FROM @sql_drop_col;
    EXECUTE stmt_col;
    DEALLOCATE PREPARE stmt_col;
  END IF;
END $$
DELIMITER ;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. CUSTOMERS TABLE (Final Exact Keys: id, customer_code, name, phone, email, address, image_url, status, loyalty_points, last_visit_at, total_visits, total_spent, created_at, updated_at)
-- ───────────────────────────────────────────────────────────────────────────
CALL pos_drop_column_safe('customers', 'tier');
CALL pos_drop_column_safe('customers', 'notes');
CALL pos_drop_column_safe('customers', 'is_deleted');
CALL pos_drop_column_safe('customers', 'deleted_at');
CALL pos_drop_column_safe('customers', 'deleted_by');

-- ───────────────────────────────────────────────────────────────────────────
-- 2. STOCK_ITEMS TABLE (Final Exact Keys: id, uuid, stock_code, name, unit_type, current_quantity, current_value, average_unit_price, min_stock_alert, status, created_at, updated_at)
-- ───────────────────────────────────────────────────────────────────────────
CALL pos_drop_column_safe('stock_items', 'reorder_level');
CALL pos_drop_column_safe('stock_items', 'reorder_quantity');
CALL pos_drop_column_safe('stock_items', 'max_stock_threshold');
CALL pos_drop_column_safe('stock_items', 'shelf_life_days');
CALL pos_drop_column_safe('stock_items', 'product_id');
CALL pos_drop_column_safe('stock_items', 'default_vendor_id');
CALL pos_drop_column_safe('stock_items', 'is_deleted');
CALL pos_drop_column_safe('stock_items', 'deleted_at');
CALL pos_drop_column_safe('stock_items', 'deleted_by');

-- ───────────────────────────────────────────────────────────────────────────
-- 3. VENDORS TABLE (Final Exact Keys: id, vendor_code, name, contact_person, phone, email, address, gst_number, pan_number, category, status, notes, total_orders, total_spent, is_active, created_at, updated_at)
-- ───────────────────────────────────────────────────────────────────────────
CALL pos_drop_column_safe('vendors', 'tax_category');
CALL pos_drop_column_safe('vendors', 'payment_terms');
CALL pos_drop_column_safe('vendors', 'credit_limit');
CALL pos_drop_column_safe('vendors', 'rating');
CALL pos_drop_column_safe('vendors', 'lead_time_days');
CALL pos_drop_column_safe('vendors', 'tax_rate');
CALL pos_drop_column_safe('vendors', 'account_number');
CALL pos_drop_column_safe('vendors', 'bank_name');
CALL pos_drop_column_safe('vendors', 'branch_name');
CALL pos_drop_column_safe('vendors', 'ifsc_code');
CALL pos_drop_column_safe('vendors', 'upi_id');
CALL pos_drop_column_safe('vendors', 'opening_balance');
CALL pos_drop_column_safe('vendors', 'state');
CALL pos_drop_column_safe('vendors', 'city');
CALL pos_drop_column_safe('vendors', 'pincode');
CALL pos_drop_column_safe('vendors', 'currency');
CALL pos_drop_column_safe('vendors', 'website');
CALL pos_drop_column_safe('vendors', 'current_balance');

-- ───────────────────────────────────────────────────────────────────────────
-- 4. CATEGORIES TABLE (Final Exact Keys: id, name, description, image_url, display_order, status, created_at, updated_at)
-- ───────────────────────────────────────────────────────────────────────────
CALL pos_drop_column_safe('categories', 'icon');

-- ───────────────────────────────────────────────────────────────────────────
-- 5. PRODUCTS TABLE (Final Exact Keys: id, category_id, name, sku, description, image_url, tax_rate, stock_quantity, low_stock_threshold, stock_item_id, variant_stock_mode, is_available, status, created_at, updated_at)
-- ───────────────────────────────────────────────────────────────────────────
CALL pos_drop_column_safe('products', 'cost_price');
CALL pos_drop_column_safe('products', 'selling_price');

-- ───────────────────────────────────────────────────────────────────────────
-- 6. DINING_TABLES TABLE (Final Exact Keys: id, table_number, name, section, capacity, active_guest_count, status, current_order_id, seated_at, cleaning_started_at, reservation_id, display_order, created_at, updated_at)
-- ───────────────────────────────────────────────────────────────────────────
CALL pos_drop_column_safe('dining_tables', 'qr_code');
CALL pos_drop_column_safe('dining_tables', 'shape');
CALL pos_drop_column_safe('dining_tables', 'position_x');
CALL pos_drop_column_safe('dining_tables', 'position_y');
CALL pos_drop_column_safe('dining_tables', 'width');
CALL pos_drop_column_safe('dining_tables', 'height');
CALL pos_drop_column_safe('dining_tables', 'floor_id');
CALL pos_drop_column_safe('dining_tables', 'floor_plan_id');
CALL pos_drop_column_safe('dining_tables', 'min_capacity');
CALL pos_drop_column_safe('dining_tables', 'max_capacity');
CALL pos_drop_column_safe('dining_tables', 'is_active');
CALL pos_drop_column_safe('dining_tables', 'is_occupied');
CALL pos_drop_column_safe('dining_tables', 'occupied_at');
CALL pos_drop_column_safe('dining_tables', 'type');
CALL pos_drop_column_safe('dining_tables', 'layout_type');
CALL pos_drop_column_safe('dining_tables', 'notes');
CALL pos_drop_column_safe('dining_tables', 'created_by');
CALL pos_drop_column_safe('dining_tables', 'is_deleted');
CALL pos_drop_column_safe('dining_tables', 'deleted_at');
CALL pos_drop_column_safe('dining_tables', 'deleted_by');

DROP PROCEDURE IF EXISTS pos_drop_column_safe;

