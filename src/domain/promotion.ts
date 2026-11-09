import { z } from 'zod';
import { MoneySchema, PriceTagSchema, parseMoneyAmount, parsePriceTag } from './money.js';
import type { PriceTag } from './money.js';

/**
 * A promotion as the website shows it. `label` is always the website's own text; the structured
 * fields are filled only when the label matches a known pattern, and stay null otherwise.
 */
export const PromotionSchema = z.strictObject({
  /**
   * `recommended_price`: sold below the recommended retail price (PVPR). `immediate_discount`: a price
   * cut, shown next to the old price. `multi_buy`: a number of units for a fixed total, or for the price
   * of fewer units, applied in the cart. `nth_unit_discount`: a percentage off one unit of several, applied in the cart. `other`: a
   * label not recognised.
   */
  kind: z.enum(['recommended_price', 'immediate_discount', 'multi_buy', 'nth_unit_discount', 'other']),
  label: z.string().trim().min(1).max(200),
  /** The price before the promotion (the PVPR or the struck-through price), for the same unit as the current price. */
  previousPrice: PriceTagSchema.nullable(),
  /** Percentage off as the label states it: of the price for `immediate_discount`, of one unit for `nth_unit_discount`. */
  percentOff: z.number().positive().max(100).nullable(),
  /** Amount off the price, for an `immediate_discount` stated in euros. */
  amountOff: MoneySchema.nullable(),
  /** `multi_buy`: this many units cost this total together (`Leve 3 Por 1€`). */
  bundle: z.strictObject({ quantity: z.number().int().min(2), total: MoneySchema }).nullable(),
  /** `multi_buy`: take this many units and pay for this many (`Leve 6 Pague 5`). */
  takePay: z.strictObject({ take: z.number().int().min(2), pay: z.number().int().min(1) }).refine(value => value.pay < value.take).nullable(),
  /** `nth_unit_discount`: the unit that gets `percentOff`, such as 2 for the second. */
  nthUnit: z.number().int().min(2).nullable(),
  /** First and last day of the promotion (Lisbon dates), where the website gives them: product pages and the cart. */
  validFrom: z.iso.date().nullable(),
  validTo: z.iso.date().nullable(),
});
export type Promotion = z.infer<typeof PromotionSchema>;

const empty = { previousPrice: null, percentOff: null, amountOff: null, bundle: null, takePay: null, nthUnit: null, validFrom: null, validTo: null };

/** Recognise a promotion label: `PVP Recomendado: 2,71€/un`, `Desconto Imediato: 6%` or `: 5€`, `Leve 3 Por 1€`, `Leve 6 Pague 5`, `20% na 2ª un`. */
export function parsePromotionLabel(input: string): Promotion | null {
  const label = input.replace(/\s+/g, ' ').trim();
  if (!label || label.length > 200) return null;
  if (/^PVP Recomendado\b/i.test(label)) return { kind: 'recommended_price', label, ...empty };
  const percent = /^Desconto Imediato:\s*(\d{1,2}(?:[.,]\d+)?)\s*%$/i.exec(label);
  if (percent) return { kind: 'immediate_discount', label, ...empty, percentOff: Number(percent[1]!.replace(',', '.')) };
  const euros = /^Desconto Imediato:\s*(\d+(?:[.,]\d{1,2})?)\s*€$/i.exec(label);
  const off = euros ? parseMoneyAmount(euros[1]) : null;
  if (off?.ok && off.value) return { kind: 'immediate_discount', label, ...empty, amountOff: off.value };
  const bundle = /^Leve\s+(\d+)\s+(?:unidades\s+)?por\s+(\d+(?:[.,]\d{1,2})?)\s*€$/i.exec(label);
  const total = bundle ? parseMoneyAmount(bundle[2]) : null;
  if (bundle && total?.ok && total.value && Number(bundle[1]) >= 2) return { kind: 'multi_buy', label, ...empty, bundle: { quantity: Number(bundle[1]), total: total.value } };
  const takePay = /^Leve\s+(\d{1,2})\s+Pague\s+(\d{1,2})$/i.exec(label);
  if (takePay && Number(takePay[1]) >= 2 && Number(takePay[2]) >= 1 && Number(takePay[2]) < Number(takePay[1])) {
    return { kind: 'multi_buy', label, ...empty, takePay: { take: Number(takePay[1]), pay: Number(takePay[2]) } };
  }
  const nth = /^(\d{1,2})\s*%\s+na\s+(\d+)\s*[ªa]\.?\s*(?:un|unidade)\.?$/i.exec(label);
  if (nth && Number(nth[2]) >= 2 && Number(nth[1]) > 0 && Number(nth[1]) <= 100) return { kind: 'nth_unit_discount', label, ...empty, percentOff: Number(nth[1]), nthUnit: Number(nth[2]) };
  return { kind: 'other', label, ...empty };
}

/**
 * The struck-through or recommended price beside a promotional one. The website leaves the unit out
 * when it is the same as the current price's (`7,99€` beside `7,49€/kg`), so it takes that unit.
 */
export function previousPriceOf(label: string, current: PriceTag | null): PriceTag | null {
  const text = label.replace(/\s+/g, '');
  const parsed = parsePriceTag(text);
  if (!parsed.ok || !parsed.value) return null;
  return text.includes('/') || !current ? parsed.value : { amount: parsed.value.amount, per: current.per };
}

/** `Promoção válida de 13/10/2026 a 26/10/2026` as ISO dates. */
export function parsePromotionDates(label: string): { validFrom: string | null; validTo: string | null } | null {
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})\D+(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(label);
  if (!match) return null;
  const date = (day: string, month: string, year: string) => {
    const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return value.getUTCDate() === Number(day) && value.getUTCMonth() === Number(month) - 1 ? value.toISOString().slice(0, 10) : null;
  };
  return { validFrom: date(match[1]!, match[2]!, match[3]!), validTo: date(match[4]!, match[5]!, match[6]!) };
}

const LISBON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Lisbon calendar date of a timestamp such as `2026-10-26T22:59:59Z`. */
export function lisbonDate(timestamp: unknown): string | null {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return null;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? LISBON.format(new Date(time)) : null;
}
