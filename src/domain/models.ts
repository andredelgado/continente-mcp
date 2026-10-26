import { z } from 'zod';
import { ToolErrorSchema } from './errors.js';
import { CartItemIdSchema, OrderIdSchema, OrderNumberSchema, ProductIdSchema, ProductReferenceSchema } from './identity.js';
import { MoneySchema, PriceTagSchema, UnitPriceSchema } from './money.js';
import { PromotionSchema } from './promotion.js';
import { CheckoutSchema } from './checkout.js';
import { ObservedQuantitySchema, QuantitySchema, ProductSaleRulesSchema } from './quantity.js';

const productDetails = {
  name: z.string().trim().min(1).max(250),
  /** The main price as displayed; null when absent or unrecognised. */
  price: PriceTagSchema.nullable(),
  url: z.url(),
};
/** Pack details parsed from the label; parts the label does not state are null. */
export const PackageSchema = z.strictObject({
  /** Items in the pack: the 6 in `6 x 1 lt`, the 12 in `12 rolos`, 1 for a single item. */
  count: z.number().int().positive().nullable(),
  /** Quantity of one item, when the label states it. */
  each: QuantitySchema.nullable(),
  /** Total quantity in the pack, including any free extra. */
  net: QuantitySchema.nullable(),
  /** Drained weight of preserves (`peso escorrido`). */
  drained: QuantitySchema.nullable(),
  /** The weight is approximate, as for products sold by the piece. */
  approximate: z.boolean(),
});
export type Package = z.infer<typeof PackageSchema>;
const packDetails = {
  /** Pack size as displayed, such as `940 gr`, `2 x 52 gr` or `1,2 kg (aprox.)`. */
  packageText: z.string().nullable(),
  package: PackageSchema.nullable(),
  /** Minimum purchase as displayed, such as `600 gr (3 un)`. */
  minimumText: z.string().nullable(),
};
export const FavoriteProductSchema = ProductReferenceSchema.safeExtend(productDetails);
export type FavoriteProduct = z.infer<typeof FavoriteProductSchema>;
export const ProductSchema = FavoriteProductSchema.safeExtend({
  /** The comparison price shown next to the main one, such as per kg or per piece. */
  secondaryPrice: PriceTagSchema.nullable(),
  /** The recommended retail price (PVPR) shown beside a promotional price; null when the website shows none. */
  recommendedPrice: PriceTagSchema.nullable(),
  /** Promotions the website shows for the product; empty when none. */
  promotions: z.array(PromotionSchema),
  ...packDetails,
  /** Whether the results page offers the product: `unknown` unless its badge and add button agree. */
  availability: z.enum(['available', 'unavailable', 'unknown']),
  brand: z.string().nullable(),
  /** The website's category path, such as `Supermercado/Congelados/Frutas e Legumes/Legumes`. */
  category: z.string().nullable(),
  /** Price per kg of drained weight, worked out from the price and the label's drained weight (`peso escorrido`). */
  drainedPrice: PriceTagSchema.nullable(),
  unitPrice: UnitPriceSchema.nullable(),
  /** The product photo on the website; null when the page gives none. */
  imageUrl: z.url().nullable(),
});
export type Product = z.infer<typeof ProductSchema>;

