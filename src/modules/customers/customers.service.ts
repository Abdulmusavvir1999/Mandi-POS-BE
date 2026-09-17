import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { CustomerImageService } from './customer-image.service';

export class CustomersService {
  static async getAll(page = 1, limit = 50, search?: string) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM customers ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const customers = await dbService.query(
      `SELECT * FROM customers
       ${where}
       ORDER BY total_visits DESC, name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: customers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    const customer = await dbService.queryOne('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) {
      throw AppError.notFound('Customer not found');
    }
    return customer;
  }

  static async getByPhone(phone: string) {
    return await dbService.queryOne('SELECT * FROM customers WHERE phone = ?', [phone]);
  }

  static async create(data: { name: string; phone: string; email?: string; address?: string; image_url?: string; notes?: string }, userId: number) {
    const existing = await dbService.queryOne('SELECT id FROM customers WHERE phone = ?', [data.phone]);
    if (existing) {
      throw AppError.conflict('Customer with this phone number already exists');
    }

    const res = await dbService.execute(
      `INSERT INTO customers (name, phone, email, address, image_url, notes, status, total_visits, total_spent)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 0, 0.0)`,
      [data.name, data.phone, data.email || null, data.address || null, data.image_url || null, data.notes || null]
    );

    await AuditService.log({
      userId,
      action: 'CUSTOMER_CREATED',
      module: 'CUSTOMERS',
      recordId: res.lastInsertRowid,
      newValues: data,
    });

    return await this.getById(res.lastInsertRowid);
  }

  static async update(id: number, data: { name?: string; phone?: string; email?: string; address?: string; image_url?: string; notes?: string; status?: string }, userId: number) {
    const current = await this.getById(id);

    // A replaced or cleared photo would otherwise leave its file behind.
    if (data.image_url !== undefined && current?.image_url && current.image_url !== data.image_url) {
      CustomerImageService.removeByUrl(current.image_url);
    }

    if (data.phone && data.phone !== current.phone) {
      const existing = await dbService.queryOne('SELECT id FROM customers WHERE phone = ? AND id != ?', [data.phone, id]);
      if (existing) {
        throw AppError.conflict('Customer with this phone number already exists');
      }
    }

    await dbService.execute(
      `UPDATE customers
       SET name = COALESCE(?, name),
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           address = COALESCE(?, address),
           image_url = COALESCE(?, image_url),
           notes = COALESCE(?, notes),
           status = COALESCE(?, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.name, data.phone, data.email, data.address, data.image_url, data.notes, data.status, id]
    );

    await AuditService.log({
      userId,
      action: 'CUSTOMER_UPDATED',
      module: 'CUSTOMERS',
      recordId: id,
      oldValues: current,
      newValues: data,
    });

    return await this.getById(id);
  }

  static async delete(id: number, userId: number) {
    const current = await this.getById(id);
    await dbService.execute('DELETE FROM customers WHERE id = ?', [id]);
    CustomerImageService.removeByUrl((current as any)?.image_url);

    await AuditService.log({
      userId,
      action: 'CUSTOMER_DELETED',
      module: 'CUSTOMERS',
      recordId: id,
      oldValues: current,
    });

    return { success: true, message: 'Customer deleted successfully' };
  }

  static async getPurchaseHistory(id: number) {
    await this.getById(id); // verify existence

    const bills = await dbService.query(
      `SELECT b.*, u.name as cashier_name
       FROM bills b
       LEFT JOIN users u ON b.cashier_id = u.id
       WHERE b.customer_id = ?
       ORDER BY b.created_at DESC`,
      [id]
    );

    const billsWithItems = await Promise.all(bills.map(async (bill) => {
      const items = await dbService.query(
        'SELECT * FROM bill_items WHERE bill_id = ?',
        [bill.id]
      );
      return {
        ...bill,
        items,
      };
    }));

    return billsWithItems;
  }
}
