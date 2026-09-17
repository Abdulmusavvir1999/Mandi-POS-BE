import { Request, Response, NextFunction } from 'express';
import { ProductsService } from './products.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class ProductsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const search = req.query.search as string | undefined;
      const categoryId = req.query.categoryId ? parseInt(req.query.categoryId as string, 10) : undefined;
      const status = req.query.status as string | undefined;
      const sortBy = req.query.sortBy as string | undefined;
      const sortOrder = req.query.sortOrder as string | undefined;

      const result = await ProductsService.getAll(page, limit, search, categoryId, status, sortBy, sortOrder);
      ResponseUtil.paginated(res, result, 'Products fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const product = await ProductsService.getById(id);
      ResponseUtil.success(res, product, 'Product retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await ProductsService.create(req.body, req.user!.id);
      ResponseUtil.created(res, product, 'Product created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const product = await ProductsService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, product, 'Product updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await ProductsService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Product operation completed');
    } catch (err) {
      next(err);
    }
  }
}