export const CartItemSchema = z.strictObject({
  productId: ProductIdSchema,
  cartItemId: CartItemIdSchema.nullable(),
  name: z.string().trim().min(1),
  /** `bag` for the shopping bags the website adds to the cart on its own; `product` for everything else. */
  kind: z.enum(['product', 'bag']),
  quantity: ObservedQuantitySchema,
  /**
   * What the website holds in its own unit, for products sold by the piece but priced by weight:
   * the kilograms in the cart, which are also the estimated weight. Null for other products.
   */
  storefrontQuantity: QuantitySchema.nullable(),
  /** Unit price with what it is for: per item, or per kg for products sold by the piece but priced by weight. */
  price: PriceTagSchema.nullable(),
  /** The line's total as the website reports it. */
  lineTotal: MoneySchema.nullable(),
  /** The line total is an estimate: products sold by the piece but priced by weight are charged by the weight picked. */
  estimated: z.boolean(),
  /** Promotions on the line; empty when none. */
  promotions: z.array(PromotionSchema),
  /** The line total before a discount the cart applies to the line, such as a multi-buy; null when none applies. */
  lineTotalBeforeDiscount: MoneySchema.nullable(),
});
export type CartItem = z.infer<typeof CartItemSchema>;
/** Each amount as the website reports it, or null when it reports none. */
export const CartTotalsSchema = z.strictObject({
  /** Product lines only, without bags or deposit. */
  products: MoneySchema.nullable(),
  /** The bag lines. */
  bags: MoneySchema.nullable(),
  /** Bottle and can deposit (SDR). */
  deposit: MoneySchema.nullable(),
  delivery: MoneySchema.nullable(),
  /** Amount taken off by order and delivery discounts. */
  discounts: MoneySchema.nullable(),
  /** The amount to pay as the website shows it; it includes the bags. */
  grandTotal: MoneySchema.nullable(),
  /** Some lines are estimates, so `products` and `grandTotal` are too. */
  estimated: z.boolean(),
});
export type CartTotals = z.infer<typeof CartTotalsSchema>;
export const CheckoutSummarySchema = z.strictObject({
  stage: z.literal('basket'), provisional: z.literal(true), totals: CartTotalsSchema,
  immediateDiscounts: MoneySchema.nullable(), loyaltyCredit: MoneySchema.nullable(),
  selectedCouponIds: z.array(z.string().trim().min(1).max(200)).nullable(),
});
export type CheckoutSummary = z.infer<typeof CheckoutSummarySchema>;
export const CartSchema = z.strictObject({
  customerAuthenticated: z.boolean(),
  items: z.array(CartItemSchema),
  totals: CartTotalsSchema,
  checkout: CheckoutSchema,
});
export type Cart = z.infer<typeof CartSchema>;

export const OrderLineSchema = z.strictObject({
  productId: ProductIdSchema.nullable(),
  name: z.string().trim().min(1),
  quantity: ObservedQuantitySchema,
});
export type OrderLine = z.infer<typeof OrderLineSchema>;
export const OrderSchema = z.strictObject({
  orderId: OrderIdSchema.nullable(),
  orderNumber: OrderNumberSchema.nullable(),
  date: z.string().nullable(),
  rawDate: z.string().nullable(),
  lines: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), items: z.array(OrderLineSchema) }),
    z.strictObject({ status: z.literal('unavailable'), error: ToolErrorSchema }),
    z.strictObject({ status: z.literal('not_requested') }),
  ]),
});
export type Order = z.infer<typeof OrderSchema>;

export const PurchaseFrequencySchema = z.strictObject({
  productId: ProductIdSchema.nullable(),
  identityBasis: z.enum(['product', 'name']),
  name: z.string().trim().min(1),
  quantities: z.array(QuantitySchema),
  orders: z.number().int().positive(),
  unknownQuantityLines: z.number().int().nonnegative(),
}).refine(frequency => (frequency.identityBasis === 'product') === (frequency.productId !== null),
{ message: 'Identity basis must agree with the available product ID' })
  .refine(frequency => new Set(frequency.quantities.map(quantity => quantity.unit)).size === frequency.quantities.length,
  { message: 'Purchase totals must contain each unit only once' });
export type PurchaseFrequency = z.infer<typeof PurchaseFrequencySchema>;

export const FavoritesCacheSchema = z.strictObject({
  schemaVersion: z.literal(2),
  accountScope: z.string().trim().min(1).max(128),
  fetchedAt: z.iso.datetime({ offset: true }),
  favorites: z.array(FavoriteProductSchema),
  completeness: z.literal('complete').optional(),
});
export type FavoritesCache = z.infer<typeof FavoritesCacheSchema>;

export const ProductDetailsSchema = ProductReferenceSchema.safeExtend({
  name: productDetails.name, url: productDetails.url, price: PriceTagSchema.nullable(),
  secondaryPrice: PriceTagSchema.nullable(), recommendedPrice: PriceTagSchema.nullable(), promotions: z.array(PromotionSchema), ...packDetails, drainedPrice: PriceTagSchema.nullable(), unitPrice: UnitPriceSchema.nullable(), imageUrl: z.url().nullable(), availability: z.enum(['available', 'unavailable', 'unknown']),
  saleRules: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), rules: ProductSaleRulesSchema }),
    z.strictObject({ status: z.literal('unavailable'), error: ToolErrorSchema }),
  ]),
});
export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

