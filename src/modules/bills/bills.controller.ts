import { Request, Response, NextFunction } from 'express';
import { BillsService } from './bills.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';
import { PaymentMethod, OrderType } from '../../core/types';

export class BillsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const search = req.query.search as string | undefined;
      const paymentMethod = req.query.paymentMethod as PaymentMethod | undefined;
      const orderType = req.query.orderType as OrderType | undefined;
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const cashierId = ParamUtil.optionalId(req.query.cashierId, 'cashierId');

      const result = await BillsService.getAll(page, limit, search, paymentMethod, orderType, dateFrom, dateTo, cashierId);
      ResponseUtil.paginated(res, result, 'Bills fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const bill = await BillsService.getById(id);
      ResponseUtil.success(res, bill, 'Bill retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPrintData(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const printData = await BillsService.getPrintData(id, req.user?.id);
      ResponseUtil.success(res, printData, 'Receipt print data formatted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getKotPrintData(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const kotData = await BillsService.getKotPrintData(id);
      ResponseUtil.success(res, kotData, 'KOT print data formatted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async voidBill(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const { reason } = req.body || {};
      const result = await BillsService.voidBill(id, reason, req.user!.id);
      ResponseUtil.success(res, result, 'Bill voided successfully');
    } catch (err) {
      next(err);
    }
  }

  static async reopenBill(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await BillsService.reopenBill(id, req.user!.id);
      ResponseUtil.success(res, result, 'Bill reopened for editing successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getDuplicate(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await BillsService.getDuplicateOrderData(id);
      ResponseUtil.success(res, result, 'Duplicate order data retrieved successfully');
    } catch (err) {
      next(err);
    }
  }
}
