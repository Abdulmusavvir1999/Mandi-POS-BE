import { Request, Response, NextFunction } from 'express';
import { BillsService } from './bills.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { PaymentMethod, OrderType } from '../../core/types';

export class BillsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const search = req.query.search as string | undefined;
      const paymentMethod = req.query.paymentMethod as PaymentMethod | undefined;
      const orderType = req.query.orderType as OrderType | undefined;
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const cashierId = req.query.cashierId ? parseInt(req.query.cashierId as string, 10) : undefined;

      const result = await BillsService.getAll(page, limit, search, paymentMethod, orderType, dateFrom, dateTo, cashierId);
      ResponseUtil.paginated(res, result, 'Bills fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const bill = await BillsService.getById(id);
      ResponseUtil.success(res, bill, 'Bill retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPrintData(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const printData = await BillsService.getPrintData(id, req.user?.id);
      ResponseUtil.success(res, printData, 'Receipt print data formatted successfully');
    } catch (err) {
      next(err);
    }
  }
}
