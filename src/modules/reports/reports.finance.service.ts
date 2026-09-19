import { dbService } from '../../database/db';
import { ReportsSchema } from './reports.schema';
import { BillScope, Granularity, ReportQuery, ReportRange } from './reports.query';

export interface FinanceReportOptions extends BillScope {
  range: ReportRange;
  granularity?: Granularity;
}

export interface ExpenseReportOptions {
  range: ReportRange;
  category?: string;
  paymentMethod?: string;
  vendorId?: number;
  /** Include expenses not yet paid. Off by default: profit is cash-realised spend. */
  includePending?: boolean;
}

/**
 * Finance reporting: revenue, what was deducted from it, and what is left.
 *
 * The vocabulary is fixed across every report here so the numbers reconcile:
 *
 * - **gross sales** — `bills.subtotal`, the menu value of what was sold.
 * - **net sales** — `bills.total_amount`, what the customer actually owed
 *   after discounts, tax and charges.
 * - **refunds** — money returned, from the `refunds` ledger.
 * - **net revenue** — net sales less refunds. This is the top line of the
 *   profit report and the only figure that should be compared to expenses.
 *
 * Voided bills are excluded throughout; a void never became revenue.
 */
export class ReportsFinanceService {
  /** Revenue: the full bill-to-net waterfall, plus a bucketed series. */
  static async revenue(options: FinanceReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const { where, params } = ReportQuery.bills('b', options.range, options);
    const bucket = ReportQuery.bucket('b', granularity);

    const totalsSql = `
      SELECT
        COUNT(b.id)                                   AS bills_count,
        COALESCE(SUM(b.subtotal), 0)                  AS gross_sales,
        COALESCE(SUM(b.discount_amount), 0)           AS bill_discount,
        COALESCE(SUM(b.coupon_discount), 0)           AS coupon_discount,
        COALESCE(SUM(b.tax_amount), 0)                AS tax_amount,
        COALESCE(SUM(b.service_charge_amount), 0)     AS service_charges,
        COALESCE(SUM(b.surcharge_amount), 0)          AS surcharges,
        COALESCE(SUM(b.total_amount), 0)              AS net_sales,
        COALESCE(AVG(b.total_amount), 0)              AS avg_bill_value,
        COUNT(DISTINCT b.customer_id)                 AS distinct_customers,
        COUNT(DISTINCT DATE(b.created_at))            AS trading_days
      FROM bills b
      ${where}`;

    const previousRange = ReportQuery.previousRange(options.range);
    const previousScope = ReportQuery.bills('b', previousRange, options);

    const [current, previous, refunds, previousRefunds, seriesRows] = await Promise.all([
      dbService.queryOne(totalsSql, params),
      dbService.queryOne(totalsSql, previousScope.params),
      this.refundTotal(options.range),
      this.refundTotal(previousRange),
      dbService.query(
        `SELECT
           ${bucket.label}                            AS period,
           ${bucket.start}                            AS period_start,
           COUNT(b.id)                                AS bills_count,
           COALESCE(SUM(b.subtotal), 0)               AS gross_sales,
           COALESCE(SUM(b.discount_amount + b.coupon_discount), 0) AS discount_amount,
           COALESCE(SUM(b.tax_amount), 0)             AS tax_amount,
           COALESCE(SUM(b.service_charge_amount + b.surcharge_amount), 0) AS charges,
           COALESCE(SUM(b.total_amount), 0)           AS net_sales
         FROM bills b
         ${where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        params
      ),
    ]);

    const n = (row: any, key: string) => ReportQuery.round(ReportQuery.num(row?.[key]));
    const netSales = n(current, 'net_sales');
    const prevNetSales = n(previous, 'net_sales');
    const netRevenue = ReportQuery.round(netSales - refunds);
    const prevNetRevenue = ReportQuery.round(prevNetSales - previousRefunds);

    return {
      range: options.range,
      comparisonRange: previousRange,
      granularity,
      waterfall: {
        gross_sales: n(current, 'gross_sales'),
        bill_discount: n(current, 'bill_discount'),
        coupon_discount: n(current, 'coupon_discount'),
        total_discount: ReportQuery.round(n(current, 'bill_discount') + n(current, 'coupon_discount')),
        tax_amount: n(current, 'tax_amount'),
        service_charges: n(current, 'service_charges'),
        surcharges: n(current, 'surcharges'),
        net_sales: netSales,
        refunds,
        net_revenue: netRevenue,
      },
      summary: {
        bills_count: Number(current?.bills_count ?? 0),
        trading_days: Number(current?.trading_days ?? 0),
        distinct_customers: Number(current?.distinct_customers ?? 0),
        avg_bill_value: n(current, 'avg_bill_value'),
        avg_revenue_per_day: ReportQuery.round(
          Number(current?.trading_days ?? 0) ? netRevenue / Number(current?.trading_days) : 0
        ),
        effective_discount_percent: ReportQuery.share(
          n(current, 'bill_discount') + n(current, 'coupon_discount'),
          n(current, 'gross_sales')
        ),
        refund_rate_percent: ReportQuery.share(refunds, netSales),
      },
      comparison: {
        net_revenue: { current: netRevenue, previous: prevNetRevenue, growth_percent: ReportQuery.growth(netRevenue, prevNetRevenue) },
        net_sales: { current: netSales, previous: prevNetSales, growth_percent: ReportQuery.growth(netSales, prevNetSales) },
        bills: {
          current: Number(current?.bills_count ?? 0),
          previous: Number(previous?.bills_count ?? 0),
          growth_percent: ReportQuery.growth(Number(current?.bills_count ?? 0), Number(previous?.bills_count ?? 0)),
        },
        avg_bill_value: {
          current: n(current, 'avg_bill_value'),
          previous: n(previous, 'avg_bill_value'),
          growth_percent: ReportQuery.growth(n(current, 'avg_bill_value'), n(previous, 'avg_bill_value')),
        },
      },
      series: ReportQuery.numbers(seriesRows, [
        'bills_count',
        'gross_sales',
        'discount_amount',
        'tax_amount',
        'charges',
        'net_sales',
      ]),
    };
  }

  /**
   * Tax collected, broken down by the rate it was charged at.
   *
   * The rate comes from `products.tax_rate` (the current rate on the product),
   * not from the bill line, which stores only the resulting amount. A rate
   * changed after a sale therefore re-buckets that sale's history.
   */
  static async tax(options: FinanceReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const { where, params } = ReportQuery.bills('b', options.range, options);
    const bucket = ReportQuery.bucket('b', granularity);

    const [totals, byRate, byOrderType, series] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.subtotal - b.discount_amount), 0) AS taxable_value,
           COALESCE(SUM(b.tax_amount), 0)         AS tax_collected,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales
         FROM bills b
         ${where}`,
        params
      ),
      dbService.query(
        `SELECT
           COALESCE(p.tax_rate, 0)                AS tax_rate,
           COUNT(DISTINCT bi.bill_id)             AS bills_count,
           COALESCE(SUM(bi.quantity), 0)          AS quantity_sold,
           COALESCE(SUM(bi.subtotal - bi.discount_amount), 0) AS taxable_value,
           COALESCE(SUM(bi.tax_amount), 0)        AS tax_collected
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         ${where}
         GROUP BY p.tax_rate
         ORDER BY tax_rate ASC`,
        params
      ),
      dbService.query(
        `SELECT
           b.order_type,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.tax_amount), 0)         AS tax_collected,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales
         FROM bills b
         ${where}
         GROUP BY b.order_type
         ORDER BY tax_collected DESC`,
        params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.subtotal - b.discount_amount), 0) AS taxable_value,
           COALESCE(SUM(b.tax_amount), 0)         AS tax_collected
         FROM bills b
         ${where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        params
      ),
    ]);

