import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dbService } from '../../database/db';
import { config } from '../../config/env';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';

export class AuthService {
  static async login(identifier: string, passwordPlain: string, ipAddress?: string, userAgent?: string) {
    const user = await dbService.queryOne<{
      id: number;
      username: string;
      email: string;
      password_hash: string;
      name: string;
      phone: string;
      status: string;
      role_id: number;
      role_name: string;
    }>(
      `SELECT u.id, u.username, u.email, u.password_hash, u.name, u.phone, u.status, u.role_id, r.name as role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.username = ? OR u.email = ?`,
      [identifier, identifier]
    );

    if (!user) {
      throw AppError.unauthorized('Invalid username or password');
    }

    if (user.status !== 'ACTIVE') {
      throw AppError.forbidden(`Account status is ${user.status}. Please contact administrator.`);
    }

    const isMatch = await bcrypt.compare(passwordPlain, user.password_hash);
    if (!isMatch) {
      throw AppError.unauthorized('Invalid username or password');
    }

    // Update last login
    await dbService.execute('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

    // Fetch permissions
    const perms = await dbService.query<{ code: string }>(
      `SELECT p.code
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [user.role_id]
    );

    const permissions = perms.map((p) => p.code);

    // Generate JWT
    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role_name,
    };

    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '8h' });
    const refreshToken = jwt.sign({ id: user.id }, config.jwtRefreshSecret, { expiresIn: '7d' });

    await AuditService.log({
      userId: user.id,
      action: 'USER_LOGIN',
      module: 'AUTH',
      recordId: user.id,
      ipAddress,
      userAgent,
    });

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role_name,
        permissions,
      },
      token,
      refreshToken,
    };
  }

  static async refreshToken(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret) as any;
      const user = await dbService.queryOne<{ id: number; username: string; email: string; name: string; status: string; role_name: string; role_id: number }>(
        `SELECT u.id, u.username, u.email, u.name, u.status, r.name as role_name, u.role_id
         FROM users u
         JOIN roles r ON u.role_id = r.id
         WHERE u.id = ?`,
        [decoded.id]
      );

      if (!user || user.status !== 'ACTIVE') {
        throw AppError.unauthorized('Invalid session');
      }

      const perms = await dbService.query<{ code: string }>(
        `SELECT p.code
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`,
        [user.role_id]
      );

      const token = jwt.sign(
        { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role_name },
        config.jwtSecret,
        { expiresIn: '8h' }
      );

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role_name,
          permissions: perms.map((p) => p.code),
        },
      };
    } catch {
      throw AppError.unauthorized('Invalid or expired refresh token');
    }
  }

  static async changePassword(userId: number, currentPasswordPlain: string, newPasswordPlain: string) {
    const user = await dbService.queryOne<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE id = ?',
      [userId]
    );

    if (!user) {
      throw AppError.notFound('User not found');
    }

    const isMatch = await bcrypt.compare(currentPasswordPlain, user.password_hash);
    if (!isMatch) {
      throw AppError.badRequest('Current password is incorrect');
    }

    const salt = bcrypt.genSaltSync(10);
    const newHash = bcrypt.hashSync(newPasswordPlain, salt);

    await dbService.execute('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      newHash,
      userId,
    ]);

    await AuditService.log({
      userId,
      action: 'PASSWORD_CHANGED',
      module: 'AUTH',
      recordId: userId,
    });

    return { message: 'Password updated successfully' };
  }

  static async getMe(userId: number) {
    const user = await dbService.queryOne<{
      id: number;
      username: string;
      email: string;
      name: string;
      phone: string;
      status: string;
      role_id: number;
      role_name: string;
      last_login_at: string;
    }>(
      `SELECT u.id, u.username, u.email, u.name, u.phone, u.status, u.role_id, r.name as role_name, u.last_login_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [userId]
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
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      phone: user.phone,
      status: user.status,
      role: user.role_name,
      lastLoginAt: user.last_login_at,
      permissions: perms.map((p) => p.code),
    };
  }
}
