import { Request, Response, NextFunction } from 'express';
import { StockService } from './stock.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';

export class StockController {
  /**
   * 1. Stock Master Items List
   */
  static async getCurrentStock(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const search = req.query.search as string | undefined;
      const categoryId = ParamUtil.optionalId(req.query.categoryId, 'categoryId');
      const lowStockOnly = req.query.lowStockOnly === 'true';
      const status = req.query.status as string | undefined;
      const unitType = req.query.unitType as string | undefined;

      const result = await StockService.getCurrentStock(page, limit, search, categoryId, lowStockOnly, status, unitType);
      ResponseUtil.paginated(res, result, 'Stock inventory fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 2. Stock Master Item by ID
   */
  static async getStockItemById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await StockService.getStockItemById(id);
      ResponseUtil.success(res, result, 'Stock item details fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 3. Create Stock Master Item
   */
  static async createStockItem(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await StockService.createStockItem(req.body, req.user!.id);
      ResponseUtil.created(res, result, 'Stock master item created successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 4. Update Stock Master Item
   */
  static async updateStockItem(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await StockService.updateStockItem(id, req.body, req.user!.id);
      ResponseUtil.success(res, result, 'Stock master item updated successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 5. Get Purchase Entries Ledger
   */
  static async getStockEntries(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const stockItemId = ParamUtil.optionalId(req.query.stockItemId, 'stockItemId');
      const search = req.query.search as string | undefined;
      const supplier = req.query.supplier as string | undefined;
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      const vendorId = ParamUtil.optionalId(req.query.vendorId, 'vendorId');

      const result = await StockService.getStockEntries(page, limit, stockItemId, search, supplier, dateFrom, dateTo, vendorId);
      ResponseUtil.paginated(res, result, 'Stock purchase entries fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 6. Create Purchase Entry (Qty * Mult, Price / TotalQty)
   */
  static async createStockEntry(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await StockService.createStockEntry(req.body, req.user!.id);
      ResponseUtil.created(res, result, 'Stock purchase entry recorded successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 7. Get Stock Movements Audit History
   */
  static async getStockMovements(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const stockItemId = ParamUtil.optionalId(req.query.stockItemId, 'stockItemId');
      const movementType = req.query.movementType as string | undefined;
      const search = req.query.search as string | undefined;
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;

      const result = await StockService.getStockMovements(page, limit, stockItemId, movementType, search, dateFrom, dateTo);
      ResponseUtil.paginated(res, result, 'Stock movements fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 8. Stock Adjustment (Audit, Wastage, Returns)
   */
  static async adjustStock(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await StockService.adjustStock(req.body, req.user!.id);
      ResponseUtil.success(res, result, 'Stock adjustment applied successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 9. Inventory Alerts (Out of stock, Low stock, Minimum stock, Reorder level, Expiry, Overstock)
   */
  static async getStockAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const type = req.query.type as string | undefined;
      const result = await StockService.getStockAlerts(type);
      ResponseUtil.success(res, result, 'Inventory alerts fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 10. Low Stock Alerts
   */
  static async getLowStock(req: Request, res: Response, next: NextFunction) {
    try {
      const lowStock = await StockService.getLowStock();
      ResponseUtil.success(res, lowStock, 'Low stock alerts fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 10. Backward-compatible Stock In
   */
  static async stockIn(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await StockService.stockIn(req.body, req.user!.id);
      ResponseUtil.success(res, result, 'Stock in recorded successfully');
    } catch (err) {
      next(err);
    }
  }

  /**
   * 11. Backward-compatible Transactions
   */
  static async getTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const productId = ParamUtil.optionalId(req.query.productId, 'productId');
      const type = req.query.type as string | undefined;

      const result = await StockService.getTransactions(page, limit, productId, type);
      ResponseUtil.paginated(res, result, 'Stock transactions fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
