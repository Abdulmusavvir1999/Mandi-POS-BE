import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { SettingsService } from './settings.service';
import { AuditService } from './audit.service';
import { StockService } from './stock.service';
import { ProductsService } from './products.service';
import { CustomersService } from './customers.service';
import { PhoneUtil } from '../utils/phone.util';
import { OrderType, PaymentMethod } from '../models';
import { SequenceUtil } from '../utils/sequence.util';
import { DocumentSequence, ORDER_DOCUMENT, BILL_DOCUMENT } from '../utils/document-sequence.util';
import { logger } from '../config/logger';
import { splitTax } from '../utils/tax.util';
import { ParamUtil } from '../utils/param.util';
import { SchemaUtil } from '../utils/schema.util';

export interface CheckoutPayload {
  customerId?: number | null;
  diningTableId?: number | null;
  existingOrderId?: number | null;
  orderType: OrderType;
  discountType?: 'FIXED' | 'PERCENTAGE';
  discountValue?: number;
  serviceChargeAmount?: number;
  surchargeAmount?: number;
  couponCode?: string;
  couponDiscount?: number;
  cashTendered?: number;
  changeReturned?: number;
  offlineSyncId?: string;
  paymentMethod: PaymentMethod;
  paymentAmount?: number;
  /**
   * A split: up to two parts, e.g. CASH 1000 + UPI 1000. When given they must
   * add up to the grand total; paymentMethod is then ignored and the bill
   * reads "CASH+UPI". Cash tendered/change apply to the cash part.
   */
  payments?: Array<{ method: string; amount: number; reference?: string }>;
  paymentReference?: string;
  notes?: string;
  /**
   * The booking this sale fulfils, when the POS was opened from a pickup
   * booking's "Collect & bill". Paying marks that pickup PICKED_UP.
   */
  reservationId?: number | null;
  /**
   * Customer typed at payment (no customer attached). With saveCustomer the
   * pair becomes a customer record - the existing one when the phone is
   * already known; without it, it is kept on this bill only.
   */
  customerName?: string | null;
  customerPhone?: string | null;
  saveCustomer?: boolean;
  items: Array<{
    /** The dish. Ignored on COMBO and ADDON lines, which name their own item. */
    productId?: number | null;
    variantId?: number | null;
    quantity: number;
    notes?: string;
    isComplimentary?: boolean;
    complimentaryReason?: string;
    selectedAddons?: Array<{ id: number; name: string; price: number; quantity?: number }>;
    itemType?: 'PRODUCT' | 'COMBO' | 'ADDON';
    comboId?: number | null;
    addonId?: number | null;
  }>;
}

/** A cart line as the server verifies it. Built by verifyLines; never taken from the client. */
export interface VerifiedLine {
  /** Null on combo and add-on lines: they are not dishes. */
  productId: number | null;
  productName: string;
  variantId: number | null;
  variantName: string | null;
  stockConsumption: number;
  unitPrice: number;
  costPrice: number;
  quantity: number;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  notes?: string;
  /** Every stock item this line draws on, and how much, for the SALE movements. */
  stockUsages: Array<{ stockId: number; quantity: number }>;
  isComplimentary: boolean;
  complimentaryReason: string | null;
  addonsData: string | null;
  itemType: 'PRODUCT' | 'COMBO' | 'ADDON';
  comboId: number | null;
  addonId: number | null;
  /**
   * Set on a line already sent to the kitchen on an open dining tab: it keeps
   * the price it was ordered at and skips the availability and stock checks,
   * because the food has been served. Only the server sets this.
   */
  locked?: boolean;
}

/** Server-side input for a line already on an open tab (see VerifiedLine.locked). */
export type LockedLineInput = CheckoutPayload['items'][number] & { lockedUnitPrice: number };

export class CheckoutService {
  private static schemaEnsured = false;

  /**
   * Auto-ensures billing, void, offline sync columns and day closing table exist.
   */
  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      // 0. Multi Stock tables (product_variant_stocks, bill_item_stock_usage):
      //    checkout writes the usage record on every sale, and the reports,
      //    voids and refunds - which all chain through here - read both.
      await ProductsService.ensureSchema();
      // Customer typed at payment: customers must be ready before the
      // checkout transaction (its DDL would commit it), and a bill keeps an
      // unsaved customer's name and phone as guest_name / guest_phone.
      await CustomersService.ensureSchema();
      try {
        await dbService.execute('ALTER TABLE bills ADD COLUMN IF NOT EXISTS guest_name VARCHAR(100) NULL');
        await dbService.execute('ALTER TABLE bills ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(30) NULL');
      } catch (_) {}

      // 1. Expand columns
      try {
        await dbService.execute("ALTER TABLE orders MODIFY COLUMN order_type VARCHAR(30) NOT NULL");
        await dbService.execute("ALTER TABLE bills MODIFY COLUMN order_type VARCHAR(30) NOT NULL");
        await dbService.execute("ALTER TABLE bills MODIFY COLUMN payment_method VARCHAR(30) NOT NULL");
        await dbService.execute("ALTER TABLE bills MODIFY COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID'");
      } catch (_) {}
      // Was ENUM without ONLINE, so an Online payment could not be recorded.
      try {
        await dbService.execute("ALTER TABLE payments MODIFY COLUMN payment_method VARCHAR(30) NOT NULL");
      } catch (e) {
        logger.warn('Could not widen payments.payment_method:', e);
      }

