import { Request, Response, NextFunction } from 'express';
import { DiningTablesService } from './dining-tables.service';
import { ResponseUtil } from '../../core/utils/response.util';

export class DiningTablesController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const section = req.query.section as string | undefined;
      const status = req.query.status as string | undefined;
      const tables = await DiningTablesService.getAll(section, status);
      ResponseUtil.success(res, tables, 'Dining tables fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getSections(req: Request, res: Response, next: NextFunction) {
    try {
      const sections = await DiningTablesService.getSections();
      ResponseUtil.success(res, sections, 'Dining sections fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const table = await DiningTablesService.getById(id);
      ResponseUtil.success(res, table, 'Dining table retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const table = await DiningTablesService.create(req.body, req.user!.id);
      ResponseUtil.created(res, table, 'Dining table created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const table = await DiningTablesService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, table, 'Dining table updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async setStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const { status, orderId } = req.body;
      const table = await DiningTablesService.setStatus(id, status, orderId, req.user!.id);
      ResponseUtil.success(res, table, 'Table status updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await DiningTablesService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Dining table deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
