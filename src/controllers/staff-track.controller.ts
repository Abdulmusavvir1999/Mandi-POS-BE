import { Request, Response, NextFunction } from 'express';
import { StaffTrackService } from '../services/staff-track.service';
import { ResponseUtil } from '../utils/response.util';
import { ParamUtil } from '../utils/param.util';
import { StaffTrackFilters } from '../models/staff-track.types';
import { StaffTrackScope, applyScopeToFilters, scopeAllowsUser } from '../middlewares/staff-track.scope';
import { AppError } from '../errors/AppError';

/** The scope `attachStaffTrackScope` resolved for this request. */
const scopeOf = (req: Request): StaffTrackScope => {
  if (!req.staffTrackScope) {
    throw AppError.forbidden('Staff track scope unresolved');
  }
  return req.staffTrackScope;
};

/**
 * Pulls the filter set every Staff Track endpoint accepts off the query string,
 * then pins it to the caller's scope. Order matters: the scope is applied last
 * so a self-scoped caller passing `?userId=<someone else>` has it overwritten
 * with their own id rather than being served another person's figures.
 */
const readFilters = (req: Request): StaffTrackFilters =>
  applyScopeToFilters(
    {
      dateFrom: ParamUtil.text(req.query.dateFrom),
      dateTo: ParamUtil.text(req.query.dateTo),
      userId: ParamUtil.optionalId(req.query.userId, 'userId'),
      roleId: ParamUtil.optionalId(req.query.roleId, 'roleId'),
      status: ParamUtil.text(req.query.status),
      search: ParamUtil.text(req.query.search),
    },
    scopeOf(req)
  );

export class StaffTrackController {
  static async getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getOverview(readFilters(req), scopeOf(req));
      ResponseUtil.success(res, data, 'Staff track overview fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 25);
      const result = await StaffTrackService.getStaffList(readFilters(req), page, limit);
      ResponseUtil.paginated(res, result, 'Staff metrics fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getStaffDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = ParamUtil.id(req.params.id, 'staff id');
      // Checked before the lookup so a self-scoped caller cannot probe which
      // staff ids exist by telling a 403 and a 404 apart.
      if (!scopeAllowsUser(scopeOf(req), id)) {
        throw AppError.forbidden('Requires permission: stafftrack.view');
      }
      const data = await StaffTrackService.getStaffDetail(id, readFilters(req));
      ResponseUtil.success(res, data, 'Staff detail fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getLive(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const windowMinutes = ParamUtil.optionalId(req.query.windowMinutes, 'windowMinutes') || 30;
      const data = await StaffTrackService.getLiveActivity(windowMinutes, scopeOf(req));
      ResponseUtil.success(res, data, 'Live activity fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 25);
      const result = await StaffTrackService.getOrders(
        {
          ...readFilters(req),
          status: ParamUtil.text(req.query.orderStatus),
          paymentStatus: ParamUtil.text(req.query.paymentStatus),
          tableId: ParamUtil.optionalId(req.query.tableId, 'tableId'),
        },
        page,
        limit
      );
      ResponseUtil.paginated(res, result, 'Staff order tracking fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getOrderDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = ParamUtil.id(req.params.orderId, 'order id');
      const data = await StaffTrackService.getOrderAttribution(id, scopeOf(req));
      ResponseUtil.success(res, data, 'Order attribution fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getRevenue(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getRevenue(readFilters(req));
      ResponseUtil.success(res, data, 'Staff revenue fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getTables(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getTables(readFilters(req));
      ResponseUtil.success(res, data, 'Staff table tracking fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const result = await StaffTrackService.getActivity(
        {
          ...readFilters(req),
          module: ParamUtil.text(req.query.module),
          action: ParamUtil.text(req.query.action),
        },
        page,
        limit
      );
      ResponseUtil.paginated(res, result, 'Staff activity fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getFilterOptions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = scopeOf(req);
      const [options, facets] = await Promise.all([
        StaffTrackService.getFilterOptions(scope),
        StaffTrackService.getActivityFacets(),
      ]);
      // `scope` travels with the options so the UI can hide the staff picker
      // rather than render a one-entry dropdown it cannot widen.
      ResponseUtil.success(
        res,
        { ...options, ...facets, scope: scope.kind },
        'Filter options fetched successfully'
      );
    } catch (err) {
      next(err);
    }
  }

  static async getOrdersReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getOrdersReport(readFilters(req));
      ResponseUtil.success(res, data, 'Staff order report fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getRevenueReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getRevenue(readFilters(req));
      ResponseUtil.success(res, data, 'Staff revenue report fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getTablesReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getTables(readFilters(req));
      ResponseUtil.success(res, { perStaff: data.perStaff }, 'Table service report fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getActivityReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StaffTrackService.getActivityReport({
        ...readFilters(req),
        module: ParamUtil.text(req.query.module),
      });
      ResponseUtil.success(res, data, 'Staff activity report fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getSummaryReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const raw = (ParamUtil.text(req.query.period) || 'daily').toLowerCase();
      const period = (['daily', 'weekly', 'monthly'].includes(raw) ? raw : 'daily') as
        | 'daily'
        | 'weekly'
        | 'monthly';
      const data = await StaffTrackService.getSummaryReport(period, readFilters(req));
      ResponseUtil.success(res, { period, rows: data }, 'Staff summary report fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
