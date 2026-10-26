import { z } from 'zod';
import { MAX_REFERENCE_LENGTH, isProductReference, PriceTagSchema, UnitPriceSchema, BasketPreviewSchema, CartSchema, ClearCartResultSchema, ProductLabelSchema, ProductIdSchema, ProductDetailsSchema, FavoriteProductSchema, OrderSchema, ProductSchema, PurchaseFrequencySchema,
  ToolErrorSchema, CartMutationResultSchema, CartItemIdSchema, OrderIdSchema, BrowserStatusSchema, FavoritesStatusSchema, UpdateStatusSchema } from '../domain/index.js';

export const ProductReferenceInput = z.string().min(1).max(MAX_REFERENCE_LENGTH).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.html)?$/)
  .refine(isProductReference, 'Expected a numeric productId or a product slug ending in it')
  .describe('productId from another tool, such as "00123". A product slug ending in that ID (for example "leite-00123") also works.');
export const LimitInput = z.number().int().min(1).max(50);
export const SearchInput = z.strictObject({
  query: z.string().max(MAX_REFERENCE_LENGTH).regex(/^[^\p{Cc}]*[^\p{Cc}\s][^\p{Cc}]*$/u).describe('Search text, for example "leite meio gordo".'),
  limit: LimitInput.default(10).describe('Maximum products to return (default 10).'),
  cursor: z.string().min(1).max(4096).optional().describe('nextCursor from an earlier search for the same query, to continue right after its last product.'),
  favoritesFirst: z.boolean().default(false).describe('Move products from your saved favorites to the top of the returned products. Default: the website\'s relevance order.'),
  category: z.string().min(1).max(100).optional().describe('Keep only products whose category path contains this text, such as "Congelados/Frutas e Legumes" or "Mercearia". Case and accents are ignored.'),
  excludeCategory: z.string().min(1).max(100).optional().describe('Leave out products whose category path contains this text, such as "Animais".'),
  brand: z.string().min(1).max(100).optional().describe('Keep only products whose brand contains this text, such as "Continente".'),
  sort: z.enum(['relevance', 'unit_price']).default('relevance').describe('unit_price orders the returned products by price per drained kg, kg or litre, cheapest first.'),
});
const cartItemId = CartItemIdSchema.optional().describe('Cart line identifier from get_cart. Required to select one of several lines for the same product.');
export const AddCartItemInput = z.strictObject({ productId: ProductReferenceInput,
  quantity: z.number().positive().default(1).describe('Amount to add, in the product sale unit (default 1).'), cartItemId });
export const SetCartItemQuantityInput = z.strictObject({ productId: ProductReferenceInput,
  quantity: z.number().nonnegative().describe('Desired total in the product sale unit. Zero removes the item.'), cartItemId });
export const RemoveCartItemInput = z.strictObject({ productId: ProductReferenceInput, cartItemId });
export const ClearCartInput = z.strictObject({
  confirm: z.literal(true).describe('Must be true: the user asked to empty the whole cart.'),
});
export const PreviewBasketInput = z.strictObject({
  items: z.array(z.strictObject({ productId: ProductReferenceInput,
    quantity: z.number().nonnegative().describe('Desired total in the product sale unit, as for set_cart_item_quantity. Zero means remove.'), cartItemId }))
    .min(1).max(30).describe('Products and the total you want of each, at most 30.'),
});
export const GetOrderInput = z.strictObject({ orderId: OrderIdSchema.describe('Internal orderId from list_orders; distinct from the displayed order number.') });
export const EmptyInput = z.strictObject({});
export const FavoritesInput = z.strictObject({
  refresh: z.boolean().default(false).describe('Fetch the current list from the website instead of using the local snapshot.'),
});
export const ListOrdersInput = z.strictObject({ limit: LimitInput.default(5).describe('Maximum order summaries to return (default 5).'),
  includeLines: z.boolean().default(true).describe('Read product lines for the returned orders.'),
  detailLimit: z.number().int().min(0).max(50).optional().describe('Maximum returned summaries to enrich with lines; defaults to limit. Zero skips details.'),
  cursor: z.string().min(1).max(4096).optional().describe('Opaque nextCursor returned by list_orders.') });
