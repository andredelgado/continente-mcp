import type { BasketPreview, BasketPreviewLine, Cart, Money, ObservedQuantity, ProductDetails, Quantity, Result, ToolError } from '../domain/index.js';
import { CartItemIdSchema, checkoutFor, failure, parseProductReference, success } from '../domain/index.js';
import { selectCartItem, validateSaleQuantity } from '../parsers/cart.js';
import type { CatalogService } from './catalog.js';
import type { CartService } from './cart.js';

export interface PreviewItem { productId: string; quantity: number; cartItemId?: string | undefined; }

const euro = (minorUnits: number): Money => ({ currency: 'EUR', minorUnits: Math.round(minorUnits) });
/** Cost of a quantity at the product's current price, and whether it depends on the weight picked. */
function cost(product: ProductDetails, quantity: Quantity): { amount: Money | null; estimated: boolean } {
  const rules = product.saleRules.status === 'available' ? product.saleRules.rules : null;
  const price = product.price;
  if (!rules || !price) return { amount: null, estimated: false };
  if (quantity.value === 0) return { amount: euro(0), estimated: false };
  if (rules.storefrontUnit === 'un' && price.per === 'item') return { amount: euro(price.amount.minorUnits * quantity.value), estimated: false };
  if (rules.saleUnit === 'un' && (rules.storefrontUnit === 'kg' || rules.storefrontUnit === 'l') && price.per === rules.storefrontUnit) {
    return { amount: euro(price.amount.minorUnits * quantity.value * rules.storefrontUnitsPerSaleUnit), estimated: true };
  }
  return { amount: null, estimated: false };
}
const change = (from: number, to: number): BasketPreviewLine['change'] =>
  Math.abs(from - to) <= 0.0005 ? 'none' : to === 0 ? 'remove' : from === 0 ? 'add' : to > from ? 'increase' : 'decrease';

/**
 * The cart's products total once these lines are set: each line's current total is replaced by its
 * estimated cost. A line with an error stays as it is. Null when any amount needed is unknown.
 */
function productsAfter(cart: Cart, lines: BasketPreviewLine[]): Money | null {
  if (!cart.totals.products) return null;
  let total = cart.totals.products.minorUnits;
  for (const line of lines) {
    if (line.error !== null) continue;
    if (line.estimatedCost === null) return null;
    const selected = selectCartItem(cart, line.productId, line.cartItemId ?? undefined);
    if (!selected.ok) return null;
    if (selected.value) {
      if (!selected.value.lineTotal) return null;
      total -= selected.value.lineTotal.minorUnits;
    }
    total += line.estimatedCost.minorUnits;
  }
  // A negative total means a line was counted wrongly; it is unknown rather than reported.
  return total < 0 ? null : euro(total);
}

/**
 * What `set_cart_item_quantity` would do for each item, without changing anything: the cart is
 * read once and each product page once. Prices and stock can change before the cart is changed.
 */
export class BasketPreviewService {
  constructor(private readonly catalog: CatalogService, private readonly cart: CartService) {}
  async preview(items: PreviewItem[]): Promise<Result<BasketPreview, ToolError>> {
    if (items.some(item => !parseProductReference(item.productId).ok)) return failure('invalid_input', 'Invalid product reference');
    const cart = await this.cart.getCart();
    if (!cart.ok) return cart;
    const lines: BasketPreviewLine[] = [];
    // Inputs are compared by the cart line they resolve to, so a product ID and that line's cartItemId are one line.
    const seen = new Set<unknown>();
    for (const item of items) lines.push(await this.line(item, cart.value, seen));
    const costs = lines.filter(line => line.error === null).map(line => line.estimatedCost);
    const total = costs.every(amount => amount !== null) ? euro(costs.reduce((sum, amount) => sum + amount!.minorUnits, 0)) : null;
    const after = productsAfter(cart.value, lines);
    return success({ lines, estimatedCost: total, estimated: lines.some(line => line.error === null && line.estimated),
      problems: lines.filter(line => line.error !== null || line.availability !== 'available').length,
      productsAfter: after, checkout: checkoutFor(after, cart.value.checkout.minimumOrder, cart.value.checkout.entregaZero) });
  }

