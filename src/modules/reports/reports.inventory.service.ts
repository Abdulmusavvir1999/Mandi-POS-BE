import { dbService } from '../../database/db';
import { ReportsSchema } from './reports.schema';
import { Granularity, ReportQuery, ReportRange } from './reports.query';

export interface InventoryReportOptions {
  range: ReportRange;
  stockItemId?: number;
  categoryId?: number;
  granularity?: Granularity;
  limit?: number;
}

export interface ValuationOptions {
  categoryId?: number;
  /** Only items at or below their reorder level. */
  lowStockOnly?: boolean;
  includeInactive?: boolean;
}

/**
 * Inventory reporting over the `stock_items` master and its ledgers.
 *
 * Two conventions of the stock module drive every query here:
 *
 * - `stock_movements.quantity` is **signed** — positive for `in`, negative for
 *   `out` and `wastage`. Summing it gives a net balance; `ABS()` is needed for
 *   an outflow volume, or the two directions cancel and wastage reads as zero.
 * - `stock_movements.total_value` is always **positive**, for both directions.
 *   It is the value that moved, with the direction carried by the type.
 *
 * Sales do not deplete stock in this system: nothing writes a movement with a
 * sale reference. Depletion is recorded by the manual `out` / `wastage`
 * adjustments, so the consumption report separates what was *booked out* from
 * what the till says was *sold* — see `consumption()`.
 */
export class ReportsInventoryService {
  /** Current stock valuation at cost and at retail. Point-in-time, not ranged. */
  static async stockValuation(options: ValuationOptions = {}) {
    await ReportsSchema.ensure();

    let where = options.includeInactive ? 'WHERE 1=1' : "WHERE si.status = 'active'";
    const params: any[] = [];
    if (options.categoryId) {
      where += ' AND p.category_id = ?';
      params.push(options.categoryId);
    }
    if (options.lowStockOnly) {
      where += ' AND si.current_quantity <= si.min_stock_alert';
    }

    const [items, totals, byCategory] = await Promise.all([
      dbService.query(
        `SELECT
           si.id                                  AS stock_item_id,
           si.stock_code,
           si.name                                AS item_name,
           si.unit_type,
           si.status,
           si.current_quantity,
           si.average_unit_price,
           si.current_value                       AS value_at_cost,
           si.min_stock_alert,
           si.updated_at                          AS last_updated_at,
           p.id                                   AS product_id,
           p.name                                 AS product_name,
           p.sku,
           COALESCE(p.selling_price, 0)           AS selling_price,
           COALESCE(c.name, 'Unlinked')           AS category_name,
           (si.current_quantity * COALESCE(NULLIF(p.selling_price, 0), si.average_unit_price)) AS value_at_retail,
           CASE
             WHEN si.current_quantity <= 0 THEN 'OUT_OF_STOCK'
             WHEN si.current_quantity <= si.min_stock_alert THEN 'LOW'
             ELSE 'OK'
           END                                    AS stock_status
         FROM stock_items si
         LEFT JOIN products p ON p.stock_item_id = si.id
         LEFT JOIN categories c ON p.category_id = c.id
         ${where}
         ORDER BY value_at_cost DESC`,
        params
      ),
      dbService.queryOne(
        `SELECT
           COUNT(si.id)                           AS items_count,
           COALESCE(SUM(si.current_quantity), 0)  AS total_quantity,
           COALESCE(SUM(si.current_value), 0)     AS total_value_at_cost,
           COALESCE(SUM(si.current_quantity * COALESCE(NULLIF(p.selling_price, 0), si.average_unit_price)), 0) AS total_value_at_retail,
           COALESCE(SUM(CASE WHEN si.current_quantity <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count,
           COALESCE(SUM(CASE WHEN si.current_quantity > 0 AND si.current_quantity <= si.min_stock_alert THEN 1 ELSE 0 END), 0) AS low_stock_count,
           COALESCE(SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END), 0) AS unlinked_count
         FROM stock_items si
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${where}`,
        params
      ),
      dbService.query(
        `SELECT
           COALESCE(c.name, 'Unlinked')           AS category_name,
           COUNT(si.id)                           AS items_count,
           COALESCE(SUM(si.current_quantity), 0)  AS total_quantity,
           COALESCE(SUM(si.current_value), 0)     AS total_value_at_cost,
           COALESCE(SUM(si.current_quantity * COALESCE(NULLIF(p.selling_price, 0), si.average_unit_price)), 0) AS total_value_at_retail
         FROM stock_items si
         LEFT JOIN products p ON p.stock_item_id = si.id
         LEFT JOIN categories c ON p.category_id = c.id
         ${where}
         GROUP BY c.name
         ORDER BY total_value_at_cost DESC`,
        params
      ),
    ]);

    const valueAtCost = ReportQuery.round(ReportQuery.num(totals?.total_value_at_cost));
    const valueAtRetail = ReportQuery.round(ReportQuery.num(totals?.total_value_at_retail));

    const rows = ReportQuery.numbers(items, [
      'current_quantity',
      'average_unit_price',
      'value_at_cost',
      'min_stock_alert',
      'selling_price',
      'value_at_retail',
    ]).map((row) => ({
      ...row,
      potential_margin: ReportQuery.round(row.value_at_retail - row.value_at_cost),
      value_share_percent: ReportQuery.share(row.value_at_cost, valueAtCost),
    }));

    return {
      asOf: new Date().toISOString(),
      summary: {
        items_count: Number(totals?.items_count ?? 0),
        total_quantity: ReportQuery.round(ReportQuery.num(totals?.total_quantity)),
        total_value_at_cost: valueAtCost,
        total_value_at_retail: valueAtRetail,
        potential_margin: ReportQuery.round(valueAtRetail - valueAtCost),
        potential_margin_percent: ReportQuery.share(valueAtRetail - valueAtCost, valueAtRetail),
        out_of_stock_count: Number(totals?.out_of_stock_count ?? 0),
        low_stock_count: Number(totals?.low_stock_count ?? 0),
        unlinked_items_count: Number(totals?.unlinked_count ?? 0),
      },
      byCategory: ReportQuery.numbers(byCategory, [
        'items_count',
        'total_quantity',
        'total_value_at_cost',
        'total_value_at_retail',
      ]).map((row) => ({
        ...row,
        potential_margin: ReportQuery.round(row.total_value_at_retail - row.total_value_at_cost),
        value_share_percent: ReportQuery.share(row.total_value_at_cost, valueAtCost),
      })),
      items: rows,
    };
  }

