import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(2),
  description: z.string().trim().max(240).optional(),
  imageUrl: z.string().trim().url().max(500).optional(),
});
