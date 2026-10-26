import type { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type { ResourceHandler, ToolHandler } from './server.js';
import { PICKER_HTML, PICKER_META, PICKER_MIME_TYPE, PICKER_URI } from './picker.js';
import type { Clock, SessionService, MutationResult } from '../ports.js';
import type { SignInWindowState } from '../session/sign-in-window.js';
import type { BasketPreview, BasketPreviewLine, Checkout, PriceTag, ProductId, ProductLabel, Promotion, UpdateStatus, CartMutationResult, Money, ObservedQuantity, Order, ProductDetails, ProductSaleRules, Quantity, Result, ToolError } from '../domain/index.js';
import { failure, parseProductReference } from '../domain/index.js';
import * as contracts from './contracts.js';
import { withAuthenticationRecovery } from '../services/recovery.js';
import type { CatalogService, FavoritesService, FavoritesSnapshot, ProductCard, SearchOptions, SearchResult } from '../services/catalog.js';
import type { CartService } from '../services/cart.js';
import { BasketPreviewService } from '../services/preview.js';
import { labelStatus } from '../parsers/label.js';
import type { PreviewItem } from '../services/preview.js';
import type { OrderService, PurchaseHistoryService, OrderListOptions } from '../services/orders.js';

export interface ShoppingServices {
  catalog: CatalogService; favorites: FavoritesService; cart: CartService; orders: OrderService;
  history: PurchaseHistoryService; session: SessionService; clock?: Clock;
}

type Status = 'success' | 'empty' | 'partial';
type MutationSummary = z.infer<typeof contracts.ErrorResultSchema>['mutation'];
type SignInRecovery = z.infer<typeof contracts.SignInRecoverySchema>;

const CONFIGURATION_GUIDE = 'https://github.com/andredelgado/continente-mcp/blob/main/docs/configuration.md';
const PUBLIC_TOOLS = 'Searching and product details work without signing in.';
const ROBOT_CHECK_HELP: Record<SignInWindowState, string> = {
  opened: 'Sign-in needs you: Continente asks you to confirm you are not a robot. A Continente sign-in window has opened on this computer: '
    + 'tick "Não sou um robô" and press "Avançar", and it finishes signing in by itself. Then try again.',
  already_open: 'Sign-in needs you: a Continente sign-in window is open on this computer. Tick "Não sou um robô" there and press "Avançar", then try again.',
  not_available: 'Sign-in needs you: Continente asks you to confirm you are not a robot, and no window can be shown here. Run '
    + '`continentept-mcp login --show-browser` in a terminal on this computer, tick "Não sou um robô" and press "Avançar", then try again.',
};
/** What to do about a sign-in failure, depending on whether credentials are configured at all and whether Continente asked for the robot check. */
export function signInHelp(credentialsConfigured: boolean | null, robotCheck: SignInWindowState | null = null): string {
  if (robotCheck) return `${ROBOT_CHECK_HELP[robotCheck]} ${PUBLIC_TOOLS}`;
  if (credentialsConfigured === false) {
    return 'Sign-in required: no Continente email and password are configured. In the Claude Desktop extension, enter them in the '
      + `extension's settings; in other setups, set CONTINENTE_EMAIL and CONTINENTE_PASSWORD (see ${CONFIGURATION_GUIDE}). ${PUBLIC_TOOLS}`;
  }
  const cause = credentialsConfigured ? 'Continente did not accept the configured email and password, or asked for extra verification'
    : 'Continente did not accept the sign-in, or no credentials are configured';
  return `Sign-in failed: ${cause}. Check the credentials, or run \`continentept-mcp login --show-browser\` in a terminal `
    + `to sign in and complete any verification (see ${CONFIGURATION_GUIDE}). ${PUBLIC_TOOLS}`;
}
/** The structured form of `signInHelp`. */
export function signInRecovery(credentialsConfigured: boolean | null, robotCheck: SignInWindowState | null = null): SignInRecovery {
  return { credentials: credentialsConfigured === null ? 'unknown' : credentialsConfigured ? 'configured' : 'missing',
    action: robotCheck ? 'confirm_not_a_robot' : credentialsConfigured === false ? 'configure_credentials' : 'check_credentials_or_sign_in',
    signInWindow: robotCheck,
    settings: { environment: ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD'], claudeDesktopExtension: ['email', 'password'] },
    command: 'continentept-mcp login --show-browser', guide: CONFIGURATION_GUIDE, publicTools: ['search_products', 'get_product'] };
}
const CHECKOUT_URL = 'https://www.continente.pt/checkout/carrinho/';

// Text content mirrors the structured result for clients that only show text to the model,
// so it always includes the identifiers needed for follow-up calls.
const euros = (money: Money | null) => money === null ? 'price unavailable' : `€${(money.minorUnits / 100).toFixed(2)}`;
const amount = (quantity: Quantity) => `${Number(quantity.value.toPrecision(12))} ${quantity.unit}`;
const observed = (quantity: ObservedQuantity) => quantity.status === 'known' ? amount(quantity.quantity)
  : quantity.value === null ? 'quantity unknown' : `${quantity.value} (unit unknown)`;
const PER: Record<PriceTag['per'], string> = { item: '', piece: ' per piece', kg: '/kg', l: '/l' };
const priced = (price: PriceTag | null) => price === null ? 'price unknown' : `${euros(price.amount)}${PER[price.per]}`;
const ordinal = (n: number) => `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
/** "; offer: Leve 3 Por 1€ (3 for €1.00, applied in the cart) until 2026-10-18". `withRecommended` adds the PVPR where the price line lacks it. */
function offers(promotions: readonly Promotion[], withRecommended = false): string {
  const shown = promotions.filter(promotion => withRecommended || promotion.kind !== 'recommended_price').map(promotion => {
    const detail = promotion.kind === 'recommended_price' && promotion.previousPrice ? `PVPR ${priced(promotion.previousPrice)}`
      : promotion.kind === 'immediate_discount' && promotion.previousPrice ? `was ${priced(promotion.previousPrice)}`
        : promotion.kind === 'multi_buy' && promotion.bundle ? `${promotion.bundle.quantity} for ${euros(promotion.bundle.total)}, applied in the cart`
          : promotion.kind === 'nth_unit_discount' && promotion.nthUnit && promotion.percentOff ? `${promotion.percentOff}% off the ${ordinal(promotion.nthUnit)} unit, applied in the cart` : '';
    return `${promotion.label}${detail ? ` (${detail})` : ''}${promotion.validTo ? ` until ${promotion.validTo}` : ''}`;
  });
  return shown.length ? `; offer: ${shown.join('; ')}` : '';
}
const numbered = (lines: string[]) => lines.map((line, index) => `${index + 1}. ${line}`).join('\n');

function response(data: unknown, text: string, status: Status = 'success'): CallToolResult {
  return { structuredContent: { result: { status, data } }, content: [{ type: 'text', text }] };
}
function errorResult(error: ToolError, mutation?: MutationSummary, signIn?: SignInRecovery): CallToolResult {
  const unknown = mutation?.outcome === 'unknown';
  const publicError = { ...error, ...(unknown ? { retryable: false } : {}) };
  const note = unknown ? '\nThe cart may have changed. Call get_cart before making another change; do not repeat this request automatically.'
    : mutation ? '\nThe cart was not changed.' : '';
  return { isError: true, content: [{ type: 'text', text: `Error (${publicError.code}): ${publicError.message}${note}` }],
    structuredContent: { result: { status: 'error', error: publicError, ...(mutation ? { mutation } : {}), ...(signIn ? { signIn } : {}) } } };
}

export function formatProductSearchResults(products: SearchResult['page']['items']): string {
  return numbered(products.map(product => `${product.name}${product.favorite ? ' ⭐ favorite' : ''}${product.availability === 'unavailable' ? ' (unavailable)' : ''} — ${priced(product.price)}` +
    `${product.secondaryPrice ? ` (${priced(product.secondaryPrice)})` : ''}${product.recommendedPrice ? `, PVPR ${priced(product.recommendedPrice)}` : ''}${offers(product.promotions)}` +
    `${product.packageText ? `, pack ${product.packageText}` : ''}${product.drainedPrice ? ` (${priced(product.drainedPrice)} drained)` : ''}` +
    `${product.unitPrice?.basis === 'pack' ? ` (${euros(product.unitPrice.amount)}/${product.unitPrice.per} from the pack size)` : ''}` +
    `${product.minimumText ? `, minimum ${product.minimumText}` : ''}` +
    `\n   productId: ${product.productId}${product.brand ? `, brand: ${product.brand}` : ''}${product.category ? `, category: ${product.category}` : ''}`));
}
function formatSaleRules(rules: ProductSaleRules): string {
  const bounds = [rules.minimum && `minimum ${amount(rules.minimum)}`, rules.maximum && `maximum ${amount(rules.maximum)}`,
    rules.step && `step ${amount(rules.step)}`].filter(Boolean).join(', ');
  return `sold in ${rules.saleUnit}${bounds ? ` (${bounds})` : ''}`;
}
/** "6 items, 6 l in total, drained 260 g" from the parsed pack details. */
function packSummary(pack: NonNullable<ProductDetails['package']>): string {
  return [pack.count !== null && pack.count > 1 ? `${pack.count} items` : '',
    pack.net ? `${amount(pack.net)}${pack.approximate ? ' (approximate)' : ''} in total` : '',
    pack.drained ? `drained ${amount(pack.drained)}` : ''].filter(Boolean).join(', ');
}
function formatProduct(product: ProductDetails): string {
  const summary = product.package ? packSummary(product.package) : '';
  return [`${product.name}`, `productId: ${product.productId}`,
    `Price: ${priced(product.price)}${product.secondaryPrice ? ` (${priced(product.secondaryPrice)})` : ''}` +
      `${product.recommendedPrice ? `, PVPR ${priced(product.recommendedPrice)}` : ''}`,
    ...(product.promotions.length ? [`Promotions: ${product.promotions.map(promotion => offers([promotion], true).replace(/^; offer: /, '')).join('; ')}`] : []),
    ...(product.packageText ? [`Pack: ${product.packageText}${summary ? ` (${summary})` : ''}`] : []),
    ...(product.minimumText ? [`Minimum purchase: ${product.minimumText}`] : []),
    `Availability: ${product.availability}`,
    product.saleRules.status === 'available' ? `Sale rules: ${formatSaleRules(product.saleRules.rules)}`
      : `Sale rules unavailable: ${product.saleRules.error.message}`, `URL: ${product.url}`].join('\n');
}
type Choice = { question: string; suggested: ProductId | null; options: ProductCard[]; failures: { productId: string; error: ToolError }[] };
function formatChoices(decisions: Choice[]): string {
  const list = numbered(decisions.map(decision => {
    const suggested = decision.options.find(option => option.productId === decision.suggested);
    const options = decision.options.map((option, index) => `   ${String.fromCharCode(97 + index)}) ${option.name} — ${priced(option.price)}` +
      `${option.packageText ? `, pack ${option.packageText}` : ''}${option.unitPrice && option.price?.per === 'item' ? ` (${euros(option.unitPrice.amount)}/${option.unitPrice.per})` : ''}` +
      `, ${option.availability} [${option.productId}]`);
    const failed = decision.failures.map(failure => `   (not shown: ${failure.productId}, ${failure.error.message})`);
    return [`${decision.question}${suggested ? ` — suggested: ${suggested.name} [${suggested.productId}]` : ''}`, ...options, ...failed].join('\n');
  }));
  return `Choices for the user (shown as a picker with photos where the client supports it; otherwise ask the user to reply with their choices):\n\n${list}` +
    '\n\nThe user\'s choices come back as a chat message. Then change the cart with set_cart_item_quantity.';
}
/** The picker view for choose_products, served as an MCP Apps resource. */
export const productPicker: ResourceHandler = { uri: PICKER_URI, name: 'product-picker', title: 'Product picker',
  description: 'Shows the products of choose_products with photos so the user can pick one for each choice.', mimeType: PICKER_MIME_TYPE, text: PICKER_HTML, meta: PICKER_META };
const NUTRIENT_ORDER = ['energy_kcal', 'fat', 'saturated_fat', 'carbohydrates', 'sugars', 'fibre', 'protein', 'salt'] as const;
const NUTRIENT_NAMES: Record<(typeof NUTRIENT_ORDER)[number], string> = { energy_kcal: 'energy', fat: 'fat', saturated_fat: 'of which saturates',
  carbohydrates: 'carbohydrates', sugars: 'of which sugars', fibre: 'fibre', protein: 'protein', salt: 'salt' };
function formatNutrition(nutrition: NonNullable<ProductLabel['nutrition']>): string {
  const main = NUTRIENT_ORDER.flatMap(key => nutrition.nutrients.filter(item => item.key === key).slice(0, 1).map(item => `${NUTRIENT_NAMES[key]} ${item.amount} ${item.unit}`));
  const others = nutrition.nutrients.filter(item => item.key === null).length;
  return `Nutrition per ${nutrition.per ? amount(nutrition.per) : 'unstated amount'}: ${main.join(', ')}${others ? ` (and ${others} more in the structured result)` : ''}`;
}
type LabelEntry = { productId: ProductId | null; name: string | null; label: ProductLabel | null; error: ToolError | null;
  status: 'complete' | 'partial' | 'none' | 'error'; missing: ('ingredients' | 'allergenStatement' | 'nutrition')[] };
const MISSING_NAMES = { ingredients: 'ingredients', allergenStatement: 'allergen statement', nutrition: 'nutrition' } as const;
function formatLabels(labels: LabelEntry[]): string {
  const list = numbered(labels.map(item => {
    const head = `${item.name ?? 'Unknown product'} [${item.productId ?? 'invalid reference'}]`;
    if (item.error) return `${head} — could not be read: ${item.error.message}`;
    const label = item.label;
    if (!label || item.status === 'none') return `${head} — the website shows no ingredients or nutrition for it`;
    return [`${head} (${item.status}${item.missing.length ? `; not on the website: ${item.missing.map(key => MISSING_NAMES[key]).join(', ')}` : ''})`,
      ...(label.ingredients ? [`Ingredients: ${label.ingredients}`] : []),
      ...(label.emphasised?.length ? [`In capitals in the ingredients: ${label.emphasised.join(', ')}`] : []),
      ...(label.allergenStatement ? [`Allergen statement: ${label.allergenStatement}`] : []),
      ...(label.mayContain && label.mayContain !== label.allergenStatement ? [`May contain: ${label.mayContain}`] : []),
      ...(label.nutrition ? [formatNutrition(label.nutrition)] : []),
      ...(label.issues.includes('nutrition_basis_mismatch') ? [`Caution: the website gives these nutrients per ${label.nutrition?.per ? amount(label.nutrition.per) : '?'} although the net content is ${label.netContent ? amount(label.netContent) : '?'}; kept as given, not converted.`] : [])].join('\n   ');
  }));
  return `Product labels, from the website's copy (the packaging prevails; nothing here is inferred):\n\n${list}`;
}
/** Minimum order and delivery for a products total, as `get_cart` and `preview_cart_changes` say them. */
function checkoutLines(checkout: Checkout, products: Money | null): string[] {
  const short = (target: Money) => products && products.minorUnits < target.minorUnits ? euros({ currency: 'EUR', minorUnits: target.minorUnits - products.minorUnits }) : null;
  const minimum = checkout.minimumOrder;
  return [
    ...(minimum ? [`Minimum order: ${euros(minimum)}, ${checkout.meetsMinimum === true ? 'reached' : checkout.meetsMinimum === false ? `${short(minimum)} to go` : 'not known whether reached'}.`] : []),
    checkout.deliveryFee === 'free' ? `Delivery: free with your EntregaZero (orders of ${euros(checkout.freeDeliveryFrom)} or more).`
      : 'Delivery fee: set at checkout by day, time slot and area; not included here.' +
        (checkout.freeDeliveryFrom ? ` Your EntregaZero makes it free from ${euros(checkout.freeDeliveryFrom)}${short(checkout.freeDeliveryFrom) ? `: ${short(checkout.freeDeliveryFrom)} to go` : ''}.` : ''),
  ];
}
/**
 * What a multi-buy or nth-unit offer means for a line's planned number of units. The cart applies
 * these offers, so the line's estimate does not include them.
 */
