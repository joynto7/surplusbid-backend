import { z } from 'zod';

const uuidList = z
  .string()
  .transform((s) => s.split(',').map((id) => id.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).max(50));

export const browseLotsSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(10),
    categoryId: z.string().uuid().optional(),
    status: z.enum(['DRAFT', 'LIVE', 'ENDED', 'SOLD', 'UNSOLD', 'CANCELLED']).optional(),
    sortBy: z
      .enum(['createdAt', 'endTime', 'currentHighestBidAmountCents', 'currentPriceCents', 'popularity'])
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    q: z.string().trim().max(100).optional(),
    /** Price filters apply to currentPriceCents: the highest bid, or the starting price before any bid. */
    minPriceCents: z.coerce.number().int().nonnegative().optional(),
    maxPriceCents: z.coerce.number().int().positive().optional(),
    location: z.string().trim().max(80).optional(),
    condition: z.string().trim().max(40).optional(),
    sellerId: z.string().uuid().optional(),
    /** Comma-separated lot ids, for watchlists and "recently viewed" strips. */
    ids: uuidList.optional(),
  })
  .refine((q) => q.minPriceCents === undefined || q.maxPriceCents === undefined || q.minPriceCents <= q.maxPriceCents, {
    message: 'minPriceCents must not exceed maxPriceCents',
    path: ['minPriceCents'],
  });

export const relatedLotsSchema = z.object({
  limit: z.coerce.number().int().positive().max(12).default(4),
});

export const recordViewSchema = z.object({
  /** Anonymous browser id (random, kept in localStorage) so one visitor counts once per half hour. */
  viewerId: z.string().trim().min(8).max(64).optional(),
});