      // 2. Add columns to bills
      const addCol = async (table: string, col: string, def: string) => {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = ? 
              AND COLUMN_NAME = ?
          `, [table, col]);
          if (!colCheck || colCheck.count === 0) {
            await dbService.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        } catch (e) {
          logger.warn(`Could not add column ${col} to ${table}:`, e);
        }
      };

      await addCol('bills', 'service_charge_amount', 'DECIMAL(10,2) DEFAULT 0.00');
      await addCol('bills', 'surcharge_amount', 'DECIMAL(10,2) DEFAULT 0.00');
      await addCol('bills', 'coupon_code', 'VARCHAR(50) NULL');
      await addCol('bills', 'coupon_discount', 'DECIMAL(10,2) DEFAULT 0.00');
      await addCol('bills', 'cash_tendered', 'DECIMAL(10,2) NULL');
      await addCol('bills', 'change_returned', 'DECIMAL(10,2) NULL');
      await addCol('bills', 'payment_reference', 'VARCHAR(100) NULL');
      await addCol('bills', 'is_voided', 'BOOLEAN DEFAULT FALSE');
      await addCol('bills', 'void_reason', 'TEXT NULL');
      await addCol('bills', 'void_by', 'INT NULL');
      await addCol('bills', 'void_at', 'DATETIME NULL');
      await addCol('bills', 'is_reopened', 'BOOLEAN DEFAULT FALSE');
      await addCol('bills', 'reopened_from_bill_id', 'INT NULL');
      await addCol('bills', 'reopened_at', 'DATETIME NULL');
      await addCol('bills', 'offline_sync_id', 'VARCHAR(100) NULL');

      // Add columns to order_items and bill_items
      await addCol('order_items', 'addons_data', 'TEXT NULL');
      await addCol('order_items', 'item_type', "VARCHAR(30) DEFAULT 'PRODUCT'");
      await addCol('order_items', 'combo_id', 'INT NULL');
      // Legacy: Meal Deals were withdrawn and nothing writes deal_id any more,
      // but sales settled while they existed still carry it, so the column is
      // still ensured rather than dropped.
      await addCol('order_items', 'deal_id', 'INT NULL');
      // Open dining tabs: which kitchen round a line went out in, and the
      // complimentary flag it has to carry until the bill is made.
      await addCol('order_items', 'kot_round', 'INT NULL');
      // Kitchen progress on an open tab, kept apart from orders.status (which
      // means billed/cancelled): READY once the kitchen has served every round
      // sent so far, cleared again when the next round goes in.
      await addCol('orders', 'kitchen_status', 'VARCHAR(20) NULL');
      await addCol('order_items', 'is_complimentary', 'BOOLEAN DEFAULT FALSE');
      await addCol('order_items', 'complimentary_reason', 'VARCHAR(255) NULL');

      await addCol('bill_items', 'is_complimentary', 'BOOLEAN DEFAULT FALSE');
      await addCol('bill_items', 'complimentary_reason', 'VARCHAR(255) NULL');
      await addCol('bill_items', 'addons_data', 'TEXT NULL');
      await addCol('bill_items', 'item_type', "VARCHAR(30) DEFAULT 'PRODUCT'");
      await addCol('bill_items', 'combo_id', 'INT NULL');
      // Legacy, as for order_items above.
      await addCol('bill_items', 'deal_id', 'INT NULL');

      // Combo and add-on lines are not dishes: they leave product_id empty,
      // and an add-on line names its add-on. Held drafts carry the same.
      try {
        for (const t of ['order_items', 'bill_items', 'draft_bill_items']) {
          await SchemaUtil.makeIntNullable(t, 'product_id');
          await SchemaUtil.addColumn(t, 'addon_id', 'INT NULL');
        }
        await SchemaUtil.addColumn('draft_bill_items', 'item_type', "VARCHAR(30) NOT NULL DEFAULT 'PRODUCT'");
        await SchemaUtil.addColumn('draft_bill_items', 'combo_id', 'INT NULL');
      } catch (e) {
        logger.warn('Could not prepare line tables for combo / add-on lines:', e);
      }

      // Soft delete for orders and invoices (see soft_delete_migration.sql).
      //
      // An administrator withdrawing a record from the Back-Office no longer
      // destroys it: the row and its items, payments and refunds stay put, and
      // `is_deleted` takes them out of every figure and every list.
      // Deliberately distinct from `is_voided` — a void is a sale cancelled at
      // the till and remains real history; a delete is a record pulled from
      // the books by an admin.
      //
      // Owned here rather than in the orders or back-office module because
      // this is already where the bills and orders column migrations live, and
      // it is chained from ReportsSchema.ensure(), so every reader that
      // filters on the column is guaranteed to find it.
      for (const table of ['orders', 'bills']) {
        await addCol(table, 'is_deleted', 'TINYINT(1) NOT NULL DEFAULT 0');
        await addCol(table, 'deleted_at', 'DATETIME NULL');
        await addCol(table, 'deleted_by', 'INT NULL');
        await addCol(table, 'delete_reason', 'TEXT NULL');
      }

      // Every read now carries `is_deleted = 0`, usually beside a date range.
      // MySQL has no CREATE INDEX IF NOT EXISTS, so each one is probed first.
      const softDeleteIndexes: [string, string, string][] = [
        ['idx_orders_is_deleted', 'orders', 'is_deleted'],
        ['idx_orders_deleted_created', 'orders', 'is_deleted, created_at'],
        ['idx_bills_is_deleted', 'bills', 'is_deleted'],
        ['idx_bills_deleted_created', 'bills', 'is_deleted, created_at'],
      ];
      for (const [name, table, columns] of softDeleteIndexes) {
        try {
          const exists = await dbService.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
            [table, name]
          );
          if (!exists || Number(exists.count) === 0) {
            await dbService.execute(`CREATE INDEX ${name} ON ${table}(${columns})`);
          }
        } catch (e) {
          logger.warn(`Could not create index ${name} on ${table}:`, e);
        }
      }

      // The gapless per-day position for orders and invoices. Must come after
      // `is_deleted` exists: the backfill numbers active rows only.
      await DocumentSequence.ensureSchema(ORDER_DOCUMENT);
      await DocumentSequence.ensureSchema(BILL_DOCUMENT);

      // 3. Create pos_day_closings table
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS pos_day_closings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          closing_number VARCHAR(50) UNIQUE NOT NULL,
          user_id INT NOT NULL,
          cashier_name VARCHAR(100) NULL,
          opening_time DATETIME NOT NULL,
          closing_time DATETIME NOT NULL,
          opening_cash DECIMAL(10,2) DEFAULT 0.00,
          total_cash_sales DECIMAL(10,2) DEFAULT 0.00,
          total_card_sales DECIMAL(10,2) DEFAULT 0.00,
          total_upi_sales DECIMAL(10,2) DEFAULT 0.00,
          total_online_sales DECIMAL(10,2) DEFAULT 0.00,
          gross_sales DECIMAL(10,2) DEFAULT 0.00,
          total_discounts DECIMAL(10,2) DEFAULT 0.00,
          total_tax DECIMAL(10,2) DEFAULT 0.00,
          total_service_charges DECIMAL(10,2) DEFAULT 0.00,
          total_bills_count INT DEFAULT 0,
          void_bills_count INT DEFAULT 0,
          void_bills_amount DECIMAL(10,2) DEFAULT 0.00,
          expected_cash DECIMAL(10,2) DEFAULT 0.00,
          actual_cash DECIMAL(10,2) DEFAULT 0.00,
          cash_variance DECIMAL(10,2) DEFAULT 0.00,
          notes TEXT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_day_closing_user (user_id),
          INDEX idx_day_closing_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      this.schemaEnsured = true;
    } catch (err) {
      logger.error('Failed to ensure checkout schema:', err);
    }
  }

  static async processCheckout(payload: CheckoutPayload, cashierId: number) {
    await this.ensureSchema();

    // A tab can be billed with nothing new in the cart; its lines are on the order.
    if ((!payload.items || payload.items.length === 0) && !payload.existingOrderId) {
      throw AppError.badRequest('Cart is empty. Please add items to checkout.');
    }

    // Check for duplicate offline sync
    if (payload.offlineSyncId) {
      const existingOffline = await dbService.queryOne<{ id: number; bill_number: string }>(
        'SELECT id, bill_number FROM bills WHERE offline_sync_id = ? AND is_deleted = 0',
        [payload.offlineSyncId]
      );
      if (existingOffline) {
        return await this.getBillSummary(existingOffline.id);
      }
    }

    // The configured tax rule: the rate, whether tax is charged at all, and
    // whether the menu price already contains it. The till works to the same
    // three, so its grand total and this one agree — they have to, since the
    // payment check below rejects anything under the total computed here.
    const taxPolicy = await SettingsService.getTaxPolicy();

    return await dbService.transaction(async () => {
      // 0. Billing an open dining tab: the lines already sent to the kitchen
      // are on the order; bill those plus anything new in this request, and
      // write only the new ones to order_items.
      let tabOrder: { id: number; order_number: string; status: string; dining_table_id: number | null; customer_id: number | null } | null = null;
      let tabLines: LockedLineInput[] = [];
      if (payload.existingOrderId) {
        tabOrder = await dbService.queryOne(
          'SELECT id, order_number, status, dining_table_id, customer_id FROM orders WHERE id = ? AND is_deleted = 0 FOR UPDATE',
          [payload.existingOrderId]
        );
        if (!tabOrder) {
          throw AppError.notFound(`Order ${payload.existingOrderId} not found.`);
        }
        if (tabOrder.status === 'COMPLETED' || tabOrder.status === 'CANCELLED') {
          throw AppError.conflict(`Order ${tabOrder.order_number} is already ${tabOrder.status.toLowerCase()}.`);
        }
        tabLines = await this.loadTabLines(tabOrder.id);
      }

      // Customer typed at payment: save / reuse by phone, or keep for this bill.
      const typed = await this.resolveTypedCustomer(payload, cashierId);
      payload = { ...payload, customerId: payload.customerId || typed.customerId || undefined };
      (payload as any).__guest = typed.guest;
      (payload as any).__customerLink = typed.link;

      // Clients can never lock a price: strip anything that looks like one.
      const newItems = (payload.items || []).map((i) => {
        const { lockedUnitPrice: _drop, ...rest } = i as any;
        return rest as CheckoutPayload['items'][number];
      });
      if (!tabLines.length && !newItems.length) {
        throw AppError.badRequest('Cart is empty. Please add items to checkout.');
      }

      // 1. Verify items & Stock availability
      const { lines: verifiedItems, subtotal } = await this.verifyLines([...tabLines, ...newItems]);

      // 2. Stock check for what has not been served yet.
      await this.assertStock(verifiedItems.filter((l) => !l.locked));

      const summary: any = await this.finishCheckout(payload, cashierId, taxPolicy, verifiedItems, subtotal, tabOrder);
      // How the typed customer was handled: EXISTING / CREATED / GUEST (or null).
      return { ...summary, customer_link: (payload as any).__customerLink ?? null };
    });
  }

  /**
   * Checks every line against the menu and works out its price and what it
   * draws from stock. A LockedLineInput keeps its stored price and skips the
   * availability checks: it is food already sent to the kitchen on a tab.
   */
  static async verifyLines(
    items: Array<CheckoutPayload['items'][number] | LockedLineInput>
  ): Promise<{ lines: VerifiedLine[]; subtotal: number }> {
    let subtotal = 0;
    const verifiedItems: VerifiedLine[] = [];

    for (const item of items) {
      const lockedPrice = (item as LockedLineInput).lockedUnitPrice;
      const locked = lockedPrice !== undefined && lockedPrice !== null;
        const isComp = Boolean(item.isComplimentary);
        const itemType = item.itemType === 'COMBO' || item.itemType === 'ADDON' ? item.itemType : 'PRODUCT';
        const quantity = Number(item.quantity) || 0;
        if (quantity <= 0) {
          throw AppError.badRequest('Every line needs a quantity of at least 1.');
        }

        let line: {
          productId: number | null;
          name: string;
          variantId: number | null;
          variantName: string | null;
          stockConsumption: number;
          basePrice: number;
          costPrice: number;
          stockUsages: Array<{ stockId: number; quantity: number }>;
        };

        if (itemType === 'COMBO') {
          // A combo sells at its own price and draws on the stock item behind
          // each add-on it bundles, per combo served.
          const combo = await dbService.queryOne<any>(
            'SELECT * FROM combo_deals WHERE id = ? AND is_deleted = 0',
            [item.comboId]
          );
          if (!combo) {
            throw AppError.notFound(`Combo deal ${item.comboId} not found`);
          }
          if (!locked && (combo.status !== 'ACTIVE' || !combo.is_available)) {
            throw AppError.badRequest(`Combo "${combo.name}" is currently unavailable for order.`);
          }
          const parts = await dbService.query<{ quantity: number; stock_id: number | null; cost_price: number }>(
            `SELECT cdi.quantity, a.stock_id, a.cost_price
             FROM combo_deal_items cdi
             JOIN product_addons a ON a.id = cdi.addon_id
             WHERE cdi.combo_id = ?`,
            [combo.id]
          );
          line = {
            productId: null,
            name: combo.name,
            variantId: null,
            variantName: null,
            stockConsumption: 1,
            basePrice: Number(combo.combo_price) || 0,
            costPrice: parts.reduce((sum, p) => sum + (Number(p.cost_price) || 0) * (Number(p.quantity) || 0), 0),
            stockUsages: parts
              .filter((p) => p.stock_id)
              .map((p) => ({ stockId: Number(p.stock_id), quantity: (Number(p.quantity) || 0) * quantity })),
          };
        } else if (itemType === 'ADDON') {
          // A stand-alone add-on sells at its own price and draws one of its
          // stock item per add-on sold.
          const addon = await dbService.queryOne<any>(
            'SELECT * FROM product_addons WHERE id = ? AND is_deleted = 0',
            [item.addonId]
          );
          if (!addon) {
            throw AppError.notFound(`Add-on ${item.addonId} not found`);
          }
          if (!locked && (addon.status !== 'ACTIVE' || !addon.is_available)) {
            throw AppError.badRequest(`Add-on "${addon.name}" is currently unavailable for order.`);
          }
          line = {
            productId: null,
            name: addon.name,
            variantId: null,
            variantName: null,
            stockConsumption: 1,
            basePrice: Number(addon.price) || 0,
            costPrice: Number(addon.cost_price) || 0,
            stockUsages: addon.stock_id ? [{ stockId: Number(addon.stock_id), quantity }] : [],
          };
        } else {
          const product = await dbService.queryOne<any>(
            'SELECT * FROM products WHERE id = ?',
            [item.productId]
          );

          if (!product) {
            throw AppError.notFound(`Product with ID ${item.productId} not found`);
          }

          if (!locked && (product.status !== 'ACTIVE' || !product.is_available)) {
            throw AppError.badRequest(`Product "${product.name}" is currently unavailable for order.`);
          }

          let variant: any = null;
          if (item.variantId) {
            variant = await dbService.queryOne<any>(
              'SELECT * FROM product_variants WHERE id = ? AND product_id = ?',
              [item.variantId, item.productId]
            );
            if (!variant) {
              throw AppError.notFound(`Variant ${item.variantId} not found for product "${product.name}"`);
            }
          }

          if (!variant) {
            variant = await dbService.queryOne<any>(
              'SELECT * FROM product_variants WHERE product_id = ? ORDER BY is_default DESC, display_order ASC, id ASC LIMIT 1',
              [item.productId]
            );
          }

          // What one portion takes from stock, from product_variant_stocks -
          // the one place it lives in every mode: one row for Common/Each,
          // one per item for Multi. A dish sold with no portions takes its
          // own linked item, 1 per sale; with neither it draws no stock.
          if (product.variant_stock_mode === 'MULTI' && !variant) {
            throw AppError.badRequest(`"${product.name}" has no portions set up, so it cannot be sold yet.`);
          }
          const recipe = variant
            ? await dbService.query<{ stock_id: number; stock_consumption: number; average_unit_price: number }>(
                `SELECT pvs.stock_id, pvs.stock_consumption, s.average_unit_price
                 FROM product_variant_stocks pvs
                 JOIN stocks s ON s.id = pvs.stock_id
                 WHERE pvs.variant_id = ?
                 ORDER BY pvs.display_order ASC, pvs.id ASC`,
                [variant.id]
              )
            : product.stock_id
              ? await dbService.query<{ stock_id: number; stock_consumption: number; average_unit_price: number }>(
                  'SELECT id AS stock_id, 1 AS stock_consumption, average_unit_price FROM stocks WHERE id = ?',
                  [product.stock_id]
                )
              : [];

          line = {
            productId: product.id,
            name: product.name,
            variantId: variant ? variant.id : null,
            variantName: variant ? variant.name : null,
            // Kept on the bill line for older reports: the single item's
            // amount, or 1 for a Multi Stock portion (its real record is
            // bill_item_stock_usage).
            stockConsumption: recipe.length === 1 ? Number(recipe[0].stock_consumption) || 1 : 1,
            basePrice: variant ? Number(variant.selling_price) : (Number((item as any).unitPrice) || 0),
            costPrice: recipe.reduce((sum, r) => sum + (Number(r.stock_consumption) || 0) * (Number(r.average_unit_price) || 0), 0),
            stockUsages: recipe.map((r) => ({ stockId: Number(r.stock_id), quantity: (Number(r.stock_consumption) || 0) * quantity })),
          };
        }

        const addonsPrice = (item.selectedAddons || []).reduce((sum, a) => sum + (Number(a.price) || 0) * (a.quantity || 1), 0);
        // If complimentary, price charged is 0
        // A tab line keeps the price it was sent to the kitchen at.
        const unitPrice = locked ? Number(lockedPrice) || 0 : isComp ? 0 : (line.basePrice + addonsPrice);
        const itemSubtotal = unitPrice * quantity;
        subtotal += itemSubtotal;

        verifiedItems.push({
          productId: line.productId,
          productName: line.name,
          variantId: line.variantId,
          variantName: line.variantName,
          stockConsumption: line.stockConsumption,
          unitPrice,
          costPrice: line.costPrice,
          quantity,
          subtotal: itemSubtotal,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: itemSubtotal,
          notes: item.notes,
          stockUsages: line.stockUsages,
          isComplimentary: isComp,
          complimentaryReason: isComp ? (item.complimentaryReason || 'Staff Authorized Complimentary') : null,
          addonsData: item.selectedAddons && item.selectedAddons.length > 0 ? JSON.stringify(item.selectedAddons) : null,
          itemType,
          comboId: itemType === 'COMBO' ? Number(item.comboId) : null,
          addonId: itemType === 'ADDON' ? Number(item.addonId) : null,
          locked,
        });
      }

    return { lines: verifiedItems, subtotal };
  }

  /**
   * Stock check, per stock item across the given lines: two lines that
   * draw on the same item (a dish and a combo holding it) must fit in its
   * balance together, not each on its own.
   *
   * The rows are read FOR UPDATE, in stock-id order: inside a transaction
   * (checkout, sending a tab round) that holds them until it commits, so a
   * second till cannot pass the same check on the same last units in
   * between. The fixed order keeps two such transactions from deadlocking.
   */
  static async assertStock(lines: VerifiedLine[]): Promise<void> {
    const required = new Map<number, number>();
    for (const it of lines) {
      for (const u of it.stockUsages) {
        required.set(u.stockId, (required.get(u.stockId) ?? 0) + u.quantity);
      }
    }
    for (const [stockId, needed] of [...required].sort((a, b) => a[0] - b[0])) {
      const stock = await dbService.queryOne<{ name: string; unit_type: string; current_quantity: number }>(
        'SELECT name, unit_type, current_quantity FROM stocks WHERE id = ? FOR UPDATE',
        [stockId]
      );
      const available = Number(stock?.current_quantity ?? 0);
      if (available < needed) {
        const unit = stock?.unit_type ? ` ${stock.unit_type}` : '';
        throw AppError.badRequest(
          `Insufficient stock for "${stock?.name ?? `stock item ${stockId}`}". Available: ${available}${unit}, Required: ${needed}${unit}`
        );
      }
    }
  }


  /**
   * The customer typed in the payment dialog, when none is attached:
   *  - saveCustomer: needs a name and a valid phone; the phone is looked up
   *    first (spaces and dashes ignored) and an existing customer is used as
   *    is - never a duplicate; otherwise a new customer is created.
   *  - not saved: nothing is created; the name / phone go on this bill only.
   * Runs inside the checkout transaction, so a failed payment saves nobody.
   */
  static async resolveTypedCustomer(payload: CheckoutPayload, cashierId: number): Promise<{
    customerId: number | null;
    guest: { name: string | null; phone: string | null } | null;
    link: 'EXISTING' | 'CREATED' | 'GUEST' | null;
  }> {
    if (payload.customerId) return { customerId: null, guest: null, link: null };
    const name = String(payload.customerName ?? '').trim().slice(0, 100);
    const phoneRaw = String(payload.customerPhone ?? '').trim();
    if (!name && !phoneRaw) return { customerId: null, guest: null, link: null };

    const phone = phoneRaw ? PhoneUtil.normalise(phoneRaw) : '';
    const digits = phone.replace('+', '');
    if (phoneRaw && (digits.length < 7 || digits.length > 15)) {
      throw AppError.badRequest('Enter a valid phone number (7 to 15 digits)');
    }

    if (!payload.saveCustomer) {
      return { customerId: null, guest: { name: name || null, phone: phone || null }, link: 'GUEST' };
    }
    if (!name || !phone) throw AppError.badRequest('Customer name and phone are both needed to save the customer');

    const findByPhone = () => CustomersService.findByPhone(phone);
    const existing = await findByPhone();
    if (existing) return { customerId: Number(existing.id), guest: null, link: 'EXISTING' };

    try {
      const created: any = await CustomersService.create({ name, phone }, cashierId);
      return { customerId: Number(created?.id), guest: null, link: 'CREATED' };
    } catch (err: any) {
      // Another till saved the same phone a moment ago: use that record.
      const again = await findByPhone();
      if (again) return { customerId: Number(again.id), guest: null, link: 'EXISTING' };
      throw err;
    }
  }

  /**
   * Live stock check for a cart or a booking's dishes - the same rule
   * checkout applies, without selling anything. For every line it returns the
   * most it can be raised to, given current stock and every other line
   * drawing on the same stock items (other portions, dishes, combos). With an
   * open dining tab, the rounds already sent count as well: nothing on a tab
   * has left stock yet.
   *
   * A line whose stock is unlimited (draws nothing) gets max: null.
   */
  static async stockCheck(items: CheckoutPayload['items'], existingOrderId?: number | null) {
    const clean = (items || []).filter((i) => Number(i?.quantity) > 0);
    const { lines } = await this.verifyLines(clean);
    const sent = existingOrderId ? (await this.verifyLines(await this.loadTabLines(existingOrderId))).lines : [];

    const required = new Map<number, number>();
    for (const l of [...sent, ...lines]) {
      for (const u of l.stockUsages) required.set(u.stockId, (required.get(u.stockId) ?? 0) + u.quantity);
    }

    const ids = [...required.keys()];
    const rows = ids.length
      ? await dbService.query<{ id: number; name: string; unit_type: string; current_quantity: number }>(
          `SELECT id, name, unit_type, current_quantity FROM stocks WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        )
      : [];
    const balance = new Map(rows.map((r) => [Number(r.id), Number(r.current_quantity) || 0]));

