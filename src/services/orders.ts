import { checkRequest, requestIO, RequestStopped, reportProgress } from '../session/request.js';
import type { Clock, OrdersGateway } from '../ports.js';
import type { Order, OrderLine, PageResult, PurchaseFrequency, Result, ToolError } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import { OrderIdSchema } from '../domain/index.js';
import { parseOrderHistory, parseOrderDetail, parseSingleOrder, aggregatePurchaseFrequency, orderHistoryUrl } from '../parsers/orders.js';
import type { OrderSummary } from '../parsers/orders.js';
import { STOREFRONT_ORIGIN } from '../parsers/catalog.js';

export interface ScanFailure { stage: 'listing' | 'detail'; orderId: Order['orderId']; orderNumber: Order['orderNumber']; error: ToolError; }
interface SummaryScan { entries: OrderSummary[]; failures: ScanFailure[]; nextCursor: string | null; hasMore: boolean | null; completeness: 'complete' | 'partial' | 'unknown'; }
const key = (entry: OrderSummary) => entry.order.orderId ?? entry.order.orderNumber!;
function cursorFor(url: string, after?: string): string { return Buffer.from(JSON.stringify({ url, ...(after ? { after } : {}) })).toString('base64url'); }
function parseCursor(cursor: string | undefined): Result<{ url: string; after?: string }, ToolError> {
  if (cursor === undefined) return success({ url: `${STOREFRONT_ORIGIN}/conta/encomendas/` });
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('url' in parsed) || typeof parsed.url !== 'string' || !orderHistoryUrl(parsed.url) ||
      Object.keys(parsed).some(key => !['url', 'after'].includes(key)) || ('after' in parsed && (typeof parsed.after !== 'string' || !parsed.after || parsed.after.length > 250))) throw new Error();
    return success({ url: parsed.url, ...('after' in parsed ? { after: parsed.after as string } : {}) });
  } catch { return failure('invalid_input', 'Invalid order history cursor'); }
}
async function scanSummaries(client: OrdersGateway, limit: number, cursor?: string): Promise<Result<SummaryScan, ToolError>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return failure('invalid_input', 'Order limit must be between 1 and 50');
  const start = parseCursor(cursor); if (!start.ok) return start;
  const entries: OrderSummary[] = []; const failures: ScanFailure[] = []; const seen = new Map<string, OrderSummary>(); const visited = new Set<string>();
  let url: string | null = start.value.url; let nextCursor: string | null = null; let hasMore: boolean | null = null;
  let complete = false; let first = true;
  for (let page = 0; url && page < 10; page++) {
    if (visited.has(url)) { failures.push({ stage: 'listing', orderId: null, orderNumber: null, error: failure('invalid_data', 'Order pagination did not advance').error }); break; }
    visited.add(url);
    let result;
    try { result = await requestIO(() => client.fetchOrderHistory(url!)); }
    catch (error) { result = failure(error instanceof RequestStopped ? error.code : 'upstream_unavailable'); }
    const parsed = result.ok ? parseOrderHistory(result.value) : result;
    if (!parsed.ok) {
      if (!entries.length) return parsed;
      failures.push({ stage: 'listing', orderId: null, orderNumber: null, error: parsed.error }); nextCursor = cursorFor(url); hasMore = true; break;
    }
    let candidates = parsed.value.entries;
    if (first && start.value.after) {
      const index = candidates.findIndex(entry => key(entry) === start.value.after);
      if (index < 0) return failure('invalid_input', 'Order history changed; restart the listing without a cursor');
      candidates = candidates.slice(index + 1);
    }
    first = false;
    for (const [index, entry] of candidates.entries()) {
      const previous = seen.get(key(entry)) ?? [...seen.values()].find(previous => previous.order.orderNumber === entry.order.orderNumber);
      if (previous) {
        if (key(previous) !== key(entry) || previous.order.orderNumber !== entry.order.orderNumber || previous.detailUrl !== entry.detailUrl) {
          failures.push({ stage: 'listing', orderId: entry.order.orderId, orderNumber: entry.order.orderNumber, error: failure('invalid_data', 'Conflicting order identity across pages').error });
        }
        continue;
      }
      seen.set(key(entry), entry); entries.push(entry);
      if (entries.length === limit && index < candidates.length - 1) {
        return success({ entries, failures, nextCursor: cursorFor(url, key(entry)), hasMore: true, completeness: failures.length ? 'partial' : 'unknown' });
      }
    }
    url = parsed.value.nextCursor;
    nextCursor = url ? cursorFor(url) : null;
    complete = !url && (parsed.value.completeness === 'complete' || (parsed.value.totalCount !== null && seen.size === parsed.value.totalCount));
    hasMore = url ? true : complete ? false : null;
    if (entries.length >= limit) break;
  }
  return success({ entries, failures, nextCursor, hasMore, completeness: failures.length ? 'partial' : complete ? 'complete' : 'unknown' });
}

