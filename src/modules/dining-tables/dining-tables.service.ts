import { v4 as uuidv4 } from 'uuid';
import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { TableStatus } from '../../core/types';
import { logger } from '../../config/logger';

export interface CreateReservationInput {
  tableId?: number;
  customerName: string;
  customerPhone: string;
  guestCount?: number;
  reservationTime: string;
  preferredSection?: string;
  specialRequests?: string;
}

export interface CreateWaitlistInput {
  customerName: string;
  customerPhone?: string;
  guestCount?: number;
  preferredSection?: string;
  estimatedWaitMinutes?: number;
}

export class DiningTablesService {
  private static schemaEnsured = false;

  /**
   * Auto-ensures dining_tables columns, table_reservations, and table_waitlist exist.
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
          status ENUM('CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'CONFIRMED',
          created_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_tr_time (reservation_time),
          INDEX idx_tr_table (table_id),
          INDEX idx_tr_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 3. Create table_waitlist
      await dbService.execute(`
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
          INDEX idx_wl_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Seed baseline reservations and waitlist if empty
      const rsvCount = await dbService.queryOne<{ total: number }>('SELECT COUNT(*) as total FROM table_reservations');
      if (!rsvCount || rsvCount.total === 0) {
        await dbService.execute(`
          INSERT IGNORE INTO table_reservations (
            uuid, reservation_code, table_id, customer_name, customer_phone, guest_count, reservation_time, preferred_section, special_requests, status
          ) VALUES 
          (?, 'RSV-101', 3, 'Fahad Al-Otaibi', '+966 50 444 8899', 6, DATE_ADD(CURDATE(), INTERVAL 19 HOUR), 'Family Cabins', 'Baby high chair requested; birthday dinner', 'CONFIRMED'),
          (?, 'RSV-102', 7, 'Eng. Mansoor Al-Zahrani', '+966 55 222 3311', 8, DATE_ADD(CURDATE(), INTERVAL 20 HOUR), 'Majlis Floor Seating', 'VIP Traditional Majlis setup', 'CONFIRMED')
        `, [uuidv4(), uuidv4()]);
      }

      const wlCount = await dbService.queryOne<{ total: number }>('SELECT COUNT(*) as total FROM table_waitlist');
      if (!wlCount || wlCount.total === 0) {
        await dbService.execute(`
          INSERT IGNORE INTO table_waitlist (
            uuid, token_number, customer_name, customer_phone, guest_count, preferred_section, estimated_wait_minutes, status
          ) VALUES 
          (?, 'W001', 'Dr. Salman Al-Ghamdi', '+966 54 888 1122', 4, 'Main Hall', 10, 'WAITING'),
          (?, 'W002', 'Khalid Al-Qurashi', '+966 56 123 9988', 2, 'Family Cabins', 15, 'WAITING'),
          (?, 'W003', 'Rayan Bin Saeed', '+966 53 777 5544', 5, 'Majlis Floor Seating', 20, 'WAITING')
        `, [uuidv4(), uuidv4(), uuidv4()]);
      }

      this.schemaEnsured = true;
      logger.info('Dining and Table Management schema verified successfully.');
    } catch (err) {
      logger.error('Error ensuring dining tables schema:', err);
    }
  }

  static async getAll(section?: string, status?: string) {
    await this.ensureSchema();

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
              tr.customer_name as reservation_customer,
              tr.reservation_time as reservation_time,
              tr.guest_count as reservation_guests,
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
       LEFT JOIN orders o ON t.current_order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN table_reservations tr ON t.id = tr.table_id AND tr.status = 'CONFIRMED' AND DATE(tr.reservation_time) = CURDATE()
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
              tr.customer_name as reservation_customer,
              tr.reservation_time as reservation_time,
              tr.guest_count as reservation_guests,
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
       LEFT JOIN orders o ON t.current_order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN table_reservations tr ON t.id = tr.table_id AND tr.status = 'CONFIRMED' AND DATE(tr.reservation_time) = CURDATE()
       WHERE t.id = ?`,
      [id]
    );

    if (!table) {
      throw AppError.notFound('Dining table not found');
    }

    return table;
  }

  static async create(data: { tableNumber: string; name: string; section?: string; capacity?: number; displayOrder?: number }, userId: number) {
    await this.ensureSchema();
    const existing = await dbService.queryOne('SELECT id FROM dining_tables WHERE table_number = ?', [data.tableNumber]);
    if (existing) {
      throw AppError.conflict('Table number already exists');
    }

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

    if (data.tableNumber && data.tableNumber !== current.table_number) {
      const existing = await dbService.queryOne('SELECT id FROM dining_tables WHERE table_number = ? AND id != ?', [data.tableNumber, id]);
      if (existing) {
        throw AppError.conflict('Table number already in use');
      }
    }

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

    // Rule: cannot release to AVAILABLE while active dining order is open
    if (status === 'AVAILABLE' && current.status === 'OCCUPIED' && current.current_order_id && orderId === undefined) {
      const order = await dbService.queryOne<{ status: string }>('SELECT status FROM orders WHERE id = ?', [current.current_order_id]);
      if (order && order.status !== 'COMPLETED' && order.status !== 'CANCELLED') {
        throw AppError.badRequest('Cannot release table while linked dining order is still active');
      }
    }

    let seatedAt = current.seated_at;
    let cleaningStartedAt = current.cleaning_started_at;
    let newGuestCount = guestCount !== undefined ? guestCount : current.active_guest_count;

    if (status === 'OCCUPIED') {
      seatedAt = seatedAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
      cleaningStartedAt = null;
    } else if (status === 'CLEANING') {
      cleaningStartedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
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

    const seatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

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
       LEFT JOIN bills b ON o.id = b.order_id
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.dining_table_id = ?
       ORDER BY o.created_at DESC
       LIMIT 30`,
      [tableId]
    );

    return history;
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

    const countRes = await dbService.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM table_reservations WHERE DATE(created_at) = CURDATE()'
    );
    const nextCode = `RSV-${(countRes?.count || 0) + 101}`;
    const uuid = uuidv4();

    const res = await dbService.execute(`
      INSERT INTO table_reservations (
        uuid, reservation_code, table_id, customer_name, customer_phone,
        guest_count, reservation_time, preferred_section, special_requests, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?)
    `, [
      uuid,
      nextCode,
      data.tableId || null,
      data.customerName.trim(),
      data.customerPhone.trim(),
      data.guestCount || 2,
      data.reservationTime,
      data.preferredSection || null,
      data.specialRequests || null,
      userId,
    ]);

    const rsvId = res.lastInsertRowid;

    // If table assigned, mark table as RESERVED
    if (data.tableId) {
      await dbService.execute(`
        UPDATE dining_tables 
        SET status = 'RESERVED', reservation_id = ?, active_guest_count = ?
        WHERE id = ? AND status = 'AVAILABLE'
      `, [rsvId, data.guestCount || 2, data.tableId]);
    }

    await AuditService.log({
      userId,
      action: 'TABLE_RESERVATION_CREATED',
      module: 'DINING',
      recordId: rsvId,
      newValues: { code: nextCode, customer: data.customerName, tableId: data.tableId },
    });

    return await dbService.queryOne('SELECT * FROM table_reservations WHERE id = ?', [rsvId]);
  }

  static async seatReservation(reservationId: number, tableId: number, userId: number) {
    await this.ensureSchema();
    const rsv = await dbService.queryOne<{ id: number; guest_count: number; table_id: number; status: string }>(
      'SELECT * FROM table_reservations WHERE id = ?',
      [reservationId]
    );

    if (!rsv) throw AppError.notFound('Reservation not found');

    const targetTableId = tableId || rsv.table_id;
    if (!targetTableId) throw AppError.badRequest('Please select a table to seat the reservation');

    return await dbService.transaction(async () => {
      // 1. Mark reservation SEATED
      await dbService.execute(`
        UPDATE table_reservations 
        SET status = 'SEATED', table_id = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [targetTableId, reservationId]);

      // 2. Mark table OCCUPIED with guest count and live timer
      const seatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
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

  /**
   * =========================================================================
   * WAITING LIST & QUEUE TOKENS
   * =========================================================================
   */
  static async getWaitlist() {
    await this.ensureSchema();

    const list = await dbService.query(
      `SELECT w.*, 
              TIMESTAMPDIFF(MINUTE, w.created_at, NOW()) as elapsed_wait_minutes,
              t.table_number, t.name as table_name
       FROM table_waitlist w
       LEFT JOIN dining_tables t ON w.assigned_table_id = t.id
       WHERE w.status IN ('WAITING', 'NOTIFIED') AND DATE(w.created_at) = CURDATE()
       ORDER BY w.id ASC`
    );

    return list;
  }

