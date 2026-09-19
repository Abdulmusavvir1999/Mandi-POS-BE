import bcrypt from 'bcryptjs';
import { dbService } from './db';
import { createSchema } from './schema';
import { logger } from '../config/logger';

export const seedDatabase = async (): Promise<void> => {
  await dbService.initialize();
  createSchema();

  const userCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM users');
  if (userCount && userCount.count > 0) {
    logger.info('Database already seeded. Skipping initial seeding.');
    return;
  }

  logger.info('Seeding database with default roles, permissions, master data, products, tables, and settings...');

  await dbService.transaction(async () => {
    // 1. Roles - seeded roles are system roles and do not count towards the
    //    manual role limit (see MAX_CUSTOM_ROLES in roles.controller.ts).
    await dbService.execute("INSERT INTO roles (name, description, is_system) VALUES ('ADMIN', 'Full Administrator with unrestricted system access', 1)");
    await dbService.execute("INSERT INTO roles (name, description, is_system) VALUES ('MANAGER', 'Store Manager with inventory, dining, reports, and operational control', 1)");
    await dbService.execute("INSERT INTO roles (name, description, is_system) VALUES ('CASHIER', 'POS Cashier with billing, payment, draft bill, and customer management access', 1)");
    await dbService.execute("INSERT INTO roles (name, description, is_system) VALUES ('STAFF', 'Floor & Kitchen Staff with order queue and table status access', 1)");

    const adminRole = await dbService.queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'ADMIN'")!;
    const managerRole = await dbService.queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'MANAGER'")!;
    const cashierRole = await dbService.queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'CASHIER'")!;
    const staffRole = await dbService.queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'STAFF'")!;

    // 2. Permissions
    const permissions = [
      { code: 'auth.login', module: 'AUTH', desc: 'Login to system' },
      { code: 'auth.change_password', module: 'AUTH', desc: 'Change password' },
      { code: 'user.manage', module: 'USERS', desc: 'Manage user accounts and roles' },
      { code: 'product.manage', module: 'PRODUCTS', desc: 'Manage products and pricing' },
      { code: 'category.manage', module: 'CATEGORIES', desc: 'Manage product categories' },
      { code: 'stock.manage', module: 'STOCK', desc: 'Perform stock in, adjustments and audits' },
      { code: 'stock.view', module: 'STOCK', desc: 'View inventory and low stock alerts' },
      { code: 'customer.manage', module: 'CUSTOMERS', desc: 'Manage customer records' },
      { code: 'dining.manage', module: 'DINING', desc: 'Manage tables and dining layout' },
      { code: 'pos.billing', module: 'POS', desc: 'Create and process POS sales' },
      { code: 'pos.hold_bill', module: 'POS', desc: 'Hold and resume draft bills' },
      { code: 'pos.discount', module: 'POS', desc: 'Apply discounts to orders' },
      { code: 'order.manage', module: 'ORDERS', desc: 'Process and update order statuses' },
      { code: 'bill.view', module: 'BILLS', desc: 'View sales bills and receipts' },
      { code: 'bill.print', module: 'BILLS', desc: 'Print and reprint bills' },
      { code: 'queue.manage', module: 'QUEUE', desc: 'Manage takeaway token queue' },
      { code: 'report.view', module: 'REPORTS', desc: 'View sales, stock and financial reports' },
      { code: 'dashboard.view', module: 'DASHBOARD', desc: 'View analytics dashboard' },
      { code: 'settings.manage', module: 'SETTINGS', desc: 'Configure system, tax and theme settings' },
      { code: 'audit.view', module: 'AUDIT', desc: 'View security and change audit logs' },
      { code: 'stafftrack.view', module: 'STAFF_TRACK', desc: 'View staff activity, order and revenue tracking' },
      { code: 'vendor.view', module: 'VENDORS', desc: 'View vendor list, profiles, ratings and purchase records' },
      { code: 'vendor.manage', module: 'VENDORS', desc: 'Create, edit, delete vendors and record purchases and payments' },
    ];

    for (const p of permissions) {
      await dbService.execute('INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)', [p.code, p.module, p.desc]);
    }

    const allPerms = await dbService.query<{ id: number; code: string }>('SELECT id, code FROM permissions');

    // Assign all to ADMIN
    for (const p of allPerms) {
      await dbService.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [adminRole!.id, p.id]);
    }

    // Assign MANAGER perms
    for (const p of allPerms) {
      if (!['user.manage', 'settings.manage', 'audit.view'].includes(p.code)) {
        await dbService.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [managerRole!.id, p.id]);
      }
    }

    // Assign CASHIER perms
    const cashierCodes = ['auth.login', 'auth.change_password', 'pos.billing', 'pos.hold_bill', 'pos.discount', 'customer.manage', 'vendor.view', 'bill.view', 'bill.print', 'order.manage', 'queue.manage', 'dining.manage', 'stock.view'];
    for (const p of allPerms) {
      if (cashierCodes.includes(p.code)) {
        await dbService.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [cashierRole!.id, p.id]);
      }
    }

    // Assign STAFF perms
    const staffCodes = ['auth.login', 'auth.change_password', 'order.manage', 'queue.manage', 'dining.manage'];
    for (const p of allPerms) {
      if (staffCodes.includes(p.code)) {
        await dbService.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [staffRole!.id, p.id]);
      }
    }

    // 3. Seed Users
    const salt = bcrypt.genSaltSync(10);
    const adminHash = bcrypt.hashSync('Super@123', salt);
    const managerHash = bcrypt.hashSync('Super@123', salt);
    const cashierHash = bcrypt.hashSync('Super@123', salt);
    const staffHash = bcrypt.hashSync('Super@123', salt);

    await dbService.execute(
      `INSERT INTO users (username, email, password_hash, name, phone, role_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      ['admin', 'admin@projectx.com', adminHash, 'System Administrator', '+91 98765 43210', adminRole!.id]
    );

    await dbService.execute(
      `INSERT INTO users (username, email, password_hash, name, phone, role_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      ['manager', 'manager@projectx.com', managerHash, 'Operations Manager', '+91 98765 43211', managerRole!.id]
    );

    await dbService.execute(
      `INSERT INTO users (username, email, password_hash, name, phone, role_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      ['cashier', 'cashier@projectx.com', cashierHash, 'Head Cashier', '+91 98765 43212', cashierRole!.id]
    );

    await dbService.execute(
      `INSERT INTO users (username, email, password_hash, name, phone, role_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      ['staff', 'staff@projectx.com', staffHash, 'Service Staff', '+91 98765 43213', staffRole!.id]
    );

    // 4. Categories
    const categories = [
      { name: 'Mandi Specials', description: 'Authentic Yemeni slow-cooked fragrant Mandi rice dishes', icon: 'utensils', order: 1 },
      { name: 'Biryani & Rice', description: 'Dum-cooked royal biryanis and specialty rice platters', icon: 'flame', order: 2 },
      { name: 'Starters & Grills', description: 'Al Faham, Kebabs, Hummus and hot Arabian appetizers', icon: 'drumstick', order: 3 },
      { name: 'Beverages & Mocktails', description: 'Refreshing Saudi Champagne, fresh juices and mint coolers', icon: 'glass-water', order: 4 },
      { name: 'Desserts & Sweets', description: 'Fresh Kunafa, Baklava and traditional sweets', icon: 'cake', order: 5 },
      { name: 'Accompaniments', description: 'Extra Toum garlic paste, Maraq soup and salads', icon: 'bowl-food', order: 6 },
    ];

    for (const c of categories) {
      await dbService.execute('INSERT INTO categories (name, description, icon, display_order, status) VALUES (?, ?, ?, ?, ?)', [
        c.name,
        c.description,
        c.icon,
        c.order,
        'ACTIVE',
      ]);
    }

    const catMandi = (await dbService.queryOne<{ id: number }>("SELECT id FROM categories WHERE name = 'Mandi Specials'"))!.id;
    const catBiryani = (await dbService.queryOne<{ id: number }>("SELECT id FROM categories WHERE name = 'Biryani & Rice'"))!.id;
    const catStarters = (await dbService.queryOne<{ id: number }>("SELECT id FROM categories WHERE name = 'Starters & Grills'"))!.id;
    const catDrinks = (await dbService.queryOne<{ id: number }>("SELECT id FROM categories WHERE name = 'Beverages & Mocktails'"))!.id;
    const catDessert = (await dbService.queryOne<{ id: number }>("SELECT id FROM categories WHERE name = 'Desserts & Sweets'"))!.id;
    const catSides = (await dbService.queryOne<{ id: number }>("SELECT id FROM categories WHERE name = 'Accompaniments'"))!.id;

    // 5. Products & Initial Stock
    const products = [
      // Mandi
      { catId: catMandi, name: 'Special Chicken Mandi (Full)', sku: 'MND-CHK-F', cost: 420, price: 680, tax: 5, stock: 45, alert: 10, desc: 'Full fragrant Mandi rice served with tender roasted whole chicken and soup' },
      { catId: catMandi, name: 'Special Chicken Mandi (Half)', sku: 'MND-CHK-H', cost: 230, price: 380, tax: 5, stock: 60, alert: 15, desc: 'Half portion Mandi rice with half roasted chicken and side sauces' },
      { catId: catMandi, name: 'Special Chicken Mandi (Quarter)', sku: 'MND-CHK-Q', cost: 130, price: 220, tax: 5, stock: 80, alert: 20, desc: 'Single serving chicken mandi with aromatic rice and spicy dakous' },
      { catId: catMandi, name: 'Royal Mutton Mandi (Full)', sku: 'MND-MUT-F', cost: 680, price: 1050, tax: 5, stock: 30, alert: 8, desc: 'Tender melt-in-mouth slow-braised mutton shanks on premium basmati mandi rice' },
      { catId: catMandi, name: 'Royal Mutton Mandi (Half)', sku: 'MND-MUT-H', cost: 360, price: 580, tax: 5, stock: 40, alert: 10, desc: 'Succulent mutton portion served over rich spiced mandi rice with fried nuts' },
      { catId: catMandi, name: 'Al Faham Chicken Mandi', sku: 'MND-ALF-F', cost: 460, price: 740, tax: 5, stock: 35, alert: 10, desc: 'Charcoal grilled spicy Al Faham chicken paired with long-grain mandi rice' },
      { catId: catMandi, name: 'Peri Peri Fish Mandi', sku: 'MND-FSH-F', cost: 480, price: 790, tax: 5, stock: 25, alert: 5, desc: 'Fresh marinated King Fish steak charcoal grilled over spiced rice' },
      
      // Biryani
      { catId: catBiryani, name: 'Hyderabadi Mutton Dum Biryani', sku: 'BRY-MUT-D', cost: 240, price: 390, tax: 5, stock: 50, alert: 12, desc: 'Traditional sealed pot dum biryani with marinated mutton and saffron aroma' },
      { catId: catBiryani, name: 'Chicken Dum Biryani Pot', sku: 'BRY-CHK-D', cost: 160, price: 280, tax: 5, stock: 70, alert: 15, desc: 'Rich spiced layered basmati rice with juicy chicken cuts and raita' },
      
      // Starters
      { catId: catStarters, name: 'Arabian Al Faham Dajaj (Full)', sku: 'STR-ALF-F', cost: 300, price: 490, tax: 5, stock: 40, alert: 10, desc: 'Full charcoal grilled marinated Arabian chicken with toum garlic sauce' },
      { catId: catStarters, name: 'Creamy Hummus with Pita (2 Pcs)', sku: 'STR-HUM-P', cost: 80, price: 160, tax: 5, stock: 60, alert: 15, desc: 'Velvety chickpea hummus dip topped with extra virgin olive oil and sumac' },
      { catId: catStarters, name: 'Mutton Maraq Soup (Bowl)', sku: 'STR-MAR-B', cost: 40, price: 90, tax: 5, stock: 100, alert: 25, desc: 'Rich aromatic mutton bone broth infused with cardamom and black pepper' },
      
      // Beverages
      { catId: catDrinks, name: 'Saudi Champagne (Pitcher 1.5L)', sku: 'BEV-SAU-P', cost: 90, price: 220, tax: 5, stock: 50, alert: 10, desc: 'Sparkling apple cider cocktail infused with fresh mint, orange and lemon slices' },
      { catId: catDrinks, name: 'Fresh Mint Lemonade', sku: 'BEV-MNT-L', cost: 30, price: 80, tax: 5, stock: 120, alert: 20, desc: 'Zesty chilled lemonade blended with fresh mountain mint' },
      { catId: catDrinks, name: 'Mineral Water (1L)', sku: 'BEV-WAT-1L', cost: 12, price: 30, tax: 5, stock: 200, alert: 40, desc: 'Packaged premium drinking water' },

      // Desserts
      { catId: catDessert, name: 'Hot Cheese Kunafa (Large)', sku: 'DST-KNF-L', cost: 160, price: 320, tax: 5, stock: 30, alert: 8, desc: 'Crispy golden kataifi pastry layered with melted sweet cheese and crushed pistachios' },
      { catId: catDessert, name: 'Classic Umali Pudding', sku: 'DST-UML-P', cost: 90, price: 190, tax: 5, stock: 35, alert: 8, desc: 'Warm Egyptian puff pastry pudding with condensed milk, raisins and roasted nuts' },

      // Sides
      { catId: catSides, name: 'Extra Toum Garlic Paste', sku: 'SID-TOU-X', cost: 15, price: 40, tax: 5, stock: 150, alert: 30, desc: 'Traditional fluffy whipped garlic toum dip' },
      { catId: catSides, name: 'Spicy Yemeni Dakous Chutney', sku: 'SID-DAK-X', cost: 10, price: 30, tax: 5, stock: 150, alert: 30, desc: 'Fresh crushed tomato, green chili, garlic and coriander sauce' },
    ];

    for (const p of products) {
      const res = await dbService.execute(
        `INSERT INTO products (category_id, name, sku, description, cost_price, selling_price, tax_rate, stock_quantity, low_stock_threshold, is_available, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ACTIVE')`,
        [p.catId, p.name, p.sku, p.desc, p.cost, p.price, p.tax, p.stock, p.alert]
      );
      const prodId = res.lastInsertRowid;

      // Stock record
      await dbService.execute(
        `INSERT INTO stock (product_id, current_stock, reserved_stock, min_stock_alert)
         VALUES (?, ?, 0, ?)`,
        [prodId, p.stock, p.alert]
      );

      // Seed 3-Tier Stock Master (stock_items)
      const stockCode = `STK-${String(prodId).padStart(4, '0')}`;
      const itemUuid = `item-${prodId}-${Date.now().toString(36)}`;
      const totalVal = p.stock * p.cost;
      const unitType = p.name.includes('Water') || p.name.includes('Lemonade') || p.name.includes('Champagne') ? 'liter' : p.name.includes('Soup') || p.name.includes('Chutney') || p.name.includes('Paste') ? 'portion' : 'piece';

      const stkRes = await dbService.execute(
        `INSERT INTO stock_items (uuid, stock_code, name, unit_type, current_quantity, current_value, average_unit_price, status, min_stock_alert, product_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [itemUuid, stockCode, p.name, unitType, p.stock, totalVal, p.cost, p.alert, prodId]
      );
      const stkId = stkRes.lastInsertRowid;

      const entryNum = `ENT-${String(prodId).padStart(4, '0')}-INIT`;
      const entryUuid = `entry-${prodId}-${Date.now().toString(36)}`;
      const moveUuid = `move-${prodId}-${Date.now().toString(36)}`;

      await dbService.execute(
        `INSERT INTO stock_entries (uuid, stock_item_id, entry_number, quantity, multiplier, total_quantity, total_price, unit_price, status, supplier, notes, created_by)
         VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, 'posted', 'Primary Wholesale Supplier', 'Initial opening stock ledger entry', 1)`,
        [entryUuid, stkId, entryNum, p.stock, p.stock, totalVal, p.cost]
      );

      await dbService.execute(
        `INSERT INTO stock_movements (uuid, stock_item_id, movement_type, reference_type, reference_id, quantity, unit_price, total_value, balance_quantity, balance_value, notes, created_by)
         VALUES (?, ?, 'in', 'PURCHASE_ENTRY', ?, ?, ?, ?, ?, ?, 'Initial inventory stock addition', 1)`,
        [moveUuid, stkId, entryNum, p.stock, p.cost, totalVal, p.stock, totalVal]
      );
    }

    // 6. Dining Tables
    const tables = [
      // Main AC Hall
      { num: 'T-01', name: 'Table 1', section: 'Main AC Hall', cap: 4, order: 1 },
      { num: 'T-02', name: 'Table 2', section: 'Main AC Hall', cap: 4, order: 2 },
      { num: 'T-03', name: 'Table 3', section: 'Main AC Hall', cap: 6, order: 3 },
      { num: 'T-04', name: 'Table 4', section: 'Main AC Hall', cap: 6, order: 4 },
      { num: 'T-05', name: 'Table 5', section: 'Main AC Hall', cap: 8, order: 5 },
      { num: 'T-06', name: 'Table 6', section: 'Main AC Hall', cap: 2, order: 6 },
      
      // Majlis Floor Seating
      { num: 'M-01', name: 'Majlis Al-Noor', section: 'Majlis Carpet Floor', cap: 8, order: 7 },
      { num: 'M-02', name: 'Majlis Al-Barakah', section: 'Majlis Carpet Floor', cap: 8, order: 8 },
      { num: 'M-03', name: 'Majlis Al-Sultan (VIP)', section: 'Majlis Carpet Floor', cap: 12, order: 9 },
      
      // Family Cabins
      { num: 'F-01', name: 'Family Cabin 1', section: 'Family Enclosure', cap: 6, order: 10 },
      { num: 'F-02', name: 'Family Cabin 2', section: 'Family Enclosure', cap: 6, order: 11 },
      { num: 'F-03', name: 'Family Royal Suite', section: 'Family Enclosure', cap: 10, order: 12 },
    ];

    for (const t of tables) {
      await dbService.execute(
        `INSERT INTO dining_tables (table_number, name, section, capacity, status, display_order)
         VALUES (?, ?, ?, ?, 'AVAILABLE', ?)`,
        [t.num, t.name, t.section, t.cap, t.order]
      );
    }

    // 7. Customers
    const customers = [
      { name: 'Dr. Farooq Siddiqui', phone: '9845012345', email: 'farooq@example.com', address: 'Banjara Hills, Hyderabad' },
      { name: 'Rashid Khan', phone: '9988776655', email: 'rashid.k@example.com', address: 'Jubilee Hills, Hyderabad' },
      { name: 'Zoya Fatima', phone: '9123456780', email: 'zoya@example.com', address: 'Tolichowki, Hyderabad' },
      { name: 'Mohammed Irfan', phone: '9871122334', email: 'irfan.m@example.com', address: 'Mehdipatnam, Hyderabad' },
    ];

    for (const cust of customers) {
      await dbService.execute(
        `INSERT INTO customers (name, phone, email, address, status, total_visits, total_spent)
         VALUES (?, ?, ?, ?, 'ACTIVE', 3, 2450.0)`,
        [cust.name, cust.phone, cust.email, cust.address]
      );
    }

    // 8. Settings
    const defaultSettings = [
      // General
      { key: 'BUSINESS_NAME', value: 'Project X — POS & Management System', cat: 'GENERAL', desc: 'Official registered trade name' },
      { key: 'BUSINESS_PHONE', value: '+91 40 2355 8900 / +91 98765 43210', cat: 'GENERAL', desc: 'Contact phone numbers' },
      { key: 'BUSINESS_EMAIL', value: 'contact@projectx.com', cat: 'GENERAL', desc: 'Official email address' },
      { key: 'BUSINESS_ADDRESS', value: 'Plot 42, Gachibowli Main Road, Hyderabad, Telangana 500032', cat: 'GENERAL', desc: 'Store physical address' },
      { key: 'BUSINESS_GSTIN', value: '36AAAAA0000A1Z5', cat: 'GENERAL', desc: 'GST / Tax identification number' },
      { key: 'CURRENCY_SYMBOL', value: '₹', cat: 'GENERAL', desc: 'Primary currency symbol' },

      // Tax
      { key: 'TAX_ENABLED', value: 'true', cat: 'TAX', desc: 'Enable automated tax computation' },
      { key: 'TAX_NAME', value: 'GST (CGST 2.5% + SGST 2.5%)', cat: 'TAX', desc: 'Tax title printed on invoices' },
      { key: 'TAX_PERCENTAGE', value: '5.0', cat: 'TAX', desc: 'Standard tax percentage rate' },
      { key: 'TAX_INCLUSIVE', value: 'false', cat: 'TAX', desc: 'Whether product prices already include tax' },

      // Receipt
      { key: 'RECEIPT_HEADER', value: '*** PROJECT X POS ***\nOfficial Store Terminal', cat: 'RECEIPT', desc: 'Top header printed on receipts' },
      { key: 'RECEIPT_FOOTER', value: 'Thank you for your visit!\nPlease rate our service.\nFor Support: +91 98765 43210', cat: 'RECEIPT', desc: 'Bottom message printed on receipt' },
      { key: 'RECEIPT_SHOW_LOGO', value: 'true', cat: 'RECEIPT', desc: 'Show restaurant emblem on print' },
      { key: 'RECEIPT_SHOW_TAX', value: 'true', cat: 'RECEIPT', desc: 'Display tax breakdown line' },
      { key: 'RECEIPT_SHOW_CUSTOMER', value: 'true', cat: 'RECEIPT', desc: 'Print customer name & phone' },
      { key: 'RECEIPT_PAPER_WIDTH', value: '80mm', cat: 'RECEIPT', desc: 'Receipt printer thermal paper width' },

      // POS
      { key: 'POS_DEFAULT_ORDER_TYPE', value: 'WALK_IN', cat: 'POS', desc: 'Default order type on fresh POS load' },
      { key: 'POS_ALLOW_NEGATIVE_STOCK', value: 'false', cat: 'POS', desc: 'Permit billing when stock reaches zero' },
      { key: 'POS_ENABLE_DISCOUNTS', value: 'true', cat: 'POS', desc: 'Allow cashier to input discounts' },
      { key: 'POS_SOUND_EFFECTS', value: 'true', cat: 'POS', desc: 'Play audible chimes on add to cart & checkout' },

      // Theme
      { key: 'THEME_PRIMARY_COLOR', value: '#D97706', cat: 'THEME', desc: 'Brand amber / saffron primary color' },
      { key: 'THEME_ACCENT_COLOR', value: '#EA580C', cat: 'THEME', desc: 'Warm fiery orange accent' },
      { key: 'THEME_DARK_BG', value: '#0F172A', cat: 'THEME', desc: 'Deep slate background' },
      { key: 'system_theme', value: '{"primary":"#D97706","primaryHover":"#EA580C","sidebarBg":"#1C1917","sidebarText":"#F5F5F4","sidebarActiveAccent":"#F59E0B","bgApp":"#F8F7F4","cardBg":"#FFFFFF","cardBorder":"#E7E5E4","textMain":"#1C1917","success":"#15803D","danger":"#DC2626","warning":"#D97706"}', cat: 'THEME', desc: 'Full UI theme palette stored as JSON (overrides individual THEME_* keys)' },

      // Printer / Notification / Invoice — one JSON document per settings tab,
      // unpacked into flat PRINTER_* / NOTIFY_* / INVOICE_* keys by the API.
      // Keep these in step with src/database/seeders.sql.
      { key: 'system_printer', value: '{"receiptEnabled":"true","receiptName":"Cashier Thermal Receipt Printer","receiptPaperWidth":"80mm","receiptAutoPrint":"true","receiptCopies":"1","kitchenEnabled":"true","kitchenName":"Kitchen Order Ticket (KOT) Printer","kitchenPaperWidth":"80mm","kitchenAutoPrint":"true","kitchenCopies":"1","barEnabled":"false","barName":"Bar Beverage Printer","barPaperWidth":"80mm","barAutoPrint":"false","barCopies":"1","connection":"usb","deviceIp":"","devicePort":"9100","charset":"CP437","density":"normal","autoCut":"true","cashDrawer":"true","buzzer":"false","feedLines":"3"}', cat: 'RECEIPT', desc: 'Print stations, device connection & paper behaviour stored as JSON' },
      { key: 'system_notification', value: '{"newOrder":"true","orderReady":"true","billVoided":"true","lowStock":"true","lowStockThreshold":"5","dayClose":"true","channelInApp":"true","channelDesktop":"false","channelEmail":"false","emailRecipients":"","channelSms":"false","smsRecipients":"","sound":"true","soundTone":"chime","quietStart":"","quietEnd":"","dailySummary":"false","dailySummaryTime":"23:30"}', cat: 'POS', desc: 'Operational alert triggers, channels & quiet hours stored as JSON' },
      { key: 'system_invoice', value: '{"prefix":"INV-","nextNumber":"1","padLength":"4","resetCycle":"yearly","title":"TAX INVOICE","paperSize":"A4","dateFormat":"dd/MM/yyyy","decimals":"2","currencyPosition":"prefix","showLogo":"true","showTaxBreakdown":"true","showQr":"false","upiId":"","showSignature":"true","signatory":"Authorised Signatory","dueDays":"0","terms":"Goods once sold will not be taken back or exchanged.","footerNote":"Thank you for your business."}', cat: 'RECEIPT', desc: 'Invoice numbering, document format & printed blocks stored as JSON' },
    ];

    for (const s of defaultSettings) {
      await dbService.execute(
        // `key` and `value` are MySQL reserved words — unquoted they are a syntax error.
        `INSERT INTO settings (\`key\`, \`value\`, category, description, is_system)
         VALUES (?, ?, ?, ?, 1)`,
        [s.key, s.value, s.cat, s.desc]
      );
    }
  });

  logger.info('Database seeding completed successfully!');
};

if (require.main === module) {
  seedDatabase()
    .then(() => {
      logger.info('Seeding script finished.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Seeding script failed:', err);
      process.exit(1);
    });
}
