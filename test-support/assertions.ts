import { z } from 'zod';
import { OperationErrorResultSchema } from '../src/mcp/contracts.js';
/** An error result, with any details a tool's errors add (such as list_frequently_bought_products' scan). */
const errorResult = OperationErrorResultSchema.safeExtend({ scan: z.unknown().optional() });

import assert from 'node:assert/strict';

const envelope = z.object({ structuredContent: z.object({ result: z.object({ status: z.enum(['success', 'empty', 'partial', 'error']) }).passthrough() }) });
export function statusOf(response: unknown) { return envelope.parse(response).structuredContent.result.status; }
export function dataOf<S extends z.ZodType>(response: unknown, schema: S): z.output<S> {
  const parsed = envelope.parse(response).structuredContent.result;
  assert.notEqual(parsed.status, 'error');
  return schema.parse(parsed.data);
}
export function toolError(response: unknown) {
  return errorResult.parse(envelope.parse(response).structuredContent.result).error;
}
export function mutationOf(response: unknown) {
  const mutation = errorResult.parse(envelope.parse(response).structuredContent.result).mutation;
  assert.ok(mutation);
  return mutation;
}
export function recoveryOf(response: unknown) {
  const mutation = mutationOf(response); assert.equal(mutation.outcome, 'unknown');
  assert.ok(mutation.outcome === 'unknown'); return mutation.recovery;
}
export function textOf(response: unknown): string {
  return z.object({ content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]).rest(z.unknown()) }).parse(response).content[0].text;
}

// Double only a dependency's exercised surface. Supplied members retain their
// signatures; missing members fail immediately if a test starts exercising them.
export type Double<T> = T | (T extends (...args: infer A) => infer R
  ? (...args: A) => R extends Promise<infer U> ? Promise<Double<U>> : Double<R>
  : T extends readonly (infer U)[] ? Double<U>[]
  : T extends object ? { [K in keyof T]?: Double<T[K]> } : T);
export function double<T>(members: Double<T>): T { return members as T; }

export function having<T, K extends PropertyKey>(value: T, key: K): T extends unknown ? K extends keyof T ? T : never : never {
  assert.ok(value !== null && typeof value === 'object' && key in value);
  return value as T extends unknown ? K extends keyof T ? T : never : never;
}

// SDK tool schemas explicitly permit undefined optional fields; the validator's
// equivalent JSON type omits those unions under exactOptionalPropertyTypes.
export function validatorSchema(schema: NonNullable<import('@modelcontextprotocol/sdk/types.js').Tool['outputSchema']>) {
  return schema as Parameters<import('@modelcontextprotocol/sdk/validation/ajv').AjvJsonSchemaValidator['getValidator']>[0];
}
