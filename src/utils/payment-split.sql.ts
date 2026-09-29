/**
 * SQL for bills that may be split across two payment modes.
 *
 * A single-mode bill carries its mode in bills.payment_method and is counted
 * at its total, as always. A split bill reads e.g. "CASH+UPI" there, and its
 * parts live in `payments` - one row per mode, for the amount taken.
 *
 * Single-mode bills keep using the bill total rather than their payment row:
 * rows written before the split change stored the cash handed over (tendered)
 * instead of the amount kept, so summing them would overstate cash.
 *
 * `billAlias` and `method` are interpolated: pass internal literals only.
 */

/** Amount of a bill taken in `method` (0 when that mode was not used). */
export function billMethodAmountSql(billAlias: string, method: string): string {
  const b = billAlias;
  return `(CASE
      WHEN ${b}.payment_method = '${method}' THEN ${b}.total_amount
      WHEN ${b}.payment_method LIKE '%+%' THEN (
        SELECT COALESCE(SUM(p_s.amount), 0) FROM payments p_s
        WHERE p_s.bill_id = ${b}.id AND p_s.payment_method = '${method}')
      ELSE 0 END)`;
}

/**
 * WHERE fragment matching bills paid (fully or partly) in a mode given as a
 * bound parameter. Push the mode twice: `params.push(mode, mode)`.
 */
export function billPaidWithSql(billAlias: string): string {
  const b = billAlias;
  return `(${b}.payment_method = ? OR (${b}.payment_method LIKE '%+%' AND EXISTS (
      SELECT 1 FROM payments p_f WHERE p_f.bill_id = ${b}.id AND p_f.payment_method = ?)))`;
}
