import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { CustomerImageService } from './customer-image.service';
import { logger } from '../config/logger';
import { ParamUtil } from '../utils/param.util';

export class CustomersService {
  private static schemaEnsured = false;

  /**
   * Auto-ensures customers columns and customer_notes table exist.
   */
  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    try {
      const addColumnSafe = async (colName: string, colDef: string) => {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'customers' 
              AND COLUMN_NAME = ?
          `, [colName]);

          if (!colCheck || colCheck.count === 0) {
            await dbService.execute(`ALTER TABLE customers ADD COLUMN ${colName} ${colDef}`);
          }
        } catch (e) {
          logger.warn(`Could not add column ${colName} to customers:`, e);
        }
      };

      await addColumnSafe('customer_code', 'VARCHAR(50) NULL');
      await addColumnSafe('loyalty_points', 'INT NOT NULL DEFAULT 0');
      await addColumnSafe('last_visit_at', 'DATETIME NULL');

      // Safely drop deprecated columns if they exist
      const deprecatedCols = ['tier', 'notes', 'is_deleted', 'deleted_at', 'deleted_by'];
      for (const col of deprecatedCols) {
        try {
          const colCheck = await dbService.queryOne<{ count: number }>(`
            SELECT COUNT(*) as count 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'customers' 
              AND COLUMN_NAME = ?
          `, [col]);
          if (colCheck && colCheck.count > 0) {
            await dbService.execute(`ALTER TABLE customers DROP COLUMN \`${col}\``);
          }
        } catch (_) {}
      }

      // Create customer_notes table
      await dbService.execute(`
        CREATE TABLE IF NOT EXISTS customer_notes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT NOT NULL,
          user_id INT NULL,
          author_name VARCHAR(100) NULL,
          note_type VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
          note_text TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_cust_notes_cid (customer_id),
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Ensure default customer_codes for existing customers
      await dbService.execute(`
        UPDATE customers 
        SET customer_code = CONCAT('CUST-', LPAD(id, 4, '0')) 
        WHERE customer_code IS NULL OR customer_code = ''
      `);

      // Backfill last_visit_at from bills if available
      try {
        await dbService.execute(`
          UPDATE customers 
          SET last_visit_at = COALESCE(
            (SELECT MAX(created_at) FROM bills WHERE bills.customer_id = customers.id AND bills.is_deleted = 0),
            created_at
          ) 
          WHERE last_visit_at IS NULL
        `);
      } catch (_) {}

      this.schemaEnsured = true;
    } catch (err) {
      logger.error('Failed to ensure customers schema:', err);
    }
  }

  static async getAll(page = 1, limit = 50, search?: string, segment?: string) {
    await this.ensureSchema();
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR customer_code LIKE ?)';
      const term = ParamUtil.like(search);
      params.push(term, term, term, term);
    }

    if (segment) {
      const seg = segment.toUpperCase();
      if (seg === 'VIP') {
        where += " AND total_spent >= 2500";
      } else if (seg === 'FREQUENT') {
        where += " AND (total_visits >= 5 OR (total_visits >= 3 AND DATEDIFF(NOW(), COALESCE(last_visit_at, created_at)) <= 30))";
      } else if (seg === 'AT_RISK') {
        where += " AND (total_visits >= 2 AND DATEDIFF(NOW(), COALESCE(last_visit_at, created_at)) > 45)";
      } else if (seg === 'NEW') {
        where += " AND (DATEDIFF(NOW(), created_at) <= 14 AND total_visits <= 1)";
      }
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM customers ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const customers = await dbService.query(
      `SELECT id, customer_code, name, phone, email, address, image_url, status, 
              loyalty_points, total_visits, total_spent, last_visit_at, created_at, updated_at,
              DATEDIFF(NOW(), COALESCE(last_visit_at, created_at)) as days_since_last_visit
       FROM customers
       ${where}
       ORDER BY total_visits DESC, name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Compute activity tag and AOV for each customer
    const enriched = customers.map((c: any) => {
      const visits = Number(c.total_visits || 0);
      const spent = Number(c.total_spent || 0);
      const aov = visits > 0 ? Math.round((spent / visits) * 100) / 100 : 0;
      const days = c.days_since_last_visit !== null && c.days_since_last_visit !== undefined 
        ? Number(c.days_since_last_visit) 
        : 999;

      let activity = 'ACTIVE';
      if (visits <= 1 && days <= 14) {
        activity = 'NEW';
      } else if (visits >= 5 || (visits >= 3 && days <= 21)) {
        activity = 'FREQUENT';
      } else if (visits >= 2 && days > 45) {
        activity = 'AT_RISK';
      } else if (days > 90) {
        activity = 'DORMANT';
      }

      return {
        ...c,
        avg_order_value: aov,
        activity_status: activity,
      };
    });

    return {
      data: enriched,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    await this.ensureSchema();
    const customer = await dbService.queryOne<any>(
      `SELECT id, customer_code, name, phone, email, address, image_url, status, 
              loyalty_points, total_visits, total_spent, last_visit_at, created_at, updated_at,
              DATEDIFF(NOW(), COALESCE(last_visit_at, created_at)) as days_since_last_visit
       FROM customers WHERE id = ?`,
      [id]
    );
    if (!customer) {
      throw AppError.notFound('Customer not found');
    }

    const visits = Number(customer.total_visits || 0);
    const spent = Number(customer.total_spent || 0);
    const aov = visits > 0 ? Math.round((spent / visits) * 100) / 100 : 0;
    const days = customer.days_since_last_visit !== null && customer.days_since_last_visit !== undefined 
      ? Number(customer.days_since_last_visit) 
      : 999;

    let activity = 'ACTIVE';
    if (visits <= 1 && days <= 14) {
      activity = 'NEW';
    } else if (visits >= 5 || (visits >= 3 && days <= 21)) {
      activity = 'FREQUENT';
    } else if (visits >= 2 && days > 45) {
      activity = 'AT_RISK';
    } else if (days > 90) {
      activity = 'DORMANT';
    }

    return {
      ...customer,
      avg_order_value: aov,
      activity_status: activity,
    };
  }

  static async getByPhone(phone: string) {
    await this.ensureSchema();
    return await dbService.queryOne('SELECT * FROM customers WHERE phone = ?', [phone]);
  }

  static async create(data: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    image_url?: string;
    customer_code?: string;
  }, userId: number) {
    await this.ensureSchema();
    const existing = await dbService.queryOne('SELECT id FROM customers WHERE phone = ?', [data.phone]);
    if (existing) {
      throw AppError.conflict('Customer with this phone number already exists');
    }

    const res = await dbService.execute(
      `INSERT INTO customers (name, phone, email, address, image_url, status, total_visits, total_spent, customer_code)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, 0.0, ?)`,
      [
        data.name,
        data.phone,
        data.email || null,
        data.address || null,
        data.image_url || null,
        data.customer_code || null,
      ]
    );

    const insertedId = res.lastInsertRowid;
    // Set customer_code if not supplied
    if (!data.customer_code) {
      const generatedCode = `CUST-${String(insertedId).padStart(4, '0')}`;
      await dbService.execute('UPDATE customers SET customer_code = ? WHERE id = ?', [generatedCode, insertedId]);
    }

    await AuditService.log({
      userId,
      action: 'CUSTOMER_CREATED',
      module: 'CUSTOMERS',
      recordId: insertedId,
      newValues: data,
    });

    return await this.getById(insertedId);
  }

  static async update(
    id: number,
    data: {
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      image_url?: string;
      status?: string;
      loyalty_points?: number;
      customer_code?: string;
    },
    userId: number
  ) {
    await this.ensureSchema();
    const current = await this.getById(id);

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
           status = COALESCE(?, status),
           loyalty_points = COALESCE(?, loyalty_points),
           customer_code = COALESCE(?, customer_code),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        data.name,
        data.phone,
        data.email,
        data.address,
        data.image_url,
        data.status,
        data.loyalty_points,
        data.customer_code,
        id,
      ]
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
    await this.ensureSchema();
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
       WHERE b.customer_id = ? AND b.is_deleted = 0
       ORDER BY b.created_at DESC`,
      [id]
    );

    const billsWithItems = await Promise.all(
      bills.map(async (bill: any) => {
        const items = await dbService.query(
          'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id ASC',
          [bill.id]
        );
        return {
          ...bill,
          items,
        };
      })
    );

    return billsWithItems;
  }

  /**
   * Customer Analytics Deep-Dive:
   * Total orders, total spent, AOV, visit frequency metrics, favorite items,
   * monthly spending history, and order type breakdown.
   */
  static async getCustomerAnalytics(id: number) {
    const customer = await this.getById(id);

    // 1. Order stats from bills
    const orderStats = await dbService.queryOne<{
      bill_count: number;
      sum_spent: number;
      first_bill_date: string | null;
      last_bill_date: string | null;
    }>(
      `SELECT COUNT(*) as bill_count,
              COALESCE(SUM(total_amount), 0) as sum_spent,
              MIN(created_at) as first_bill_date,
              MAX(created_at) as last_bill_date
       FROM bills
       WHERE customer_id = ? AND is_deleted = 0`,
      [id]
    );

    const totalOrders = Math.max(Number(customer.total_visits || 0), Number(orderStats?.bill_count || 0));
    const totalSpent = Math.max(Number(customer.total_spent || 0), Number(orderStats?.sum_spent || 0));
    const avgOrderValue = totalOrders > 0 ? Math.round((totalSpent / totalOrders) * 100) / 100 : 0;

    const firstVisit = orderStats?.first_bill_date || customer.created_at;
    const lastVisit = orderStats?.last_bill_date || customer.last_visit_at || customer.created_at;

    // Days since last visit
    let daysSinceLast = 0;
    if (lastVisit) {
      const diffMs = Date.now() - new Date(lastVisit).getTime();
      daysSinceLast = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    }

    // Customer frequency category
    let frequencyCategory = 'FIRST_TIME';
    if (totalOrders > 15) {
      frequencyCategory = 'VERY_FREQUENT';
    } else if (totalOrders >= 6) {
      frequencyCategory = 'FREQUENT';
    } else if (totalOrders >= 2) {
      frequencyCategory = 'REGULAR';
    }

    // 2. Favorite items (Top dishes ordered)
    const favoriteItems = await dbService.query<{
      product_name: string;
      product_id: number;
      total_qty: number;
      total_spent: number;
      last_ordered_at: string;
    }>(
      `SELECT bi.product_name,
              bi.product_id,
              SUM(bi.quantity) as total_qty,
              SUM(bi.subtotal) as total_spent,
              MAX(b.created_at) as last_ordered_at
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       WHERE b.customer_id = ? AND b.is_deleted = 0
       GROUP BY bi.product_name, bi.product_id
       ORDER BY total_qty DESC, total_spent DESC
       LIMIT 6`,
      [id]
    );

    // 3. Monthly spending history (last 6 months)
    const monthlySpending = await dbService.query<{
      month_key: string;
      order_count: number;
      total_spent: number;
    }>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as month_key,
              COUNT(*) as order_count,
              SUM(total_amount) as total_spent
       FROM bills
       WHERE customer_id = ? AND is_deleted = 0
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month_key DESC
       LIMIT 6`,
      [id]
    );

    // 4. Order type breakdown (Dining vs Takeaway vs Walk-in)
    const orderTypes = await dbService.query<{
      order_type: string;
      count: number;
      total_amount: number;
    }>(
      `SELECT order_type,
              COUNT(*) as count,
              SUM(total_amount) as total_amount
       FROM bills
       WHERE customer_id = ? AND is_deleted = 0
       GROUP BY order_type`,
      [id]
    );

    // 5. Recent 5 orders
    const recentBills = await dbService.query(
      `SELECT id, bill_number, order_type, payment_method, payment_status, total_amount, created_at
       FROM bills
       WHERE customer_id = ? AND is_deleted = 0
       ORDER BY created_at DESC
       LIMIT 5`,
      [id]
    );

    return {
      customer,
      summary: {
        total_orders: totalOrders,
        total_spent: totalSpent,
        avg_order_value: avgOrderValue,
        first_visit_at: firstVisit,
        last_visit_at: lastVisit,
        days_since_last_visit: daysSinceLast,
        frequency_category: frequencyCategory,
        activity_status: customer.activity_status,
      },
      favorite_items: favoriteItems,
      monthly_spending: monthlySpending.reverse(), // chronologically ascending
      order_type_breakdown: orderTypes,
      recent_orders: recentBills,
    };
  }

  // --- Customer Notes & Preferences ---

  static async getCustomerNotes(customerId: number) {
    await this.ensureSchema();
    await this.getById(customerId); // Verify customer exists

    return await dbService.query(
      `SELECT cn.*, u.name as user_full_name
       FROM customer_notes cn
       LEFT JOIN users u ON cn.user_id = u.id
       WHERE cn.customer_id = ?
       ORDER BY cn.created_at DESC`,
      [customerId]
    );
  }

  static async createCustomerNote(
    customerId: number,
    data: {
      note_type: string;
      note_text: string;
      author_name?: string;
    },
    userId: number
  ) {
    await this.ensureSchema();
    await this.getById(customerId); // Verify customer exists

    let author = data.author_name;
    if (!author && userId) {
      const user = await dbService.queryOne<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
      author = user?.name || 'Staff';
    }

    const res = await dbService.execute(
      `INSERT INTO customer_notes (customer_id, user_id, author_name, note_type, note_text)
       VALUES (?, ?, ?, ?, ?)`,
      [customerId, userId, author || 'Staff', data.note_type || 'GENERAL', data.note_text]
    );

    await AuditService.log({
      userId,
      action: 'CUSTOMER_NOTE_CREATED',
      module: 'CUSTOMERS',
      recordId: res.lastInsertRowid,
      newValues: { customerId, ...data },
    });

    return await dbService.queryOne('SELECT * FROM customer_notes WHERE id = ?', [res.lastInsertRowid]);
  }

  static async deleteCustomerNote(noteId: number, userId: number) {
    await this.ensureSchema();
    const note = await dbService.queryOne('SELECT * FROM customer_notes WHERE id = ?', [noteId]);
    if (!note) {
      throw AppError.notFound('Customer note not found');
    }

    await dbService.execute('DELETE FROM customer_notes WHERE id = ?', [noteId]);

    await AuditService.log({
      userId,
      action: 'CUSTOMER_NOTE_DELETED',
      module: 'CUSTOMERS',
      recordId: noteId,
      oldValues: note,
    });

    return { success: true, message: 'Note deleted successfully' };
  }

  // --- CRM Storewide Summary KPIs ---

  static async getCrmSummary() {
    await this.ensureSchema();

    const counts = await dbService.queryOne<{
      total_customers: number;
      vip_count: number;
      total_spent_sum: number;
      total_visits_sum: number;
      repeat_count: number;
    }>(`
      SELECT COUNT(*) as total_customers,
             SUM(CASE WHEN total_spent >= 2500 THEN 1 ELSE 0 END) as vip_count,
             COALESCE(SUM(total_spent), 0) as total_spent_sum,
             COALESCE(SUM(total_visits), 0) as total_visits_sum,
             SUM(CASE WHEN total_visits > 1 THEN 1 ELSE 0 END) as repeat_count
      FROM customers
    `);

    // Active in last 30 days
    const activeRes = await dbService.queryOne<{ count: number }>(`
      SELECT COUNT(*) as count 
      FROM customers 
      WHERE DATEDIFF(NOW(), COALESCE(last_visit_at, created_at)) <= 30
    `);

    // At risk: >= 2 visits but no visit in > 45 days
    const atRiskRes = await dbService.queryOne<{ count: number }>(`
      SELECT COUNT(*) as count 
      FROM customers 
      WHERE total_visits >= 2 AND DATEDIFF(NOW(), COALESCE(last_visit_at, created_at)) > 45
    `);

    const totalCustomers = Number(counts?.total_customers || 0);
    const repeatCount = Number(counts?.repeat_count || 0);
    const repeatRate = totalCustomers > 0 ? Math.round((repeatCount / totalCustomers) * 100) : 0;
    const totalSpent = Number(counts?.total_spent_sum || 0);
    const totalVisits = Number(counts?.total_visits_sum || 0);
    const storeAov = totalVisits > 0 ? Math.round((totalSpent / totalVisits) * 100) / 100 : 0;

    return {
      total_customers: totalCustomers,
      active_customers: Number(activeRes?.count || 0),
      vip_customers: Number(counts?.vip_count || 0),
      at_risk_customers: Number(atRiskRes?.count || 0),
      store_avg_order_value: storeAov,
      repeat_rate_percent: repeatRate,
    };
  }
}
