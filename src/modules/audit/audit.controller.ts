import { Request, Response, NextFunction } from 'express';
import { AuditService } from './audit.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class AuditController {
  static async getLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const moduleFilter = req.query.module as string | undefined;
      const actionFilter = req.query.action as string | undefined;

      const result = await AuditService.getLogs(page, limit, moduleFilter, actionFilter);
      ResponseUtil.paginated(res, result, 'Audit logs fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
