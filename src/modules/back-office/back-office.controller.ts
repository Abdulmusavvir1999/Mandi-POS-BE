import { Request, Response, NextFunction } from 'express';
import { BackOfficeService, BulkResult } from './back-office.service';
import { ResponseUtil } from '../../core/utils/response.util';
import { ParamUtil } from '../../core/utils/param.util';
import { OrderStatus, OrderType, PaymentMethod } from '../../core/types';

/**
 * Turns a bulk result into the sentence the operator sees.
 *
 * A run where some records were rejected must never read as a clean success —
 * the summary names how many went through and how many did not, and the caller
 * still receives the per-record reasons in `data.failed`.
 */
const summarise = (result: BulkResult, noun: string, verb: string): string => {
  const done = result.succeeded.length;
  const skipped = result.failed.length;

  if (done === 0) {
    return `No ${noun} could be ${verb}. ${skipped} ${skipped === 1 ? 'record was' : 'records were'} rejected.`;
  }
  if (skipped === 0) {
    return `${done} ${done === 1 ? noun.replace(/s$/, '') : noun} ${verb}.`;
  }
  return `${done} of ${result.requested} ${noun} ${verb}. ${skipped} could not be processed.`;
};

export class BackOfficeController {
  // ── Orders ────────────────────────────────────────────────────────────

  static async listOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const hasInvoiceRaw = ParamUtil.text(req.query.hasInvoice);
      const result = await BackOfficeService.listOrders({
        page: ParamUtil.page(req.query.page),
        limit: ParamUtil.limit(req.query.limit, 20),
        status: ParamUtil.text(req.query.status) as OrderStatus | undefined,
        orderType: ParamUtil.text(req.query.orderType) as OrderType | undefined,
        search: ParamUtil.text(req.query.search),
        hasInvoice: hasInvoiceRaw === 'YES' || hasInvoiceRaw === 'NO' ? hasInvoiceRaw : undefined,
        dateFrom: ParamUtil.text(req.query.dateFrom),
        dateTo: ParamUtil.text(req.query.dateTo),
      });
      ResponseUtil.paginated(res, result, 'Back-office orders fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const order = await BackOfficeService.getOrder(id);
      ResponseUtil.success(res, order, 'Order retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.createOrderWithInvoice(req.body, req.user!.id);
      ResponseUtil.created(res, result, 'Order created and invoice raised successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deleteOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await BackOfficeService.deleteOrders([id], req.user!.id, ParamUtil.text(req.body?.reason));

      if (result.failed.length > 0) {
        ResponseUtil.error(res, result.failed[0].reason, 'ORDER_DELETE_REJECTED', 409, result);
        return;
      }

      ResponseUtil.success(res, result, `Order ${result.succeeded[0].reference} deleted.`);
    } catch (err) {
      next(err);
    }
  }

  static async deleteOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.deleteOrders(req.body?.orderIds, req.user!.id, ParamUtil.text(req.body?.reason));
      ResponseUtil.success(res, result, summarise(result, 'orders', 'deleted'));
    } catch (err) {
      next(err);
    }
  }

  /** The withdrawn orders available to undo. */
  static async listDeletedOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.listDeletedOrders({
        page: ParamUtil.page(req.query.page),
        limit: ParamUtil.limit(req.query.limit, 20),
        search: ParamUtil.text(req.query.search),
      });
      ResponseUtil.paginated(res, result, 'Deleted orders fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async restoreOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await BackOfficeService.restoreOrders([id], req.user!.id);

      if (result.failed.length > 0) {
        ResponseUtil.error(res, result.failed[0].reason, 'ORDER_RESTORE_REJECTED', 409, result);
        return;
      }

      ResponseUtil.success(res, result, `Order ${result.succeeded[0].reference} restored.`);
    } catch (err) {
      next(err);
    }
  }

  static async restoreOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.restoreOrders(req.body?.orderIds, req.user!.id);
      ResponseUtil.success(res, result, summarise(result, 'orders', 'restored'));
    } catch (err) {
      next(err);
    }
  }

  static async applyDiscount(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.applyBulkDiscount(req.body, req.user!.id);
      ResponseUtil.success(res, result, summarise(result, 'orders', 'discounted'));
    } catch (err) {
      next(err);
    }
  }

  // ── Invoices ──────────────────────────────────────────────────────────

  static async listInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.listInvoices({
        page: ParamUtil.page(req.query.page),
        limit: ParamUtil.limit(req.query.limit, 20),
        search: ParamUtil.text(req.query.search),
        paymentMethod: ParamUtil.text(req.query.paymentMethod) as PaymentMethod | undefined,
        orderType: ParamUtil.text(req.query.orderType) as OrderType | undefined,
        dateFrom: ParamUtil.text(req.query.dateFrom),
        dateTo: ParamUtil.text(req.query.dateTo),
      });
      ResponseUtil.paginated(res, result, 'Back-office invoices fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const invoice = await BackOfficeService.getInvoice(id);
      ResponseUtil.success(res, invoice, 'Invoice retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deleteInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await BackOfficeService.deleteInvoices([id], req.user!.id, ParamUtil.text(req.body?.reason));

      if (result.failed.length > 0) {
        ResponseUtil.error(res, result.failed[0].reason, 'INVOICE_DELETE_REJECTED', 409, result);
        return;
      }

      ResponseUtil.success(res, result, `Invoice ${result.succeeded[0].reference} deleted.`);
    } catch (err) {
      next(err);
    }
  }

  static async deleteInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.deleteInvoices(req.body?.invoiceIds, req.user!.id, ParamUtil.text(req.body?.reason));
      ResponseUtil.success(res, result, summarise(result, 'invoices', 'deleted'));
    } catch (err) {
      next(err);
    }
  }

  /** The withdrawn invoices available to undo. */
  static async listDeletedInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.listDeletedInvoices({
        page: ParamUtil.page(req.query.page),
        limit: ParamUtil.limit(req.query.limit, 20),
        search: ParamUtil.text(req.query.search),
      });
      ResponseUtil.paginated(res, result, 'Deleted invoices fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async restoreInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await BackOfficeService.restoreInvoices([id], req.user!.id);

      if (result.failed.length > 0) {
        ResponseUtil.error(res, result.failed[0].reason, 'INVOICE_RESTORE_REJECTED', 409, result);
        return;
      }

      ResponseUtil.success(res, result, `Invoice ${result.succeeded[0].reference} restored.`);
    } catch (err) {
      next(err);
    }
  }

  static async restoreInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await BackOfficeService.restoreInvoices(req.body?.invoiceIds, req.user!.id);
      ResponseUtil.success(res, result, summarise(result, 'invoices', 'restored'));
    } catch (err) {
      next(err);
    }
  }
}
