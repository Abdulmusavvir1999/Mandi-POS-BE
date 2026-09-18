-- ═══════════════════════════════════════════════════════════════════════════
-- Staff Track — migration for an already-seeded system
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run this once against an existing database. A freshly seeded database gets
-- the permission from src/database/seeders.ts instead and needs only PART 2.
--
-- This script adds NO tables and NO columns. Staff Track reads the data the
-- POS already writes — orders.created_by, order_status_history.changed_by,
-- bills.cashier_id, payments.created_by and audit_logs — so there is no new
-- place for order, revenue, table or activity data to drift out of sync.
--
-- PART 1 registers the permission that widens /api/staff-track to the whole
-- roster. It does not gate the module: a signed-in user without it still
-- reaches Staff Track and is scoped by the server to their own attribution.
-- PART 2 adds read indexes only. Both parts are safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- PART 1 — Permission
-- ───────────────────────────────────────────────────────────────────────────

-- The permission that turns Staff Track from "my own figures" into "everyone's".
-- Holding it means a viewer sees every staff member; lacking it means the API
-- pins every query, report and filter list to the caller's own id rather than
-- refusing them. `permissions.code` is UNIQUE, so IGNORE makes a second run a
-- no-op rather than an error.
INSERT IGNORE INTO permissions (code, module, description)
VALUES ('stafftrack.view', 'STAFF_TRACK', 'View staff activity, order and revenue tracking');

-- Grant to ADMIN and MANAGER. role_permissions has a composite primary key,
-- so IGNORE likewise makes re-running harmless.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'stafftrack.view'
  AND r.name IN ('ADMIN', 'MANAGER');

-- To give another role the all-staff view later, add its name to the IN list
-- above and re-run. Revoking does not remove the role's access to Staff Track;
-- it drops that role back to seeing only its own rows. To revoke:
--   DELETE rp FROM role_permissions rp
--   JOIN permissions p ON p.id = rp.permission_id
--   JOIN roles r       ON r.id = rp.role_id
--   WHERE p.code = 'stafftrack.view' AND r.name = 'MANAGER';


-- ───────────────────────────────────────────────────────────────────────────
-- PART 2 — Read indexes (performance only; no data or schema change)
-- ───────────────────────────────────────────────────────────────────────────
--
-- InnoDB already indexes the foreign keys Staff Track attributes through
-- (orders.created_by, bills.cashier_id, order_status_history.changed_by,
-- audit_logs.user_id), so per-staff lookups are covered. What is missing is
-- the date side: every Staff Track screen is bounded by a date range, and
-- audit_logs in particular is scanned by timestamp on each load.
--
-- MySQL has no CREATE INDEX IF NOT EXISTS. Each block below therefore checks
-- information_schema first and builds the ALTER only when the index is absent,
-- so a second run reports "already present" instead of failing on a duplicate
-- key name. This uses only SET / PREPARE / EXECUTE — no stored procedure and no
-- DELIMITER — so it runs identically in phpMyAdmin, the mysql CLI and a driver.

-- Activity History and the Live Activity window both filter audit_logs by
-- timestamp; the composite serves "one staff member's recent activity", which
-- is the shape the staff detail page and live view ask for.
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_created');
SET @s := IF(@x = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_created (created_at)',
                     'SELECT ''idx_audit_created already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_user_created');
SET @s := IF(@x = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_user_created (user_id, created_at)',
                     'SELECT ''idx_audit_user_created already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_module');
SET @s := IF(@x = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_module (module)',
                     'SELECT ''idx_audit_module already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Order and revenue screens are date-bounded before they are grouped by staff.
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = 'idx_orders_created_by_date');
SET @s := IF(@x = 0, 'ALTER TABLE orders ADD INDEX idx_orders_created_by_date (created_by, created_at)',
                     'SELECT ''idx_orders_created_by_date already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'bills' AND index_name = 'idx_bills_cashier_date');
SET @s := IF(@x = 0, 'ALTER TABLE bills ADD INDEX idx_bills_cashier_date (cashier_id, created_at)',
                     'SELECT ''idx_bills_cashier_date already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Order duration and average service time read the COMPLETED transition.
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'order_status_history' AND index_name = 'idx_osh_order_status');
SET @s := IF(@x = 0, 'ALTER TABLE order_status_history ADD INDEX idx_osh_order_status (order_id, new_status)',
                     'SELECT ''idx_osh_order_status already present'' AS note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ───────────────────────────────────────────────────────────────────────────
-- Verification
-- ───────────────────────────────────────────────────────────────────────────

SELECT r.name AS role_name, p.code AS permission
FROM role_permissions rp
JOIN roles r       ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE p.code = 'stafftrack.view'
ORDER BY r.name;


-- ═══════════════════════════════════════════════════════════════════════════
-- Not included, deliberately
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Staff Track reports only what this system records. The following were left
-- out because closing them means changing flows the brief puts off limits:
--
--   Departments, branches, shifts   no such table or column exists
--   Staff code                      users has username, no separate code
--   Logout / "currently logged in"  /auth/logout writes nothing and JWT is
--                                   stateless, so there is no session to read
--   Table assignment / transfer     dining_tables has no staff column and no
--                                   assignment log; Staff Track therefore
--                                   derives the attending staff member from
--                                   the table's current order and labels that
--                                   derivation in the response
--   Order edits, item add/remove    orders are created then status-changed;
--                                   there is no edit path to record
--   Refund / void                   no such flow exists anywhere in the API
--
-- Each would need a new column or table plus a write from the relevant service.
-- ═══════════════════════════════════════════════════════════════════════════
