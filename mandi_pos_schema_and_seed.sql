-- =====================================================================
-- Mandi Shop POS & Management System — Complete MySQL Database Dump
-- Compatible with phpMyAdmin, MySQL 5.7+, 8.0+, MariaDB 10.3+
-- Server: http://192.168.10.15/phpmyadmin/
-- Database: pos
-- =====================================================================

CREATE DATABASE IF NOT EXISTS \`pos\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE \`pos\`;

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Roles table
DROP TABLE IF EXISTS \`role_permissions\`;
DROP TABLE IF EXISTS \`permissions\`;
DROP TABLE IF EXISTS \`users\`;
DROP TABLE IF EXISTS \`roles\`;

CREATE TABLE \`roles\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`name\` VARCHAR(50) NOT NULL UNIQUE,
  \`description\` VARCHAR(255),
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Permissions table
CREATE TABLE \`permissions\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`code\` VARCHAR(100) NOT NULL UNIQUE,
  \`module\` VARCHAR(50) NOT NULL,
  \`description\` VARCHAR(255),
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Role Permissions junction
CREATE TABLE \`role_permissions\` (
  \`role_id\` INT NOT NULL,
  \`permission_id\` INT NOT NULL,
  PRIMARY KEY (\`role_id\`, \`permission_id\`),
  FOREIGN KEY (\`role_id\`) REFERENCES \`roles\`(\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`permission_id\`) REFERENCES \`permissions\`(\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Users table
CREATE TABLE \`users\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`username\` VARCHAR(50) NOT NULL UNIQUE,
  \`email\` VARCHAR(100) NOT NULL UNIQUE,
  \`password_hash\` VARCHAR(255) NOT NULL,
  \`name\` VARCHAR(100) NOT NULL,
  \`phone\` VARCHAR(20),
  \`role_id\` INT NOT NULL,
  \`status\` ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') DEFAULT 'ACTIVE',
  \`last_login_at\` DATETIME NULL,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (\`role_id\`) REFERENCES \`roles\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Categories table
DROP TABLE IF EXISTS \`categories\`;
CREATE TABLE \`categories\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`name\` VARCHAR(100) NOT NULL,
  \`description\` TEXT,
  \`icon\` VARCHAR(50),
  \`image_url\` VARCHAR(255),
  \`display_order\` INT DEFAULT 0,
  \`status\` ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Products table
DROP TABLE IF EXISTS \`products\`;
CREATE TABLE \`products\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`category_id\` INT NOT NULL,
  \`name\` VARCHAR(150) NOT NULL,
  \`sku\` VARCHAR(50) NOT NULL UNIQUE,
  \`description\` TEXT,
  \`image_url\` VARCHAR(255),
  \`cost_price\` DECIMAL(10,2) DEFAULT 0.00,
  \`selling_price\` DECIMAL(10,2) NOT NULL,
  \`tax_rate\` DECIMAL(5,2) DEFAULT 5.00,
  \`stock_quantity\` INT DEFAULT 0,
  \`low_stock_threshold\` INT DEFAULT 10,
  \`is_available\` TINYINT(1) DEFAULT 1,
  \`status\` ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (\`category_id\`) REFERENCES \`categories\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Stock Items Master table
DROP TABLE IF EXISTS `stock_items`;
CREATE TABLE `stock_items` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uuid` VARCHAR(36) NOT NULL UNIQUE,
  `stock_code` VARCHAR(50) NOT NULL UNIQUE,
  `name` VARCHAR(255) NOT NULL,
  `unit_type` VARCHAR(50) NOT NULL DEFAULT 'piece',
  `current_quantity` DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  `current_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `average_unit_price` DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  `min_stock_alert` DECIMAL(12,3) NOT NULL DEFAULT 10.000,
  `product_id` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE SET NULL,
  INDEX idx_stock_items_code (`stock_code`),
  INDEX idx_stock_items_status (`status`),
  INDEX idx_stock_items_product (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Stock Entries (Purchase / Addition Ledger)
DROP TABLE IF EXISTS `stock_entries`;
CREATE TABLE `stock_entries` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uuid` VARCHAR(36) NOT NULL UNIQUE,
  `stock_item_id` INT NOT NULL,
  `entry_number` VARCHAR(50) NOT NULL UNIQUE,
  `entry_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `quantity` DECIMAL(12,3) NOT NULL,
  `multiplier` DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  `total_quantity` DECIMAL(12,3) NOT NULL,
  `total_price` DECIMAL(14,2) NOT NULL,
  `unit_price` DECIMAL(14,4) NOT NULL,
  `status` ENUM('draft', 'posted', 'cancelled') NOT NULL DEFAULT 'posted',
  `supplier` VARCHAR(150) NULL,
  `invoice_number` VARCHAR(100) NULL,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX idx_stock_entries_item (`stock_item_id`),
  INDEX idx_stock_entries_number (`entry_number`),
  INDEX idx_stock_entries_date (`entry_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Stock Movements (History / Audit Trail)