function offerHints(line: BasketPreviewLine): string[] {
  const planned = line.requested?.unit === 'un' && line.change !== null && line.change !== 'remove' ? line.requested.value : 0;
  if (!Number.isInteger(planned) || planned <= 0) return [];
  return line.promotions.flatMap(promotion => {
    if (promotion.kind === 'multi_buy' && promotion.bundle) {
      const { quantity, total } = promotion.bundle;
      const sets = Math.floor(planned / quantity); const missing = (quantity - (planned % quantity)) % quantity;
      const priced = (count: number) => `${count * quantity} for ${euros({ currency: 'EUR', minorUnits: count * total.minorUnits })}`;
      return [missing === 0 ? `${promotion.label} applies: ${priced(sets)} in the cart (not in the estimate)`
        : `${promotion.label}: ${sets ? `${priced(sets)} applies; ` : ''}${missing} more make${missing === 1 ? 's' : ''} it ${priced(sets + 1)}`];
    }
    if (promotion.kind === 'nth_unit_discount' && promotion.nthUnit && promotion.percentOff) {
      return [planned >= promotion.nthUnit ? `${promotion.label} applies: ${promotion.percentOff}% off the ${ordinal(promotion.nthUnit)} unit in the cart (not in the estimate)`
        : `${promotion.label}: take ${promotion.nthUnit} for ${promotion.percentOff}% off the ${ordinal(promotion.nthUnit)} unit`];
    }
    return [];
  });
}
function formatPreview(preview: BasketPreview): string {
  const list = numbered(preview.lines.map(line => {
    const head = `${line.name ?? 'Unknown product'} [${line.productId}]`;
    if (line.error) return `${head} — would be refused: ${line.error.message}`;
    const now = line.current.status === 'known' ? amount(line.current.quantity) : 'unknown';
    const cost = line.estimatedCost ? `, ${line.estimated ? 'about ' : ''}${euros(line.estimatedCost)}` : ', cost unknown';
    const pack = line.packageText ? `pack ${line.packageText}${line.package ? ` (${packSummary(line.package)})` : ''}, ` : '';
    const weight = line.storefrontQuantity ? `, about ${amount(line.storefrontQuantity)}` : '';
    return `${head} — ${line.change} to ${line.requested ? amount(line.requested) : '?'}${weight} (cart has ${now})${cost}\n   ${pack}${line.availability}` +
      offerHints(line).map(hint => `\n   offer: ${hint}`).join('');
  }));
  const total = preview.estimatedCost ? `${preview.estimated ? 'about ' : ''}${euros(preview.estimatedCost)}` : 'unknown';
  const after = preview.productsAfter ? `\nProducts in the cart after these changes: ${preview.estimated ? 'about ' : ''}${euros(preview.productsAfter)}` : '';
  return `Cart changes preview, nothing was changed:\n\n${list}\n\nEstimated cost of these lines: ${total}${after}` +
    `\n${checkoutLines(preview.checkout, preview.productsAfter).join('\n')}` +
    (preview.problems ? `\n${preview.problems} line(s) need attention: refused or not available.` : '') +
    '\nApply each line with set_cart_item_quantity. Prices and stock can change before then.';
}
function formatOrderLines(order: Order): string {
  if (order.lines.status === 'not_requested') return '   (lines not requested)';
  if (order.lines.status === 'unavailable') return `   (lines could not be read: ${order.lines.error.message})`;
  if (!order.lines.items.length) return '   (no product lines)';
  return order.lines.items.map(line => `   - ${observed(line.quantity)} × ${line.name}${line.productId ? ` [${line.productId}]` : ''}`).join('\n');
}
function orderHeading(order: Order): string {
  return [order.date ?? order.rawDate ?? 'date unknown', order.orderNumber && `order ${order.orderNumber}`,
    order.orderId && `orderId: ${order.orderId}`].filter(Boolean).join(' · ');
}
function favoritesData(snapshot: FavoritesSnapshot) {
  const { favorites, fetchedAt, source, freshness, expiresAt, cacheState } = snapshot;
  return { favorites, fetchedAt, source, freshness, expiresAt, cacheState, completeness: snapshot.completeness ?? 'unknown' };
}
function mutationText(value: Extract<CartMutationResult, { outcome: 'confirmed' }>, operation: 'add' | 'set' | 'remove'): string {
  const line = value.cartItemId ? ` (cartItemId ${value.cartItemId})` : '';
  if (value.disposition === 'already_absent') return `Product ${value.productId} was not in the cart; nothing changed.`;
  if (value.disposition === 'removed') return `Removed product ${value.productId}${line} from the cart.`;
  const action = operation === 'add' ? `Added ${amount(value.requested)} of` : `Set the quantity to ${amount(value.requested)} for`;
  return `${action} product ${value.productId}${line}. The cart now holds ${amount(value.confirmedQuantity)}.`;
}

