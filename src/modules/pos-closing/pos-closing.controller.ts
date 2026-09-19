import { Request, Response, NextFunction } from 'express';
import { PosClosingService } from './pos-closing.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class PosClosingController {
  static async getCurrentShift(req: Request, res: Response, next: NextFunction) {
    try {
      const summary = await PosClosingService.getCurrentShiftSummary(req.user!.id);
      ResponseUtil.success(res, summary, 'Current shift summary retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createDayClosing(req: Request, res: Response, next: NextFunction) {
    try {
      const closing = await PosClosingService.createDayClosing(req.body, req.user!.id);
      ResponseUtil.created(res, closing, 'Day closing Z-report generated and saved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 20);
      const history = await PosClosingService.getHistory(page, limit);
      ResponseUtil.paginated(res, history, 'Day closing history retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const closing = await PosClosingService.getDayClosingById(id);
      ResponseUtil.success(res, closing, 'Day closing retrieved successfully');
    } catch (err) {
      next(err);
    }
  }
}
