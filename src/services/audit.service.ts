import { dbService } from '../database/db';
import { logger } from '../config/logger';
import { ParamUtil } from '../utils/param.util';

export interface AuditLogEntry {
  userId?: number | null;
  action: string;
  module: string;
  recordId?: string | number | null;
  oldValues?: any;
  newValues?: any;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export class AuditService {
  static async log(entry: AuditLogEntry): Promise<void> {
    try {
      await dbService.execute(
        `INSERT INTO audit_logs (user_id, action, module, record_id, old_values, new_values, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.userId || null,
          entry.action,
          entry.module,
          entry.recordId ? String(entry.recordId) : null,
          entry.oldValues ? JSON.stringify(entry.oldValues) : null,
          entry.newValues ? JSON.stringify(entry.newValues) : null,
          entry.ipAddress || null,
          entry.userAgent || null,
        ]
      );
    } catch (err) {
      logger.error('Failed to write audit log:', err);
    }
  }

  static async getLogs(page = 1, limit = 50, moduleFilter?: string, actionFilter?: string) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (moduleFilter) {
      where += ' AND a.module = ?';
      params.push(moduleFilter);
    }

    if (actionFilter) {
      where += ' AND a.action LIKE ?';
      params.push(ParamUtil.like(actionFilter));
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM audit_logs a ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const logs = await dbService.query(
      `SELECT a.id, a.user_id, u.name as user_name, u.username, a.action, a.module, a.record_id,
              a.old_values, a.new_values, a.ip_address, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: logs.map((log: any) => ({
        ...log,
        old_values: log.old_values ? JSON.parse(log.old_values) : null,
        new_values: log.new_values ? JSON.parse(log.new_values) : null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}
