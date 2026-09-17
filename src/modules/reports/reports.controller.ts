import { Request, Response, NextFunction } from 'express';
import { ReportsService } from './reports.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class ReportsController {
  static async getSalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const paymentMethod = req.query.paymentMethod as string | undefined;
      const orderType = req.query.orderType as string | undefined;
      const cashierId = req.query.cashierId ? parseInt(req.query.cashierId as string, 10) : undefined;

      const report = await ReportsService.getSalesReport(dateFrom, dateTo, paymentMethod, orderType, cashierId);
      ResponseUtil.success(res, report, 'Sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getProductSalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const categoryId = req.query.categoryId ? parseInt(req.query.categoryId as string, 10) : undefined;

      const report = await ReportsService.getProductSalesReport(dateFrom, dateTo, categoryId);
      ResponseUtil.success(res, report, 'Product sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getCategorySalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;

      const report = await ReportsService.getCategorySalesReport(dateFrom, dateTo);
      ResponseUtil.success(res, report, 'Category sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getStockReport(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsService.getStockReport();
      ResponseUtil.success(res, report, 'Stock report generated successfully');
    } catch (err) {
      next(err);
    }
  }
}
