import { z } from 'zod';

export const browseLotsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
  categoryId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'LIVE', 'ENDED', 'SOLD', 'UNSOLD', 'CANCELLED']).optional(),
  sortBy: z.enum(['createdAt', 'endTime', 'currentHighestBidAmountCents']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().optional(),
});
