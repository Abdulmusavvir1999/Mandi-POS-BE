import { dbService } from './db';
import { logger } from '../config/logger';

export const createSchema = async (): Promise<void> => {
  logger.info('Initializing database schema and indexes...');

  const schemaSql = `
    -- Roles table
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Permissions table
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      module TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Role Permissions junction
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    );

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role_id INTEGER NOT NULL,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    -- Categories table
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      image_url TEXT,
      display_order INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Products table
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sku TEXT UNIQUE NOT NULL,
      description TEXT,
      image_url TEXT,
      cost_price REAL DEFAULT 0.0,
      selling_price REAL NOT NULL,
      tax_rate REAL DEFAULT 5.0,
      stock_quantity INTEGER DEFAULT 0,
      low_stock_threshold INTEGER DEFAULT 10,
      is_available INTEGER DEFAULT 1 CHECK(is_available IN (0, 1)),
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    -- 7. Stock Items Master table
    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      stock_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      unit_type TEXT NOT NULL DEFAULT 'piece',
      current_quantity REAL NOT NULL DEFAULT 0.0,
      current_value REAL NOT NULL DEFAULT 0.0,
      average_unit_price REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      min_stock_alert REAL NOT NULL DEFAULT 10.0,
      product_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    -- 8. Stock Entries (Purchase / Addition Ledger)
    CREATE TABLE IF NOT EXISTS stock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      stock_item_id INTEGER NOT NULL,
      entry_number TEXT UNIQUE NOT NULL,
      entry_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      quantity REAL NOT NULL,
      multiplier REAL NOT NULL DEFAULT 1.0,
      total_quantity REAL NOT NULL,
      total_price REAL NOT NULL,
      unit_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft', 'posted', 'cancelled')),
      supplier TEXT,
      invoice_number TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- 9. Stock Movements (History / Audit Trail)
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      stock_item_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('in', 'out', 'adjustment', 'return', 'wastage', 'transfer_in', 'transfer_out')),
      reference_type TEXT NOT NULL,
      reference_id TEXT,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0.0,
      total_value REAL NOT NULL DEFAULT 0.0,
      balance_quantity REAL NOT NULL,
      balance_value REAL NOT NULL,
      movement_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Legacy Stock tracking table (kept for backward compatibility)
    CREATE TABLE IF NOT EXISTS stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER UNIQUE NOT NULL,
      current_stock INTEGER NOT NULL DEFAULT 0,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      min_stock_alert INTEGER DEFAULT 10,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    -- Legacy Stock transactions history
    CREATE TABLE IF NOT EXISTS stock_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('STOCK_IN', 'SALE', 'ADJUSTMENT', 'RETURN')),
      quantity INTEGER NOT NULL,
      previous_stock INTEGER NOT NULL,
      new_stock INTEGER NOT NULL,
      reference_id TEXT,
      reference_type TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Legacy Stock adjustments
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('INCREASE', 'DECREASE')),
      quantity INTEGER NOT NULL,
      reason TEXT NOT NULL,
      approved_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    );

    -- Customers table
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      address TEXT,
      notes TEXT,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
      total_visits INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Dining Tables
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      section TEXT DEFAULT 'Main Hall',
      capacity INTEGER DEFAULT 4,
      status TEXT DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE', 'SELECTED', 'OCCUPIED', 'UNAVAILABLE')),
      current_order_id INTEGER,
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Orders table
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      dining_table_id INTEGER,
      order_type TEXT NOT NULL CHECK(order_type IN ('WALK_IN', 'TAKEAWAY', 'DINING')),
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
      subtotal REAL NOT NULL DEFAULT 0.0,
      discount_type TEXT DEFAULT 'FIXED' CHECK(discount_type IN ('FIXED', 'PERCENTAGE')),
      discount_value REAL DEFAULT 0.0,
      discount_amount REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total_amount REAL NOT NULL DEFAULT 0.0,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Order Items table
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      unit_price REAL NOT NULL,
      cost_price REAL DEFAULT 0.0,
      quantity INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      discount_amount REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Order Status History
    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      changed_by INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id)
    );

    -- Draft Bills (Hold Bills)
    CREATE TABLE IF NOT EXISTS draft_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      dining_table_id INTEGER,
      order_type TEXT NOT NULL DEFAULT 'WALK_IN' CHECK(order_type IN ('WALK_IN', 'TAKEAWAY', 'DINING')),
      discount_type TEXT DEFAULT 'FIXED' CHECK(discount_type IN ('FIXED', 'PERCENTAGE')),
      discount_value REAL DEFAULT 0.0,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Draft Bill Items
    CREATE TABLE IF NOT EXISTS draft_bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_bill_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      notes TEXT,
      FOREIGN KEY (draft_bill_id) REFERENCES draft_bills(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Bills table
    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT UNIQUE NOT NULL,
      order_id INTEGER UNIQUE NOT NULL,
      customer_id INTEGER,
      dining_table_id INTEGER,
      cashier_id INTEGER NOT NULL,
      order_type TEXT NOT NULL CHECK(order_type IN ('WALK_IN', 'TAKEAWAY', 'DINING')),
      subtotal REAL NOT NULL,
      discount_type TEXT DEFAULT 'FIXED',
      discount_value REAL DEFAULT 0.0,
      discount_amount REAL NOT NULL DEFAULT 0.0,
      tax_amount REAL NOT NULL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      payment_status TEXT DEFAULT 'PAID' CHECK(payment_status IN ('PAID', 'PENDING', 'FAILED', 'REFUNDED')),
      payment_method TEXT NOT NULL CHECK(payment_method IN ('CASH', 'CARD', 'UPI', 'OTHER')),
      notes TEXT,
      printed_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (dining_table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (cashier_id) REFERENCES users(id)
    );

    -- Bill Items table
    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      discount_amount REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Payments table
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('CASH', 'CARD', 'UPI', 'OTHER')),
      amount REAL NOT NULL,
      status TEXT DEFAULT 'PAID' CHECK(status IN ('PAID', 'PENDING', 'FAILED', 'REFUNDED')),
      reference_number TEXT,
      transaction_data TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Queue management
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_number TEXT NOT NULL,
      order_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
      token_type TEXT DEFAULT 'TAKEAWAY',
      estimated_minutes INTEGER DEFAULT 15,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    -- Settings table
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('GENERAL', 'TAX', 'RECEIPT', 'POS', 'THEME')),
      description TEXT,
      is_system INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Audit logs table
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      record_id TEXT,
      old_values TEXT,
      new_values TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Performance Indexes
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

    CREATE INDEX IF NOT EXISTS idx_orders_order_num ON orders(order_number);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(order_type);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(dining_table_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

    CREATE INDEX IF NOT EXISTS idx_bills_bill_num ON bills(bill_number);
    CREATE INDEX IF NOT EXISTS idx_bills_order ON bills(order_id);
    CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);
    CREATE INDEX IF NOT EXISTS idx_bills_payment_method ON bills(payment_method);

    CREATE INDEX IF NOT EXISTS idx_stock_items_code ON stock_items(stock_code);
    CREATE INDEX IF NOT EXISTS idx_stock_items_status ON stock_items(status);
    CREATE INDEX IF NOT EXISTS idx_stock_items_product ON stock_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_entries_item ON stock_entries(stock_item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_entries_number ON stock_entries(entry_number);
    CREATE INDEX IF NOT EXISTS idx_stock_entries_date ON stock_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(movement_type);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(movement_date);

    CREATE INDEX IF NOT EXISTS idx_stock_product ON stock(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_trans_product ON stock_transactions(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_trans_created ON stock_transactions(created_at);

    CREATE INDEX IF NOT EXISTS idx_queue_num ON queue(queue_number);
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_created ON queue(created_at);

    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  `;

  await dbService.executeBatch(schemaSql);
  logger.info('Database schema and performance indexes verified successfully.');
};
