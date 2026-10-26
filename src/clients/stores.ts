import type { PickupSlotGateway, PickupSlotWindow, PickupStoreGateway, PickupStoreQuery, PickupStoreSelectionGateway } from '../ports.js';
import { failure, success } from '../domain/index.js';
import type { PickupSlots, PickupStoreChange, PickupStores, Result, ToolError } from '../domain/index.js';
import type { StorefrontClient } from './storefront.js';
import type { Clock } from '../ports.js';
import { SessionAccountMismatch } from '../session/browser.js';
import { parsePickupStores } from '../parsers/stores.js';
import { parsePickupSlots } from '../parsers/pickup-slots.js';
import { STOREFRONT_ORIGIN } from '../parsers/catalog.js';
import { allowedPickupStoreContextRequest, responseStatus } from './policy.js';
import { checkRequest, markWriteAttempted, RequestStopped, requestTimeout } from '../session/request.js';
import { parsePickupStoreMutationContext, pickupStoreReadbackConfirms } from '../parsers/pickup-store-selection.js';

const STORE_SEARCH_PATH = '/on/demandware.store/Sites-continente-Site/default/Stores-GetStores?isQuerySearch=true';
const POSTAL_CODE = /^\d{4}-\d{3}$/;
const DELIVERY_PAGE = '/checkout/entrega/';
const COVERAGE_PATH = '/on/demandware.store/Sites-continente-Site/default/Stores-GetCoverageArea';
const SET_CONTEXT_PATH = '/on/demandware.store/Sites-continente-Site/default/Stores-SetStoreContext';

function validWindow(window: PickupSlotWindow, now = new Date()): boolean {
  const from = Date.parse(`${window.from}T00:00:00Z`); const to = Date.parse(`${window.to}T00:00:00Z`);
  if (!(/^\d{4}-\d{2}-\d{2}$/.test(window.from) && /^\d{4}-\d{2}-\d{2}$/.test(window.to) &&
    Number.isFinite(from) && Number.isFinite(to) && new Date(from).toISOString().slice(0, 10) === window.from &&
    new Date(to).toISOString().slice(0, 10) === window.to && to >= from && to - from <= 30 * 86400000)) return false;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const today = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
  const earliest = Date.parse(`${today}T00:00:00Z`);
  return from >= earliest && to <= earliest + 30 * 86400000;
}

