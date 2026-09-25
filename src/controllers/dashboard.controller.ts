import { Request, Response, NextFunction } from 'express';
import { DashboardService } from '../services/dashboard.service';
import { ResponseUtil } from '../utils/response.util';

export class DashboardController {
  static async getMetrics(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await DashboardService.getMetrics();
      ResponseUtil.success(res, data, 'Dashboard metrics fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
