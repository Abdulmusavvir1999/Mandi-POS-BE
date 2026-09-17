import { Request, Response, NextFunction } from 'express';
import { DraftBillsService } from './draft-bills.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class DraftBillsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const drafts = await DraftBillsService.getAll();
      ResponseUtil.success(res, drafts, 'Draft bills fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const draft = await DraftBillsService.getById(id);
      ResponseUtil.success(res, draft, 'Draft bill retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const draft = await DraftBillsService.create(req.body, req.user!.id);
      ResponseUtil.created(res, draft, 'Draft bill held successfully');
    } catch (err) {
      next(err);
    }
  }

  static async resume(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const draft = await DraftBillsService.resume(id, req.user!.id);
      ResponseUtil.success(res, draft, 'Draft bill resumed into cart');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await DraftBillsService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Draft bill deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