    const taxCollected = ReportQuery.round(ReportQuery.num(totals?.tax_collected));
    const taxableValue = ReportQuery.round(ReportQuery.num(totals?.taxable_value));

    return {
      range: options.range,
      granularity,
      summary: {
        bills_count: Number(totals?.bills_count ?? 0),
        taxable_value: taxableValue,
        tax_collected: taxCollected,
        net_sales: ReportQuery.round(ReportQuery.num(totals?.net_sales)),
        effective_tax_percent: ReportQuery.share(taxCollected, taxableValue),
      },
      byRate: ReportQuery.numbers(byRate, [
        'tax_rate',
        'bills_count',
        'quantity_sold',
        'taxable_value',
        'tax_collected',
      ]).map((row) => ({
        ...row,
        tax_share_percent: ReportQuery.share(row.tax_collected, taxCollected),
      })),
      byOrderType: ReportQuery.numbers(byOrderType, ['bills_count', 'tax_collected', 'net_sales']),
      series: ReportQuery.numbers(series, ['bills_count', 'taxable_value', 'tax_collected']),
    };
  }

  /**
   * Discounts given away: bill-level, coupon, line-level and complimentary.
   *
   * Complimentary items are counted at menu value, because a free dish costs
   * the business its selling price in forgone revenue even though it never
   * appeared as a discount line.
   */
  static async discounts(options: FinanceReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const { where, params } = ReportQuery.bills('b', options.range, options);
    const bucket = ReportQuery.bucket('b', granularity);

    const [totals, itemTotals, byCashier, byCoupon, byProduct, series] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.subtotal), 0)           AS gross_sales,
           COALESCE(SUM(b.discount_amount), 0)    AS bill_discount,
           COALESCE(SUM(b.coupon_discount), 0)    AS coupon_discount,
           COALESCE(SUM(CASE WHEN b.discount_amount + b.coupon_discount > 0 THEN 1 ELSE 0 END), 0) AS discounted_bills
         FROM bills b
         ${where}`,
        params
      ),
      dbService.queryOne(
        `SELECT
           COALESCE(SUM(bi.discount_amount), 0)   AS item_discount,
           COALESCE(SUM(CASE WHEN bi.is_complimentary = 1 THEN bi.quantity ELSE 0 END), 0) AS complimentary_items,
           COALESCE(SUM(CASE WHEN bi.is_complimentary = 1 THEN bi.quantity * bi.unit_price ELSE 0 END), 0) AS complimentary_value
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         ${where}`,
        params
      ),
      dbService.query(
        `SELECT
           u.id                                   AS user_id,
           u.name                                 AS employee_name,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.discount_amount + b.coupon_discount), 0) AS discount_given,
           COALESCE(SUM(b.subtotal), 0)           AS gross_sales,
           COALESCE(SUM(CASE WHEN b.discount_amount + b.coupon_discount > 0 THEN 1 ELSE 0 END), 0) AS discounted_bills
         FROM bills b
         JOIN users u ON b.cashier_id = u.id
         ${where}
         GROUP BY u.id, u.name
         HAVING discount_given > 0
         ORDER BY discount_given DESC`,
        params
      ),
      dbService.query(
        `SELECT
           b.coupon_code,
           COUNT(b.id)                            AS times_used,
           COALESCE(SUM(b.coupon_discount), 0)    AS discount_given,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales
         FROM bills b
         ${where} AND b.coupon_code IS NOT NULL AND b.coupon_code <> ''
         GROUP BY b.coupon_code
         ORDER BY discount_given DESC`,
        params
      ),
      dbService.query(
        `SELECT
           p.id                                   AS product_id,
           p.name                                 AS product_name,
           COALESCE(SUM(bi.discount_amount), 0)   AS item_discount,
           COALESCE(SUM(CASE WHEN bi.is_complimentary = 1 THEN bi.quantity ELSE 0 END), 0) AS complimentary_items,
           COALESCE(SUM(bi.quantity), 0)          AS quantity_sold
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         ${where}
         GROUP BY p.id, p.name
         HAVING item_discount > 0 OR complimentary_items > 0
         ORDER BY item_discount DESC
         LIMIT 50`,
        params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.subtotal), 0)           AS gross_sales,
           COALESCE(SUM(b.discount_amount + b.coupon_discount), 0) AS discount_given
         FROM bills b
         ${where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        params
      ),
    ]);

    const grossSales = ReportQuery.round(ReportQuery.num(totals?.gross_sales));
    const billDiscount = ReportQuery.round(ReportQuery.num(totals?.bill_discount));
    const couponDiscount = ReportQuery.round(ReportQuery.num(totals?.coupon_discount));
    const itemDiscount = ReportQuery.round(ReportQuery.num(itemTotals?.item_discount));
    const complimentaryValue = ReportQuery.round(ReportQuery.num(itemTotals?.complimentary_value));
    const billsCount = Number(totals?.bills_count ?? 0);
    const discountedBills = Number(totals?.discounted_bills ?? 0);

    return {
      range: options.range,
      granularity,
      summary: {
        bills_count: billsCount,
        discounted_bills: discountedBills,
        discounted_bills_percent: ReportQuery.share(discountedBills, billsCount),
        gross_sales: grossSales,
        bill_discount: billDiscount,
        coupon_discount: couponDiscount,
        item_discount: itemDiscount,
        total_discount: ReportQuery.round(billDiscount + couponDiscount),
        complimentary_items: ReportQuery.round(ReportQuery.num(itemTotals?.complimentary_items)),
        complimentary_value: complimentaryValue,
        total_giveaway: ReportQuery.round(billDiscount + couponDiscount + complimentaryValue),
        discount_percent_of_gross: ReportQuery.share(billDiscount + couponDiscount, grossSales),
        avg_discount_per_discounted_bill: ReportQuery.round(
          discountedBills ? (billDiscount + couponDiscount) / discountedBills : 0
        ),
      },
      byCashier: ReportQuery.numbers(byCashier, [
        'bills_count',
        'discount_given',
        'gross_sales',
        'discounted_bills',
      ]).map((row) => ({
        ...row,
        discount_percent_of_gross: ReportQuery.share(row.discount_given, row.gross_sales),
      })),
      byCoupon: ReportQuery.numbers(byCoupon, ['times_used', 'discount_given', 'net_sales']),
      byProduct: ReportQuery.numbers(byProduct, ['item_discount', 'complimentary_items', 'quantity_sold']),
      series: ReportQuery.numbers(series, ['bills_count', 'gross_sales', 'discount_given']),
    };
  }

  /** Refunds issued, by reason, method, product and period. */
  static async refunds(options: FinanceReportOptions & { status?: string; reasonCode?: string }) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const bucket = ReportQuery.bucket('rf', granularity);

    const { where, params } = ReportQuery.dateRange('rf', options.range);
    let scoped = where;
    const args = [...params];

    // Cancelled refunds are excluded by default: the money never left the till.
    if (options.status) {
      scoped += ' AND rf.status = ?';
      args.push(options.status);
    } else {
      scoped += " AND rf.status <> 'CANCELLED'";
    }
    if (options.reasonCode) {
      scoped += ' AND rf.reason_code = ?';
      args.push(options.reasonCode);
    }

    const salesScope = ReportQuery.bills('b', options.range, options);

    const [totals, byReason, byMethod, byProduct, byCashier, series, sales] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(rf.id)                           AS refunds_count,
           COALESCE(SUM(rf.subtotal), 0)          AS subtotal,
           COALESCE(SUM(rf.tax_amount), 0)        AS tax_amount,
           COALESCE(SUM(rf.total_amount), 0)      AS total_refunded,
           COALESCE(AVG(rf.total_amount), 0)      AS avg_refund_value,
           COALESCE(SUM(CASE WHEN rf.refund_type = 'FULL' THEN 1 ELSE 0 END), 0)    AS full_refunds,
           COALESCE(SUM(CASE WHEN rf.refund_type = 'PARTIAL' THEN 1 ELSE 0 END), 0) AS partial_refunds,
           COUNT(DISTINCT rf.bill_id)             AS bills_affected,
           COUNT(DISTINCT rf.customer_id)         AS customers_affected
         FROM refunds rf
         ${scoped}`,
        args
      ),
      dbService.query(
        `SELECT
           rf.reason_code,
           COUNT(rf.id)                           AS refunds_count,
           COALESCE(SUM(rf.total_amount), 0)      AS total_refunded
         FROM refunds rf
         ${scoped}
         GROUP BY rf.reason_code
         ORDER BY total_refunded DESC`,
        args
      ),
      dbService.query(
        `SELECT
           rf.refund_method,
           COUNT(rf.id)                           AS refunds_count,
           COALESCE(SUM(rf.total_amount), 0)      AS total_refunded
         FROM refunds rf
         ${scoped}
         GROUP BY rf.refund_method
         ORDER BY total_refunded DESC`,
        args
      ),
      dbService.query(
        `SELECT
           ri.product_id,
           ri.product_name,
           COALESCE(SUM(ri.quantity), 0)          AS quantity_refunded,
           COALESCE(SUM(ri.total_amount), 0)      AS total_refunded,
           COUNT(DISTINCT ri.refund_id)           AS refunds_count
         FROM refund_items ri
         JOIN refunds rf ON ri.refund_id = rf.id
         ${scoped}
         GROUP BY ri.product_id, ri.product_name
         ORDER BY total_refunded DESC
         LIMIT 50`,
        args
      ),
      dbService.query(
        `SELECT
           u.id                                   AS user_id,
           u.name                                 AS employee_name,
           COUNT(rf.id)                           AS refunds_count,
           COALESCE(SUM(rf.total_amount), 0)      AS total_refunded
         FROM refunds rf
         JOIN users u ON rf.refunded_by = u.id
         ${scoped}
         GROUP BY u.id, u.name
         ORDER BY total_refunded DESC`,
        args
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(rf.id)                           AS refunds_count,
           COALESCE(SUM(rf.total_amount), 0)      AS total_refunded
         FROM refunds rf
         ${scoped}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        args
      ),
      dbService.queryOne(
        `SELECT COUNT(b.id) AS bills_count, COALESCE(SUM(b.total_amount), 0) AS net_sales
         FROM bills b
         ${salesScope.where}`,
        salesScope.params
      ),
    ]);

    const totalRefunded = ReportQuery.round(ReportQuery.num(totals?.total_refunded));
    const netSales = ReportQuery.round(ReportQuery.num(sales?.net_sales));
    const refundsCount = Number(totals?.refunds_count ?? 0);
    const billsCount = Number(sales?.bills_count ?? 0);

    return {
      range: options.range,
      granularity,
      summary: {
        refunds_count: refundsCount,
        full_refunds: Number(totals?.full_refunds ?? 0),
        partial_refunds: Number(totals?.partial_refunds ?? 0),
        bills_affected: Number(totals?.bills_affected ?? 0),
        customers_affected: Number(totals?.customers_affected ?? 0),
        subtotal: ReportQuery.round(ReportQuery.num(totals?.subtotal)),
        tax_refunded: ReportQuery.round(ReportQuery.num(totals?.tax_amount)),
        total_refunded: totalRefunded,
        avg_refund_value: ReportQuery.round(ReportQuery.num(totals?.avg_refund_value)),
        net_sales: netSales,
        net_revenue: ReportQuery.round(netSales - totalRefunded),
        refund_value_rate_percent: ReportQuery.share(totalRefunded, netSales),
        refund_bill_rate_percent: ReportQuery.share(Number(totals?.bills_affected ?? 0), billsCount),
      },
      byReason: ReportQuery.numbers(byReason, ['refunds_count', 'total_refunded']).map((row) => ({
        ...row,
        share_percent: ReportQuery.share(row.total_refunded, totalRefunded),
      })),
      byMethod: ReportQuery.numbers(byMethod, ['refunds_count', 'total_refunded']).map((row) => ({
        ...row,
        share_percent: ReportQuery.share(row.total_refunded, totalRefunded),
      })),
      byProduct: ReportQuery.numbers(byProduct, ['quantity_refunded', 'total_refunded', 'refunds_count']),
      byCashier: ReportQuery.numbers(byCashier, ['refunds_count', 'total_refunded']),
      series: ReportQuery.numbers(series, ['refunds_count', 'total_refunded']),
    };
  }

  /**
   * Payment methods, read from `payments` rather than `bills.payment_method`.
   *
   * `payments` is the tender ledger: a bill settled across two methods has one
   * row per method, so it is the only source that can report a split payment
   * correctly. The `bills` view is returned alongside it, and a mismatch
   * between the two totals is itself a reconciliation signal.
   */
  static async paymentMethods(options: FinanceReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const { where, params } = ReportQuery.bills('b', options.range, options);
    // Bucketed on the bill's timestamp, not the payment's, so a tender settled
    // just after midnight lands in the trading day it belongs to.
    const bucket = ReportQuery.bucket('b', granularity);

    // Payments inherit the bill's void state, so the join keeps voids out. A
    // FAILED attempt is excluded: nothing was tendered.
    const paymentScope = `
      JOIN bills b ON p.bill_id = b.id
      ${where} AND p.status <> 'FAILED'`;

    const [byMethodPayments, byMethodBills, series, totals] = await Promise.all([
      dbService.query(
        `SELECT
           p.payment_method,
           COUNT(p.id)                            AS transaction_count,
           COALESCE(SUM(p.amount), 0)             AS total_amount,
           COALESCE(AVG(p.amount), 0)             AS avg_amount,
           COUNT(DISTINCT p.bill_id)              AS bills_count,
           COALESCE(SUM(CASE WHEN p.status = 'REFUNDED' THEN p.amount ELSE 0 END), 0) AS refunded_amount
         FROM payments p
         ${paymentScope}
         GROUP BY p.payment_method
         ORDER BY total_amount DESC`,
        params
      ),
      dbService.query(
        `SELECT
           b.payment_method,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.total_amount), 0)       AS total_amount,
           COALESCE(SUM(b.cash_tendered), 0)      AS cash_tendered,
           COALESCE(SUM(b.change_returned), 0)    AS change_returned
         FROM bills b
         ${where}
         GROUP BY b.payment_method
         ORDER BY total_amount DESC`,
        params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           p.payment_method,
           COUNT(p.id)                            AS transaction_count,
           COALESCE(SUM(p.amount), 0)             AS total_amount
         FROM payments p
         ${paymentScope}
         GROUP BY period, period_start, p.payment_method
         ORDER BY period_start ASC, total_amount DESC`,
        params
      ),
      dbService.queryOne(
        `SELECT
           COUNT(p.id)                            AS transaction_count,
           COALESCE(SUM(p.amount), 0)             AS total_amount
         FROM payments p
         ${paymentScope}`,
        params
      ),
    ]);

    const totalTendered = ReportQuery.round(ReportQuery.num(totals?.total_amount));
    const methods = ReportQuery.numbers(byMethodPayments, [
      'transaction_count',
      'total_amount',
      'avg_amount',
      'bills_count',
      'refunded_amount',
    ]).map((row) => ({
      ...row,
      share_percent: ReportQuery.share(row.total_amount, totalTendered),
    }));

    const billsView = ReportQuery.numbers(byMethodBills, [
      'bills_count',
      'total_amount',
      'cash_tendered',
      'change_returned',
    ]);
    const billsTotal = billsView.reduce((s, r) => s + r.total_amount, 0);
    const cash = methods.find((m) => String(m.payment_method).toUpperCase() === 'CASH');

    return {
      range: options.range,
      granularity,
      summary: {
        transaction_count: Number(totals?.transaction_count ?? 0),
        total_tendered: totalTendered,
        methods_used: methods.length,
        cash_amount: cash?.total_amount ?? 0,
        cash_share_percent: ReportQuery.share(cash?.total_amount ?? 0, totalTendered),
        non_cash_amount: ReportQuery.round(totalTendered - (cash?.total_amount ?? 0)),
        billed_total: ReportQuery.round(billsTotal),
        unreconciled_difference: ReportQuery.round(billsTotal - totalTendered),
      },
      byMethod: methods,
      byMethodFromBills: billsView,
      series: ReportQuery.numbers(series, ['transaction_count', 'total_amount']),
    };
  }

  /** Operating expenses by category, vendor, method and period. */
  static async expenses(options: ExpenseReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.dateRange('e', options.range, 'expense_date');

    let scoped = where;
    const args = [...params];
    if (!options.includePending) {
      scoped += " AND e.payment_status = 'PAID'";
    } else {
      scoped += " AND e.payment_status <> 'CANCELLED'";
    }
    if (options.category) {
      scoped += ' AND e.category = ?';
      args.push(options.category);
    }
    if (options.paymentMethod) {
      scoped += ' AND e.payment_method = ?';
      args.push(options.paymentMethod);
    }
    if (options.vendorId) {
      scoped += ' AND e.vendor_id = ?';
      args.push(options.vendorId);
    }

    const [totals, byCategory, byMethod, byVendor, series, fixedSplit] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(e.id)                            AS expenses_count,
           COALESCE(SUM(e.amount), 0)             AS net_amount,
           COALESCE(SUM(e.tax_amount), 0)         AS tax_amount,
           COALESCE(SUM(e.total_amount), 0)       AS total_amount,
           COALESCE(AVG(e.total_amount), 0)       AS avg_expense_value,
           COUNT(DISTINCT e.category)             AS categories_used,
           COALESCE(SUM(CASE WHEN e.payment_status = 'PENDING' THEN e.total_amount ELSE 0 END), 0) AS pending_amount
         FROM expenses e
         ${scoped}`,
        args
      ),
      dbService.query(
        `SELECT
           e.category,
           COUNT(e.id)                            AS expenses_count,
           COALESCE(SUM(e.total_amount), 0)       AS total_amount,
           COALESCE(AVG(e.total_amount), 0)       AS avg_expense_value,
           MAX(e.expense_date)                    AS last_expense_date
         FROM expenses e
         ${scoped}
         GROUP BY e.category
         ORDER BY total_amount DESC`,
        args
      ),
      dbService.query(
        `SELECT
           e.payment_method,
           COUNT(e.id)                            AS expenses_count,
           COALESCE(SUM(e.total_amount), 0)       AS total_amount
         FROM expenses e
         ${scoped}
         GROUP BY e.payment_method
         ORDER BY total_amount DESC`,
        args
      ),
      dbService.query(
        `SELECT
           e.vendor_id,
           COALESCE(e.vendor_name, 'Unattributed') AS vendor_name,
           COUNT(e.id)                            AS expenses_count,
           COALESCE(SUM(e.total_amount), 0)       AS total_amount
         FROM expenses e
         ${scoped}
         GROUP BY e.vendor_id, e.vendor_name
         ORDER BY total_amount DESC
         LIMIT 50`,
        args
      ),
      dbService.query(
        `SELECT
           DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS period,
           DATE(e.expense_date)                    AS period_start,
           COUNT(e.id)                             AS expenses_count,
           COALESCE(SUM(e.total_amount), 0)        AS total_amount
         FROM expenses e
         ${scoped}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        args
      ),
      dbService.query(
        `SELECT
           CASE WHEN COALESCE(ec.is_fixed_cost, 0) = 1 THEN 'FIXED' ELSE 'VARIABLE' END AS cost_type,
           COUNT(e.id)                            AS expenses_count,
           COALESCE(SUM(e.total_amount), 0)       AS total_amount
         FROM expenses e
         LEFT JOIN expense_categories ec ON ec.name = e.category
         ${scoped}
         GROUP BY cost_type`,
        args
      ),
    ]);

    const totalAmount = ReportQuery.round(ReportQuery.num(totals?.total_amount));

    return {
      range: options.range,
      summary: {
        expenses_count: Number(totals?.expenses_count ?? 0),
        categories_used: Number(totals?.categories_used ?? 0),
        net_amount: ReportQuery.round(ReportQuery.num(totals?.net_amount)),
        tax_amount: ReportQuery.round(ReportQuery.num(totals?.tax_amount)),
        total_amount: totalAmount,
        avg_expense_value: ReportQuery.round(ReportQuery.num(totals?.avg_expense_value)),
        pending_amount: ReportQuery.round(ReportQuery.num(totals?.pending_amount)),
        avg_per_day: ReportQuery.round(options.range.days ? totalAmount / options.range.days : 0),
      },
      byCategory: ReportQuery.numbers(byCategory, ['expenses_count', 'total_amount', 'avg_expense_value']).map(
        (row) => ({ ...row, share_percent: ReportQuery.share(row.total_amount, totalAmount) })
      ),
      byMethod: ReportQuery.numbers(byMethod, ['expenses_count', 'total_amount']),
      byVendor: ReportQuery.numbers(byVendor, ['expenses_count', 'total_amount']),
      byCostType: ReportQuery.numbers(fixedSplit, ['expenses_count', 'total_amount']).map((row) => ({
        ...row,
        share_percent: ReportQuery.share(row.total_amount, totalAmount),
      })),
      series: ReportQuery.numbers(series, ['expenses_count', 'total_amount']),
    };
  }

  /**
   * Profit: net revenue less cost of goods sold less operating expenses.
   *
   * COGS is `quantity x products.cost_price` over the billed lines. Because
   * `bill_items` stores no cost, this is the product's cost *today* — good
   * enough to steer pricing, not an audited cost of sales. The caveat is
   * returned on the payload as `cogs_basis` so a consumer can label it.
   */
  static async profit(options: FinanceReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'month';
    const { where, params } = ReportQuery.bills('b', options.range, options);
    const bucket = ReportQuery.bucket('b', granularity);
    const previousRange = ReportQuery.previousRange(options.range);

    const cogsSql = (clause: string) => `
      SELECT COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
      FROM bill_items bi
      JOIN bills b ON bi.bill_id = b.id
      JOIN products p ON bi.product_id = p.id
      ${clause}`;

    const previousScope = ReportQuery.bills('b', previousRange, options);

    const [sales, prevSales, cogsRow, prevCogsRow, expenseTotals, prevExpenseTotals, refunds, prevRefunds, salesSeries, cogsSeries, expenseSeries] =
      await Promise.all([
        dbService.queryOne(
          `SELECT COUNT(b.id) AS bills_count,
                  COALESCE(SUM(b.subtotal), 0) AS gross_sales,
                  COALESCE(SUM(b.tax_amount), 0) AS tax_amount,
                  COALESCE(SUM(b.total_amount), 0) AS net_sales
           FROM bills b ${where}`,
          params
        ),
        dbService.queryOne(
          `SELECT COALESCE(SUM(b.total_amount), 0) AS net_sales FROM bills b ${previousScope.where}`,
          previousScope.params
        ),
        dbService.queryOne(cogsSql(where), params),
        dbService.queryOne(cogsSql(previousScope.where), previousScope.params),
        this.expenseTotal(options.range),
        this.expenseTotal(previousRange),
        this.refundTotal(options.range),
        this.refundTotal(previousRange),
        dbService.query(
          `SELECT ${bucket.label} AS period,
                  ${bucket.start} AS period_start,
                  COUNT(b.id) AS bills_count,
                  COALESCE(SUM(b.tax_amount), 0) AS tax_amount,
                  COALESCE(SUM(b.total_amount), 0) AS net_sales
           FROM bills b ${where}
           GROUP BY period, period_start
           ORDER BY period_start ASC`,
          params
        ),
        dbService.query(
          `SELECT ${bucket.label} AS period,
                  COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
           FROM bill_items bi
           JOIN bills b ON bi.bill_id = b.id
           JOIN products p ON bi.product_id = p.id
           ${where}
           GROUP BY period`,
          params
        ),
        dbService.query(
          `SELECT ${ReportQuery.bucket('e', granularity, 'expense_date').label} AS period,
                  COALESCE(SUM(e.total_amount), 0) AS expenses
           FROM expenses e
           ${ReportQuery.dateRange('e', options.range, 'expense_date').where}
             AND e.payment_status = 'PAID'
           GROUP BY period`,
          ReportQuery.dateRange('e', options.range, 'expense_date').params
        ),
      ]);

    const netSales = ReportQuery.round(ReportQuery.num(sales?.net_sales));
    const netRevenue = ReportQuery.round(netSales - refunds);
    const cogs = ReportQuery.round(ReportQuery.num(cogsRow?.cogs));
    const grossProfit = ReportQuery.round(netRevenue - cogs);
    const netProfit = ReportQuery.round(grossProfit - expenseTotals);

    const prevNetRevenue = ReportQuery.round(ReportQuery.num(prevSales?.net_sales) - prevRefunds);
    const prevCogs = ReportQuery.round(ReportQuery.num(prevCogsRow?.cogs));
    const prevGrossProfit = ReportQuery.round(prevNetRevenue - prevCogs);
    const prevNetProfit = ReportQuery.round(prevGrossProfit - prevExpenseTotals);

    const cogsByPeriod = new Map<string, number>(
      cogsSeries.map((row: any) => [String(row.period), ReportQuery.num(row.cogs)])
    );
    const expensesByPeriod = new Map<string, number>(
      expenseSeries.map((row: any) => [String(row.period), ReportQuery.num(row.expenses)])
    );

    const series = ReportQuery.numbers(salesSeries, ['bills_count', 'tax_amount', 'net_sales']).map((row) => {
      const periodCogs = ReportQuery.round(cogsByPeriod.get(String(row.period)) ?? 0);
      const periodExpenses = ReportQuery.round(expensesByPeriod.get(String(row.period)) ?? 0);
      const periodGross = ReportQuery.round(row.net_sales - periodCogs);
      return {
        ...row,
        cogs: periodCogs,
        gross_profit: periodGross,
        expenses: periodExpenses,
        net_profit: ReportQuery.round(periodGross - periodExpenses),
        gross_margin_percent: ReportQuery.share(periodGross, row.net_sales),
      };
    });

    return {
      range: options.range,
      comparisonRange: previousRange,
      granularity,
      cogs_basis: 'products.cost_price at report time; bill lines do not store historical cost',
      summary: {
        gross_sales: ReportQuery.round(ReportQuery.num(sales?.gross_sales)),
        net_sales: netSales,
        refunds,
        net_revenue: netRevenue,
        cogs,
        gross_profit: grossProfit,
        operating_expenses: expenseTotals,
        net_profit: netProfit,
        tax_collected: ReportQuery.round(ReportQuery.num(sales?.tax_amount)),
        bills_count: Number(sales?.bills_count ?? 0),
        gross_margin_percent: ReportQuery.share(grossProfit, netRevenue),
        net_margin_percent: ReportQuery.share(netProfit, netRevenue),
        cogs_percent_of_revenue: ReportQuery.share(cogs, netRevenue),
        expense_percent_of_revenue: ReportQuery.share(expenseTotals, netRevenue),
        /** Revenue at which gross margin would exactly cover expenses. */
        break_even_revenue: ReportQuery.round(
          grossProfit > 0 && netRevenue > 0 ? expenseTotals / (grossProfit / netRevenue) : 0
        ),
      },
      comparison: {
        net_revenue: { current: netRevenue, previous: prevNetRevenue, growth_percent: ReportQuery.growth(netRevenue, prevNetRevenue) },
        gross_profit: { current: grossProfit, previous: prevGrossProfit, growth_percent: ReportQuery.growth(grossProfit, prevGrossProfit) },
        net_profit: { current: netProfit, previous: prevNetProfit, growth_percent: ReportQuery.growth(netProfit, prevNetProfit) },
        operating_expenses: {
          current: expenseTotals,
          previous: prevExpenseTotals,
          growth_percent: ReportQuery.growth(expenseTotals, prevExpenseTotals),
        },
      },
      series,
    };
  }

  /** Completed refund value in a range, shared by revenue and profit. */
  private static async refundTotal(range: ReportRange): Promise<number> {
    const { where, params } = ReportQuery.dateRange('rf', range);
    const row = await dbService.queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(rf.total_amount), 0) AS total
       FROM refunds rf
       ${where} AND rf.status = 'COMPLETED'`,
      params
    );
    return ReportQuery.round(ReportQuery.num(row?.total));
  }

  /** Paid operating expense value in a range. */
  private static async expenseTotal(range: ReportRange): Promise<number> {
    const { where, params } = ReportQuery.dateRange('e', range, 'expense_date');
    const row = await dbService.queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(e.total_amount), 0) AS total
       FROM expenses e
       ${where} AND e.payment_status = 'PAID'`,
      params
    );
    return ReportQuery.round(ReportQuery.num(row?.total));
  }
}
