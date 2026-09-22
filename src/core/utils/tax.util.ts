/**
 * How tax turns a taxable amount into a bill total, in one place.
 *
 * Two rules are in play, and the same menu price produces two different bills
 * depending on which one is configured:
 *
 *   EXCLUSIVE — the menu price is net. The tax is added on top, so the guest
 *               pays more than the card says.
 *   INCLUSIVE — the menu price already contains the tax. Nothing is added; the
 *               tax is *extracted* from the amount so the tax line, the GST
 *               return and the reports still have a figure, and the guest pays
 *               exactly what the card says.
 *
 * Every total in the system — the till, the order, the invoice, a later
 * re-price — has to reach the same answer, so they all come through here
 * rather than each writing `taxable * rate / 100` again.
 *
 * Service charge and surcharge are outside this entirely: they are added after
 * tax under both rules, which is how they have always been handled.
 */

/** The configured rule. `rate` is a percentage: 5 means 5%. */
export interface TaxPolicy {
  /** False zeroes the tax. Under INCLUSIVE that raises no total — the tax was
   *  never added — it only stops the bill claiming a tax was collected. */
  enabled: boolean;
  rate: number;
  /** True when the menu price already contains the tax. */
  inclusive: boolean;
}

/** What stands in when settings cannot be read at all. */
export const DEFAULT_TAX_POLICY: TaxPolicy = { enabled: true, rate: 5.0, inclusive: false };

export const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

export interface TaxSplit {
  /** Value before tax. */
  net: number;
  tax: number;
  /** What the bill is worth before service charge and surcharge. */
  gross: number;
}

/**
 * Splits a taxable amount under the configured rule.
 *
 * Callers never have to branch: add service charge and surcharge to `gross`
 * for the grand total and store `tax` on the record, whichever rule is on.
 * Under EXCLUSIVE `gross` is the amount plus the tax; under INCLUSIVE it is
 * the amount itself, with `net` sitting below it.
 */
export function splitTax(taxableAmount: number, policy: TaxPolicy): TaxSplit {
  const amount = Math.max(0, round2(taxableAmount));
  const rate = policy.enabled ? Number(policy.rate) || 0 : 0;

  if (rate <= 0 || amount <= 0) {
    return { net: amount, tax: 0, gross: amount };
  }

  if (policy.inclusive) {
    const net = round2(amount / (1 + rate / 100));
    return { net, tax: round2(amount - net), gross: amount };
  }

  const tax = round2((amount * rate) / 100);
  return { net: amount, tax, gross: round2(amount + tax) };
}

/**
 * The share of a taxable base that a rate takes, as a percentage.
 *
 * Under EXCLUSIVE that is the rate itself. Under INCLUSIVE the tax is already
 * inside the base, so 5% of the net is only 4.7619% of the gross — which is
 * the figure a record's stored tax ÷ stored base actually reports, and the one
 * to compare it against.
 */
export function effectiveTaxShare(policy: TaxPolicy): number {
  const rate = policy.enabled ? Number(policy.rate) || 0 : 0;
  if (rate <= 0) return 0;
  return policy.inclusive ? (rate / (100 + rate)) * 100 : rate;
}

/**
 * Whether a stored record's total already contained its tax.
 *
 * A record re-priced later has to keep the rule it was written under: the
 * setting may have been switched since, and a bill from last month must not
 * quietly move onto today's rule and change what the guest was charged. The
 * record answers for itself — under EXCLUSIVE its total is the taxable base
 * plus the tax, under INCLUSIVE it is the base alone — and `fallback` only
 * decides records that carry no tax, where the two are the same number.
 */
export function wasTaxIncludedInTotal(
  taxableAmount: number,
  taxAmount: number,
  extraCharges: number,
  storedTotal: number,
  fallback: boolean
): boolean {
  const tax = round2(taxAmount);
  if (tax <= 0) return fallback;

  const exclusiveTotal = round2(taxableAmount + tax + extraCharges);
  const inclusiveTotal = round2(taxableAmount + extraCharges);
  const total = round2(storedTotal);

  return Math.abs(total - inclusiveTotal) < Math.abs(total - exclusiveTotal);
}