    const lineResults = lines.map((l, index) => {
      if (!l.stockUsages.length) return { index, quantity: l.quantity, max: null as number | null, ok: true };
      let max = Infinity;
      for (const u of l.stockUsages) {
        const perUnit = l.quantity > 0 ? u.quantity / l.quantity : 0;
        if (!(perUnit > 0)) continue;
        // What is left for this line once every other line has its share.
        const others = (required.get(u.stockId) ?? 0) - u.quantity;
        const free = (balance.get(u.stockId) ?? 0) - others;
        max = Math.min(max, Math.floor((free + 1e-9) / perUnit));
      }
      const cap = Number.isFinite(max) ? Math.max(0, max) : null;
      return { index, quantity: l.quantity, max: cap, ok: cap === null || l.quantity <= cap };
    });

    return {
      ok: lineResults.every((r) => r.ok),
      lines: lineResults,
      stocks: rows.map((r) => ({
        stock_id: Number(r.id),
        name: r.name,
        unit_type: r.unit_type,
        available: Number(r.current_quantity) || 0,
        required: required.get(Number(r.id)) ?? 0,
      })),
    };
  }

  /**
   * Close a CONFIRMED booking by how it was actually served, whatever it was
   * booked as. Dining on a table: it becomes a TABLE booking on that table,
   * SEATED. Anything else: a PICKUP, PICKED_UP. A table it was holding
   * elsewhere is released; the table it is served on belongs to the dining
   * tab and is left alone. Returns the new status, or null when there was
   * nothing to do (not confirmed any more).
   */
  static async fulfilBooking(reservationId: number, servedAs: 'DINING' | 'TAKEAWAY', tableId: number | null) {
    const rsv = await dbService.queryOne<{ id: number; status: string; table_id: number | null }>(
      'SELECT id, status, table_id FROM table_reservations WHERE id = ? FOR UPDATE',
      [reservationId]
    );
    if (!rsv || rsv.status !== 'CONFIRMED') return null;

    const dining = servedAs === 'DINING' && !!tableId;
    if (rsv.table_id && Number(rsv.table_id) !== Number(dining ? tableId : 0)) {
      await dbService.execute(
        `UPDATE dining_tables SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
         WHERE id = ? AND status = 'RESERVED' AND reservation_id = ?`,
        [rsv.table_id, reservationId]
      );
    }
    if (dining) {
      await dbService.execute(
        `UPDATE table_reservations
         SET booking_type = 'TABLE', status = 'SEATED', table_id = ?, guest_count = GREATEST(guest_count, 1), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [tableId, reservationId]
      );
      return 'SEATED';
    }
    await dbService.execute(
      `UPDATE table_reservations
       SET booking_type = 'PICKUP', status = 'PICKED_UP', table_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reservationId]
    );
    return 'PICKED_UP';
  }

  /** Everything after the lines are verified: totals, order, bill, stock, payment. */
  private static async finishCheckout(
    payload: CheckoutPayload,
    cashierId: number,
    taxPolicy: Awaited<ReturnType<typeof SettingsService.getTaxPolicy>>,
    verifiedItems: VerifiedLine[],
    subtotal: number,
    tabOrder: { id: number; order_number: string; dining_table_id: number | null; customer_id: number | null } | null
  ) {
    // A tab belongs to its table and guest: the bill carries both even if
    // the till did not resend them.
    if (tabOrder) {
      payload = {
        ...payload,
        orderType: 'DINING',
        diningTableId: payload.diningTableId || tabOrder.dining_table_id,
        customerId: payload.customerId || tabOrder.customer_id,
      };
    }

    // 3. Discount calculation
    let discountAmount = 0;
    const discountVal = payload.discountValue || 0;
    if (discountVal > 0) {
      if (payload.discountType === 'PERCENTAGE') {
        if (discountVal > 100) {
          throw AppError.badRequest('Discount percentage cannot exceed 100%');
        }
        discountAmount = (subtotal * discountVal) / 100;
      } else {
        if (discountVal > subtotal) {
          throw AppError.badRequest('Fixed discount cannot exceed subtotal amount');
        }
        discountAmount = discountVal;
      }
    }

    const couponDiscount = Math.max(0, Number(payload.couponDiscount) || 0);
    const totalDiscounts = Math.min(subtotal, discountAmount + couponDiscount);

    // 4. Tax & Additional Charges (Service Charge & Surcharges)
    //
    // splitTax carries both rules: under EXCLUSIVE `taxedAmount` is the
    // taxable base plus the tax, under INCLUSIVE it is the base itself with
    // the tax already inside it. `subtotal` stays what the guest was
    // quoted either way, and `taxAmount` is what the GST return needs.
    const taxableAmount = Math.max(0, subtotal - totalDiscounts);
    const { tax: taxAmount, gross: taxedAmount } = splitTax(taxableAmount, taxPolicy);
    const serviceCharge = Math.max(0, Number(payload.serviceChargeAmount) || 0);
    const surcharge = Math.max(0, Number(payload.surchargeAmount) || 0);
    const grandTotal = Math.round((taxedAmount + serviceCharge + surcharge) * 100) / 100;

    // Payment parts: one mode for the whole bill, or a split across two.
    const METHODS = ['CASH', 'CARD', 'UPI', 'ONLINE', 'OTHER'];
    let parts: Array<{ method: string; amount: number; reference: string | null }>;
    if (Array.isArray(payload.payments) && payload.payments.length > 0) {
      if (payload.payments.length > 2) {
        throw AppError.badRequest('A bill can be split across at most 2 payment modes.');
      }
      parts = payload.payments.map((p) => ({
        method: String(p?.method || '').toUpperCase(),
        amount: Math.round((Number(p?.amount) || 0) * 100) / 100,
        reference: p?.reference ? String(p.reference) : null,
      }));
      for (const p of parts) {
        if (!METHODS.includes(p.method)) throw AppError.badRequest(`Unknown payment mode "${p.method}".`);
        if (!(p.amount > 0)) throw AppError.badRequest(`Enter an amount for ${p.method}.`);
      }
      if (parts.length === 2 && parts[0].method === parts[1].method) {
        throw AppError.badRequest('Pick two different payment modes to split a bill.');
      }
      const sum = Math.round(parts.reduce((t, p) => t + p.amount, 0) * 100) / 100;
      if (Math.abs(sum - grandTotal) > 0.01) {
        throw AppError.badRequest(`The split (${sum}) must add up to the Grand Total (${grandTotal}).`);
      }
    } else {
      const paymentAmount = payload.paymentAmount !== undefined ? payload.paymentAmount : grandTotal;
      if (paymentAmount < grandTotal) {
        throw AppError.badRequest(`Payment amount (${paymentAmount}) cannot be less than Grand Total (${grandTotal})`);
      }
      parts = [{ method: String(payload.paymentMethod || 'CASH').toUpperCase(), amount: grandTotal, reference: payload.paymentReference || null }];
    }
    const billMethod = parts.map((p) => p.method).join('+');

    // Tendered and change belong to the cash part only.
    const cashPart = parts.find((p) => p.method === 'CASH')?.amount || 0;
    const cashTendered = cashPart > 0
      ? (payload.cashTendered ? Number(payload.cashTendered) : cashPart)
      : grandTotal;
    if (cashPart > 0 && cashTendered < cashPart) {
      throw AppError.badRequest(`Cash tendered (${cashTendered}) is less than the cash part (${cashPart}).`);
    }
    const changeReturned = cashPart > 0 ? Math.round(Math.max(0, cashTendered - cashPart) * 100) / 100 : 0;

    // 5. Create or reuse Order
    let orderId: number;
    let orderNumber: string;

    if (tabOrder) {
      orderId = tabOrder.id;
      orderNumber = tabOrder.order_number;

      await dbService.execute(
        `UPDATE orders
         SET status = 'COMPLETED', customer_id = ?, subtotal = ?, discount_type = ?, discount_value = ?,
             discount_amount = ?, tax_amount = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          payload.customerId || null,
          subtotal,
          payload.discountType || 'FIXED',
          discountVal,
          totalDiscounts,
          taxAmount,
          grandTotal,
          orderId,
        ]
      );
    } else {
      orderNumber = await SequenceUtil.nextDailyNumber('orders', 'order_number', 'ORD');

      const orderRes = await dbService.execute(
        `INSERT INTO orders (
          order_number, customer_id, dining_table_id, order_type,
          status, subtotal, discount_type, discount_value,
          discount_amount, tax_amount, total_amount, notes, created_by
        ) VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber,
          payload.customerId || null,
          payload.diningTableId || null,
          ParamUtil.orderType(payload.orderType),
          subtotal,
          payload.discountType || 'FIXED',
          discountVal,
          totalDiscounts,
          taxAmount,
          grandTotal,
          payload.notes || null,
          cashierId,
        ]
      );
      orderId = orderRes.lastInsertRowid;

      // Gapless position within the day, so a list never shows a hole left
      // by a withdrawn order. Separate from `order_number`, which stays
      // permanent because it is printed on the receipt.
      await DocumentSequence.assignForNew(ORDER_DOCUMENT, orderId);
    }

    // Order Items: lines already on the tab are there; write the rest.
    // On a tab they are the last kitchen round, so they get the next number.
    const newLines = verifiedItems.filter((l) => !l.locked);
    const round = tabOrder ? await this.nextKotRound(orderId) : null;
    await this.insertOrderLines(orderId, newLines, round);

    // 6. Generate Sequential Bill Number
    const billNumber = await SequenceUtil.nextDailyNumber('bills', 'bill_number', 'INV');

    // Deduct inventory as sale movements against the bill: the stock item
    // behind each dish, add-on, or add-on inside a combo. A line with no
    // linked stock item carries no balance to draw down.
    for (const item of verifiedItems) {
      for (const usage of item.stockUsages) {
        await StockService.recordMovement({
          stockId: usage.stockId,
          quantity: -usage.quantity,
          movementType: 'out',
          referenceType: 'SALE',
          referenceId: billNumber,
          notes: `Sold on ${billNumber}: ${item.quantity} x ${item.productName}${item.variantName ? ` (${item.variantName})` : ''}`,
          userId: cashierId,
        });
      }
    }

    // 7. Create Bill Record
    const billRes = await dbService.execute(
      `INSERT INTO bills (
        bill_number, order_id, customer_id, dining_table_id, cashier_id,
        order_type, subtotal, discount_type, discount_value,
        discount_amount, tax_amount, service_charge_amount, surcharge_amount,
        coupon_code, coupon_discount, total_amount, payment_status,
        payment_method, cash_tendered, change_returned, offline_sync_id, notes, printed_count,
        guest_name, guest_phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        billNumber,
        orderId,
        payload.customerId || null,
        payload.diningTableId || null,
        cashierId,
        ParamUtil.orderType(payload.orderType),
        subtotal,
        payload.discountType || 'FIXED',
        discountVal,
        discountAmount,
        taxAmount,
        serviceCharge,
        surcharge,
        payload.couponCode || null,
        couponDiscount,
        grandTotal,
        billMethod,
        cashTendered,
        changeReturned,
        payload.offlineSyncId || null,
        payload.notes || null,
        (payload as any).__guest?.name ?? null,
        (payload as any).__guest?.phone ?? null,
      ]
    );

    const billId = billRes.lastInsertRowid;

    // Gapless position within the day, so an invoice list never shows a hole
    // left by a withdrawn invoice. Separate from `bill_number`, which stays
    // permanent because it is printed on the customer's copy.
    await DocumentSequence.assignForNew(BILL_DOCUMENT, billId);

    // 8. Insert Bill Items
    for (const item of verifiedItems) {
      const billItemRes = await dbService.execute(
        `INSERT INTO bill_items (
          bill_id, product_id, product_name, variant_id, variant_name, stock_consumption,
          unit_price, quantity, subtotal, discount_amount, tax_amount, total_amount,
          is_complimentary, complimentary_reason, addons_data, item_type, combo_id, addon_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billId,
          item.productId,
          item.productName,
          item.variantId,
          item.variantName,
          item.stockConsumption,
          item.unitPrice,
          item.quantity,
          item.subtotal,
          item.subtotal,
          item.isComplimentary,
          item.complimentaryReason,
          item.addonsData,
          item.itemType,
          item.comboId,
          item.addonId,
        ]
      );

      // Record what one unit of this line took from each stock item, so a
      // later void, refund or cost report uses exactly this - not whatever
      // the dish's recipe says by then.
      for (const usage of item.stockUsages) {
        if (!(usage.quantity > 0) || !(item.quantity > 0)) continue;
        await dbService.execute(
          'INSERT INTO bill_item_stock_usage (bill_item_id, stock_id, quantity_per_unit) VALUES (?, ?, ?)',
          [billItemRes.lastInsertRowid, usage.stockId, Math.round((usage.quantity / item.quantity) * 1000) / 1000]
        );
      }
    }

    // 9. Payment Records: one per part, for the amount actually taken
    // (not the cash handed over - the change is on the bill).
    for (const p of parts) {
      await dbService.execute(
        `INSERT INTO payments (
          bill_id, order_id, payment_method, amount, status, reference_number, created_by
        ) VALUES (?, ?, ?, ?, 'PAID', ?, ?)`,
        [billId, orderId, p.method, p.amount, p.reference, cashierId]
      );
    }

    // 10. Update Customer Stats
    if (payload.customerId) {
      await dbService.execute(
        `UPDATE customers
         SET total_visits = total_visits + 1,
             total_spent = total_spent + ?,
             last_visit_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [grandTotal, payload.customerId]
      );
    }

    // 11. Free Table if dining
    if (payload.diningTableId) {
      await dbService.execute(
        `UPDATE dining_tables
         SET status = 'AVAILABLE',
             active_guest_count = 0,
             current_order_id = NULL,
             seated_at = NULL,
             cleaning_started_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [payload.diningTableId]
      );
    }

    // 11b. A booking loaded into this sale is fulfilled by how it was served -
    //      same transaction as the sale, so it is never marked without it.
    if (payload.reservationId) {
      await CheckoutService.fulfilBooking(
        Number(payload.reservationId),
        ParamUtil.orderType(payload.orderType) === 'DINING' ? 'DINING' : 'TAKEAWAY',
        payload.diningTableId ? Number(payload.diningTableId) : null
      );
    }

    // 12. Audit Log
    await AuditService.log({
      userId: cashierId,
      action: 'ORDER_CHECKOUT_COMPLETED',
      module: 'CHECKOUT',
      recordId: billId,
      newValues: {
        billNumber,
        orderNumber,
        orderType: ParamUtil.orderType(payload.orderType),
        paymentMethod: billMethod,
        payments: parts.length > 1 ? parts.map((p) => ({ method: p.method, amount: p.amount })) : undefined,
        grandTotal,
        itemCount: verifiedItems.length,
        offlineSyncId: payload.offlineSyncId || null,
      },
    });

    return await this.getBillSummary(billId);
  }

  /** Next kitchen round number for an order: 1 for its first KOT. */
  static async nextKotRound(orderId: number): Promise<number> {
    const row = await dbService.queryOne<{ r: number }>(
      'SELECT COALESCE(MAX(kot_round), 0) + 1 AS r FROM order_items WHERE order_id = ?',
      [orderId]
    );
    return Number(row?.r) || 1;
  }

  /** Writes verified lines to order_items, tagged with their kitchen round. */
  static async insertOrderLines(orderId: number, lines: VerifiedLine[], round: number | null): Promise<void> {
    for (const item of lines) {
      await dbService.execute(
        `INSERT INTO order_items (
          order_id, product_id, product_name, variant_id, variant_name,
          stock_consumption, unit_price, cost_price, quantity, subtotal,
          discount_amount, tax_amount, total_amount, addons_data, item_type, combo_id, addon_id, notes,
          is_complimentary, complimentary_reason, kot_round
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.productId,
          item.productName,
          item.variantId,
          item.variantName,
          item.stockConsumption,
          item.unitPrice,
          item.costPrice,
          item.quantity,
          item.subtotal,
          item.subtotal,
          item.addonsData,
          item.itemType,
          item.comboId,
          item.addonId,
          item.notes || null,
          item.isComplimentary ? 1 : 0,
          item.complimentaryReason,
          round,
        ]
      );
    }
  }

  /**
   * The lines already on an open tab, as locked inputs for verifyLines: same
   * dish, portion, add-ons and quantity, at the price they were ordered at.
   */
  static async loadTabLines(orderId: number): Promise<LockedLineInput[]> {
    const rows = await dbService.query<any>(
      `SELECT product_id, variant_id, quantity, unit_price, notes, addons_data, item_type,
              combo_id, addon_id, is_complimentary, complimentary_reason
       FROM order_items WHERE order_id = ? ORDER BY id ASC`,
      [orderId]
    );
    return rows.map((r) => {
      let addons: any[] = [];
      try {
        addons = r.addons_data ? JSON.parse(r.addons_data) : [];
      } catch (_) {
        addons = [];
      }
      return {
        productId: r.product_id,
        variantId: r.variant_id,
        quantity: Number(r.quantity) || 0,
        notes: r.notes || undefined,
        isComplimentary: Boolean(Number(r.is_complimentary)),
        complimentaryReason: r.complimentary_reason || undefined,
        selectedAddons: Array.isArray(addons) ? addons : [],
        itemType: r.item_type || 'PRODUCT',
        comboId: r.combo_id,
        addonId: r.addon_id,
        lockedUnitPrice: Number(r.unit_price) || 0,
      };
    });
  }

  static async getBillSummary(billId: number) {
    const bill = await dbService.queryOne(
      `SELECT b.*, o.order_number, COALESCE(c.name, b.guest_name) as customer_name, COALESCE(c.phone, b.guest_phone) as customer_phone,
              t.table_number, t.name as table_name,
              u.name as cashier_name
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN dining_tables t ON b.dining_table_id = t.id
       LEFT JOIN users u ON b.cashier_id = u.id
       WHERE b.id = ? AND b.is_deleted = 0`,
      [billId]
    );

    const items = await dbService.query(
      'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id ASC',
      [billId]
    );

    // The bill's own fields stay at the top level because that is the contract
    // every existing caller was written against: the POS reads
    // `res.data.bill_number` for the settled-bill toast and `res.data.id` to
    // fetch the KOT, and both silently became undefined when this started
    // returning only the nested form. `bill` and `items` are kept alongside so
    // newer callers that want the line items still get them.
    return {
      ...bill,
      bill,
      items,
    };
  }

  /**
   * Sync a batch of offline orders created while disconnected.
   */
  static async syncOfflineOrders(orders: CheckoutPayload[], cashierId: number) {
    await this.ensureSchema();
    if (!orders || orders.length === 0) {
      return { syncedCount: 0, results: [] };
    }

    const results: any[] = [];
    for (const order of orders) {
      try {
        const res = await this.processCheckout(order, cashierId);
        results.push({ success: true, offlineSyncId: order.offlineSyncId, bill: res.bill });
      } catch (err: any) {
        results.push({ success: false, offlineSyncId: order.offlineSyncId, error: err?.message || 'Sync failed' });
      }
    }

    return {
      syncedCount: results.filter((r) => r.success).length,
      totalCount: orders.length,
      results,
    };
  }
}