export const FrequentlyBoughtInput = z.strictObject({
  orderLimit: LimitInput.default(10).describe('Maximum recent orders to scan.'),
  limit: LimitInput.default(25).describe('Maximum ranked products to return.'),
});

export const PublicErrorSchema = ToolErrorSchema.extend({ code: z.union([ToolErrorSchema.shape.code, z.enum(['internal_error', 'invalid_result'])]) });
const RecoverySchema = z.strictObject({ action: z.literal('get_cart'), automaticReplay: z.literal(false) });
/** What to do about a sign-in failure, so an assistant can guide the user without parsing the message. */
export const SignInRecoverySchema = z.strictObject({
  credentials: z.enum(['configured', 'missing', 'unknown']),
  /**
   * `configure_credentials` when none are set; `confirm_not_a_robot` when Continente asks the person
   * to confirm they are not a robot; otherwise check the credentials, or sign in once in a visible browser.
   */
  action: z.enum(['configure_credentials', 'check_credentials_or_sign_in', 'confirm_not_a_robot']),
  /** For `confirm_not_a_robot`: a sign-in window `opened` or was `already_open` on this computer, or none can be shown here (`not_available`). Otherwise null. */
  signInWindow: z.enum(['opened', 'already_open', 'not_available']).nullable(),
  settings: z.strictObject({
    environment: z.tuple([z.literal('CONTINENTE_EMAIL'), z.literal('CONTINENTE_PASSWORD')]),
    claudeDesktopExtension: z.tuple([z.literal('email'), z.literal('password')]),
  }),
  /** Run in a terminal to sign in and complete any extra verification. */
  command: z.literal('continentept-mcp login --show-browser'),
  guide: z.url(),
  /** Tools that keep working without signing in. */
  publicTools: z.array(z.string()),
});
export const ErrorResultSchema = z.strictObject({ status: z.literal('error'), error: PublicErrorSchema,
  mutation: z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('not_applied') }),
    z.strictObject({ outcome: z.literal('unknown'), recovery: RecoverySchema }),
  ]).optional(),
  signIn: SignInRecoverySchema.optional(),
});
export const ExecutionErrorSchema = z.strictObject({ result: ErrorResultSchema });
/** The result envelope: data with its status, or an error. `errorDetails` are extra fields one tool's errors carry. */
export function outputSchema<T extends z.ZodType>(data: T, errorDetails: z.ZodRawShape = {}) {
  return z.strictObject({ result: z.union([
    z.strictObject({ status: z.enum(['success', 'empty', 'partial']), data }), ErrorResultSchema.safeExtend(errorDetails),
  ]) });
}
const integer = z.number().int().nonnegative();
/** When the website was read; prices and availability can change after it. */
const observed = { observedAt: z.iso.datetime({ offset: true }) };
/**
 * Whose view of the catalogue this is, from the server's last sign-in check. Availability and
 * which products open can differ between signed in and signed out.
 */
const viewed = { catalogView: z.enum(['signed_in', 'signed_out', 'unknown']) };
export const SearchData = z.strictObject({ ...observed, ...viewed, products: z.array(ProductSchema.safeExtend({ favorite: z.boolean() })),
  /** Products a filter left out only because the results page gave no category or brand for them. */
  unknownToFilter: z.number().int().nonnegative(),
  scanned: integer, returned: integer, favoritesLoaded: integer, completeness: z.enum(['complete', 'partial', 'unknown']),
  failures: z.array(ToolErrorSchema), nextCursor: z.string().nullable() });
export const FavoritesData = z.strictObject({ favorites: z.array(FavoriteProductSchema), fetchedAt: z.iso.datetime({ offset: true }), completeness: z.enum(['complete', 'unknown']),
  source: z.enum(['cache', 'website']), freshness: z.enum(['fresh', 'stale']), expiresAt: z.iso.datetime({ offset: true }), cacheState: z.enum(['empty', 'populated']) });
const ScanFailure = z.strictObject({ stage: z.enum(['listing', 'detail']), orderId: OrderSchema.shape.orderId, orderNumber: OrderSchema.shape.orderNumber, error: ToolErrorSchema });
export const OrdersData = z.strictObject({ ...observed, orders: z.array(OrderSchema), completeness: z.enum(['complete', 'partial', 'unknown']), failures: z.array(ScanFailure), nextCursor: z.string().nullable(),
  hasMore: z.boolean().nullable(), detailBudget: integer, detailsRead: integer });
