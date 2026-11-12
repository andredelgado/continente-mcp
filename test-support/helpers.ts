import type { Result, ToolError } from '../src/domain/index.js';
import { readFileSync } from 'node:fs';

import assert from 'node:assert/strict';

export const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}.html`, import.meta.url), 'utf8');
export function ok(): { ok: true; value: void };
export function ok<T>(value: T): { ok: true; value: T };
export function ok<T>(value?: T) { return { ok: true as const, value }; }
export function valueOf<T>(result: Result<T, unknown>): T { assert.ok(result.ok); return result.value; }
export function errorOf<E>(result: Result<unknown, E>): E { assert.ok(!result.ok); return result.error; }
export function present<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined); return value; }

export const fail = (code: ToolError['code'] = 'upstream_unavailable') => ({ ok: false as const, error: { code, message: code, retryable: false as const } });
/** A cart line sold by the unit, as the website describes it: its quantity is a known count. */
export const UNIT_LINE = { quantityConversionRates: { primaryunit: 'un', secondaryunit: 'un', hasAlternativeSaleUnit: false, hasConversionRate: false } };
export const rawCart = (qty = 0, id = '00123') => ({
  resources: { customerAuthenticated: true },
  cart: { items: qty ? [{ id, productName: 'Leite Meio Gordo', quantity: qty, price: { sales: { value: 1.29 } }, measurementInfo: UNIT_LINE }] : [], totalProductsValueNumber: 4.25 },
});
export interface RawSaleRules { primaryunit: string; secondaryunit: string; primaryToSecondary?: number; hasAlternativeSaleUnit?: boolean; minOrderQuantity?: number; maxNumberOfUnitsPerSale?: number; }
export const unitRules: RawSaleRules = { primaryunit: 'un', secondaryunit: 'kg' };
export const weightedRules = { primaryunit: 'kg', secondaryunit: 'un', primaryToSecondary: 0.2, hasAlternativeSaleUnit: true, minOrderQuantity: 0.6 };
export const productForm = (rules = unitRules, action = '/Cart-AddProduct') => `<input name="productID" value="00123-master"><input class="add-to-cart-url" value="${action}"><input name="csrf_token" value="synthetic-token"><div class="ct-tile-quantity-update" data-measure-options='${JSON.stringify(rules)}'></div>`;
export const cartControls = (rules = unitRules, action = '/Cart-UpdateQuantity') => `<div data-pid="00123" data-product-name="Leite" data-uuid="line-abc" data-idx="2"><input class="add-to-cart-quantity" data-pid="00123-master"><span class="ct-tile-quantity-update" data-action="${action}" data-measure-options='${JSON.stringify(rules)}'></span><button class="remove-product" data-action="/Cart-RemoveProduct"></button></div>`;
export const ordersPage = ['first', 'second'].map((id, i) => `<div class="ct-order-history--order-preview-item"><div class="ct-order-history--order-preview-number">123456789_00${i + 1}</div><span class="ct-order-history--order-preview-delivery-date">${2 - i} outubro 2026</span><a href="/detalhe-encomenda?id=${id}">Details</a></div>`).join('');
export const pages = (...html: string[]) => ({ pages: html, failures: [] });
