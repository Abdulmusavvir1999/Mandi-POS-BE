import { Request, Response, NextFunction } from 'express';
import { OrdersService } from './orders.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';
import { OrderStatus, OrderType } from '../../core/types';

export class OrdersController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const status = req.query.status as OrderStatus | undefined;
      const orderType = req.query.orderType as OrderType | undefined;
      const search = req.query.search as string | undefined;
      const diningTableId = ParamUtil.optionalId(req.query.diningTableId, 'diningTableId');
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;

      const result = await OrdersService.getAll(page, limit, status, orderType, search, diningTableId, dateFrom, dateTo);
      ResponseUtil.paginated(res, result, 'Orders fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const order = await OrdersService.getById(id);
      ResponseUtil.success(res, order, 'Order retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await OrdersService.create(req.body, req.user!.id);
      ResponseUtil.created(res, order, 'Order created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async startOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const order = await OrdersService.updateStatus(id, 'IN_PROGRESS', req.user!.id, req.body.notes);
      ResponseUtil.success(res, order, 'Order is now in progress');
    } catch (err) {
      next(err);
    }
  }

  static async completeOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const order = await OrdersService.updateStatus(id, 'COMPLETED', req.user!.id, req.body.notes);
      ResponseUtil.success(res, order, 'Order marked as completed');
    } catch (err) {
      next(err);
    }
  }

  static async cancelOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const order = await OrdersService.updateStatus(id, 'CANCELLED', req.user!.id, req.body.reason || 'Order cancelled by staff');
      ResponseUtil.success(res, order, 'Order cancelled');
    } catch (err) {
      next(err);
    }
  }
}
