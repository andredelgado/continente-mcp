import { load } from 'cheerio';
import { failure, success } from '../domain/index.js';
import type { Result, ToolError } from '../domain/index.js';

const clean = (value: string | undefined): string | null => value?.trim() || null;
const postal = (value: string | null): value is string => value !== null && /^\d{4}-\d{3}$/.test(value);
const COVERAGE_ACTION = '/on/demandware.store/Sites-continente-Site/default/Stores-GetCoverageArea';
const CONTEXT_ACTION = '/on/demandware.store/Sites-continente-Site/default/Stores-SetStoreContext';
export interface PickupStoreOption {
  storeId: string; name: string | null; postalCode: string | null; city: string | null;
  location: string | null; latitude: string | null; longitude: string | null; addressId: string;
  radioValue: string;
}
/** Ephemeral data freshly read from the server-rendered delivery page. */
export interface PickupStoreMutationContext {
  coverageAction: string; contextAction: string; currentStoreId: string; selectedDeliveryId: string;
  options: PickupStoreOption[]; selectedRadioStoreId: string | null;
}

/** Parse one primary pickup context and the fresh store choices used by the observed context-change flow. */
export function parsePickupStoreMutationContext(html: string): Result<PickupStoreMutationContext, ToolError> {
  const $ = load(html);
  const allSteps = $('.step-type--address');
  const steps = $('.step-type--address[data-address-store="store"][data-current-shipment-store]');
  if (allSteps.length !== 1 || steps.length !== 1 || allSteps.first().attr('data-is-primary') !== 'true') {
    return failure('invalid_data', 'The delivery page does not expose exactly one primary pickup context');
  }
  const step = steps.first();
  const currentStoreId = clean(step.attr('data-current-shipment-store'));
  const selectedDeliveryId = clean(step.attr('data-selected-delivery'));
  if (!currentStoreId || currentStoreId !== selectedDeliveryId) {
    return failure('invalid_data', 'The currently selected pickup store is ambiguous');
  }
  const rows = step.find('.js-type-store[data-store-id]');
  if (rows.length === 0) {
    return failure('invalid_data', 'The delivery page does not expose fresh pickup choices');
  }
  const options: PickupStoreOption[] = [];
  const seen = new Set<string>(); let invalidOption = false;
  rows.each((_, element) => {
    const row = $(element); const storeId = clean(row.attr('data-store-id'));
    const radios = row.find('input.pwc-form-check-input[type="radio"]');
    const radioValue = radios.length === 1 ? clean(radios.first().attr('value')) : null;
    const postalCode = clean(row.attr('data-postal'));
    if (!storeId || storeId.length > 100 || !radioValue || radioValue !== storeId || seen.has(storeId) || !postal(postalCode)) {
      invalidOption = true; return;
    }
    seen.add(storeId);
    options.push({ storeId, radioValue, postalCode,
      name: clean(row.attr('data-delivery-location')),
      city: clean(row.attr('data-delivery-city')),
      location: clean(row.attr('data-delivery-location')),
      latitude: clean(row.attr('data-delivery-latitude')), longitude: clean(row.attr('data-delivery-longitude')),
      addressId: clean(row.attr('data-address-id')) ?? '' });
  });
  if (invalidOption) return failure('invalid_data', 'The delivery page has ambiguous pickup store choices');
  const checked = rows.find('input.pwc-form-check-input[type="radio"]:checked');
  let selectedRadioStoreId: string | null = null;
  if (checked.length === 1) {
    const value = clean(checked.first().attr('value'));
    const rowId = clean(checked.first().closest('.js-type-store').attr('data-store-id'));
    if (value && value === rowId) selectedRadioStoreId = value;
  }
  return success({ coverageAction: COVERAGE_ACTION, contextAction: CONTEXT_ACTION,
    currentStoreId, selectedDeliveryId, options, selectedRadioStoreId });
}

export function pickupStoreReadbackConfirms(html: string, storeId: string): Result<PickupStoreOption | null, ToolError> {
  const parsed = parsePickupStoreMutationContext(html);
  if (!parsed.ok) return parsed;
  const row = parsed.value.options.find(option => option.storeId === storeId) ?? null;
  if (parsed.value.currentStoreId !== storeId || parsed.value.selectedDeliveryId !== storeId || parsed.value.selectedRadioStoreId !== storeId) {
    return success(null);
  }
  return success(row);
}