  /**
   * Stock movement ledger for the range: inflow, outflow and net change per
   * item, with the opening balance reconstructed from the movement history.
   */
  static async stockMovement(options: InventoryReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const scope = this.movementScope(options);
    const bucket = ReportQuery.bucket('sm', granularity, 'movement_date');

    const [byItem, byType, series, totals, opening] = await Promise.all([
      dbService.query(
        `SELECT
           si.id                                  AS stock_item_id,
           si.stock_code,
           si.name                                AS item_name,
           si.unit_type,
           si.current_quantity                    AS closing_quantity,
           COUNT(sm.id)                           AS movements_count,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0)      AS quantity_in,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) AS quantity_out,
           COALESCE(SUM(sm.quantity), 0)          AS net_quantity_change,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.total_value ELSE 0 END), 0)   AS value_in,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN sm.total_value ELSE 0 END), 0)   AS value_out,
           COALESCE(SUM(CASE WHEN sm.movement_type = 'wastage' THEN ABS(sm.quantity) ELSE 0 END), 0) AS wastage_quantity
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY si.id, si.stock_code, si.name, si.unit_type, si.current_quantity
         ORDER BY ABS(SUM(sm.quantity)) DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           sm.movement_type,
           COUNT(sm.id)                           AS movements_count,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS total_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS total_value,
           COUNT(DISTINCT sm.stock_item_id)       AS items_affected
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY sm.movement_type
         ORDER BY total_value DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(sm.id)                           AS movements_count,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0)      AS quantity_in,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) AS quantity_out,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.total_value ELSE 0 END), 0)   AS value_in,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN sm.total_value ELSE 0 END), 0)   AS value_out
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        scope.params
      ),
      dbService.queryOne(
        `SELECT
           COUNT(sm.id)                           AS movements_count,
           COUNT(DISTINCT sm.stock_item_id)       AS items_affected,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0)      AS quantity_in,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) AS quantity_out,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.total_value ELSE 0 END), 0)   AS value_in,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN sm.total_value ELSE 0 END), 0)   AS value_out
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}`,
        scope.params
      ),
      // Everything booked before the window, which is the opening balance.
      dbService.query(
        `SELECT sm.stock_item_id, COALESCE(SUM(sm.quantity), 0) AS opening_quantity
         FROM stock_movements sm
         WHERE sm.movement_date < ?
         GROUP BY sm.stock_item_id`,
        [options.range.startAt]
      ),
    ]);

    const openingByItem = new Map<number, number>(
      opening.map((row: any) => [Number(row.stock_item_id), ReportQuery.num(row.opening_quantity)])
    );

    const items = ReportQuery.numbers(byItem, [
      'closing_quantity',
      'movements_count',
      'quantity_in',
      'quantity_out',
      'net_quantity_change',
      'value_in',
      'value_out',
      'wastage_quantity',
    ]).map((row) => {
      const openingQuantity = ReportQuery.round(openingByItem.get(Number(row.stock_item_id)) ?? 0);
      return {
        ...row,
        opening_quantity: openingQuantity,
        computed_closing_quantity: ReportQuery.round(openingQuantity + row.net_quantity_change),
        turnover_percent: ReportQuery.share(row.quantity_out, openingQuantity + row.quantity_in),
      };
    });

    return {
      range: options.range,
      granularity,
      summary: {
        movements_count: Number(totals?.movements_count ?? 0),
        items_affected: Number(totals?.items_affected ?? 0),
        quantity_in: ReportQuery.round(ReportQuery.num(totals?.quantity_in)),
        quantity_out: ReportQuery.round(ReportQuery.num(totals?.quantity_out)),
        net_quantity_change: ReportQuery.round(
          ReportQuery.num(totals?.quantity_in) - ReportQuery.num(totals?.quantity_out)
        ),
        value_in: ReportQuery.round(ReportQuery.num(totals?.value_in)),
        value_out: ReportQuery.round(ReportQuery.num(totals?.value_out)),
        net_value_change: ReportQuery.round(ReportQuery.num(totals?.value_in) - ReportQuery.num(totals?.value_out)),
      },
      byType: ReportQuery.numbers(byType, [
        'movements_count',
        'total_quantity',
        'total_value',
        'items_affected',
      ]),
      series: ReportQuery.numbers(series, [
        'movements_count',
        'quantity_in',
        'quantity_out',
        'value_in',
        'value_out',
      ]),
      items,
    };
  }

  /**
   * Wastage: stock written off, by item, reason and period.
   *
   * The reason is the free-text `notes` the adjustment was recorded with
   * (the stock module requires a reason on every adjustment), so it is
   * reported verbatim rather than bucketed into codes that do not exist.
   */
  static async wastage(options: InventoryReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const scope = this.movementScope(options, "sm.movement_type = 'wastage'");
    const bucket = ReportQuery.bucket('sm', granularity, 'movement_date');

    // Consumption in the same window, for the wastage-to-consumption ratio.
    const consumedScope = this.movementScope(options, "sm.quantity < 0");

    const [totals, byItem, byReason, series, byUser, consumed] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(sm.id)                           AS events_count,
           COUNT(DISTINCT sm.stock_item_id)       AS items_affected,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS wasted_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS wasted_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}`,
        scope.params
      ),
      dbService.query(
        `SELECT
           si.id                                  AS stock_item_id,
           si.stock_code,
           si.name                                AS item_name,
           si.unit_type,
           COALESCE(c.name, 'Unlinked')           AS category_name,
           COUNT(sm.id)                           AS events_count,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS wasted_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS wasted_value,
           MAX(sm.movement_date)                  AS last_wasted_at
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         LEFT JOIN categories c ON p.category_id = c.id
         ${scope.where}
         GROUP BY si.id, si.stock_code, si.name, si.unit_type, c.name
         ORDER BY wasted_value DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           COALESCE(NULLIF(TRIM(sm.notes), ''), 'Unspecified') AS reason,
           COUNT(sm.id)                           AS events_count,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS wasted_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS wasted_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY reason
         ORDER BY wasted_value DESC
         LIMIT 50`,
        scope.params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(sm.id)                           AS events_count,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS wasted_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS wasted_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           u.id                                   AS user_id,
           COALESCE(u.name, 'System')             AS recorded_by,
           COUNT(sm.id)                           AS events_count,
           COALESCE(SUM(sm.total_value), 0)       AS wasted_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         LEFT JOIN users u ON sm.created_by = u.id
         ${scope.where}
         GROUP BY u.id, u.name
         ORDER BY wasted_value DESC`,
        scope.params
      ),
      dbService.queryOne(
        `SELECT
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS quantity_out,
           COALESCE(SUM(sm.total_value), 0)       AS value_out
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${consumedScope.where}`,
        consumedScope.params
      ),
    ]);

    const wastedValue = ReportQuery.round(ReportQuery.num(totals?.wasted_value));
    const outflowValue = ReportQuery.round(ReportQuery.num(consumed?.value_out));

    return {
      range: options.range,
      granularity,
      summary: {
        events_count: Number(totals?.events_count ?? 0),
        items_affected: Number(totals?.items_affected ?? 0),
        wasted_quantity: ReportQuery.round(ReportQuery.num(totals?.wasted_quantity)),
        wasted_value: wastedValue,
        total_outflow_value: outflowValue,
        wastage_percent_of_outflow: ReportQuery.share(wastedValue, outflowValue),
        avg_wasted_value_per_day: ReportQuery.round(options.range.days ? wastedValue / options.range.days : 0),
      },
      byItem: ReportQuery.numbers(byItem, ['events_count', 'wasted_quantity', 'wasted_value']).map((row) => ({
        ...row,
        value_share_percent: ReportQuery.share(row.wasted_value, wastedValue),
      })),
      byReason: ReportQuery.numbers(byReason, ['events_count', 'wasted_quantity', 'wasted_value']).map((row) => ({
        ...row,
        value_share_percent: ReportQuery.share(row.wasted_value, wastedValue),
      })),
      byUser: ReportQuery.numbers(byUser, ['events_count', 'wasted_value']),
      series: ReportQuery.numbers(series, ['events_count', 'wasted_quantity', 'wasted_value']),
    };
  }

  /**
   * Purchases: the `stock_entries` ledger, plus the invoice-level view from
   * `vendor_purchases` when the vendor module has been migrated.
   */
  static async purchase(options: InventoryReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const bucket = ReportQuery.bucket('se', granularity, 'entry_date');

    const { where, params } = ReportQuery.dateRange('se', options.range, 'entry_date');
    let scoped = `${where} AND se.status = 'posted'`;
    const args = [...params];
    if (options.stockItemId) {
      scoped += ' AND se.stock_item_id = ?';
      args.push(options.stockItemId);
    }

    const [totals, byItem, bySupplier, series, entries, vendorView] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(se.id)                           AS entries_count,
           COUNT(DISTINCT se.stock_item_id)       AS items_purchased,
           COUNT(DISTINCT se.supplier)            AS suppliers_count,
           COALESCE(SUM(se.total_quantity), 0)    AS total_quantity,
           COALESCE(SUM(se.total_price), 0)       AS total_spend,
           COALESCE(AVG(se.total_price), 0)       AS avg_entry_value
         FROM stock_entries se
         ${scoped}`,
        args
      ),
      dbService.query(
        `SELECT
           si.id                                  AS stock_item_id,
           si.stock_code,
           si.name                                AS item_name,
           si.unit_type,
           COUNT(se.id)                           AS entries_count,
           COALESCE(SUM(se.total_quantity), 0)    AS total_quantity,
           COALESCE(SUM(se.total_price), 0)       AS total_spend,
           COALESCE(AVG(se.unit_price), 0)        AS avg_unit_price,
           MIN(se.unit_price)                     AS min_unit_price,
           MAX(se.unit_price)                     AS max_unit_price,
           MAX(se.entry_date)                     AS last_purchased_at
         FROM stock_entries se
         JOIN stock_items si ON se.stock_item_id = si.id
         ${scoped}
         GROUP BY si.id, si.stock_code, si.name, si.unit_type
         ORDER BY total_spend DESC`,
        args
      ),
      dbService.query(
        `SELECT
           COALESCE(NULLIF(TRIM(se.supplier), ''), 'Unattributed') AS supplier,
           COUNT(se.id)                           AS entries_count,
           COUNT(DISTINCT se.stock_item_id)       AS items_supplied,
           COALESCE(SUM(se.total_quantity), 0)    AS total_quantity,
           COALESCE(SUM(se.total_price), 0)       AS total_spend,
           MAX(se.entry_date)                     AS last_purchased_at
         FROM stock_entries se
         ${scoped}
         GROUP BY supplier
         ORDER BY total_spend DESC`,
        args
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(se.id)                           AS entries_count,
           COALESCE(SUM(se.total_quantity), 0)    AS total_quantity,
           COALESCE(SUM(se.total_price), 0)       AS total_spend
         FROM stock_entries se
         ${scoped}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        args
      ),
      dbService.query(
        `SELECT
           se.id,
           se.entry_number,
           se.entry_date,
           se.quantity,
           se.multiplier,
           se.total_quantity,
           se.unit_price,
           se.total_price,
           se.supplier,
           se.invoice_number,
           si.name                                AS item_name,
           si.stock_code,
           si.unit_type,
           COALESCE(u.name, 'System')             AS created_by_name
         FROM stock_entries se
         JOIN stock_items si ON se.stock_item_id = si.id
         LEFT JOIN users u ON se.created_by = u.id
         ${scoped}
         ORDER BY se.entry_date DESC, se.id DESC
         LIMIT ?`,
        [...args, options.limit ?? 200]
      ),
      this.vendorPurchaseSummary(options.range),
    ]);

    const totalSpend = ReportQuery.round(ReportQuery.num(totals?.total_spend));

    return {
      range: options.range,
      granularity,
      summary: {
        entries_count: Number(totals?.entries_count ?? 0),
        items_purchased: Number(totals?.items_purchased ?? 0),
        suppliers_count: Number(totals?.suppliers_count ?? 0),
        total_quantity: ReportQuery.round(ReportQuery.num(totals?.total_quantity)),
        total_spend: totalSpend,
        avg_entry_value: ReportQuery.round(ReportQuery.num(totals?.avg_entry_value)),
        avg_spend_per_day: ReportQuery.round(options.range.days ? totalSpend / options.range.days : 0),
      },
      byItem: ReportQuery.numbers(byItem, [
        'entries_count',
        'total_quantity',
        'total_spend',
        'avg_unit_price',
        'min_unit_price',
        'max_unit_price',
      ]).map((row) => ({
        ...row,
        spend_share_percent: ReportQuery.share(row.total_spend, totalSpend),
        /** A wide spread means the item was bought at inconsistent rates. */
        unit_price_spread: ReportQuery.round(row.max_unit_price - row.min_unit_price),
      })),
      bySupplier: ReportQuery.numbers(bySupplier, [
        'entries_count',
        'items_supplied',
        'total_quantity',
        'total_spend',
      ]).map((row) => ({
        ...row,
        spend_share_percent: ReportQuery.share(row.total_spend, totalSpend),
      })),
      series: ReportQuery.numbers(series, ['entries_count', 'total_quantity', 'total_spend']),
      entries: ReportQuery.numbers(entries, [
        'quantity',
        'multiplier',
        'total_quantity',
        'unit_price',
        'total_price',
      ]),
      vendorInvoices: vendorView,
    };
  }

  /**
   * Consumption: what left the store, and how that compares to what the till
   * says was sold.
   *
   * `booked` is the recorded depletion from the movement ledger. `sold` is the
   * stock those sales *should* have drawn, derived from the menu-to-stock link
   * (`products.stock_item_id` and the per-line `stock_consumption`). The gap
   * between them is the untracked depletion — the single most useful number
   * here, and it is only available on a database that has the link columns.
   */
  static async consumption(options: InventoryReportOptions) {
    await ReportsSchema.ensure();
    const caps = await ReportsSchema.capabilities();
    const granularity = options.granularity ?? 'day';
    const scope = this.movementScope(options, 'sm.quantity < 0');
    const bucket = ReportQuery.bucket('sm', granularity, 'movement_date');

    const [totals, byItem, byType, series] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(sm.id)                           AS movements_count,
           COUNT(DISTINCT sm.stock_item_id)       AS items_consumed,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS consumed_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS consumed_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}`,
        scope.params
      ),
      dbService.query(
        `SELECT
           si.id                                  AS stock_item_id,
           si.stock_code,
           si.name                                AS item_name,
           si.unit_type,
           si.current_quantity,
           si.average_unit_price,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS consumed_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS consumed_value,
           COALESCE(SUM(CASE WHEN sm.movement_type = 'wastage' THEN ABS(sm.quantity) ELSE 0 END), 0) AS wasted_quantity
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY si.id, si.stock_code, si.name, si.unit_type, si.current_quantity, si.average_unit_price
         ORDER BY consumed_value DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           sm.movement_type,
           COUNT(sm.id)                           AS movements_count,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS consumed_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS consumed_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY sm.movement_type
         ORDER BY consumed_value DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COALESCE(SUM(ABS(sm.quantity)), 0)     AS consumed_quantity,
           COALESCE(SUM(sm.total_value), 0)       AS consumed_value
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        scope.params
      ),
    ]);

    const soldDepletion = caps.productStockLink ? await this.soldDepletion(options) : null;

    const consumedQuantity = ReportQuery.round(ReportQuery.num(totals?.consumed_quantity));
    const consumedValue = ReportQuery.round(ReportQuery.num(totals?.consumed_value));

    const soldByItem = new Map<number, { quantity: number; value: number }>(
      (soldDepletion?.items ?? []).map((row) => [row.stock_item_id, { quantity: row.sold_quantity, value: row.sold_value }])
    );

    return {
      range: options.range,
      granularity,
      basis: caps.productStockLink
        ? 'booked depletion from stock_movements, compared to sales-implied depletion via products.stock_item_id'
        : 'booked depletion from stock_movements only; this database has no products.stock_item_id link',
      summary: {
        movements_count: Number(totals?.movements_count ?? 0),
        items_consumed: Number(totals?.items_consumed ?? 0),
        booked_quantity: consumedQuantity,
        booked_value: consumedValue,
        sold_quantity: soldDepletion?.summary.sold_quantity ?? null,
        sold_value: soldDepletion?.summary.sold_value ?? null,
        untracked_quantity:
          soldDepletion ? ReportQuery.round(soldDepletion.summary.sold_quantity - consumedQuantity) : null,
        untracked_value: soldDepletion ? ReportQuery.round(soldDepletion.summary.sold_value - consumedValue) : null,
        avg_consumed_value_per_day: ReportQuery.round(options.range.days ? consumedValue / options.range.days : 0),
      },
      byItem: ReportQuery.numbers(byItem, [
        'current_quantity',
        'average_unit_price',
        'consumed_quantity',
        'consumed_value',
        'wasted_quantity',
      ]).map((row) => {
        const sold = soldByItem.get(Number(row.stock_item_id));
        const dailyBurn = options.range.days ? row.consumed_quantity / options.range.days : 0;
        return {
          ...row,
          sold_quantity: sold ? sold.quantity : null,
          untracked_quantity: sold ? ReportQuery.round(sold.quantity - row.consumed_quantity) : null,
          wastage_percent: ReportQuery.share(row.wasted_quantity, row.consumed_quantity),
          avg_daily_burn: ReportQuery.round(dailyBurn),
          /** Days of cover left at the observed burn rate. */
          days_of_cover: dailyBurn > 0 ? ReportQuery.round(row.current_quantity / dailyBurn) : null,
        };
      }),
      byType: ReportQuery.numbers(byType, ['movements_count', 'consumed_quantity', 'consumed_value']),
      series: ReportQuery.numbers(series, ['consumed_quantity', 'consumed_value']),
      soldDepletionByItem: soldDepletion?.items ?? null,
    };
  }

  /**
   * Food cost: cost of goods sold as a share of revenue, overall and by
   * category, with the purchase-to-sales ratio alongside it.
   *
   * Two different measures, deliberately both reported:
   *
   * - **recipe food cost** — `quantity x products.cost_price` over the billed
   *   lines. Stable, but only as accurate as the maintained cost prices.
   * - **purchase food cost** — what was actually spent on stock in the window
   *   over revenue in the same window. Noisy for a short range, since a bulk
   *   delivery lands in one period and is eaten across several.
   */
  static async foodCost(options: InventoryReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const billScope = ReportQuery.bills('b', options.range);
    const bucket = ReportQuery.bucket('b', granularity);

    let categoryFilter = '';
    const categoryArgs: any[] = [];
    if (options.categoryId) {
      categoryFilter = ' AND p.category_id = ?';
      categoryArgs.push(options.categoryId);
    }

    const [totals, byCategory, byProduct, series, purchases, consumedValue] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COALESCE(SUM(bi.total_amount), 0)                        AS revenue,
           COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs,
           COALESCE(SUM(bi.quantity), 0)                            AS quantity_sold,
           COUNT(DISTINCT bi.bill_id)                               AS bills_count
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         ${billScope.where}${categoryFilter}`,
        [...billScope.params, ...categoryArgs]
      ),
      dbService.query(
        `SELECT
           COALESCE(c.name, 'Uncategorised')                        AS category_name,
           c.id                                                     AS category_id,
           COALESCE(SUM(bi.quantity), 0)                            AS quantity_sold,
           COALESCE(SUM(bi.total_amount), 0)                        AS revenue,
           COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         LEFT JOIN categories c ON p.category_id = c.id
         ${billScope.where}${categoryFilter}
         GROUP BY c.id, c.name
         ORDER BY revenue DESC`,
        [...billScope.params, ...categoryArgs]
      ),
      dbService.query(
        `SELECT
           p.id                                                     AS product_id,
           p.name                                                   AS product_name,
           p.sku,
           COALESCE(p.cost_price, 0)                                AS cost_price,
           COALESCE(p.selling_price, 0)                             AS selling_price,
           COALESCE(SUM(bi.quantity), 0)                            AS quantity_sold,
           COALESCE(SUM(bi.total_amount), 0)                        AS revenue,
           COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         ${billScope.where}${categoryFilter}
         GROUP BY p.id, p.name, p.sku, p.cost_price, p.selling_price
         ORDER BY cogs DESC
         LIMIT ?`,
        [...billScope.params, ...categoryArgs, options.limit ?? 100]
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                                          AS period,
           ${bucket.start}                                          AS period_start,
           COALESCE(SUM(bi.total_amount), 0)                        AS revenue,
           COALESCE(SUM(bi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
         FROM bill_items bi
         JOIN bills b ON bi.bill_id = b.id
         JOIN products p ON bi.product_id = p.id
         ${billScope.where}${categoryFilter}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        [...billScope.params, ...categoryArgs]
      ),
      dbService.queryOne(
        `SELECT COALESCE(SUM(se.total_price), 0) AS purchase_spend
         FROM stock_entries se
         ${ReportQuery.dateRange('se', options.range, 'entry_date').where}
           AND se.status = 'posted'`,
        ReportQuery.dateRange('se', options.range, 'entry_date').params
      ),
      dbService.queryOne(
        `SELECT COALESCE(SUM(sm.total_value), 0) AS consumed_value
         FROM stock_movements sm
         ${ReportQuery.dateRange('sm', options.range, 'movement_date').where}
           AND sm.quantity < 0`,
        ReportQuery.dateRange('sm', options.range, 'movement_date').params
      ),
    ]);

    const revenue = ReportQuery.round(ReportQuery.num(totals?.revenue));
    const cogs = ReportQuery.round(ReportQuery.num(totals?.cogs));
    const purchaseSpend = ReportQuery.round(ReportQuery.num(purchases?.purchase_spend));
    const stockConsumed = ReportQuery.round(ReportQuery.num(consumedValue?.consumed_value));

    return {
      range: options.range,
      granularity,
      summary: {
        revenue,
        recipe_cogs: cogs,
        recipe_food_cost_percent: ReportQuery.share(cogs, revenue),
        gross_profit: ReportQuery.round(revenue - cogs),
        gross_margin_percent: ReportQuery.share(revenue - cogs, revenue),
        purchase_spend: purchaseSpend,
        purchase_food_cost_percent: ReportQuery.share(purchaseSpend, revenue),
        stock_consumed_value: stockConsumed,
        stock_consumed_percent: ReportQuery.share(stockConsumed, revenue),
        quantity_sold: ReportQuery.round(ReportQuery.num(totals?.quantity_sold)),
        bills_count: Number(totals?.bills_count ?? 0),
      },
      byCategory: ReportQuery.numbers(byCategory, ['quantity_sold', 'revenue', 'cogs']).map((row) => ({
        ...row,
        gross_profit: ReportQuery.round(row.revenue - row.cogs),
        food_cost_percent: ReportQuery.share(row.cogs, row.revenue),
        margin_percent: ReportQuery.share(row.revenue - row.cogs, row.revenue),
        revenue_share_percent: ReportQuery.share(row.revenue, revenue),
      })),
      byProduct: ReportQuery.numbers(byProduct, [
        'cost_price',
        'selling_price',
        'quantity_sold',
        'revenue',
        'cogs',
      ]).map((row) => ({
        ...row,
        gross_profit: ReportQuery.round(row.revenue - row.cogs),
        food_cost_percent: ReportQuery.share(row.cogs, row.revenue),
        margin_percent: ReportQuery.share(row.revenue - row.cogs, row.revenue),
      })),
      series: ReportQuery.numbers(series, ['revenue', 'cogs']).map((row) => ({
        ...row,
        food_cost_percent: ReportQuery.share(row.cogs, row.revenue),
      })),
    };
  }

  /**
   * Inventory variance: the master balance against its own ledger.
   *
   * Two independent checks per item, because they fail for different reasons:
   *
   * - **ledger variance** — `current_quantity` against the sum of every
   *   movement ever recorded. A non-zero result means a balance was written
   *   without a movement row (a direct edit, or a failed partial transaction).
   * - **last-balance variance** — `current_quantity` against the running
   *   `balance_quantity` stamped on the most recent movement. A non-zero
   *   result means the master moved after its last ledger entry.
   *
   * This report is deliberately not date-ranged: a variance is a property of
   * the whole history, and truncating the ledger to a window would manufacture
   * a variance out of the opening balance.
   */
  static async variance(options: { stockItemId?: number; onlyDiscrepancies?: boolean; tolerance?: number } = {}) {
    await ReportsSchema.ensure();
    const tolerance = options.tolerance ?? 0.001;

    let where = "WHERE si.status = 'active'";
    const params: any[] = [];
    if (options.stockItemId) {
      where += ' AND si.id = ?';
      params.push(options.stockItemId);
    }

    const rows = await dbService.query(
      `SELECT
         si.id                                    AS stock_item_id,
         si.stock_code,
         si.name                                  AS item_name,
         si.unit_type,
         si.current_quantity                      AS system_quantity,
         si.current_value                         AS system_value,
         si.average_unit_price,
         COALESCE(ledger.ledger_quantity, 0)      AS ledger_quantity,
         COALESCE(ledger.movements_count, 0)      AS movements_count,
         last_move.balance_quantity               AS last_recorded_balance,
         last_move.movement_date                  AS last_movement_at
       FROM stock_items si
       LEFT JOIN (
         SELECT stock_item_id,
                SUM(quantity) AS ledger_quantity,
                COUNT(*)      AS movements_count
         FROM stock_movements
         GROUP BY stock_item_id
       ) ledger ON ledger.stock_item_id = si.id
       LEFT JOIN (
         SELECT sm.stock_item_id, sm.balance_quantity, sm.movement_date
         FROM stock_movements sm
         JOIN (
           SELECT stock_item_id, MAX(id) AS max_id
           FROM stock_movements
           GROUP BY stock_item_id
         ) latest ON latest.max_id = sm.id
       ) last_move ON last_move.stock_item_id = si.id
       ${where}
       ORDER BY ABS(si.current_quantity - COALESCE(ledger.ledger_quantity, 0)) DESC`,
      params
    );

    const items = ReportQuery.numbers(rows, [
      'system_quantity',
      'system_value',
      'average_unit_price',
      'ledger_quantity',
      'movements_count',
      'last_recorded_balance',
    ]).map((row) => {
      const ledgerVariance = ReportQuery.round(row.system_quantity - row.ledger_quantity);
      const hasLedger = row.movements_count > 0;
      const balanceVariance = hasLedger
        ? ReportQuery.round(row.system_quantity - row.last_recorded_balance)
        : null;
      return {
        ...row,
        last_recorded_balance: hasLedger ? row.last_recorded_balance : null,
        ledger_variance: ledgerVariance,
        ledger_variance_value: ReportQuery.round(ledgerVariance * row.average_unit_price),
        ledger_variance_percent: ReportQuery.share(Math.abs(ledgerVariance), Math.abs(row.ledger_quantity)),
        balance_variance: balanceVariance,
        has_ledger: hasLedger,
        is_discrepant:
          Math.abs(ledgerVariance) > tolerance || (balanceVariance !== null && Math.abs(balanceVariance) > tolerance),
      };
    });

    const discrepant = items.filter((row) => row.is_discrepant);

    return {
      asOf: new Date().toISOString(),
      tolerance,
      summary: {
        items_checked: items.length,
        items_discrepant: discrepant.length,
        items_without_ledger: items.filter((row) => !row.has_ledger).length,
        clean_percent: ReportQuery.share(items.length - discrepant.length, items.length),
        net_variance_quantity: ReportQuery.round(discrepant.reduce((s, r) => s + r.ledger_variance, 0)),
        net_variance_value: ReportQuery.round(discrepant.reduce((s, r) => s + r.ledger_variance_value, 0)),
        absolute_variance_value: ReportQuery.round(
          discrepant.reduce((s, r) => s + Math.abs(r.ledger_variance_value), 0)
        ),
      },
      items: options.onlyDiscrepancies ? discrepant : items,
    };
  }

  /**
   * Stock adjustments: manual corrections, by item, reason and operator.
   *
   * Scoped to `movement_type = 'adjustment'` — a wastage write-off is an
   * adjustment mechanically but has its own report, and lumping the two
   * together would hide deliberate write-offs inside audit corrections.
   */
  static async adjustments(options: InventoryReportOptions) {
    await ReportsSchema.ensure();
    const granularity = options.granularity ?? 'day';
    const scope = this.movementScope(options, "sm.movement_type = 'adjustment'");
    const bucket = ReportQuery.bucket('sm', granularity, 'movement_date');

    const [totals, byItem, byReason, byUser, series, recent] = await Promise.all([
      dbService.queryOne(
        `SELECT
           COUNT(sm.id)                           AS adjustments_count,
           COUNT(DISTINCT sm.stock_item_id)       AS items_affected,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0)      AS quantity_increased,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) AS quantity_decreased,
           COALESCE(SUM(sm.quantity), 0)          AS net_quantity_change,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.total_value ELSE 0 END), 0)   AS value_increased,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN sm.total_value ELSE 0 END), 0)   AS value_decreased
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}`,
        scope.params
      ),
      dbService.query(
        `SELECT
           si.id                                  AS stock_item_id,
           si.stock_code,
           si.name                                AS item_name,
           si.unit_type,
           COUNT(sm.id)                           AS adjustments_count,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0)      AS quantity_increased,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) AS quantity_decreased,
           COALESCE(SUM(sm.quantity), 0)          AS net_quantity_change,
           COALESCE(SUM(sm.total_value), 0)       AS total_value_moved,
           MAX(sm.movement_date)                  AS last_adjusted_at
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY si.id, si.stock_code, si.name, si.unit_type
         ORDER BY adjustments_count DESC, total_value_moved DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           COALESCE(NULLIF(TRIM(sm.notes), ''), 'Unspecified') AS reason,
           COUNT(sm.id)                           AS adjustments_count,
           COALESCE(SUM(sm.quantity), 0)          AS net_quantity_change,
           COALESCE(SUM(sm.total_value), 0)       AS total_value_moved
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY reason
         ORDER BY adjustments_count DESC
         LIMIT 50`,
        scope.params
      ),
      dbService.query(
        `SELECT
           u.id                                   AS user_id,
           COALESCE(u.name, 'System')             AS adjusted_by,
           COUNT(sm.id)                           AS adjustments_count,
           COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm.quantity ELSE 0 END), 0)      AS quantity_increased,
           COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN ABS(sm.quantity) ELSE 0 END), 0) AS quantity_decreased,
           COALESCE(SUM(sm.total_value), 0)       AS total_value_moved
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         LEFT JOIN users u ON sm.created_by = u.id
         ${scope.where}
         GROUP BY u.id, u.name
         ORDER BY adjustments_count DESC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           ${bucket.label}                        AS period,
           ${bucket.start}                        AS period_start,
           COUNT(sm.id)                           AS adjustments_count,
           COALESCE(SUM(sm.quantity), 0)          AS net_quantity_change,
           COALESCE(SUM(sm.total_value), 0)       AS total_value_moved
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         ${scope.where}
         GROUP BY period, period_start
         ORDER BY period_start ASC`,
        scope.params
      ),
      dbService.query(
        `SELECT
           sm.id,
           sm.movement_date,
           sm.reference_id,
           sm.quantity,
           sm.unit_price,
           sm.total_value,
           sm.balance_quantity,
           sm.notes                               AS reason,
           si.name                                AS item_name,
           si.stock_code,
           si.unit_type,
           COALESCE(u.name, 'System')             AS adjusted_by
         FROM stock_movements sm
         JOIN stock_items si ON sm.stock_item_id = si.id
         LEFT JOIN products p ON p.stock_item_id = si.id
         LEFT JOIN users u ON sm.created_by = u.id
         ${scope.where}
         ORDER BY sm.movement_date DESC, sm.id DESC
         LIMIT ?`,
        [...scope.params, options.limit ?? 200]
      ),
    ]);

    return {
      range: options.range,
      granularity,
      summary: {
        adjustments_count: Number(totals?.adjustments_count ?? 0),
        items_affected: Number(totals?.items_affected ?? 0),
        quantity_increased: ReportQuery.round(ReportQuery.num(totals?.quantity_increased)),
        quantity_decreased: ReportQuery.round(ReportQuery.num(totals?.quantity_decreased)),
        net_quantity_change: ReportQuery.round(ReportQuery.num(totals?.net_quantity_change)),
        value_increased: ReportQuery.round(ReportQuery.num(totals?.value_increased)),
        value_decreased: ReportQuery.round(ReportQuery.num(totals?.value_decreased)),
        net_value_change: ReportQuery.round(
          ReportQuery.num(totals?.value_increased) - ReportQuery.num(totals?.value_decreased)
        ),
        avg_adjustments_per_day: ReportQuery.round(
          options.range.days ? Number(totals?.adjustments_count ?? 0) / options.range.days : 0
        ),
      },
      byItem: ReportQuery.numbers(byItem, [
        'adjustments_count',
        'quantity_increased',
        'quantity_decreased',
        'net_quantity_change',
        'total_value_moved',
      ]),
      byReason: ReportQuery.numbers(byReason, ['adjustments_count', 'net_quantity_change', 'total_value_moved']),
      byUser: ReportQuery.numbers(byUser, [
        'adjustments_count',
        'quantity_increased',
        'quantity_decreased',
        'total_value_moved',
      ]),
      series: ReportQuery.numbers(series, ['adjustments_count', 'net_quantity_change', 'total_value_moved']),
      adjustments: ReportQuery.numbers(recent, ['quantity', 'unit_price', 'total_value', 'balance_quantity']),
    };
  }

  /**
   * Stock the range's sales should have drawn down, via the menu-to-stock link.
   *
   * Only reachable when `products.stock_item_id` exists. The per-line
   * `stock_consumption` is how many stock units one sold unit draws (a half
   * portion draws less than a full), defaulting to 1 where absent.
   */
  private static async soldDepletion(options: InventoryReportOptions) {
    const caps = await ReportsSchema.capabilities();
    const billScope = ReportQuery.bills('b', options.range);
    const consumptionExpr = caps.billItemConsumption ? 'COALESCE(bi.stock_consumption, 1)' : '1';

    const rows = await dbService.query(
      `SELECT
         si.id                                    AS stock_item_id,
         si.stock_code,
         si.name                                  AS item_name,
         si.unit_type,
         si.average_unit_price,
         COALESCE(SUM(bi.quantity * ${consumptionExpr}), 0) AS sold_quantity,
         COALESCE(SUM(bi.quantity * ${consumptionExpr} * si.average_unit_price), 0) AS sold_value
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.id
       JOIN products p ON bi.product_id = p.id
       JOIN stock_items si ON p.stock_item_id = si.id
       ${billScope.where}
       GROUP BY si.id, si.stock_code, si.name, si.unit_type, si.average_unit_price
       ORDER BY sold_value DESC`,
      billScope.params
    );

    const items = ReportQuery.numbers(rows, ['average_unit_price', 'sold_quantity', 'sold_value']);

    return {
      items,
      summary: {
        sold_quantity: ReportQuery.round(items.reduce((s, r) => s + r.sold_quantity, 0)),
        sold_value: ReportQuery.round(items.reduce((s, r) => s + r.sold_value, 0)),
      },
    };
  }

  /**
   * Invoice-level purchases from the vendor module. Returns null when that
   * migration has not been applied, rather than failing the whole report.
   */
  private static async vendorPurchaseSummary(range: ReportRange) {
    try {
      const { where, params } = ReportQuery.dateRange('vp', range, 'order_date');
      const totals = await dbService.queryOne(
        `SELECT
           COUNT(vp.id)                           AS invoices_count,
           COUNT(DISTINCT vp.vendor_id)           AS vendors_count,
           COALESCE(SUM(vp.total_amount), 0)      AS total_amount,
           COALESCE(SUM(vp.paid_amount), 0)       AS paid_amount,
           COALESCE(SUM(vp.total_amount - vp.paid_amount), 0) AS outstanding_amount
         FROM vendor_purchases vp
         ${where}`,
        params
      );
      const byVendor = await dbService.query(
        `SELECT
           v.id                                   AS vendor_id,
           v.name                                 AS vendor_name,
           v.category,
           COUNT(vp.id)                           AS invoices_count,
           COALESCE(SUM(vp.total_amount), 0)      AS total_amount,
           COALESCE(SUM(vp.paid_amount), 0)       AS paid_amount,
           COALESCE(SUM(vp.total_amount - vp.paid_amount), 0) AS outstanding_amount
         FROM vendor_purchases vp
         JOIN vendors v ON vp.vendor_id = v.id
         ${where}
         GROUP BY v.id, v.name, v.category
         ORDER BY total_amount DESC`,
        params
      );

      return {
        summary: {
          invoices_count: Number(totals?.invoices_count ?? 0),
          vendors_count: Number(totals?.vendors_count ?? 0),
          total_amount: ReportQuery.round(ReportQuery.num(totals?.total_amount)),
          paid_amount: ReportQuery.round(ReportQuery.num(totals?.paid_amount)),
          outstanding_amount: ReportQuery.round(ReportQuery.num(totals?.outstanding_amount)),
        },
        byVendor: ReportQuery.numbers(byVendor, [
          'invoices_count',
          'total_amount',
          'paid_amount',
          'outstanding_amount',
        ]),
      };
    } catch {
      return null;
    }
  }

  /**
   * Movement-table `WHERE` shared by the ledger reports. The `products` join is
   * present in every caller so a `categoryId` filter can reach the category.
   */
  private static movementScope(options: InventoryReportOptions, extra?: string) {
    const { where, params } = ReportQuery.dateRange('sm', options.range, 'movement_date');
    let scoped = where;
    const args = [...params];

    if (extra) scoped += ` AND ${extra}`;
    if (options.stockItemId) {
      scoped += ' AND sm.stock_item_id = ?';
      args.push(options.stockItemId);
    }
    if (options.categoryId) {
      scoped += ' AND p.category_id = ?';
      args.push(options.categoryId);
    }

    return { where: scoped, params: args };
  }
}