/** An order dated this long ago is settled (delivered or cancelled), so its lines no longer change. */
export const SETTLED_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Product lines of settled orders, kept in memory for the account they were read with, so the order
 * tools do not load the same detail pages again. Recent orders are always read from the website.
 */
export class SettledOrders {
  private scope: string | null = null;
  private readonly orders = new Map<string, { orderNumber: Order['orderNumber']; lines: OrderLine[]; single?: Order }>();
  constructor(private readonly clock: Clock, private readonly currentScope: () => string, private readonly max = 200) {}
  private entries() {
    const scope = this.currentScope();
    if (scope !== this.scope) { this.orders.clear(); this.scope = scope; }
    return this.orders;
  }
  private settled(order: Order): boolean {
    const date = order.date ? Date.parse(order.date) : NaN;
    return Number.isFinite(date) && this.clock.now().getTime() - date >= SETTLED_AFTER_MS;
  }
  /** Lines for an order of the history list, when the same order (id and number) was read before. */
  lines(order: Order): OrderLine[] | undefined {
    const entry = order.orderId ? this.entries().get(order.orderId) : undefined;
    return entry && entry.orderNumber === order.orderNumber ? structuredClone(entry.lines) : undefined;
  }
  single(orderId: string): Order | undefined { const entry = this.entries().get(orderId); return entry?.single && structuredClone(entry.single); }
  /** The account the website is being read with now; pass it to `remember` with what is then read. */
  owner(): string { return this.currentScope(); }
  /** Keep an order read with the session `readWith` names; when the session changed during the read, it is not kept. */
  remember(order: Order, readWith: string, single = false): void {
    if (!order.orderId || order.lines.status !== 'available' || !this.settled(order)) return;
    if (readWith !== this.currentScope()) return;
    const orders = this.entries(); const previous = orders.get(order.orderId);
    const entry = { orderNumber: order.orderNumber, lines: structuredClone(order.lines.items),
      ...(single ? { single: structuredClone(order) } : previous?.orderNumber === order.orderNumber && previous.single ? { single: previous.single } : {}) };
    orders.delete(order.orderId); orders.set(order.orderId, entry);
    for (const oldest of orders.keys()) { if (orders.size <= this.max) break; orders.delete(oldest); }
  }
}
export interface OrderListOptions { includeLines?: boolean; detailLimit?: number; cursor?: string; }
export interface OrderListResult extends PageResult<Order> { hasMore: boolean | null; detailBudget: number; detailsRead: number; scanFailures: ScanFailure[]; }
export class OrderService {
  constructor(private readonly client: OrdersGateway, private readonly settled?: SettledOrders) {}
  async getOrder(identifier: string): Promise<Result<Order, ToolError>> {
    const id = OrderIdSchema.safeParse(identifier);
    if (!id.success) return failure('invalid_input', 'Invalid orderId');
    const known = this.settled?.single(id.data);
    if (known) return success(known);
    const owner = this.settled?.owner();
    const url = new URL('/conta/detalhe-encomenda/', STOREFRONT_ORIGIN); url.searchParams.set('orderID', id.data);
    const response = await requestIO(() => this.client.fetchOrderLines(url.href));
    const order = response.ok ? parseSingleOrder(response.value, id.data) : response;
    if (order.ok && owner !== undefined) this.settled?.remember(order.value, owner, true);
    return order;
  }
  async listOrders(limit: number, options: OrderListOptions = {}): Promise<Result<OrderListResult, ToolError>> {
    const budget = options.includeLines === false ? 0 : options.detailLimit ?? limit;
    if (!Number.isInteger(budget) || budget < 0 || budget > 50) return failure('invalid_input', 'Detail limit must be between 0 and 50');
    const owner = this.settled?.owner();
    const scan = await scanSummaries(this.client, limit, options.cursor); if (!scan.ok) return scan;
    const entries = scan.value.entries; const scanFailures = [...scan.value.failures]; let detailsRead = 0;
    for (const [index, entry] of entries.slice(0, budget).entries()) {
      const { order, detailUrl } = entry;
      let parsed;
      try {
        checkRequest();
        const known = this.settled?.lines(order);
        if (known) parsed = success(known);
        else if (!detailUrl) parsed = { ok: false as const, error: entry.error ?? failure('order_details_unavailable').error };
        else { const response = await requestIO(() => this.client.fetchOrderLines(detailUrl)); parsed = response.ok ? parseOrderDetail(response.value, order) : response; }
      } catch (error) {
        const stopped = failure(error instanceof RequestStopped ? error.code : 'upstream_unavailable').error;
        if (error instanceof RequestStopped) {
          for (const remaining of entries.slice(index, budget)) {
            remaining.order.lines = { status: 'unavailable', error: stopped };
            scanFailures.push({ stage: 'detail', orderId: remaining.order.orderId, orderNumber: remaining.order.orderNumber, error: stopped });
          }
          break;
        }
        parsed = { ok: false as const, error: stopped };
      }
      if (parsed.ok) { order.lines = { status: 'available', items: parsed.value }; detailsRead++; if (owner !== undefined) this.settled?.remember(order, owner); }
      else { order.lines = { status: 'unavailable', error: parsed.error }; scanFailures.push({ stage: 'detail', orderId: order.orderId, orderNumber: order.orderNumber, error: parsed.error }); }
      reportProgress(index + 1, Math.min(entries.length, budget), 'Reading order details');
    }
    return success({ items: entries.map(entry => entry.order), nextCursor: scan.value.nextCursor, hasMore: scan.value.hasMore,
      completeness: scanFailures.length ? 'partial' : scan.value.completeness, failures: scanFailures.map(item => item.error), scanFailures,
      detailBudget: budget, detailsRead });
  }
}
export interface FrequencyResult {
  products: PurchaseFrequency[]; listed: number; scanned: number; succeeded: number; failed: number; unscanned: number;
  unknownQuantityLines: number; failures: ScanFailure[]; completeness: 'complete' | 'partial' | 'unknown';
}
export class PurchaseHistoryService {
  constructor(private readonly client: OrdersGateway, private readonly settled?: SettledOrders) {}
  async listFrequentlyBoughtProducts(limit: number): Promise<Result<FrequencyResult, ToolError>> {
    const result = await new OrderService(this.client, this.settled).listOrders(limit); if (!result.ok) return result;
    const page = result.value;
    const known = page.items.flatMap(order => order.lines.status === 'available' ? [order.lines.items] : []);
    const unavailable = page.items.filter(order => order.lines.status === 'unavailable');
    const unscanned = unavailable.filter(order => order.lines.status === 'unavailable' && ['cancelled', 'deadline_exceeded', 'server_closed'].includes(order.lines.error.code)).length;
    const aggregate = aggregatePurchaseFrequency(known); if (!aggregate.ok) return aggregate;
    const unknownQuantityLines = aggregate.value.reduce((total, product) => total + product.unknownQuantityLines, 0);
    return success({ products: aggregate.value, listed: page.items.length, scanned: page.items.length - unscanned, succeeded: known.length,
      failed: unavailable.length - unscanned, unscanned, unknownQuantityLines, failures: page.scanFailures,
      completeness: unknownQuantityLines ? 'partial' : page.completeness });
  }
}
