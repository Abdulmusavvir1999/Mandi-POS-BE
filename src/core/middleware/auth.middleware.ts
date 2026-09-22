import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env';
import { AppError } from '../errors/AppError';
import { UserPayload } from '../types';
import { dbService } from '../../database/db';
import { hasUnrestrictedAccess, isSuperAdmin, resolveRoleName } from '../utils/role.util';

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

    // Verify user still exists and is ACTIVE.
    //
    // LEFT JOIN, not JOIN: the super administrator holds no `role_id`, and an
    // inner join would drop that row entirely and report the account as
    // missing. Every user that does have a role is unaffected — the join
    // matches exactly as it did before.
    const user = await dbService.queryOne<{
      id: number;
      username: string;
      email: string;
      name: string;
      status: string;
      role_id: number | null;
      role_name: string | null;
    }>(
      `SELECT u.id, u.username, u.email, u.name, u.status, u.role_id, r.name as role_name
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [decoded.id]
    );

    if (!user) {
      throw AppError.unauthorized('User not found');
    }

    if (user.status !== 'ACTIVE') {
      throw AppError.forbidden('User account is not active');
    }

    const role = resolveRoleName(user.role_id, user.role_name);

    // Fetch permissions. A super administrator has no `role_id` and therefore
    // no rows here; `hasUnrestrictedAccess` is what grants it access instead.
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
      role: role as any,
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
    if (hasUnrestrictedAccess(req.user.role) || roles.includes(req.user.role)) {
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
    if (hasUnrestrictedAccess(req.user.role) || req.user.permissions.includes(permissionCode)) {
      return next();
    }
    throw AppError.forbidden(`Requires permission: ${permissionCode}`);
  };
};

/**
 * Gate for every Back-Office endpoint.
 *
 * The super administrator and nobody else — ADMIN is refused here as firmly as
 * a cashier is. The Back-Office deletes orders and invoices outright and
 * re-prices settled bills, so it is held one step above the administrator who
 * runs the shop day to day.
 *
 * This cannot be expressed with `requireRole()`: that helper waves anyone with
 * unrestricted access through whatever list it is given, ADMIN included, which
 * is the opposite of what is wanted here.
 */
export const requireBackOfficeRole = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    next(AppError.unauthorized());
    return;
  }
  if (!isSuperAdmin(req.user.role)) {
    next(AppError.forbidden('The Back-Office is restricted to the super administrator'));
    return;
  }
  next();
};