export class ShoppingHandlers {
  constructor(private readonly services: ShoppingServices, private readonly update: UpdateStatus) {}
  private observedAt() { return (this.services.clock?.now() ?? new Date()).toISOString(); }
  /** Signed in or out, as the session last observed it; without saved cookies the catalogue is the public one. */
  private async catalogView(): Promise<'signed_in' | 'signed_out' | 'unknown'> {
    const status = await this.services.session.getStatus?.().catch(() => undefined);
    if (!status) return 'unknown';
    if (status.authentication.state === 'authenticated') return 'signed_in';
    return status.authentication.state === 'unauthenticated' || status.savedCookies === 'missing' ? 'signed_out' : 'unknown';
  }
  /** An error result; sign-in failures before any cart write get guidance for fixing them. */
  private async failed(error: ToolError, mutation?: MutationSummary): Promise<CallToolResult> {
    if (error.code !== 'not_authenticated' || mutation?.outcome === 'unknown') return errorResult(error, mutation);
    const status = await this.services.session.getStatus?.().catch(() => undefined);
    const configured = !status || status.credentials.hasEmail === null ? null : status.credentials.hasEmail === true && status.credentials.hasPassword === true;
    const robotCheck = this.services.session.signInPrompt?.() ?? null;
    return errorResult({ ...error, message: signInHelp(configured, robotCheck) }, mutation, signInRecovery(configured, robotCheck));
  }
  private recover<T>(operation: () => Promise<Result<T, ToolError>>) {
    return withAuthenticationRecovery(operation, () => this.services.session.refreshAuthentication());
  }

