import { Request, Response, NextFunction } from 'express';
import { dbService } from '../../database/db';
import { ResponseUtil } from '../../core/utils/response.util';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';

export class RolesController {
  static async getRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await dbService.query('SELECT * FROM roles ORDER BY id ASC');
      const rolesWithPerms = await Promise.all(roles.map(async (role) => {
        const perms = await dbService.query(
          `SELECT p.id, p.code, p.module, p.description
           FROM permissions p
           JOIN role_permissions rp ON p.id = rp.permission_id
           WHERE rp.role_id = ?`,
          [role.id]
        );
        return {
          ...role,
          permissions: perms,
        };
      }));
      ResponseUtil.success(res, rolesWithPerms, 'Roles fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const permissions = await dbService.query('SELECT * FROM permissions ORDER BY module ASC, code ASC');
      ResponseUtil.success(res, permissions, 'Permissions fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateRolePermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = parseInt(req.params.id, 10);
      const { permissionIds } = req.body as { permissionIds: number[] };

      const role = await dbService.queryOne('SELECT * FROM roles WHERE id = ?', [roleId]);
      if (!role) {
        throw AppError.notFound('Role not found');
      }

      if (role.name === 'ADMIN') {
        throw AppError.forbidden('Cannot modify permissions for ADMIN role');
      }

      await dbService.transaction(async () => {
        await dbService.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
        for (const pId of permissionIds) {
          await dbService.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, pId]);
        }
      });

      await AuditService.log({
        userId: req.user!.id,
        action: 'ROLE_PERMISSIONS_UPDATED',
        module: 'ROLES',
        recordId: roleId,
        newValues: { roleId, permissionIds },
      });

      ResponseUtil.success(res, { roleId, updated: true }, 'Role permissions updated successfully');
    } catch (err) {
      next(err);
    }
  }
}
