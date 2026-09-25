import { dbService } from '../database/db';
import { ReportsSchema } from '../database/reports.schema';
import { BillScope, Granularity, ReportQuery, ReportRange } from '../utils/reports.query';

export interface SalesReportOptions extends BillScope {
  range: ReportRange;
  categoryId?: number;
  limit?: number;
  /**
   * `variant` splits each dish into its portion sizes (Full / Half / ...).
   * Ignored on databases without `bill_items.variant_id`.
   */
  groupBy?: 'product' | 'variant';
}

/**
 * Sales reporting: what sold, to whom, through whom and when.
 *
 * All figures come from `bills` / `bill_items` rather than `orders`, because a
 * bill is the settled record — an order can be cancelled or re-rung and would
 * double-count. Voided bills are excluded by `ReportQuery.bills`.
 *
 * Cost and margin use `products.cost_price`, which is the product's *current*
 * cost, not the cost at the time of sale (`bill_items` carries no cost column).
 * Margin figures are therefore indicative: restating a product's cost price
 * retroactively shifts the margin on its history.
 */
export class ReportsSalesService {
  /** Sales by product (optionally by portion variant), with margin and share of revenue. */
  static async byProduct(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const caps = await ReportsSchema.capabilities();
    const byVariant = options.groupBy === 'variant' && caps.billItemVariants;
    const { where, params } = ReportQuery.bills('b', options.range, options);

    let filtered = where;
    const args = [...params];
    if (options.categoryId) {
      filtered += ' AND p.category_id = ?';
      args.push(options.categoryId);
    }

    const variantSelect = byVariant
      ? `bi.variant_id AS variant_id, COALESCE(bi.variant_name, 'Standard') AS variant_name,`
      : '';
    const variantGroup = byVariant ? ', bi.variant_id, bi.variant_name' : '';

    const rows = await dbService.query(
      `SELECT
         p.id                                                   AS product_id,
         p.name                                                 AS product_name,
         p.sku,
         p.category_id,
         COALESCE(c.name, 'Uncategorised')                      AS category_name,
         ${variantSelect}
         COALESCE(SUM(bi.quantity), 0)                          AS quantity_sold,
         COUNT(DISTINCT bi.bill_id)                             AS bills_count,
         COALESCE(SUM(bi.subtotal), 0)                          AS gross_sales,
         COALESCE(SUM(bi.discount_amount), 0)                   AS discount_amount,
         COALESCE(SUM(bi.tax_amount), 0)                        AS tax_amount,
         COALESCE(SUM(bi.total_amount), 0)                      AS net_sales,
         COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS total_cost,
         COALESCE(SUM(bi.total_amount) - SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS gross_profit,
         COALESCE(AVG(bi.unit_price), 0)                        AS avg_selling_price,
         MAX(b.created_at)                                      AS last_sold_at
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.id
       JOIN products p ON bi.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       ${filtered}
       GROUP BY p.id, p.name, p.sku, p.category_id, c.name${variantGroup}
       ORDER BY net_sales DESC
       ${options.limit ? 'LIMIT ?' : ''}`,
      options.limit ? [...args, options.limit] : args
    );

    const products = ReportQuery.numbers(rows, [
      'quantity_sold',
      'bills_count',
      'gross_sales',
      'discount_amount',
      'tax_amount',
      'net_sales',
      'total_cost',
      'gross_profit',
      'avg_selling_price',
    ]);

    const totalNet = products.reduce((sum, r) => sum + r.net_sales, 0);
    const withShare = products.map((row) => ({
      ...row,
      revenue_share_percent: ReportQuery.share(row.net_sales, totalNet),
      margin_percent: ReportQuery.share(row.gross_profit, row.net_sales),
    }));

    return {
      range: options.range,
      groupBy: byVariant ? 'variant' : 'product',
      summary: {
        products_sold: withShare.length,
        total_quantity: ReportQuery.round(products.reduce((s, r) => s + r.quantity_sold, 0)),
        total_net_sales: ReportQuery.round(totalNet),
        total_cost: ReportQuery.round(products.reduce((s, r) => s + r.total_cost, 0)),
        total_gross_profit: ReportQuery.round(products.reduce((s, r) => s + r.gross_profit, 0)),
      },
      products: withShare,
    };
  }