  async searchProducts(query: string, limit: number, options: SearchOptions = {}): Promise<CallToolResult> {
    const result = await this.services.catalog.searchProducts(query, limit, options);
    if (!result.ok) return this.failed(result.error);
    const { page, scanned, favorites, unknownToFilter } = result.value;
    const partial = page.completeness === 'partial';
    const text = page.items.length
      ? `${page.items.length} of ${scanned} scanned products for "${query}"${options.sort === 'unit_price' ? ', these sorted by unit price' : ''}:\n\n${formatProductSearchResults(page.items)}`
      : `No products found for "${query}".`;
    return response({ observedAt: this.observedAt(), catalogView: await this.catalogView(), products: page.items, scanned, returned: page.items.length, favoritesLoaded: favorites.length,
      completeness: page.completeness, failures: page.failures, nextCursor: page.nextCursor, unknownToFilter },
    text + (partial ? `\n\nPartial results: ${page.failures.length} problem(s) reading results; see failures.` : '') +
      (unknownToFilter ? `\n\n${unknownToFilter} more product(s) were left out because the results page gave no category or brand for them; search without the filter to see them.` : '') +
      (page.nextCursor ? `\n\nMore results are available. Pass cursor "${page.nextCursor}" with the same query to continue.` : ''),
    partial ? 'partial' : page.items.length ? 'success' : 'empty');
  }

