import { Request, Response, NextFunction } from 'express';
import { CheckoutService } from './checkout.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class CheckoutController {
  static async processCheckout(req: Request, res: Response, next: NextFunction) {
    try {
      const bill = await CheckoutService.processCheckout(req.body, req.user!.id);
      ResponseUtil.created(res, bill, 'Checkout completed and bill generated successfully');
    } catch (err) {
      next(err);
    }
  }
}
