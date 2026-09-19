import { Request, Response, NextFunction } from 'express';
import { ReportsService } from './reports.service';
import { ReportsSalesService } from './reports.sales.service';
import { ReportsFinanceService } from './reports.finance.service';
import { ReportsInventoryService } from './reports.inventory.service';
import { ReportsBiService } from './reports.bi.service';
import { REPORT_CATALOG } from './reports.catalog';
import { BillScope, Granularity, ReportQuery, ReportRange } from './reports.query';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

/**
 * Every report takes the same window and the same bill filters, so they are
 * parsed once here rather than per handler. A malformed date or preset throws
 * a 400 out of `ReportQuery`/`ParamUtil` before any query runs.
 */
const range = (req: Request): ReportRange =>
  ReportQuery.range({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    preset: req.query.preset,
  });

const scope = (req: Request): BillScope => ({
  paymentMethod: ParamUtil.text(req.query.paymentMethod),
  orderType: ParamUtil.text(req.query.orderType),
  cashierId: ParamUtil.optionalId(req.query.cashierId, 'cashierId'),
  customerId: ParamUtil.optionalId(req.query.customerId, 'customerId'),
  includeVoided: ParamUtil.bool(req.query.includeVoided),
});

const granularity = (req: Request, fallback: Granularity = 'day'): Granularity =>
  ReportQuery.granularity(req.query.granularity, fallback);

export class ReportsController {
  // ───────────────────────────────────────────────────────────────────────────
  // Catalog
  // ───────────────────────────────────────────────────────────────────────────

