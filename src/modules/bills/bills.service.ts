import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { PaymentMethod, OrderType } from '../../core/types';

export class BillsService {
  static async getAll(
    page = 1,
    limit = 50,
    search?: string,
    paymentMethod?: PaymentMethod,
    orderType?: OrderType,
    dateFrom?: string,
    dateTo?: string,
    cashierId?: number
  ) {
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (b.bill_number LIKE ? OR o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (paymentMethod) {
      where += ' AND b.payment_method = ?';
      params.push(paymentMethod);
    }

    if (orderType) {
      where += ' AND b.order_type = ?';
      params.push(orderType);
    }

    if (cashierId) {
      where += ' AND b.cashier_id = ?';
      params.push(cashierId);
    }

    if (dateFrom) {
      where += ' AND DATE(b.created_at) >= DATE(?)';
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ' AND DATE(b.created_at) <= DATE(?)';
      params.push(dateTo);
    }

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) as total
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       ${where}`,
      params
    );
    const total = countRes?.total || 0;

    const bills = await dbService.query(
      `SELECT b.*, o.order_number, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as cashier_name
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN dining_tables t ON b.dining_table_id = t.id
       LEFT JOIN users u ON b.cashier_id = u.id
       ${where}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: bills,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getById(id: number) {
    const bill = await dbService.queryOne(
      `SELECT b.*, o.order_number, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
              t.table_number, t.name as table_name,
              u.name as cashier_name
       FROM bills b
       LEFT JOIN orders o ON b.order_id = o.id
       LEFT JOIN customers c ON b.customer_id = c.id
       LEFT JOIN dining_tables t ON b.dining_table_id = t.id
       LEFT JOIN users u ON b.cashier_id = u.id
       WHERE b.id = ?`,
      [id]
    );

    if (!bill) {
      throw AppError.notFound('Bill not found');
    }

    const items = await dbService.query(
      `SELECT bi.*, p.sku
       FROM bill_items bi
       JOIN products p ON bi.product_id = p.id
       WHERE bi.bill_id = ?`,
      [id]
    );

    const payments = await dbService.query(
      'SELECT * FROM payments WHERE bill_id = ?',
      [id]
    );

    return {
      ...bill,
      items,
      payments,
    };
  }

  static async getPrintData(id: number, userId?: number) {
    const bill = await this.getById(id);

    // Fetch Shop & Receipt Settings
    const settingsRows = await dbService.query<{ key: string; value: string }>('SELECT `key`, `value` FROM settings');
    const settingsMap: Record<string, string> = {};
    for (const r of settingsRows) {
      settingsMap[r.key] = r.value;
    }
    // Legacy databases spell these keys differently; expose both spellings.
    SettingsService.applyKeyAliases(settingsMap);

    // Increment print count
    await dbService.execute('UPDATE bills SET printed_count = printed_count + 1 WHERE id = ?', [id]);

    if (userId) {
      await AuditService.log({
        userId,
        action: 'BILL_PRINTED',
        module: 'BILLS',
        recordId: id,
        newValues: { billNumber: bill.bill_number },
      });
    }

    return {
      bill,
      receiptSettings: {
        businessName: settingsMap['BUSINESS_NAME'] || settingsMap['restaurant_name'] || '',
        phone: settingsMap['BUSINESS_PHONE'] || '',
        email: settingsMap['BUSINESS_EMAIL'] || '',
        address: settingsMap['BUSINESS_ADDRESS'] || '',
        gstin: settingsMap['BUSINESS_GSTIN'] || '',
        currencySymbol: settingsMap['CURRENCY_SYMBOL'] || '₹',
        header: settingsMap['RECEIPT_HEADER'] || '',
        footer: settingsMap['RECEIPT_FOOTER'] || '',
        showLogo: settingsMap['RECEIPT_SHOW_LOGO'] === 'true',
        showTax: settingsMap['RECEIPT_SHOW_TAX'] === 'true',
        showCustomer: settingsMap['RECEIPT_SHOW_CUSTOMER'] === 'true',
        paperWidth: settingsMap['RECEIPT_PAPER_WIDTH'] || '80mm',
      },
    };
  }
}
