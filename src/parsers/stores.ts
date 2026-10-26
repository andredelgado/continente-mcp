import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Cheerio } from 'cheerio';
import { PickupStoreSchema, PickupStoresSchema } from '../domain/index.js';
import type { PickupStore, PickupStores, Result, ToolError } from '../domain/index.js';
import { failure, parseValue, success } from '../domain/index.js';

function jsonAttribute(tile: Cheerio<AnyNode>): unknown {
  const raw = tile.attr('data-storedetails');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const string = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;

/** Parse the observed store locator payload; no selected-store context endpoint is called. */
export function parsePickupStores(html: string): Result<PickupStores, ToolError> {
  const $ = load(html);
  const tiles = $('.delivery-nearest .store-details.store-point[data-storedetails], .store-details.store-point[data-storedetails]');
  if (!tiles.length) return failure('invalid_data', 'The store locator response had no recognised store rows');
  const stores: PickupStore[] = [];
  let invalid = 0;
  tiles.each((_, element) => {
    const raw = jsonAttribute($(element));
    if (!raw || typeof raw !== 'object') { invalid++; return; }
    const data = raw as Record<string, unknown>;
    if (data.isPickupStore !== true) return;
    const candidate = {
      storeId: string(data.ID), name: string(data.name), address1: string(data.address1), address2: string(data.address2),
      city: string(data.city), postalCode: string(data.postalCode), latitude: number(data.latitude), longitude: number(data.longitude),
      countryCode: string(data.countryCode), storeHours: data.storeHours ?? null, isPickupStore: data.isPickupStore,
      isGalpStore: typeof data.isGalpStore === 'boolean' ? data.isGalpStore : null,
    };
    const parsed = PickupStoreSchema.safeParse(candidate);
    if (parsed.success) stores.push(parsed.data); else invalid++;
  });
  const continuation = $('[data-stores-per-load-next]').length > 0 && $('.coverage-area-no-stores-chunk').length === 0;
  const completeness = invalid ? stores.length ? 'partial' : 'unknown' : continuation ? 'unknown' : 'complete';
  const parsed = parseValue(PickupStoresSchema, { stores, completeness, selectedStoreChanged: false }, 'pickup store list');
  return parsed.ok ? success(parsed.value) : parsed;
}
