import { Request, Response, NextFunction } from 'express';
import { CategoriesService } from '../services/categories.service';
import { ResponseUtil } from '../utils/response.util';
import { ParamUtil } from '../utils/param.util';
import { CategoryImageService } from '../services/category-image.service';

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
      const id = ParamUtil.id(req.params.id, 'id');
      const category = await CategoriesService.getById(id);
      ResponseUtil.success(res, category, 'Category retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * Stores a category thumbnail and returns its URL. The upload happens before
   * the category row exists (the Add modal uploads as soon as a file is
   * picked), so this is a standalone endpoint rather than /:id/image.
   */
  static async uploadImage(req: Request, res: Response, next: NextFunction) {
    try {
      const { dataUrl } = req.body || {};
      const data = CategoryImageService.save(dataUrl);
      ResponseUtil.success(res, data, 'Category image uploaded successfully');
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
      const id = ParamUtil.id(req.params.id, 'id');
      const category = await CategoriesService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, category, 'Category updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await CategoriesService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Category deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