  /** Machine-readable index of the suite, so a client need not hardcode it. */
  static async getCatalog(req: Request, res: Response, next: NextFunction) {
    try {
      ResponseUtil.success(res, REPORT_CATALOG, 'Report catalog retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Legacy endpoints, kept for the existing reports screen
  // ───────────────────────────────────────────────────────────────────────────

  static async getSalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const paymentMethod = req.query.paymentMethod as string | undefined;
      const orderType = req.query.orderType as string | undefined;
      const cashierId = ParamUtil.optionalId(req.query.cashierId, 'cashierId');

      const report = await ReportsService.getSalesReport(dateFrom, dateTo, paymentMethod, orderType, cashierId);
      ResponseUtil.success(res, report, 'Sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getProductSalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const categoryId = ParamUtil.optionalId(req.query.categoryId, 'categoryId');

      const report = await ReportsService.getProductSalesReport(dateFrom, dateTo, categoryId);
      ResponseUtil.success(res, report, 'Product sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getCategorySalesReport(req: Request, res: Response, next: NextFunction) {
    try {
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;

      const report = await ReportsService.getCategorySalesReport(dateFrom, dateTo);
      ResponseUtil.success(res, report, 'Category sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getStockReport(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsService.getStockReport();
      ResponseUtil.success(res, report, 'Stock report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sales reports
  // ───────────────────────────────────────────────────────────────────────────

  static async salesByProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.byProduct({
        range: range(req),
        ...scope(req),
        categoryId: ParamUtil.optionalId(req.query.categoryId, 'categoryId'),
        limit: req.query.limit ? ParamUtil.limit(req.query.limit, 100, 1000) : undefined,
        groupBy: req.query.groupBy === 'variant' ? 'variant' : 'product',
      });
      ResponseUtil.success(res, report, 'Sales by product report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async salesByCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.byCategory({ range: range(req), ...scope(req) });
      ResponseUtil.success(res, report, 'Sales by category report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async salesByEmployee(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.byEmployee({ range: range(req), ...scope(req) });
      ResponseUtil.success(res, report, 'Sales by employee report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async salesByHour(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.byHour({ range: range(req), ...scope(req) });
      ResponseUtil.success(res, report, 'Sales by hour report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async salesByOrderType(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.byOrderType({ range: range(req), ...scope(req) });
      ResponseUtil.success(res, report, 'Sales by order type report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async dailySales(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.daily({ range: range(req), ...scope(req) });
      ResponseUtil.success(res, report, 'Daily sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async monthlySales(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.monthly({ range: range(req), ...scope(req) });
      ResponseUtil.success(res, report, 'Monthly sales report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async salesTrends(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsSalesService.trends({
        range: range(req),
        ...scope(req),
        granularity: granularity(req),
      });
      ResponseUtil.success(res, report, 'Sales trends report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Finance reports
  // ───────────────────────────────────────────────────────────────────────────

  static async revenue(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.revenue({
        range: range(req),
        ...scope(req),
        granularity: granularity(req),
      });
      ResponseUtil.success(res, report, 'Revenue report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async tax(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.tax({
        range: range(req),
        ...scope(req),
        granularity: granularity(req),
      });
      ResponseUtil.success(res, report, 'Tax report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async discounts(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.discounts({
        range: range(req),
        ...scope(req),
        granularity: granularity(req),
      });
      ResponseUtil.success(res, report, 'Discount report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async refunds(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.refunds({
        range: range(req),
        ...scope(req),
        granularity: granularity(req),
        status: ParamUtil.text(req.query.status),
        reasonCode: ParamUtil.text(req.query.reasonCode),
      });
      ResponseUtil.success(res, report, 'Refund report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async paymentMethods(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.paymentMethods({
        range: range(req),
        ...scope(req),
        granularity: granularity(req),
      });
      ResponseUtil.success(res, report, 'Payment methods report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async expenses(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.expenses({
        range: range(req),
        category: ParamUtil.text(req.query.category),
        paymentMethod: ParamUtil.text(req.query.paymentMethod),
        vendorId: ParamUtil.optionalId(req.query.vendorId, 'vendorId'),
        includePending: ParamUtil.bool(req.query.includePending),
      });
      ResponseUtil.success(res, report, 'Expense report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async profit(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsFinanceService.profit({
        range: range(req),
        ...scope(req),
        granularity: granularity(req, 'month'),
      });
      ResponseUtil.success(res, report, 'Profit report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Inventory reports
  // ───────────────────────────────────────────────────────────────────────────

  static async stockValuation(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.stockValuation({
        categoryId: ParamUtil.optionalId(req.query.categoryId, 'categoryId'),
        lowStockOnly: ParamUtil.bool(req.query.lowStockOnly),
        includeInactive: ParamUtil.bool(req.query.includeInactive),
      });
      ResponseUtil.success(res, report, 'Stock valuation report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async stockMovement(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.stockMovement(ReportsController.inventoryOptions(req));
      ResponseUtil.success(res, report, 'Stock movement report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async wastage(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.wastage(ReportsController.inventoryOptions(req));
      ResponseUtil.success(res, report, 'Wastage report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async purchases(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.purchase(ReportsController.inventoryOptions(req));
      ResponseUtil.success(res, report, 'Purchase report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async consumption(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.consumption(ReportsController.inventoryOptions(req));
      ResponseUtil.success(res, report, 'Consumption report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async foodCost(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.foodCost(ReportsController.inventoryOptions(req));
      ResponseUtil.success(res, report, 'Food cost report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async inventoryVariance(req: Request, res: Response, next: NextFunction) {
    try {
      const tolerance = req.query.tolerance !== undefined ? Number(req.query.tolerance) : undefined;
      const report = await ReportsInventoryService.variance({
        stockItemId: ParamUtil.optionalId(req.query.stockItemId, 'stockItemId'),
        onlyDiscrepancies: ParamUtil.bool(req.query.onlyDiscrepancies),
        tolerance: Number.isFinite(tolerance) && tolerance! >= 0 ? tolerance : undefined,
      });
      ResponseUtil.success(res, report, 'Inventory variance report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async stockAdjustments(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsInventoryService.adjustments(ReportsController.inventoryOptions(req));
      ResponseUtil.success(res, report, 'Stock adjustment report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Business intelligence
  // ───────────────────────────────────────────────────────────────────────────

  static async productPerformance(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.productPerformance(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Product performance report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async customerAnalytics(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.customerAnalytics(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Customer analytics report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async biSalesTrends(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.salesTrends(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Sales trends report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async peakHours(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.peakHours(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Peak hours report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async averageOrderValue(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.averageOrderValue(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Average order value report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async repeatCustomers(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.repeatCustomers(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Repeat customers report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async dashboardKpis(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.dashboardKpis(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Dashboard KPIs generated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async employeePerformance(req: Request, res: Response, next: NextFunction) {
    try {
      const report = await ReportsBiService.employeePerformance(ReportsController.biOptions(req));
      ResponseUtil.success(res, report, 'Employee performance report generated successfully');
    } catch (err) {
      next(err);
    }
  }

  private static inventoryOptions(req: Request) {
    return {
      range: range(req),
      stockItemId: ParamUtil.optionalId(req.query.stockItemId, 'stockItemId'),
      categoryId: ParamUtil.optionalId(req.query.categoryId, 'categoryId'),
      granularity: granularity(req),
      limit: req.query.limit ? ParamUtil.limit(req.query.limit, 200, 1000) : undefined,
    };
  }

  private static biOptions(req: Request) {
    return {
      range: range(req),
      ...scope(req),
      granularity: granularity(req),
      limit: req.query.limit ? ParamUtil.limit(req.query.limit, 50, 500) : undefined,
    };
  }
}
