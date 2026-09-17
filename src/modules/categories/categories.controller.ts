import { Request, Response, NextFunction } from 'express';
import { CategoriesService } from './categories.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class CategoriesController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const categories = await CategoriesService.getAll(includeInactive);
      ResponseUtil.success(res, categories, 'Categories fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const category = await CategoriesService.getById(id);
      ResponseUtil.success(res, category, 'Category retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await CategoriesService.create(req.body, req.user!.id);
      ResponseUtil.created(res, category, 'Category created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const category = await CategoriesService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, category, 'Category updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await CategoriesService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Category deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