export const FrequencyData = z.strictObject({ ...observed, products: z.array(PurchaseFrequencySchema), listed: integer, scanned: integer, succeeded: integer, failed: integer, unscanned: integer,
  unknownQuantityLines: integer, failures: z.array(ScanFailure), completeness: z.enum(['complete', 'partial', 'unknown']) });
export const SearchOutput = outputSchema(SearchData);
export const FavoritesOutput = outputSchema(FavoritesData);
export const CartData = CartSchema.safeExtend(observed);
export const PreviewData = BasketPreviewSchema.safeExtend({ ...observed, ...viewed });
export const PreviewOutput = outputSchema(PreviewData);
export const CartOutput = outputSchema(CartData);
export const MutationData = CartMutationResultSchema.options[0].safeExtend(observed).refine(value => value.requested.unit === value.confirmedQuantity.unit);
export const MutationOutput = outputSchema(MutationData);
export const ClearCartOutput = outputSchema(ClearCartResultSchema.options[0].safeExtend(observed));
export const OrdersOutput = outputSchema(OrdersData);
export const SingleOrderOutput = outputSchema(z.strictObject({ ...observed, order: OrderSchema, unknownQuantityLines: integer }));
/** When no order detail could be read, the error carries the scan's statistics in `scan`. */
export const FrequencyOutput = outputSchema(FrequencyData, { scan: FrequencyData.optional() });
export const SessionStatusOutput = outputSchema(BrowserStatusSchema.extend({ favorites: FavoritesStatusSchema, update: UpdateStatusSchema }));

export const GetProductInput = z.strictObject({ productId: ProductReferenceInput });
export const ChooseProductsInput = z.strictObject({
  decisions: z.array(z.strictObject({
    question: z.string().trim().min(1).max(80).describe('What the user decides, in a few words, such as "Leite meio gordo" or "Manteiga de amendoim: 500 g ou 1 kg?".'),
    productIds: z.array(ProductReferenceInput).min(2).max(4).describe('The candidates, 2 to 4 productIds from search_products or get_product.'),
    suggested: ProductReferenceInput.optional().describe('The candidate you recommend; it starts selected.'),
  })).min(1).max(10).describe('Every open choice of the request, at most 10, shown together in one picker.'),
});
const ChoiceOption = z.strictObject({ productId: ProductIdSchema, name: z.string(), packageText: z.string().nullable(), price: PriceTagSchema.nullable(),
  unitPrice: UnitPriceSchema.nullable(), availability: z.enum(['available', 'unavailable', 'unknown']), imageUrl: z.url().nullable() });
export const ChooseProductsData = z.strictObject({ ...observed, decisions: z.array(z.strictObject({
  question: z.string(), suggested: ProductIdSchema.nullable(), options: z.array(ChoiceOption),
  /** Candidates that could not be shown, such as a product the website no longer shows. */
  failures: z.array(z.strictObject({ productId: z.string(), error: ToolErrorSchema })),
})) });
export const ChooseProductsOutput = outputSchema(ChooseProductsData);
export const GetProductLabelsInput = z.strictObject({
  productIds: z.array(ProductReferenceInput).min(1).max(20).describe('Products to read the label of, at most 20.'),
});
export const LabelsData = z.strictObject({ ...observed, labels: z.array(z.strictObject({
  productId: ProductIdSchema.nullable(), name: z.string().nullable(),
  /** Null when the website has no label information for the product, or when it could not be read (see error). */
  label: ProductLabelSchema.nullable(), error: ToolErrorSchema.nullable(),
  /** `complete` (ingredients and nutrition), `partial` (one of them), `none` (neither on the website) or `error` (could not be read). */
  status: z.enum(['complete', 'partial', 'none', 'error']),
  /** Fields the website does not give for this product. */
  missing: z.array(z.enum(['ingredients', 'allergenStatement', 'nutrition'])),
})) });
export const LabelsOutput = outputSchema(LabelsData);
export const ProductDetailsData = ProductDetailsSchema.safeExtend({ ...observed, ...viewed });
export const ProductDetailsOutput = outputSchema(ProductDetailsData);
