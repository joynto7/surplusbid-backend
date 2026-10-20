import { z } from 'zod';
import { ApiError } from './ApiError';

/** Validates query strings and other non-body input with the same 422 shape as the validate() middleware. */
export function parseOr422<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
    throw new ApiError(422, 'Validation failed', errors);
  }
  return parsed.data;
}
