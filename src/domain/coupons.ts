import { z } from 'zod';
import { ToolErrorSchema } from './errors.js';

export const CouponIdSchema = z.string().trim().min(1).max(200);

/** A Cartão Continente coupon as the account page shows it. Eligibility and stacking are never stated, so they stay unknown. */
export const CouponSchema = z.strictObject({
  /** The ID to pass to `set_cart_coupons`; null when the page shows none. */
  couponId: CouponIdSchema.nullable(),
  description: z.string().trim().min(1).max(1000),
  /** Availability as the page states it, such as an end date. */
  availability: z.string().trim().max(300).nullable(),
  /** The benefit as shown, such as `5 €` or `10%`. */
  benefitValue: z.string().trim().max(100).nullable(),
  /** What the benefit applies to, as shown, such as `em compras superiores a 25 €`. */
  benefitQualifier: z.string().trim().max(200).nullable(),
  /** Whether it is selected for the current cart; null when the cart's coupon choices could not be read, or when it is not known to be selected while the selection is `unknown`. */
  selectedInCart: z.boolean().nullable(),
});
export type Coupon = z.infer<typeof CouponSchema>;

export const CouponListSchema = z.strictObject({
  coupons: z.array(CouponSchema),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  /**
   * `read` when the cart's coupon choices were read; `unknown` when a checked coupon in the cart has no
   * readable ID, so only the coupons marked selected are known; `unavailable` when they could not be read,
   * such as with an empty cart.
   */
  cartSelection: z.enum(['read', 'unknown', 'unavailable']),
});
export type CouponList = z.infer<typeof CouponListSchema>;

/** Selecting coupons for the cart: confirmed by reading the cart back, refused before any write, or unknown and never replayed. */
export const CouponSelectionResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('confirmed'), selectedCouponIds: z.array(CouponIdSchema) }),
  z.strictObject({ outcome: z.literal('not_applied'), error: ToolErrorSchema }),
  z.strictObject({ outcome: z.literal('unknown'), error: ToolErrorSchema.extend({ retryable: z.literal(false) }),
    recovery: z.strictObject({ action: z.literal('list_coupons'), automaticReplay: z.literal(false) }) }),
]);
export type CouponSelectionResult = z.infer<typeof CouponSelectionResultSchema>;
