import { Request, Response, NextFunction } from 'express';
import { CheckoutService } from '../services/checkout.service';
import { ResponseUtil } from '../utils/response.util';

export class CheckoutController {
  static async processCheckout(req: Request, res: Response, next: NextFunction) {
    try {
      const bill = await CheckoutService.processCheckout(req.body, req.user!.id);
      ResponseUtil.created(res, bill, 'Checkout completed and bill generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async syncOffline(req: Request, res: Response, next: NextFunction) {
    try {
      const { orders } = req.body || {};
      const result = await CheckoutService.syncOfflineOrders(orders, req.user!.id);
      ResponseUtil.success(res, result, 'Offline orders synced successfully');
    } catch (err) {
      next(err);
    }
  }
}
