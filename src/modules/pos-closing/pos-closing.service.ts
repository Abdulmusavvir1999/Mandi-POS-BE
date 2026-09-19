import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { CheckoutService } from '../checkout/checkout.service';

export interface CreateDayClosingPayload {
  openingCash: number;
  actualCash: number;
  notes?: string;
}

export class PosClosingService {
  /**
   * Calculates the current open shift's sales, payment splits, voids, and expected cash.
   */
  static async getCurrentShiftSummary(userId: number) {
    await CheckoutService.ensureSchema();

    // Find the last closing timestamp
    const lastClose = await dbService.queryOne<{ closing_time: string }>(
      'SELECT closing_time FROM pos_day_closings ORDER BY closing_time DESC LIMIT 1'
    );

    const startTime = lastClose?.closing_time || new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

    const stats = await dbService.queryOne<{
      total_bills: number;
      gross_sales: number;
      cash_sales: number;
      card_sales: number;
      upi_sales: number;
      online_sales: number;
      total_discounts: number;
      total_tax: number;
      total_service_charges: number;
      void_bills_count: number;
      void_bills_amount: number;
    }>(`
      SELECT COUNT(*) as total_bills,
             COALESCE(SUM(CASE WHEN is_voided = 0 THEN total_amount ELSE 0 END), 0) as gross_sales,
             COALESCE(SUM(CASE WHEN is_voided = 0 AND payment_method = 'CASH' THEN total_amount ELSE 0 END), 0) as cash_sales,
             COALESCE(SUM(CASE WHEN is_voided = 0 AND payment_method = 'CARD' THEN total_amount ELSE 0 END), 0) as card_sales,
             COALESCE(SUM(CASE WHEN is_voided = 0 AND payment_method = 'UPI' THEN total_amount ELSE 0 END), 0) as upi_sales,
             COALESCE(SUM(CASE WHEN is_voided = 0 AND payment_method = 'ONLINE' THEN total_amount ELSE 0 END), 0) as online_sales,
             COALESCE(SUM(CASE WHEN is_voided = 0 THEN (discount_amount + coupon_discount) ELSE 0 END), 0) as total_discounts,
             COALESCE(SUM(CASE WHEN is_voided = 0 THEN tax_amount ELSE 0 END), 0) as total_tax,
             COALESCE(SUM(CASE WHEN is_voided = 0 THEN service_charge_amount ELSE 0 END), 0) as total_service_charges,
             COALESCE(SUM(CASE WHEN is_voided = 1 THEN 1 ELSE 0 END), 0) as void_bills_count,
             COALESCE(SUM(CASE WHEN is_voided = 1 THEN total_amount ELSE 0 END), 0) as void_bills_amount
      FROM bills
      WHERE created_at >= ?
    `, [startTime]);

    const user = await dbService.queryOne<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);

    return {
      startTime,
      currentTime: new Date().toISOString(),
      cashierName: user?.name || 'Staff',
      totalBills: Number(stats?.total_bills || 0),
      grossSales: Number(stats?.gross_sales || 0),
      cashSales: Number(stats?.cash_sales || 0),
      cardSales: Number(stats?.card_sales || 0),
      upiSales: Number(stats?.upi_sales || 0),
      onlineSales: Number(stats?.online_sales || 0),
      totalDiscounts: Number(stats?.total_discounts || 0),
      totalTax: Number(stats?.total_tax || 0),
      totalServiceCharges: Number(stats?.total_service_charges || 0),
      voidBillsCount: Number(stats?.void_bills_count || 0),
      voidBillsAmount: Number(stats?.void_bills_amount || 0),
    };
  }

  /**
   * Finalizes the shift / day closing record and outputs the Z-Report payload.
   */
  static async createDayClosing(payload: CreateDayClosingPayload, userId: number) {
    await CheckoutService.ensureSchema();

    const summary = await this.getCurrentShiftSummary(userId);

    const openingCash = Math.max(0, Number(payload.openingCash) || 0);
    const actualCash = Math.max(0, Number(payload.actualCash) || 0);
    const expectedCash = openingCash + summary.cashSales;
    const variance = actualCash - expectedCash;

    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const countToday = await dbService.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM pos_day_closings WHERE DATE(created_at) = CURDATE()'
    );
    const nextSeq = ((countToday?.count || 0) + 1).toString().padStart(3, '0');
    const closingNumber = `Z-${datePart}-${nextSeq}`;

    const res = await dbService.execute(`
      INSERT INTO pos_day_closings (
        closing_number, user_id, cashier_name, opening_time, closing_time,
        opening_cash, total_cash_sales, total_card_sales, total_upi_sales,
        total_online_sales, gross_sales, total_discounts, total_tax,
        total_service_charges, total_bills_count, void_bills_count, void_bills_amount,
        expected_cash, actual_cash, cash_variance, notes
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      closingNumber,
      userId,
      summary.cashierName,
      summary.startTime,
      openingCash,
      summary.cashSales,
      summary.cardSales,
      summary.upiSales,
      summary.onlineSales,
      summary.grossSales,
      summary.totalDiscounts,
      summary.totalTax,
      summary.totalServiceCharges,
      summary.totalBills,
      summary.voidBillsCount,
      summary.voidBillsAmount,
      expectedCash,
      actualCash,
      variance,
      payload.notes || null,
    ]);

    const closingId = res.lastInsertRowid;

    await AuditService.log({
      userId,
      action: 'POS_DAY_CLOSED',
      module: 'POS_CLOSING',
      recordId: closingId,
      newValues: {
        closingNumber,
        expectedCash,
        actualCash,
        variance,
      },
    });

    return await this.getDayClosingById(closingId);
  }

  static async getDayClosingById(id: number) {
    const record = await dbService.queryOne<any>('SELECT * FROM pos_day_closings WHERE id = ?', [id]);
    if (!record) {
      throw AppError.notFound('Day closing record not found');
    }

    const settingsRows = await dbService.query<{ key: string; value: string }>('SELECT `key`, `value` FROM settings');
    const settingsMap: Record<string, string> = {};
    for (const r of settingsRows) {
      settingsMap[r.key] = r.value;
    }
    SettingsService.applyKeyAliases(settingsMap);

    return {
      closing: record,
      receiptSettings: {
        businessName: settingsMap['BUSINESS_NAME'] || settingsMap['restaurant_name'] || 'Mandi Restaurant',
        address: settingsMap['BUSINESS_ADDRESS'] || '',
        phone: settingsMap['BUSINESS_PHONE'] || '',
        gstin: settingsMap['BUSINESS_GSTIN'] || '',
        currencySymbol: settingsMap['CURRENCY_SYMBOL'] || '₹',
      },
    };
  }

  static async getHistory(page = 1, limit = 20) {
    await CheckoutService.ensureSchema();
    const offset = (page - 1) * limit;

    const countRes = await dbService.queryOne<{ total: number }>('SELECT COUNT(*) as total FROM pos_day_closings');
    const total = countRes?.total || 0;

    const closings = await dbService.query(
      'SELECT * FROM pos_day_closings ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );

    return {
      data: closings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}
