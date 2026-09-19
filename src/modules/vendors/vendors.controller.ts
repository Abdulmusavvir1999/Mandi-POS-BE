import { Request, Response, NextFunction } from 'express';
import { VendorsService } from './vendors.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class VendorsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const search = req.query.search as string | undefined;
      const category = req.query.category as string | undefined;
      const status = req.query.status as string | undefined;
      const sortBy = req.query.sortBy as string | undefined;
      const sortOrder = req.query.sortOrder === 'DESC' ? 'DESC' : 'ASC';

      const result = await VendorsService.getAll({
        page,
        limit,
        search,
        category,
        status,
        sortBy,
        sortOrder,
      });
      ResponseUtil.paginated(res, result, 'Vendors retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await VendorsService.getStats();
      ResponseUtil.success(res, stats, 'Vendor statistics retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const vendor = await VendorsService.getById(id);
      ResponseUtil.success(res, vendor, 'Vendor details retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const vendor = await VendorsService.create(req.body, req.user!.id);
      ResponseUtil.created(res, vendor, 'Vendor created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const vendor = await VendorsService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, vendor, 'Vendor updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await VendorsService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Vendor deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPurchases(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);

      const result = await VendorsService.getPurchases(id, page, limit);
      ResponseUtil.paginated(res, result, 'Vendor purchase history retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async recordPurchase(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const vendor = await VendorsService.recordPurchase(id, req.body, req.user!.id);
      ResponseUtil.created(res, vendor, 'Purchase invoice recorded successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPayments(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);

      const result = await VendorsService.getPayments(id, page, limit);
      ResponseUtil.paginated(res, result, 'Vendor payment history retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async recordPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const vendor = await VendorsService.recordPayment(id, req.body, req.user!.id);
      ResponseUtil.created(res, vendor, 'Payment recorded successfully');
    } catch (err) {
      next(err);
    }
  }

  static async updateRating(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const vendor = await VendorsService.updateRatingAndPerformance(id, req.body, req.user!.id);
      ResponseUtil.success(res, vendor, 'Vendor rating and performance updated successfully');
    } catch (err) {
      next(err);
    }
  }
}
