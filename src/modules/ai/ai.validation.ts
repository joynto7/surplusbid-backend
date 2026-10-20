import { z } from 'zod';

export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(2000),
      })
    )
    .min(1)
    .max(20)
    .refine((m) => m[m.length - 1]?.role === 'user', { message: 'The last message must be from the user' }),
  lotId: z.string().uuid().optional(),
});

export const suggestQuerySchema = z.object({
  q: z.string().max(100).default(''),
});

export const searchIntentSchema = z.object({
  q: z.string().trim().min(1).max(200),
});

const idList = z
  .string()
  .transform((s) => s.split(',').map((id) => id.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).max(30));

export const recommendationsQuerySchema = z.object({
  seed: idList.optional(),
  limit: z.coerce.number().int().positive().max(24).default(8),
});

export const trendingQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(24).default(8),
});
