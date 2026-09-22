import { dbService } from '../../database/db';
import { ReportsSchema } from './reports.schema';
import { BillScope, Granularity, ReportQuery, ReportRange } from './reports.query';
import { ReportsSalesService } from './reports.sales.service';
import { ReportsFinanceService } from './reports.finance.service';

export interface BiReportOptions extends BillScope {
  range: ReportRange;
  granularity?: Granularity;
  limit?: number;
}

/**
 * Business intelligence: the same transactions as the sales and finance
 * reports, read for decisions rather than for reconciliation.
 *
 * Where a figure here is also produced by another report it is delegated, not
 * re-derived — `salesTrends` calls the sales service — so the two can never
 * drift apart and quietly disagree in the UI.
 */
export class ReportsBiService {
  /**
   * Menu engineering: every product classified on volume against margin.
   *
   * The classification is the standard four-box against the *median* of the
   * range, not a fixed threshold, so it stays meaningful for a ten-item menu
   * and a two-hundred-item one:
   *
   * - `STAR` — sells well and earns well. Protect it.
   * - `PLOUGHHORSE` — sells well, earns little. Reprice or re-cost.
   * - `PUZZLE` — earns well, sells little. Promote or reposition.
   * - `DOG` — neither. Candidate for removal.
   *
   * Products with no sales in the window are returned separately rather than
   * classified as dogs; never-offered and offered-but-unwanted are different
   * problems.
   */
  static async productPerformance(options: BiReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const [rows, unsold] = await Promise.all([
      dbService.query(
        `SELECT
           p.id                                                     AS product_id,
           p.name                                                   AS product_name,
           p.sku,
           COALESCE(c.name, 'Uncategorised')                        AS category_name,
           COALESCE(p.cost_price, 0)                                AS cost_price,
           COALESCE(p.selling_price, 0)                             AS selling_price,
           COALESCE(SUM(bi.quantity), 0)                            AS quantity_sold,
           COUNT(DISTINCT bi.bill_id)                               AS bills_count,
           COALESCE(SUM(bi.total_amount), 0)                        AS revenue,
           COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs,
           COALESCE(SUM(bi.discount_amount), 0)                     AS discount_given,
           MIN(b.created_at)                                        AS first_sold_at,
           MAX(b.created_at)                                        AS last_sold_at
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         LEFT JOIN categories c ON p.category_id = c.id
         ${where}
         GROUP BY p.id, p.name, p.sku, c.name, p.cost_price, p.selling_price
         ORDER BY revenue DESC`,
        params
      ),
      dbService.query(
        `SELECT
           p.id                                   AS product_id,
           p.name                                 AS product_name,
           p.sku,
           COALESCE(c.name, 'Uncategorised')      AS category_name,
           COALESCE(p.selling_price, 0)           AS selling_price,
           p.status,
           p.is_available
         FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1
             FROM bill_items bi
             JOIN bills b ON bi.bill_id = b.id
             WHERE bi.product_id = p.id
               AND b.created_at >= ?
               AND b.created_at < ?
               AND b.is_voided = 0
               AND b.is_deleted = 0
           )
         ORDER BY p.name ASC`,
        [options.range.startAt, options.range.endAt]
      ),
    ]);

    const products = ReportQuery.numbers(rows, [
      'cost_price',
      'selling_price',
      'quantity_sold',
      'bills_count',
      'revenue',
      'cogs',
      'discount_given',
    ]).map((row) => ({
      ...row,
      gross_profit: ReportQuery.round(row.revenue - row.cogs),
      margin_percent: ReportQuery.share(row.revenue - row.cogs, row.revenue),
      units_per_day: ReportQuery.round(options.range.days ? row.quantity_sold / options.range.days : 0),
    }));

    const totalRevenue = products.reduce((s, r) => s + r.revenue, 0);
    const totalUnits = products.reduce((s, r) => s + r.quantity_sold, 0);
    const totalProfit = products.reduce((s, r) => s + r.gross_profit, 0);

    const medianUnits = this.median(products.map((r) => r.quantity_sold));
    const medianMargin = this.median(products.map((r) => r.margin_percent));

    const billCount = await dbService.queryOne<{ bills: number }>(
      `SELECT COUNT(b.id) AS bills FROM bills b ${where}`,
      params
    );
    const totalBills = Number(billCount?.bills ?? 0);

    const classified = products
      .map((row, index) => {
        const highVolume = row.quantity_sold >= medianUnits;
        const highMargin = row.margin_percent >= medianMargin;
        return {
          ...row,
          rank: index + 1,
          revenue_share_percent: ReportQuery.share(row.revenue, totalRevenue),
          units_share_percent: ReportQuery.share(row.quantity_sold, totalUnits),
          profit_share_percent: ReportQuery.share(row.gross_profit, totalProfit),
          attach_rate_percent: ReportQuery.share(row.bills_count, totalBills),
          classification: highVolume
            ? highMargin
              ? 'STAR'
              : 'PLOUGHHORSE'
            : highMargin
              ? 'PUZZLE'
              : 'DOG',
        };
      })
      .map((row) => ({ ...row, is_top_decile: row.rank <= Math.max(1, Math.ceil(products.length / 10)) }));

    // Pareto: how few products carry 80% of revenue.
    let cumulative = 0;
    let paretoCount = 0;
    for (const row of classified) {
      cumulative += row.revenue;
      paretoCount += 1;
      if (cumulative >= totalRevenue * 0.8) break;
    }

    const counts = classified.reduce<Record<string, number>>((acc, row) => {
      acc[row.classification] = (acc[row.classification] ?? 0) + 1;
      return acc;
    }, {});

    return {
      range: options.range,
      summary: {
        products_sold: classified.length,
        products_unsold: unsold.length,
        total_revenue: ReportQuery.round(totalRevenue),
        total_units: ReportQuery.round(totalUnits),
        total_gross_profit: ReportQuery.round(totalProfit),
        median_units_sold: ReportQuery.round(medianUnits),
        median_margin_percent: ReportQuery.round(medianMargin),
        products_driving_80_percent_revenue: paretoCount,
        pareto_concentration_percent: ReportQuery.share(paretoCount, classified.length),
        stars: counts.STAR ?? 0,
        ploughhorses: counts.PLOUGHHORSE ?? 0,
        puzzles: counts.PUZZLE ?? 0,
        dogs: counts.DOG ?? 0,
      },
      products: options.limit ? classified.slice(0, options.limit) : classified,
      unsoldProducts: ReportQuery.numbers(unsold, ['selling_price']),
    };
  }

