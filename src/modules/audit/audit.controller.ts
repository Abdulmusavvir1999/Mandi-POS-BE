import { Request, Response, NextFunction } from 'express';
import { AuditService } from './audit.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class AuditController {
  static async getLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const moduleFilter = req.query.module as string | undefined;
      const actionFilter = req.query.action as string | undefined;

      const result = await AuditService.getLogs(page, limit, moduleFilter, actionFilter);
      ResponseUtil.paginated(res, result, 'Audit logs fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
