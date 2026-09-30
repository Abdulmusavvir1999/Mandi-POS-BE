import { v4 as uuidv4 } from 'uuid';
import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { TableStatus } from '../models';
import { logger } from '../config/logger';
import { ParamUtil } from '../utils/param.util';
import { CheckoutService } from './checkout.service';

export type BookingType = 'TABLE' | 'PICKUP';

export interface ReservationItemInput {
  productId: number;
  variantId?: number | null;
  quantity: number;
  notes?: string;
}

export interface CreateReservationInput {
  /** TABLE - guests come to dine; PICKUP - the customer books a time and collects. */
  bookingType?: BookingType;
  /** Hours after reservation_time the booking stays open; then it expires. Default 24. */
  validHours?: number;
  /**
   * Dishes booked ahead - optional. Only saved here: stock is taken when the
   * customer arrives and the order is paid at the POS, like any other sale.
   */
  items?: ReservationItemInput[];
  tableId?: number;
  customerName: string;
  customerPhone: string;
  guestCount?: number;
  reservationTime: string;
  preferredSection?: string;
  specialRequests?: string;
}

export class DiningTablesService {
  private static schemaEnsured = false;

  /**
   * Current time on the database clock. seated_at / cleaning_started_at are
   * later diffed against NOW() in SQL, so they must come from the same clock:
   * new Date().toISOString() is UTC and made every fresh table start at +5h30m.
   */
  private static async dbNow(): Promise<string> {
    const row = await dbService.queryOne<{ now: string }>('SELECT NOW() AS now');
    return String(row?.now);
  }

  /**
   * Auto-ensures dining_tables columns and table_reservations exist.
   */
  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      // 1. Extend dining_tables status to VARCHAR(30)
      try {
        await dbService.execute("ALTER TABLE dining_tables MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE'");
      } catch (_) {}

      // Add columns if they don't exist
      const addColumnSafe = async (colName: string, colDef: string) => {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'dining_tables' 
              AND COLUMN_NAME = ?
          `, [colName]);

          if (!colCheck || colCheck.count === 0) {
            await dbService.execute(`ALTER TABLE dining_tables ADD COLUMN ${colName} ${colDef}`);
          }
        } catch (e) {
          logger.warn(`Could not check or add column ${colName} to dining_tables:`, e);
        }
      };

      await addColumnSafe('active_guest_count', 'INT NOT NULL DEFAULT 0');
      await addColumnSafe('seated_at', 'DATETIME NULL');
      await addColumnSafe('cleaning_started_at', 'DATETIME NULL');
      await addColumnSafe('reservation_id', 'INT NULL');

      // 2. Create table_reservations
      await dbService.execute(`
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
          booking_type ENUM('TABLE', 'PICKUP') NOT NULL DEFAULT 'TABLE',
          valid_hours INT NOT NULL DEFAULT 24,
          status ENUM('CONFIRMED', 'SEATED', 'PICKED_UP', 'EXPIRED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'CONFIRMED',
          created_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_tr_time (reservation_time),
          INDEX idx_tr_table (table_id),
          INDEX idx_tr_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 3. Pickup bookings: a booking type, and PICKED_UP as a pickup's
      //    "arrived" status (a table booking's is SEATED). For older databases.
      await dbService.execute(
        "ALTER TABLE table_reservations ADD COLUMN IF NOT EXISTS booking_type ENUM('TABLE', 'PICKUP') NOT NULL DEFAULT 'TABLE' AFTER reservation_code"
      );
      const statusCol = await dbService.queryOne<{ COLUMN_TYPE: string }>(
        `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'table_reservations' AND COLUMN_NAME = 'status'`
      );
      if (statusCol && !(String(statusCol.COLUMN_TYPE).includes("'PICKED_UP'") && String(statusCol.COLUMN_TYPE).includes("'EXPIRED'"))) {
        await dbService.execute(
          "ALTER TABLE table_reservations MODIFY COLUMN status ENUM('CONFIRMED', 'SEATED', 'PICKED_UP', 'EXPIRED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'CONFIRMED'"
        );
      }

      // 5. Dishes booked ahead (optional). Name, portion and price are copied
      //    at booking time so the list reads the same if the menu changes.
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS reservation_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          reservation_id INT NOT NULL,
          product_id INT NOT NULL,
          variant_id INT NULL,
          product_name VARCHAR(150) NOT NULL,
          variant_name VARCHAR(80) NULL,
          quantity INT NOT NULL,
          unit_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
          notes VARCHAR(255) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_ri_reservation (reservation_id),
          CONSTRAINT fk_ri_reservation FOREIGN KEY (reservation_id) REFERENCES table_reservations(id) ON DELETE CASCADE,
          CONSTRAINT fk_ri_product FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // 4. How long a booking stays open after its time before it expires.
      await dbService.execute(
        'ALTER TABLE table_reservations ADD COLUMN IF NOT EXISTS valid_hours INT NOT NULL DEFAULT 24 AFTER reservation_time'
      );

      this.schemaEnsured = true;
      logger.info('Dining and Table Management schema verified successfully.');
    } catch (err) {
      logger.error('Error ensuring dining tables schema:', err);
    }
  }