  /**
   * Customer analytics: who is spending, how often, and who has gone quiet.
   *
   * Walk-in bills carry no `customer_id`, so they are reported as an explicit
   * anonymous share rather than being silently dropped — in a counter-service
   * shop they are usually the majority of trade, and a customer report that
   * hides them looks broken.
   */
  static async customerAnalytics(options: BiReportOptions) {
    await ReportsSchema.ensure();
    const caps = await ReportsSchema.capabilities();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const tierSelect = caps.customerTiers ? 'COALESCE(cu.tier, \'REGULAR\')' : "'REGULAR'";

    const [identified, topCustomers, newVsReturning, byTier, frequency, lapsed] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(b.id)                            AS total_bills,
           COALESCE(SUM(b.total_amount), 0)       AS total_revenue,
           COALESCE(SUM(CASE WHEN b.customer_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS identified_bills,
           COALESCE(SUM(CASE WHEN b.customer_id IS NOT NULL THEN b.total_amount ELSE 0 END), 0) AS identified_revenue,
           COUNT(DISTINCT b.customer_id)          AS distinct_customers
         FROM bills b
         ${where}`,
        params
      ),
      dbService.query(
        `SELECT
           cu.id                                  AS customer_id,
           cu.name                                AS customer_name,
           cu.phone,
           ${tierSelect}                          AS tier,
           COUNT(b.id)                            AS visits,
           COALESCE(SUM(b.total_amount), 0)       AS total_spent,
           COALESCE(AVG(b.total_amount), 0)       AS avg_spend,
           MIN(b.created_at)                      AS first_visit_at,
           MAX(b.created_at)                      AS last_visit_at
         FROM bills b
         JOIN customers cu ON b.customer_id = cu.id
         ${where}
         GROUP BY cu.id, cu.name, cu.phone${caps.customerTiers ? ', cu.tier' : ''}
         ORDER BY total_spent DESC
         LIMIT ?`,
        [...params, options.limit ?? 50]
      ),
      // "New" means the customer record was created inside the window; every
      // other identified buyer was already known to the business.
      dbService.queryOne(
        `SELECT
           COUNT(DISTINCT CASE WHEN cu.created_at >= ? THEN cu.id END) AS new_customers,
           COUNT(DISTINCT CASE WHEN cu.created_at < ?  THEN cu.id END) AS returning_customers,
           COALESCE(SUM(CASE WHEN cu.created_at >= ? THEN b.total_amount ELSE 0 END), 0) AS new_customer_revenue,
           COALESCE(SUM(CASE WHEN cu.created_at <  ? THEN b.total_amount ELSE 0 END), 0) AS returning_customer_revenue
         FROM bills b
         JOIN customers cu ON b.customer_id = cu.id
         ${where}`,
        [options.range.startAt, options.range.startAt, options.range.startAt, options.range.startAt, ...params]
      ),
      caps.customerTiers
        ? dbService.query(
            `SELECT
               COALESCE(cu.tier, 'REGULAR')       AS tier,
               COUNT(DISTINCT cu.id)              AS customers,
               COUNT(b.id)                        AS visits,
               COALESCE(SUM(b.total_amount), 0)   AS total_spent,
               COALESCE(AVG(b.total_amount), 0)   AS avg_spend
             FROM bills b
             JOIN customers cu ON b.customer_id = cu.id
             ${where}
             GROUP BY cu.tier
             ORDER BY total_spent DESC`,
            params
          )
        : Promise.resolve([]),
      dbService.query(
        `SELECT visits, COUNT(*) AS customers, COALESCE(SUM(spent), 0) AS total_spent
         FROM (
           SELECT b.customer_id, COUNT(b.id) AS visits, SUM(b.total_amount) AS spent
           FROM bills b
           ${where} AND b.customer_id IS NOT NULL
           GROUP BY b.customer_id
         ) per_customer
         GROUP BY visits
         ORDER BY visits ASC`,
        params
      ),
      // Customers who bought before this window but not in it.
      dbService.query(
        `SELECT
           cu.id                                  AS customer_id,
           cu.name                                AS customer_name,
           cu.phone,
           COALESCE(cu.total_spent, 0)            AS lifetime_spent,
           COALESCE(cu.total_visits, 0)           AS lifetime_visits,
           MAX(b.created_at)                      AS last_visit_at,
           DATEDIFF(?, MAX(b.created_at))         AS days_since_last_visit
         FROM customers cu
         JOIN bills b ON b.customer_id = cu.id AND b.is_voided = 0 AND b.is_deleted = 0
         WHERE b.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM bills b2
             WHERE b2.customer_id = cu.id
               AND b2.is_voided = 0
               AND b2.is_deleted = 0
               AND b2.created_at >= ?
               AND b2.created_at < ?
           )
         GROUP BY cu.id, cu.name, cu.phone, cu.total_spent, cu.total_visits
         ORDER BY lifetime_spent DESC
         LIMIT ?`,
        [
          options.range.endAt,
          options.range.startAt,
          options.range.startAt,
          options.range.endAt,
          options.limit ?? 50,
        ]
      ),
    ]);

    const totalRevenue = ReportQuery.round(ReportQuery.num(identified?.total_revenue));
    const identifiedRevenue = ReportQuery.round(ReportQuery.num(identified?.identified_revenue));
    const totalBills = Number(identified?.total_bills ?? 0);
    const identifiedBills = Number(identified?.identified_bills ?? 0);
    const distinctCustomers = Number(identified?.distinct_customers ?? 0);

    const frequencyRows = ReportQuery.numbers(frequency, ['visits', 'customers', 'total_spent']);
    const oneTimers = frequencyRows.find((r) => r.visits === 1)?.customers ?? 0;

    return {
      range: options.range,
      summary: {
        total_bills: totalBills,
        total_revenue: totalRevenue,
        identified_bills: identifiedBills,
        identified_revenue: identifiedRevenue,
        anonymous_bills: totalBills - identifiedBills,
        anonymous_revenue: ReportQuery.round(totalRevenue - identifiedRevenue),
        identified_bill_percent: ReportQuery.share(identifiedBills, totalBills),
        distinct_customers: distinctCustomers,
        new_customers: Number(newVsReturning?.new_customers ?? 0),
        returning_customers: Number(newVsReturning?.returning_customers ?? 0),
        new_customer_revenue: ReportQuery.round(ReportQuery.num(newVsReturning?.new_customer_revenue)),
        returning_customer_revenue: ReportQuery.round(ReportQuery.num(newVsReturning?.returning_customer_revenue)),
        avg_spend_per_customer: ReportQuery.round(distinctCustomers ? identifiedRevenue / distinctCustomers : 0),
        avg_visits_per_customer: ReportQuery.round(distinctCustomers ? identifiedBills / distinctCustomers : 0),
        one_time_customers: oneTimers,
        one_time_customer_percent: ReportQuery.share(oneTimers, distinctCustomers),
        lapsed_customers: lapsed.length,
      },
      topCustomers: ReportQuery.numbers(topCustomers, ['visits', 'total_spent', 'avg_spend']).map((row) => ({
        ...row,
        revenue_share_percent: ReportQuery.share(row.total_spent, identifiedRevenue),
      })),
      byTier: ReportQuery.numbers(byTier, ['customers', 'visits', 'total_spent', 'avg_spend']),
      visitFrequency: frequencyRows.map((row) => ({
        ...row,
        customer_share_percent: ReportQuery.share(row.customers, distinctCustomers),
      })),
      lapsedCustomers: ReportQuery.numbers(lapsed, [
        'lifetime_spent',
        'lifetime_visits',
        'days_since_last_visit',
      ]),
      tierBreakdownAvailable: caps.customerTiers,
    };
  }

  /** Sales trends. Delegates to the sales report so both endpoints agree. */
  static async salesTrends(options: BiReportOptions) {
    return ReportsSalesService.trends({ ...options, granularity: options.granularity });
  }

  /**
   * Peak trading: a day-of-week by hour grid.
   *
   * Returned both as the full 7x24 matrix (for a heatmap) and as ranked slots,
   * because the actionable output is usually "Friday 20:00 is the peak", not
   * the grid itself. Averages are per *occurrence* of that slot in the range,
   * so a range covering three Fridays does not read as three times the trade.
   */
  static async peakHours(options: BiReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const [grid, byDay, byHour] = await Promise.all([
      dbService.query(
        `SELECT
           DAYOFWEEK(b.created_at)                AS dow,
           HOUR(b.created_at)                     AS hour,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales,
           COUNT(DISTINCT DATE(b.created_at))     AS occurrences
         FROM bills b
         ${where}
         GROUP BY dow, hour`,
        params
      ),
      dbService.query(
        `SELECT
           DAYOFWEEK(b.created_at)                AS dow,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales,
           COALESCE(AVG(b.total_amount), 0)       AS avg_bill_value,
           COUNT(DISTINCT DATE(b.created_at))     AS occurrences
         FROM bills b
         ${where}
         GROUP BY dow
         ORDER BY dow ASC`,
        params
      ),
      dbService.query(
        `SELECT
           HOUR(b.created_at)                     AS hour,
           COUNT(b.id)                            AS bills_count,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales,
           COUNT(DISTINCT DATE(b.created_at))     AS occurrences
         FROM bills b
         ${where}
         GROUP BY hour
         ORDER BY hour ASC`,
        params
      ),
    ]);

    // MySQL DAYOFWEEK() is 1=Sunday..7=Saturday.
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const cells = new Map<string, any>(
      ReportQuery.numbers(grid, ['bills_count', 'net_sales', 'occurrences']).map((row) => [
        `${Number(row.dow)}-${Number(row.hour)}`,
        row,
      ])
    );

    const matrix = dayNames.map((dayName, index) => {
      const dow = index + 1;
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const cell = cells.get(`${dow}-${hour}`);
        const occurrences = cell ? cell.occurrences : 0;
        return {
          hour,
          bills_count: cell ? cell.bills_count : 0,
          net_sales: cell ? cell.net_sales : 0,
          occurrences,
          avg_bills_per_occurrence: ReportQuery.round(occurrences ? cell.bills_count / occurrences : 0),
          avg_sales_per_occurrence: ReportQuery.round(occurrences ? cell.net_sales / occurrences : 0),
        };
      });
      return { dow, day_name: dayName, hours };
    });

    const slots = matrix
      .flatMap((day) =>
        day.hours
          .filter((cell) => cell.bills_count > 0)
          .map((cell) => ({
            dow: day.dow,
            day_name: day.day_name,
            hour: cell.hour,
            label: `${day.day_name} ${String(cell.hour).padStart(2, '0')}:00`,
            bills_count: cell.bills_count,
            net_sales: cell.net_sales,
            avg_sales_per_occurrence: cell.avg_sales_per_occurrence,
          }))
      )
      .sort((a, b) => b.net_sales - a.net_sales);

    const days = ReportQuery.numbers(byDay, [
      'bills_count',
      'net_sales',
      'avg_bill_value',
      'occurrences',
    ]).map((row) => ({
      ...row,
      day_name: dayNames[Number(row.dow) - 1] ?? 'Unknown',
      avg_sales_per_occurrence: ReportQuery.round(row.occurrences ? row.net_sales / row.occurrences : 0),
    }));

    const hours = ReportQuery.numbers(byHour, ['bills_count', 'net_sales', 'occurrences']).map((row) => ({
      ...row,
      label: `${String(Number(row.hour)).padStart(2, '0')}:00`,
      avg_sales_per_occurrence: ReportQuery.round(row.occurrences ? row.net_sales / row.occurrences : 0),
    }));

    const busiestDay = [...days].sort((a, b) => b.avg_sales_per_occurrence - a.avg_sales_per_occurrence)[0];
    const busiestHour = [...hours].sort((a, b) => b.net_sales - a.net_sales)[0];

    return {
      range: options.range,
      summary: {
        peak_slot: slots[0]?.label ?? null,
        peak_slot_sales: slots[0]?.net_sales ?? 0,
        busiest_day: busiestDay?.day_name ?? null,
        busiest_day_avg_sales: busiestDay?.avg_sales_per_occurrence ?? 0,
        busiest_hour: busiestHour?.label ?? null,
        busiest_hour_sales: busiestHour?.net_sales ?? 0,
        trading_hours_observed: hours.length,
      },
      topSlots: slots.slice(0, options.limit ?? 20),
      byDay: days,
      byHour: hours,
      matrix,
    };
  }

  /**
   * Average order value, sliced every way it is usually questioned, plus the
   * spread.
   *
   * The distribution matters more than the mean here: a 450 average made of
   * many 200 bills and a few 3000 ones is a different business from one where
   * every bill is 450, and only the buckets show which it is.
   */
  static async averageOrderValue(options: BiReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const { where, params } = ReportQuery.bills('b', options.range, options);
    const bucket = ReportQuery.bucket('b', granularity);
    const previousRange = ReportQuery.previousRange(options.range);
    const previousScope = ReportQuery.bills('b', previousRange, options);

    const aovSql = (clause: string) => `
      SELECT
        COUNT(b.id)                               AS bills_count,
        COALESCE(SUM(b.total_amount), 0)          AS net_sales,
        COALESCE(AVG(b.total_amount), 0)          AS avg_order_value,
        COALESCE(MIN(b.total_amount), 0)          AS min_order_value,
        COALESCE(MAX(b.total_amount), 0)          AS max_order_value,
        COALESCE(STDDEV_POP(b.total_amount), 0)   AS stddev_order_value
      FROM bills b
      ${clause}`;

    const [current, previous, byOrderType, byCashier, series, itemStats, distribution] = await Promise.all([
      dbService.queryOne(aovSql(where), params),
      dbService.queryOne(aovSql(previousScope.where), previousScope.params),
      dbService.query(
        `SELECT
           b.order_type,
           COUNT(b.id)                            AS bills_count,
           COALESCE(AVG(b.total_amount), 0)       AS avg_order_value,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales
         FROM bills b
         ${where}
         GROUP BY b.order_type
         ORDER BY avg_order_value DESC`,
        params
      ),
      dbService.query(
        `SELECT
           u.id                                   AS user_id,
           u.name                                 AS employee_name,
           COUNT(b.id)                            AS bills_count,
           COALESCE(AVG(b.total_amount), 0)       AS avg_order_value,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales
         FROM bills b
         JOIN users u ON b.cashier_id = u.id
         ${where}
         GROUP BY u.id, u.name
         ORDER BY avg_order_value DESC`,
        params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(b.id)                            AS bills_count,
           COALESCE(AVG(b.total_amount), 0)       AS avg_order_value,
           COALESCE(SUM(b.total_amount), 0)       AS net_sales
         FROM bills b
         ${where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        params
      ),
      dbService.queryOne(
        `SELECT
           COALESCE(SUM(bi.quantity), 0)          AS items_sold,
           COUNT(DISTINCT bi.bill_id)             AS bills_with_items,
           COUNT(DISTINCT bi.product_id)          AS distinct_products
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         ${where}`,
        params
      ),
      // Value bands, so the shape of the distribution is visible.
      dbService.query(
        `SELECT band, COUNT(*) AS bills_count, COALESCE(SUM(total_amount), 0) AS net_sales
         FROM (
           SELECT
             b.total_amount,
             CASE
               WHEN b.total_amount < 100  THEN '0-99'
               WHEN b.total_amount < 250  THEN '100-249'
               WHEN b.total_amount < 500  THEN '250-499'
               WHEN b.total_amount < 1000 THEN '500-999'
               WHEN b.total_amount < 2500 THEN '1000-2499'
               WHEN b.total_amount < 5000 THEN '2500-4999'
               ELSE '5000+'
             END AS band,
             CASE
               WHEN b.total_amount < 100  THEN 1
               WHEN b.total_amount < 250  THEN 2
               WHEN b.total_amount < 500  THEN 3
               WHEN b.total_amount < 1000 THEN 4
               WHEN b.total_amount < 2500 THEN 5
               WHEN b.total_amount < 5000 THEN 6
               ELSE 7
             END AS band_order
           FROM bills b
           ${where}
         ) banded
         GROUP BY band, band_order
         ORDER BY band_order ASC`,
        params
      ),
    ]);

    const aov = ReportQuery.round(ReportQuery.num(current?.avg_order_value));
    const prevAov = ReportQuery.round(ReportQuery.num(previous?.avg_order_value));
    const billsCount = Number(current?.bills_count ?? 0);
    const itemsSold = ReportQuery.round(ReportQuery.num(itemStats?.items_sold));

    const bands = ReportQuery.numbers(distribution, ['bills_count', 'net_sales']);
    const totalBanded = bands.reduce((s, r) => s + r.bills_count, 0);

    return {
      range: options.range,
      comparisonRange: previousRange,
      granularity,
      summary: {
        bills_count: billsCount,
        net_sales: ReportQuery.round(ReportQuery.num(current?.net_sales)),
        avg_order_value: aov,
        min_order_value: ReportQuery.round(ReportQuery.num(current?.min_order_value)),
        max_order_value: ReportQuery.round(ReportQuery.num(current?.max_order_value)),
        stddev_order_value: ReportQuery.round(ReportQuery.num(current?.stddev_order_value)),
        items_sold: itemsSold,
        avg_items_per_bill: ReportQuery.round(billsCount ? itemsSold / billsCount : 0),
        avg_item_value: ReportQuery.round(itemsSold ? ReportQuery.num(current?.net_sales) / itemsSold : 0),
        distinct_products_sold: Number(itemStats?.distinct_products ?? 0),
      },
      comparison: {
        avg_order_value: { current: aov, previous: prevAov, growth_percent: ReportQuery.growth(aov, prevAov) },
        bills: {
          current: billsCount,
          previous: Number(previous?.bills_count ?? 0),
          growth_percent: ReportQuery.growth(billsCount, Number(previous?.bills_count ?? 0)),
        },
      },
      byOrderType: ReportQuery.numbers(byOrderType, ['bills_count', 'avg_order_value', 'net_sales']),
      byEmployee: ReportQuery.numbers(byCashier, ['bills_count', 'avg_order_value', 'net_sales']),
      distribution: bands.map((row) => ({
        ...row,
        bills_share_percent: ReportQuery.share(row.bills_count, totalBanded),
      })),
      series: ReportQuery.numbers(series, ['bills_count', 'avg_order_value', 'net_sales']),
    };
  }

  /**
   * Repeat customers: how much of the trade comes back.
   *
   * Two different questions, both answered:
   *
   * - **in-window repeat rate** — of the customers seen in this range, how
   *   many came more than once *within it*. Sensitive to range length; a
   *   one-day range can only ever show same-day repeats.
   * - **lifetime repeat rate** — of the customers seen in this range, how many
   *   had already bought before it. Range-length independent, and the better
   *   measure of loyalty.
   */
  static async repeatCustomers(options: BiReportOptions) {
    await ReportsSchema.ensure();
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const [inWindow, lifetime, cohorts, topRepeat] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(*)                               AS customers,
           COALESCE(SUM(CASE WHEN visits > 1 THEN 1 ELSE 0 END), 0) AS repeat_customers,
           COALESCE(SUM(CASE WHEN visits = 1 THEN 1 ELSE 0 END), 0) AS single_visit_customers,
           COALESCE(SUM(visits), 0)               AS total_visits,
           COALESCE(SUM(spent), 0)                AS total_spent,
           COALESCE(SUM(CASE WHEN visits > 1 THEN spent ELSE 0 END), 0) AS repeat_spent
         FROM (
           SELECT b.customer_id, COUNT(b.id) AS visits, SUM(b.total_amount) AS spent
           FROM bills b
           ${where} AND b.customer_id IS NOT NULL
           GROUP BY b.customer_id
         ) per_customer`,
        params
      ),
      dbService.queryOne(
        `SELECT
           COUNT(DISTINCT b.customer_id)          AS customers,
           COUNT(DISTINCT CASE WHEN prior.bills_before > 0 THEN b.customer_id END) AS previously_known,
           COALESCE(SUM(CASE WHEN prior.bills_before > 0 THEN b.total_amount ELSE 0 END), 0) AS previously_known_revenue
         FROM bills b
         LEFT JOIN (
           SELECT customer_id, COUNT(*) AS bills_before
           FROM bills
           WHERE is_voided = 0 AND is_deleted = 0 AND created_at < ?
           GROUP BY customer_id
         ) prior ON prior.customer_id = b.customer_id
         ${where} AND b.customer_id IS NOT NULL`,
        [options.range.startAt, ...params]
      ),
      // Visit-count cohorts, which read better than a row per visit count.
      dbService.query(
        `SELECT cohort, COUNT(*) AS customers, COALESCE(SUM(spent), 0) AS total_spent,
                COALESCE(SUM(visits), 0) AS total_visits
         FROM (
           SELECT
             per.visits,
             per.spent,
             CASE
               WHEN per.visits = 1 THEN '1 visit'
               WHEN per.visits = 2 THEN '2 visits'
               WHEN per.visits BETWEEN 3 AND 5 THEN '3-5 visits'
               WHEN per.visits BETWEEN 6 AND 10 THEN '6-10 visits'
               ELSE '10+ visits'
             END AS cohort,
             CASE
               WHEN per.visits = 1 THEN 1
               WHEN per.visits = 2 THEN 2
               WHEN per.visits BETWEEN 3 AND 5 THEN 3
               WHEN per.visits BETWEEN 6 AND 10 THEN 4
               ELSE 5
             END AS cohort_order
           FROM (
             SELECT b.customer_id, COUNT(b.id) AS visits, SUM(b.total_amount) AS spent
             FROM bills b
             ${where} AND b.customer_id IS NOT NULL
             GROUP BY b.customer_id
           ) per
         ) cohorted
         GROUP BY cohort, cohort_order
         ORDER BY cohort_order ASC`,
        params
      ),
      dbService.query(
        `SELECT
           cu.id                                  AS customer_id,
           cu.name                                AS customer_name,
           cu.phone,
           COUNT(b.id)                            AS visits,
           COALESCE(SUM(b.total_amount), 0)       AS total_spent,
           COALESCE(AVG(b.total_amount), 0)       AS avg_spend,
           MIN(b.created_at)                      AS first_visit_at,
           MAX(b.created_at)                      AS last_visit_at,
           DATEDIFF(MAX(b.created_at), MIN(b.created_at)) AS span_days
         FROM bills b
         JOIN customers cu ON b.customer_id = cu.id
         ${where}
         GROUP BY cu.id, cu.name, cu.phone
         HAVING visits > 1
         ORDER BY visits DESC, total_spent DESC
         LIMIT ?`,
        [...params, options.limit ?? 50]
      ),
    ]);

    const customers = Number(inWindow?.customers ?? 0);
    const repeaters = Number(inWindow?.repeat_customers ?? 0);
    const totalSpent = ReportQuery.round(ReportQuery.num(inWindow?.total_spent));
    const repeatSpent = ReportQuery.round(ReportQuery.num(inWindow?.repeat_spent));
    const lifetimeCustomers = Number(lifetime?.customers ?? 0);
    const previouslyKnown = Number(lifetime?.previously_known ?? 0);

    const cohortRows = ReportQuery.numbers(cohorts, ['customers', 'total_spent', 'total_visits']);

    return {
      range: options.range,
      summary: {
        identified_customers: customers,
        repeat_customers_in_window: repeaters,
        single_visit_customers: Number(inWindow?.single_visit_customers ?? 0),
        in_window_repeat_rate_percent: ReportQuery.share(repeaters, customers),
        previously_known_customers: previouslyKnown,
        lifetime_repeat_rate_percent: ReportQuery.share(previouslyKnown, lifetimeCustomers),
        total_visits: Number(inWindow?.total_visits ?? 0),
        avg_visits_per_customer: ReportQuery.round(customers ? Number(inWindow?.total_visits ?? 0) / customers : 0),
        total_spent: totalSpent,
        repeat_customer_spend: repeatSpent,
        repeat_revenue_share_percent: ReportQuery.share(repeatSpent, totalSpent),
        previously_known_revenue: ReportQuery.round(ReportQuery.num(lifetime?.previously_known_revenue)),
        avg_spend_repeat_customer: ReportQuery.round(repeaters ? repeatSpent / repeaters : 0),
      },
      cohorts: cohortRows.map((row) => ({
        ...row,
        customer_share_percent: ReportQuery.share(row.customers, customers),
        revenue_share_percent: ReportQuery.share(row.total_spent, totalSpent),
      })),
      topRepeatCustomers: ReportQuery.numbers(topRepeat, [
        'visits',
        'total_spent',
        'avg_spend',
        'span_days',
      ]).map((row) => ({
        ...row,
        avg_days_between_visits:
          row.visits > 1 ? ReportQuery.round(row.span_days / (row.visits - 1)) : null,
      })),
    };
  }

  /**
   * Dashboard KPIs for a range, pulled from the same report services the
   * detail pages use.
   *
   * Distinct from `DashboardService.getMetrics()`, which answers "what is
   * happening right now" for the POS home screen. This one answers "how did
   * the chosen period do", and every number on it can be drilled into by
   * opening the matching report with the same range.
   */
  static async dashboardKpis(options: BiReportOptions) {
    await ReportsSchema.ensure();

    const [revenue, profit, aov, customers, valuation, topCategories, topProducts] = await Promise.all([
      ReportsFinanceService.revenue({ range: options.range, granularity: options.granularity ?? 'day' }),
      ReportsFinanceService.profit({ range: options.range, granularity: options.granularity ?? 'day' }),
      this.averageOrderValue({ range: options.range }),
      this.customerAnalytics({ range: options.range, limit: 5 }),
      stockSnapshot(),
      ReportsSalesService.byCategory({ range: options.range, limit: 5 }),
      ReportsSalesService.byProduct({ range: options.range, limit: 5 }),
    ]);

    return {
      range: options.range,
      kpis: {
        gross_sales: revenue.waterfall.gross_sales,
        net_sales: revenue.waterfall.net_sales,
        net_revenue: revenue.waterfall.net_revenue,
        refunds: revenue.waterfall.refunds,
        total_discount: revenue.waterfall.total_discount,
        tax_collected: revenue.waterfall.tax_amount,
        bills_count: revenue.summary.bills_count,
        trading_days: revenue.summary.trading_days,
        avg_order_value: aov.summary.avg_order_value,
        avg_items_per_bill: aov.summary.avg_items_per_bill,
        items_sold: aov.summary.items_sold,
        cogs: profit.summary.cogs,
        gross_profit: profit.summary.gross_profit,
        operating_expenses: profit.summary.operating_expenses,
        net_profit: profit.summary.net_profit,
        gross_margin_percent: profit.summary.gross_margin_percent,
        net_margin_percent: profit.summary.net_margin_percent,
        distinct_customers: customers.summary.distinct_customers,
        new_customers: customers.summary.new_customers,
        identified_bill_percent: customers.summary.identified_bill_percent,
        stock_value_at_cost: valuation.total_value_at_cost,
        low_stock_count: valuation.low_stock_count,
        out_of_stock_count: valuation.out_of_stock_count,
        revenue_growth_percent: revenue.comparison.net_revenue.growth_percent,
        profit_growth_percent: profit.comparison.net_profit.growth_percent,
        aov_growth_percent: aov.comparison.avg_order_value.growth_percent,
      },
      comparisonRange: revenue.comparisonRange,
      topCategories: topCategories.categories.slice(0, 5),
      topProducts: topProducts.products.slice(0, 5),
      topCustomers: customers.topCustomers.slice(0, 5),
      revenueSeries: revenue.series,
      profitSeries: profit.series,
    };
  }

  /**
   * Employee performance: throughput and discipline per operator.
   *
   * Sales come from `bills.cashier_id` (who settled) while order creation comes
   * from `orders.created_by` (who rang it up); on a single-till shop these are
   * the same person, but they diverge wherever a supervisor settles another
   * operator's order, so both are reported.
   */
  static async employeePerformance(options: BiReportOptions) {
    await ReportsSchema.ensure();
    const sales = await ReportsSalesService.byEmployee({ ...options });
    const { where, params } = ReportQuery.bills('b', options.range, options);

    const [orders, refunds, hours] = await Promise.all([
      dbService.query(
        `SELECT
           o.created_by                           AS user_id,
           COUNT(o.id)                            AS orders_created,
           COALESCE(SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS orders_cancelled,
           COALESCE(SUM(o.total_amount), 0)       AS orders_value
         FROM orders o
         ${ReportQuery.dateRange('o', options.range).where}
         GROUP BY o.created_by`,
        ReportQuery.dateRange('o', options.range).params
      ),
      dbService.query(
        `SELECT
           rf.refunded_by                         AS user_id,
           COUNT(rf.id)                           AS refunds_issued,
           COALESCE(SUM(rf.total_amount), 0)      AS refund_value
         FROM refunds rf
         ${ReportQuery.dateRange('rf', options.range).where}
           AND rf.status = 'COMPLETED'
         GROUP BY rf.refunded_by`,
        ReportQuery.dateRange('rf', options.range).params
      ),
      // Hours actually worked are not recorded, so throughput is measured over
      // the span between an operator's first and last bill each day.
      dbService.query(
        `SELECT
           b.cashier_id                           AS user_id,
           COALESCE(SUM(span_minutes), 0)         AS active_minutes
         FROM (
           SELECT
             b.cashier_id,
             DATE(b.created_at) AS trading_day,
             TIMESTAMPDIFF(MINUTE, MIN(b.created_at), MAX(b.created_at)) AS span_minutes
           FROM bills b
           ${where}
           GROUP BY b.cashier_id, DATE(b.created_at)
         ) b
         GROUP BY b.cashier_id`,
        params
      ),
    ]);

    const ordersByUser = new Map<number, any>(
      ReportQuery.numbers(orders, ['orders_created', 'orders_cancelled', 'orders_value']).map((row) => [
        Number(row.user_id),
        row,
      ])
    );
    const refundsByUser = new Map<number, any>(
      ReportQuery.numbers(refunds, ['refunds_issued', 'refund_value']).map((row) => [Number(row.user_id), row])
    );
    const minutesByUser = new Map<number, number>(
      hours.map((row: any) => [Number(row.user_id), ReportQuery.num(row.active_minutes)])
    );

    const employees = sales.employees.map((employee: any) => {
      const userId = Number(employee.user_id);
      const orderStats = ordersByUser.get(userId);
      const refundStats = refundsByUser.get(userId);
      const activeMinutes = minutesByUser.get(userId) ?? 0;
      const activeHours = ReportQuery.round(activeMinutes / 60);

      return {
        ...employee,
        orders_created: orderStats?.orders_created ?? 0,
        orders_cancelled: orderStats?.orders_cancelled ?? 0,
        order_cancellation_rate_percent: ReportQuery.share(
          orderStats?.orders_cancelled ?? 0,
          orderStats?.orders_created ?? 0
        ),
        refunds_issued: refundStats?.refunds_issued ?? 0,
        refund_value: refundStats?.refund_value ?? 0,
        active_hours: activeHours,
        bills_per_hour: activeHours > 0 ? ReportQuery.round(employee.bills_count / activeHours) : null,
        sales_per_hour: activeHours > 0 ? ReportQuery.round(employee.net_sales / activeHours) : null,
        avg_items_per_bill: ReportQuery.round(
          employee.bills_count ? employee.items_sold / employee.bills_count : 0
        ),
        discount_rate_percent: ReportQuery.share(employee.discount_given, employee.gross_sales),
      };
    });

    const ranked = [...employees]
      .sort((a, b) => b.net_sales - a.net_sales)
      .map((employee, index) => ({ ...employee, sales_rank: index + 1 }));

    const totalActiveHours = ranked.reduce((s, r) => s + (r.active_hours ?? 0), 0);

    return {
      range: options.range,
      summary: {
        ...sales.summary,
        total_orders_created: ranked.reduce((s, r) => s + r.orders_created, 0),
        total_refunds_issued: ranked.reduce((s, r) => s + r.refunds_issued, 0),
        total_active_hours: ReportQuery.round(totalActiveHours),
        avg_sales_per_hour: ReportQuery.round(
          totalActiveHours ? sales.summary.total_net_sales / totalActiveHours : 0
        ),
        top_performer: ranked[0]?.employee_name ?? null,
        top_performer_sales: ranked[0]?.net_sales ?? 0,
      },
      employees: ranked,
    };
  }

  /** Median of a numeric list; 0 for an empty one. */
  private static median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}

/**
 * The stock headline figures the KPI panel needs, without pulling the whole
 * item list a full valuation report would return.
 */
async function stockSnapshot() {
  const row = await dbService.queryOne(
    `SELECT
       COALESCE(SUM(si.current_value), 0)         AS total_value_at_cost,
       COALESCE(SUM(CASE WHEN si.current_quantity > 0 AND si.current_quantity <= si.min_stock_alert THEN 1 ELSE 0 END), 0) AS low_stock_count,
       COALESCE(SUM(CASE WHEN si.current_quantity <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count
     FROM stock_items si
     WHERE si.status = 'active'`
  );

  return {
    total_value_at_cost: ReportQuery.round(ReportQuery.num(row?.total_value_at_cost)),
    low_stock_count: Number(row?.low_stock_count ?? 0),
    out_of_stock_count: Number(row?.out_of_stock_count ?? 0),
  };
}