/** Read store locator results through the observed AJAX GET contract, without setting store context. */
export class PickupStoresClient implements PickupStoreGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchPickupStores(query: PickupStoreQuery): Promise<Result<PickupStores, ToolError>> {
    if (!POSTAL_CODE.test(query.postalCode)) return failure('invalid_input', 'postalCode must use the Portuguese format NNNN-NNN');
    if (!Number.isFinite(query.latitude) || query.latitude < -90 || query.latitude > 90 ||
      !Number.isFinite(query.longitude) || query.longitude < -180 || query.longitude > 180) {
      return failure('invalid_input', 'latitude and longitude must be valid geographic coordinates');
    }
    const params = new URLSearchParams({ deliveryLocation: query.postalCode, deliveryPostalCode: query.postalCode,
      latitude: String(query.latitude), longitude: String(query.longitude), searchLatitude: String(query.latitude), searchLongitude: String(query.longitude) });
    if (query.city?.trim()) params.set('city', query.city.trim());
    try {
      const lease = await this.site.session.ensureReady();
      const url = `${STOREFRONT_ORIGIN}${STORE_SEARCH_PATH}&${params}`;
      const response = await this.site.io(lease, () => lease.context.request.get(url, {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${STOREFRONT_ORIGIN}/` },
        timeout: requestTimeout(10000), maxRedirects: 0,
      }));
      const status = responseStatus(response, response.url?.() ?? url);
      if (!status.ok) return status;
      const html = await this.site.io(lease, () => response.text());
      return parsePickupStores(html);
    } catch (error) {
      if (error instanceof RequestStopped) return failure(error.code);
      if (error instanceof SessionAccountMismatch) return failure('not_authenticated', 'The saved session account could not be verified. Sign in again with the configured account.');
      return failure('upstream_unavailable', 'The store locator response could not be read');
    }
  }
}

/** Reads the server-rendered delivery summary without navigating a page or executing auto-selection JS. */
export class PickupSlotsClient implements PickupSlotGateway {
  constructor(private readonly site: StorefrontClient, private readonly clock: Clock = { now: () => new Date() }) {}
  async fetchPickupSlots(window: PickupSlotWindow): Promise<Result<PickupSlots, ToolError>> {
    if (!validWindow(window, this.clock.now())) return failure('invalid_input', 'Choose an upcoming date window within the next 31 days');
    try {
      const lease = await this.site.session.ensureReady();
      const url = `${STOREFRONT_ORIGIN}${DELIVERY_PAGE}`;
      const response = await this.site.io(lease, () => lease.context.request.get(url, {
        headers: { Accept: 'text/html', Referer: url },
        timeout: requestTimeout(10000), maxRedirects: 0,
      }));
      const status = responseStatus(response, response.url?.() ?? url);
      if (!status.ok) return status;
      const html = await this.site.io(lease, () => response.text());
      return parsePickupSlots(html, window, this.clock.now());
    } catch (error) {
      if (error instanceof RequestStopped) return failure(error.code);
      if (error instanceof SessionAccountMismatch) return failure('not_authenticated', 'The saved session account could not be verified. Sign in again with the configured account.');
      return failure('upstream_unavailable', 'The delivery slot summary could not be read');
    }
  }
}

/** Changes only the primary pickup store through the observed coverage/context form flow. */
export class PickupStoreSelectionClient implements PickupStoreSelectionGateway {
  constructor(private readonly site: StorefrontClient, private readonly clock: Clock = { now: () => new Date() }) {}

  async setPickupStore(storeId: string, recoveryWindow: PickupSlotWindow): Promise<Result<PickupStoreChange, ToolError>> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(storeId)) return failure('invalid_input', 'storeId must come from list_pickup_stores');
    if (!validWindow(recoveryWindow, this.clock.now())) return failure('invalid_input', 'Choose an upcoming recovery date window within the next 31 days');
    const initial = await this.readDeliveryPage();
    if (!initial.ok) return initial;
    const parsed = parsePickupStoreMutationContext(initial.value.html);
    if (!parsed.ok) return parsed;
    const state = parsed.value;
    const target = state.options.find(option => option.storeId === storeId);
    if (!target) return failure('invalid_input', 'The requested store is not a fresh selectable pickup choice on the delivery page');
    if (state.selectedRadioStoreId !== state.currentStoreId) return failure('invalid_data', 'The selected pickup radio does not match the current store');
    if (state.currentStoreId === storeId) {
      return { ok: true, value: { outcome: 'confirmed', requestedStoreId: storeId, previousStoreId: storeId,
        selectedStoreId: storeId, storeName: target.name, storePostalCode: target.postalCode,
        selectedStoreChanged: false, cartAndCouponsNeedRevalidation: false } };
    }
    if (!allowedPickupStoreContextRequest(state.coverageAction, 'GET') || !allowedPickupStoreContextRequest(state.contextAction, 'POST')) {
      return failure('invalid_data', 'The pickup context actions are not the exact supported store endpoints');
    }
    const coverage = await this.fetchCoverage(state.coverageAction, target.postalCode!);
    if (!coverage.ok) return coverage;
    if (!coverage.value) return failure('invalid_data', 'The selected store coverage response did not provide context identifiers');

    const form = { city: target.city ?? '', storeId: coverage.value.storeId,
      physicalStoreId: coverage.value.physicalStoreId, areaID: coverage.value.areaID, storeID: coverage.value.storeID,
      storeInfo: target.location ?? '', storePostalCode: target.postalCode!, latitude: target.latitude ?? '',
      longitude: target.longitude ?? '', searchLatitude: target.latitude ?? '', searchLongitude: target.longitude ?? '',
      ID: target.storeId, selectedAddressId: target.addressId, checkOutChange: 'true' };
    try {
      const lease = await this.site.session.ensureReady();
      checkRequest();
      markWriteAttempted();
      let explicitSuccess: boolean | null = null;
      try {
        const response = await this.site.io(lease, () => lease.context.request.post(
          new URL(state.contextAction, STOREFRONT_ORIGIN).href,
          { headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: STOREFRONT_ORIGIN,
            Referer: `${STOREFRONT_ORIGIN}${DELIVERY_PAGE}` }, form,
            timeout: requestTimeout(10000), maxRedirects: 0 }));
        const finalUrl = response.url?.() ?? state.contextAction;
        const status = responseStatus(response, finalUrl);
        if (status.ok) {
          try {
            const body: unknown = await this.site.io(lease, () => response.json());
            if (body && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).success === 'boolean') {
              explicitSuccess = (body as Record<string, unknown>).success as boolean;
            }
          } catch { /* readback, not the mutation response, is the confirmation source */ }
        }
      } catch (error) {
        if (error instanceof RequestStopped) throw error;
        // The request may have reached the retailer. Read back once; never replay.
      }

      const after = await this.readDeliveryPage();
      if (after.ok) {
        const confirmed = pickupStoreReadbackConfirms(after.value.html, storeId);
        if (confirmed.ok && confirmed.value) return { ok: true, value: { outcome: 'confirmed', requestedStoreId: storeId,
          previousStoreId: state.currentStoreId, selectedStoreId: storeId, storeName: confirmed.value.name ?? target.name,
          storePostalCode: confirmed.value.postalCode ?? target.postalCode, selectedStoreChanged: true,
          cartAndCouponsNeedRevalidation: true } };
        const old = pickupStoreReadbackConfirms(after.value.html, state.currentStoreId);
        if (explicitSuccess === false && old.ok && old.value) return { ok: true, value: { outcome: 'not_applied',
          requestedStoreId: storeId, previousStoreId: state.currentStoreId, selectedStoreId: state.currentStoreId,
          storeName: old.value.name, storePostalCode: old.value.postalCode, selectedStoreChanged: false,
          cartAndCouponsNeedRevalidation: false } };
      }
      const selected = after.ok ? parsePickupStoreMutationContext(after.value.html) : null;
      return { ok: true, value: { outcome: 'unknown', requestedStoreId: storeId, previousStoreId: state.currentStoreId,
        selectedStoreId: selected?.ok ? selected.value.currentStoreId : null,
        storeName: target.name, storePostalCode: target.postalCode, selectedStoreChanged: null,
        cartAndCouponsNeedRevalidation: true, recovery: { action: 'list_pickup_slots', fromDate: recoveryWindow.from,
          toDate: recoveryWindow.to, automaticReplay: false } } };
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      return { ok: true, value: { outcome: 'unknown', requestedStoreId: storeId, previousStoreId: state.currentStoreId,
        selectedStoreId: null, storeName: target.name, storePostalCode: target.postalCode, selectedStoreChanged: null,
        cartAndCouponsNeedRevalidation: true, recovery: { action: 'list_pickup_slots', fromDate: recoveryWindow.from,
          toDate: recoveryWindow.to, automaticReplay: false } } };
    }
  }

  private async readDeliveryPage(): Promise<Result<{ html: string }, ToolError>> {
    try {
      const lease = await this.site.session.ensureReady();
      const url = `${STOREFRONT_ORIGIN}${DELIVERY_PAGE}`;
      const response = await this.site.io(lease, () => lease.context.request.get(url, {
        headers: { Accept: 'text/html', Referer: url },
        timeout: requestTimeout(10000), maxRedirects: 0,
      }));
      const status = responseStatus(response, response.url?.() ?? url);
      if (!status.ok) return status;
      return success({ html: await this.site.io(lease, () => response.text()) });
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      if (error instanceof SessionAccountMismatch) return failure('not_authenticated', 'The saved session account could not be verified. Sign in again with the configured account.');
      return failure('upstream_unavailable', 'The delivery context could not be read');
    }
  }

  private async fetchCoverage(action: string, postalCode: string): Promise<Result<CoverageIdentifiers | null, ToolError>> {
    if (!allowedPickupStoreContextRequest(action, 'GET')) return failure('invalid_data', 'The store coverage action is not allowlisted');
    try {
      const lease = await this.site.session.ensureReady();
      const url = new URL(action, STOREFRONT_ORIGIN); url.searchParams.set('postalCode', postalCode);
      const response = await this.site.io(lease, () => lease.context.request.get(url.href, {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${STOREFRONT_ORIGIN}${DELIVERY_PAGE}` },
        timeout: requestTimeout(10000), maxRedirects: 0,
      }));
      const status = responseStatus(response, response.url?.() ?? url.href);
      if (!status.ok) return status;
      let body: unknown;
      try { body = await this.site.io(lease, () => response.json()); }
      catch { return failure('invalid_data', 'The store coverage response was not valid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('invalid_data', 'The store coverage response was not an object');
      const root = body as Record<string, unknown>;
      if (root.error) return success(null);
      const data = root.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return success(null);
      const value = data as Record<string, unknown>;
      const identifiers = ['storeId', 'physicalStoreId', 'areaID', 'storeID'].map(key => {
        const item = value[key];
        return typeof item === 'string' && item.trim() && item.length <= 200 ? item.trim()
          : typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? String(item) : null;
      });
      if (identifiers.some(item => item === null)) return success(null);
      return success({ storeId: identifiers[0]!, physicalStoreId: identifiers[1]!, areaID: identifiers[2]!, storeID: identifiers[3]! });
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      if (error instanceof SessionAccountMismatch) return failure('not_authenticated', 'The saved session account could not be verified. Sign in again with the configured account.');
      return failure('upstream_unavailable', 'The selected store coverage could not be verified');
    }
  }
}

interface CoverageIdentifiers { storeId: string; physicalStoreId: string; areaID: string; storeID: string; }
