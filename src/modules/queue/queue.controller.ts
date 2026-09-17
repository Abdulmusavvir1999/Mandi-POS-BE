import { Request, Response, NextFunction } from 'express';
import { QueueService } from './queue.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { QueueStatus } from '../../core/types';

export class QueueController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.query.status as QueueStatus | undefined;
      const date = req.query.date as string | undefined;
      const items = await QueueService.getAll(status, date);
      ResponseUtil.success(res, items, 'Queue tokens fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPending(req: Request, res: Response, next: NextFunction) {
    try {
      const items = await QueueService.getPending();
      ResponseUtil.success(res, items, 'Pending queue tokens fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const item = await QueueService.getById(id);
      ResponseUtil.success(res, item, 'Queue token retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await QueueService.create(req.body, req.user!.id);
      ResponseUtil.created(res, item, 'Queue token issued successfully');
    } catch (err) {
      next(err);
    }
  }

  static async start(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const item = await QueueService.updateStatus(id, 'IN_PROGRESS', req.user!.id);
      ResponseUtil.success(res, item, 'Queue token marked as preparing');
    } catch (err) {
      next(err);
    }
  }

  static async complete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const item = await QueueService.updateStatus(id, 'COMPLETED', req.user!.id);
      ResponseUtil.success(res, item, 'Queue token ready / completed');
    } catch (err) {
      next(err);
    }
  }

  static async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const item = await QueueService.updateStatus(id, 'CANCELLED', req.user!.id);
      ResponseUtil.success(res, item, 'Queue token cancelled');
    } catch (err) {
      next(err);
    }
  }
}
