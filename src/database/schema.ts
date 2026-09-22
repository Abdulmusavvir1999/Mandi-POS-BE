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
      is_system INTEGER DEFAULT 0,
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
      stock_item_id INTEGER,
      variant_stock_mode TEXT DEFAULT 'COMMON' CHECK(variant_stock_mode IN ('COMMON', 'EACH')),
      is_available INTEGER DEFAULT 1 CHECK(is_available IN (0, 1)),
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    -- Dish Variants table (portion sizes: Full / Half / ...)
    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      stock_item_id INTEGER,
      selling_price REAL NOT NULL DEFAULT 0.0,
      stock_consumption REAL NOT NULL DEFAULT 1.0,
      display_order INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    -- Stock Items Master table
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
      reorder_level REAL NOT NULL DEFAULT 15.0,
      reorder_quantity REAL NOT NULL DEFAULT 50.0,
      max_stock_threshold REAL NOT NULL DEFAULT 100.0,
      shelf_life_days INTEGER,
      product_id INTEGER,
      default_vendor_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      FOREIGN KEY (default_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
    );

    -- Stock Entries (Purchase / Addition Ledger)
    CREATE TABLE IF NOT EXISTS stock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      stock_item_id INTEGER NOT NULL,
      entry_number TEXT UNIQUE NOT NULL,
      entry_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiry_date DATE,
      batch_number TEXT,
      quantity REAL NOT NULL,
      multiplier REAL NOT NULL DEFAULT 1.0,
      total_quantity REAL NOT NULL,
      total_price REAL NOT NULL,
      unit_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft', 'posted', 'cancelled')),
      supplier TEXT,
      vendor_id INTEGER,
      invoice_number TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id),
      -- vendors is declared further down this file; SQLite resolves the
      -- reference at insert time, not at CREATE time, so the order is fine.
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
    );

    -- Stock Movements (History / Audit Trail)
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

    -- Vendors table
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      vendor_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General Supplies',
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
      image_url TEXT,
      notes TEXT,
      contact_person TEXT,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      website TEXT,
      tax_id TEXT,
      pan_number TEXT,
      tax_category TEXT DEFAULT 'STANDARD',
      msme_number TEXT,
      payment_terms TEXT DEFAULT 'NET_30',
      preferred_payment_method TEXT DEFAULT 'BANK_TRANSFER',
      bank_name TEXT,
      account_number TEXT,
      ifsc_code TEXT,
      branch_name TEXT,
      upi_id TEXT,
      credit_limit REAL NOT NULL DEFAULT 0.0,
      credit_period_days INTEGER NOT NULL DEFAULT 30,
      outstanding_balance REAL NOT NULL DEFAULT 0.0,
      total_purchases_amount REAL NOT NULL DEFAULT 0.0,
      total_purchases_count INTEGER NOT NULL DEFAULT 0,
      last_purchase_date DATETIME,
      last_payment_date DATETIME,
      rating REAL NOT NULL DEFAULT 5.0,
      delivery_speed_rating REAL NOT NULL DEFAULT 5.0,
      quality_rating REAL NOT NULL DEFAULT 5.0,
      pricing_rating REAL NOT NULL DEFAULT 5.0,
      on_time_delivery_rate REAL NOT NULL DEFAULT 100.0,
      quality_score REAL NOT NULL DEFAULT 100.0,
      fulfillment_rate REAL NOT NULL DEFAULT 100.0,
      performance_notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Vendor Purchases (Invoices Ledger)
    CREATE TABLE IF NOT EXISTS vendor_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      vendor_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL,
      order_date DATETIME NOT NULL,
      due_date DATETIME,
      total_amount REAL NOT NULL DEFAULT 0.0,
      paid_amount REAL NOT NULL DEFAULT 0.0,
      balance_amount REAL NOT NULL DEFAULT 0.0,
      payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN ('PAID', 'PARTIAL', 'UNPAID', 'OVERDUE')),
      delivery_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(delivery_status IN ('RECEIVED', 'PENDING', 'CANCELLED')),
      items_summary TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Vendor Payments (Disbursements Ledger)
    CREATE TABLE IF NOT EXISTS vendor_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      vendor_id INTEGER NOT NULL,
      purchase_id INTEGER,
      payment_number TEXT UNIQUE NOT NULL,
      payment_date DATETIME NOT NULL,
      amount REAL NOT NULL DEFAULT 0.0,
      payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
      reference_number TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
      FOREIGN KEY (purchase_id) REFERENCES vendor_purchases(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Customers table
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      address TEXT,
      notes TEXT,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
      tier TEXT DEFAULT 'REGULAR',
      loyalty_points INTEGER DEFAULT 0,
      last_visit_at DATETIME,
      total_visits INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Customer Notes table
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      user_id INTEGER,
      author_name TEXT,
      note_type TEXT NOT NULL DEFAULT 'GENERAL',
      note_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Dining Tables
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      section TEXT DEFAULT 'Main Hall',
      capacity INTEGER DEFAULT 4,
      active_guest_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'AVAILABLE',
      current_order_id INTEGER,
      seated_at DATETIME,
      cleaning_started_at DATETIME,
      reservation_id INTEGER,
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Table Reservations
    CREATE TABLE IF NOT EXISTS table_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      reservation_code TEXT UNIQUE NOT NULL,
      table_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      guest_count INTEGER NOT NULL DEFAULT 2,
      reservation_time DATETIME NOT NULL,
      preferred_section TEXT,
      special_requests TEXT,
      status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW')),
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (table_id) REFERENCES dining_tables(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Orders table
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      dining_table_id INTEGER,
      order_type TEXT NOT NULL,
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
      variant_id INTEGER,
      variant_name TEXT,
      stock_consumption REAL DEFAULT 1.0,
      unit_price REAL NOT NULL,
      cost_price REAL DEFAULT 0.0,
      quantity INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      discount_amount REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      addons_data TEXT,
      item_type TEXT DEFAULT 'PRODUCT',
      combo_id INTEGER,
      -- Legacy: Meal Deals were withdrawn, but settled sales still carry it.
      deal_id INTEGER,
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
      order_type TEXT NOT NULL DEFAULT 'TAKEAWAY',
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
      order_type TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount_type TEXT DEFAULT 'FIXED',
      discount_value REAL DEFAULT 0.0,
      discount_amount REAL NOT NULL DEFAULT 0.0,
      tax_amount REAL NOT NULL DEFAULT 0.0,
      service_charge_amount REAL DEFAULT 0.0,
      surcharge_amount REAL DEFAULT 0.0,
      coupon_code TEXT,
      coupon_discount REAL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      payment_status TEXT DEFAULT 'PAID',
      payment_method TEXT NOT NULL,
      cash_tendered REAL,
      change_returned REAL,
      payment_reference TEXT,
      notes TEXT,
      is_voided INTEGER DEFAULT 0,
      void_reason TEXT,
      void_by INTEGER,
      void_at DATETIME,
      is_reopened INTEGER DEFAULT 0,
      reopened_from_bill_id INTEGER,
      reopened_at DATETIME,
      offline_sync_id TEXT,
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
      variant_id INTEGER,
      variant_name TEXT,
      stock_consumption REAL DEFAULT 1.0,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      discount_amount REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      is_complimentary INTEGER DEFAULT 0,
      complimentary_reason TEXT,
      addons_data TEXT,
      item_type TEXT DEFAULT 'PRODUCT',
      combo_id INTEGER,
      -- Legacy: Meal Deals were withdrawn, but settled sales still carry it.
      deal_id INTEGER,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Product Add-ons
    CREATE TABLE IF NOT EXISTS product_addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Sides',
      price REAL NOT NULL DEFAULT 0.0,
      cost_price REAL NOT NULL DEFAULT 0.0,
      image_url TEXT,
      is_available INTEGER DEFAULT 1,
      stock_item_id INTEGER,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Add-on Mappings
    CREATE TABLE IF NOT EXISTS product_addon_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      addon_id INTEGER NOT NULL,
      product_id INTEGER,
      category_id INTEGER,
      is_global INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (addon_id) REFERENCES product_addons(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    -- Combo Deals
    CREATE TABLE IF NOT EXISTS combo_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      combo_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      category_id INTEGER,
      original_price REAL NOT NULL DEFAULT 0.0,
      combo_price REAL NOT NULL DEFAULT 0.0,
      savings_amount REAL NOT NULL DEFAULT 0.0,
      is_available INTEGER DEFAULT 1,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Combo Deal Items
    CREATE TABLE IF NOT EXISTS combo_deal_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      combo_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      variant_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER DEFAULT 0,
      FOREIGN KEY (combo_id) REFERENCES combo_deals(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
    );

    -- Payments table
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'PAID',
      reference_number TEXT,
      transaction_data TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- POS Day Closing (Z-Report / Shift Close) table
    CREATE TABLE IF NOT EXISTS pos_day_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      closing_number TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      cashier_name TEXT,
      opening_time DATETIME NOT NULL,
      closing_time DATETIME NOT NULL,
      opening_cash REAL DEFAULT 0.0,
      total_cash_sales REAL DEFAULT 0.0,
      total_card_sales REAL DEFAULT 0.0,
      total_upi_sales REAL DEFAULT 0.0,
      total_online_sales REAL DEFAULT 0.0,
      gross_sales REAL DEFAULT 0.0,
      total_discounts REAL DEFAULT 0.0,
      total_tax REAL DEFAULT 0.0,
      total_service_charges REAL DEFAULT 0.0,
      total_bills_count INTEGER DEFAULT 0,
      void_bills_count INTEGER DEFAULT 0,
      void_bills_amount REAL DEFAULT 0.0,
      expected_cash REAL DEFAULT 0.0,
      actual_cash REAL DEFAULT 0.0,
      cash_variance REAL DEFAULT 0.0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
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
    CREATE INDEX IF NOT EXISTS idx_product_variants_prod ON product_variants(product_id);

    CREATE INDEX IF NOT EXISTS idx_orders_order_num ON orders(order_number);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(order_type);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(dining_table_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_created_by_date ON orders(created_by, created_at);

    CREATE INDEX IF NOT EXISTS idx_bills_bill_num ON bills(bill_number);
    CREATE INDEX IF NOT EXISTS idx_bills_order ON bills(order_id);
    CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);
    CREATE INDEX IF NOT EXISTS idx_bills_payment_method ON bills(payment_method);
    CREATE INDEX IF NOT EXISTS idx_bills_offline_sync ON bills(offline_sync_id);
    CREATE INDEX IF NOT EXISTS idx_bills_voided ON bills(is_voided);
    CREATE INDEX IF NOT EXISTS idx_bills_cashier_date ON bills(cashier_id, created_at);

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

    CREATE INDEX IF NOT EXISTS idx_vendors_code ON vendors(vendor_code);
    CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name);
    CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors(category);
    CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
    CREATE INDEX IF NOT EXISTS idx_vendors_phone ON vendors(phone);

    CREATE INDEX IF NOT EXISTS idx_vp_vendor_id ON vendor_purchases(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_vp_invoice ON vendor_purchases(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_vp_payment_status ON vendor_purchases(payment_status);
    CREATE INDEX IF NOT EXISTS idx_vp_order_date ON vendor_purchases(order_date);

    CREATE INDEX IF NOT EXISTS idx_vpay_vendor_id ON vendor_payments(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_vpay_purchase_id ON vendor_payments(purchase_id);
    CREATE INDEX IF NOT EXISTS idx_vpay_date ON vendor_payments(payment_date);

    CREATE INDEX IF NOT EXISTS idx_tr_time ON table_reservations(reservation_time);
    CREATE INDEX IF NOT EXISTS idx_tr_table ON table_reservations(table_id);
    CREATE INDEX IF NOT EXISTS idx_tr_status ON table_reservations(status);

    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_customers_code ON customers(customer_code);
    CREATE INDEX IF NOT EXISTS idx_customers_tier ON customers(tier);
    CREATE INDEX IF NOT EXISTS idx_cust_notes_cid ON customer_notes(customer_id);

    CREATE INDEX IF NOT EXISTS idx_queue_num ON queue(queue_number);
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_created ON queue(created_at);

    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module);

    CREATE INDEX IF NOT EXISTS idx_osh_order_status ON order_status_history(order_id, new_status);

    CREATE INDEX IF NOT EXISTS idx_day_closing_user ON pos_day_closings(user_id);
    CREATE INDEX IF NOT EXISTS idx_day_closing_created ON pos_day_closings(created_at);

    CREATE INDEX IF NOT EXISTS idx_addon_name ON product_addons(name);
    CREATE INDEX IF NOT EXISTS idx_addon_category ON product_addons(category);
    CREATE INDEX IF NOT EXISTS idx_addon_status ON product_addons(status);

    CREATE INDEX IF NOT EXISTS idx_combo_deal_code ON combo_deals(combo_code);
    CREATE INDEX IF NOT EXISTS idx_combo_deal_status ON combo_deals(status);
    CREATE INDEX IF NOT EXISTS idx_cdi_combo ON combo_deal_items(combo_id);
    CREATE INDEX IF NOT EXISTS idx_cdi_product ON combo_deal_items(product_id);


    CREATE INDEX IF NOT EXISTS idx_stock_entries_expiry ON stock_entries(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_entries_vendor ON stock_entries(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_stock_items_reorder ON stock_items(reorder_level, current_quantity);
    CREATE INDEX IF NOT EXISTS idx_stock_items_default_vendor ON stock_items(default_vendor_id);
  `;

  await dbService.executeBatch(schemaSql);
  logger.info('Database schema and performance indexes verified successfully.');
};