  static async addToWaitlist(data: CreateWaitlistInput, userId: number) {
    await this.ensureSchema();

    const countToday = await dbService.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM table_waitlist WHERE DATE(created_at) = CURDATE()'
    );
    const nextSeq = ((countToday?.count || 0) + 1).toString().padStart(3, '0');
    const tokenNumber = `W${nextSeq}`;
    const uuid = uuidv4();

    const res = await dbService.execute(`
      INSERT INTO table_waitlist (
        uuid, token_number, customer_name, customer_phone, guest_count,
        preferred_section, estimated_wait_minutes, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING', ?)
    `, [
      uuid,
      tokenNumber,
      data.customerName.trim(),
      data.customerPhone?.trim() || null,
      data.guestCount || 2,
      data.preferredSection || 'Any Section',
      data.estimatedWaitMinutes || 15,
      userId,
    ]);

    const waitlistId = res.lastInsertRowid;

    await AuditService.log({
      userId,
      action: 'WAITLIST_ENTRY_ADDED',
      module: 'DINING',
      recordId: waitlistId,
      newValues: { tokenNumber, customer: data.customerName, guestCount: data.guestCount },
    });

    return await dbService.queryOne('SELECT * FROM table_waitlist WHERE id = ?', [waitlistId]);
  }

  static async seatWaitlistParty(waitlistId: number, tableId: number, userId: number) {
    await this.ensureSchema();

    const entry = await dbService.queryOne<{ id: number; guest_count: number; customer_name: string }>(
      'SELECT * FROM table_waitlist WHERE id = ?',
      [waitlistId]
    );
    if (!entry) throw AppError.notFound('Waitlist party not found');

    const table = await this.getById(tableId);
    if (table.status === 'OCCUPIED') {
      throw AppError.badRequest('Selected table is already occupied');
    }

    return await dbService.transaction(async () => {
      const seatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

      // 1. Mark waitlist entry SEATED
      await dbService.execute(`
        UPDATE table_waitlist 
        SET status = 'SEATED', assigned_table_id = ?, seated_at = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [tableId, seatedAt, waitlistId]);

      // 2. Seat table
      await dbService.execute(`
        UPDATE dining_tables 
        SET status = 'OCCUPIED', 
            active_guest_count = ?, 
            seated_at = ?,
            cleaning_started_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [entry.guest_count || 2, seatedAt, tableId]);

      await AuditService.log({
        userId,
        action: 'WAITLIST_SEATED_AT_TABLE',
        module: 'DINING',
        recordId: waitlistId,
        newValues: { tableId, party: entry.customer_name },
      });

      return await this.getById(tableId);
    });
  }

  static async updateWaitlistStatus(waitlistId: number, status: 'WAITING' | 'NOTIFIED' | 'CANCELLED', userId: number) {
    await this.ensureSchema();
    await dbService.execute(`
      UPDATE table_waitlist 
      SET status = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [status, waitlistId]);

    await AuditService.log({
      userId,
      action: 'WAITLIST_STATUS_UPDATED',
      module: 'DINING',
      recordId: waitlistId,
      newValues: { status },
    });

    return { success: true, message: `Waitlist party status updated to ${status}` };
  }
}