  async getProduct(reference: string): Promise<CallToolResult> {
    const result = await this.services.catalog.getProduct(reference);
    if (!result.ok) return this.failed(result.error);
    const product = result.value;
    const partial = product.saleRules.status === 'unavailable' || product.price === null || product.availability === 'unknown';
    return response({ ...product, observedAt: this.observedAt(), catalogView: await this.catalogView() }, formatProduct(product), partial ? 'partial' : 'success');
  }

  async chooseProducts(decisions: { question: string; productIds: string[]; suggested?: string | undefined }[]): Promise<CallToolResult> {
    const shown = [];
    for (const decision of decisions) {
      const options: ProductCard[] = []; const failures: { productId: string; error: ToolError }[] = [];
      for (const reference of decision.productIds) {
        const product = await this.services.catalog.productCard(reference);
        if (!product.ok) failures.push({ productId: reference, error: product.error });
        else if (!options.some(option => option.productId === product.value.productId)) options.push(product.value);
      }
      const suggested = decision.suggested === undefined ? null : parseProductReference(decision.suggested);
      const pick = suggested?.ok && options.some(option => option.productId === suggested.value.productId) ? suggested.value.productId : null;
      shown.push({ question: decision.question, suggested: pick, options, failures });
    }
    const partial = shown.some(decision => decision.failures.length > 0);
    return response({ observedAt: this.observedAt(), decisions: shown }, formatChoices(shown), partial ? 'partial' : 'success');
  }

  async getProductLabels(references: string[]): Promise<CallToolResult> {
    const labels: LabelEntry[] = [];
    for (const reference of references) {
      const parsed = parseProductReference(reference);
      if (!parsed.ok) { labels.push({ productId: null, name: null, label: null, error: parsed.error, status: 'error', missing: [] }); continue; }
      const { productId } = parsed.value;
      const result = await this.services.catalog.getProductLabel(productId);
      labels.push(result.ok ? { productId, name: result.value.name, label: result.value.label, error: null, ...labelStatus(result.value.label) }
        : { productId, name: null, label: null, error: result.error, status: 'error' as const, missing: [] });
    }
    return response({ observedAt: this.observedAt(), labels }, formatLabels(labels));
  }

  async listFavorites(refresh: boolean): Promise<CallToolResult> {
    const result = await this.recover(() => refresh ? this.services.favorites.refreshFavorites() : this.services.favorites.listFavorites());
    if (!result.ok) return this.failed(result.error);
    const { favorites, source, freshness } = result.value;
    const header = `${favorites.length} favorites (${source === 'website' ? 'fetched from the website' : `cached ${result.value.fetchedAt}`}):`;
    const list = numbered(favorites.map(item => `${item.name} — ${priced(item.price)}\n   productId: ${item.productId}`));
    return response(favoritesData(result.value), (favorites.length ? `${header}\n\n${list}` : 'No favorites saved.') +
      (freshness === 'stale' ? '\n\nThis snapshot is more than 24 hours old. Call list_favorites with refresh: true to update it.' : ''),
    favorites.length ? 'success' : 'empty');
  }

