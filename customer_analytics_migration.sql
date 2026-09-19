-- Customer Management & Analytics Migration
-- Mandi POS CRM Suite

-- 1. Ensure columns exist on customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_code VARCHAR(50) NULL AFTER id;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'REGULAR' AFTER status;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INT DEFAULT 0 AFTER tier;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_visit_at DATETIME NULL AFTER total_spent;

-- 2. Create customer_notes table for multi-note history & dietary preferences
CREATE TABLE IF NOT EXISTS customer_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  user_id INT NULL,
  note_type VARCHAR(30) DEFAULT 'GENERAL', -- GENERAL, PREFERENCE, DIETARY, ALLERGY, VIP_REQUEST
  note_text TEXT NOT NULL,
  author_name VARCHAR(100) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cust_notes_cid (customer_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Populate default codes & tiers for existing customers
UPDATE customers SET customer_code = CONCAT('CUST-', LPAD(id, 3, '0')) WHERE customer_code IS NULL OR customer_code = '';
UPDATE customers SET tier = 'VIP' WHERE total_spent >= 5000 AND (tier IS NULL OR tier = 'REGULAR');
UPDATE customers SET tier = 'PLATINUM' WHERE total_spent >= 15000;
UPDATE customers SET last_visit_at = COALESCE(
  (SELECT MAX(created_at) FROM bills WHERE bills.customer_id = customers.id),
  created_at
) WHERE last_visit_at IS NULL;
