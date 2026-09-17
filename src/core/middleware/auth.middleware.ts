import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env';
import { AppError } from '../errors/AppError';
import { UserPayload } from '../types';
import { dbService } from '../../database/db';

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(AppError.unauthorized('No authorization token provided'));
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as any;
    
    // Verify user still exists and is ACTIVE
    const user = await dbService.queryOne<{ id: number; username: string; email: string; name: string; status: string; role_name: string }>(
      `SELECT u.id, u.username, u.email, u.name, u.status, r.name as role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [decoded.id]
    );

    if (!user) {
      throw AppError.unauthorized('User not found');
    }

    if (user.status !== 'ACTIVE') {
      throw AppError.forbidden('User account is not active');
    }

    // Fetch permissions
    const perms = await dbService.query<{ code: string }>(
      `SELECT p.code
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       JOIN users u ON u.role_id = rp.role_id
       WHERE u.id = ?`,
      [user.id]
    );

    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role_name as any,
      permissions: perms.map((p) => p.code),
    };

    next();
  } catch (err: any) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(AppError.unauthorized('Invalid or expired authentication token'));
    }
  }
};

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    if (req.user.role === 'ADMIN' || roles.includes(req.user.role)) {
      return next();
    }
    throw AppError.forbidden(`Requires one of roles: ${roles.join(', ')}`);
  };
};

export const requirePermission = (permissionCode: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    if (req.user.role === 'ADMIN' || req.user.permissions.includes(permissionCode)) {
      return next();
    }
    throw AppError.forbidden(`Requires permission: ${permissionCode}`);
  };
};