  async getCart(): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.cart.getCart());
    if (!result.ok) return this.failed(result.error);
    const cart = { ...result.value, observedAt: this.observedAt() };
    if (!cart.items.length) return response(cart, 'The cart is empty.', 'empty');
    const list = numbered(cart.items.map(item => `${item.name}${item.kind === 'bag' ? ' (bag)' : ''} — ${observed(item.quantity)}` +
      `${item.storefrontQuantity ? ` (about ${amount(item.storefrontQuantity)})` : ''} × ${priced(item.price)}` +
      `${item.lineTotal ? `, line ${item.estimated ? 'about ' : ''}${euros(item.lineTotal)}` : ''}` +
      `${item.lineTotalBeforeDiscount ? ` (${euros(item.lineTotalBeforeDiscount)} before the discount)` : ''}${offers(item.promotions, true)}` +
      `\n   productId: ${item.productId}${item.cartItemId ? `, cartItemId: ${item.cartItemId}` : ''}`));
    const { totals } = cart;
    const optional = ([['Deposit', totals.deposit], ['Delivery', totals.delivery], ['Discounts', totals.discounts]] as const)
      .filter(([, value]) => value !== null && value.minorUnits > 0).map(([label, value]) => `${label}: ${euros(value)}`);
    const summary = [`Products: ${totals.products === null ? 'unavailable' : euros(totals.products)}`,
      ...(totals.bags !== null && totals.bags.minorUnits > 0 ? [`Bags: ${euros(totals.bags)}`] : []), ...optional,
      `Total to pay: ${totals.grandTotal === null ? 'unavailable' : `${totals.estimated ? 'about ' : ''}${euros(totals.grandTotal)}`}`,
      ...(totals.estimated ? ['Products sold by weight are charged by the weight picked, so the final amount can differ.'] : []),
      ...checkoutLines(cart.checkout, totals.products)].join('\n');
    return response(cart, `Cart (${cart.items.length} lines):\n\n${list}\n\n${summary}\nCheckout happens on the website: ${CHECKOUT_URL}`);
  }

  private async mutation(result: MutationResult, operation: 'add' | 'set' | 'remove'): Promise<CallToolResult> {
    if (!result.ok) return this.failed(result.error, { outcome: 'not_applied' });
    const value = result.value;
    if (value.outcome === 'confirmed') return response({ ...value, observedAt: this.observedAt() }, mutationText(value, operation));
    return this.failed(value.error, value.outcome === 'unknown' ? { outcome: 'unknown', recovery: value.recovery } : { outcome: 'not_applied' });
  }
  async addCartItem(reference: string, quantity: number, cartItemId?: string): Promise<CallToolResult> {
    return this.mutation(await this.recover(() => this.services.cart.addCartItem(reference, quantity, cartItemId)), 'add');
  }
  async setCartItemQuantity(reference: string, quantity: number, cartItemId?: string): Promise<CallToolResult> {
    return this.mutation(await this.recover(() => this.services.cart.setCartItemQuantity(reference, quantity, cartItemId)), quantity === 0 ? 'remove' : 'set');
  }
  async clearCart(): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.cart.clearCart());
    if (!result.ok) return this.failed(result.error, { outcome: 'not_applied' });
    const value = result.value;
    if (value.outcome === 'unknown') return this.failed(value.error, { outcome: 'unknown', recovery: value.recovery });
    return response({ ...value, observedAt: this.observedAt() }, value.disposition === 'already_empty' ? 'The cart was already empty; nothing changed.'
      : `Emptied the cart: removed ${value.removedLines} product line${value.removedLines === 1 ? '' : 's'}. The cart now holds no products.`);
  }
  async removeCartItem(reference: string, cartItemId?: string): Promise<CallToolResult> {
    return this.mutation(await this.recover(() => this.services.cart.removeCartItem(reference, cartItemId)), 'remove');
  }

  async previewBasket(items: PreviewItem[]): Promise<CallToolResult> {
    const result = await this.recover(() => new BasketPreviewService(this.services.catalog, this.services.cart).preview(items));
    if (!result.ok) return this.failed(result.error);
    return response({ ...result.value, observedAt: this.observedAt(), catalogView: await this.catalogView() }, formatPreview(result.value));
  }

  async listOrders(limit: number, options: OrderListOptions): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.orders.listOrders(limit, options));
    if (!result.ok) return this.failed(result.error);
    const page = result.value;
    const partial = page.completeness === 'partial';
    const list = numbered(page.items.map(order => `${orderHeading(order)}\n${formatOrderLines(order)}`));
    return response({ observedAt: this.observedAt(), orders: page.items, completeness: page.completeness, failures: page.scanFailures, nextCursor: page.nextCursor,
      hasMore: page.hasMore, detailBudget: page.detailBudget, detailsRead: page.detailsRead },
    (list ? `Orders:\n\n${list}` : 'No orders found.') +
      (partial ? '\n\nPartial results: some order pages or details could not be read.' : '') +
      (page.nextCursor ? `\n\nMore orders are available. Pass cursor "${page.nextCursor}" to continue.` : ''),
    partial ? 'partial' : page.items.length ? 'success' : 'empty');
  }

  async getOrder(orderId: string): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.orders.getOrder(orderId));
    if (!result.ok) return this.failed(result.error);
    const order = result.value;
    const lines = order.lines.status === 'available' ? order.lines.items : [];
    const unknownQuantityLines = lines.filter(line => line.quantity.status === 'unknown').length;
    return response({ observedAt: this.observedAt(), order, unknownQuantityLines }, `${orderHeading(order)} — ${lines.length} product lines:\n${formatOrderLines(order)}` +
      (unknownQuantityLines ? `\n\n${unknownQuantityLines} quantities could not be read.` : ''),
    unknownQuantityLines ? 'partial' : lines.length ? 'success' : 'empty');
  }

  async listFrequentlyBoughtProducts(orderLimit: number, limit: number): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.history.listFrequentlyBoughtProducts(orderLimit));
    if (!result.ok) return this.failed(result.error);
    const scan = result.value;
    if (!scan.succeeded && (scan.failed || scan.unscanned)) {
      const unavailable = errorResult(failure('order_details_unavailable', 'No order details could be read. See scan.failures.').error);
      const envelope = unavailable.structuredContent as { result: Record<string, unknown> };
      return { ...unavailable, structuredContent: { result: { ...envelope.result, scan: { ...scan, observedAt: this.observedAt() } } } };
    }
    const products = scan.products.slice(0, limit);
    const list = numbered(products.map(item => `${item.name}${item.productId ? ` [${item.productId}]` : ''} — ` +
      `${item.quantities.map(amount).join(' + ') || 'quantity unknown'} across ${item.orders} order${item.orders === 1 ? '' : 's'}`));
    return response({ ...scan, products, observedAt: this.observedAt() },
      (list ? `Most frequently bought products across ${scan.succeeded} orders:\n\n${list}` : scan.listed === 0 ? 'No orders found.' : 'The orders read contain no product lines.') +
      (scan.failed ? `\n\nPartial results: ${scan.failed} of ${scan.scanned} orders could not be read and are not counted.` : '') +
      (scan.unscanned ? `\n${scan.unscanned} orders were not read before the request stopped.` : '') +
      (scan.failures.some(item => item.stage === 'listing') ? '\nSome order history pages could not be listed.' : ''),
    scan.completeness === 'partial' || scan.unknownQuantityLines ? 'partial' : products.length ? 'success' : 'empty');
  }

  async getSessionStatus(): Promise<CallToolResult> {
    const status = await this.services.session.getStatus?.() ?? { browser: 'unknown', credentials: { hasEmail: null, hasPassword: null },
      savedCookies: 'unknown', authentication: { state: 'unknown', checkedAt: null } };
    const favorites = await this.services.favorites.getCacheStatus();
    const credentials = status.credentials.hasEmail && status.credentials.hasPassword ? 'configured'
      : status.credentials.hasEmail === null ? 'unknown' : 'missing';
    const update = this.update.available ? ` Update available: ${this.update.latestVersion} (running ${this.update.currentVersion}).` : '';
    return response({ ...status, favorites, update: this.update }, `Browser: ${status.browser}. Credentials: ${credentials}. Saved cookies: ${status.savedCookies}. ` +
      `Last observed login state: ${status.authentication.state}. Favorites snapshot: ${favorites.state}.${update}`);
  }
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const UNCERTAIN_WRITE = 'If the result has mutation.outcome "unknown", the cart may have changed: call get_cart before any further change and never repeat the request automatically.';