/** One nutrient as the label gives it, per `nutrition.per`. */
export const NutrientSchema = z.strictObject({
  /** The label's name, such as `proteínas` or `lípidos > saturados`. */
  name: z.string().min(1),
  /** A stable key for the common nutrients; null for the others, such as vitamins. */
  key: z.enum(['energy_kj', 'energy_kcal', 'fat', 'saturated_fat', 'carbohydrates', 'sugars', 'fibre', 'protein', 'salt']).nullable(),
  amount: z.number().finite().nonnegative(),
  /** `kJ`, `kcal`, `g`, `mg` or `µg`, or the label's own text for anything else. */
  unit: z.string().min(1),
});
/** What the website's copy of a product label declares. Nothing is inferred; the packaging prevails. */
export const ProductLabelSchema = z.strictObject({
  regulatedName: z.string().nullable(),
  ingredients: z.string().nullable(),
  /**
   * Words of three or more letters printed in capitals in the ingredients, such as `SOJA` or
   * `TRIGO`. Labels emphasise allergens this way, but this is typography, not an allergen list:
   * it also catches abbreviations such as `EDTA`, and not every label capitalises its allergens.
   * Null when the ingredients are missing or entirely in capitals.
   */
  emphasised: z.array(z.string()).nullable(),
  /** What the website files as the allergen statement, such as `Contém Leite.`; sometimes another text, such as a nutrition claim. */
  allergenStatement: z.string().nullable(),
  /** The label's "may contain traces of" sentence, from the allergen statement or the ingredients. */
  mayContain: z.string().nullable(),
  storage: z.string().nullable(),
  /** The pack's net content as the label states it, such as 500 g. */
  netContent: QuantitySchema.nullable(),
  /**
   * Inconsistencies in the website's data, kept as given: `nutrition_basis_mismatch` when the
   * nutrients are per 100 ml of a product whose net content is in grams, or the other way round.
   */
  issues: z.array(z.enum(['nutrition_basis_mismatch'])),
  nutrition: z.strictObject({
    /** The amount the values are for, such as 100 g or 100 ml; null when the label does not say. */
    per: QuantitySchema.nullable(),
    nutrients: z.array(NutrientSchema),
  }).nullable(),
});
export type ProductLabel = z.infer<typeof ProductLabelSchema>;

/** One requested line of a basket preview: what the cart holds, what would change and what it would cost. */
export const BasketPreviewLineSchema = z.strictObject({
  productId: ProductIdSchema,
  cartItemId: CartItemIdSchema.nullable(),
  name: z.string().nullable(),
  /** The desired total, in the product's sale unit; null when the sale unit is unknown. */
  requested: QuantitySchema.nullable(),
  /** The desired total in the website's unit, for products sold by the piece but priced by weight: the estimated weight. */
  storefrontQuantity: QuantitySchema.nullable(),
  /** What the cart holds now; zero when the product is not in it. */
  current: ObservedQuantitySchema,
  /** What `set_cart_item_quantity` would do; null when it would be refused. */
  change: z.enum(['add', 'increase', 'decrease', 'remove', 'none']).nullable(),
  availability: z.enum(['available', 'unavailable', 'unknown']).nullable(),
  price: PriceTagSchema.nullable(),
  packageText: z.string().nullable(),
  package: PackageSchema.nullable(),
  saleRules: ProductSaleRulesSchema.nullable(),
  /** The product's promotions, from its product page; empty when none. */
  promotions: z.array(PromotionSchema),
  /** Cost of the desired total at the current price, before any multi-buy or nth-unit offer the cart applies; null when it cannot be worked out. */
  estimatedCost: MoneySchema.nullable(),
  /** The cost depends on the weight picked, for products sold by the piece but priced by weight. */
  estimated: z.boolean(),
  /** Why the line cannot be applied as asked, such as a quantity below the minimum. */
  error: ToolErrorSchema.nullable(),
});
export type BasketPreviewLine = z.infer<typeof BasketPreviewLineSchema>;
export const BasketPreviewSchema = z.strictObject({
  lines: z.array(BasketPreviewLineSchema),
  /** Sum of the lines' estimated costs; null when any line's cost is unknown. */
  estimatedCost: MoneySchema.nullable(),
  estimated: z.boolean(),
  /** Lines with an error or a product that is not available. */
  problems: z.number().int().nonnegative(),
  /** The cart's products total after these changes: the current total with these lines at their estimated cost; null when any part is unknown. */
  productsAfter: MoneySchema.nullable(),
  /** The minimum order and delivery fee for `productsAfter`. */
  checkout: CheckoutSchema,
});
export type BasketPreview = z.infer<typeof BasketPreviewSchema>;
/** A coupon as displayed on the account's coupon page. Unknown retailer rules remain unknown. */
export const CouponSchema = z.strictObject({
  couponId: z.string().trim().min(1).max(200).nullable(),
  description: z.string().trim().min(1).max(1000),
  availability: z.string().trim().max(300).nullable(),
  benefitValue: z.string().trim().max(100).nullable(),
  benefitQualifier: z.string().trim().max(200).nullable(),
  eligibility: z.literal('unknown'),
  expiry: z.null(),
});
export type Coupon = z.infer<typeof CouponSchema>;
export const CouponListSchema = z.strictObject({ coupons: z.array(CouponSchema), completeness: z.enum(['complete', 'partial', 'unknown']) });
export type CouponList = z.infer<typeof CouponListSchema>;
const CouponIdsSchema = z.array(z.string().trim().min(1).max(200));
export const CouponSelectionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('confirmed'), selectedCouponIds: CouponIdsSchema }),
  z.strictObject({ outcome: z.literal('unknown'),
    /** Null when the current selection could not be read after the write. */
    selectedCouponIds: CouponIdsSchema.nullable(),
    /** The last readable selection, which may predate the write. */
    lastObservedSelectedCouponIds: CouponIdsSchema,
    recovery: z.strictObject({ action: z.literal('get_checkout_summary'), automaticReplay: z.literal(false) }),
  }),
]);
export type CouponSelection = z.infer<typeof CouponSelectionSchema>;

