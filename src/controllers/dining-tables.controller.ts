import { Request, Response, NextFunction } from 'express';
import { DiningTablesService } from '../services/dining-tables.service';
import { ResponseUtil } from '../utils/response.util';
import { ParamUtil } from '../utils/param.util';
import { AppError } from '../errors/AppError';
import { DiningTabService } from '../services/dining-tab.service';

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

  static async getTableHistoryPage(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body || {};
      const date = (v: unknown) => {
        const s = ParamUtil.text(v);
        return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
      };
      const status = ParamUtil.text(body.status)?.toUpperCase();
      const result = await DiningTablesService.getTableHistoryPage({
        tableId: ParamUtil.id(body.tableId, 'tableId'),
        from: date(body.from),
        to: date(body.to),
        status: status && ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status) ? status : undefined,
        search: ParamUtil.text(body.search),
        page: ParamUtil.page(body.page),
        limit: ParamUtil.limit(body.limit, 25, 100),
      });
      ResponseUtil.success(res, result, 'Table history retrieved successfully');
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
      // The screen sends snake_case (customer_name); the service takes camelCase.
      // Passing req.body straight through left customerName undefined and every
      // booking failed on .trim().
      const b = req.body || {};
      const customerName = ParamUtil.text(b.customerName ?? b.customer_name);
      const customerPhone = ParamUtil.text(b.customerPhone ?? b.customer_phone);
      const rawTime = ParamUtil.text(b.reservationTime ?? b.reservation_time);
      if (!customerName || !customerPhone || !rawTime) {
        throw AppError.badRequest('Customer name, phone number and reservation time are required');
      }
      // datetime-local gives "2026-09-29T19:30"; store as local "2026-09-29 19:30:00".
      const m = rawTime.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/);
      if (!m) throw AppError.badRequest('Invalid reservation time');
      const guestCount = Number(b.guestCount ?? b.guest_count) || 2;
      if (guestCount < 1 || guestCount > 500) throw AppError.badRequest('Invalid party size');

      const reservation = await DiningTablesService.createReservation(
        {
          customerName,
          customerPhone,
          reservationTime: `${m[1]} ${m[2]}${m[3] || ':00'}`,
          guestCount,
          tableId: ParamUtil.optionalId(b.tableId ?? b.table_id, 'tableId'),
          preferredSection: ParamUtil.text(b.preferredSection ?? b.preferred_section),
          specialRequests: ParamUtil.text(b.specialRequests ?? b.special_requests),
        },
        req.user!.id
      );
      ResponseUtil.created(res, reservation, 'Table reservation booked successfully');
    } catch (err) {
      next(err);
    }
  }

  static async listReservations(req: Request, res: Response, next: NextFunction) {
    try {
      const b = req.body || {};
      const date = (v: unknown) => {
        const s = ParamUtil.text(v);
        return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
      };
      const status = ParamUtil.text(b.status)?.toUpperCase();
      const result = await DiningTablesService.listReservations({
        from: date(b.from),
        to: date(b.to),
        status: status && ['CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW'].includes(status) ? status : undefined,
        search: ParamUtil.text(b.search),
      });
      ResponseUtil.success(res, result, 'Reservations fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async seatReservationPost(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.body?.reservationId, 'reservationId');
      const tableId = ParamUtil.optionalId(req.body?.tableId, 'tableId');
      const table = await DiningTablesService.seatReservation(id, tableId as number, req.user!.id);
      ResponseUtil.success(res, table, 'Reservation party seated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async cancelReservationPost(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.body?.reservationId, 'reservationId');
      const result = await DiningTablesService.cancelReservation(id, req.user!.id);
      ResponseUtil.success(res, result, 'Reservation cancelled');
    } catch (err) {
      next(err);
    }
  }

  // ─── Open dining tabs ───
  static async getTab(req: Request, res: Response, next: NextFunction) {
    try {
      const tab = await DiningTabService.getTab(ParamUtil.id(req.body?.tableId, 'tableId'));
      ResponseUtil.success(res, tab, 'Table tab fetched');
    } catch (err) {
      next(err);
    }
  }

  static async sendTabToKitchen(req: Request, res: Response, next: NextFunction) {
    try {
      const b = req.body || {};
      const result = await DiningTabService.sendToKitchen(
        {
          tableId: ParamUtil.id(b.tableId, 'tableId'),
          items: Array.isArray(b.items) ? b.items : [],
          customerId: ParamUtil.optionalId(b.customerId, 'customerId') ?? null,
          guestCount: Number(b.guestCount) || null,
          notes: ParamUtil.text(b.notes),
        },
        req.user!.id
      );
      ResponseUtil.success(res, result, 'Sent to kitchen');
    } catch (err) {
      next(err);
    }
  }

  static async removeTabLine(req: Request, res: Response, next: NextFunction) {
    try {
      const tab = await DiningTabService.removeLine(
        { orderItemId: ParamUtil.id(req.body?.orderItemId, 'orderItemId'), reason: ParamUtil.text(req.body?.reason) },
        req.user!.id
      );
      ResponseUtil.success(res, tab, 'Item removed from tab');
    } catch (err) {
      next(err);
    }
  }

  static async cancelTab(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await DiningTabService.cancelTab(
        { tableId: ParamUtil.id(req.body?.tableId, 'tableId'), reason: ParamUtil.text(req.body?.reason) },
        req.user!.id
      );
      ResponseUtil.success(res, result, 'Tab cancelled');
    } catch (err) {
      next(err);
    }
  }

  static async noShowReservation(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.body?.reservationId, 'reservationId');
      const result = await DiningTablesService.markReservationNoShow(id, req.user!.id);
      ResponseUtil.success(res, result, 'Reservation marked as no-show');
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
