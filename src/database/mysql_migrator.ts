import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DB_HOST = process.env.DB_HOST || '192.168.10.15';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'pos';

export async function runMysqlMigration() {
  console.log(`\n===============================================================`);
  console.log(` Connecting to MySQL Server at ${DB_HOST}:${DB_PORT} (${DB_USER})`);
  console.log(` Target Database: ${DB_NAME}`);
  console.log(` phpMyAdmin: http://${DB_HOST}/phpmyadmin/`);
  console.log(`===============================================================\n`);

  // Connect without DB first to ensure database exists
  const serverConn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
  });

  console.log(`1. Ensuring database \`${DB_NAME}\` exists...`);
  await serverConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await serverConn.end();

  // Connect to target DB
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    multipleStatements: true,
  });

  console.log(`2. Creating all 22+ tables and indexes for Mandi POS in \`${DB_NAME}\`...`);

  const tablesSql = `
    SET FOREIGN_KEY_CHECKS = 0;

    -- 1. Roles table
    CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      description VARCHAR(255),
      is_system TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 2. Permissions table
    CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(100) NOT NULL UNIQUE,
      module VARCHAR(50) NOT NULL,
      description VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 3. Role Permissions junction
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INT NOT NULL,
      permission_id INT NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 4. Users table
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      role_id INT NOT NULL,
      status ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') DEFAULT 'ACTIVE',
      last_login_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES roles(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 5. Categories table
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      icon VARCHAR(50),
      image_url VARCHAR(255),
      display_order INT DEFAULT 0,
      status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 6. Products table
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      sku VARCHAR(50) NOT NULL UNIQUE,
      description TEXT,
      image_url VARCHAR(255),
      cost_price DECIMAL(10,2) DEFAULT 0.00,
      selling_price DECIMAL(10,2) NOT NULL,
      tax_rate DECIMAL(5,2) DEFAULT 5.00,
      stock_quantity INT DEFAULT 0,
      low_stock_threshold INT DEFAULT 10,
      is_available TINYINT(1) DEFAULT 1,
      status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 6b. Dish Variants (portion sizes: Full / Half / ...)
    --     Each variant carries its own price and the amount of the linked
    --     stock item one sale of it consumes.
    CREATE TABLE IF NOT EXISTS product_variants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      name VARCHAR(80) NOT NULL,
      selling_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000,
      display_order INT DEFAULT 0,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_variant_name_per_product (product_id, name),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 7. Stock Items Master table
    CREATE TABLE IF NOT EXISTS stock_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(36) NOT NULL UNIQUE,
      stock_code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      unit_type VARCHAR(50) NOT NULL DEFAULT 'piece',
      current_quantity DECIMAL(12,3) NOT NULL DEFAULT 0.000,
      current_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
      average_unit_price DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      min_stock_alert DECIMAL(12,3) NOT NULL DEFAULT 10.000,
      product_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      INDEX idx_stock_items_code (stock_code),
      INDEX idx_stock_items_status (status),
      INDEX idx_stock_items_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 8. Stock Entries (Purchase / Addition Ledger)
    CREATE TABLE IF NOT EXISTS stock_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(36) NOT NULL UNIQUE,
      stock_item_id INT NOT NULL,
      entry_number VARCHAR(50) NOT NULL UNIQUE,
      entry_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      quantity DECIMAL(12,3) NOT NULL,
      multiplier DECIMAL(12,3) NOT NULL DEFAULT 1.000,
      total_quantity DECIMAL(12,3) NOT NULL,
      total_price DECIMAL(14,2) NOT NULL,
      unit_price DECIMAL(14,4) NOT NULL,
      status ENUM('draft', 'posted', 'cancelled') NOT NULL DEFAULT 'posted',
      supplier VARCHAR(150) NULL,
      invoice_number VARCHAR(100) NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_stock_entries_item (stock_item_id),
      INDEX idx_stock_entries_number (entry_number),
      INDEX idx_stock_entries_date (entry_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 9. Stock Movements (History / Audit Trail)
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(36) NOT NULL UNIQUE,
      stock_item_id INT NOT NULL,
      movement_type ENUM('in', 'out', 'adjustment', 'return', 'wastage', 'transfer_in', 'transfer_out') NOT NULL,
      reference_type VARCHAR(50) NOT NULL,
      reference_id VARCHAR(100) NULL,
      quantity DECIMAL(12,3) NOT NULL,
      unit_price DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
      total_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
      balance_quantity DECIMAL(12,3) NOT NULL,
      balance_value DECIMAL(14,2) NOT NULL,
      movement_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_stock_movements_item (stock_item_id),
      INDEX idx_stock_movements_type (movement_type),
      INDEX idx_stock_movements_date (movement_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- Legacy Stock tracking table (kept for backward compatibility)
    CREATE TABLE IF NOT EXISTS stock (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL UNIQUE,
      current_stock INT NOT NULL DEFAULT 0,
      reserved_stock INT NOT NULL DEFAULT 0,
      min_stock_alert INT DEFAULT 10,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- Legacy Stock transactions history
    CREATE TABLE IF NOT EXISTS stock_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      transaction_type ENUM('STOCK_IN', 'SALE', 'ADJUSTMENT', 'RETURN') NOT NULL,
      quantity INT NOT NULL,
      previous_stock INT NOT NULL,
      new_stock INT NOT NULL,
      reference_id VARCHAR(100),
      reference_type VARCHAR(50),
      notes TEXT,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- Legacy Stock adjustments
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      adjustment_type ENUM('INCREASE', 'DECREASE') NOT NULL,
      quantity INT NOT NULL,
      reason VARCHAR(255) NOT NULL,
      approved_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 10. Customers table
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20) NOT NULL UNIQUE,
      email VARCHAR(100),
      address TEXT,
      notes TEXT,
      status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
      total_visits INT DEFAULT 0,
      total_spent DECIMAL(10,2) DEFAULT 0.00,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 11. Dining Tables
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      table_number VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(50) NOT NULL,
      section VARCHAR(50) DEFAULT 'Main Hall',
      capacity INT DEFAULT 4,
      status ENUM('AVAILABLE', 'SELECTED', 'OCCUPIED', 'UNAVAILABLE') DEFAULT 'AVAILABLE',
      current_order_id INT NULL,
      display_order INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 12. Orders table
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_number VARCHAR(50) NOT NULL UNIQUE,
      customer_id INT NULL,
      dining_table_id INT NULL,
      order_type ENUM('WALK_IN', 'TAKEAWAY', 'DINING') NOT NULL,
      status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') DEFAULT 'PENDING',
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      discount_type ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
      discount_value DECIMAL(10,2) DEFAULT 0.00,
      discount_amount DECIMAL(10,2) DEFAULT 0.00,
      tax_amount DECIMAL(10,2) DEFAULT 0.00,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      notes TEXT,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 13. Order Items table
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(150) NOT NULL,
      variant_id INT NULL,
      variant_name VARCHAR(80) NULL,
      stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000,
      unit_price DECIMAL(10,2) NOT NULL,
      cost_price DECIMAL(10,2) DEFAULT 0.00,
      quantity INT NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      discount_amount DECIMAL(10,2) DEFAULT 0.00,
      tax_amount DECIMAL(10,2) DEFAULT 0.00,
      total_amount DECIMAL(10,2) NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 14. Order Status History
    CREATE TABLE IF NOT EXISTS order_status_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      previous_status VARCHAR(50),
      new_status VARCHAR(50) NOT NULL,
      changed_by INT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 15. Draft Bills
    CREATE TABLE IF NOT EXISTS draft_bills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      draft_number VARCHAR(50) NOT NULL UNIQUE,
      customer_id INT NULL,
      dining_table_id INT NULL,
      order_type ENUM('WALK_IN', 'TAKEAWAY', 'DINING') NOT NULL DEFAULT 'WALK_IN',
      discount_type ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
      discount_value DECIMAL(10,2) DEFAULT 0.00,
      notes TEXT,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 16. Draft Bill Items
    CREATE TABLE IF NOT EXISTS draft_bill_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      draft_bill_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(150) NOT NULL,
      quantity INT NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      notes TEXT,
      FOREIGN KEY (draft_bill_id) REFERENCES draft_bills(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 17. Bills table
    CREATE TABLE IF NOT EXISTS bills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bill_number VARCHAR(50) NOT NULL UNIQUE,
      order_id INT NOT NULL UNIQUE,
      customer_id INT NULL,
      dining_table_id INT NULL,
      cashier_id INT NOT NULL,
      order_type ENUM('WALK_IN', 'TAKEAWAY', 'DINING') NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      discount_type ENUM('FIXED', 'PERCENTAGE') DEFAULT 'FIXED',
      discount_value DECIMAL(10,2) DEFAULT 0.00,
      discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      total_amount DECIMAL(10,2) NOT NULL,
      payment_status ENUM('PAID', 'PENDING', 'FAILED', 'REFUNDED') DEFAULT 'PAID',
      payment_method ENUM('CASH', 'CARD', 'UPI', 'OTHER') NOT NULL,
      notes TEXT,
      printed_count INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (cashier_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 18. Bill Items table
    CREATE TABLE IF NOT EXISTS bill_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bill_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(150) NOT NULL,
      variant_id INT NULL,
      variant_name VARCHAR(80) NULL,
      stock_consumption DECIMAL(12,3) NOT NULL DEFAULT 1.000,
      unit_price DECIMAL(10,2) NOT NULL,
      quantity INT NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      discount_amount DECIMAL(10,2) DEFAULT 0.00,
      tax_amount DECIMAL(10,2) DEFAULT 0.00,
      total_amount DECIMAL(10,2) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 19. Payments table
    CREATE TABLE IF NOT EXISTS payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bill_id INT NOT NULL,
      order_id INT NOT NULL,
      payment_method ENUM('CASH', 'CARD', 'UPI', 'OTHER') NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      status ENUM('PAID', 'PENDING', 'FAILED', 'REFUNDED') DEFAULT 'PAID',
      reference_number VARCHAR(100),
      transaction_data TEXT,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 20. Queue table
    CREATE TABLE IF NOT EXISTS queue (
      id INT AUTO_INCREMENT PRIMARY KEY,
      queue_number VARCHAR(50) NOT NULL,
      order_id INT NULL,
      customer_name VARCHAR(100),
      customer_phone VARCHAR(20),
      status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') DEFAULT 'PENDING',
      token_type VARCHAR(50) DEFAULT 'TAKEAWAY',
      estimated_minutes INT DEFAULT 15,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 21. Settings table
    CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      \`key\` VARCHAR(100) NOT NULL UNIQUE,
      \`value\` TEXT NOT NULL,
      category ENUM('GENERAL', 'TAX', 'RECEIPT', 'POS', 'THEME') NOT NULL,
      description VARCHAR(255),
      is_system TINYINT(1) DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- 22. Audit Logs table
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      module VARCHAR(50) NOT NULL,
      record_id VARCHAR(50),
      old_values TEXT,
      new_values TEXT,
      ip_address VARCHAR(45),
      user_agent VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    SET FOREIGN_KEY_CHECKS = 1;
  `;

  await conn.query(tablesSql);
  console.log(`✅ All MySQL tables and constraints created successfully!`);

  // 3. Seed data
  console.log(`3. Seeding default data (Roles, Permissions, Users, Categories, Dishes, Tables, Settings)...`);

  // Roles
  const roles = [
    { name: 'ADMIN', description: 'System Administrator with full access' },
    { name: 'MANAGER', description: 'Restaurant Manager with operational and report access' },
    { name: 'CASHIER', description: 'Cashier with POS billing and receipt printing access' },
    { name: 'STAFF', description: 'Floor / Kitchen Staff with order status access' },
  ];

  for (const role of roles) {
    await conn.query(`INSERT IGNORE INTO roles (name, description) VALUES (?, ?)`, [role.name, role.description]);
  }

  // Permissions
  const permissions = [
    { code: 'pos.billing', module: 'POS', description: 'Create and process POS orders & checkout' },
    { code: 'pos.hold_bill', module: 'POS', description: 'Hold and resume draft bills' },
    { code: 'pos.discount', module: 'POS', description: 'Apply bill and item discounts' },
    { code: 'pos.reprint', module: 'POS', description: 'Reprint completed customer receipts' },
    { code: 'order.view', module: 'ORDERS', description: 'View live order pipeline' },
    { code: 'order.manage', module: 'ORDERS', description: 'Update order status & cancel orders' },
    { code: 'bill.view', module: 'BILLS', description: 'View all past sales bills & invoices' },
    { code: 'bill.refund', module: 'BILLS', description: 'Process payment refunds' },
    { code: 'dining.view', module: 'DINING', description: 'View dining table map' },
    { code: 'dining.manage', module: 'DINING', description: 'Manage table status and layout' },
    { code: 'queue.view', module: 'QUEUE', description: 'View takeaway token queue' },
    { code: 'queue.manage', module: 'QUEUE', description: 'Call, process and complete tokens' },
    { code: 'product.view', module: 'PRODUCTS', description: 'View products catalog' },
    { code: 'product.manage', module: 'PRODUCTS', description: 'Create, edit and delete products' },
    { code: 'category.manage', module: 'CATEGORIES', description: 'Manage product categories' },
    { code: 'stock.view', module: 'STOCK', description: 'View stock levels & low stock alerts' },
    { code: 'stock.manage', module: 'STOCK', description: 'Perform stock adjustments & view history' },
    { code: 'customer.manage', module: 'CUSTOMERS', description: 'Manage customer database' },
    { code: 'report.view', module: 'REPORTS', description: 'View daily sales, summary & export reports' },
    { code: 'user.manage', module: 'USERS', description: 'Manage system users and role assignments' },
    { code: 'settings.manage', module: 'SETTINGS', description: 'Manage restaurant profile, tax and receipt configuration' },
    { code: 'dashboard.view', module: 'DASHBOARD', description: 'Access executive analytics dashboard' },
  ];

  for (const perm of permissions) {
    await conn.query(`INSERT IGNORE INTO permissions (code, module, description) VALUES (?, ?, ?)`, [
      perm.code,
      perm.module,
      perm.description,
    ]);
  }

  // Assign permissions to Admin, Manager, Cashier, Staff
  const [adminRoleRow]: any = await conn.query(`SELECT id FROM roles WHERE name = 'ADMIN' LIMIT 1`);
  const [managerRoleRow]: any = await conn.query(`SELECT id FROM roles WHERE name = 'MANAGER' LIMIT 1`);
  const [cashierRoleRow]: any = await conn.query(`SELECT id FROM roles WHERE name = 'CASHIER' LIMIT 1`);
  const [staffRoleRow]: any = await conn.query(`SELECT id FROM roles WHERE name = 'STAFF' LIMIT 1`);
  const [allPerms]: any = await conn.query(`SELECT id, code FROM permissions`);

  if (adminRoleRow.length > 0) {
    const adminRoleId = adminRoleRow[0].id;
    for (const p of allPerms) {
      await conn.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, [adminRoleId, p.id]);
    }
  }

  if (managerRoleRow.length > 0) {
    const managerRoleId = managerRoleRow[0].id;
    for (const p of allPerms) {
      if (p.code !== 'user.manage' && p.code !== 'settings.manage') {
        await conn.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, [managerRoleId, p.id]);
      }
    }
  }

  if (cashierRoleRow.length > 0) {
    const cashierRoleId = cashierRoleRow[0].id;
    const cashierCodes = [
      'pos.billing', 'pos.hold_bill', 'pos.discount', 'pos.reprint',
      'order.view', 'order.manage', 'bill.view', 'dining.view', 'dining.manage',
      'queue.view', 'queue.manage', 'product.view', 'stock.view', 'customer.manage'
    ];
    for (const p of allPerms) {
      if (cashierCodes.includes(p.code)) {
        await conn.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, [cashierRoleId, p.id]);
      }
    }
  }

  if (staffRoleRow.length > 0) {
    const staffRoleId = staffRoleRow[0].id;
    const staffCodes = ['order.view', 'order.manage', 'dining.view', 'queue.view', 'product.view'];
    for (const p of allPerms) {
      if (staffCodes.includes(p.code)) {
        await conn.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, [staffRoleId, p.id]);
      }
    }
  }

  // Users
  const [rolesList]: any = await conn.query(`SELECT id, name FROM roles`);
  const roleMap: Record<string, number> = {};
  rolesList.forEach((r: any) => {
    roleMap[r.name] = r.id;
  });

  const users = [
    { username: 'admin', email: 'admin@baitmandi.com', name: 'Al-Mandi Administrator', role: 'ADMIN', pass: 'Super@123', phone: '+966500112233' },
    { username: 'cashier', email: 'cashier@baitmandi.com', name: 'Zaid Al-Harbi (Cashier 1)', role: 'CASHIER', pass: 'Cashier@123', phone: '+966500112244' },
    { username: 'manager', email: 'manager@baitmandi.com', name: 'Tariq Al-Mansoor (Manager)', role: 'MANAGER', pass: 'Manager@123', phone: '+966500112255' },
    { username: 'staff', email: 'staff@baitmandi.com', name: 'Omar Kitchen / Floor', role: 'STAFF', pass: 'Staff@123', phone: '+966500112266' },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.pass, 10);
    const roleId = roleMap[u.role] || 1;
    await conn.query(
      `INSERT IGNORE INTO users (username, email, password_hash, name, phone, role_id, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [u.username, u.email, hash, u.name, u.phone, roleId]
    );
  }

  // Categories
  const categories = [
    { name: 'Mutton Mandi', icon: '🍖', desc: 'Slow-cooked succulent tender lamb & rice', order: 1 },
    { name: 'Chicken Mandi', icon: '🍗', desc: 'Traditional spiced roast chicken mandi', order: 2 },
    { name: 'Madfoon & Madhbi', icon: '🔥', desc: 'Stone grilled & buried pot delicacies', order: 3 },
    { name: 'Appetizers & Salads', icon: '🥗', desc: 'Daqoos, fresh salads, tahini, soup', order: 4 },
    { name: 'Desserts & Sweets', icon: '🍯', desc: 'Kunafa, Baklava, Creamy Muhallabia', order: 5 },
    { name: 'Beverages & Drinks', icon: '🥤', desc: 'Fresh laban, mint lemonade, Arabic tea', order: 6 },
  ];

  for (const c of categories) {
    await conn.query(
      `INSERT IGNORE INTO categories (name, description, icon, display_order, status) VALUES (?, ?, ?, ?, 'ACTIVE')`,
      [c.name, c.desc, c.icon, c.order]
    );
  }

  // Products
  const [catRows]: any = await conn.query(`SELECT id, name FROM categories`);
  const catMap: Record<string, number> = {};
  catRows.forEach((c: any) => {
    catMap[c.name] = c.id;
  });

  const products = [
    { name: 'Royal Mutton Mandi (Full)', sku: 'MM-ROYAL-F', cat: 'Mutton Mandi', cost: 110.0, price: 165.0, stock: 45 },
    { name: 'Royal Mutton Mandi (Half)', sku: 'MM-ROYAL-H', cat: 'Mutton Mandi', cost: 60.0, price: 90.0, stock: 60 },
    { name: 'Special Mutton Shoulder Mandi', sku: 'MM-SHLDR', cat: 'Mutton Mandi', cost: 130.0, price: 195.0, stock: 20 },
    { name: 'Chicken Mandi (Full)', sku: 'CM-FULL', cat: 'Chicken Mandi', cost: 38.0, price: 58.0, stock: 80 },
    { name: 'Chicken Mandi (Half)', sku: 'CM-HALF', cat: 'Chicken Mandi', cost: 20.0, price: 32.0, stock: 110 },
    { name: 'Chicken Madhbi On Charcoal (Full)', sku: 'CMD-FULL', cat: 'Madfoon & Madhbi', cost: 42.0, price: 62.0, stock: 55 },
    { name: 'Mutton Madfoon in Foil Wrap', sku: 'MMD-WRAP', cat: 'Madfoon & Madhbi', cost: 120.0, price: 180.0, stock: 30 },
    { name: 'Spicy Tomato Daqoos Sauce', sku: 'APP-DAQOOS', cat: 'Appetizers & Salads', cost: 2.0, price: 5.0, stock: 300 },
    { name: 'Arabic Fresh Garden Salad', sku: 'APP-SALAD', cat: 'Appetizers & Salads', cost: 4.0, price: 12.0, stock: 150 },
    { name: 'Creamy Tahini Dip Plate', sku: 'APP-TAHINI', cat: 'Appetizers & Salads', cost: 3.0, price: 8.0, stock: 200 },
    { name: 'Crispy Cheese Kunafa with Syrup', sku: 'DST-KUNAFA', cat: 'Desserts & Sweets', cost: 12.0, price: 28.0, stock: 40 },
    { name: 'Pistachio Baklava Plate (4 Pcs)', sku: 'DST-BAKLAVA', cat: 'Desserts & Sweets', cost: 10.0, price: 22.0, stock: 50 },
    { name: 'Fresh Village Ayran Laban (Bottle)', sku: 'BEV-LABAN', cat: 'Beverages & Drinks', cost: 2.5, price: 6.0, stock: 250 },
    { name: 'Fresh Mint Lime Juice (Chilled)', sku: 'BEV-MINTLIME', cat: 'Beverages & Drinks', cost: 4.0, price: 14.0, stock: 100 },
    { name: 'Traditional Arabic Red Tea Pot', sku: 'BEV-TEA', cat: 'Beverages & Drinks', cost: 2.0, price: 8.0, stock: 200 },
  ];

  for (const p of products) {
    const catId = catMap[p.cat] || 1;
    await conn.query(
      `INSERT IGNORE INTO products (category_id, name, sku, cost_price, selling_price, tax_rate, stock_quantity, low_stock_threshold, is_available, status)
       VALUES (?, ?, ?, ?, ?, 5.00, ?, 10, 1, 'ACTIVE')`,
      [catId, p.name, p.sku, p.cost, p.price, p.stock]
    );

    const [prodRow]: any = await conn.query(`SELECT id FROM products WHERE sku = ? LIMIT 1`, [p.sku]);
    if (prodRow.length > 0) {
      const prodId = prodRow[0].id;
      await conn.query(
        `INSERT IGNORE INTO stock (product_id, current_stock, reserved_stock, min_stock_alert) VALUES (?, ?, 0, 10)`,
        [prodId, p.stock]
      );

      // Seed 3-Tier Stock Master (stock_items)
      const stockCode = `STK-${String(prodId).padStart(4, '0')}`;
      const itemUuid = `item-${prodId}-${Date.now().toString(36)}`;
      const totalVal = p.stock * p.cost;
      const unitType = p.cat.includes('Beverages') ? 'liter' : p.cat.includes('Appetizers') ? 'portion' : 'piece';

      await conn.query(
        `INSERT IGNORE INTO stock_items (uuid, stock_code, name, unit_type, current_quantity, current_value, average_unit_price, status, min_stock_alert, product_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 10.0, ?)`,
        [itemUuid, stockCode, p.name, unitType, p.stock, totalVal, p.cost, prodId]
      );

      const [stkItemRow]: any = await conn.query(`SELECT id FROM stock_items WHERE stock_code = ? LIMIT 1`, [stockCode]);
      if (stkItemRow.length > 0) {
        const stkId = stkItemRow[0].id;
        const entryNum = `ENT-${String(prodId).padStart(4, '0')}-INIT`;
        const entryUuid = `entry-${prodId}-${Date.now().toString(36)}`;
        const moveUuid = `move-${prodId}-${Date.now().toString(36)}`;

        await conn.query(
          `INSERT IGNORE INTO stock_entries (uuid, stock_item_id, entry_number, quantity, multiplier, total_quantity, total_price, unit_price, status, supplier, notes, created_by)
           VALUES (?, ?, ?, ?, 1.000, ?, ?, ?, 'posted', 'Primary Supplier Wholesale', 'Initial opening stock ledger entry', 1)`,
          [entryUuid, stkId, entryNum, p.stock, p.stock, totalVal, p.cost]
        );

        await conn.query(
          `INSERT IGNORE INTO stock_movements (uuid, stock_item_id, movement_type, reference_type, reference_id, quantity, unit_price, total_value, balance_quantity, balance_value, notes, created_by)
           VALUES (?, ?, 'in', 'PURCHASE_ENTRY', ?, ?, ?, ?, ?, ?, 'Initial inventory stock addition', 1)`,
          [moveUuid, stkId, entryNum, p.stock, p.cost, totalVal, p.stock, totalVal]
        );
      }
    }
  }

  // Dining Tables
  const tables = [
    { num: 'T-01', name: 'VIP Majlis 1', sec: 'VIP Section', cap: 8, order: 1 },
    { num: 'T-02', name: 'VIP Majlis 2', sec: 'VIP Section', cap: 8, order: 2 },
    { num: 'T-03', name: 'Family Booth 1', sec: 'Family Section', cap: 6, order: 3 },
    { num: 'T-04', name: 'Family Booth 2', sec: 'Family Section', cap: 6, order: 4 },
    { num: 'T-05', name: 'Family Booth 3', sec: 'Family Section', cap: 6, order: 5 },
    { num: 'T-06', name: 'Main Hall Table 1', sec: 'Main Hall', cap: 4, order: 6 },
    { num: 'T-07', name: 'Main Hall Table 2', sec: 'Main Hall', cap: 4, order: 7 },
    { num: 'T-08', name: 'Main Hall Table 3', sec: 'Main Hall', cap: 4, order: 8 },
    { num: 'T-09', name: 'Outdoor Terrace 1', sec: 'Outdoor Terrace', cap: 4, order: 9 },
    { num: 'T-10', name: 'Outdoor Terrace 2', sec: 'Outdoor Terrace', cap: 4, order: 10 },
  ];

  for (const t of tables) {
    await conn.query(
      `INSERT IGNORE INTO dining_tables (table_number, name, section, capacity, status, display_order) VALUES (?, ?, ?, ?, 'AVAILABLE', ?)`,
      [t.num, t.name, t.sec, t.cap, t.order]
    );
  }

  // Settings
  const settings = [
    { key: 'restaurant_name', value: 'Bait Al Mandi Restaurant & Grill', cat: 'GENERAL', desc: 'Brand restaurant display name' },
    { key: 'currency_symbol', value: 'SAR', cat: 'GENERAL', desc: 'Default currency symbol (e.g., SAR, USD, AED, ₹)' },
    { key: 'tax_rate_percentage', value: '5.0', cat: 'TAX', desc: 'Standard VAT/Tax percentage applied' },
    { key: 'tax_identification_number', value: '310998822400003', cat: 'TAX', desc: 'Official VAT / Tax Identification Number' },
    { key: 'receipt_header_title', value: 'بيت المندي — BAIT AL MANDI', cat: 'RECEIPT', desc: 'Printed thermal header name' },
    { key: 'receipt_tagline', value: 'Authentic Yemeni & Gulf Charcoal Grills', cat: 'RECEIPT', desc: 'Receipt sub-header text' },
    { key: 'receipt_footer_note', value: 'Thank you for dining with us! Come again.', cat: 'RECEIPT', desc: 'Bottom thermal receipt message' },
    { key: 'receipt_phone', value: '+966 11 456 7890 / +966 50 123 4567', cat: 'RECEIPT', desc: 'Support & takeaway phone number' },
    { key: 'receipt_address', value: 'King Fahd Road, Al-Olaya Dist, Riyadh, KSA', cat: 'RECEIPT', desc: 'Store physical branch address' },
    { key: 'thermal_printer_paper_width', value: '80mm', cat: 'RECEIPT', desc: 'Thermal printer width (80mm / 58mm)' },
    { key: 'system_theme', value: '{"primary":"#D97706","primaryHover":"#EA580C","sidebarBg":"#1C1917","sidebarText":"#F5F5F4","sidebarActiveAccent":"#F59E0B","bgApp":"#F8F7F4","cardBg":"#FFFFFF","cardBorder":"#E7E5E4","textMain":"#1C1917","success":"#15803D","danger":"#DC2626","warning":"#D97706"}', cat: 'THEME', desc: 'Full UI theme palette stored as JSON (overrides individual THEME_* keys)' },
  ];

  for (const s of settings) {
    await conn.query(
      `INSERT IGNORE INTO settings (\`key\`, \`value\`, category, description, is_system) VALUES (?, ?, ?, ?, 1)`,
      [s.key, s.value, s.cat, s.desc]
    );
  }

  // Customers
  const customers = [
    { name: 'Sheikh Hamdan Al-Dosari', phone: '+966555123456', email: 'hamdan@example.com', visits: 14, spent: 2350.0 },
    { name: 'Fahad Al-Shehri', phone: '+966555654321', email: 'fahad@example.com', visits: 8, spent: 1120.0 },
    { name: 'Majed Al-Ghamdi', phone: '+966555987654', email: 'majed@example.com', visits: 5, spent: 680.0 },
  ];

  for (const cu of customers) {
    await conn.query(
      `INSERT IGNORE INTO customers (name, phone, email, status, total_visits, total_spent) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      [cu.name, cu.phone, cu.email, cu.visits, cu.spent]
    );
  }

  const [tableCount]: any = await conn.query(`SHOW TABLES;`);
  console.log(`\n🎉 MySQL Database Setup Complete! Total tables in \`${DB_NAME}\`: ${tableCount.length}`);
  for (const row of tableCount) {
    console.log(`  - ${Object.values(row)[0]}`);
  }

  await conn.end();
}

if (require.main === module) {
  runMysqlMigration()
    .then(() => {
      console.log('\n✅ Migration finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Migration failed:', err);
      process.exit(1);
    });
}