  private async line(item: PreviewItem, cart: Cart, seen: Set<unknown>): Promise<BasketPreviewLine> {
    const reference = parseProductReference(item.productId);
    const cartItemId = item.cartItemId === undefined ? null : CartItemIdSchema.parse(item.cartItemId);
    if (!reference.ok) throw new Error('Product references are checked before the preview');
    const { productId } = reference.value;
    const blank = (error: ToolError): BasketPreviewLine => ({ productId, cartItemId, name: null, requested: null, storefrontQuantity: null,
      current: { status: 'unknown', value: null, rawText: null, reason: null }, change: null, availability: null, price: null,
      packageText: null, package: null, saleRules: null, promotions: [], estimatedCost: null, estimated: false, error });
    const selected = selectCartItem(cart, productId, item.cartItemId);
    const line = selected.ok ? selected.value : null;
    // The cart line itself when there is one; otherwise the product as absent, or the input that could not be resolved.
    const key = line ?? (selected.ok && item.cartItemId === undefined ? `absent:${productId}` : `unresolved:${productId}|${item.cartItemId ?? ''}`);
    if (seen.has(key)) return blank({ code: 'invalid_input', message: 'This product is listed more than once', retryable: false });
    seen.add(key);
    const product = await this.catalog.getProduct(productId);
    if (!product.ok) return blank(product.error);
    const details = product.value;
    const rules = details.saleRules.status === 'available' ? details.saleRules.rules : null;
    const unit = rules?.saleUnit ?? null;
    const current: ObservedQuantity = !selected.ok ? { status: 'unknown', value: null, rawText: null, reason: null }
      : line ? line.quantity : { status: 'known', quantity: { value: 0, unit: unit ?? 'un' } };
    const base: BasketPreviewLine = { productId, cartItemId: cartItemId ?? line?.cartItemId ?? null, name: details.name,
      requested: unit ? { value: item.quantity, unit } : null, storefrontQuantity: null, current, change: null, availability: details.availability, price: details.price,
      packageText: details.packageText, package: details.package, saleRules: rules, promotions: details.promotions, estimatedCost: null, estimated: false, error: null };
    if (!selected.ok) return { ...base, error: selected.error };
    if (item.cartItemId !== undefined && !line) return { ...base, error: { code: 'not_found', message: 'No cart line has this cartItemId. Use get_cart to read current lines.', retryable: false } };
    if (details.saleRules.status === 'unavailable') return { ...base, error: details.saleRules.error };
    const requested = validateSaleQuantity(item.quantity, { rules: rules! });
    if (!requested.ok) return { ...base, error: requested.error };
    const now = current.status === 'known' ? current.quantity : null;
    if (!now) return { ...base, error: { code: 'invalid_data', message: 'The unit of the quantity in the cart is unknown', retryable: false } };
    if (now.unit !== requested.value.unit) return { ...base, error: { code: 'invalid_data', message: 'The cart line uses another unit than the product', retryable: false } };
    const priced = cost(details, requested.value);
    const weight = rules && rules.storefrontUnit !== 'un' && rules.saleUnit === 'un'
      ? { value: Number((requested.value.value * rules.storefrontUnitsPerSaleUnit).toPrecision(12)), unit: rules.storefrontUnit } : null;
    const changed = change(now.value, requested.value.value);
    // A line kept as it is costs what the cart already charges for it, multi-buy discounts included.
    if (changed === 'none' && line?.lineTotal) return { ...base, requested: requested.value, storefrontQuantity: weight, change: changed, estimatedCost: line.lineTotal, estimated: false };
    return { ...base, requested: requested.value, storefrontQuantity: weight, change: changed, estimatedCost: priced.amount, estimated: priced.estimated };
  }
}
