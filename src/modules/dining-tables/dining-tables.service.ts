import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { TableStatus } from '../../core/types';

export class DiningTablesService {
  static async getAll(section?: string, status?: string) {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (section) {
      where += ' AND t.section = ?';
      params.push(section);
    }

    if (status) {
      where += ' AND t.status = ?';
      params.push(status);
    }

    const tables = await dbService.query(
      `SELECT t.*, o.order_number, o.created_at as order_start_time,
              c.name as customer_name, c.phone as customer_phone,
              o.total_amount as order_current_total
       FROM dining_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}
       ORDER BY t.display_order ASC, t.table_number ASC`,
      params
    );

    return tables;
  }

  static async getSections() {
    const rows = await dbService.query<{ section: string }>('SELECT DISTINCT section FROM dining_tables ORDER BY section ASC');
    return rows.map((r) => r.section);
  }

  static async getById(id: number) {
    const table = await dbService.queryOne(
      `SELECT t.*, o.order_number, o.created_at as order_start_time,
              c.name as customer_name, c.phone as customer_phone,
              o.total_amount as order_current_total
       FROM dining_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE t.id = ?`,
      [id]
    );

    if (!table) {
      throw AppError.notFound('Dining table not found');
    }

    return table;
  }

  static async create(data: { tableNumber: string; name: string; section?: string; capacity?: number; displayOrder?: number }, userId: number) {
    const existing = await dbService.queryOne('SELECT id FROM dining_tables WHERE table_number = ?', [data.tableNumber]);
    if (existing) {
      throw AppError.conflict('Table number already exists');
    }

    const res = await dbService.execute(
      `INSERT INTO dining_tables (table_number, name, section, capacity, status, display_order)
       VALUES (?, ?, ?, ?, 'AVAILABLE', ?)`,
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

  static async update(id: number, data: { tableNumber?: string; name?: string; section?: string; capacity?: number; status?: TableStatus; displayOrder?: number }, userId: number) {
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
           status = COALESCE(?, status),
           display_order = COALESCE(?, display_order),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.tableNumber, data.name, data.section, data.capacity, data.status, data.displayOrder, id]
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

  static async setStatus(id: number, status: TableStatus, orderId?: number | null, userId?: number) {
    const current = await this.getById(id);

    // Protection rule: cannot release to AVAILABLE while active order is linked unless explicitly clearing
    if (status === 'AVAILABLE' && current.status === 'OCCUPIED' && current.current_order_id && orderId === undefined) {
      // Check if order is completed
      const order = await dbService.queryOne<{ status: string }>('SELECT status FROM orders WHERE id = ?', [current.current_order_id]);
      if (order && order.status !== 'COMPLETED' && order.status !== 'CANCELLED') {
        throw AppError.badRequest('Cannot release table while linked dining order is still active');
      }
    }

    await dbService.execute(
      `UPDATE dining_tables
       SET status = ?,
           current_order_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, orderId !== undefined ? orderId : current.current_order_id, id]
    );

    await AuditService.log({
      userId,
      action: 'TABLE_STATUS_CHANGED',
      module: 'DINING',
      recordId: id,
      oldValues: { status: current.status, orderId: current.current_order_id },
      newValues: { status, orderId },
    });

    return await this.getById(id);
  }

  static async delete(id: number, userId: number) {
    const current = await this.getById(id);
    if (current.status === 'OCCUPIED') {
      throw AppError.badRequest('Cannot delete occupied table');
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
}
