import { load } from 'cheerio';
import { PickupSlotsSchema } from '../domain/index.js';
import type { PickupSlot, PickupSlots, Result, ToolError } from '../domain/index.js';
import { failure, parseValue, success } from '../domain/index.js';

export interface PickupSlotWindow { from: string; to: string; }
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, janeiro: 1, fev: 2, fevereiro: 2, mar: 3, marco: 3, abr: 4, abril: 4,
  mai: 5, maio: 5, jun: 6, junho: 6, jul: 7, julho: 7, ago: 8, agosto: 8,
  set: 9, setembro: 9, out: 10, outubro: 10, nov: 11, novembro: 11, dez: 12, dezembro: 12,
};
const clean = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
function monthNumber(value: unknown): number | null {
  const normalized = clean(value)?.toLocaleLowerCase('pt-PT').normalize('NFD').replace(/[\u0300-\u036f.]/g, '');
  return normalized ? MONTHS[normalized] ?? null : null;
}
function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function resolveDate(dayValue: unknown, monthValue: unknown, window: PickupSlotWindow): { date: string | null; malformed: boolean } {
  const day = typeof dayValue === 'number' ? dayValue : typeof dayValue === 'string' && /^\d{1,2}$/.test(dayValue) ? Number(dayValue) : NaN;
  const month = monthNumber(monthValue);
  if (!Number.isInteger(day) || day < 1 || day > 31 || month === null) return { date: null, malformed: true };
  const firstYear = Number(window.from.slice(0, 4)); const lastYear = Number(window.to.slice(0, 4));
  for (let year = firstYear - 1; year <= lastYear + 1; year++) {
    const candidate = isoDate(year, month, day);
    if (candidate && candidate >= window.from && candidate <= window.to) return { date: candidate, malformed: false };
  }
  // A valid date outside the requested window is confidently excluded.
  if (!isoDate(firstYear, month, day) && !isoDate(lastYear, month, day)) return { date: null, malformed: true };
  return { date: null, malformed: false };
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function windowIsUpcoming(window: PickupSlotWindow, observedAt: Date): boolean {
  const from = Date.parse(`${window.from}T00:00:00Z`); const to = Date.parse(`${window.to}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window.from) || !/^\d{4}-\d{2}-\d{2}$/.test(window.to) ||
      !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 30 * 86400000 ||
      new Date(from).toISOString().slice(0, 10) !== window.from || new Date(to).toISOString().slice(0, 10) !== window.to) return false;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(observedAt);
  const today = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
  const earliest = Date.parse(`${today}T00:00:00Z`);
  return from >= earliest && to <= earliest + 30 * 86400000;
}

/** Parses only server-rendered delivery HTML; it never executes retailer slot-selection JavaScript. */
export function parsePickupSlots(html: string, dateWindow: PickupSlotWindow, observedAt = new Date()): Result<PickupSlots, ToolError> {
  if (!windowIsUpcoming(dateWindow, observedAt)) return failure('invalid_input', 'Choose an upcoming date window within the next 31 days');
  const $ = load(html);
  const steps = $('.step-type--address');
  const storeMarker = steps.filter('[data-address-store="store"][data-current-shipment-store][data-selected-delivery]');
  const primary = steps.filter('[data-is-primary="true"]');
  const selectedStoreId = clean(storeMarker.attr('data-current-shipment-store'));
  const selectedDeliveryId = clean(storeMarker.attr('data-selected-delivery'));
  const shipmentId = clean(storeMarker.attr('data-shipment-id'));
  const selectedRadio = storeMarker.find('.js-type-store[data-store-id] input.pwc-form-check-input[type="radio"]:checked');
  const selectedRadioId = selectedRadio.length === 1 ? clean(selectedRadio.first().val()) : null;
  const pickupVerified = steps.length === 1 && storeMarker.length === 1 && primary.length === 1 && primary[0] === storeMarker[0] &&
    selectedStoreId !== null && selectedStoreId === selectedDeliveryId && selectedRadioId === selectedStoreId && shipmentId !== null;
  const components = $('.shipping-delivery-slot[data-shipment-id][data-delivery-slot-url]').filter((_, element) => clean($(element).attr('data-shipment-id')) === shipmentId);
  const component = components.length === 1 ? components.first() : null;
  if (pickupVerified && !component) return failure('invalid_data', 'The delivery page did not expose a slot summary for the selected pickup shipment');
  const pickupMode = pickupVerified && component ? 'pickup' : 'unknown';
  const storeId = pickupMode === 'pickup' ? selectedStoreId : null;
  const postalCode = pickupMode === 'pickup' ? clean(storeMarker.attr('data-current-shipment-store-postal-code')) : null;
  const source = component?.attr('data-shipment-delivery-slots');
  let envelope: Record<string, unknown> | null = null;
  if (source) { try { envelope = record(JSON.parse(source)); } catch { envelope = null; } }
  const delivery = record(envelope?.shipmentDeliverySlots);
  const componentShipmentId = component ? clean(component.attr('data-shipment-id')) : null;
  const envelopeShipmentId = clean(delivery?.shipmentId);
  const grouped = delivery?.groupedDeliverySlots;
  const slots: PickupSlot[] = [];
  let unresolved = false;
  if (pickupMode === 'pickup' && componentShipmentId && envelopeShipmentId === componentShipmentId && Array.isArray(grouped)) {
    for (const rawGroup of grouped) {
      const group = record(rawGroup);
      if (!group || !Array.isArray(group.slotDetails)) continue;
      const resolved = resolveDate(group.slotDateDay, group.slotDateMonth, dateWindow);
      if (resolved.malformed) continue;
      if (!resolved.date) continue;
      for (const rawSlot of group.slotDetails) {
        const slot = record(rawSlot);
        if (!slot) continue;
        const startTime = clean(slot.formattedStart); const endTime = clean(slot.formattedEnd);
        slots.push({ date: resolved.date, weekday: clean(group.slotDateDayName), weekdayShort: clean(group.slotDateDayNameShort),
          startTime, endTime, shippingCost: clean(slot.formattedShippingCost) });
      }
    }
  } else unresolved = true;
  const unique = [...new Map(slots.map(slot => [`${slot.date}|${slot.startTime}|${slot.endTime}|${slot.shippingCost}`, slot])).values()];
  // The delivery page also has a separate more-days interaction. This read reports only
  // dates already present in server HTML and cannot claim the whole requested window is covered.
  const completeness = unresolved || !unique.length ? 'unknown' : 'partial';
  const parsed = parseValue(PickupSlotsSchema, { pickupMode, selectedStoreId: storeId, storePostalCode: postalCode,
    dateWindow, dateYearBasis: 'requested-window', coverage: 'server-rendered-days-only', slots: unique, completeness,
    selectedStoreChanged: false, slotReserved: false }, 'pickup slot list');
  return parsed.ok ? success(parsed.value) : parsed;
}