const NO_UPDATE_INFO: UpdateStatus = { currentVersion: null, latestVersion: null, available: false };

export function registerShoppingTools(services: ShoppingServices, update: UpdateStatus = NO_UPDATE_INFO): ToolHandler[] {
  const handlers = new ShoppingHandlers(services, update);
  function tool<T>(name: string, title: string, description: string, inputSchema: z.ZodType<T>, outputSchema: z.ZodType,
    annotations: ToolAnnotations, execute: (args: T) => Promise<CallToolResult>, cartMutation = false, meta?: Record<string, unknown>): ToolHandler {
    return { definition: { name, title, description, annotations, ...(meta ? { _meta: meta } : {}) }, inputSchema, outputSchema, cartMutation,
      execute: raw => services.session.run(() => execute(raw as T)) };
  }
  return [
    tool('search_products', 'Search products',
      'Search the Continente.pt catalogue. No login needed. Results keep the website\'s relevance order and mark saved favorites; pass favoritesFirst to move them to the top. ' +
      'Each shows its price with what it is for (per item, piece, kg or litre), any promotions, the pack size, brand, category and productId. Filter with category, excludeCategory or brand, ' +
      'and sort by unit_price to compare packs. Pass nextCursor back as cursor, with the same query, for the next products.',
      contracts.SearchInput, contracts.SearchOutput, READ, args => handlers.searchProducts(args.query, args.limit, { ...(args.cursor ? { cursor: args.cursor } : {}), favoritesFirst: args.favoritesFirst,
        ...(args.category ? { category: args.category } : {}), ...(args.excludeCategory ? { excludeCategory: args.excludeCategory } : {}),
        ...(args.brand ? { brand: args.brand } : {}), sort: args.sort })),
    tool('get_product', 'Get product',
      'Get one product by productId: price, promotions with their dates, pack size, availability and sale rules (sale unit, minimum, maximum and step). ' +
      'A multi-buy or nth-unit offer is applied by the cart, not in the price shown. ' +
      'Availability is what the product page shows this session, signed in or not; it is not a delivery-slot stock check. ' +
      'Check this before choosing a quantity for weighted or bulk products. No login needed.',
      contracts.GetProductInput, contracts.ProductDetailsOutput, READ, args => handlers.getProduct(args.productId)),
    tool('choose_products', 'Choose products',
      'Show the user the open choices of a request side by side, with photos where the client supports it, so they pick one product for each. ' +
      'Use it only when the user must decide between candidates, such as two milks or 500 g against 1 kg; settle everything else yourself (favorites, ' +
      'usual purchases, cheapest per kg). Put all open choices of a list in one call, at most 10, each with 2 to 4 candidates and your suggestion. ' +
      'It changes nothing: the choices come back as a chat message, then change the cart with set_cart_item_quantity.',
      contracts.ChooseProductsInput, contracts.ChooseProductsOutput, READ, args => handlers.chooseProducts(args.decisions), false,
      { ui: { resourceUri: PICKER_URI }, 'ui/resourceUri': PICKER_URI }),
    tool('get_product_labels', 'Get product labels',
      'Ingredients, allergens and nutrition for up to 20 products, as the website\'s copy of each label declares them: the ingredient list, ' +
      'the words it prints in capitals (how labels mark allergens), the allergen and "may contain traces" statements, and nutrients per 100 g or ml. ' +
      'Use it only when a task needs them, such as checking vegan, gluten or allergens, or adding up protein. Nothing is inferred: absence of an ' +
      'allergen in these fields is not a "free from" claim, and the packaging prevails. No login needed.',
      contracts.GetProductLabelsInput, contracts.LabelsOutput, READ, args => handlers.getProductLabels(args.productIds)),
    tool('list_favorites', 'List favorites',
      'List the products saved as favorites on the account. Uses a local snapshot that is refreshed automatically when missing; ' +
      'snapshots older than 24 hours are marked stale. Pass refresh: true to fetch the current list from the website.',
      contracts.FavoritesInput, contracts.FavoritesOutput, READ, args => handlers.listFavorites(args.refresh)),
    tool('get_cart', 'Get cart',
      'Read the shopping cart: each line with productId, cartItemId, kind (product or bag), quantity, unit price (per item or per kg) ' +
      'and lineTotal, its promotions and lineTotalBeforeDiscount when the cart discounts the line, plus the totals ' +
      '(products, bags, deposit, delivery, discounts and grandTotal, the amount to pay), and checkout: the minimum order and whether the ' +
      'delivery fee is free with EntregaZero or set at checkout by day, slot and area (it is not in the totals until then). ' +
      'Use it to check current quantities before changing them and to verify any uncertain change.',
      contracts.EmptyInput, contracts.CartOutput, READ, () => handlers.getCart()),
    tool('preview_cart_changes', 'Preview cart changes',
      'Check products and the total wanted of each before changing the cart, without changing anything. For each: what the cart holds, ' +
      'what set_cart_item_quantity would do (add, increase, decrease, remove or none), why it would be refused (such as a minimum or step), ' +
      'availability, pack details and the estimated cost, plus the products total after the changes with its minimum order and delivery fee. ' +
      'Reads one product page per item, at most 30. Prices and stock can change before you apply it.',
      contracts.PreviewBasketInput, contracts.PreviewOutput, READ, args => handlers.previewBasket(args.items)),
    tool('add_cart_item', 'Add to cart',
      'Add an amount of a product to the cart, on top of any quantity already there. quantity is in the product sale unit (default 1). ' +
      `Use set_cart_item_quantity instead when the user wants a specific total. ${UNCERTAIN_WRITE}`,
      contracts.AddCartItemInput, contracts.MutationOutput, ADD,
      args => handlers.addCartItem(args.productId, args.quantity, args.cartItemId), true),
    tool('set_cart_item_quantity', 'Set cart quantity',
      'Make the cart hold exactly this quantity of a product, adding it if it is not there yet. Zero removes it. ' +
      `Pass cartItemId from get_cart when the product has more than one line. ${UNCERTAIN_WRITE}`,
      contracts.SetCartItemQuantityInput, contracts.MutationOutput, UPDATE,
      args => handlers.setCartItemQuantity(args.productId, args.quantity, args.cartItemId), true),
    tool('remove_cart_item', 'Remove from cart',
      'Remove a product line from the cart. Succeeds without changes if it is already absent. ' +
      `Pass cartItemId from get_cart when the product has more than one line. ${UNCERTAIN_WRITE}`,
      contracts.RemoveCartItemInput, contracts.MutationOutput, UPDATE,
      args => handlers.removeCartItem(args.productId, args.cartItemId), true),
    tool('clear_cart', 'Empty cart',
      'Remove every product from the cart in one step, with the website\'s own "remove all" action, and confirm the cart is empty. ' +
      'Only when the user asks to empty or clear the whole cart; pass confirm: true. To remove some products, use remove_cart_item. ' + UNCERTAIN_WRITE,
      contracts.ClearCartInput, contracts.ClearCartOutput, UPDATE, () => handlers.clearCart(), true),
    tool('list_orders', 'List orders',
      'List recent orders, newest first, with their product lines. Each order has an orderId for get_order. ' +
      'Use detailLimit or includeLines: false to read fewer details, and pass the returned nextCursor as cursor to continue.',
      contracts.ListOrdersInput, contracts.OrdersOutput, READ,
      args => handlers.listOrders(args.limit, { includeLines: args.includeLines,
        ...(args.detailLimit !== undefined ? { detailLimit: args.detailLimit } : {}), ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) })),
    tool('get_order', 'Get order',
      'Get the product lines of one order by its orderId from list_orders (not the displayed order number).',
      contracts.GetOrderInput, contracts.SingleOrderOutput, READ, args => handlers.getOrder(args.orderId)),
    tool('list_frequently_bought_products', 'List frequently bought products',
      'Rank products by how many recent orders contained them, with total quantities per unit. ' +
      'orderLimit sets how many recent orders to read (default 10); limit caps the products returned (default 25). Useful for building a usual shopping list.',
      contracts.FrequentlyBoughtInput, contracts.FrequencyOutput, READ,
      args => handlers.listFrequentlyBoughtProducts(args.orderLimit, args.limit)),
    tool('get_session_status', 'Get session status',
      'Report local state without contacting the website: browser status, whether credentials and saved cookies exist, ' +
      'the last observed login state and favorites snapshot freshness. Never returns secrets.',
      contracts.EmptyInput, contracts.SessionStatusOutput, { ...READ, openWorldHint: false }, () => handlers.getSessionStatus()),
  ];
}