DROP TABLE IF EXISTS `stock_movements`;
CREATE TABLE `stock_movements` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uuid` VARCHAR(36) NOT NULL UNIQUE,
  `stock_item_id` INT NOT NULL,
  `movement_type` ENUM('in', 'out', 'adjustment', 'return', 'wastage', 'transfer_in', 'transfer_out') NOT NULL,
  `reference_type` VARCHAR(50) NOT NULL,
  `reference_id` VARCHAR(100) NULL,
  `quantity` DECIMAL(12,3) NOT NULL,
  `unit_price` DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  `total_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `balance_quantity` DECIMAL(12,3) NOT NULL,
  `balance_value` DECIMAL(14,2) NOT NULL,
  `movement_date` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX idx_stock_movements_item (`stock_item_id`),
  INDEX idx_stock_movements_type (`movement_type`),
  INDEX idx_stock_movements_date (`movement_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy Stock tracking table
DROP TABLE IF EXISTS `stock`;
CREATE TABLE `stock` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL UNIQUE,
  `current_stock` INT NOT NULL DEFAULT 0,
  `reserved_stock` INT NOT NULL DEFAULT 0,
  `min_stock_alert` INT DEFAULT 10,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy Stock transactions history
DROP TABLE IF EXISTS \`stock_transactions\`;
CREATE TABLE \`stock_transactions\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`product_id\` INT NOT NULL,
  \`transaction_type\` ENUM('STOCK_IN', 'SALE', 'ADJUSTMENT', 'RETURN') NOT NULL,
  \`quantity\` INT NOT NULL,
  \`previous_stock\` INT NOT NULL,
  \`new_stock\` INT NOT NULL,
  \`reference_id\` VARCHAR(100),
  \`reference_type\` VARCHAR(50),
  \`notes\` TEXT,
  \`created_by\` INT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`),
  FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy Stock adjustments
