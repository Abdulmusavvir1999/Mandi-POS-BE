import { Request, Response, NextFunction } from 'express';
import { dbService } from '../../database/db';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';

/**
 * How many roles may be created by hand. Seeded roles (is_system = 1) are
 * built into the system and are not counted against this limit.
 */
const MAX_CUSTOM_ROLES = 2;

export class RolesController {
  static async getRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await dbService.query<any>(
        `SELECT r.id, r.name, r.description, COALESCE(r.is_system, 0) as is_system, r.created_at, r.updated_at,
                COUNT(u.id) as user_count
         FROM roles r
         LEFT JOIN users u ON r.id = u.role_id
         GROUP BY r.id
         ORDER BY r.id ASC`
      );

      const rolesWithPerms = await Promise.all(
        roles.map(async (role) => {
          const perms = await dbService.query(
            `SELECT p.id, p.code, p.module, p.description
             FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             WHERE rp.role_id = ?
             ORDER BY p.module ASC, p.code ASC`,
            [role.id]
          );
          return {
            ...role,
            user_count: Number(role.user_count || 0),
            permissions: perms,
          };
        })
      );

      ResponseUtil.success(res, rolesWithPerms, 'Roles fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getRoleById(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.params.id, 'id');
      const role = await dbService.queryOne<any>(
        `SELECT r.id, r.name, r.description, COALESCE(r.is_system, 0) as is_system, r.created_at, r.updated_at,
                COUNT(u.id) as user_count
         FROM roles r
         LEFT JOIN users u ON r.id = u.role_id
         WHERE r.id = ?
         GROUP BY r.id`,
        [roleId]
      );

      if (!role) {
        throw AppError.notFound('Role not found');
      }

      const perms = await dbService.query(
        `SELECT p.id, p.code, p.module, p.description
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.module ASC, p.code ASC`,
        [roleId]
      );

      ResponseUtil.success(
        res,
        {
          ...role,
          user_count: Number(role.user_count || 0),
          permissions: perms,
        },
        'Role retrieved successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  static async createRole(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, description, permissionIds } = req.body as {
        name: string;
        description?: string;
        permissionIds?: number[];
      };

      if (!name || !name.trim()) {
        throw AppError.badRequest('Role name is required');
      }

      const trimmedName = name.trim();

      // Check if role name already exists (case-insensitive)
      const existing = await dbService.queryOne(
        'SELECT id FROM roles WHERE LOWER(name) = LOWER(?)',
        [trimmedName]
      );
      if (existing) {
        throw AppError.conflict(`Role '${trimmedName}' already exists`);
      }

      // Only a limited number of roles may be created by hand. Built-in
      // roles carry is_system = 1 and are excluded from the count.
      const customRoleCount = await dbService.queryOne<{ total: number }>(
        'SELECT COUNT(*) as total FROM roles WHERE COALESCE(is_system, 0) = 0'
      );
      if (Number(customRoleCount?.total || 0) >= MAX_CUSTOM_ROLES) {
        throw AppError.badRequest(
          `Role limit reached. A maximum of ${MAX_CUSTOM_ROLES} custom roles can be created. Delete an existing custom role before adding another.`
        );
      }

      let newRoleId: number = 0;

      await dbService.transaction(async () => {
        const result = await dbService.execute(
          'INSERT INTO roles (name, description) VALUES (?, ?)',
          [trimmedName, description ? description.trim() : null]
        );
        newRoleId = result.lastInsertRowid;

        if (Array.isArray(permissionIds) && permissionIds.length > 0) {
          for (const pId of permissionIds) {
            await dbService.execute(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
              [newRoleId, pId]
            );
          }
        }
      });

      await AuditService.log({
        userId: req.user?.id || 1,
        action: 'ROLE_CREATED',
        module: 'ROLES',
        recordId: newRoleId,
        newValues: { name: trimmedName, description, permissionIds },
      });

      const perms = await dbService.query(
        `SELECT p.id, p.code, p.module, p.description
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.module ASC, p.code ASC`,
        [newRoleId]
      );

      ResponseUtil.created(
        res,
        {
          id: newRoleId,
          name: trimmedName,
          description: description || null,
          is_system: 0,
          user_count: 0,
          permissions: perms,
        },
        'Role created successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  static async updateRole(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.params.id, 'id');
      const { name, description, permissionIds } = req.body as {
        name?: string;
        description?: string;
        permissionIds?: number[];
      };

      const role = await dbService.queryOne<any>('SELECT * FROM roles WHERE id = ?', [roleId]);
      if (!role) {
        throw AppError.notFound('Role not found');
      }

      const trimmedName = name ? name.trim() : role.name;

      if (name && trimmedName.toLowerCase() !== role.name.toLowerCase()) {
        const existing = await dbService.queryOne(
          'SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id != ?',
          [trimmedName, roleId]
        );
        if (existing) {
          throw AppError.conflict(`Role name '${trimmedName}' is already in use`);
        }
      }

      await dbService.transaction(async () => {
        await dbService.execute(
          `UPDATE roles 
           SET name = COALESCE(?, name), 
               description = COALESCE(?, description),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [trimmedName, description !== undefined ? description : role.description, roleId]
        );

        if (Array.isArray(permissionIds)) {
          await dbService.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
          for (const pId of permissionIds) {
            await dbService.execute(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
              [roleId, pId]
            );
          }
        }
      });

      await AuditService.log({
        userId: req.user?.id || 1,
        action: 'ROLE_UPDATED',
        module: 'ROLES',
        recordId: roleId,
        oldValues: { name: role.name, description: role.description },
        newValues: { name: trimmedName, description, permissionIds },
      });

      const updatedPerms = await dbService.query(
        `SELECT p.id, p.code, p.module, p.description
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.module ASC, p.code ASC`,
        [roleId]
      );

      const userCountRes = await dbService.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users WHERE role_id = ?',
        [roleId]
      );

      ResponseUtil.success(
        res,
        {
          id: roleId,
          name: trimmedName,
          description: description !== undefined ? description : role.description,
          user_count: Number(userCountRes?.count || 0),
          permissions: updatedPerms,
        },
        'Role updated successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  static async deleteRole(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.params.id, 'id');

      const role = await dbService.queryOne<any>('SELECT * FROM roles WHERE id = ?', [roleId]);
      if (!role) {
        throw AppError.notFound('Role not found');
      }

      // Check if any users are assigned to this role
      const userCountRes = await dbService.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users WHERE role_id = ?',
        [roleId]
      );
      const userCount = Number(userCountRes?.count || 0);

      if (userCount > 0) {
        throw AppError.badRequest(
          `Cannot delete role '${role.name}': ${userCount} staff user(s) are currently assigned to this role. Please reassign their roles first.`
        );
      }

      await dbService.transaction(async () => {
        await dbService.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
        await dbService.execute('DELETE FROM roles WHERE id = ?', [roleId]);
      });

      await AuditService.log({
        userId: req.user?.id || 1,
        action: 'ROLE_DELETED',
        module: 'ROLES',
        recordId: roleId,
        oldValues: { name: role.name },
      });

      ResponseUtil.success(res, { id: roleId, deleted: true }, `Role '${role.name}' deleted successfully`);
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

  static async createPermission(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, module, description } = req.body as {
        code: string;
        module: string;
        description?: string;
      };

      if (!code || !module) {
        throw AppError.badRequest('Permission code and module are required');
      }

      const trimmedCode = code.trim().toLowerCase();
      const trimmedModule = module.trim().toUpperCase();

      const existing = await dbService.queryOne('SELECT id FROM permissions WHERE LOWER(code) = ?', [trimmedCode]);
      if (existing) {
        throw AppError.conflict(`Permission code '${trimmedCode}' already exists`);
      }

      const resInsert = await dbService.execute(
        'INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)',
        [trimmedCode, trimmedModule, description ? description.trim() : null]
      );

      ResponseUtil.created(
        res,
        {
          id: resInsert.lastInsertRowid,
          code: trimmedCode,
          module: trimmedModule,
          description: description || null,
        },
        'Permission created successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  static async deletePermission(req: Request, res: Response, next: NextFunction) {
    try {
      const permissionId = ParamUtil.id(req.params.id, 'id');

      const perm = await dbService.queryOne<any>('SELECT * FROM permissions WHERE id = ?', [permissionId]);
      if (!perm) {
        throw AppError.notFound('Permission not found');
      }

      await dbService.transaction(async () => {
        await dbService.execute('DELETE FROM role_permissions WHERE permission_id = ?', [permissionId]);
        await dbService.execute('DELETE FROM permissions WHERE id = ?', [permissionId]);
      });

      ResponseUtil.success(res, { id: permissionId, deleted: true }, `Permission '${perm.code}' deleted successfully`);
    } catch (err) {
      next(err);
    }
  }

  static async updateRolePermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.params.id, 'id');
      const { permissionIds } = req.body as { permissionIds: number[] };

      const role = await dbService.queryOne('SELECT * FROM roles WHERE id = ?', [roleId]);
      if (!role) {
        throw AppError.notFound('Role not found');
      }

      await dbService.transaction(async () => {
        await dbService.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
        if (Array.isArray(permissionIds)) {
          for (const pId of permissionIds) {
            await dbService.execute(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
              [roleId, pId]
            );
          }
        }
      });

      await AuditService.log({
        userId: req.user?.id || 1,
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
