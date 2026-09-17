import { Request, Response, NextFunction } from 'express';
import { UsersService } from './users.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class UsersController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 20);
      const search = req.query.search as string | undefined;
      const roleId = ParamUtil.optionalId(req.query.roleId, 'roleId');
      const status = req.query.status as string | undefined;

      const result = await UsersService.getAll(page, limit, search, roleId, status);
      ResponseUtil.paginated(res, result, 'Users fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const user = await UsersService.getById(id);
      ResponseUtil.success(res, user, 'User retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await UsersService.create(req.body, req.user!.id);
      ResponseUtil.created(res, user, 'User created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const user = await UsersService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, user, 'User updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await UsersService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'User deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