DROP TABLE IF EXISTS \`stock_adjustments\`;
CREATE TABLE \`stock_adjustments\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`product_id\` INT NOT NULL,
  \`adjustment_type\` ENUM('INCREASE', 'DECREASE') NOT NULL,
  \`quantity\` INT NOT NULL,
  \`reason\` VARCHAR(255) NOT NULL,
  \`approved_by\` INT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`),
  FOREIGN KEY (\`approved_by\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Customers table
DROP TABLE IF EXISTS \`customers\`;
CREATE TABLE \`customers\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`name\` VARCHAR(100) NOT NULL,
  \`phone\` VARCHAR(20) NOT NULL UNIQUE,
  \`email\` VARCHAR(100),
  \`address\` TEXT,
  \`notes\` TEXT,
  \`status\` ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
  \`total_visits\` INT DEFAULT 0,
  \`total_spent\` DECIMAL(10,2) DEFAULT 0.00,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Dining Tables
DROP TABLE IF EXISTS \`dining_tables\`;
CREATE TABLE \`dining_tables\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`table_number\` VARCHAR(20) NOT NULL UNIQUE,
  \`name\` VARCHAR(50) NOT NULL,
  \`section\` VARCHAR(50) DEFAULT 'Main Hall',
  \`capacity\` INT DEFAULT 4,
  \`status\` ENUM('AVAILABLE', 'SELECTED', 'OCCUPIED', 'UNAVAILABLE') DEFAULT 'AVAILABLE',
  \`current_order_id\` INT NULL,
  \`display_order\` INT DEFAULT 0,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Orders table
DROP TABLE IF EXISTS \`orders\`;
CREATE TABLE \`orders\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`order_number\` VARCHAR(50) NOT NULL UNIQUE,
  \`customer_id\` INT NULL,
  \`dining_table_id\` INT NULL,
  \`order_type\` ENUM('WALK_IN', 'TAKEAWAY', 'DINING') NOT NULL,
  \`status\` ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') DEFAULT 'PENDING',
  \`subtotal\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  \`discount_type\` ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
  \`discount_value\` DECIMAL(10,2) DEFAULT 0.00,
  \`discount_amount\` DECIMAL(10,2) DEFAULT 0.00,
  \`tax_amount\` DECIMAL(10,2) DEFAULT 0.00,
  \`total_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  \`notes\` TEXT,
  \`created_by\` INT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\`(\`id\`),
  FOREIGN KEY (\`dining_table_id\`) REFERENCES \`dining_tables\`(\`id\`),
  FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Order Items table
DROP TABLE IF EXISTS \`order_items\`;
CREATE TABLE \`order_items\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`order_id\` INT NOT NULL,
  \`product_id\` INT NOT NULL,
  \`product_name\` VARCHAR(150) NOT NULL,
  \`unit_price\` DECIMAL(10,2) NOT NULL,
  \`cost_price\` DECIMAL(10,2) DEFAULT 0.00,
  \`quantity\` INT NOT NULL,
  \`subtotal\` DECIMAL(10,2) NOT NULL,
  \`discount_amount\` DECIMAL(10,2) DEFAULT 0.00,
  \`tax_amount\` DECIMAL(10,2) DEFAULT 0.00,
  \`total_amount\` DECIMAL(10,2) NOT NULL,
  \`notes\` TEXT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. Order Status History
DROP TABLE IF EXISTS \`order_status_history\`;
CREATE TABLE \`order_status_history\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`order_id\` INT NOT NULL,
  \`previous_status\` VARCHAR(50),
  \`new_status\` VARCHAR(50) NOT NULL,
  \`changed_by\` INT,
  \`notes\` TEXT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`changed_by\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Draft Bills
DROP TABLE IF EXISTS \`draft_bills\`;
CREATE TABLE \`draft_bills\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`draft_number\` VARCHAR(50) NOT NULL UNIQUE,
  \`customer_id\` INT NULL,
  \`dining_table_id\` INT NULL,
  \`order_type\` ENUM('WALK_IN', 'TAKEAWAY', 'DINING') NOT NULL DEFAULT 'WALK_IN',
  \`discount_type\` ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
  \`discount_value\` DECIMAL(10,2) DEFAULT 0.00,
  \`notes\` TEXT,
  \`created_by\` INT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\`(\`id\`),
  FOREIGN KEY (\`dining_table_id\`) REFERENCES \`dining_tables\`(\`id\`),
  FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. Draft Bill Items
DROP TABLE IF EXISTS \`draft_bill_items\`;
CREATE TABLE \`draft_bill_items\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`draft_bill_id\` INT NOT NULL,
  \`product_id\` INT NOT NULL,
  \`product_name\` VARCHAR(150) NOT NULL,
  \`quantity\` INT NOT NULL,
  \`unit_price\` DECIMAL(10,2) NOT NULL,
  \`notes\` TEXT,
  FOREIGN KEY (\`draft_bill_id\`) REFERENCES \`draft_bills\`(\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. Bills table
DROP TABLE IF EXISTS \`bills\`;
CREATE TABLE \`bills\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`bill_number\` VARCHAR(50) NOT NULL UNIQUE,
  \`order_id\` INT NOT NULL UNIQUE,
  \`customer_id\` INT NULL,
  \`dining_table_id\` INT NULL,
  \`cashier_id\` INT NOT NULL,
  \`order_type\` ENUM('WALK_IN', 'TAKEAWAY', 'DINING') NOT NULL,
  \`subtotal\` DECIMAL(10,2) NOT NULL,
  \`discount_type\` ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
  \`discount_value\` DECIMAL(10,2) DEFAULT 0.00,
  \`discount_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  \`tax_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  \`total_amount\` DECIMAL(10,2) NOT NULL,
  \`payment_status\` ENUM('PAID', 'PENDING', 'FAILED', 'REFUNDED') DEFAULT 'PAID',
  \`payment_method\` ENUM('CASH', 'CARD', 'UPI', 'OTHER') NOT NULL,
  \`notes\` TEXT,
  \`printed_count\` INT DEFAULT 0,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`),
  FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\`(\`id\`),
  FOREIGN KEY (\`dining_table_id\`) REFERENCES \`dining_tables\`(\`id\`),
  FOREIGN KEY (\`cashier_id\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. Bill Items table
DROP TABLE IF EXISTS \`bill_items\`;
CREATE TABLE \`bill_items\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`bill_id\` INT NOT NULL,
  \`product_id\` INT NOT NULL,
  \`product_name\` VARCHAR(150) NOT NULL,
  \`unit_price\` DECIMAL(10,2) NOT NULL,
  \`quantity\` INT NOT NULL,
  \`subtotal\` DECIMAL(10,2) NOT NULL,
  \`discount_amount\` DECIMAL(10,2) DEFAULT 0.00,
  \`tax_amount\` DECIMAL(10,2) DEFAULT 0.00,
  \`total_amount\` DECIMAL(10,2) NOT NULL,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`bill_id\`) REFERENCES \`bills\`(\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. Payments table
DROP TABLE IF EXISTS \`payments\`;
CREATE TABLE \`payments\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`bill_id\` INT NOT NULL,
  \`order_id\` INT NOT NULL,
  \`payment_method\` ENUM('CASH', 'CARD', 'UPI', 'OTHER') NOT NULL,
  \`amount\` DECIMAL(10,2) NOT NULL,
  \`status\` ENUM('PAID', 'PENDING', 'FAILED', 'REFUNDED') DEFAULT 'PAID',
  \`reference_number\` VARCHAR(100),
  \`transaction_data\` TEXT,
  \`created_by\` INT,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`bill_id\`) REFERENCES \`bills\`(\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`),
  FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20. Queue table
