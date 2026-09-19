import { Request, Response, NextFunction } from 'express';
import { RefundsService } from './refunds.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class RefundsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await RefundsService.getAll({
        page: ParamUtil.page(req.query.page),
        limit: ParamUtil.limit(req.query.limit, 50),
        search: ParamUtil.text(req.query.search),
        billId: ParamUtil.optionalId(req.query.billId, 'billId'),
        customerId: ParamUtil.optionalId(req.query.customerId, 'customerId'),
        status: ParamUtil.text(req.query.status),
        reasonCode: ParamUtil.text(req.query.reasonCode),
        dateFrom: ParamUtil.text(req.query.dateFrom),
        dateTo: ParamUtil.text(req.query.dateTo),
      });
      ResponseUtil.paginated(res, result, 'Refunds retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const refund = await RefundsService.getById(ParamUtil.id(req.params.id, 'id'));
      ResponseUtil.success(res, refund, 'Refund details retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  /** What a bill has had refunded and what is still refundable on it. */
  static async getByBill(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await RefundsService.getByBill(ParamUtil.id(req.params.billId, 'billId'));
      ResponseUtil.success(res, result, 'Bill refund summary retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const refund = await RefundsService.create(req.body, req.user!.id);
      ResponseUtil.created(res, refund, 'Refund issued successfully');
    } catch (err) {
      next(err);
    }
  }

  static async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const refund = await RefundsService.cancel(
        ParamUtil.id(req.params.id, 'id'),
        (req.body?.reason as string) ?? '',
        req.user!.id
      );
      ResponseUtil.success(res, refund, 'Refund cancelled successfully');
    } catch (err) {
      next(err);
    }
  }
}
