-- ═══════════════════════════════════════════════════════════════════════════
-- Dine-In & Table Management Suite — Migration & Schema Extension
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This script upgrades the dining and seating management system:
-- 1. Updates `dining_tables` to support 5 operational statuses:
--    - AVAILABLE (Free, clean and ready to seat)
--    - OCCUPIED (Active dining order in progress)
--    - RESERVED (Booked for upcoming party/guest)
--    - CLEANING (Table needs clearing, busser/sanitizing in progress)
--    - UNAVAILABLE (Out of service / maintenance)
-- 2. Adds guest count, dine-in timer (seated_at), cleaning timer (cleaning_started_at)
-- 3. Creates `table_reservations` for booking management
-- 4. Creates `table_waitlist` for walk-in queue and token management
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- PART 1: EXTEND DINING TABLES
-- ───────────────────────────────────────────────────────────────────────────

-- Expand table status column to VARCHAR(30) so all 5 statuses are supported seamlessly
ALTER TABLE dining_tables MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE';

-- Add active guest count and timers if not present
SET @dbname = DATABASE();
SET @tablename = "dining_tables";

-- active_guest_count
SET @col = "active_guest_count";
SET @q = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @col) > 0,
  "SELECT 'Column active_guest_count already exists' AS msg;",
  "ALTER TABLE dining_tables ADD COLUMN active_guest_count INT NOT NULL DEFAULT 0 AFTER capacity;"
));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- seated_at (Dine-in Timer)
SET @col = "seated_at";
SET @q = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @col) > 0,
  "SELECT 'Column seated_at already exists' AS msg;",
  "ALTER TABLE dining_tables ADD COLUMN seated_at DATETIME NULL AFTER current_order_id;"
));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- cleaning_started_at (Cleaning Timer)
SET @col = "cleaning_started_at";
SET @q = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @col) > 0,
  "SELECT 'Column cleaning_started_at already exists' AS msg;",
  "ALTER TABLE dining_tables ADD COLUMN cleaning_started_at DATETIME NULL AFTER seated_at;"
));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- reservation_id
SET @col = "reservation_id";
SET @q = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @col) > 0,
  "SELECT 'Column reservation_id already exists' AS msg;",
  "ALTER TABLE dining_tables ADD COLUMN reservation_id INT NULL AFTER cleaning_started_at;"
));
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 2: TABLE RESERVATIONS
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS table_reservations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  reservation_code VARCHAR(50) NOT NULL UNIQUE,
  table_id INT NULL,
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  guest_count INT NOT NULL DEFAULT 2,
  reservation_time DATETIME NOT NULL,
  preferred_section VARCHAR(50) NULL,
  special_requests TEXT NULL,
  status ENUM('CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'CONFIRMED',
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tr_time (reservation_time),
  INDEX idx_tr_table (table_id),
  INDEX idx_tr_status (status),
  FOREIGN KEY (table_id) REFERENCES dining_tables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 3: WAITING LIST & QUEUE TOKENS
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS table_waitlist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  token_number VARCHAR(50) NOT NULL,
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(30) NULL,
  guest_count INT NOT NULL DEFAULT 2,
  preferred_section VARCHAR(50) NULL,
  estimated_wait_minutes INT NOT NULL DEFAULT 15,
  status ENUM('WAITING', 'NOTIFIED', 'SEATED', 'CANCELLED') NOT NULL DEFAULT 'WAITING',
  assigned_table_id INT NULL,
  seated_at DATETIME NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_wl_status (status),
  INDEX idx_wl_created (created_at),
  FOREIGN KEY (assigned_table_id) REFERENCES dining_tables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- PART 4: SAMPLE SEED DATA
-- ───────────────────────────────────────────────────────────────────────────

-- Add sample reservation for today
INSERT IGNORE INTO table_reservations (
  id, uuid, reservation_code, table_id, customer_name, customer_phone, guest_count, reservation_time, preferred_section, special_requests, status
) VALUES
(1, 'rsv-uuid-001', 'RSV-101', 3, 'Fahad Al-Otaibi', '+966 50 444 8899', 6, DATE_ADD(CURDATE(), INTERVAL 19 HOUR), 'Family Cabins', 'Baby high chair requested; birthday dinner', 'CONFIRMED'),
(2, 'rsv-uuid-002', 'RSV-102', 7, 'Eng. Mansoor Al-Zahrani', '+966 55 222 3311', 8, DATE_ADD(CURDATE(), INTERVAL 20 HOUR), 'Majlis Floor Seating', 'VIP Traditional Majlis setup', 'CONFIRMED');

-- Add sample waiting queue tokens
INSERT IGNORE INTO table_waitlist (
  id, uuid, token_number, customer_name, customer_phone, guest_count, preferred_section, estimated_wait_minutes, status
) VALUES
(1, 'wl-uuid-001', 'W001', 'Dr. Salman Al-Ghamdi', '+966 54 888 1122', 4, 'Main Hall', 10, 'WAITING'),
(2, 'wl-uuid-002', 'W002', 'Khalid Al-Qurashi', '+966 56 123 9988', 2, 'Family Cabins', 15, 'WAITING'),
(3, 'wl-uuid-003', 'W003', 'Rayan Bin Saeed', '+966 53 777 5544', 5, 'Majlis Floor Seating', 20, 'WAITING');
