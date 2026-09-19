import { Request, Response, NextFunction } from 'express';
import { ExpensesService } from './expenses.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class ExpensesController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await ExpensesService.getAll({
        page: ParamUtil.page(req.query.page),
        limit: ParamUtil.limit(req.query.limit, 50),
        search: ParamUtil.text(req.query.search),
        category: ParamUtil.text(req.query.category),
        paymentMethod: ParamUtil.text(req.query.paymentMethod),
        paymentStatus: ParamUtil.text(req.query.paymentStatus),
        vendorId: ParamUtil.optionalId(req.query.vendorId, 'vendorId'),
        dateFrom: ParamUtil.text(req.query.dateFrom),
        dateTo: ParamUtil.text(req.query.dateTo),
        sortBy: ParamUtil.text(req.query.sortBy),
        sortOrder: req.query.sortOrder === 'ASC' ? 'ASC' : 'DESC',
      });

      // The running totals ride alongside the page, so a client showing
      // "total spend" does not have to fetch every page to add it up.
      ResponseUtil.success(
        res,
        { expenses: result.data, totals: result.totals, pagination: result.pagination },
        'Expenses retrieved successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  static async getCategories(req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await ExpensesService.getCategories(ParamUtil.bool(req.query.includeInactive));
      ResponseUtil.success(res, categories, 'Expense categories retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const expense = await ExpensesService.getById(ParamUtil.id(req.params.id, 'id'));
      ResponseUtil.success(res, expense, 'Expense details retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const expense = await ExpensesService.create(req.body, req.user!.id);
      ResponseUtil.created(res, expense, 'Expense recorded successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expense = await ExpensesService.update(ParamUtil.id(req.params.id, 'id'), req.body, req.user!.id);
      ResponseUtil.success(res, expense, 'Expense updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await ExpensesService.delete(ParamUtil.id(req.params.id, 'id'), req.user!.id);
      ResponseUtil.success(res, result, 'Expense deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
