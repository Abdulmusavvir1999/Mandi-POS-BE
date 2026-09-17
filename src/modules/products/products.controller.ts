import { Request, Response, NextFunction } from 'express';
import { ProductsService } from './products.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';
import { ProductImageService } from './product-image.service';

export class ProductsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const search = req.query.search as string | undefined;
      const categoryId = ParamUtil.optionalId(req.query.categoryId, 'categoryId');
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
      const id = ParamUtil.id(req.params.id, 'id');
      const product = await ProductsService.getById(id);
      ResponseUtil.success(res, product, 'Product retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /** Stores a dish photo and returns its URL; uploaded before the row exists. */
  static async uploadImage(req: Request, res: Response, next: NextFunction) {
    try {
      const { dataUrl } = req.body || {};
      const data = ProductImageService.save(dataUrl);
      ResponseUtil.success(res, data, 'Dish image uploaded successfully');
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
      const id = ParamUtil.id(req.params.id, 'id');
      const product = await ProductsService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, product, 'Product updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await ProductsService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Product operation completed');
    } catch (err) {
      next(err);
    }
  }
}
