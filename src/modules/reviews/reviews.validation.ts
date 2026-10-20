import { z } from 'zod';

export const createReviewSchema = z.object({
  lotId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(3).max(80),
  comment: z.string().trim().min(10).max(1000),
});

export const reviewListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  q: z.string().trim().max(100).optional(),
});