DROP TABLE IF EXISTS \`queue\`;
CREATE TABLE \`queue\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`queue_number\` VARCHAR(50) NOT NULL,
  \`order_id\` INT NULL,
  \`customer_name\` VARCHAR(100),
  \`customer_phone\` VARCHAR(20),
  \`status\` ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') DEFAULT 'PENDING',
  \`token_type\` VARCHAR(50) DEFAULT 'TAKEAWAY',
  \`estimated_minutes\` INT DEFAULT 15,
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 21. Settings table
DROP TABLE IF EXISTS \`settings\`;
CREATE TABLE \`settings\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`key\` VARCHAR(100) NOT NULL UNIQUE,
  \`value\` TEXT NOT NULL,
  \`category\` ENUM('GENERAL', 'TAX', 'RECEIPT', 'POS', 'THEME') NOT NULL,
  \`description\` VARCHAR(255),
  \`is_system\` TINYINT(1) DEFAULT 0,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 22. Audit Logs table
DROP TABLE IF EXISTS \`audit_logs\`;
CREATE TABLE \`audit_logs\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`user_id\` INT NULL,
  \`action\` VARCHAR(100) NOT NULL,
  \`module\` VARCHAR(50) NOT NULL,
  \`record_id\` VARCHAR(50),
  \`old_values\` TEXT,
  \`new_values\` TEXT,
  \`ip_address\` VARCHAR(45),
  \`user_agent\` VARCHAR(255),
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