  /**
   * Checks the dishes on a booking and copies what the list shows (name,
   * portion, price). Only active, available dishes; a portion must belong to
   * its dish, and a dish with portions defaults to its default portion.
   * Nothing is reserved - stock is checked and taken at the POS on arrival.
   */
  private static async resolveReservationItems(input: ReservationItemInput[]) {
    const lines = (Array.isArray(input) ? input : []).filter((i) => i && Number(i.productId) > 0);
    if (lines.length > 50) throw AppError.badRequest('A booking can hold at most 50 dish lines');
    const out: {
      productId: number; variantId: number | null; productName: string; variantName: string | null;
      quantity: number; unitPrice: number; notes: string | null;
    }[] = [];
    for (const line of lines) {
      const quantity = Math.floor(Number(line.quantity) || 0);
      if (quantity < 1 || quantity > 999) throw AppError.badRequest('Each dish needs a quantity between 1 and 999');
      const product = await dbService.queryOne<any>('SELECT id, name, status, is_available FROM products WHERE id = ?', [Number(line.productId)]);
      if (!product) throw AppError.badRequest(`Dish ${line.productId} no longer exists`);
      if (product.status !== 'ACTIVE' || !product.is_available) {
        throw AppError.badRequest(`"${product.name}" is not available right now`);
      }
      let variant: any = null;
      if (line.variantId) {
        variant = await dbService.queryOne<any>(
          'SELECT id, name, selling_price FROM product_variants WHERE id = ? AND product_id = ?',
          [Number(line.variantId), product.id]
        );
        if (!variant) throw AppError.badRequest(`That portion is not on "${product.name}"`);
      } else {
        variant = await dbService.queryOne<any>(
          'SELECT id, name, selling_price FROM product_variants WHERE product_id = ? ORDER BY is_default DESC, display_order ASC, id ASC LIMIT 1',
          [product.id]
        );
      }
      out.push({
        productId: Number(product.id),
        variantId: variant ? Number(variant.id) : null,
        productName: product.name,
        variantName: variant ? variant.name : null,
        quantity,
        unitPrice: variant ? Number(variant.selling_price) || 0 : 0,
        notes: line.notes ? String(line.notes).slice(0, 255) : null,
      });
    }
    return out;
  }