export const PickupStoreSchema = z.strictObject({
  storeId: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(250),
  address1: z.string().trim().max(250).nullable(), address2: z.string().trim().max(250).nullable(),
  city: z.string().trim().max(150).nullable(), postalCode: z.string().trim().max(20).nullable(),
  latitude: z.number().finite().nullable(), longitude: z.number().finite().nullable(),
  countryCode: z.string().trim().max(10).nullable(), storeHours: z.unknown().nullable(),
  isPickupStore: z.boolean(), isGalpStore: z.boolean().nullable(),
});
export type PickupStore = z.infer<typeof PickupStoreSchema>;
export const PickupStoresSchema = z.strictObject({ stores: z.array(PickupStoreSchema), completeness: z.enum(['complete', 'partial', 'unknown']), selectedStoreChanged: z.literal(false) });
export type PickupStores = z.infer<typeof PickupStoresSchema>;
export const PickupSlotSchema = z.strictObject({
  date: z.iso.date(), weekday: z.string().trim().max(40).nullable(), weekdayShort: z.string().trim().max(20).nullable(),
  startTime: z.string().trim().max(20).nullable(), endTime: z.string().trim().max(20).nullable(), shippingCost: z.string().trim().max(40).nullable(),
});
export const PickupSlotsSchema = z.strictObject({
  pickupMode: z.enum(['pickup', 'unknown']), selectedStoreId: z.string().trim().min(1).max(100).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
  dateWindow: z.strictObject({ from: z.iso.date(), to: z.iso.date() }), dateYearBasis: z.literal('requested-window'),
  coverage: z.literal('server-rendered-days-only'),
  slots: z.array(PickupSlotSchema), completeness: z.enum(['complete', 'partial', 'unknown']),
  /** These flags describe writes issued by the tool, not unverified retailer-side GET effects. */
  selectedStoreChanged: z.literal(false), slotReserved: z.literal(false),
});
export type PickupSlot = z.infer<typeof PickupSlotSchema>;
export type PickupSlots = z.infer<typeof PickupSlotsSchema>;
export const PickupStoreChangeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('confirmed'), requestedStoreId: z.string().trim().min(1).max(100),
    previousStoreId: z.string().trim().min(1).max(100), selectedStoreId: z.string().trim().min(1).max(100),
    storeName: z.string().trim().max(250).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
    selectedStoreChanged: z.boolean(), cartAndCouponsNeedRevalidation: z.boolean() }),
  z.strictObject({ outcome: z.literal('not_applied'), requestedStoreId: z.string().trim().min(1).max(100),
    previousStoreId: z.string().trim().min(1).max(100), selectedStoreId: z.string().trim().min(1).max(100),
    storeName: z.string().trim().max(250).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
    selectedStoreChanged: z.literal(false), cartAndCouponsNeedRevalidation: z.literal(false) }),
  z.strictObject({ outcome: z.literal('unknown'), requestedStoreId: z.string().trim().min(1).max(100),
    previousStoreId: z.string().trim().min(1).max(100), selectedStoreId: z.string().trim().min(1).max(100).nullable(),
    storeName: z.string().trim().max(250).nullable(), storePostalCode: z.string().trim().max(20).nullable(),
    selectedStoreChanged: z.boolean().nullable(), cartAndCouponsNeedRevalidation: z.literal(true),
    recovery: z.strictObject({ action: z.literal('list_pickup_slots'), fromDate: z.iso.date(), toDate: z.iso.date(), automaticReplay: z.literal(false) }) }),
]);
export type PickupStoreChange = z.infer<typeof PickupStoreChangeSchema>;
