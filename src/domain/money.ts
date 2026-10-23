import { ValidationError } from "./errors";

export const CURRENCIES = ["NGN", "USD", "EUR", "GBP"] as const;

export type Currency = (typeof CURRENCIES)[number];

/** Smallest billable amount is one minor unit (one kobo or one cent). */
export const MIN_AMOUNT = 1;

/** Stays inside Number.MAX_SAFE_INTEGER so minor units never need a float. */
export const MAX_AMOUNT = 9_999_999_999;

const CURRENCY_SET: ReadonlySet<string> = new Set(CURRENCIES);

export function isCurrency(value: string): value is Currency {
  return CURRENCY_SET.has(value);
}

export function assertAmount(amount: number): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount < MIN_AMOUNT ||
    amount > MAX_AMOUNT
  ) {
    throw new ValidationError(
      `Amount must be an integer minor-unit value from ${MIN_AMOUNT} to ${MAX_AMOUNT}`,
    );
  }
}
