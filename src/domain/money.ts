import { z } from 'zod';
import { invalidData } from './errors.js';
import type { ToolError } from './errors.js';
import type { Result } from './result.js';

export const MoneySchema = z.strictObject({
  currency: z.literal('EUR'),
  minorUnits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type Money = z.infer<typeof MoneySchema>;

/** Convert decimal text through integer arithmetic; never round an unrecognized precision. */
export function parseMoneyAmount(input: unknown): Result<Money | null, ToolError> {
  if (input === null || input === undefined || input === '') return { ok: true, value: null };
  if (typeof input !== 'number' && typeof input !== 'string') {
    return { ok: false, error: invalidData('money amount') };
  }
  const text = String(input).trim();
  if (text.length > 100) return { ok: false, error: invalidData('money amount') };
  const match = text.match(/^(\d+)(?:[.,](\d{1,2}))?\s*€?$/);
  if (!match?.[1]) return { ok: false, error: invalidData('money amount') };
  const minorUnits = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: invalidData('money amount') };
  }
  return { ok: true, value: { currency: 'EUR', minorUnits: Number(minorUnits) } };
}

/**
 * What a displayed price is for. The storefront shows packaged goods per `item` (one pack or
 * article), produce and meat per `kg`, drinks per `l`, an approximate price per `piece`, and
 * detergents per `dose` (one wash).
 */
export const PriceTagSchema = z.strictObject({
  amount: MoneySchema,
  per: z.enum(['item', 'piece', 'kg', 'l', 'dose']),
});
export type PriceTag = z.infer<typeof PriceTagSchema>;

const PRICE_UNITS: Readonly<Record<string, PriceTag['per']>> = { kg: 'kg', l: 'l', lt: 'l', un: 'piece', dos: 'dose' };

/** Parse labels such as `1,29€`, `1,19€/kg` or `0,24€/un`. An empty label is an unknown price. */
export function parsePriceTag(input: unknown): Result<PriceTag | null, ToolError> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: invalidData('price') };
  const text = input.replace(/\s+/g, '');
  if (!text) return { ok: true, value: null };
  const match = /^(\d+(?:[.,]\d{1,2})?)€(?:\/([a-z]+))?$/i.exec(text);
  const per = match ? PRICE_UNITS[(match[2] ?? '').toLowerCase()] ?? (match[2] === undefined ? 'item' : undefined) : undefined;
  const amount = match && per ? parseMoneyAmount(match[1]) : null;
  if (!amount?.ok || !amount.value || !per) return { ok: false, error: { ...invalidData('price'), message: 'Unrecognised price format' } };
  return { ok: true, value: { amount: amount.value, per } };
}

/**
 * Price per kg of drained weight, for a single pack with a stated drained weight. Null when the
 * pack price is not for one item or the drained weight is not in grams or kilograms.
 */
export function drainedPricePerKg(price: { amount: Money; per: string } | null, pack: { count: number | null; drained: { value: number; unit: string } | null } | null) {
  if (!price || price.per !== 'item' || !pack?.drained || pack.count !== 1) return null;
  const kilograms = pack.drained.unit === 'g' ? pack.drained.value / 1000 : pack.drained.unit === 'kg' ? pack.drained.value : null;
  if (!kilograms || kilograms <= 0) return null;
  return { amount: { currency: 'EUR' as const, minorUnits: Math.round(price.amount.minorUnits / kilograms) }, per: 'kg' as const };
}

export const UnitPriceSchema = z.strictObject({
  amount: MoneySchema,
  per: z.enum(['kg', 'l', 'dose']),
  /** `drained`: per kg of drained weight; `website`: the website's own price per kg, litre or dose; `pack`: the pack price divided by its net quantity. */
  basis: z.enum(['drained', 'website', 'pack']),
});
export type UnitPrice = z.infer<typeof UnitPriceSchema>;
/**
 * The price to compare products by: per drained kg when the label gives a drained weight, else the
 * website's price per kg, litre or dose, else the pack price divided by the pack's net quantity.
 */
export function unitPriceOf(price: { amount: Money; per: string } | null, secondaryPrice: { amount: Money; per: string } | null,
  pack: { net: { value: number; unit: string } | null } | null, drainedPrice: { amount: Money; per: string } | null): UnitPrice | null {
  if (drainedPrice?.per === 'kg') return { amount: drainedPrice.amount, per: 'kg', basis: 'drained' };
  for (const candidate of [price, secondaryPrice]) {
    if (candidate && (candidate.per === 'kg' || candidate.per === 'l' || candidate.per === 'dose')) return { amount: candidate.amount, per: candidate.per, basis: 'website' };
  }
  const net = pack?.net;
  if (!price || price.per !== 'item' || !net || net.value <= 0) return null;
  const amount = net.unit === 'g' ? { per: 'kg' as const, size: net.value / 1000 } : net.unit === 'kg' ? { per: 'kg' as const, size: net.value }
    : net.unit === 'ml' ? { per: 'l' as const, size: net.value / 1000 } : net.unit === 'l' ? { per: 'l' as const, size: net.value } : null;
  return amount ? { amount: { currency: 'EUR', minorUnits: Math.round(price.amount.minorUnits / amount.size) }, per: amount.per, basis: 'pack' } : null;
}
