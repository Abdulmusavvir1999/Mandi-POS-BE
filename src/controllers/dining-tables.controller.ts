import { Request, Response, NextFunction } from 'express';
import { DiningTablesService } from '../services/dining-tables.service';
import { ResponseUtil } from '../utils/response.util';
import { ParamUtil } from '../utils/param.util';

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
      const id = ParamUtil.id(req.params.id, 'id');
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
      const id = ParamUtil.id(req.params.id, 'id');
      const table = await DiningTablesService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, table, 'Dining table updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async setStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const { status, orderId, guestCount } = req.body;
      const table = await DiningTablesService.setStatus(id, status, orderId, guestCount, req.user!.id);
      ResponseUtil.success(res, table, 'Table status updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async seatGuests(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const { guestCount, orderId } = req.body;
      const table = await DiningTablesService.seatGuests(id, Number(guestCount) || 2, orderId, req.user!.id);
      ResponseUtil.success(res, table, 'Guests seated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async cleanTable(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const table = await DiningTablesService.cleanTable(id, req.user!.id);
      ResponseUtil.success(res, table, 'Table marked for cleaning');
    } catch (err) {
      next(err);
    }
  }

  static async finishCleaning(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const table = await DiningTablesService.finishCleaning(id, req.user!.id);
      ResponseUtil.success(res, table, 'Table is clean and available');
    } catch (err) {
      next(err);
    }
  }

  static async getTableHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const history = await DiningTablesService.getTableHistory(id);
      ResponseUtil.success(res, history, 'Table history retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await DiningTablesService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Dining table deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  // Reservations
  static async getReservations(req: Request, res: Response, next: NextFunction) {
    try {
      const date = req.query.date as string | undefined;
      const status = req.query.status as string | undefined;
      const reservations = await DiningTablesService.getReservations({ date, status });
      ResponseUtil.success(res, reservations, 'Reservations fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createReservation(req: Request, res: Response, next: NextFunction) {
    try {
      const reservation = await DiningTablesService.createReservation(req.body, req.user!.id);
      ResponseUtil.created(res, reservation, 'Table reservation booked successfully');
    } catch (err) {
      next(err);
    }
  }

  static async seatReservation(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const { tableId } = req.body;
      const table = await DiningTablesService.seatReservation(id, tableId, req.user!.id);
      ResponseUtil.success(res, table, 'Reservation party seated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async cancelReservation(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await DiningTablesService.cancelReservation(id, req.user!.id);
      ResponseUtil.success(res, result, 'Reservation cancelled');
    } catch (err) {
      next(err);
    }
  }
}
