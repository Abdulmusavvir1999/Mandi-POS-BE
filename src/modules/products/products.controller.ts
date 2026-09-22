import { Request, Response, NextFunction } from 'express';
import { ProductsService } from './products.service';
import { AddonsCombosService } from './addons-combos.service';
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

  // ── Add-ons ──
  static async getAddons(req: Request, res: Response, next: NextFunction) {
    try {
      const { category, status } = req.query;
      const addons = await AddonsCombosService.getAddons(category as string, status as string);
      ResponseUtil.success(res, addons, 'Add-ons retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getAddonById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const addon = await AddonsCombosService.getAddonById(id);
      ResponseUtil.success(res, addon, 'Add-on retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createAddon(req: Request, res: Response, next: NextFunction) {
    try {
      const addon = await AddonsCombosService.createAddon(req.body, req.user!.id);
      ResponseUtil.created(res, addon, 'Add-on created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateAddon(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const addon = await AddonsCombosService.updateAddon(id, req.body, req.user!.id);
      ResponseUtil.success(res, addon, 'Add-on updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deleteAddon(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await AddonsCombosService.deleteAddon(id, req.user!.id);
      ResponseUtil.success(res, result, 'Add-on deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getProductAddons(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const addons = await AddonsCombosService.getProductAddons(id);
      ResponseUtil.success(res, addons, 'Product add-ons retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  // ── Combo Deals ──
  static async getComboDeals(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.query.status as string | undefined;
      const combos = await AddonsCombosService.getComboDeals(status);
      ResponseUtil.success(res, combos, 'Combo deals retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getComboDealById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const combo = await AddonsCombosService.getComboDealById(id);
      ResponseUtil.success(res, combo, 'Combo deal retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createComboDeal(req: Request, res: Response, next: NextFunction) {
    try {
      const combo = await AddonsCombosService.createComboDeal(req.body, req.user!.id);
      ResponseUtil.created(res, combo, 'Combo deal created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateComboDeal(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const combo = await AddonsCombosService.updateComboDeal(id, req.body, req.user!.id);
      ResponseUtil.success(res, combo, 'Combo deal updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deleteComboDeal(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await AddonsCombosService.deleteComboDeal(id, req.user!.id);
      ResponseUtil.success(res, result, 'Combo deal deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
