import { Request, Response, NextFunction } from 'express';
import { ResponseUtil } from '../utils/response.util';
import { ParamUtil } from '../utils/param.util';
import { RolesService } from '../services/roles.service';

/**
 * HTTP edge for roles and permissions.
 *
 * Every endpoint is POST, so ids and filters arrive in req.body rather than
 * as path segments or query parameters. The controller reads the body,
 * delegates to RolesService and shapes the response — no rules, no SQL.
 */
export class RolesController {
  // ---------------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------------
  static async getRoles(req: Request, res: Response, next: NextFunction) {
    try {
      const roles = await RolesService.getAll();
      ResponseUtil.success(res, roles, 'Roles fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getRoleById(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.body?.id, 'id');
      const role = await RolesService.getById(roleId);
      ResponseUtil.success(res, role, 'Role retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createRole(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, description, permissionIds } = req.body || {};
      const role = await RolesService.create(
        { name, description, permissionIds },
        req.user?.id || 1
      );
      ResponseUtil.created(res, role, 'Role created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateRole(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.body?.id, 'id');
      const { name, description, permissionIds } = req.body || {};
      const role = await RolesService.update(
        roleId,
        { name, description, permissionIds },
        req.user?.id || 1
      );
      ResponseUtil.success(res, role, 'Role updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deleteRole(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.body?.id, 'id');
      const { result, name } = await RolesService.remove(roleId, req.user?.id || 1);
      ResponseUtil.success(res, result, `Role '${name}' deleted successfully`);
    } catch (err) {
      next(err);
    }
  }

  static async updateRolePermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const roleId = ParamUtil.id(req.body?.id ?? req.body?.roleId, 'id');
      const { permissionIds } = req.body || {};
      const result = await RolesService.updatePermissions(
        roleId,
        permissionIds,
        req.user?.id || 1
      );
      ResponseUtil.success(res, result, 'Role permissions updated successfully');
    } catch (err) {
      next(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------
  static async getPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const permissions = await RolesService.getPermissions();
      ResponseUtil.success(res, permissions, 'Permissions fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createPermission(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, module, description } = req.body || {};
      const permission = await RolesService.createPermission({ code, module, description });
      ResponseUtil.created(res, permission, 'Permission created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deletePermission(req: Request, res: Response, next: NextFunction) {
    try {
      const permissionId = ParamUtil.id(req.body?.id, 'id');
      const { result, code } = await RolesService.removePermission(permissionId);
      ResponseUtil.success(res, result, `Permission '${code}' deleted successfully`);
    } catch (err) {
      next(err);
    }
  }
}