  /** Sets `items` and `items_total` on each reservation row, in one query. */
  private static async attachReservationItems(rows: any[]) {
    for (const r of rows) { r.items = []; r.items_total = 0; }
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const items = await dbService.query<any>(
      `SELECT reservation_id, product_id, variant_id, product_name, variant_name, quantity, unit_price, notes
       FROM reservation_items WHERE reservation_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
      ids
    );
    const byId = new Map<number, any>(rows.map((r) => [Number(r.id), r]));
    for (const it of items) {
      const row = byId.get(Number(it.reservation_id));
      if (!row) continue;
      row.items.push({
        product_id: Number(it.product_id),
        variant_id: it.variant_id === null ? null : Number(it.variant_id),
        product_name: it.product_name,
        variant_name: it.variant_name,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        notes: it.notes,
      });
      row.items_total += Number(it.quantity) * Number(it.unit_price);
    }
  }

  /**
   * A CONFIRMED booking whose time plus its valid_hours (default 24) has
   * passed becomes EXPIRED, and any table it was holding is released.
   *
   * Run at the start of every read and action that could see such a booking
   * (the floor, the Reservations page, seat / pickup / convert / no-show), so
   * nothing depends on a background timer and an expired booking can never be
   * seated. Cheap when nothing is due: one indexed SELECT.
   */
  private static async expireOverdueReservations(): Promise<void> {
    try {
      const due = await dbService.query<{ id: number }>(
        `SELECT id FROM table_reservations
         WHERE status = 'CONFIRMED'
           AND DATE_ADD(reservation_time, INTERVAL COALESCE(valid_hours, 24) HOUR) <= NOW()`
      );
      if (due.length === 0) return;
      const ids = due.map((r) => Number(r.id));
      const marks = ids.map(() => '?').join(',');
      await dbService.transaction(async () => {
        await dbService.execute(
          `UPDATE table_reservations SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
           WHERE id IN (${marks}) AND status = 'CONFIRMED'`,
          ids
        );
        await dbService.execute(
          `UPDATE dining_tables SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
           WHERE status = 'RESERVED' AND reservation_id IN (${marks})`,
          ids
        );
      });
      logger.info(`Expired ${ids.length} reservation(s) past their valid hours`);
    } catch (err) {
      logger.warn('Could not expire overdue reservations:', err);
    }
  }

  static async getAll(section?: string, status?: string) {
    await this.ensureSchema();
    await this.expireOverdueReservations();

    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (section && section !== 'ALL') {
      where += ' AND t.section = ?';
      params.push(section);
    }

    if (status && status !== 'ALL') {
      where += ' AND t.status = ?';
      params.push(status);
    }

    const tables = await dbService.query(
      `SELECT t.*, 
              o.order_number, 
              COALESCE(t.seated_at, o.created_at) as order_start_time,
              c.name as customer_name, 
              c.phone as customer_phone,
              o.total_amount as order_current_total,
              o.status as order_status,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as order_item_count,
              tr.customer_name as reservation_customer,
              tr.reservation_time as reservation_time,
              tr.guest_count as reservation_guests,
              sb.id as seated_booking_id,
              sb.reservation_code as seated_booking_code,
              sb.customer_name as seated_booking_customer,
              sb.customer_phone as seated_booking_phone,
              CASE 
                WHEN t.status = 'OCCUPIED' AND COALESCE(t.seated_at, o.created_at) IS NOT NULL 
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(t.seated_at, o.created_at), NOW())
                ELSE 0 
              END as elapsed_minutes,
              CASE 
                WHEN t.status = 'CLEANING' AND t.cleaning_started_at IS NOT NULL 
                THEN TIMESTAMPDIFF(MINUTE, t.cleaning_started_at, NOW())
                ELSE 0 
              END as cleaning_minutes
       FROM dining_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id AND o.is_deleted = 0
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN table_reservations tr ON t.id = tr.table_id AND tr.status = 'CONFIRMED' AND DATE(tr.reservation_time) = CURDATE()
       -- Booked or walk-in: a booking seated on this table since the current
       -- party sat down (seating it and the table timer start together).
       LEFT JOIN table_reservations sb ON t.status = 'OCCUPIED' AND sb.id = (
         SELECT r2.id FROM table_reservations r2
         WHERE r2.table_id = t.id AND r2.status = 'SEATED'
           AND r2.updated_at >= COALESCE(t.seated_at, o.created_at) - INTERVAL 2 MINUTE
         ORDER BY r2.updated_at DESC LIMIT 1
       )
       ${where}
       ORDER BY t.display_order ASC, t.table_number ASC`,
      params
    );

    return tables;
  }

  static async getSections() {
    await this.ensureSchema();
    const rows = await dbService.query<{ section: string }>('SELECT DISTINCT section FROM dining_tables ORDER BY section ASC');
    return rows.map((r) => r.section);
  }

  static async getById(id: number) {
    await this.ensureSchema();
    const table = await dbService.queryOne(
      `SELECT t.*, 
              o.order_number, 
              COALESCE(t.seated_at, o.created_at) as order_start_time,
              c.name as customer_name, 
              c.phone as customer_phone,
              o.total_amount as order_current_total,
              o.status as order_status,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as order_item_count,
              tr.customer_name as reservation_customer,
              tr.reservation_time as reservation_time,
              tr.guest_count as reservation_guests,
              sb.id as seated_booking_id,
              sb.reservation_code as seated_booking_code,
              sb.customer_name as seated_booking_customer,
              sb.customer_phone as seated_booking_phone,
              CASE 
                WHEN t.status = 'OCCUPIED' AND COALESCE(t.seated_at, o.created_at) IS NOT NULL 
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(t.seated_at, o.created_at), NOW())
                ELSE 0 
              END as elapsed_minutes,
              CASE 
                WHEN t.status = 'CLEANING' AND t.cleaning_started_at IS NOT NULL 
                THEN TIMESTAMPDIFF(MINUTE, t.cleaning_started_at, NOW())
                ELSE 0 
              END as cleaning_minutes
       FROM dining_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id AND o.is_deleted = 0
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN table_reservations tr ON t.id = tr.table_id AND tr.status = 'CONFIRMED' AND DATE(tr.reservation_time) = CURDATE()
       -- Booked or walk-in: a booking seated on this table since the current
       -- party sat down (seating it and the table timer start together).
       LEFT JOIN table_reservations sb ON t.status = 'OCCUPIED' AND sb.id = (
         SELECT r2.id FROM table_reservations r2
         WHERE r2.table_id = t.id AND r2.status = 'SEATED'
           AND r2.updated_at >= COALESCE(t.seated_at, o.created_at) - INTERVAL 2 MINUTE
         ORDER BY r2.updated_at DESC LIMIT 1
       )
       WHERE t.id = ?`,
      [id]
    );

    if (!table) {
      throw AppError.notFound('Dining table not found');
    }

    return table;
  }

  /**
   * Table number and display name are each unique across the floor. The
   * column collation is case-insensitive, so 'T-07' and 't-07' collide too.
   * excludeId skips the table being edited.
   */
  private static async assertUnique(tableNumber?: string, name?: string, excludeId?: number) {
    const idClause = excludeId ? ' AND id != ?' : '';
    const idParam = excludeId ? [excludeId] : [];
    if (tableNumber) {
      const hit = await dbService.queryOne<{ name: string }>(
        'SELECT name FROM dining_tables WHERE TRIM(table_number) = ?' + idClause + ' LIMIT 1',
        [tableNumber, ...idParam]
      );
      if (hit) throw AppError.conflict('Table number "' + tableNumber + '" is already used by ' + hit.name);
    }
    if (name) {
      const hit = await dbService.queryOne<{ table_number: string }>(
        'SELECT table_number FROM dining_tables WHERE TRIM(name) = ?' + idClause + ' LIMIT 1',
        [name, ...idParam]
      );
      if (hit) throw AppError.conflict('Display name "' + name + '" is already used by table ' + hit.table_number);
    }
  }

  static async create(data: { tableNumber: string; name: string; section?: string; capacity?: number; displayOrder?: number }, userId: number) {
    await this.ensureSchema();
    data = { ...data, tableNumber: String(data.tableNumber ?? '').trim(), name: String(data.name ?? '').trim() };
    await this.assertUnique(data.tableNumber, data.name);

    const res = await dbService.execute(
      `INSERT INTO dining_tables (table_number, name, section, capacity, active_guest_count, status, display_order)
       VALUES (?, ?, ?, ?, 0, 'AVAILABLE', ?)`,
      [data.tableNumber, data.name, data.section || 'Main Hall', data.capacity || 4, data.displayOrder || 0]
    );

    await AuditService.log({
      userId,
      action: 'TABLE_CREATED',
      module: 'DINING',
      recordId: res.lastInsertRowid,
      newValues: data,
    });

    return await this.getById(res.lastInsertRowid);
  }

  static async update(
    id: number,
    data: {
      tableNumber?: string;
      name?: string;
      section?: string;
      capacity?: number;
      activeGuestCount?: number;
      status?: TableStatus;
      displayOrder?: number;
    },
    userId: number
  ) {
    await this.ensureSchema();
    const current = await this.getById(id);

    if (data.tableNumber !== undefined) data = { ...data, tableNumber: String(data.tableNumber).trim() || undefined };
    if (data.name !== undefined) data = { ...data, name: String(data.name).trim() || undefined };
    await this.assertUnique(data.tableNumber, data.name, id);

    await dbService.execute(
      `UPDATE dining_tables
       SET table_number = COALESCE(?, table_number),
           name = COALESCE(?, name),
           section = COALESCE(?, section),
           capacity = COALESCE(?, capacity),
           active_guest_count = COALESCE(?, active_guest_count),
           status = COALESCE(?, status),
           display_order = COALESCE(?, display_order),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.tableNumber ?? null, data.name ?? null, data.section ?? null, data.capacity ?? null, data.activeGuestCount ?? null, data.status ?? null, data.displayOrder ?? null, id]
    );

    await AuditService.log({
      userId,
      action: 'TABLE_UPDATED',
      module: 'DINING',
      recordId: id,
      oldValues: current,
      newValues: data,
    });

    return await this.getById(id);
  }

  static async setStatus(
    id: number,
    status: TableStatus,
    orderId?: number | null,
    guestCount?: number,
    userId?: number
  ) {
    await this.ensureSchema();
    const current = await this.getById(id);

    // Rule: a table with an unbilled tab cannot be released or sent to
    // cleaning - that would drop the order and the guests would never be
    // billed. (The floor sends orderId null, so this cannot key on undefined.)
    // An open order with nothing on it is simply closed.
    if ((status === 'AVAILABLE' || status === 'CLEANING') && current.current_order_id) {
      const order = await dbService.queryOne<{ id: number; status: string; order_number: string; line_count: number }>(
        `SELECT o.id, o.status, o.order_number, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS line_count
         FROM orders o WHERE o.id = ? AND o.is_deleted = 0`,
        [current.current_order_id]
      );
      if (order && order.status !== 'COMPLETED' && order.status !== 'CANCELLED') {
        if (Number(order.line_count) > 0) {
          throw AppError.conflict(
            `Table ${current.table_number} has an unbilled tab (${order.order_number}). Generate the bill or cancel the tab first.`
          );
        }
        await dbService.execute(`UPDATE orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [order.id]);
      }
    }

    let seatedAt = current.seated_at;
    let cleaningStartedAt = current.cleaning_started_at;
    let newGuestCount = guestCount !== undefined ? guestCount : current.active_guest_count;

    if (status === 'OCCUPIED') {
      seatedAt = seatedAt || await this.dbNow();
      cleaningStartedAt = null;
    } else if (status === 'CLEANING') {
      cleaningStartedAt = await this.dbNow();
      seatedAt = null;
      newGuestCount = 0;
      orderId = null;
    } else if (status === 'AVAILABLE') {
      seatedAt = null;
      cleaningStartedAt = null;
      newGuestCount = 0;
      orderId = null;
    } else if (status === 'RESERVED') {
      seatedAt = null;
      cleaningStartedAt = null;
    }

    await dbService.execute(
      `UPDATE dining_tables
       SET status = ?,
           current_order_id = ?,
           active_guest_count = ?,
           seated_at = ?,
           cleaning_started_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, orderId !== undefined ? orderId : current.current_order_id, newGuestCount, seatedAt, cleaningStartedAt, id]
    );

    await AuditService.log({
      userId: userId || 1,
      action: 'TABLE_STATUS_CHANGED',
      module: 'DINING',
      recordId: id,
      oldValues: { status: current.status, orderId: current.current_order_id },
      newValues: { status, orderId, guestCount: newGuestCount },
    });

    return await this.getById(id);
  }

  static async seatGuests(id: number, guestCount: number, orderId?: number | null, userId?: number) {
    await this.ensureSchema();
    const table = await this.getById(id);

    if (table.status === 'OCCUPIED' && table.current_order_id && orderId && table.current_order_id !== orderId) {
      throw AppError.conflict('Table is already occupied with another active dining order');
    }

    const seatedAt = await this.dbNow();

    await dbService.execute(`
      UPDATE dining_tables
      SET status = 'OCCUPIED',
          active_guest_count = ?,
          current_order_id = ?,
          seated_at = ?,
          cleaning_started_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [guestCount || 2, orderId || null, seatedAt, id]);

    await AuditService.log({
      userId: userId || 1,
      action: 'TABLE_GUESTS_SEATED',
      module: 'DINING',
      recordId: id,
      newValues: { guestCount, orderId },
    });

    return await this.getById(id);
  }

  static async cleanTable(id: number, userId?: number) {
    return await this.setStatus(id, 'CLEANING', null, 0, userId);
  }

  static async finishCleaning(id: number, userId?: number) {
    return await this.setStatus(id, 'AVAILABLE', null, 0, userId);
  }

  static async getTableHistory(tableId: number) {
    await this.ensureSchema();

    const history = await dbService.query(
      `SELECT o.id as order_id,
              o.order_number,
              o.order_type,
              o.status as order_status,
              o.total_amount,
              o.created_at as order_start_time,
              o.updated_at as order_end_time,
              b.bill_number,
              b.payment_method,
              u.name as staff_name,
              c.name as customer_name,
              c.phone as customer_phone,
              TIMESTAMPDIFF(MINUTE, o.created_at, o.updated_at) as duration_minutes
       FROM orders o
       LEFT JOIN bills b ON o.id = b.order_id AND b.is_deleted = 0
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.dining_table_id = ? AND o.is_deleted = 0
       ORDER BY o.created_at DESC
       LIMIT 30`,
      [tableId]
    );

    return history;
  }

  /**
   * Full history page for one table: filtered, paged rows plus totals over the
   * whole filtered range (not just the current page). Cancelled orders are
   * listed but kept out of revenue and turn-time figures.
   */
  static async getTableHistoryPage(opts: {
    tableId: number;
    from?: string;
    to?: string;
    status?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    await this.ensureSchema();
    const table = await this.getById(opts.tableId);

    let where = 'WHERE o.dining_table_id = ? AND o.is_deleted = 0';
    const params: any[] = [opts.tableId];
    if (opts.from) {
      where += ' AND o.created_at >= ?';
      params.push(opts.from);
    }
    if (opts.to) {
      where += ' AND o.created_at < DATE_ADD(?, INTERVAL 1 DAY)';
      params.push(opts.to);
    }
    if (opts.status) {
      where += ' AND o.status = ?';
      params.push(opts.status);
    }
    if (opts.search) {
      where += ' AND (o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
      const term = ParamUtil.like(opts.search);
      params.push(term, term, term);
    }

    // One bill per order: the latest live one, so a re-billed order is not doubled.
    const billJoin = `LEFT JOIN bills b ON b.id = (
        SELECT MAX(b2.id) FROM bills b2 WHERE b2.order_id = o.id AND b2.is_deleted = 0
      )`;
    const endExpr = 'COALESCE(b.created_at, o.updated_at)';

    const summary = await dbService.queryOne<any>(
      `SELECT COUNT(*) AS sessions,
              SUM(o.status <> 'CANCELLED') AS completed_sessions,
              SUM(o.status = 'CANCELLED') AS cancelled_sessions,
              COALESCE(SUM(CASE WHEN o.status <> 'CANCELLED' THEN o.total_amount END), 0) AS revenue,
              COALESCE(AVG(CASE WHEN o.status <> 'CANCELLED' THEN o.total_amount END), 0) AS avg_bill,
              COALESCE(AVG(CASE WHEN o.status <> 'CANCELLED' THEN TIMESTAMPDIFF(MINUTE, o.created_at, ${endExpr}) END), 0) AS avg_minutes,
              MAX(o.created_at) AS last_session_at
       FROM orders o
       ${billJoin}
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}`,
      params
    );

    const offset = (opts.page - 1) * opts.limit;
    const rows = await dbService.query(
      `SELECT o.id AS order_id,
              o.order_number,
              o.order_type,
              o.status AS order_status,
              o.total_amount,
              o.created_at AS order_start_time,
              ${endExpr} AS order_end_time,
              TIMESTAMPDIFF(MINUTE, o.created_at, ${endExpr}) AS duration_minutes,
              b.bill_number,
              b.payment_method,
              b.payment_status,
              u.name AS staff_name,
              c.id AS customer_id,
              c.name AS customer_name,
              c.phone AS customer_phone
       FROM orders o
       ${billJoin}
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ${Number(opts.limit)} OFFSET ${Number(offset)}`,
      params
    );

    return {
      table,
      summary: {
        sessions: Number(summary?.sessions) || 0,
        completed_sessions: Number(summary?.completed_sessions) || 0,
        cancelled_sessions: Number(summary?.cancelled_sessions) || 0,
        revenue: Number(summary?.revenue) || 0,
        avg_bill: Number(summary?.avg_bill) || 0,
        avg_minutes: Math.round(Number(summary?.avg_minutes) || 0),
        last_session_at: summary?.last_session_at || null,
      },
      rows,
      total: Number(summary?.sessions) || 0,
      page: opts.page,
      limit: opts.limit,
    };
  }

  /** One past (or open) order on a table: its lines by kitchen round, and its bill if it has one. */
  static async getHistoryDetail(orderId: number) {
    await this.ensureSchema();
    const order = await dbService.queryOne<any>(
      `SELECT o.*, u.name AS staff_name, c.name AS customer_name, c.phone AS customer_phone,
              t.table_number, t.section AS table_section
       FROM orders o
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN dining_tables t ON t.id = o.dining_table_id
       WHERE o.id = ? AND o.is_deleted = 0`,
      [orderId]
    );
    if (!order) throw AppError.notFound('Order not found');

    const items = await dbService.query<any>(
      `SELECT id, product_name, variant_name, unit_price, quantity, subtotal, notes, addons_data,
              item_type, is_complimentary, complimentary_reason, kot_round, created_at
       FROM order_items WHERE order_id = ?
       ORDER BY COALESCE(kot_round, 0) ASC, id ASC`,
      [orderId]
    );

    const bill = await dbService.queryOne<any>(
      `SELECT b.id, b.bill_number, b.subtotal, b.discount_amount, b.coupon_code, b.coupon_discount,
              b.tax_amount, b.service_charge_amount, b.surcharge_amount, b.total_amount,
              b.payment_method, b.payment_status, b.cash_tendered, b.change_returned,
              b.is_voided, b.void_reason, b.created_at, u.name AS cashier_name
       FROM bills b LEFT JOIN users u ON u.id = b.cashier_id
       WHERE b.order_id = ? AND b.is_deleted = 0
       ORDER BY b.id DESC LIMIT 1`,
      [orderId]
    );

    const parseAddons = (raw: any) => {
      try {
        const a = raw ? JSON.parse(raw) : [];
        return Array.isArray(a) ? a : [];
      } catch (_) {
        return [];
      }
    };

    return {
      order,
      items: items.map((i) => ({
        ...i,
        is_complimentary: Boolean(Number(i.is_complimentary)),
        selected_addons: parseAddons(i.addons_data),
      })),
      bill: bill ? { ...bill, is_voided: Boolean(Number(bill.is_voided)) } : null,
    };
  }

  static async delete(id: number, userId: number) {
    await this.ensureSchema();
    const current = await this.getById(id);
    if (current.status === 'OCCUPIED') {
      throw AppError.badRequest('Cannot delete an occupied table');
    }

    await dbService.execute('DELETE FROM dining_tables WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'TABLE_DELETED',
      module: 'DINING',
      recordId: id,
      oldValues: current,
    });

    return { success: true, message: 'Dining table deleted successfully' };
  }

  /**
   * =========================================================================
   * TABLE RESERVATIONS
   * =========================================================================
   */
  static async getReservations(options: { date?: string; status?: string } = {}) {
    await this.ensureSchema();
    await this.expireOverdueReservations();

    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (options.date) {
      where += ' AND DATE(r.reservation_time) = DATE(?)';
      params.push(options.date);
    } else {
      where += ' AND DATE(r.reservation_time) >= CURDATE()';
    }

    if (options.status && options.status !== 'ALL') {
      where += ' AND r.status = ?';
      params.push(options.status);
    }

    const reservations = await dbService.query(
      `SELECT r.*, t.table_number, t.name as table_name, t.section as table_section, t.capacity as table_capacity
       FROM table_reservations r
       LEFT JOIN dining_tables t ON r.table_id = t.id
       ${where}
       ORDER BY r.reservation_time ASC`,
      params
    );

    return reservations;
  }

  static async createReservation(data: CreateReservationInput, userId: number) {
    await this.ensureSchema();

    // Date-prefixed so the daily counter can restart without colliding with
    // yesterday's codes (reservation_code is UNIQUE; the old "RSV-101" form
    // repeated every day and the second day's first booking failed).
    const countRes = await dbService.queryOne<{ count: number; ymd: string }>(
      `SELECT COUNT(*) AS count, DATE_FORMAT(CURDATE(), '%y%m%d') AS ymd
       FROM table_reservations WHERE created_at >= CURDATE()`
    );
    const nextCode = `RSV-${countRes?.ymd}-${String(Number(countRes?.count || 0) + 1).padStart(3, '0')}`;
    const uuid = uuidv4();

    // Booking the table and holding it are one action: a failure between them
    // left a confirmed reservation against a table still showing AVAILABLE,
    // which the floor would then seat to someone else.
    const items = await this.resolveReservationItems(data.items || []);
    if (items.length) {
      // Same rule as the till: every dish line added up per stock item. Nothing
      // is held - this only stops a booking the kitchen could not make now.
      const check = await CheckoutService.stockCheck(
        items.map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity }))
      );
      const over = check.lines.find((l) => !l.ok);
      if (over) {
        const it = items[over.index];
        const label = it.productName + (it.variantName ? ' (' + it.variantName + ')' : '');
        throw AppError.badRequest(
          over.max && over.max > 0
            ? `Only ${over.max} of ${label} can be made from current stock`
            : `${label} is out of stock`
        );
      }
    }

    // A pickup holds a time slot only: no table, and no party to seat.
    const isPickup = data.bookingType === 'PICKUP';
    const tableId = isPickup ? null : data.tableId || null;

    return await dbService.transaction(async () => {
      const res = await dbService.execute(`
        INSERT INTO table_reservations (
          uuid, reservation_code, booking_type, table_id, customer_name, customer_phone,
          guest_count, reservation_time, valid_hours, preferred_section, special_requests, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?)
      `, [
        uuid,
        nextCode,
        isPickup ? 'PICKUP' : 'TABLE',
        tableId,
        data.customerName.trim(),
        data.customerPhone.trim(),
        isPickup ? 1 : data.guestCount || 2,
        data.reservationTime,
        data.validHours && data.validHours > 0 ? Math.floor(data.validHours) : 24,
        isPickup ? null : data.preferredSection || null,
        data.specialRequests || null,
        userId,
      ]);

      const rsvId = res.lastInsertRowid;

      for (const it of items) {
        await dbService.execute(
          `INSERT INTO reservation_items (reservation_id, product_id, variant_id, product_name, variant_name, quantity, unit_price, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [rsvId, it.productId, it.variantId, it.productName, it.variantName, it.quantity, it.unitPrice, it.notes]
        );
      }

      // If table assigned, mark table as RESERVED
      if (tableId) {
        await dbService.execute(`
          UPDATE dining_tables
          SET status = 'RESERVED', reservation_id = ?, active_guest_count = ?
          WHERE id = ? AND status = 'AVAILABLE'
        `, [rsvId, data.guestCount || 2, tableId]);
      }

      await AuditService.log({
        userId,
        action: 'TABLE_RESERVATION_CREATED',
        module: 'DINING',
        recordId: rsvId,
        newValues: { code: nextCode, type: isPickup ? 'PICKUP' : 'TABLE', customer: data.customerName, tableId, dishes: items.length },
      });

      return await dbService.queryOne('SELECT * FROM table_reservations WHERE id = ?', [rsvId]);
    });
  }

  static async seatReservation(reservationId: number, tableId: number, userId: number) {
    await this.ensureSchema();
    await this.expireOverdueReservations();
    const rsv = await dbService.queryOne<{ id: number; guest_count: number; table_id: number; status: string }>(
      'SELECT * FROM table_reservations WHERE id = ?',
      [reservationId]
    );

    if (!rsv) throw AppError.notFound('Reservation not found');

    if (rsv.status !== 'CONFIRMED') {
      throw AppError.badRequest('Only confirmed reservations can be seated');
    }
    if ((rsv as any).booking_type === 'PICKUP') {
      throw AppError.badRequest('This is a pickup booking - mark it as picked up instead of seating it');
    }

    const targetTableId = tableId || rsv.table_id;
    if (!targetTableId) throw AppError.badRequest('Please select a table to seat the reservation');

    const target = await this.getById(targetTableId);
    const heldForThis = target.status === 'RESERVED' && Number(target.reservation_id) === Number(reservationId);
    if (target.status !== 'AVAILABLE' && !heldForThis) {
      throw AppError.conflict(`Table ${target.table_number} is ${String(target.status).toLowerCase()}, choose another table`);
    }

    return await dbService.transaction(async () => {
      // Seating somewhere other than the held table: give the held one back.
      if (rsv.table_id && Number(rsv.table_id) !== Number(targetTableId)) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
           WHERE id = ? AND status = 'RESERVED' AND reservation_id = ?`,
          [rsv.table_id, reservationId]
        );
      }

      // 1. Mark reservation SEATED
      await dbService.execute(`
        UPDATE table_reservations 
        SET status = 'SEATED', table_id = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [targetTableId, reservationId]);

      // 2. Mark table OCCUPIED with guest count and live timer
      const seatedAt = await this.dbNow();
      await dbService.execute(`
        UPDATE dining_tables 
        SET status = 'OCCUPIED', 
            active_guest_count = ?, 
            seated_at = ?,
            reservation_id = ?,
            cleaning_started_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [rsv.guest_count || 2, seatedAt, reservationId, targetTableId]);

      await AuditService.log({
        userId,
        action: 'RESERVATION_SEATED',
        module: 'DINING',
        recordId: reservationId,
        newValues: { tableId: targetTableId },
      });

      return await this.getById(targetTableId);
    });
  }

  /**
   * Reservations page: rows in a date range plus counts for the KPI strip.
   * `from`/`to` are inclusive calendar days; omit both for everything upcoming.
   */
  static async listReservations(opts: { from?: string; to?: string; status?: string; search?: string }) {
    await this.ensureSchema();
    await this.expireOverdueReservations();

    let where = 'WHERE 1=1';
    const params: any[] = [];
    if (opts.from) {
      where += ' AND r.reservation_time >= ?';
      params.push(opts.from);
    }
    if (opts.to) {
      where += ' AND r.reservation_time < DATE_ADD(?, INTERVAL 1 DAY)';
      params.push(opts.to);
    }
    if (!opts.from && !opts.to) {
      where += ' AND r.reservation_time >= CURDATE()';
    }
    if (opts.search) {
      where += ' AND (r.customer_name LIKE ? OR r.customer_phone LIKE ? OR r.reservation_code LIKE ?)';
      const term = ParamUtil.like(opts.search);
      params.push(term, term, term);
    }

    // Counts ignore the status filter so the chips can show how many each holds.
    const counts = await dbService.queryOne<any>(
      `SELECT COUNT(*) AS total,
              SUM(r.status = 'CONFIRMED') AS confirmed,
              SUM(r.status = 'SEATED') AS seated,
              SUM(r.status = 'PICKED_UP') AS picked_up,
              SUM(r.status = 'EXPIRED') AS expired,
              SUM(r.booking_type = 'PICKUP') AS pickups,
              SUM(r.status = 'CANCELLED') AS cancelled,
              SUM(r.status = 'NO_SHOW') AS no_show,
              COALESCE(SUM(CASE WHEN r.booking_type = 'TABLE' AND r.status IN ('CONFIRMED', 'SEATED') THEN r.guest_count END), 0) AS covers,
              SUM(r.status = 'CONFIRMED' AND r.reservation_time < NOW()) AS late
       FROM table_reservations r
       ${where}`,
      params
    );

    let rowWhere = where;
    const rowParams = [...params];
    if (opts.status) {
      rowWhere += ' AND r.status = ?';
      rowParams.push(opts.status);
    }

    const rows = await dbService.query(
      `SELECT r.*, t.table_number, t.name AS table_name, t.section AS table_section,
              t.capacity AS table_capacity, t.status AS table_status,
              TIMESTAMPDIFF(MINUTE, NOW(), r.reservation_time) AS minutes_until,
              DATE_ADD(r.reservation_time, INTERVAL COALESCE(r.valid_hours, 24) HOUR) AS expires_at,
              -- Measured by the database clock, so the screen's countdown does
              -- not depend on the device clock being right.
              TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(r.reservation_time, INTERVAL COALESCE(r.valid_hours, 24) HOUR)) AS seconds_to_expiry
       FROM table_reservations r
       LEFT JOIN dining_tables t ON r.table_id = t.id
       ${rowWhere}
       ORDER BY r.reservation_time ASC, r.id ASC
       LIMIT 500`,
      rowParams
    );

    await this.attachReservationItems(rows as any[]);

    const today = await dbService.queryOne<any>(
      `SELECT COUNT(*) AS bookings,
              COALESCE(SUM(CASE WHEN booking_type = 'TABLE' AND status IN ('CONFIRMED', 'SEATED') THEN guest_count END), 0) AS covers,
              SUM(status = 'CONFIRMED') AS pending,
              SUM(status = 'SEATED') AS seated
       FROM table_reservations
       WHERE reservation_time >= CURDATE() AND reservation_time < CURDATE() + INTERVAL 1 DAY`
    );

    const n = (v: any) => Number(v) || 0;
    return {
      rows,
      counts: {
        total: n(counts?.total),
        confirmed: n(counts?.confirmed),
        seated: n(counts?.seated),
        picked_up: n(counts?.picked_up),
        expired: n(counts?.expired),
        pickups: n(counts?.pickups),
        cancelled: n(counts?.cancelled),
        no_show: n(counts?.no_show),
        covers: n(counts?.covers),
        late: n(counts?.late),
      },
      today: {
        bookings: n(today?.bookings),
        covers: n(today?.covers),
        pending: n(today?.pending),
        seated: n(today?.seated),
      },
    };
  }

  /**
   * The customer booked a pickup but now wants to dine in: turn the booking
   * into a table booking, keeping its code, customer and time. It stays
   * CONFIRMED - seat it as usual - and, when a table is chosen, that table is
   * held for it exactly as a new table booking would hold it.
   */
  static async convertPickupToTable(
    reservationId: number,
    data: { guestCount: number; tableId?: number | null },
    userId: number
  ) {
    await this.ensureSchema();
    await this.expireOverdueReservations();
    const rsv = await dbService.queryOne<{ id: number; status: string; booking_type: string; reservation_code: string }>(
      'SELECT id, status, booking_type, reservation_code FROM table_reservations WHERE id = ?',
      [reservationId]
    );
    if (!rsv) throw AppError.notFound('Reservation not found');
    if (rsv.booking_type !== 'PICKUP') {
      throw AppError.badRequest('This booking is already a table booking');
    }
    if (rsv.status !== 'CONFIRMED') {
      throw AppError.badRequest('Only confirmed pickup bookings can be changed to dine-in');
    }
    const guestCount = Math.floor(Number(data.guestCount) || 0);
    if (guestCount < 1 || guestCount > 500) throw AppError.badRequest('Invalid party size');

    const tableId = data.tableId || null;
    if (tableId) {
      const table = await this.getById(tableId);
      if (table.status !== 'AVAILABLE') {
        throw AppError.conflict(`Table ${table.table_number} is ${String(table.status).toLowerCase()}, choose another table`);
      }
    }

    await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE table_reservations
         SET booking_type = 'TABLE', guest_count = ?, table_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [guestCount, tableId, reservationId]
      );
      if (tableId) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'RESERVED', reservation_id = ?, active_guest_count = ?
           WHERE id = ? AND status = 'AVAILABLE'`,
          [reservationId, guestCount, tableId]
        );
      }
    });

    await AuditService.log({
      userId,
      action: 'RESERVATION_PICKUP_TO_TABLE',
      module: 'DINING',
      recordId: reservationId,
      newValues: { code: rsv.reservation_code, guestCount, tableId },
    });

    // Same shape as a Reservations page row, so the screen can keep using it.
    return await dbService.queryOne(
      `SELECT r.*, t.table_number, t.name AS table_name, t.section AS table_section,
              t.capacity AS table_capacity, t.status AS table_status,
              TIMESTAMPDIFF(MINUTE, NOW(), r.reservation_time) AS minutes_until
       FROM table_reservations r
       LEFT JOIN dining_tables t ON r.table_id = t.id
       WHERE r.id = ?`,
      [reservationId]
    );
  }

  /**
   * The other way round: a table booking the customer now wants to collect.
   * It becomes a PICKUP with the same code, customer, time, dishes and
   * validity; any table it was holding is released, and it no longer seats
   * anyone.
   */
  static async convertTableToPickup(reservationId: number, userId: number) {
    await this.ensureSchema();
    await this.expireOverdueReservations();
    const rsv = await dbService.queryOne<{ id: number; status: string; booking_type: string; table_id: number | null; reservation_code: string }>(
      'SELECT id, status, booking_type, table_id, reservation_code FROM table_reservations WHERE id = ?',
      [reservationId]
    );
    if (!rsv) throw AppError.notFound('Reservation not found');
    if (rsv.booking_type === 'PICKUP') throw AppError.badRequest('This booking is already a pickup');
    if (rsv.status !== 'CONFIRMED') {
      throw AppError.badRequest('Only confirmed table bookings can be changed to pickup');
    }

    await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE table_reservations
         SET booking_type = 'PICKUP', table_id = NULL, guest_count = 1, preferred_section = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [reservationId]
      );
      if (rsv.table_id) {
        await dbService.execute(
          `UPDATE dining_tables SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
           WHERE id = ? AND status = 'RESERVED' AND reservation_id = ?`,
          [rsv.table_id, reservationId]
        );
      }
    });

    await AuditService.log({
      userId,
      action: 'RESERVATION_TABLE_TO_PICKUP',
      module: 'DINING',
      recordId: reservationId,
      newValues: { code: rsv.reservation_code, releasedTableId: rsv.table_id },
    });

    return { success: true };
  }

  /**
   * The POS served a booking: a dining round for it went to the kitchen (or
   * it was billed). Closes it by how it was served - see
   * CheckoutService.fulfilBooking - and audits it.
   */
  static async fulfilReservation(reservationId: number, servedAs: 'DINING' | 'TAKEAWAY', tableId: number | null, userId: number) {
    await this.ensureSchema();
    if (servedAs === 'DINING' && !tableId) throw AppError.badRequest('Pick a table to seat this booking');
    const status = await dbService.transaction(() => CheckoutService.fulfilBooking(reservationId, servedAs, tableId));
    if (!status) throw AppError.badRequest('This booking is no longer confirmed');
    await AuditService.log({
      userId,
      action: 'RESERVATION_FULFILLED',
      module: 'DINING',
      recordId: reservationId,
      newValues: { servedAs, tableId, status },
    });
    return { status };
  }

  /** A pickup booking collected: close it. No table is involved. */
  static async markReservationPickedUp(reservationId: number, userId: number) {
    await this.ensureSchema();
    await this.expireOverdueReservations();
    const rsv = await dbService.queryOne<{ id: number; status: string; booking_type: string }>(
      'SELECT id, status, booking_type FROM table_reservations WHERE id = ?',
      [reservationId]
    );
    if (!rsv) throw AppError.notFound('Reservation not found');
    if (rsv.booking_type !== 'PICKUP') {
      throw AppError.badRequest('Only pickup bookings can be marked as picked up');
    }
    if (rsv.status !== 'CONFIRMED') {
      throw AppError.badRequest('Only confirmed bookings can be marked as picked up');
    }

    await dbService.execute(
      `UPDATE table_reservations SET status = 'PICKED_UP', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [reservationId]
    );

    await AuditService.log({
      userId,
      action: 'RESERVATION_PICKED_UP',
      module: 'DINING',
      recordId: reservationId,
    });

    return { success: true };
  }

  /** Guest never arrived: close the booking and free the table it was holding. */
  static async markReservationNoShow(reservationId: number, userId: number) {
    await this.ensureSchema();
    await this.expireOverdueReservations();
    const rsv = await dbService.queryOne<{ id: number; table_id: number; status: string }>(
      'SELECT * FROM table_reservations WHERE id = ?',
      [reservationId]
    );
    if (!rsv) throw AppError.notFound('Reservation not found');
    if (rsv.status !== 'CONFIRMED') {
      throw AppError.badRequest('Only confirmed reservations can be marked as no-show');
    }

    await dbService.transaction(async () => {
      await dbService.execute(
        `UPDATE table_reservations SET status = 'NO_SHOW', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [reservationId]
      );
      if (rsv.table_id) {
        await dbService.execute(
          `UPDATE dining_tables
           SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
           WHERE id = ? AND status = 'RESERVED' AND reservation_id = ?`,
          [rsv.table_id, reservationId]
        );
      }
    });

    await AuditService.log({
      userId,
      action: 'RESERVATION_NO_SHOW',
      module: 'DINING',
      recordId: reservationId,
    });

    return { success: true };
  }

  /**
   * Cancel several bookings at once. Only CONFIRMED ones are cancelled - a
   * seated, picked-up, no-show or already-cancelled booking is skipped and
   * reported, never changed. All of it is one transaction, so a failure part
   * way leaves every booking as it was. Each table held for a cancelled
   * booking is released.
   */
  static async cancelReservations(reservationIds: number[], userId: number) {
    await this.ensureSchema();
    const ids = [...new Set(reservationIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) throw AppError.badRequest('Select at least one booking to cancel');
    if (ids.length > 500) throw AppError.badRequest('Cancel at most 500 bookings at a time');

    const rows = await dbService.query<{ id: number; status: string; table_id: number | null; reservation_code: string }>(
      `SELECT id, status, table_id, reservation_code FROM table_reservations WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const cancellable = rows.filter((r) => r.status === 'CONFIRMED');
    const skipped = rows.filter((r) => r.status !== 'CONFIRMED').map((r) => r.reservation_code);
    const missing = ids.length - rows.length;

    if (cancellable.length > 0) {
      await dbService.transaction(async () => {
        for (const r of cancellable) {
          await dbService.execute(
            `UPDATE table_reservations SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'CONFIRMED'`,
            [r.id]
          );
          if (r.table_id) {
            await dbService.execute(
              `UPDATE dining_tables
               SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
               WHERE id = ? AND status = 'RESERVED' AND reservation_id = ?`,
              [r.table_id, r.id]
            );
          }
          await AuditService.log({
            userId,
            action: 'RESERVATION_CANCELLED',
            module: 'DINING',
            recordId: r.id,
            newValues: { bulk: true },
          });
        }
      });
    }

    return { cancelled: cancellable.length, skipped, missing };
  }

  static async cancelReservation(reservationId: number, userId: number) {
    await this.ensureSchema();
    const rsv = await dbService.queryOne<{ id: number; table_id: number }>(
      'SELECT * FROM table_reservations WHERE id = ?',
      [reservationId]
    );
    if (!rsv) throw AppError.notFound('Reservation not found');

    await dbService.transaction(async () => {
      await dbService.execute(`
        UPDATE table_reservations 
        SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [reservationId]);

      // Release table if linked
      if (rsv.table_id) {
        await dbService.execute(`
          UPDATE dining_tables 
          SET status = 'AVAILABLE', reservation_id = NULL, active_guest_count = 0
          WHERE id = ? AND status = 'RESERVED'
        `, [rsv.table_id]);
      }
    });

    await AuditService.log({
      userId,
      action: 'RESERVATION_CANCELLED',
      module: 'DINING',
      recordId: reservationId,
    });

    return { success: true, message: 'Reservation cancelled successfully' };
  }
}
