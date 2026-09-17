import bcrypt from 'bcryptjs';
import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';

export class UsersService {
  static async getAll(page = 1, limit = 20, search?: string, roleId?: number, status?: string) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (roleId) {
      where += ' AND u.role_id = ?';
      params.push(roleId);
    }

    if (status) {
      where += ' AND u.status = ?';
      params.push(status);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM users u ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const users = await dbService.query(
      `SELECT u.id, u.username, u.email, u.name, u.phone, u.status, u.role_id, r.name as role_name, r.name as role,
              u.last_login_at, u.created_at, u.updated_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    const user = await dbService.queryOne(
      `SELECT u.id, u.username, u.email, u.name, u.phone, u.status, u.role_id, r.name as role_name, r.name as role,
              u.last_login_at, u.created_at, u.updated_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [id]
    );

    if (!user) {
      throw AppError.notFound('User not found');
    }

    const perms = await dbService.query<{ code: string }>(
      `SELECT p.code
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [user.role_id]
    );

    return {
      ...user,
      permissions: perms.map((p) => p.code),
    };
  }

  static async create(data: { username: string; email: string; password: string; name: string; phone?: string; roleId: number; status?: string }, adminUserId: number) {
    const existing = await dbService.queryOne(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [data.username, data.email]
    );

    if (existing) {
      throw AppError.conflict('Username or email already exists');
    }

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(data.password, salt);

    const res = await dbService.execute(
      `INSERT INTO users (username, email, password_hash, name, phone, role_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.username, data.email, passwordHash, data.name, data.phone || null, data.roleId, data.status || 'ACTIVE']
    );

    await AuditService.log({
      userId: adminUserId,
      action: 'USER_CREATED',
      module: 'USERS',
      recordId: res.lastInsertRowid,
      newValues: { username: data.username, email: data.email, roleId: data.roleId },
    });

    return await this.getById(res.lastInsertRowid);
  }

  static async update(id: number, data: { name?: string; phone?: string; roleId?: number; status?: string; password?: string }, adminUserId: number) {
    const user = await dbService.queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      throw AppError.notFound('User not found');
    }

    let passwordHash = user.password_hash;
    if (data.password && data.password.trim().length > 0) {
      const salt = bcrypt.genSaltSync(10);
      passwordHash = bcrypt.hashSync(data.password, salt);
    }

    await dbService.execute(
      `UPDATE users
       SET name = COALESCE(?, name),
           phone = COALESCE(?, phone),
           role_id = COALESCE(?, role_id),
           status = COALESCE(?, status),
           password_hash = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.name, data.phone, data.roleId, data.status, passwordHash, id]
    );

    await AuditService.log({
      userId: adminUserId,
      action: 'USER_UPDATED',
      module: 'USERS',
      recordId: id,
      oldValues: { name: user.name, role_id: user.role_id, status: user.status },
      newValues: data,
    });

    return await this.getById(id);
  }

  static async delete(id: number, adminUserId: number) {
    const user = await dbService.queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (user.username === 'admin') {
      throw AppError.forbidden('Default administrator account cannot be deleted');
    }

    await dbService.execute('DELETE FROM users WHERE id = ?', [id]);

    await AuditService.log({
      userId: adminUserId,
      action: 'USER_DELETED',
      module: 'USERS',
      recordId: id,
      oldValues: { username: user.username, email: user.email },
    });

    return { success: true, message: 'User deleted successfully' };
  }
}