  /** Sales by category, with share of revenue and units. */
  static async byCategory(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const rows = await dbService.query(
      `SELECT
         c.id                                                   AS category_id,
         COALESCE(c.name, 'Uncategorised')                      AS category_name,
         c.icon,
         COUNT(DISTINCT bi.bill_id)                             AS bills_count,
         COUNT(DISTINCT p.id)                                   AS distinct_products,
         COALESCE(SUM(bi.quantity), 0)                          AS quantity_sold,
         COALESCE(SUM(bi.subtotal), 0)                          AS gross_sales,
         COALESCE(SUM(bi.discount_amount), 0)                   AS discount_amount,
         COALESCE(SUM(bi.tax_amount), 0)                        AS tax_amount,
         COALESCE(SUM(bi.total_amount), 0)                      AS net_sales,
         COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS total_cost,
         COALESCE(SUM(bi.total_amount) - SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS gross_profit
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.id
       JOIN products p ON bi.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       ${where}
       GROUP BY c.id, c.name, c.icon
       ORDER BY net_sales DESC`,
      params
    );

    const categories = ReportQuery.numbers(rows, [
      'bills_count',
      'distinct_products',
      'quantity_sold',
      'gross_sales',
      'discount_amount',
      'tax_amount',
      'net_sales',
      'total_cost',
      'gross_profit',
    ]);

    const totalNet = categories.reduce((s, r) => s + r.net_sales, 0);
    const totalUnits = categories.reduce((s, r) => s + r.quantity_sold, 0);

    return {
      range: options.range,
      summary: {
        categories_sold: categories.length,
        total_quantity: ReportQuery.round(totalUnits),
        total_net_sales: ReportQuery.round(totalNet),
        total_gross_profit: ReportQuery.round(categories.reduce((s, r) => s + r.gross_profit, 0)),
      },
      categories: categories.map((row) => ({
        ...row,
        revenue_share_percent: ReportQuery.share(row.net_sales, totalNet),
        units_share_percent: ReportQuery.share(row.quantity_sold, totalUnits),
        margin_percent: ReportQuery.share(row.gross_profit, row.net_sales),
      })),
    };
  }

  /**
   * Sales by employee (the cashier who settled the bill).
   *
   * Voids are deliberately scoped in here rather than filtered out: a till's
   * void count and void value are the point of this report, so the window is
   * opened with `includeVoided` and each measure decides for itself via a
   * CASE, keeping it to a single pass over the range.
   */
  static async byEmployee(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, { ...options, includeVoided: true });

    const rows = await dbService.query(
      `SELECT
         u.id                                                   AS user_id,
         u.name                                                 AS employee_name,
         u.username,
         r.name                                                 AS role_name,
         COALESCE(SUM(CASE WHEN b.is_voided = 0 THEN 1 ELSE 0 END), 0)                        AS bills_count,
         COALESCE(SUM(CASE WHEN b.is_voided = 0 THEN b.subtotal ELSE 0 END), 0)               AS gross_sales,
         COALESCE(SUM(CASE WHEN b.is_voided = 0 THEN b.discount_amount + b.coupon_discount ELSE 0 END), 0) AS discount_given,
         COALESCE(SUM(CASE WHEN b.is_voided = 0 THEN b.tax_amount ELSE 0 END), 0)             AS tax_collected,
         COALESCE(SUM(CASE WHEN b.is_voided = 0 THEN b.total_amount ELSE 0 END), 0)           AS net_sales,
         COALESCE(SUM(CASE WHEN b.is_voided = 1 THEN 1 ELSE 0 END), 0)                        AS void_count,
         COALESCE(SUM(CASE WHEN b.is_voided = 1 THEN b.total_amount ELSE 0 END), 0)           AS void_amount,
         COALESCE(SUM(CASE WHEN b.is_voided = 0 AND b.payment_method = 'CASH' THEN b.total_amount ELSE 0 END), 0) AS cash_sales,
         COUNT(DISTINCT CASE WHEN b.is_voided = 0 THEN DATE(b.created_at) END)                AS active_days,
         MIN(b.created_at)                                      AS first_bill_at,
         MAX(b.created_at)                                      AS last_bill_at
       FROM bills b
       JOIN users u ON b.cashier_id = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       ${where}
       GROUP BY u.id, u.name, u.username, r.name
       ORDER BY net_sales DESC`,
      params
    );

