/**
 * One way to compare phone numbers, so "98765 43209", "98765-43209" and
 * "9876543209" are the same customer everywhere: the payment dialog's
 * lookup, checkout's save, and creating a customer.
 */
export class PhoneUtil {
  /** Digits only, with a leading + kept. */
  static normalise(raw: unknown): string {
    const s = String(raw ?? '').trim();
    const plus = s.startsWith('+') ? '+' : '';
    return plus + s.replace(/\D/g, '');
  }

  /** 7 to 15 digits, once normalised. */
  static isValid(raw: unknown): boolean {
    const digits = this.normalise(raw).replace('+', '');
    return digits.length >= 7 && digits.length <= 15;
  }

  /** SQL for a stored phone column with the same punctuation stripped, to compare with normalise(). */
  static sqlColumn(column = 'phone'): string {
    return `REPLACE(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '(', ''), ')', '')`;
  }
}
