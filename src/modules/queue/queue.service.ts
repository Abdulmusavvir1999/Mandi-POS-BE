import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { QueueStatus } from '../../core/types';

export class QueueService {
  static async getAll(status?: QueueStatus, date?: string) {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (status) {
      where += ' AND q.status = ?';
      params.push(status);
    }

    if (date) {
      where += ' AND DATE(q.created_at) = DATE(?)';
      params.push(date);
    } else {
      where += " AND DATE(q.created_at) = CURDATE()";
    }

    const items = await dbService.query(
      `SELECT q.*, o.order_number, o.total_amount, o.order_type
       FROM queue q
       LEFT JOIN orders o ON q.order_id = o.id AND o.is_deleted = 0
       ${where}
       ORDER BY q.id ASC`,
      params
    );

    return items;
  }

  static async getPending() {
    return await dbService.query(
      `SELECT q.*, o.order_number, o.total_amount, o.order_type
       FROM queue q
       LEFT JOIN orders o ON q.order_id = o.id AND o.is_deleted = 0
       WHERE q.status IN ('PENDING', 'IN_PROGRESS') AND DATE(q.created_at) = CURDATE()
       ORDER BY CASE q.status WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END, q.id ASC`
    );
  }

  static async getById(id: number) {
    const item = await dbService.queryOne(
      `SELECT q.*, o.order_number, o.total_amount, o.order_type
       FROM queue q
       LEFT JOIN orders o ON q.order_id = o.id AND o.is_deleted = 0
       WHERE q.id = ?`,
      [id]
    );

    if (!item) {
      throw AppError.notFound('Queue item not found');
    }

    return item;
  }

  static async create(data: {
    orderId?: number;
    customerName?: string;
    customerPhone?: string;
    tokenType?: string;
    estimatedMinutes?: number;
  }, userId: number) {
    return await dbService.transaction(async () => {
      // Generate Queue token number: A001, A002... reset daily
      const countToday = await dbService.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM queue WHERE DATE(created_at) = CURDATE()"
      );
      const nextSeq = ((countToday?.count || 0) + 1).toString().padStart(3, '0');
      const prefix = data.tokenType === 'DINING' ? 'D' : 'A';
      const queueNumber = `${prefix}${nextSeq}`;

      const res = await dbService.execute(
        `INSERT INTO queue (queue_number, order_id, customer_name, customer_phone, status, token_type, estimated_minutes)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        [
          queueNumber,
          data.orderId || null,
          data.customerName || 'Takeaway Guest',
          data.customerPhone || null,
          data.tokenType || 'TAKEAWAY',
          data.estimatedMinutes || 15,
        ]
      );

      const queueId = res.lastInsertRowid;

      await AuditService.log({
        userId,
        action: 'QUEUE_TOKEN_ISSUED',
        module: 'QUEUE',
        recordId: queueId,
        newValues: { queueNumber, orderId: data.orderId },
      });

      return await this.getById(queueId);
    });
  }

  static async updateStatus(id: number, newStatus: QueueStatus, userId: number) {
    const item = await this.getById(id);

    await dbService.execute(
      `UPDATE queue
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newStatus, id]
    );

    await AuditService.log({
      userId,
      action: 'QUEUE_STATUS_CHANGED',
      module: 'QUEUE',
      recordId: id,
      oldValues: { status: item.status },
      newValues: { status: newStatus },
    });

    return await this.getById(id);
  }
}