    const employees = ReportQuery.numbers(rows, [
      'bills_count',
      'gross_sales',
      'discount_given',
      'tax_collected',
      'net_sales',
      'void_count',
      'void_amount',
      'cash_sales',
      'active_days',
    ]);

    const items = await dbService.query(
      `SELECT b.cashier_id AS user_id, COALESCE(SUM(bi.quantity), 0) AS items_sold
       FROM bills b
       JOIN bill_items bi ON bi.bill_id = b.id
       ${ReportQuery.bills('b', options.range, options).where}
       GROUP BY b.cashier_id`,
      ReportQuery.bills('b', options.range, options).params
    );
    const itemsByUser = new Map<number, number>(
      items.map((row: any) => [Number(row.user_id), ReportQuery.num(row.items_sold)])
    );

    const totalNet = employees.reduce((s, r) => s + r.net_sales, 0);

    return {
      range: options.range,
      summary: {
        employees_active: employees.length,
        total_net_sales: ReportQuery.round(totalNet),
        total_bills: employees.reduce((s, r) => s + r.bills_count, 0),
        total_voids: employees.reduce((s, r) => s + r.void_count, 0),
      },
      employees: employees.map((row) => ({
        ...row,
        items_sold: ReportQuery.round(itemsByUser.get(Number(row.user_id)) ?? 0),
        avg_bill_value: ReportQuery.round(row.bills_count ? row.net_sales / row.bills_count : 0),
        avg_sales_per_day: ReportQuery.round(row.active_days ? row.net_sales / row.active_days : 0),
        revenue_share_percent: ReportQuery.share(row.net_sales, totalNet),
        void_rate_percent: ReportQuery.share(row.void_count, row.bills_count + row.void_count),
      })),
    };
  }

  /**
   * Sales by hour of day, 00:00 to 23:00.
   *
   * Hours with no trade are emitted as zero rows rather than omitted, so a
   * chart shows the shape of the trading day including the dead hours.
   */
  static async byHour(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const rows = await dbService.query(
      `SELECT
         HOUR(b.created_at)                     AS hour,
         COUNT(b.id)                            AS bills_count,
         COALESCE(SUM(b.total_amount), 0)       AS net_sales,
         COALESCE(SUM(b.subtotal), 0)           AS gross_sales,
         COALESCE(SUM(b.discount_amount), 0)    AS discount_amount,
         COALESCE(SUM(b.tax_amount), 0)         AS tax_amount,
         COUNT(DISTINCT DATE(b.created_at))     AS active_days
       FROM bills b
       ${where}
       GROUP BY HOUR(b.created_at)
       ORDER BY hour ASC`,
      params
    );

    const byHour = new Map<number, any>(
      ReportQuery.numbers(rows, [
        'bills_count',
        'net_sales',
        'gross_sales',
        'discount_amount',
        'tax_amount',
        'active_days',
      ]).map((row) => [Number(row.hour), row])
    );

    const totalNet = [...byHour.values()].reduce((s, r) => s + r.net_sales, 0);

    const hours = Array.from({ length: 24 }, (_, hour) => {
      const row = byHour.get(hour);
      const bills = row ? row.bills_count : 0;
      const net = row ? row.net_sales : 0;
      const activeDays = row ? row.active_days : 0;
      return {
        hour,
        label: `${String(hour).padStart(2, '0')}:00`,
        bills_count: bills,
        gross_sales: row ? row.gross_sales : 0,
        discount_amount: row ? row.discount_amount : 0,
        tax_amount: row ? row.tax_amount : 0,
        net_sales: net,
        avg_bill_value: ReportQuery.round(bills ? net / bills : 0),
        avg_sales_per_active_day: ReportQuery.round(activeDays ? net / activeDays : 0),
        revenue_share_percent: ReportQuery.share(net, totalNet),
      };
    });

    const busiest = [...hours].sort((a, b) => b.net_sales - a.net_sales)[0];
    const quietest = [...hours].filter((h) => h.bills_count > 0).sort((a, b) => a.net_sales - b.net_sales)[0];

    return {
      range: options.range,
      summary: {
        total_net_sales: ReportQuery.round(totalNet),
        total_bills: hours.reduce((s, h) => s + h.bills_count, 0),
        busiest_hour: busiest?.bills_count ? busiest.label : null,
        busiest_hour_sales: busiest?.net_sales ?? 0,
        quietest_trading_hour: quietest ? quietest.label : null,
      },
      hours,
    };
  }

  /** Sales split by order type (DINING / TAKEAWAY, or any later addition). */
  static async byOrderType(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const rows = await dbService.query(
      `SELECT
         b.order_type,
         COUNT(b.id)                            AS bills_count,
         COALESCE(SUM(b.subtotal), 0)           AS gross_sales,
         COALESCE(SUM(b.discount_amount + b.coupon_discount), 0) AS discount_amount,
         COALESCE(SUM(b.tax_amount), 0)         AS tax_amount,
         COALESCE(SUM(b.service_charge_amount), 0) AS service_charges,
         COALESCE(SUM(b.total_amount), 0)       AS net_sales,
         COALESCE(AVG(b.total_amount), 0)       AS avg_bill_value,
         COUNT(DISTINCT b.customer_id)          AS distinct_customers
       FROM bills b
       ${where}
       GROUP BY b.order_type
       ORDER BY net_sales DESC`,
      params
    );

    const orderTypes = ReportQuery.numbers(rows, [
      'bills_count',
      'gross_sales',
      'discount_amount',
      'tax_amount',
      'service_charges',
      'net_sales',
      'avg_bill_value',
      'distinct_customers',
    ]);

    const totalNet = orderTypes.reduce((s, r) => s + r.net_sales, 0);
    const totalBills = orderTypes.reduce((s, r) => s + r.bills_count, 0);

    const items = await dbService.query(
      `SELECT b.order_type, COALESCE(SUM(bi.quantity), 0) AS items_sold
       FROM bills b
       JOIN bill_items bi ON bi.bill_id = b.id
       ${where}
       GROUP BY b.order_type`,
      params
    );
    const itemsByType = new Map<string, number>(
      items.map((row: any) => [String(row.order_type), ReportQuery.num(row.items_sold)])
    );

    return {
      range: options.range,
      summary: {
        total_net_sales: ReportQuery.round(totalNet),
        total_bills: totalBills,
        order_types: orderTypes.length,
      },
      orderTypes: orderTypes.map((row) => ({
        ...row,
        items_sold: ReportQuery.round(itemsByType.get(String(row.order_type)) ?? 0),
        revenue_share_percent: ReportQuery.share(row.net_sales, totalNet),
        bills_share_percent: ReportQuery.share(row.bills_count, totalBills),
        avg_items_per_bill: ReportQuery.round(
          row.bills_count ? (itemsByType.get(String(row.order_type)) ?? 0) / row.bills_count : 0
        ),
      })),
    };
  }

  /**
   * Day-by-day sales for the range, with every calendar day present.
   *
   * Gaps are filled because a closed day is information: a chart or a
   * day-on-day delta built on a sparse series silently treats the next
   * trading day as "yesterday".
   */
  static async daily(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const series = await this.series(options, 'day');
    const days = series.periods;

    const trading = days.filter((d) => d.bills_count > 0);
    const best = [...trading].sort((a, b) => b.net_sales - a.net_sales)[0];
    const worst = [...trading].sort((a, b) => a.net_sales - b.net_sales)[0];

    return {
      range: options.range,
      summary: {
        ...series.summary,
        trading_days: trading.length,
        closed_days: days.length - trading.length,
        avg_sales_per_trading_day: ReportQuery.round(
          trading.length ? series.summary.total_net_sales / trading.length : 0
        ),
        best_day: best?.period ?? null,
        best_day_sales: best?.net_sales ?? 0,
        worst_day: worst?.period ?? null,
        worst_day_sales: worst?.net_sales ?? 0,
      },
      days,
    };
  }

  /** Month-by-month sales with month-on-month growth. */
  static async monthly(options: SalesReportOptions) {
    await ReportsSchema.ensure();
    const series = await this.series(options, 'month');

    const months = series.periods.map((row, index) => {
      const previous = index > 0 ? series.periods[index - 1] : null;
      return {
        ...row,
        growth_percent: previous ? ReportQuery.growth(row.net_sales, previous.net_sales) : null,
      };
    });

    const best = [...months].sort((a, b) => b.net_sales - a.net_sales)[0];

    return {
      range: options.range,
      summary: {
        ...series.summary,
        months_covered: months.length,
        avg_sales_per_month: ReportQuery.round(months.length ? series.summary.total_net_sales / months.length : 0),
        best_month: best?.period ?? null,
        best_month_sales: best?.net_sales ?? 0,
      },
      months,
    };
  }

  /**
   * Sales trends: this window against the equally long window before it, with
   * both series bucketed at the requested granularity so they can be overlaid.
   */
  static async trends(options: SalesReportOptions & { granularity?: Granularity }) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const previousRange = ReportQuery.previousRange(options.range);

    const [current, previous] = await Promise.all([
      this.series(options, granularity),
      this.series({ ...options, range: previousRange }, granularity),
    ]);

    const measure = (key: 'total_net_sales' | 'total_bills' | 'total_items' | 'avg_bill_value' | 'total_discount') => ({
      current: current.summary[key],
      previous: previous.summary[key],
      change: ReportQuery.round(current.summary[key] - previous.summary[key]),
      growth_percent: ReportQuery.growth(current.summary[key], previous.summary[key]),
    });

    return {
      range: options.range,
      comparisonRange: previousRange,
      granularity,
      trends: {
        net_sales: measure('total_net_sales'),
        bills: measure('total_bills'),
        items_sold: measure('total_items'),
        avg_bill_value: measure('avg_bill_value'),
        discount: measure('total_discount'),
      },
      current: current.periods,
      previous: previous.periods,
    };
  }

  /**
   * The one bucketed sales query behind daily / monthly / trends.
   *
   * Item counts come from a second query rather than a join onto `bill_items`,
   * because joining would multiply each bill's header amounts by its line count
   * and inflate every total.
   */
  private static async series(options: SalesReportOptions, granularity: Granularity) {
    const { where, params } = ReportQuery.bills('b', options.range, options);
    const bucket = ReportQuery.bucket('b', granularity);

    const rows = await dbService.query(
      `SELECT
         ${bucket.label}                        AS period,
         ${bucket.start}                        AS period_start,
         COUNT(b.id)                            AS bills_count,
         COALESCE(SUM(b.subtotal), 0)           AS gross_sales,
         COALESCE(SUM(b.discount_amount + b.coupon_discount), 0) AS discount_amount,
         COALESCE(SUM(b.tax_amount), 0)         AS tax_amount,
         COALESCE(SUM(b.service_charge_amount), 0) AS service_charges,
         COALESCE(SUM(b.total_amount), 0)       AS net_sales,
         COUNT(DISTINCT b.customer_id)          AS distinct_customers
       FROM bills b
       ${where}
       GROUP BY period, period_start
       ORDER BY period_start ASC`,
      params
    );

    const itemRows = await dbService.query(
      `SELECT ${bucket.label} AS period, COALESCE(SUM(bi.quantity), 0) AS items_sold
       FROM bills b
       JOIN bill_items bi ON bi.bill_id = b.id
       ${where}
       GROUP BY period`,
      params
    );
    const itemsByPeriod = new Map<string, number>(
      itemRows.map((row: any) => [String(row.period), ReportQuery.num(row.items_sold)])
    );

    const measured = new Map<string, any>(
      ReportQuery.numbers(rows, [
        'bills_count',
        'gross_sales',
        'discount_amount',
        'tax_amount',
        'service_charges',
        'net_sales',
        'distinct_customers',
      ]).map((row) => [String(row.period), row])
    );

    const periods = this.periodKeys(options.range, granularity).map(({ period, period_start }) => {
      const row = measured.get(period);
      const bills = row ? row.bills_count : 0;
      const net = row ? row.net_sales : 0;
      const items = itemsByPeriod.get(period) ?? 0;
      return {
        period,
        period_start,
        bills_count: bills,
        gross_sales: row ? row.gross_sales : 0,
        discount_amount: row ? row.discount_amount : 0,
        tax_amount: row ? row.tax_amount : 0,
        service_charges: row ? row.service_charges : 0,
        net_sales: net,
        distinct_customers: row ? row.distinct_customers : 0,
        items_sold: ReportQuery.round(items),
        avg_bill_value: ReportQuery.round(bills ? net / bills : 0),
      };
    });

    const totalNet = periods.reduce((s, p) => s + p.net_sales, 0);
    const totalBills = periods.reduce((s, p) => s + p.bills_count, 0);

    return {
      periods,
      summary: {
        total_gross_sales: ReportQuery.round(periods.reduce((s, p) => s + p.gross_sales, 0)),
        total_discount: ReportQuery.round(periods.reduce((s, p) => s + p.discount_amount, 0)),
        total_tax: ReportQuery.round(periods.reduce((s, p) => s + p.tax_amount, 0)),
        total_net_sales: ReportQuery.round(totalNet),
        total_bills: totalBills,
        total_items: ReportQuery.round(periods.reduce((s, p) => s + p.items_sold, 0)),
        avg_bill_value: ReportQuery.round(totalBills ? totalNet / totalBills : 0),
      },
    };
  }

  /**
   * Every bucket label the range spans, so the series can be gap-filled.
   * Labels are generated with the same rules as the SQL bucket expressions:
   * ISO week for `week`, calendar month for `month`.
   */
  private static periodKeys(range: ReportRange, granularity: Granularity) {
    const keys: { period: string; period_start: string }[] = [];
    const seen = new Set<string>();
    const cursor = new Date(`${range.dateFrom}T00:00:00`);
    const last = new Date(`${range.dateTo}T00:00:00`);

    while (cursor <= last) {
      const { period, period_start } = this.keyFor(cursor, granularity);
      if (!seen.has(period)) {
        seen.add(period);
        keys.push({ period, period_start });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return keys;
  }

  private static keyFor(date: Date, granularity: Granularity) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');

    if (granularity === 'month') {
      return { period: `${y}-${m}`, period_start: `${y}-${m}-01` };
    }
    if (granularity === 'week') {
      // Monday of this date's ISO week, then that week's ISO year/number.
      const monday = new Date(date.getTime());
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const thursday = new Date(monday.getTime());
      thursday.setDate(thursday.getDate() + 3);
      const firstThursday = new Date(thursday.getFullYear(), 0, 4);
      firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
      const week = Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000)) + 1;
      const mm = String(monday.getMonth() + 1).padStart(2, '0');
      const dd = String(monday.getDate()).padStart(2, '0');
      return {
        period: `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`,
        period_start: `${monday.getFullYear()}-${mm}-${dd}`,
      };
    }
    return { period: `${y}-${m}-${d}`, period_start: `${y}-${m}-${d}` };
  }
}
