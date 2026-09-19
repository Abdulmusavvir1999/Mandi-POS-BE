import { v4 as uuidv4 } from 'uuid';
import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { ReportsSchema } from '../reports/reports.schema';

export interface CreateExpenseInput {
  category: string;
  expense_date: string;
  amount: number;
  tax_amount?: number;
  payment_method?: string;
  payment_status?: string;
  vendor_id?: number | null;
  vendor_name?: string;
  reference_number?: string;
  description?: string;
  notes?: string;
  is_recurring?: boolean;
}

export type UpdateExpenseInput = Partial<CreateExpenseInput>;

export interface ListExpensesQuery {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  vendorId?: number;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

const SORTABLE: Record<string, string> = {
  expense_date: 'e.expense_date',
  total_amount: 'e.total_amount',
  category: 'e.category',
  created_at: 'e.created_at',
  expense_number: 'e.expense_number',
};

/**
 * Operating expenses — the spend side of the profit report.
 *
 * The reporting module owns the table definition (`ReportsSchema`), because
 * expenses exist for the Expenses and Profit reports; this service is the
 * write path that keeps them from being permanently empty.
 *
 * `total_amount` is always computed server-side as `amount + tax_amount` and
 * never taken from the request, so the figure the profit report sums cannot
 * disagree with its own components.
 */
export class ExpensesService {
  static async getAll(query: ListExpensesQuery = {}) {
    await ReportsSchema.ensure();

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 50;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (query.search) {
      where +=
        ' AND (e.expense_number LIKE ? OR e.description LIKE ? OR e.reference_number LIKE ? OR e.vendor_name LIKE ? OR e.category LIKE ?)';
      const term = `%${query.search}%`;
      params.push(term, term, term, term, term);
    }
    if (query.category) {
      where += ' AND e.category = ?';
      params.push(query.category);
    }
    if (query.paymentMethod) {
      where += ' AND e.payment_method = ?';
      params.push(query.paymentMethod);
    }
    if (query.paymentStatus) {
      where += ' AND e.payment_status = ?';
      params.push(query.paymentStatus);
    }
    if (query.vendorId) {
      where += ' AND e.vendor_id = ?';
      params.push(query.vendorId);
    }
    if (query.dateFrom) {
      where += ' AND e.expense_date >= ?';
      params.push(query.dateFrom);
    }
    if (query.dateTo) {
      where += ' AND e.expense_date <= ?';
      params.push(query.dateTo);
    }

    const sortColumn = SORTABLE[query.sortBy ?? ''] ?? 'e.expense_date';
    const sortOrder = query.sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM expenses e ${where}`,
      params
    );
    const total = Number(countRes?.total ?? 0);

    const data = await dbService.query(
      `SELECT
         e.*,
         COALESCE(u.name, 'System') AS recorded_by_name,
         COALESCE(ec.is_fixed_cost, 0) AS is_fixed_cost
       FROM expenses e
       LEFT JOIN users u ON e.recorded_by = u.id
       LEFT JOIN expense_categories ec ON ec.name = e.category
       ${where}
       ORDER BY ${sortColumn} ${sortOrder}, e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totals = await dbService.queryOne<{ total_amount: number; paid_amount: number; pending_amount: number }>(
      `SELECT
         COALESCE(SUM(e.total_amount), 0) AS total_amount,
         COALESCE(SUM(CASE WHEN e.payment_status = 'PAID' THEN e.total_amount ELSE 0 END), 0) AS paid_amount,
         COALESCE(SUM(CASE WHEN e.payment_status = 'PENDING' THEN e.total_amount ELSE 0 END), 0) AS pending_amount
       FROM expenses e
       ${where}`,
      params
    );

    return {
      data,
      totals: {
        total_amount: Number(totals?.total_amount ?? 0),
        paid_amount: Number(totals?.paid_amount ?? 0),
        pending_amount: Number(totals?.pending_amount ?? 0),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    await ReportsSchema.ensure();
    const expense = await dbService.queryOne(
      `SELECT
         e.*,
         COALESCE(u.name, 'System') AS recorded_by_name,
         COALESCE(ec.is_fixed_cost, 0) AS is_fixed_cost
       FROM expenses e
       LEFT JOIN users u ON e.recorded_by = u.id
       LEFT JOIN expense_categories ec ON ec.name = e.category
       WHERE e.id = ?`,
      [id]
    );
    if (!expense) {
      throw AppError.notFound(`Expense ${id} not found`);
    }
    return expense;
  }

  static async getCategories(includeInactive = false) {
    await ReportsSchema.ensure();
    return dbService.query(
      // `usage` is reserved in MariaDB, hence the `spend` alias.
      `SELECT ec.*,
              COALESCE(spend.expenses_count, 0) AS expenses_count,
              COALESCE(spend.total_amount, 0)   AS total_amount
       FROM expense_categories ec
       LEFT JOIN (
         SELECT category, COUNT(*) AS expenses_count, SUM(total_amount) AS total_amount
         FROM expenses
         WHERE payment_status <> 'CANCELLED'
         GROUP BY category
       ) spend ON spend.category = ec.name
       ${includeInactive ? '' : "WHERE ec.status = 'ACTIVE'"}
       ORDER BY ec.display_order ASC, ec.name ASC`
    );
  }

  static async create(data: CreateExpenseInput, userId: number) {
    await ReportsSchema.ensure();

    const amount = this.money(data.amount, 'amount');
    const taxAmount = data.tax_amount === undefined ? 0 : this.money(data.tax_amount, 'tax_amount');
    const category = data.category?.trim();
    if (!category) {
      throw AppError.badRequest('Expense category is required', 'VALIDATION_ERROR');
    }
    const expenseDate = this.date(data.expense_date, 'expense_date');

    const vendorName = await this.resolveVendorName(data.vendor_id, data.vendor_name);

    const expenseNumber = await this.nextExpenseNumber();
    const uuid = uuidv4();

    const res = await dbService.execute(
      `INSERT INTO expenses (
         uuid, expense_number, category, expense_date, amount, tax_amount, total_amount,
         payment_method, payment_status, vendor_id, vendor_name, reference_number,
         description, notes, is_recurring, recorded_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid,
        expenseNumber,
        category,
        expenseDate,
        amount,
        taxAmount,
        Math.round((amount + taxAmount) * 100) / 100,
        (data.payment_method ?? 'CASH').toUpperCase(),
        (data.payment_status ?? 'PAID').toUpperCase(),
        data.vendor_id ?? null,
        vendorName,
        data.reference_number ?? null,
        data.description ?? null,
        data.notes ?? null,
        data.is_recurring ? 1 : 0,
        userId,
      ]
    );

    await AuditService.log({
      userId,
      action: 'EXPENSE_CREATED',
      module: 'EXPENSES',
      recordId: res.lastInsertRowid,
      newValues: { expenseNumber, category, amount, taxAmount, expenseDate },
    });

    return this.getById(res.lastInsertRowid);
  }

  static async update(id: number, data: UpdateExpenseInput, userId: number) {
    await ReportsSchema.ensure();
    const existing: any = await this.getById(id);

    // Amount and tax are interdependent through total_amount, so both are
    // resolved before the write even when only one was supplied.
    const amount = data.amount === undefined ? Number(existing.amount) : this.money(data.amount, 'amount');
    const taxAmount =
      data.tax_amount === undefined ? Number(existing.tax_amount) : this.money(data.tax_amount, 'tax_amount');

    const vendorId = data.vendor_id === undefined ? existing.vendor_id : data.vendor_id;
    const vendorName =
      data.vendor_id === undefined && data.vendor_name === undefined
        ? existing.vendor_name
        : await this.resolveVendorName(vendorId, data.vendor_name);

    await dbService.execute(
      `UPDATE expenses SET
         category = ?,
         expense_date = ?,
         amount = ?,
         tax_amount = ?,
         total_amount = ?,
         payment_method = ?,
         payment_status = ?,
         vendor_id = ?,
         vendor_name = ?,
         reference_number = ?,
         description = ?,
         notes = ?,
         is_recurring = ?
       WHERE id = ?`,
      [
        data.category?.trim() || existing.category,
        data.expense_date ? this.date(data.expense_date, 'expense_date') : existing.expense_date,
        amount,
        taxAmount,
        Math.round((amount + taxAmount) * 100) / 100,
        (data.payment_method ?? existing.payment_method).toUpperCase(),
        (data.payment_status ?? existing.payment_status).toUpperCase(),
        vendorId ?? null,
        vendorName,
        data.reference_number === undefined ? existing.reference_number : data.reference_number,
        data.description === undefined ? existing.description : data.description,
        data.notes === undefined ? existing.notes : data.notes,
        data.is_recurring === undefined ? existing.is_recurring : data.is_recurring ? 1 : 0,
        id,
      ]
    );

    await AuditService.log({
      userId,
      action: 'EXPENSE_UPDATED',
      module: 'EXPENSES',
      recordId: id,
      oldValues: {
        category: existing.category,
        amount: existing.amount,
        tax_amount: existing.tax_amount,
        payment_status: existing.payment_status,
      },
      newValues: { category: data.category, amount, taxAmount, payment_status: data.payment_status },
    });

    return this.getById(id);
  }

  static async delete(id: number, userId: number) {
    await ReportsSchema.ensure();
    const existing: any = await this.getById(id);

    await dbService.execute('DELETE FROM expenses WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'EXPENSE_DELETED',
      module: 'EXPENSES',
      recordId: id,
      oldValues: {
        expense_number: existing.expense_number,
        category: existing.category,
        total_amount: existing.total_amount,
      },
    });

    return { id, deleted: true };
  }

  /** `EXP-000001`, sequential on the table's high-water mark. */
  private static async nextExpenseNumber(): Promise<string> {
    const maxRes = await dbService.queryOne<{ max_id: number }>('SELECT COALESCE(MAX(id), 0) as max_id FROM expenses');
    const next = Number(maxRes?.max_id ?? 0) + 1;
    return `EXP-${String(next).padStart(6, '0')}`;
  }

  /**
   * Denormalises the vendor's name onto the expense so the report reads
   * correctly even if the vendor is later renamed or removed. A supplied name
   * is kept when no vendor id is given, which is the common case for one-off
   * cash spend.
   */
  private static async resolveVendorName(
    vendorId?: number | null,
    vendorName?: string
  ): Promise<string | null> {
    if (vendorId) {
      try {
        const vendor = await dbService.queryOne<{ name: string }>('SELECT name FROM vendors WHERE id = ?', [vendorId]);
        if (vendor?.name) return vendor.name;
      } catch {
        // The vendor module may not be migrated on this database; fall through
        // to whatever name the caller supplied.
      }
    }
    return vendorName?.trim() || null;
  }

  private static money(value: unknown, field: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw AppError.badRequest(`Invalid ${field}: a non-negative number is required.`, 'VALIDATION_ERROR');
    }
    return Math.round(parsed * 100) / 100;
  }

  private static date(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
      throw AppError.badRequest(`Invalid ${field}: expected a YYYY-MM-DD date.`, 'VALIDATION_ERROR');
    }
    return value.trim().slice(0, 10);
  }
}
