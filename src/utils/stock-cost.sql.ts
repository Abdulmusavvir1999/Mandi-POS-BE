/**
 * SQL for what one unit of a bill line cost in stock, at today's weighted
 * average cost.
 *
 * A line sold since bill_item_stock_usage exists is priced from its own
 * record: every stock item it drew (all of a Multi Stock recipe, each add-on
 * in a combo) times quantity_per_unit times that item's average cost. Older
 * lines have no record and keep the caller's original formula - which is all
 * those bills ever drew.
 *
 * Expects the bill line aliased `bi`. Multiply by bi.quantity for the line's
 * cost.
 */
export const lineUnitStockCost = (fallback: string) => `COALESCE(
  (SELECT SUM(r.quantity_per_unit * rs.average_unit_price)
     FROM bill_item_stock_usage r
     JOIN stocks rs ON rs.id = r.stock_id
    WHERE r.bill_item_id = bi.id),
  ${fallback}
)`;

/**
 * The common case: the dish's stock item joined as `si`
 * (LEFT JOIN stocks si ON si.id = p.stock_id), at stock_consumption per unit.
 */
export const LINE_UNIT_STOCK_COST = lineUnitStockCost(
  'COALESCE(bi.stock_consumption, 1) * COALESCE(si.average_unit_price, 0)'
);
