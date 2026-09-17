import { Request, Response, NextFunction } from 'express';
import { UsersService } from './users.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class UsersController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const search = req.query.search as string | undefined;
      const roleId = req.query.roleId ? parseInt(req.query.roleId as string, 10) : undefined;
      const status = req.query.status as string | undefined;

      const result = await UsersService.getAll(page, limit, search, roleId, status);
      ResponseUtil.paginated(res, result, 'Users fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
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
      const id = parseInt(req.params.id, 10);
      const user = await UsersService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, user, 'User updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await UsersService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'User deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
