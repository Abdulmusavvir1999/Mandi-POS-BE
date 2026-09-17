import { Request, Response, NextFunction } from 'express';
import { CustomersService } from './customers.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class CustomersController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const search = req.query.search as string | undefined;

      const result = await CustomersService.getAll(page, limit, search);
      ResponseUtil.paginated(res, result, 'Customers fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const customer = await CustomersService.getById(id);
      ResponseUtil.success(res, customer, 'Customer retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const customer = await CustomersService.create(req.body, req.user!.id);
      ResponseUtil.created(res, customer, 'Customer created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const customer = await CustomersService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, customer, 'Customer updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await CustomersService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Customer deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPurchaseHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const history = await CustomersService.getPurchaseHistory(id);
      ResponseUtil.success(res, history, 'Customer purchase history fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
