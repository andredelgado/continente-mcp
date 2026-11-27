import { z } from 'zod';

export const ToolErrorCodeSchema = z.enum([
  'invalid_data', 'invalid_input', 'not_authenticated', 'upstream_unavailable',
  'not_found', 'sale_rules_unknown', 'quantity_below_minimum',
  'cart_change_rejected', 'cart_change_unconfirmed', 'cache_unavailable', 'product_unavailable',
  'order_details_unavailable',
  'cancelled', 'deadline_exceeded', 'server_closed', 'queue_full', 'browser_unavailable',
]);

export const ToolErrorSchema = z.strictObject({
  code: ToolErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  issues: z.array(z.strictObject({ path: z.string(), code: z.string() })).optional(),
});

export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;

export function invalidData(context: string): ToolError {
  return { code: 'invalid_data', message: `Invalid ${context}`, retryable: false };
}
