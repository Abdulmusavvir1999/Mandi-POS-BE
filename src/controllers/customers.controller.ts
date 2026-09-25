import { Request, Response, NextFunction } from 'express';
import { CustomersService } from '../services/customers.service';
import { ResponseUtil } from '../utils/response.util';
import { ParamUtil } from '../utils/param.util';
import { CustomerImageService } from '../services/customer-image.service';

export class CustomersController {
  /** Stores a customer photo and returns its URL; uploaded before the row exists. */
  static async uploadImage(req: Request, res: Response, next: NextFunction) {
    try {
      const { dataUrl } = req.body || {};
      const data = CustomerImageService.save(dataUrl);
      ResponseUtil.success(res, data, 'Customer photo uploaded successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const summary = await CustomersService.getCrmSummary();
      ResponseUtil.success(res, summary, 'Customer CRM summary fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = ParamUtil.page(req.query.page);
      const limit = ParamUtil.limit(req.query.limit, 50);
      const search = req.query.search as string | undefined;
      const segment = req.query.segment as string | undefined;

      const result = await CustomersService.getAll(page, limit, search, segment);
      ResponseUtil.paginated(res, result, 'Customers fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const customer = await CustomersService.getById(id);
      ResponseUtil.success(res, customer, 'Customer retrieved successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getAnalytics(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const analytics = await CustomersService.getCustomerAnalytics(id);
      ResponseUtil.success(res, analytics, 'Customer analytics fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getNotes(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const notes = await CustomersService.getCustomerNotes(id);
      ResponseUtil.success(res, notes, 'Customer notes fetched successfully');
    } catch (err) {
      next(err);
    }
  }

  static async createNote(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const note = await CustomersService.createCustomerNote(id, req.body, req.user!.id);
      ResponseUtil.created(res, note, 'Customer note created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async deleteNote(req: Request, res: Response, next: NextFunction) {
    try {
      const noteId = ParamUtil.id(req.params.noteId, 'noteId');
      const result = await CustomersService.deleteCustomerNote(noteId, req.user!.id);
      ResponseUtil.success(res, result, 'Customer note deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const customer = await CustomersService.create(req.body, req.user!.id);
      ResponseUtil.created(res, customer, 'Customer created successfully');
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const customer = await CustomersService.update(id, req.body, req.user!.id);
      ResponseUtil.success(res, customer, 'Customer updated successfully');
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const result = await CustomersService.delete(id, req.user!.id);
      ResponseUtil.success(res, result, 'Customer deleted successfully');
    } catch (err) {
      next(err);
    }
  }

  static async getPurchaseHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const id = ParamUtil.id(req.params.id, 'id');
      const history = await CustomersService.getPurchaseHistory(id);
      ResponseUtil.success(res, history, 'Customer purchase history fetched successfully');
    } catch (err) {
      next(err);
    }
  }
}
