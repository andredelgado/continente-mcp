import { checkRequest, markWriteAttempted, requestIO, RequestStopped } from '../session/request.js';
import type { CartGateway, CartOperation, MutationResult } from '../ports.js';
import { allowedCartMutation } from '../clients/policy.js';
import type { Cart, CartMutationResult, ClearCartResult, ProductId, Quantity, Result, ToolError } from '../domain/index.js';
import { parseProductReference, CartItemIdSchema } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import { parseCartResponse, parseProductForm, parseCartControls, parseSaleRules, validateSaleQuantity, weightedLineQuantity,
  toStorefrontQuantity, observedCartQuantity, selectCartItem, parseMutationReceipt, parseClearCartAction } from '../parsers/cart.js';
import { storefrontUrl } from '../parsers/catalog.js';
import { field } from '../parsers/records.js';

export class CartService {
  constructor(private readonly client: CartGateway) {}
  private async preflight(operation: () => Promise<MutationResult>): Promise<MutationResult> {
    try { return await operation(); }
    catch (error) { return failure(error instanceof RequestStopped ? error.code : 'upstream_unavailable'); }
  }
  async getCart(): Promise<Result<Cart, ToolError>> {
    const response = await requestIO(() => this.client.fetchCart());
    if (!response.ok) return response;
    const authenticated = field(response.value, 'resources', 'customerAuthenticated');
    if (authenticated === false) return failure('not_authenticated');
    if (authenticated !== true) return failure('invalid_data', 'The cart response did not state whether you are signed in');
    const cart = parseCartResponse(response.value);
    if (!cart.ok) return cart;
    // Weighted lines whose JSON does not count pieces are read from the cart page; they stay unknown if it cannot say.
    const missing = cart.value.items.filter(item => item.estimated && item.quantity.status === 'unknown' && item.quantity.reason === 'missing');
    if (!missing.length) return cart;
    const page = await requestIO(() => this.client.fetchCartControls());
    if (!page.ok) return cart;
    return success({ ...cart.value, items: cart.value.items.map(item => {
      if (!missing.includes(item)) return item;
      const amount = weightedLineQuantity(page.value, item.productId, item.cartItemId);
      return amount ? { ...item, quantity: { status: 'known' as const, quantity: amount.pieces }, storefrontQuantity: amount.storefront } : item;
    }) });
  }
  private unknown(productId: ProductId, requested: Quantity, error: ToolError): MutationResult {
    return success({ outcome: 'unknown', productId, requested, error: { ...error, retryable: false },
      recovery: { action: 'get_cart', automaticReplay: false } });
  }
  private async write(productId: ProductId, requested: Quantity, action: string, params: URLSearchParams,
    operation: CartOperation, next: () => Promise<MutationResult>): Promise<MutationResult> {
    if (!storefrontUrl(action)) return failure('invalid_data', 'The cart action points outside the storefront');
    // A form or control whose action is another cart operation is refused before anything is sent.
    if (!allowedCartMutation(action, operation)) return failure('invalid_data', 'The cart action is not the requested operation');
    // Everything before markWriteAttempted() is a pre-write failure (not_applied); after it, unknown.
    const prepared = this.client.prepareCartMutation ? await requestIO(() => this.client.prepareCartMutation!(action, params, operation)) : null;
    if (prepared && !prepared.ok) return prepared;
    checkRequest();
    markWriteAttempted();
    try {
      const sent = await requestIO(() => prepared ? prepared.value() : this.client.submitCartMutation(action, params, operation));
      if (!sent.ok) return this.unknown(productId, requested, sent.error);
      const receipt = parseMutationReceipt(sent.value);
      if (!receipt.ok) return this.unknown(productId, requested, receipt.error);
      const result = await next();
      if (!result.ok) return this.unknown(productId, requested, result.error);
      if (result.value.outcome === 'not_applied') return this.unknown(productId, requested, result.value.error);
      return success({ ...result.value, requested });
    } catch (error) {
      return this.unknown(productId, requested, failure(error instanceof RequestStopped ? error.code : 'cart_change_unconfirmed').error);
    }
  }
  async confirmCartItemQuantity(productId: ProductId, requested: Quantity, expected: number, cartItemId?: string, requireAbsence = false): Promise<MutationResult> {
    const cart = await this.getCart();
    const actual = cart.ok ? observedCartQuantity(cart.value, productId, cartItemId) : null;
    const selected = cart.ok ? selectCartItem(cart.value, productId, cartItemId) : null;
    // A line that reports its unit must report the requested one; an amount in another unit is not a confirmation.
    const line = selected?.ok ? selected.value : null;
    const otherUnit = line?.quantity.status === 'known' && line.quantity.quantity.unit !== requested.unit;
    if (!cart.ok || actual === null || otherUnit || Math.abs(actual - expected) > 0.0005 || (requireAbsence && (!selected?.ok || selected.value !== null))) {
      return this.unknown(productId, requested, failure('cart_change_unconfirmed').error);
    }
    const confirmed: CartMutationResult = { outcome: 'confirmed', productId, requested,
      confirmedQuantity: { value: actual, unit: requested.unit },
      disposition: requireAbsence ? 'removed' : null, cartItemId: cartItemId ? CartItemIdSchema.parse(cartItemId) : null };
    return success(confirmed);
  }
  /** Set an absolute quantity. A product that is not in the cart is added; zero removes it. */
  async setCartItemQuantity(reference: string, value: number, cartItemId?: string): Promise<MutationResult> {
    return this.preflight(() => this.setQuantity(reference, value, cartItemId, true));
  }
  /** Set an existing line only; used after a write, where adding again could duplicate it. */
  private updateExistingQuantity(reference: string, value: number, cartItemId?: string): Promise<MutationResult> {
    return this.preflight(() => this.setQuantity(reference, value, cartItemId, false));
  }
  /**
   * Empty the cart with the website's own "remove all" request, then read the cart back: no product
   * lines may remain. An already empty cart is not written to. After the request is sent, any
   * failure is an unknown outcome that is never retried.
   */
  async clearCart(): Promise<Result<ClearCartResult, ToolError>> {
    return this.preflightClear(async () => {
      const before = await this.getCart();
      if (!before.ok) return before;
      const lines = before.value.items.filter(item => item.kind === 'product').length;
      if (!lines) return success({ outcome: 'confirmed', disposition: 'already_empty', removedLines: 0 });
      const html = await requestIO(() => this.client.fetchCartControls());
      if (!html.ok) return html;
      const action = parseClearCartAction(html.value);
      if (!action.ok) return action;
      if (!allowedCartMutation(action.value, 'clear')) return failure('invalid_data', 'The cart action is not the requested operation');
      const unknown = (error: ToolError): Result<ClearCartResult, ToolError> => success({ outcome: 'unknown', error: { ...error, retryable: false },
        recovery: { action: 'get_cart', automaticReplay: false } });
      checkRequest();
      markWriteAttempted();
      try {
        const sent = await requestIO(() => this.client.submitCartMutation(action.value, new URLSearchParams(), 'clear'));
        if (!sent.ok) return unknown(sent.error);
        const receipt = parseMutationReceipt(sent.value);
        if (!receipt.ok) return unknown(receipt.error);
        const after = await this.getCart();
        if (!after.ok) return unknown(after.error);
        if (after.value.items.some(item => item.kind === 'product')) return unknown(failure('cart_change_unconfirmed', 'Product lines remain in the cart').error);
        return success({ outcome: 'confirmed', disposition: 'cleared', removedLines: lines });
      } catch (error) {
        return unknown(failure(error instanceof RequestStopped ? error.code : 'cart_change_unconfirmed').error);
      }
    });
  }
  private async preflightClear(operation: () => Promise<Result<ClearCartResult, ToolError>>): Promise<Result<ClearCartResult, ToolError>> {
    try { return await operation(); }
    catch (error) { return failure(error instanceof RequestStopped ? error.code : 'upstream_unavailable'); }
  }
  async removeCartItem(reference: string, cartItemId?: string): Promise<MutationResult> {
    return this.preflight(() => this.setQuantity(reference, 0, cartItemId, false));
  }
  private async setQuantity(reference: string, value: number, cartItemId: string | undefined, addIfAbsent: boolean): Promise<MutationResult> {
    if (!Number.isFinite(value) || value < 0) return failure('invalid_input', 'Quantity must be zero or a positive number');
    if (cartItemId !== undefined && !CartItemIdSchema.safeParse(cartItemId).success) return failure('invalid_input', 'Invalid cartItemId');
    const ref = parseProductReference(reference);
    if (!ref.ok) return ref;
    const before = await this.getCart();
    if (!before.ok) return before;
    const selected = selectCartItem(before.value, ref.value.productId, cartItemId);
    if (!selected.ok) return selected;
    if (!selected.value) {
      if (cartItemId && before.value.items.some(item => item.cartItemId === cartItemId)) return failure('invalid_input', 'cartItemId belongs to another product');
      if (value === 0) return success({ outcome: 'confirmed', disposition: 'already_absent', productId: ref.value.productId,
        requested: { value: 0, unit: 'un' }, confirmedQuantity: { value: 0, unit: 'un' }, cartItemId: cartItemId ? CartItemIdSchema.parse(cartItemId) : null });
      if (cartItemId) return failure('not_found', 'No cart line has this cartItemId. Use get_cart to read current lines.');
      return addIfAbsent ? this.addQuantity(reference, value) : failure('not_found', 'The product is not in the cart.');
    }
    const lineId = selected.value.cartItemId ?? undefined;
    const html = await requestIO(() => this.client.fetchCartControls());
    if (!html.ok) return html;
    const controls = parseCartControls(html.value, ref.value.productId, lineId);
    if (!controls.ok) return controls;
    const { productId } = ref.value;
    const data = controls.value;
    if (value === 0) {
      if (!data.removeAction || !data.removeUuid) return failure('invalid_data', 'The cart page has no remove control for this line');
      const requested: Quantity = { value: 0, unit: 'un' };
      return this.write(productId, requested, data.removeAction, new URLSearchParams({ pid: productId, uuid: data.removeUuid }),
        'remove', () => this.confirmCartItemQuantity(productId, requested, 0, lineId, true));
    }
    const sale = parseSaleRules(data.measureOptions);
    if (!sale.ok) return sale;
    const requested = validateSaleQuantity(value, sale.value);
    if (!requested.ok) return requested;
    const current = observedCartQuantity(before.value, productId, lineId);
    if (current !== null && Math.abs(current - value) <= 0.0005) {
      return success({ outcome: 'confirmed', productId, requested: requested.value, confirmedQuantity: { value: current, unit: requested.value.unit },
        disposition: null, cartItemId: lineId ? CartItemIdSchema.parse(lineId) : null });
    }
    if (!data.action || !data.uuid) return failure('invalid_data', 'The cart page has no quantity control for this line');
    const params = new URLSearchParams({ pid: productId, quantity: toStorefrontQuantity(requested.value, sale.value),
      step: sale.value.storefrontStep, uuid: data.uuid, dimension: sale.value.updateDimension,
      isCart: 'true', gtmList: 'Checkout', gtmIndex: data.gtmIndex, promotionData: 'null', taggstarPromotionData: '' });
    return this.write(productId, requested.value, data.action, params, 'update',
      () => this.confirmCartItemQuantity(productId, requested.value, value, lineId));
  }
  async addCartItem(reference: string, value: number, cartItemId?: string): Promise<MutationResult> {
    return this.preflight(() => this.addQuantity(reference, value, cartItemId));
  }
  private async addQuantity(reference: string, value: number, cartItemId?: string): Promise<MutationResult> {
    if (!Number.isFinite(value) || value <= 0) return failure('invalid_input', 'Quantity must be a positive number');
    if (cartItemId !== undefined && !CartItemIdSchema.safeParse(cartItemId).success) return failure('invalid_input', 'Invalid cartItemId');
    const ref = parseProductReference(reference);
    if (!ref.ok) return ref;
    const before = await this.getCart();
    if (!before.ok) return before;
    const selected = selectCartItem(before.value, ref.value.productId, cartItemId);
    if (!selected.ok) return selected;
    if (cartItemId !== undefined && !selected.value) return failure('not_found', 'No cart line has this cartItemId. Use get_cart to read current lines.');
    const lineId = selected.value?.cartItemId ?? undefined;
    const html = await requestIO(() => this.client.fetchProductForm(reference));
    if (!html.ok) return html;
    const form = parseProductForm(html.value, ref.value.productId);
    if (!form.ok) return form;
    const { productId } = ref.value;
    const previous = observedCartQuantity(before.value, productId, lineId);
    if (previous === null) return failure('sale_rules_unknown');
    const incrementRules = { ...form.value.sale, rules: { ...form.value.sale.rules, minimum: null, maximum: null } };
    const increment = validateSaleQuantity(value, incrementRules);
    if (!increment.ok) return increment;
    const desired = validateSaleQuantity(previous + value, form.value.sale);
    if (!desired.ok) return desired;
    const requested: Quantity = { value, unit: desired.value.unit };
    if (cartItemId !== undefined || (form.value.sale.alternativeUnit && previous > 0)) {
      const updated = await this.updateExistingQuantity(productId, previous + value, lineId);
      return updated.ok ? success({ ...updated.value, requested }) : updated;
    }
    const params = new URLSearchParams({ pid: form.value.pid,
      quantity: form.value.sale.alternativeUnit ? '-1' : toStorefrontQuantity(increment.value, incrementRules), options: '[]' });
    if (form.value.csrf) params.set('csrf_token', form.value.csrf);
    return this.write(productId, requested, form.value.action, params, 'add', () => form.value.sale.alternativeUnit
      ? this.updateExistingQuantity(productId, previous + value)
      : this.confirmCartItemQuantity(productId, requested, previous + value, lineId));
  }
}
