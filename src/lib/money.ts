import { AppError } from "@/server/errors";

export function parseMoneyToCents(value: string): number {
  const match = /^(0|[1-9]\d{0,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new AppError("VALIDATION_ERROR", "Enter an amount with up to two decimal places.", 400);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new AppError("VALIDATION_ERROR", "Amount is out of range.", 400);
  return cents;
}

export function formatCents(cents: number, currency = "USD") {
  if (!Number.isSafeInteger(cents)) throw new TypeError("Money must be represented as integer cents.");
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function toPayPalAmount(cents: number, currency = "USD") {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new TypeError("PayPal amount must be non-negative integer cents.");
  return { currency_code: currency, value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` };
}
